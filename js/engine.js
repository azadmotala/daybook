/* ============================================================
   Observations engine.

   This deliberately does NOT classify days as adrenaline /
   cortisol / insulin driven. Finger-prick readings a few times
   a day cannot separate those hormones, and a confident wrong
   label is worse than no label. Instead it reports what was
   logged, side by side, in plain language — and refuses to
   report anything until there is enough data to be worth
   looking at.

   Rules:
     - never asserts cause
     - never reports a comparison with fewer than MIN_BUCKET
       days on each side
     - never reports a difference smaller than MIN_DIFF
     - always states how many days it is based on
   ============================================================ */

var Engine = (function () {
  'use strict';

  var MIN_DAYS   = 5;    // days with a morning reading before we compare anything
  var MIN_BUCKET = 3;    // days needed on each side of a comparison
  var MIN_DIFF   = 0.8;  // mmol/L — below this it's noise
  var MIN_MOVE   = 0.6;  // mmol/L — meaningful change around an activity
  var MIN_T      = 2.5;  // separation required before we'll show anything

  /* Why MIN_T exists: with a dozen days and half a dozen things to
     compare, something will always look different by chance. So the gap
     between two groups must be large relative to both the day-to-day
     scatter AND how few days are in each group:

         t = gap / (pooled SD * sqrt(1/n1 + 1/n2))

     2.5 is deliberately stricter than the usual 2.0, because several
     comparisons run at once and the cost of pointing at noise here is
     someone changing their life around a coincidence. No p-value is
     shown or implied — this is only a brake on what gets displayed. */

  function mean(xs) {
    var t = 0;
    for (var i = 0; i < xs.length; i++) t += xs[i];
    return t / xs.length;
  }

  function sd(xs) {
    if (xs.length < 2) return 0;
    var m = mean(xs), v = 0;
    for (var i = 0; i < xs.length; i++) v += (xs[i] - m) * (xs[i] - m);
    return Math.sqrt(v / (xs.length - 1));
  }

  /** Pooled standard deviation of two groups. */
  function pooledSD(a, b) {
    var na = a.length, nb = b.length;
    if (na + nb - 2 <= 0) return 0;
    var sa = sd(a), sb = sd(b);
    return Math.sqrt(((na - 1) * sa * sa + (nb - 1) * sb * sb) / (na + nb - 2));
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function n(v) { return '<em>' + esc(Units.out(v)) + ' ' + esc(Units.label()) + '</em>'; }

  /* ------------------------------------------------------------------
     Within a single day — direct arithmetic on paired readings.
     These are facts, not inferences, so they need no gating.
     ------------------------------------------------------------------ */

  function dayFacts(day) {
    var out = [];

    (day.movement || []).forEach(function (m) {
      if (m.before == null || m.after == null) return;
      var change = m.after - m.before;
      if (Math.abs(change) < MIN_MOVE) return;
      var mins = Dates.minutesBetween(m.startTime, m.afterTime);
      var dir = change > 0 ? 'rose' : 'dropped';
      var over = mins != null ? ' over ' + esc(Dates.humanMinutes(mins)) : '';
      out.push({
        kind: (m.activity || 'Activity'),
        text: 'Your reading ' + dir + ' ' + n(Math.abs(change)) + over +
              ' around ' + esc((m.activity || 'this').toLowerCase()) +
              (m.feeling ? ', when you felt <em>' + esc(m.feeling.toLowerCase()) + '</em>' : '') + '.',
        strength: Math.abs(change)
      });
    });

    if (day.food && day.food.meals) {
      day.food.meals.forEach(function (m) {
        if (m.before == null || m.after == null) return;
        var change = m.after - m.before;
        if (Math.abs(change) < MIN_MOVE) return;
        var mins = Dates.minutesBetween(m.time, m.afterTime);
        var dir = change > 0 ? 'rose' : 'dropped';
        out.push({
          kind: m.kind || 'Meal',
          text: 'Your reading ' + dir + ' ' + n(Math.abs(change)) +
                (mins != null ? ' in the ' + esc(Dates.humanMinutes(mins)) + ' after ' : ' after ') +
                esc((m.note || m.kind || 'this meal').toLowerCase()) + '.',
          strength: Math.abs(change)
        });
      });
    }

    out.sort(function (a, b) { return b.strength - a.strength; });
    return out;
  }

  /* ------------------------------------------------------------------
     Across days — grouped comparisons, heavily gated.
     ------------------------------------------------------------------ */

  /**
   * Compare two groups that were decided in advance.
   *
   * opts.a / opts.b each name the values that fall in that group, plus
   * the phrase used to describe it. Anything in neither group is left
   * out. Which group turns out higher is not known until the averages
   * are in, and the wording works either way round.
   *
   * This deliberately does NOT sort three groups and report the widest
   * pair. Choosing the pair after seeing the data, then testing it as
   * though it had been chosen up front, roughly doubles the rate at
   * which coincidences get through — and with several comparisons
   * running at once that is the difference between "occasionally" and
   * "about a third of the time".
   */
  function compare(rows, opts) {
    var a = [], b = [];
    rows.forEach(function (r) {
      if (r.key == null || r.value == null) return;
      if (opts.a.values.indexOf(r.key) > -1) a.push(r.value);
      else if (opts.b.values.indexOf(r.key) > -1) b.push(r.value);
    });

    if (a.length < MIN_BUCKET || b.length < MIN_BUCKET) return null;

    var avgA = mean(a), avgB = mean(b);
    var gap = Math.abs(avgA - avgB);
    if (gap < (opts.minDiff || MIN_DIFF)) return null;

    // Is the gap bigger than the ordinary scatter, or is it just scatter?
    var spread = pooledSD(a, b);
    if (spread > 0) {
      var t = gap / (spread * Math.sqrt(1 / a.length + 1 / b.length));
      if (t < MIN_T) return null;
    }

    var noun = opts.noun || 'days';
    return {
      kind: opts.kind,
      text: opts.text({ n: a.length, avg: avgA, phrase: opts.a.phrase },
                      { n: b.length, avg: avgB, phrase: opts.b.phrase }),
      note: 'Based on ' + (a.length + b.length) + ' ' + noun +
            '. These things happened together. That doesn’t mean one caused the other.',
      strength: gap
    };
  }

  /**
   * @param days  oldest-first array of day records
   */
  function patterns(days) {
    var withMorning = days.filter(function (d) { return d.morning && d.morning.glucose != null; });

    if (withMorning.length < MIN_DAYS) {
      return {
        ready: false,
        have: withMorning.length,
        need: MIN_DAYS,
        items: []
      };
    }

    var byDate = {};
    days.forEach(function (d) { byDate[d.date] = d; });

    var items = [];

    // --- morning reading against how she slept -----------------------
    items.push(compare(
      withMorning.map(function (d) {
        return { key: d.morning.sleep, value: d.morning.glucose };
      }),
      {
        kind: 'Sleep',
        a: { values: ['poor'], phrase: 'slept badly' },
        b: { values: ['good'], phrase: 'slept well' },
        text: function (A, B) {
          return 'On the ' + A.n + ' days after you ' + A.phrase +
                 ', your morning reading averaged ' + n(A.avg) +
                 '. On the ' + B.n + ' days after you ' + B.phrase +
                 ', it averaged ' + n(B.avg) + '.';
        }
      }
    ));

    // --- morning reading against yesterday's stress / fatigue ---------
    var STRESS = {
      emotional: {
        kind: 'Stress the day before',
        a: { values: ['high'], phrase: 'felt very stressed' },
        b: { values: ['low'],  phrase: 'felt calm' }
      },
      fatigue: {
        kind: 'Tiredness the day before',
        a: { values: ['high'], phrase: 'felt very tired' },
        b: { values: ['low'],  phrase: 'had good energy' }
      }
    };

    ['emotional', 'fatigue'].forEach(function (field) {
      var spec = STRESS[field];
      items.push(compare(
        withMorning.map(function (d) {
          var prev = byDate[Dates.add(d.date, -1)];
          var key = prev && prev.stress ? prev.stress[field] : null;
          return { key: key, value: d.morning.glucose };
        }),
        {
          kind: spec.kind,
          a: spec.a,
          b: spec.b,
          text: function (A, B) {
            return 'After days when you ' + A.phrase +
                   ', your next morning reading averaged ' + n(A.avg) +
                   ' (' + A.n + ' days). After days when you ' + B.phrase +
                   ', it averaged ' + n(B.avg) + ' (' + B.n + ' days).';
          }
        }
      ));
    });

    // --- morning reading against yesterday's hydration ---------------
    items.push(compare(
      withMorning.map(function (d) {
        var prev = byDate[Dates.add(d.date, -1)];
        var key = prev && prev.food ? prev.food.hydration : null;
        return { key: key, value: d.morning.glucose };
      }),
      {
        kind: 'Drinking',
        a: { values: ['low'],  phrase: 'drank little' },
        b: { values: ['good'], phrase: 'drank plenty' },
        text: function (A, B) {
          return 'After days when you ' + A.phrase +
                 ', your morning reading averaged ' + n(A.avg) +
                 '. After days when you ' + B.phrase +
                 ', it averaged ' + n(B.avg) + '.';
        }
      }
    ));

    // --- morning reading against pain ---------------------------------
    // "any pain" vs "none", because severe days are too rare on their
    // own to clear MIN_BUCKET, and leaving them out would waste them.
    items.push(compare(
      withMorning.map(function (d) {
        return { key: d.morning.pain, value: d.morning.glucose };
      }),
      {
        kind: 'Pain',
        a: { values: ['mild', 'moderate', 'severe'], phrase: 'had some pain' },
        b: { values: ['none'], phrase: 'had no pain' },
        text: function (A, B) {
          return 'On the ' + A.n + ' mornings when you ' + A.phrase +
                 ', your reading averaged ' + n(A.avg) +
                 '. On the ' + B.n + ' mornings when you ' + B.phrase +
                 ', it averaged ' + n(B.avg) + '.';
        }
      }
    ));

    // --- change around activity, against how it felt -----------------
    // Feelings are not ordered, so the two sides are grouped by meaning
    // rather than by which happens to come out higher. "Tired" sits in
    // neither group on purpose.
    var moves = [];
    days.forEach(function (d) {
      (d.movement || []).forEach(function (m) {
        if (m.before != null && m.after != null && m.feeling) {
          moves.push({ key: m.feeling, value: m.after - m.before });
        }
      });
    });
    items.push(compare(moves, {
      minDiff: MIN_MOVE,
      noun: 'times',
      kind: 'How activity felt',
      a: { values: ['Tense', 'Anxious', 'Shaky'], phrase: 'tense, anxious or shaky' },
      b: { values: ['Calm', 'Energised'],         phrase: 'calm or energised' },
      text: function (A, B) {
        function describe(g) {
          return (g.avg >= 0 ? 'rose by ' : 'dropped by ') + n(Math.abs(g.avg));
        }
        return 'When you felt <em>' + A.phrase + '</em> during activity, your reading ' +
               describe(A) + ' on average (' + A.n + ' times). When you felt <em>' +
               B.phrase + '</em>, it ' + describe(B) + ' (' + B.n + ' times).';
      }
    }));

    // --- this week against last week ---------------------------------
    if (days.length >= 14) {
      var recent = withMorning.filter(function (d) { return Dates.diff(days[days.length - 1].date, d.date) < 7; });
      var older  = withMorning.filter(function (d) {
        var g = Dates.diff(days[days.length - 1].date, d.date);
        return g >= 7 && g < 14;
      });
      if (recent.length >= 4 && older.length >= 4) {
        var rAvg = mean(recent.map(function (d) { return d.morning.glucose; }));
        var oAvg = mean(older.map(function (d) { return d.morning.glucose; }));
        var gap = rAvg - oAvg;
        if (Math.abs(gap) >= MIN_DIFF) {
          items.push({
            kind: 'Week on week',
            // Deliberately no third number for the difference. rAvg and oAvg are
            // each rounded for display, so a separately-rounded gap can disagree
            // with the two figures sitting right beside it. The direction is
            // visible from the numbers themselves.
            text: 'Your morning readings averaged ' + n(rAvg) + ' over the last 7 days. ' +
                  'The week before it was ' + n(oAvg) + '.',
            note: 'Based on ' + (recent.length + older.length) + ' mornings.',
            strength: Math.abs(gap)
          });
        }
      }
    }

    items = items.filter(Boolean).sort(function (a, b) { return b.strength - a.strength; });

    return { ready: true, have: withMorning.length, need: MIN_DAYS, items: items };
  }

  /* ------------------------------------------------------------------
     Her own tags, counted. Not inference — just her notes added up.
     ------------------------------------------------------------------ */

  function tally(days, field) {
    var counts = {};
    days.forEach(function (d) {
      if (!d.summary || !d.summary[field]) return;
      d.summary[field].forEach(function (t) {
        counts[t] = (counts[t] || 0) + 1;
      });
    });
    return Object.keys(counts)
      .map(function (k) { return { name: k, n: counts[k] }; })
      .sort(function (a, b) { return b.n - a.n || a.name.localeCompare(b.name); });
  }

  /* ------------------------------------------------------------------
     Summary numbers for a stretch of days.
     ------------------------------------------------------------------ */

  function summary(days) {
    var vals = days.filter(function (d) { return d.morning && d.morning.glucose != null; })
                   .map(function (d) { return d.morning.glucose; });
    var logged = days.filter(function (d) { return !Store.isEmpty(d); }).length;
    if (!vals.length) return { logged: logged, count: 0 };
    return {
      logged: logged,
      count: vals.length,
      avg: mean(vals),
      min: Math.min.apply(null, vals),
      max: Math.max.apply(null, vals)
    };
  }

  return {
    dayFacts: dayFacts,
    patterns: patterns,
    tally: tally,
    summary: summary,
    MIN_DAYS: MIN_DAYS
  };
})();
