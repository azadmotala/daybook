/* ============================================================
   Telling her a newer Daybook is ready, and letting her choose it.

   The service worker updates itself; the page already running does
   not. A desktop browser hides that, because every refresh is a fresh
   document load. An installed app on a phone is resumed rather than
   cold-started, so the second load can be days away or never — which
   is how a fix sits on the server for a week while she uses the
   version it replaced.

   Two paths, and the split is the whole design:

     - Waiting at boot means the worker installed during an earlier
       session, so she has already had a chance to take it. Take it
       now, without asking. Safe by construction: at boot no sheet is
       open, so there is nothing of hers to lose.
     - Installed during this session means she is using the app right
       now. Ask, and hold the asking until she is not mid-entry.

   Nothing here touches her notes. A reload does not clear
   localStorage, so the diary survives by construction; what a reload
   would lose is a half-filled sheet, which is what the busy check is
   for.
   ============================================================ */

var Updater = (function () {
  'use strict';

  /**
   * Is she in the middle of something a reload would throw away?
   *
   * An open sheet is the only such thing in this app: a half-entered activity, a meal she has
   * typed but not added, a reading on the keypad. Everything else auto-saves the moment it is
   * tapped, so a reload costs nothing.
   */
  function isBusy(doc) {
    var sheet = (doc || document).getElementById('sheet');
    return !!(sheet && !sheet.hidden);
  }

  /**
   * What the prompt should do right now. Pure, so it can be reasoned about without a browser.
   *
   * @returns {'none'|'busy'|'ready'} `busy` is "yes, but not yet" — the caller draws nothing and
   *   will ask again on the next render, which is what makes the queueing free.
   */
  function promptState(ready, doc) {
    if (!ready) return 'none';
    return isBusy(doc) ? 'busy' : 'ready';
  }

  /**
   * Watch a registration for a newer worker.
   *
   * @param {ServiceWorkerRegistration} reg
   * @param {() => void} onReady called when a newer version is waiting *during* this session.
   *   Not called for the boot case, which takes the update rather than asking about it.
   * @returns {{ take: () => void }} `take` is what the prompt's button calls.
   */
  function watch(reg, onReady) {
    var container = navigator.serviceWorker;

    /* Only reload for a swap we asked for. `controllerchange` also fires the first time a worker
       takes control of a page that had none — every first-time visitor — and reloading there is a
       pointless flash at best and a loop at worst. */
    var asked = false;

    container.addEventListener('controllerchange', function () {
      if (!asked) return;
      window.location.reload();
    });

    function take() {
      var waiting = reg.waiting;
      // Nothing waiting is not an error: she may have tapped twice, or it may have activated on
      // its own between the render and the tap.
      if (!waiting) return;
      asked = true;
      waiting.postMessage({ type: 'SKIP_WAITING' });
    }

    // Path 1 — already waiting when this page loaded, so it has been waiting since a previous
    // session. Take it. `controller` must exist, or this is a first install with nothing to replace.
    if (reg.waiting && container.controller) {
      take();
      return { take: take, recheck: recheck };
    }

    /**
     * Ask again, when the app comes back to the foreground.
     *
     * **Why this exists, and it is not belt-and-braces.** Everything above happens once, on a
     * document load. An installed app on a phone is resumed rather than cold-started, so `load`
     * can go days without firing again — and `updatefound` cannot fire a second time for a worker
     * that is already installed and waiting. So once "Not now" was tapped, there was no route back:
     * the prompt could never reappear and the boot path never ran. Observed on an iPhone, where
     * opening the app twice still served the version it was replacing.
     *
     * Three cases, in order:
     *   - mid-entry: do nothing, and the next resume asks again
     *   - already waiting: offer it, rather than reloading the page while she is looking at it
     *   - nothing waiting: ask the server, which is the only thing that can find a new one.
     *     Nothing else in the app ever called `reg.update()`.
     *
     * @returns {'busy'|'offered'|'checked'} named so a test can tell the three apart.
     */
    function recheck(doc) {
      if (isBusy(doc)) return 'busy';
      if (reg.waiting && container.controller) { onReady(); return 'offered'; }
      if (typeof reg.update === 'function') {
        try { reg.update(); } catch (e) { /* offline, or the browser said no. Ask again next time. */ }
      }
      return 'checked';
    }

    // Path 2 — one arrives while she is using the app.
    reg.addEventListener('updatefound', function () {
      var installing = reg.installing;
      if (!installing) return;
      installing.addEventListener('statechange', function () {
        // `installed` with a controller present means "a newer one is ready and an older one is in
        // charge". Without a controller it is the first install, and there is nothing to tell her.
        if (installing.state === 'installed' && container.controller) onReady();
      });
    });

    return { take: take, recheck: recheck };
  }

  return { isBusy: isBusy, promptState: promptState, watch: watch };
})();
