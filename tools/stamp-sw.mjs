/**
 * Stamp the service worker's cache name with a fingerprint of what it precaches.
 *
 *     node tools/stamp-sw.mjs
 *
 * **Why this exists, and it is not tidiness.** A service worker only reinstalls when `sw.js` itself
 * changes. If a precached file changes and the cache name does not, the browser sees no new worker,
 * never reinstalls, and serves the old file **forever** — offline and online alike. Bumping a
 * version by hand works right up until the release where someone forgets, and then the failure is
 * silent, permanent, and looks like "the update didn't go out".
 *
 * This app was built with a hand-bumped `daybook-v2` style version and it was bumped fifteen times
 * in one afternoon. That is the argument.
 *
 * There is no build step, so the fingerprint is stamped by this script and **verified by
 * `test/precache.test.js`**: change a precached file without restamping and the suite goes red with
 * the value to paste. A release ritual becomes a check.
 *
 * Zero dependencies, and it never ships to the device.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = new URL('../', import.meta.url);

/** Read the precache list out of `sw.js`. It is the list the worker will actually install. */
export function precachePaths(source) {
  const match = source.match(/var PRECACHE = \[([\s\S]*?)\];/);
  if (!match) throw new Error('sw.js no longer declares a PRECACHE array');
  return [...match[1].matchAll(/'([^']+)'/g)]
    .map((m) => m[1].replace(/^\.\//, ''))
    .filter((path) => path !== '');
}

/**
 * A fingerprint of every precached file's contents, **and of `sw.js` itself**.
 *
 * Paths go in as well as bytes, so renaming a file changes the fingerprint even if its contents are
 * identical.
 *
 * **Why `sw.js` is in here despite not being precached.** The cache name has two jobs. Forcing a new
 * cache when precached content changes is the original one, and for that the worker's own code is
 * irrelevant — a logic change needs a new *worker*, which the browser installs on any byte
 * difference, not a new *cache*. The second job arrived later: this string is the version the About
 * screen reports, and a version that cannot distinguish two different workers is not answering the
 * question it is being asked. A worker-only fix would ship and read as the release it replaced.
 *
 * The `CACHE` line is masked before hashing, because hashing a value into the file that holds it
 * never settles.
 */
export function fingerprint(rootUrl, paths) {
  const hash = createHash('sha256');
  // 'sw.js' sorts among the rest rather than being appended, so the order stays content-derived.
  for (const path of [...paths, 'sw.js'].sort()) {
    hash.update(path);
    const bytes = path === 'sw.js'
      ? Buffer.from(readFileSync(new URL(path, rootUrl), 'utf8')
          .replace(/var CACHE = '[^']*';/, "var CACHE = '<stamped>';"), 'utf8')
      : readFileSync(new URL(path, rootUrl));
    // **Line endings are normalised before hashing, for text only.** Git rewrites LF to CRLF on
    // checkout on Windows, so hashing raw bytes would make the fingerprint a property of *this
    // checkout* rather than of the content: a fresh clone elsewhere computes a different value and
    // the precache test fails with a message about restamping that restamping does not fix.
    // Binaries (woff2, png) are hashed as-is — a byte-for-byte normalise would corrupt them.
    hash.update(/\.(woff2|png|svg)$/.test(path) && !path.endsWith('.svg')
      ? bytes
      : bytes.toString('utf8').replace(/\r\n/g, '\n'));
  }
  return hash.digest('hex').slice(0, 12);
}

/**
 * **Only when run directly.** `test/precache.test.js` imports `fingerprint` from this file, and
 * importing an ES module executes its top level — so without this guard the test would restamp
 * `sw.js` on import and then assert that the stamp it had just written was correct. It passed
 * unconditionally, including on a deliberately stale stamp. A check that repairs the fault it is
 * looking for is worse than no check, because it reports green.
 */
function main() {
  const swPath = fileURLToPath(new URL('sw.js', root));
  const source = readFileSync(swPath, 'utf8');
  const stamp = fingerprint(root, precachePaths(source));

  const updated = source.replace(/var CACHE = '[^']*';/, `var CACHE = 'daybook-${stamp}';`);
  if (updated === source) {
    console.log(`already stamped: daybook-${stamp}`);
  } else {
    writeFileSync(swPath, updated);
    console.log(`stamped sw.js: daybook-${stamp}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
