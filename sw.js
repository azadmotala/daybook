/* ============================================================
   Service worker — the app must open on a bus, in a waiting
   room, on a device with no data left. Everything is cached.

   CACHE is NOT edited by hand. `node tools/stamp-sw.mjs` derives
   it from a fingerprint of every file in PRECACHE, and
   test/precache.test.js fails if it is stale. Bumping a version
   by hand works right up until the release someone forgets, and
   then the browser sees no new worker, never reinstalls, and
   serves the old files forever.
   ============================================================ */

var CACHE = 'daybook-49fdffa67087';

var PRECACHE = [
  './',
  './index.html',
  './styles.css',
  './js/store.js',
  './js/engine.js',
  './js/ui.js',
  './js/demo.js',
  './js/update.js',
  './js/app.js',
  './manifest.webmanifest',
  './fonts/atkinson-400-latin.woff2',
  './fonts/atkinson-400-latin-ext.woff2',
  './fonts/atkinson-700-latin.woff2',
  './fonts/atkinson-700-latin-ext.woff2',
  './fonts/atkinson-400-italic-latin.woff2',
  './fonts/atkinson-400-italic-latin-ext.woff2',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/icon-180.png',
  './icons/favicon-32.png',
  './icons/favicon-16.png',
  './icons/icon-monochrome.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      /* Forgiving on purpose: addAll rejects the whole install if one
         entry 404s, and the cost of that is no service worker at all —
         no offline, for everything. A wrong path is caught by
         test/precache.test.js before it ever ships, which is the right
         place for it. */
      /* `cache: 'reload'` is load-bearing, not a nicety. A plain cache.add() is an
         ordinary fetch, so it may be answered from the browser's own HTTP cache —
         and these filenames never change, only their contents do. That let a brand
         new worker precache the files it was replacing and then serve them under a
         fresh cache name that claimed to be current: the update lands, the cache
         name changes, and the app is still the old one. Reproduced locally, a cache
         holding a 4222-byte js/update.js while the server had 5686.
         'reload' bypasses the HTTP cache and goes to the network. */
      return Promise.all(PRECACHE.map(function (url) {
        var req;
        try { req = new Request(url, { cache: 'reload' }); } catch (e) { req = url; }
        return cache.add(req).catch(function () {
          // A browser that refuses the option should still get a worker, just a
          // less certain one. Better a possibly-stale cache than none at all.
          return cache.add(url).catch(function () { return null; });
        });
      }));
    })
    /* No skipWaiting here. A new worker waits until she says yes, or
       until the next cold start takes it (js/update.js). Taking over
       mid-session would reload the page under her. */
  );
});

self.addEventListener('message', function (event) {
  if (!event.data) return;

  // Sent by js/update.js when she taps "Get it".
  if (event.data.type === 'SKIP_WAITING') self.skipWaiting();

  /* Which build is actually running, for the About screen. The page cannot read
     CACHE itself, and the *active worker* is the honest answer: it is the thing
     serving her files, so it is the number that says whether an update landed.
     Asking the page what it thinks it is would answer a different question. */
  if (event.data.type === 'VERSION' && event.ports && event.ports[0]) {
    event.ports[0].postMessage(CACHE);
  }
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  // Nothing is fetched from anywhere else. The fonts are ours now.
  if (url.origin !== self.location.origin) return;

  /* Everything this release cached is served as it was cached, and nothing is
     refreshed behind the scenes. That refresh used to write the next release's
     files into this release's cache on the first open after a deploy, so the app
     she was running changed underneath her before she said yes, and About could
     name one release while serving another (findings F14). New bytes now arrive
     only with a new worker, and a new worker waits for her "Get it". */

  // Page loads: the app's own document, from this release's cache.
  //
  // **Only the app's own document.** This used to answer every navigation in
  // scope with the app shell, whatever the path. The app is a single page with
  // no client-side routes, so nothing needed that, and it made every other page
  // on the origin unreachable — including test/browser/, which returned the app
  // with the test page's URL in the address bar. Anything else falls through to
  // the network, where a real 404 is a more honest answer than the app.
  if (req.mode === 'navigate') {
    var home = new URL('./', self.registration.scope).pathname;
    if (url.pathname !== home && url.pathname !== home + 'index.html') return;
    event.respondWith(
      caches.match('./index.html').then(function (hit) {
        return hit || fillGap(req, './index.html');
      })
    );
    return;
  }

  /* A one-off URL is never worth keeping. The app asks for no query strings, so anything
     carrying one is a cache-buster or a probe, and storing it grows the cache without bound
     — entries only ever leave when the cache name changes at the next release. The browser
     suite's own cached-versus-served check fetches every precached file with a fresh query
     each run, and after a handful of runs `cache.keys()` failed with "Operation too large".
     Serve it from the network, keep nothing. */
  var oneOff = url.search !== '';

  event.respondWith(
    caches.match(req).then(function (hit) {
      return hit || fillGap(req, oneOff ? null : req);
    })
  );
});

/* A file this release's cache does not hold: an install that lost it to a
   dropped connection, since install forgives a failed entry rather than leave
   her with no worker at all. Fetch it and keep it, so the next open with no
   signal still works. The bytes are the server's, which are this release's
   unless another has shipped since; an app that will not open offline until the
   next release is the worse of the two. `keepAs` null means fetch, keep nothing. */
function fillGap(req, keepAs) {
  return fetch(req).then(function (res) {
    if (res && res.ok && keepAs) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(keepAs, copy); });
    }
    return res;
  });
}
