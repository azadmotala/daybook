import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { fingerprint, precachePaths } from '../tools/stamp-sw.mjs';

/**
 * The service worker's precache list, checked against the filesystem.
 *
 * **Why this is worth more than it looks.** A file missing from the list breaks nothing while she
 * is online — the network quietly fills the gap — so it ships green and fails on a plane, which is
 * the one place offline was actually promised. The failure is silent, delayed, and lands in exactly
 * the situation the feature existed for.
 *
 * The expected list is **derived from the directory**, never from a second copy of the list. A
 * check that read its expectations from `sw.js` would agree with `sw.js` whatever either of them
 * said.
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SW = readFileSync(ROOT + 'sw.js', 'utf8');

/** Everything the app loads at runtime. */
function shippedFiles() {
  const out = ['index.html', 'styles.css', 'manifest.webmanifest'];

  const walk = (dir, pattern) => {
    for (const entry of readdirSync(ROOT + dir)) {
      const relative = `${dir}${entry}`;
      if (statSync(ROOT + relative).isDirectory()) walk(`${relative}/`, pattern);
      else if (pattern.test(entry)) out.push(relative);
    }
  };
  walk('js/', /\.js$/);
  walk('fonts/', /\.woff2$/);

  // **Icons are found by what references them, not by listing the directory.** A directory listing
  // would demand that build intermediates be precached too, and would go quiet the day someone adds
  // an icon to the manifest without adding the file.
  const referenced = new Set();
  const manifest = JSON.parse(readFileSync(ROOT + 'manifest.webmanifest', 'utf8'));
  for (const icon of manifest.icons) referenced.add(icon.src);
  for (const m of readFileSync(ROOT + 'index.html', 'utf8').matchAll(/(?:href|src)="(icons\/[^"]+)"/g)) {
    referenced.add(m[1]);
  }
  out.push(...referenced);

  return [...new Set(out)].sort();
}

test('every file the app loads is precached', () => {
  const listed = new Set(precachePaths(SW));
  const missing = shippedFiles().filter((f) => !listed.has(f));
  assert.deepEqual(missing, [], `not precached, so unavailable offline:\n  ${missing.join('\n  ')}`);
});

test('nothing precached is missing from disk', () => {
  const absent = precachePaths(SW)
    .filter((p) => p !== '' && !existsSync(ROOT + p));
  assert.deepEqual(absent, [], `precached but not on disk:\n  ${absent.join('\n  ')}`);
});

test('the cache name matches what is precached', () => {
  const declared = /var CACHE = 'daybook-([0-9a-f]+)';/.exec(SW);
  assert.ok(declared, 'sw.js does not declare a stamped CACHE name');

  const expected = fingerprint(new URL('../', import.meta.url), precachePaths(SW));
  assert.equal(
    declared[1],
    expected,
    `\n  A precached file changed but sw.js was not restamped, so the browser will\n` +
    `  never install a new worker and will serve the old files forever.\n\n` +
    `  Fix: node tools/stamp-sw.mjs   (expected daybook-${expected})\n`,
  );
});

test('the cache name is not hand-versioned', () => {
  // A `daybook-v3` style name is the thing this whole mechanism replaced.
  assert.doesNotMatch(SW, /var CACHE = 'daybook-v\d+';/,
    'CACHE looks hand-bumped. Run node tools/stamp-sw.mjs instead.');
});
