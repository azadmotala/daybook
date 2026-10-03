/**
 * The checks that need a real browser.
 *
 * Everything provable from source or from a pure function belongs in `node --test`. What is here is
 * what only a browser can answer, and each one exists because it was checked by hand once and thrown
 * away: `findings.md` F6.
 *
 * **Nothing here writes to storage.** `js/app.js` is deliberately not loaded by the page, because it
 * boots on load and calls `Store.init()`, which reads and writes her diary. The other modules are
 * plain IIFEs with no load-time side effects, so they can be loaded and asked questions safely. The
 * runner proves the diary was untouched as its final result.
 */

import { test, assert, contrast, token, underTheme, afterPaint } from './runner.js';

const ROOT = new URL('../../', location.href);
const url = (path) => new URL(path, ROOT).href;

/* ============================================================ the shipped code */

/**
 * The app is ES5-compatible on purpose, for an older Android phone. A syntax feature the target
 * browser rejects makes the whole file fail to parse, and the app is simply blank — there is no
 * partial failure to notice. This asks the browser that is running, which is the only one whose
 * answer counts.
 */
test('every shipped script parsed and exposed its global', () => {
  const expected = { Store: 'js/store.js', Engine: 'js/engine.js', UI: 'js/ui.js', Demo: 'js/demo.js', Updater: 'js/update.js' };
  const missing = Object.keys(expected).filter((name) => typeof window[name] === 'undefined');
  assert.empty(missing.map((n) => `${n} (${expected[n]})`), 'a script did not parse or did not expose its global');
});

test('the modules the page loads do not touch storage on load', () => {
  // Guards the assumption the whole page rests on. If a module ever gains a top-level Store.init()
  // or a localStorage read, this page becomes unsafe to open on her device and this says so.
  // The runner's diary check is the other half; this one names the cause rather than the symptom.
  assert.equal(typeof Store.init, 'function', 'Store.init should exist but not have been called');
  assert.equal(document.getElementById('view'), null, 'the app shell is not on this page, so app.js cannot have booted');
});

/* ============================================================ media queries */

/**
 * F6's first real catch, kept as a regression.
 *
 * Inside a media query, `rem` and `em` resolve against the browser's initial 16px and ignore the
 * font-size on `:root`. `@media (max-width: 22rem)` was written meaning 22 x the app's 18px root =
 * 396px and evaluated at 352px, so the update prompt's stacked layout never fired on any ordinary
 * phone. Nothing in the repo could have caught that. This can, for every rule at once.
 */
test('no media query is written in rem or em', () => {
  const offenders = [];
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }   // a cross-origin sheet has none to read
    if (!rules) continue;
    for (const rule of rules) {
      if (rule.type !== CSSRule.MEDIA_RULE) continue;
      const text = rule.conditionText || rule.media.mediaText;
      if (/[\d.]\s*r?em\b/.test(text)) offenders.push(`@media ${text}`);
    }
  }
  assert.empty(offenders,
    'rem/em in a media query resolves against 16px, not the root font size, so this fires at a width nobody intended');
});

/**
 * The threshold, read from the rule itself.
 *
 * A first version of this asked `matchMedia('(min-width: 360px)')`, which reports whether the
 * *current viewport* is at least 360px — nothing at all about where the rule switches. It failed on
 * a desktop viewport and would have "passed" on a phone while proving nothing either way. A page
 * cannot resize itself, so the honest thing to read is the stylesheet.
 */
test('the update prompt switches layout above phone widths, in px', () => {
  const conditions = [];
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    if (!rules) continue;
    for (const rule of rules) {
      if (rule.type !== CSSRule.MEDIA_RULE) continue;
      if (!/\.update\b/.test(rule.cssText)) continue;
      conditions.push(rule.conditionText || rule.media.mediaText);
    }
  }
  assert.equal(conditions.length, 1, `expected one media rule governing .update, found: ${conditions.join(' | ') || 'none'}`);

  const condition = conditions[0];
  const px = /min-width:\s*(\d+)px/.exec(condition);
  assert.ok(px, `the threshold must be in px, not a unit that resolves against 16px: ${condition}`);
  assert.atLeast(Number(px[1]), 480,
    'a phone must get the stacked layout; anything at or below 430px would put the squeeze back');
});

/* ============================================================ colour */

const SURFACES = ['--paper', '--card'];
const TEXT_TOKENS = ['--ink', '--ink-2', '--ink-3'];

for (const theme of ['light', 'dark']) {
  test(`every text colour clears WCAG AA on every surface (${theme})`, async () => {
    await underTheme(theme, async () => {
      const failures = [];
      for (const ink of TEXT_TOKENS) {
        for (const surface of SURFACES) {
          const ratio = contrast(token(ink), token(surface));
          if (ratio < 4.5) failures.push(`${ink} on ${surface}: ${ratio}`);
        }
      }
      assert.empty(failures, 'AA is the floor for all text, and --ink-3 carries every hint and caption');
    });
  });

  test(`a reading's state colour is readable on the card it sits on (${theme})`, async () => {
    await underTheme(theme, async () => {
      const failures = [];
      for (const state of ['--state-in', '--state-hi', '--state-lo']) {
        const ratio = contrast(token(state), token('--card'));
        if (ratio < 4.5) failures.push(`${state} on --card: ${ratio}`);
      }
      assert.empty(failures, 'a number she cannot read is worse than an uncoloured one');
    });
  });
}

/**
 * State colour is for a reading against her range, and nothing else. Three grading bugs once lived
 * in CSS, where no copy review would ever find them.
 *
 * This reads the stylesheet rather than a rendered screen, so it covers every rule including the
 * ones no test happens to render — but it is therefore blind to inline styles, which is worth
 * knowing rather than glossing.
 */
test('no CSS rule outside a reading paints with a state colour', async () => {
  const stateNames = ['--state-in', '--state-hi', '--state-lo'];
  const offenders = [];

  /* Selectors that ARE a reading, and may therefore wear its colour: the hero number and its chip,
     a chart dot and its halo, the `.val` / `.s-*` classes the app stamps on a value, and the chart's
     target band.

     The band was F10, and the owner ruled it a value **on the condition that the range came from her
     doctor**. That condition is the whole of the ruling: the band is not the app's opinion about a
     good zone, it is her doctor's numbers drawn to scale. With no range the chart draws neutral
     reference lines at her own highest and lowest instead, in `--ink-3`.

     Moving it in here means this sweep no longer guards it, so the condition is guarded separately
     by `test/chart-band.test.js`. */
  const isAReading = /\.(val|hero-value|hero-chip|ch-dot|ch-today|ch-halo|ch-band|ch-bandline|ch-bandtick)\b|\.s-(in|high|hi|low|lo)\b/;

  for (const sheet of document.styleSheets) {
    // Only the app's own stylesheet. This page styles its own pass/fail headings with state colours,
    // and sweeping itself would report the test harness as a defect in the app.
    if (!sheet.href || !/styles\.css$/.test(new URL(sheet.href, location.href).pathname)) continue;
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    if (!rules) continue;
    for (const rule of rules) {
      if (rule.type !== CSSRule.STYLE_RULE) continue;
      const declares = ['color', 'background-color', 'background', 'border-color', 'fill', 'stroke']
        .map((p) => rule.style.getPropertyValue(p))
        .join(' ');
      if (!declares.trim()) continue;
      const usesState = stateNames.some((n) => declares.includes(`var(${n})`));
      if (usesState && !isAReading.test(rule.selectorText)) offenders.push(`${rule.selectorText} { ${declares.trim()} }`);
    }
  }
  assert.empty(offenders, 'state colour belongs on values, never on furniture');
});

/**
 * `--danger` and `--state-lo` are the same hex, which is why the Remove button uses `--ink-2`.
 * If they ever diverge this test is wrong rather than the code, and it should be deleted — the
 * point is to record that the sweep above cannot tell them apart while they are equal.
 */
test('--danger and --state-lo are still the same colour, which the sweep cannot distinguish', () => {
  assert.equal(token('--danger'), token('--state-lo'),
    'if these differ now, the state-colour sweep can be tightened to catch danger-on-furniture too');
});

/* ============================================================ the DOM kit */

test('[hidden] beats an author rule that sets display', async () => {
  // `hidden` is only display:none in the UA stylesheet, so any author rule setting display wins
  // silently. `.update { display: grid }` once rendered an empty accent strip on every screen.
  const el = document.createElement('div');
  el.className = 'update';
  el.hidden = true;
  document.body.appendChild(el);
  await afterPaint();
  const display = getComputedStyle(el).display;
  el.remove();
  assert.equal(display, 'none', 'a hidden element with an author display rule is still on screen');
});

test('an icon has a size of its own and does not fill its container', async () => {
  const host = document.getElementById('sandbox');
  const wrap = document.createElement('div');
  wrap.style.cssText = 'width:300px;height:300px';
  wrap.appendChild(UI.icon('chev'));
  host.appendChild(wrap);
  await afterPaint();
  const box = wrap.firstChild.getBoundingClientRect();
  wrap.remove();
  assert.ok(box.width > 0 && box.height > 0, 'the icon did not render');
  assert.ok(box.height < 100, `an SVG with only a viewBox fills its container: ${Math.round(box.height)}px tall in a 300px box`);
});

/* ============================================================ what is cached */

/**
 * `findings.md` F9, and the reason this page exists at all.
 *
 * `tools/stamp-sw.mjs` derives the cache name from the files on disk and `test/precache.test.js`
 * proves the name is current. Neither can see the cache the browser actually serves from. On
 * 2026-08-09 that cache held the previous release's `js/update.js` under a correctly derived name,
 * because `cache.add()` had been answered from the browser's own HTTP cache. Correct name, wrong
 * bytes, and no test in the repo could tell.
 */
test('the worker cached the files the server is serving, not older ones', async () => {
  if (!('caches' in window)) { return; }                     // not an error: some contexts have no CacheStorage
  const names = await caches.keys();
  const daybook = names.filter((n) => n.indexOf('daybook-') === 0);
  if (daybook.length === 0) return;                          // nothing installed here yet, nothing to compare

  assert.equal(daybook.length, 1, `exactly one cache should survive activate, found: ${daybook.join(', ')}`);

  const cache = await caches.open(daybook[0]);

  /* The list comes from sw.js's own PRECACHE, not from `cache.keys()`.
     Two reasons, and the second was learned by breaking it. The question is "did the files that
     shipped get cached", which is what PRECACHE names — whatever else happens to be in the cache is
     a different question. And iterating the cache's own keys made this test grow the thing it was
     measuring: each run fetched every entry with a fresh query string, the worker stored each one,
     and after a few runs `cache.keys()` failed with "Operation too large". The worker no longer
     caches one-off URLs, and this no longer asks it to. */
  const swSource = await fetch(url('sw.js') + '?precachelist=' + Date.now()).then((r) => r.text());
  const listed = [...(/var PRECACHE = \[([\s\S]*?)\];/.exec(swSource)?.[1] ?? '').matchAll(/'([^']+)'/g)]
    .map((m) => m[1].replace(/^\.\//, ''))
    .filter(Boolean);
  assert.ok(listed.length > 0, 'could not read PRECACHE out of sw.js, so this test knows nothing');

  const textual = listed.filter((p) => /\.(js|css|html|webmanifest)$/.test(p) || p === '');
  const mismatches = [];

  for (const path of textual) {
    const target = url(path);
    const cached = await cache.match(target);
    if (!cached) { mismatches.push(`${path}: precached by name but not in the cache`); continue; }
    // A fresh query string misses the cache key, so this is the network copy.
    const live = await fetch(`${target}?cachecheck=${Date.now()}`, { cache: 'reload' })
      .then((r) => (r.ok ? r.text() : null))
      .catch(() => null);
    if (live === null) continue;                              // offline, which is not a failure of the cache
    const stored = await cached.text();
    if (stored.length !== live.length) {
      mismatches.push(`${path}: cached ${stored.length} bytes, server has ${live.length}`);
    }
  }
  assert.empty(mismatches, 'the cache holds files the server has since replaced, under a name that claims to be current');
});

/**
 * Found by this page, on its first run, before it had run a single test.
 *
 * The worker answered *every* navigation in scope with the app shell, so opening `test/browser/`
 * returned the app with the test page's URL in the address bar — the suite was unreachable the
 * moment a worker was registered. The app is a single page with no client-side routes, so nothing
 * ever needed the catch-all.
 *
 * Checked with a real navigation request rather than by reading `sw.js`, because the source is a
 * proxy for what the worker does and what the worker does is the whole question.
 */
test('a path that is not the app document is not answered with the app shell', async () => {
  if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) return;
  const response = await fetch('does-not-exist-' + Date.now() + '/', { mode: 'same-origin' });
  const body = await response.text();
  assert.doesNotMatch(body, /<title>Daybook: blood sugar diary<\/title>/,
    'the worker served the app shell for a path that is not the app');
});

test('this very page is not being served the app shell', () => {
  // The symptom as the reader would meet it. If this fails, every other result on this page is
  // about a document that is not this one.
  assert.match(document.title, /browser tests/, 'the page under the test URL is not the test page');
});

test('the cache name matches the worker that is running', async () => {
  if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) return;
  const reported = await new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (e) => resolve(e.data);
    navigator.serviceWorker.controller.postMessage({ type: 'VERSION' }, [channel.port2]);
    setTimeout(() => resolve(null), 1500);
  });
  if (reported === null) return;                              // an older worker predates the question
  const names = (await caches.keys()).filter((n) => n.indexOf('daybook-') === 0);
  assert.ok(names.includes(reported), `the running worker says ${reported}, caches are ${names.join(', ') || 'none'}`);
});

/* ============================================================ the fonts */

/**
 * B3 has no network path to close, so the check is that nothing was fetched from anywhere else.
 * Resource timing is read rather than the source, because the source is a proxy for what the browser
 * did and the whole point is what the browser did.
 */
test('nothing was fetched from another origin', () => {
  const foreign = performance.getEntriesByType('resource')
    .map((e) => new URL(e.name).origin)
    .filter((origin) => origin !== location.origin);
  assert.empty([...new Set(foreign)], 'B3: this is a named person\'s health record and nothing leaves the device');
});

test('Atkinson Hyperlegible is the face actually in use', async () => {
  await afterPaint();
  const probe = document.createElement('p');
  probe.textContent = 'reading';
  document.getElementById('sandbox').appendChild(probe);
  await afterPaint();
  const family = getComputedStyle(probe).fontFamily;
  const loaded = document.fonts ? document.fonts.check('1rem "Atkinson Hyperlegible"') : true;
  probe.remove();
  assert.match(family, /Atkinson Hyperlegible/, 'the body face should be the low-vision one');
  assert.ok(loaded, 'the family is named in CSS but the browser has not loaded a face for it');
});
