/* ============================================================
   Demo data.

   A month in the life of a fictional 76-year-old woman in South
   Africa with type 2 diabetes, generated so every screen has
   something real to show: readings in and out of range, gaps,
   partly-filled days, meals with paired readings, and one genuine
   pattern for the engine to find.

   Deterministic. The same month every time, so what you see in a
   screenshot is what you get on the next device.

   Nothing in here is medical guidance. The ranges are illustrative
   (see RANGE below) and the numbers are invented.
   ============================================================ */

var Demo = (function () {
  'use strict';

  /* SEMDSA 2017 (Ch. 8) gives, for an HbA1c target of ≤7%, a
     fasting/pre-prandial SMBG target of 4.0–7.0 mmol/L and a
     post-prandial target of 5.0–10.0. For "the elderly, the frail,
     those with limited life expectancy" it accepts an HbA1c of
     7.1–8.5%, with SMBG targets individualised to match.

     So the demo raises the floor to 5.0 — hypo avoidance is the main
     reason targets are relaxed with age — and keeps the standard
     post-meal ceiling. Illustrative for a fictional person, not a
     recommendation for anyone. */
  var RANGE = { rangeLow: 5.0, rangeHigh: 8.0, postHigh: 10.0 };

  /* ---------------------------------------------------- prng */

  var seed;
  function rnd() {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  }
  function pick(a) { return a[Math.floor(rnd() * a.length)]; }
  function chance(p) { return rnd() < p; }
  function jitter(n) { return (rnd() * 2 - 1) * n; }
  function r1(v) { return Math.round(v * 10) / 10; }

  function hhmm(h, m) {
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }
  function around(h, m, spread) {
    var t = h * 60 + m + Math.round(jitter(spread));
    return hhmm(Math.floor(t / 60) % 24, ((t % 60) + 60) % 60);
  }

  /* ---------------------------------------------------- the month */

  var DAYS = 30;

  // The planted signal: she sleeps badly, her morning reading is up.
  // Tight within-group scatter so it clears the engine's t-gate (§8.2).
  var BY_SLEEP = { poor: 8.7, ok: 7.3, good: 6.4 };

  // Between them these cover every option in the picker, so the demo
  // shows the whole vocabulary rather than a convenient subset.
  var CALM_FEELINGS  = ['Calm', 'Energised'];
  var EDGY_FEELINGS  = ['Tense', 'Anxious', 'Shaky'];
  var OTHER_FEELINGS = ['Tired', 'Achy', 'Breathless', 'Dizzy'];

  var NOTES = [
    'Slept badly, up twice in the night.',
    'Grandchildren came round after church.',
    'Long queue at the clinic.',
    'Quiet day, feet up in the afternoon.',
    'Dancing at the hall, lovely evening.',
    'Hot day, did not drink enough.',
    'Knees sore on the stairs.',
    ''
  ];

  function build(today) {
    seed = 20260808;                    // fixed: same month every time
    var days = {};

    for (var i = DAYS - 1; i >= 0; i--) {
      var date = Dates.add(today, -i);
      var age  = i;                     // days ago
      var dow  = Dates.parse(date).getDay();

      // One day she never touched the app at all, and it must render
      // as a gap rather than a zero.
      if (age === 11) { continue; }

      var d = {
        date: date, morning: null, movement: [],
        food: null, stress: null, summary: null,
        updatedAt: new Date().toISOString()
      };

      var sleep = chance(0.3) ? 'poor' : chance(0.45) ? 'ok' : 'good';
      var base  = BY_SLEEP[sleep] + jitter(0.3);

      // Two mornings she forgot to test, but logged the rest.
      var tested = !(age === 4 || age === 19);

      // One low morning and one clearly high one, so both ends of the
      // colour scale appear somewhere in the month.
      if (age === 7)  { base = 4.6; sleep = 'ok'; }
      if (age === 22) { base = 11.4; sleep = 'poor'; }

      if (tested) {
        d.morning = {
          glucose: r1(base),
          time: around(6, 30, 25),
          sleep: sleep,
          pain: chance(0.25) ? pick(['mild', 'moderate']) : 'none'
        };
      }

      /* --- movement -------------------------------------------------
         She walks most days, dances on a Thursday, and there is enough
         variety that the activity list is exercised. */
      var moves = [];
      if (chance(0.8)) moves.push('Walking');
      if (dow === 4) moves.push('Dance');
      if (chance(0.4)) moves.push(pick(['Housework', 'Gardening', 'Shopping', 'Cooking',
                                        'Stairs', 'Exercise', 'Other']));

      moves.slice(0, 2).forEach(function (activity, k) {
        var edgy = chance(0.3);
        var feeling = edgy ? pick(EDGY_FEELINGS)
                    : chance(0.25) ? pick(OTHER_FEELINGS)
                    : pick(CALM_FEELINGS);
        var before = r1(base + 0.6 + rnd() * 0.9);
        // Second planted signal: on-edge activity goes up, calm goes down.
        var delta  = edgy ? 1.3 + rnd() * 0.6 : -(0.9 + rnd() * 0.6);
        var start  = k === 0 ? around(9, 45, 40) : around(16, 0, 50);
        var mins   = 25 + Math.floor(rnd() * 20);
        var sh = +start.slice(0, 2), sm = +start.slice(3);

        // Pin the two rarest options to fixed days so the demo always
        // shows the full picker, not whatever the seed happened to roll.
        if (age === 9  && k === 0) activity = 'Other';
        if (age === 13 && k === 0) feeling  = 'Dizzy';

        d.movement.push({
          id: 'dm' + i + k,
          activity: activity,
          startTime: start,
          before: before,
          after: r1(before + delta),
          afterTime: around(sh, sm + mins, 4),
          feeling: feeling
        });
      });
      d.movement.sort(function (a, b) { return a.startTime.localeCompare(b.startTime); });

      /* --- food ------------------------------------------------------ */
      if (chance(0.9)) {
        var meals = [];

        // Breakfast, usually with a paired reading either side.
        var bBefore = r1(base + jitter(0.3));
        if (age === 14) bBefore = 4.8;          // one low pre-meal reading
        var bRise = 2.1 + rnd() * 1.6;
        meals.push({
          id: 'db' + i, kind: 'Breakfast', time: around(7, 45, 20),
          note: pick(['Oats and tea', 'Toast and tea', 'Mieliepap', 'Eggs and toast', 'Yoghurt']),
          before: bBefore,
          after: r1(bBefore + bRise),
          afterTime: around(9, 45, 20)
        });

        if (chance(0.55)) {
          var lBefore = r1(base + 0.4 + jitter(0.5));
          meals.push({
            id: 'dl' + i, kind: 'Lunch', time: around(12, 45, 30),
            note: pick(['Soup and bread', 'Sandwich', 'Leftover stew', 'Salad and chicken']),
            before: lBefore,
            after: chance(0.7) ? r1(lBefore + 1.8 + rnd() * 1.9) : null,
            afterTime: chance(0.7) ? around(14, 45, 25) : null
          });
        }
        if (chance(0.4)) {
          meals.push({
            id: 'dd' + i, kind: 'Dinner', time: around(18, 30, 40),
            note: pick(['Stew and rice', 'Fish and veg', 'Pap and chicken', 'Pasta']),
            before: null, after: null, afterTime: null
          });
        }

        d.food = {
          meals: meals,
          hydration: chance(0.3) ? 'low' : chance(0.5) ? 'ok' : 'good',
          hungry: chance(0.3)
        };
      }

      /* --- stress and tiredness --------------------------------------- */
      if (chance(0.85)) {
        d.stress = {
          emotional: sleep === 'poor' && chance(0.5) ? 'high'
                   : chance(0.45) ? 'medium' : 'low',
          fatigue: sleep === 'poor' ? (chance(0.6) ? 'high' : 'medium')
                 : chance(0.4) ? 'medium' : 'low'
        };
      }

      /* --- end of day -------------------------------------------------- */
      if (chance(0.7)) {
        var triggers = [];
        if (sleep === 'poor') triggers.push('Poor sleep');
        if (d.stress && d.stress.emotional === 'high') triggers.push('Stress');
        if (d.food && d.food.hydration === 'low') triggers.push('Not enough water');
        if (chance(0.3)) triggers.push(pick(['Large meal', 'Something sweet', 'Bread, rice or pasta', 'Rushing about']));

        var helped = [];
        if (d.movement.length) helped.push('A walk');
        if (chance(0.4)) helped.push(pick(['Resting', 'Drinking water', 'Slow breathing', 'A quiet morning', 'Company']));

        d.summary = {
          notes: chance(0.35) ? pick(NOTES) : '',
          triggers: triggers,
          helped: helped
        };
      }

      // A couple of days deliberately left half-finished, because real
      // weeks look like that and History should show it plainly.
      if (age === 2 || age === 16) { d.food = null; d.summary = null; }

      days[date] = d;
    }

    return days;
  }

  return { build: build, RANGE: RANGE, DAYS: DAYS };
})();
