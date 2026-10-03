import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Static guards on the browser suite itself.
 *
 * `test/browser/` runs in a browser and therefore cannot run here — but two things about it are
 * safety properties rather than test results, and they are checkable from the source:
 *
 *   1. **The page must not boot the app.** It is served from the same origin as Daybook, so it
 *      shares her `localStorage`. `js/app.js` boots on load and calls `Store.init()`, which reads
 *      and writes her diary. Loading it here would make opening this page on her device a write to
 *      a real person's health record. The runner's own diary check is the detective control; this
 *      is the preventive one, and it fails in CI rather than on her phone.
 *   2. **The suite must not be empty.** A page that registers no tests reports "0 passed" in green.
 *      A suite reporting success because it ran nothing is this project's signature failure.
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const page = readFileSync(ROOT + 'test/browser/index.html', 'utf8');
const tests = readFileSync(ROOT + 'test/browser/tests.js', 'utf8');
const runner = readFileSync(ROOT + 'test/browser/runner.js', 'utf8');

test('the browser test page does not load js/app.js', () => {
  // Matches a real script tag, not the several comments that explain why it is absent.
  const scripts = [...page.matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/g)].map((m) => m[1]);
  const bootsTheApp = scripts.filter((src) => /(^|\/)app\.js$/.test(src));
  assert.deepEqual(bootsTheApp, [],
    'app.js boots on load and calls Store.init(), which would write to her diary from a test page');
});

test('the browser test page loads the modules it does need', () => {
  const scripts = [...page.matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/g)].map((m) => m[1]);
  for (const needed of ['store.js', 'ui.js', 'update.js']) {
    assert.ok(scripts.some((s) => s.endsWith(needed)), `the suite asks questions of ${needed}`);
  }
});

test('the browser suite is not empty', () => {
  const registered = [...tests.matchAll(/^test\(/gm)].length + [...tests.matchAll(/\n\s{2}test\(/g)].length;
  assert.ok(registered >= 10, `expected a real suite, found ${registered} registered tests`);
});

test('the runner proves the diary was untouched rather than asserting it', () => {
  assert.match(runner, /snapshotDiary/, 'the diary guard is what makes this page safe to open');
  assert.match(runner, /did not touch her diary/, 'and it must appear as a named result, not a silent check');
});

test('a ?only= filter that matches nothing is an error, not an empty pass', () => {
  assert.match(runner, /matched no test out of/,
    'a suite reporting success because it ran nothing is this project\'s signature failure');
});
