import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/**
 * `Store.upsert` and `Store.dropById`, checked without a browser.
 *
 * These two decide whether editing an activity updates the one she already noted or quietly becomes
 * a second one beside it. That is the whole risk of making a list entry editable: a mistake here
 * duplicates an entry or drops the wrong one, and there is no undo and no server copy (B4).
 *
 * `js/store.js` is a classic script, so it runs in a VM and is asked for its module the same way the
 * browser gets it. It touches `localStorage` at init, which is not called here — only the two pure
 * list functions are, and they close over nothing.
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url));

function load() {
  const store = {};
  const context = {
    window: {},
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {}
    },
    console
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(readFileSync(ROOT + 'js/store.js', 'utf8'), context);
  assert.ok(context.Store, 'js/store.js did not expose Store');
  return context.Store;
}

const Store = load();

/* ------------------------------------------------------------------ upsert */

test('an entry with a new id is appended', () => {
  const list = [{ id: 'a', activity: 'Walk' }];
  const out = Store.upsert(list, { id: 'b', activity: 'Stairs' });
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((e) => e.id), ['a', 'b']);
});

test('an entry with an existing id replaces it in place, and does not duplicate', () => {
  const list = [{ id: 'a', activity: 'Walk' }, { id: 'b', activity: 'Stairs' }];
  const out = Store.upsert(list, { id: 'a', activity: 'Long walk' });
  assert.equal(out.length, 2, 'editing must not grow the list');
  assert.equal(out[0].activity, 'Long walk');
  assert.equal(out[0].id, 'a');
  assert.equal(out[1].activity, 'Stairs', 'the other entry is untouched');
});

test('replacing keeps the entry in its original position', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const out = Store.upsert(list, { id: 'b', note: 'edited' });
  assert.deepEqual(out.map((e) => e.id), ['a', 'b', 'c']);
  assert.equal(out[1].note, 'edited');
});

test('the original list is not mutated, so an abandoned edit changes nothing', () => {
  const list = [{ id: 'a', activity: 'Walk' }];
  const out = Store.upsert(list, { id: 'a', activity: 'Changed' });
  assert.equal(list[0].activity, 'Walk', 'caller keeps its own array until it saves');
  assert.equal(out[0].activity, 'Changed');
  assert.notEqual(out, list);
});

test('an absent or empty list is tolerated', () => {
  // Compared by value, not with deepEqual on the array itself. When the list is
  // absent, store.js builds the array inside the VM realm, so it carries that
  // realm's Array.prototype and a strict deep compare fails on the prototype
  // rather than on anything that matters. See anti-patterns.md.
  for (const input of [null, undefined, []]) {
    const out = Store.upsert(input, { id: 'a' });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'a');
  }
});

test('an entry with no id is refused rather than appended without identity', () => {
  // An entry that cannot be found again could never be edited or removed, so
  // silently storing one would strand it in her diary.
  const list = [{ id: 'a' }];
  assert.deepEqual(Store.upsert(list, { activity: 'No id' }), [{ id: 'a' }]);
  assert.deepEqual(Store.upsert(list, null), [{ id: 'a' }]);
});

/* ---------------------------------------------------------------- dropById */

test('dropById removes only the matching entry', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(Store.dropById(list, 'b').map((e) => e.id), ['a', 'c']);
});

test('dropById on an id that is not there changes nothing', () => {
  const list = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(Store.dropById(list, 'zzz').map((e) => e.id), ['a', 'b']);
});

test('dropById does not mutate the original list', () => {
  const list = [{ id: 'a' }, { id: 'b' }];
  Store.dropById(list, 'a');
  assert.equal(list.length, 2);
});

test('dropById tolerates an absent list', () => {
  // Length, not deepEqual — same cross-realm reason as above.
  assert.equal(Store.dropById(null, 'a').length, 0);
  assert.equal(Store.dropById(undefined, 'a').length, 0);
});
