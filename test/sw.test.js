import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/**
 * The service worker's fetch handler, run without a browser.
 *
 * `sw.js` is a classic script, so it runs in a VM with a fake origin, fake caches and a fetch that
 * counts what it was asked for. The network always answers with the NEXT release's bytes, because
 * that is the situation that matters: a release has been published and her device is still running
 * the one before it.
 *
 * Why this exists (`findings.md` F14): the worker used to answer from cache and then refresh that
 * entry from the network in the background, into its own cache. So the release she was running took
 * in the next one's files before she said yes, and About could name one release while serving
 * another. A new worker waiting for her "Get it" is only a promise if the old one does not change
 * underneath her.
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SCOPE = 'https://example.test/daybook/';
const SW_URL = SCOPE + 'sw.js';

const key = (input) => new URL(typeof input === 'string' ? input : input.url, SW_URL).href;
const response = (body) => ({ ok: true, status: 200, body, clone: () => response(body) });

function fakeCache() {
  const entries = new Map();
  let puts = 0;
  return {
    entries,
    puts: () => puts,
    match: (req) => Promise.resolve(entries.get(key(req))),
    put: (req, res) => { puts += 1; entries.set(key(req), res); return Promise.resolve(); },
    keys: () => Promise.resolve([...entries.keys()].map((url) => ({ url }))),
  };
}

/** Boot sw.js with its own cache seeded as `cached` ({ path: body }). */
function boot(cached) {
  const listeners = {};
  const stores = new Map();
  const fetched = [];
  const context = {
    self: {
      addEventListener: (type, fn) => { listeners[type] = fn; },
      location: new URL(SW_URL),
      registration: { scope: SCOPE },
      skipWaiting: () => {},
      clients: { claim: () => Promise.resolve() },
    },
    caches: {
      open: (name) => {
        if (!stores.has(name)) stores.set(name, fakeCache());
        return Promise.resolve(stores.get(name));
      },
      match: (req) => {
        for (const c of stores.values()) if (c.entries.has(key(req))) return Promise.resolve(c.entries.get(key(req)));
        return Promise.resolve(undefined);
      },
      keys: () => Promise.resolve([...stores.keys()]),
      delete: (name) => Promise.resolve(stores.delete(name)),
    },
    fetch: (req) => { fetched.push(key(req)); return Promise.resolve(response('next:' + new URL(key(req)).pathname)); },
    URL,
    Request: class { constructor(url) { this.url = key(url); } },
    console,
  };
  vm.createContext(context);
  vm.runInContext(readFileSync(ROOT + 'sw.js', 'utf8'), context);
  const name = vm.runInContext('CACHE', context);
  const own = fakeCache();
  stores.set(name, own);
  for (const [path, body] of Object.entries(cached)) own.entries.set(key(path), response(body));

  /** Dispatch one fetch, wait for it AND for anything it set off in the background. */
  async function get(path, mode = 'no-cors') {
    let answered;
    const event = {
      request: { method: 'GET', url: key(path), mode },
      respondWith: (p) => { answered = Promise.resolve(p); },
    };
    listeners.fetch(event);
    const res = answered ? await answered : undefined;
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
    return res;
  }
  return { get, fetched, own };
}

test('a cached file is served from the cache, and the network is not asked', async () => {
  const sw = boot({ './js/app.js': 'this:app' });
  const res = await sw.get('./js/app.js');
  assert.equal(res.body, 'this:app');
  assert.deepEqual(sw.fetched, [], 'a cache hit went to the network, which is how the next release got in');
  assert.equal(sw.own.puts(), 0, 'a cache hit wrote to the cache');
});

test('the app\'s page is served from the cache, and the network is not asked', async () => {
  const sw = boot({ './index.html': 'this:page' });
  const res = await sw.get('./', 'navigate');
  assert.equal(res.body, 'this:page');
  assert.deepEqual(sw.fetched, [], 'opening the app went to the network for a page it already had');
  assert.equal(sw.own.puts(), 0, 'opening the app rewrote the cached page');
});

test('a published release does not reach her until a new worker does', async () => {
  // The F14 sequence: the next release is live, she opens the app twice under the old worker.
  const sw = boot({ './index.html': 'this:page', './js/app.js': 'this:app' });
  await sw.get('./', 'navigate');
  await sw.get('./js/app.js');
  const page = await sw.get('./', 'navigate');
  const app = await sw.get('./js/app.js');
  assert.equal(page.body, 'this:page', 'the second open served the next release\'s page');
  assert.equal(app.body, 'this:app', 'the second open served the next release\'s script');
  assert.equal(sw.own.entries.get(key('./js/app.js')).body, 'this:app', 'the cache now holds the next release');
});

test('a file the cache lacks is fetched and kept, so the next offline open has it', async () => {
  // An install that lost a file to a dropped connection. Healing the gap beats an app that will not
  // open offline until the next release; the bytes are the server's, which is this release's
  // unless another has shipped since.
  const sw = boot({});
  const res = await sw.get('./js/store.js');
  assert.equal(res.body, 'next:/daybook/js/store.js');
  assert.ok(sw.own.entries.has(key('./js/store.js')), 'the gap was served but not kept');
});

test('a one-off URL is fetched and never kept', async () => {
  const sw = boot({ './js/app.js': 'this:app' });
  await sw.get('./js/app.js?probe=1');
  assert.deepEqual(sw.fetched, [key('./js/app.js?probe=1')]);
  assert.equal(sw.own.puts(), 0, 'a query-string URL was stored, which grows the cache without bound');
});

test('a page outside the app is left to the network', async () => {
  const sw = boot({ './index.html': 'this:page' });
  const res = await sw.get('./test/browser/', 'navigate');
  assert.equal(res, undefined, 'the worker answered a navigation that is not the app');
});
