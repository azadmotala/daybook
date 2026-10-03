import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/**
 * The update prompt's decision, checked without a browser.
 *
 * `js/update.js` is a classic script, so it is run in a VM and asked for its module the same way
 * the browser gets it. The decision about *when* to show the prompt is the part worth pinning: it
 * is the difference between interrupting her mid-entry and waiting until she is done.
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url));

function load() {
  const context = { window: {}, navigator: {}, document: null, console };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(readFileSync(ROOT + 'js/update.js', 'utf8'), context);
  assert.ok(context.Updater, 'js/update.js did not expose Updater');
  return context;
}

/** A stand-in for the sheet element, which is the only "busy" this app has. */
function docWithSheet(hidden) {
  return { getElementById: (id) => (id === 'sheet' ? { hidden } : null) };
}

test('a closed sheet is not busy', () => {
  const { Updater } = load();
  assert.equal(Updater.isBusy(docWithSheet(true)), false);
});

test('an open sheet is busy', () => {
  const { Updater } = load();
  assert.equal(Updater.isBusy(docWithSheet(false)), true);
});

test('no sheet in the document at all is not busy', () => {
  const { Updater } = load();
  assert.equal(Updater.isBusy({ getElementById: () => null }), false);
});

test('nothing waiting means no prompt, however idle she is', () => {
  const { Updater } = load();
  assert.equal(Updater.promptState(false, docWithSheet(true)), 'none');
  assert.equal(Updater.promptState(false, docWithSheet(false)), 'none');
});

test('an update while she is mid-entry waits rather than interrupting', () => {
  const { Updater } = load();
  assert.equal(Updater.promptState(true, docWithSheet(false)), 'busy');
});

test('an update while she is idle is offered', () => {
  const { Updater } = load();
  assert.equal(Updater.promptState(true, docWithSheet(true)), 'ready');
});

/**
 * Wire up a watched registration inside a fresh VM, returning the levers a test needs.
 *
 * @param {object} reg what `serviceWorker.register()` resolved to
 */
function watched(reg) {
  const context = load();
  const swEvents = {};
  let reloads = 0;
  const posted = [];

  context.navigator.serviceWorker = {
    controller: reg.hasController === false ? null : {},
    addEventListener: (type, fn) => { swEvents[type] = fn; },
  };
  context.window.location = { reload: () => { reloads += 1; } };

  const regEvents = {};
  let updates = 0;
  const registration = {
    waiting: reg.waiting
      ? { postMessage: (m) => posted.push(m) }
      : null,
    installing: null,
    addEventListener: (type, fn) => { regEvents[type] = fn; },
    update: () => { updates += 1; },
  };

  let told = 0;
  const handle = context.Updater.watch(registration, () => { told += 1; });

  return {
    handle,
    registration,
    fire: (type) => swEvents[type] && swEvents[type](),
    posted,
    reloads: () => reloads,
    told: () => told,
    updates: () => updates,
    /** Make a worker appear as waiting *after* watch() ran, which is the resume case. */
    setWaiting: () => { registration.waiting = { postMessage: (m) => posted.push(m) }; },
  };
}

/** A stand-in document whose only "busy" is an open sheet. */
const docBusy = { getElementById: () => ({ hidden: false }) };
const docIdle = { getElementById: () => ({ hidden: true }) };

/**
 * The reload guard. `controllerchange` also fires the first time a worker takes control of a page
 * that had none — every first-time visitor — and reloading there is a flash at best and a loop at
 * worst. Both directions are asserted, because a guard that never lets anything through would pass
 * the negative case alone.
 */
test('controllerchange does not reload when she did not ask', () => {
  const w = watched({ waiting: false });
  w.fire('controllerchange');
  assert.equal(w.reloads(), 0, 'reloaded a page nobody asked to reload');
});

test('controllerchange does reload once she has asked', () => {
  const w = watched({ waiting: true });
  // Waiting at boot with a controller present is path 1: taken without asking.
  //
  // Compared by value rather than with deepEqual: the message is constructed inside the VM, so it
  // carries that realm's Object.prototype and a strict deep comparison fails on the prototype
  // rather than on anything that matters.
  assert.equal(w.posted.length, 1, 'did not take the waiting worker');
  assert.equal(w.posted[0].type, 'SKIP_WAITING');
  w.fire('controllerchange');
  assert.equal(w.reloads(), 1, 'did not reload after taking the update');
});

test('a worker waiting at boot is taken silently, not offered', () => {
  const w = watched({ waiting: true });
  assert.equal(w.told(), 0, 'prompted about an update it should have just taken');
});

test('a first install has nothing waiting and nothing to say', () => {
  const w = watched({ waiting: true, hasController: false });
  assert.equal(w.posted.length, 0, 'tried to replace a worker that was never there');
  assert.equal(w.told(), 0);
});

/* --------------------------------------------------------------------------- resume

   The bug these cover, in full: an installed app on a phone is resumed rather than
   cold-started, so `load` may not fire again for days, and `updatefound` cannot fire a
   second time for a worker that is already installed and waiting. So once "Not now" was
   tapped there was no route back. Observed on an iPhone: opening the app twice still
   served the version it was replacing. `recheck` is the way back, and it is the only
   one, so each of its three outcomes is pinned.                                        */

test('a resume mid-entry changes nothing, and asks again next time', () => {
  const w = watched({ waiting: false });
  w.setWaiting();
  assert.equal(w.handle.recheck(docBusy), 'busy');
  assert.equal(w.told(), 0, 'interrupted a half-filled sheet');
  assert.equal(w.updates(), 0, 'went to the network while she was mid-entry');
});

test('a resume with a worker waiting offers it again, so "Not now" is not permanent', () => {
  // The regression. Before recheck existed this was unreachable: the prompt could
  // only ever be raised once per waiting worker, and dismissing it was final.
  const w = watched({ waiting: false });
  w.setWaiting();
  assert.equal(w.handle.recheck(docIdle), 'offered');
  assert.equal(w.told(), 1, 'did not re-offer a waiting update on resume');
});

test('re-offering does not reload the page under her', () => {
  const w = watched({ waiting: false });
  w.setWaiting();
  w.handle.recheck(docIdle);
  assert.equal(w.reloads(), 0, 'reloaded on resume instead of asking');
  assert.equal(w.posted.length, 0, 'took the update without being asked');
});

test('a resume with nothing waiting asks the server, which nothing else ever did', () => {
  const w = watched({ waiting: false });
  assert.equal(w.handle.recheck(docIdle), 'checked');
  assert.equal(w.updates(), 1, 'never asked whether a newer version exists');
  assert.equal(w.told(), 0, 'offered an update that does not exist');
});

test('resuming repeatedly keeps asking rather than giving up', () => {
  const w = watched({ waiting: false });
  w.handle.recheck(docIdle);
  w.handle.recheck(docIdle);
  w.handle.recheck(docIdle);
  assert.equal(w.updates(), 3);
});

test('a first install on resume checks rather than offering', () => {
  // No controller means nothing to replace, so there is nothing to tell her about.
  const w = watched({ waiting: false, hasController: false });
  w.setWaiting();
  assert.equal(w.handle.recheck(docIdle), 'checked');
  assert.equal(w.told(), 0, 'offered an update to a page with no worker in charge');
});
