import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The chart's target band may only be drawn when she has a range.
 *
 * **Why this file exists.** `findings.md` F10 asked whether the band — a green zone across the long
 * chart — is a value or furniture, since state colour is for values only. The owner ruled it a
 * value, **on the condition that the range came from her doctor**. That condition is the entire
 * ruling: the band is not the app calling a zone good, it is her doctor's numbers drawn to scale.
 *
 * The condition therefore needs guarding, and the browser suite can no longer do it — the band is
 * now inside its "is a reading" pattern, so the colour sweep waves it through. Drawing the band
 * against a range the app invented would breach B8 and would look exactly like a reading.
 *
 * **This is a source-shape check, and that is a real limitation.** It proves the band elements are
 * created inside the `hasTarget` branch, not that the rendered chart behaves. Behaviour would need
 * the app booted with fabricated settings, which needs a storage seam in `Store` — an owner decision
 * about production code (see F6's resolution). Until then this catches the mistake that matters:
 * moving the band out from behind its guard.
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const app = readFileSync(ROOT + 'js/app.js', 'utf8');

/** The chart's range branch: from `var ranged = ...` to the `} else {` that handles no range. */
function rangedBranch() {
  const start = app.indexOf('var ranged = Units.hasTarget(');
  assert.notEqual(start, -1, 'the chart no longer decides on Units.hasTarget, so this guard is reading the wrong thing');
  const elseAt = app.indexOf('} else {', start);
  assert.notEqual(elseAt, -1, 'the range branch has no else, so there is no no-range path to fall back to');
  return { start, elseAt, inside: app.slice(start, elseAt), after: app.slice(elseAt) };
}

test('the band is drawn only when she has a range', () => {
  const { inside } = rangedBranch();
  for (const cls of ['ch-band', 'ch-bandline', 'ch-bandtick']) {
    assert.ok(inside.includes(cls), `${cls} is not inside the hasTarget branch`);
  }
});

test('no band element is created outside that branch', () => {
  const { start, elseAt } = rangedBranch();
  const outside = app.slice(0, start) + app.slice(elseAt);
  for (const cls of ['ch-band', 'ch-bandline', 'ch-bandtick']) {
    assert.doesNotMatch(outside, new RegExp(`class:\\s*'${cls}'`),
      `${cls} is created outside the range check, so it could be drawn against a range the app invented (B8)`);
  }
});

test('the no-range path draws neutral reference lines, not a target', () => {
  const { after } = rangedBranch();
  // Everything from the else to the end of the branch. `ch-grid` and `ch-tick` are --ink-3 chrome.
  const noRange = after.slice(0, after.indexOf('\n      }'));
  assert.match(noRange, /ch-grid/, 'the no-range path should still give the scale meaning');
  assert.doesNotMatch(noRange, /ch-band/, 'a band without a range would be a target the app chose');
});

test('the band uses her stored bounds and never a constant', () => {
  const { inside } = rangedBranch();
  assert.match(inside, /s\.rangeHigh/, 'the band should be drawn from her settings');
  assert.match(inside, /s\.rangeLow/, 'the band should be drawn from her settings');
  // A bare mmol/L literal here would be a shipped default range, which B8 forbids outright.
  const literals = inside.match(/\b(?:[3-9]|1[0-9])\.\d\b/g) || [];
  assert.deepEqual(literals, [], `a numeric target in the chart would be a range the app chose: ${literals.join(', ')}`);
});
