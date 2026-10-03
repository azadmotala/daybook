/**
 * A test runner that runs in the browser, with no dependencies.
 *
 * **Why this exists.** `node --test` proves everything that is a pure function or a static property
 * of the source, and that is most of what this repo can prove. It cannot prove what a browser
 * actually does: whether a contrast ratio clears AA once the browser has resolved the colours,
 * whether a media query fires at the width its author meant, or whether the service worker's cache
 * holds the files that shipped. Every one of those has been checked here by hand, in a console, and
 * thrown away afterwards. `findings.md` F6 and F9.
 *
 * A DOM shim asserting against itself would prove nothing about any of them — it would be a check
 * that agrees with itself, in the exact shape this workspace keeps getting caught by.
 *
 * So these run in a real browser, against the real files, in the real DOM. On a laptop, and on the
 * phone, which is the only place Safari behaves like Safari.
 *
 * Adapted from Pawfolio's `test/browser/runner.js`, including the three things it learned the hard
 * way: `afterPaint`, the loud failure when `?only=` matches nothing, and `href` in the results.
 *
 * **This page never writes to her diary.** No test here touches `localStorage`, and
 * `snapshotDiary`/`assertDiaryUntouched` prove it rather than asserting it. The page shares an
 * origin with the app, so a stray write here would be a write to a real person's health record.
 *
 * Deliberately tiny: an assertion, a runner, and a report. Anything cleverer would be a dependency.
 */

const tests = [];

export function test(name, fn) {
  tests.push({ name, fn });
}

const format = (value) => (typeof value === 'string' ? JSON.stringify(value) : String(value));

export const assert = {
  ok(value, message = 'expected a truthy value') {
    if (!value) throw new Error(message);
  },
  equal(actual, expected, message) {
    if (actual !== expected) {
      throw new Error(`${message ?? 'not equal'}\n  expected: ${format(expected)}\n  actual:   ${format(actual)}`);
    }
  },
  notEqual(actual, expected, message) {
    if (actual === expected) throw new Error(`${message ?? 'expected them to differ'}: ${format(actual)}`);
  },
  /**
   * At least `min`, and it says both numbers when it fails.
   *
   * A contrast failure that only says "false" sends you back to the console to find out by how much,
   * which is how a 4.49 gets waved through as "basically fine".
   */
  atLeast(actual, min, message) {
    if (!(actual >= min)) {
      throw new Error(`${message ?? 'below the floor'}\n  floor:  ${min}\n  actual: ${actual}`);
    }
  },
  match(text, pattern, message) {
    if (!pattern.test(text)) throw new Error(`${message ?? 'no match'}\n  ${pattern}\n  in: ${format(text)}`);
  },
  /**
   * The other half of `match`, and not a convenience. A presence check can be satisfied by the part
   * that was never broken; pinning that the wrong thing is absent is what separates "the right value
   * is here" from "a value is here".
   */
  doesNotMatch(text, pattern, message) {
    if (pattern.test(text)) {
      throw new Error(`${message ?? 'matched when it should not'}\n  ${pattern}\n  in: ${format(text)}`);
    }
  },
  /** Empty is the answer for most sweeps here, so the failure prints what was found. */
  empty(list, message) {
    if (list.length !== 0) {
      throw new Error(`${message ?? 'expected nothing'}\n  found ${list.length}:\n    ${list.map(format).join('\n    ')}`);
    }
  },
};

/**
 * Wait until the browser has actually rendered.
 *
 * **Not a sleep, and not defensive.** A test that claims to read *rendered* colours has to read them
 * after a render, and changing a custom property on `<html>` does not update
 * `getComputedStyle(document.body)` synchronously in iOS Safari. Desktop engines recalc eagerly
 * enough to hide that, so a test can pass on a laptop and fail on the only device that counts.
 *
 * This repo hit the same class of bug from the other side on 2026-08-09: a theme sweep that read
 * dark values while believing it was in light mode.
 */
export function afterPaint() {
  // Reading a layout property forces a synchronous style and layout recalculation, which is what
  // makes a new custom-property value visible to getComputedStyle.
  void document.documentElement.offsetHeight;

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    // Never depended on: requestAnimationFrame does not fire in a backgrounded or non-compositing
    // tab, and a suite that hangs with no output is worse than the failure it was avoiding.
    requestAnimationFrame(() => requestAnimationFrame(finish));
    setTimeout(finish, 50);
  });
}

/* ------------------------------------------------------------------ her diary */

/**
 * Every `diary.*` key and its exact value.
 *
 * This page loads the real modules at the real origin, which means it can see her real diary. It
 * must never change it (B4), and "must never" is worth a check rather than a comment: the guard runs
 * first and last, and any difference fails the suite by name.
 */
export function snapshotDiary() {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.indexOf('diary.') === 0) out[key] = localStorage.getItem(key);
  }
  return out;
}

export function diaryDifference(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [];
  for (const key of keys) {
    if (before[key] !== after[key]) {
      const was = before[key] === undefined ? 'absent' : `${before[key].length} bytes`;
      const now = after[key] === undefined ? 'absent' : `${after[key].length} bytes`;
      changed.push(`${key}: ${was} -> ${now}`);
    }
  }
  return changed;
}

/* --------------------------------------------------------------------- colour */

/** Relative luminance, per WCAG. */
function luminance(rgb) {
  const parts = String(rgb).match(/[\d.]+/g);
  if (!parts || parts.length < 3) throw new Error(`not a colour: ${rgb}`);
  const [r, g, b] = parts.slice(0, 3).map(Number).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio between two resolved colours, rounded the way a report should read. */
export function contrast(a, b) {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100;
}

/** Resolve a custom property to the rgb() the browser actually computed. */
export function token(name, el = document.documentElement) {
  const probe = document.createElement('span');
  probe.style.color = `var(${name})`;
  el.appendChild(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value;
}

/**
 * Run the whole suite under a theme, then put the theme back.
 *
 * The app stamps `data-theme` on `<html>` at boot, so a test that wants light values has to set it
 * and wait for a paint. Reading straight after the write is what produced a "light" sweep reporting
 * dark colours.
 */
export async function underTheme(name, fn) {
  const root = document.documentElement;
  const previous = root.getAttribute('data-theme');
  root.setAttribute('data-theme', name);
  await afterPaint();
  try {
    return await fn();
  } finally {
    if (previous === null) root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', previous);
    await afterPaint();
  }
}

/* --------------------------------------------------------------------- runner */

export async function run(root) {
  const results = [];

  /**
   * `?only=<substring>` runs just the tests whose name contains it.
   *
   * A filter, never a reordering: it changes which tests run and not the order of the ones that do,
   * so a pass is evidence about isolation rather than about sequence.
   */
  const only = new URLSearchParams(location.search).get('only');
  const selected = only
    ? tests.filter((t) => t.name.toLowerCase().includes(only.toLowerCase()))
    : tests;

  if (only && selected.length === 0) {
    // Louder than a green "0 of 0 failed", which is what a typo would otherwise produce. A suite
    // reporting success because it ran nothing is this project's signature failure.
    throw new Error(`?only=${only} matched no test out of ${tests.length}`);
  }

  const diaryBefore = snapshotDiary();

  for (const { name, fn } of selected) {
    try {
      await fn();
      results.push({ name, ok: true });
    } catch (error) {
      results.push({ name, ok: false, error: error?.message ?? String(error) });
    }
  }

  // Last, and unconditional. If anything here wrote to her diary, that matters more than every
  // other result on the page.
  const changed = diaryDifference(diaryBefore, snapshotDiary());
  results.push(changed.length === 0
    ? { name: 'this page did not touch her diary', ok: true }
    : { name: 'this page did not touch her diary', ok: false, error: `changed:\n    ${changed.join('\n    ')}` });

  const failed = results.filter((r) => !r.ok);

  /* `href` ties this result to the document that produced it. Anything driving this page should
     navigate with a fresh query string and confirm the href it gets back is the one it asked for —
     Pawfolio's harness once returned the previous page's results after a reload, which is the
     "check that agrees with itself" trap happening inside the tool built to catch it. */
  window.__daybookResults = {
    total: results.length,
    failed: failed.length,
    href: location.href,
    only: only ?? null,
    of: tests.length,
    diaryKeysSeen: Object.keys(diaryBefore).length,
    results,
  };

  const heading = document.createElement('h1');
  const scope = only ? ` (only "${only}" — ${selected.length} of ${tests.length})` : '';
  heading.textContent = (failed.length === 0
    ? `${results.length} passed`
    : `${failed.length} of ${results.length} failed`) + scope;
  heading.className = failed.length === 0 ? 'pass' : 'fail';
  root.append(heading);

  const list = document.createElement('ol');
  for (const result of results) {
    const item = document.createElement('li');
    item.className = result.ok ? 'pass' : 'fail';
    item.textContent = `${result.ok ? 'ok' : 'FAILED'}  ${result.name}`;
    if (!result.ok) {
      const detail = document.createElement('pre');
      detail.textContent = result.error;
      item.append(detail);
    }
    list.append(item);
  }
  root.append(list);
  return window.__daybookResults;
}
