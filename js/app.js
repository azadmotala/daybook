/* ============================================================
   Daybook — screens and wiring.

   Everything auto-saves the moment it's tapped. There is no
   "did I remember to press save?" in this app.
   ============================================================ */

(function () {
  'use strict';

  var h = UI.h;
  var SVG = 'http://www.w3.org/2000/svg';

  /** Months that have something in them, newest first. */
  function monthsWithData() {
    var seen = {};
    Store.dates().forEach(function (date) {
      if (!Store.isEmpty(Store.get(date))) seen[date.slice(0, 7)] = true;
    });
    return Object.keys(seen).sort().reverse();
  }

  function monthLabel(ym) {
    var parts = ym.split('-');
    return MONTHS_LONG[+parts[1] - 1] + ' ' + parts[0];
  }

  var state = {
    tab: 'today',
    date: Dates.today(),
    /* Which month the History list is showing, 'YYYY-MM'. The list is the only
       thing in the app that would otherwise grow without bound. One month at a
       time keeps it to at most 31 rows however many years she has. */
    historyMonth: null,
    /* A newer version is installed and waiting for her to say yes. Set only
       for one that arrives during this session; one already waiting at boot
       is taken silently, because at boot there is nothing of hers on screen. */
    updateReady: false
  };

  /** Set once the worker is registered; null in any browser without one. */
  var updater = null;

  /* ---------------------------------------------------- vocab */

  var V = {
    sleep:     [{ value: 'poor', label: 'Badly' }, { value: 'ok', label: 'Alright' }, { value: 'good', label: 'Well' }],
    pain:      [{ value: 'none', label: 'None' }, { value: 'mild', label: 'Mild' }, { value: 'moderate', label: 'Moderate' }, { value: 'severe', label: 'Bad' }],
    emotional: [{ value: 'low', label: 'Calm' }, { value: 'medium', label: 'Some stress' }, { value: 'high', label: 'Very stressed' }],
    fatigue:   [{ value: 'low', label: 'Good energy' }, { value: 'medium', label: 'A bit tired' }, { value: 'high', label: 'Very tired' }],
    hydration: [{ value: 'low', label: 'Not much' }, { value: 'ok', label: 'Normal' }, { value: 'good', label: 'Plenty' }],
    /* Things she actually does, named the way she'd say them. "Exercise"
       stays as the catch-all for anything deliberate. */
    activity:  ['Walking', 'Dance', 'Housework', 'Cooking', 'Gardening',
                'Shopping', 'Stairs', 'Exercise', 'Other'],

    /* How it felt, physical and emotional together. Dizzy, Shaky and
       Breathless earn their place because they are the ones worth
       having written down when she next sees her doctor.
       Engine grouping (§8.3) uses Tense/Anxious/Shaky vs Calm/Energised;
       the rest sit in neither bucket on purpose. */
    feeling:   ['Calm', 'Energised', 'Tired', 'Achy',
                'Tense', 'Anxious', 'Shaky', 'Dizzy', 'Breathless'],
    meal:      ['Breakfast', 'Lunch', 'Dinner', 'Snack'],
    triggers:  ['Poor sleep', 'Stress', 'Missed a meal', 'Large meal', 'Something sweet',
                'Bread, rice or pasta', 'Pain', 'Feeling unwell', 'Rushing about',
                'Upset or argument', 'Not enough water', 'Sat down all day'],
    helped:    ['A walk', 'Resting', 'Drinking water', 'Smaller portion', 'Eating earlier',
                'Slow breathing', 'A good night’s sleep', 'Company', 'A quiet morning']
  };

  function labelFor(list, value) {
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      if (typeof o === 'string') { if (o === value) return o; }
      else if (o.value === value) return o.label;
    }
    return value || '';
  }

  /* ---------------------------------------------------- day access */

  function day() { return Store.get(state.date); }

  function commit(d) {
    var saved = Store.save(d);
    UI.refresh();
    render();   // the progress meter lives in the topbar, so redraw that too
    // The banner sits behind an open sheet, so say it here too.
    if (!saved) UI.toast('Not saved. See the message at the top.');
    return saved;
  }

  function uid() {
    return 'e' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  }

  /**
   * A reading with its state colour, measured against the range for its
   * own timing. `when` is 'pre' or 'post' and must reflect where the
   * reading actually sits relative to food.
   */
  function reading(v, when) {
    var st = Units.state(v, when);
    return h('span', { class: 'val' + (st ? ' s-' + st : ''), text: Units.out(v) });
  }

  /**
   * One row in the movement or meals list, and the whole row opens it for editing.
   *
   * **The row is the tap target and there is no delete button in it.** Removing an entry lives
   * inside the sheet this opens, behind a confirm. An entry can hold two readings and two times,
   * there is no undo and no server copy, so a one-tap delete sitting inside a row she taps to
   * correct a typo is the wrong shape. One target per row also suits reduced dexterity better than
   * two small adjacent ones.
   */
  function entryRow(opts) {
    return h('button', {
      type: 'button', class: 'entry entry-open', 'aria-label': opts.label,
      onclick: opts.onOpen
    }, [
      h('span', { class: 'entry-time', text: opts.time || '—' }),
      h('span', { class: 'entry-main' }, [
        h('span', { class: 'entry-title' }, opts.title),
        h('span', { class: 'entry-sub' }, opts.sub)
      ]),
      h('span', { class: 'go' }, UI.icon('chev'))
    ]);
  }

  /**
   * The delete action inside an entry sheet. Confirmed, because `UI.confirm` already guards
   * "Delete everything" and a single activity carrying two readings deserves the same question.
   */
  function removeEntryAction(opts) {
    return h('button', {
      type: 'button', class: 'btn btn-quiet btn-remove', text: opts.label,
      onclick: function () {
        UI.confirm({
          title: opts.confirmTitle,
          message: opts.confirmMessage,
          confirmLabel: opts.confirmLabel,
          danger: true,
          onConfirm: opts.onRemove
        });
      }
    });
  }

  /** Join parts with a middot, keeping element children intact. */
  function subLine(parts) {
    var out = [];
    parts.filter(Boolean).forEach(function (p, i) {
      if (i) out.push(document.createTextNode(' · '));
      out.push(typeof p === 'string' ? document.createTextNode(p) : p);
    });
    return out;
  }

  /* ============================================================
     TODAY
     ============================================================ */

  function topbarToday() {
    var d = day();
    var count = Store.completeCount(d);
    var isToday = state.date === Dates.today();

    return [
      h('div', { class: 'daynav' }, [
        h('button', {
          type: 'button', 'aria-label': 'Previous day',
          onclick: function () { state.date = Dates.add(state.date, -1); render(); }
        }, UI.icon('left')),
        h('div', { style: 'flex:1;text-align:center' }, [
          h('p', { class: 'eyebrow', text: isToday ? Dates.dayName(state.date) : 'Looking back' }),
          h('h1', { class: 'page-title', text: Dates.friendly(state.date) })
        ]),
        h('button', {
          type: 'button', 'aria-label': 'Next day',
          disabled: isToday,
          onclick: function () {
            if (state.date === Dates.today()) return;
            state.date = Dates.add(state.date, 1);
            render();
          }
        }, UI.icon('right'))
      ]),
      h('p', {
        class: 'meter-label',
        text: count === 5 ? 'All five noted. Nothing else needed today.'
            : count === 0 ? 'Nothing noted yet. Start anywhere you like.'
            : ''
      })
    ];
  }

  /** Circular progress. Purely a count of sections filled in. */
  function ring(done, total) {
    var C = 2 * Math.PI * 15;
    var svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 'ring');
    svg.setAttribute('width', '34');
    svg.setAttribute('height', '34');
    svg.setAttribute('viewBox', '0 0 36 36');
    svg.setAttribute('aria-hidden', 'true');
    function c(cls, dash) {
      var n = document.createElementNS(SVG, 'circle');
      n.setAttribute('class', cls);
      n.setAttribute('cx', 18); n.setAttribute('cy', 18); n.setAttribute('r', 15);
      n.setAttribute('fill', 'none');
      n.setAttribute('stroke-width', 5);
      n.setAttribute('stroke-linecap', 'round');
      if (dash != null) {
        n.setAttribute('stroke-dasharray', dash + ' ' + C);
        n.setAttribute('transform', 'rotate(-90 18 18)');
      }
      return n;
    }
    svg.appendChild(c('ring-track'));
    if (done > 0) svg.appendChild(c('ring-fill', (C * done / total).toFixed(2)));
    return svg;
  }

  var MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June',
                     'July', 'August', 'September', 'October', 'November', 'December'];

  /** How many days this calendar month have anything in them. */
  function daysLoggedThisMonth() {
    var prefix = state.date.slice(0, 7);
    return Store.dates().filter(function (dt) {
      return dt.indexOf(prefix) === 0 && !Store.isEmpty(Store.get(dt));
    }).length;
  }

  /**
   * Add to Home Screen, and backing up.
   *
   * These are not housekeeping. A browser tab's storage is cleared by mobile
   * Safari after about a week unopened, and everything she has written lives
   * there. At most one of the two shows at a time, and the install one wins:
   * it is what stops the clearing happening at all.
   */
  function survivalCard() {
    if (Store.isDemo()) return null;                 // not while she is looking at someone else's month

    if (!Store.isInstalled()) {
      return h('button', {
        type: 'button', class: 'range-cta survival', onclick: sheetInstall
      }, [
        h('span', {}, [
          h('b', { text: 'Keep Daybook on your home screen' }),
          h('span', { text: 'It keeps your notes safe, and opens like an app.' })
        ]),
        h('span', { class: 'go' }, UI.icon('chev'))
      ]);
    }

    var b = Store.backupStatus();
    if (!b.needsBackup) return null;
    return h('button', {
      type: 'button', class: 'range-cta survival', onclick: backupNow
    }, [
      h('span', {}, [
        h('b', { text: b.neverBackedUp ? 'Save a copy of your notes' : 'Time to save a copy' }),
        h('span', { text: b.neverBackedUp
          ? 'One file, kept wherever you like. Nothing is sent anywhere.'
          : 'The last one was ' + b.daysSince + ' days ago.' })
      ]),
      h('span', { class: 'go' }, UI.icon('download'))
    ]);
  }

  function sheetInstall() {
    UI.push(function () {
      var iOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
      return {
        title: 'Put it on your home screen',
        body: [
          h('div', { class: 'panel', style: 'margin-bottom:1.4rem' }, [
            h('p', { text:
              'A web page loses what it has saved if you go a week or so without opening it, ' +
              'and that would take your notes with it. Keeping Daybook on your home screen ' +
              'stops that happening.' }),
            h('p', { text: 'It also opens straight up, without the browser round it.' })
          ]),
          h('p', { class: 'section-head', text: 'How' }),
          h('div', { class: 'prose' }, iOS
            ? [
                h('p', { text: '1. Tap the Share button at the bottom of the screen.' }),
                h('p', { text: '2. Scroll down and tap “Add to Home Screen”.' }),
                h('p', { text: '3. Tap “Add”.' })
              ]
            : [
                h('p', { text: '1. Tap the three dots at the top right.' }),
                h('p', { text: '2. Tap “Add to Home screen”, or “Install app”.' }),
                h('p', { text: '3. Tap “Install”.' })
              ]),
          h('p', { class: 'obs-note', style: 'margin-top:1.2rem', text:
            'This message goes away by itself once it is done.' })
        ],
        actions: [doneAction()]
      };
    });
  }

  function card(opts) {
    return h('button', {
      type: 'button',
      class: 'card' + (opts.done ? ' done' : ''),
      style: 'animation-delay:' + (opts.index * 45) + 'ms',
      onclick: opts.onclick
    }, [
      h('span', { class: 'card-body' }, [
        h('span', { class: 'card-title', text: opts.title }),
        h('span', { class: 'card-sub' + (opts.done ? '' : ' muted'), text: opts.sub })
      ]),
      h('span', { class: 'card-mark' }, UI.icon(opts.done ? 'check' : 'plus'))
    ]);
  }

  function screenToday() {
    var d = day();
    var s = Store.sections(d);
    var out = [];

    // --- headline reading -------------------------------------------
    if (d.morning && d.morning.glucose != null) {
      var g = d.morning.glucose;
      var st = Units.state(g, 'pre');            // waking reading

      // "0.4 lower than yesterday" — arithmetic on two numbers she can
      // already see, not a claim about what it means.
      var prev = Store.get(Dates.add(state.date, -1));
      var trend = '';
      if (prev.morning && prev.morning.glucose != null) {
        var delta = g - prev.morning.glucose;
        if (Math.abs(delta) >= 0.1) {
          trend = ' · ' + Units.out(Math.abs(delta)) + ' ' +
                  (delta > 0 ? 'higher' : 'lower') + ' than yesterday';
        } else {
          trend = ' · same as yesterday';
        }
      }

      out.push(h('div', { class: 'hero' + (st ? ' state-' + st : '') }, [
        h('div', { class: 'hero-line' }, [
          h('span', { class: 'hero-value', text: Units.out(g) }),
          h('span', { class: 'hero-unit', text: Units.label() }),
          st ? h('span', { class: 'hero-chip', text: Units.stateWord(st) }) : null
        ]),
        h('span', {
          class: 'hero-meta',
          text: 'morning reading' + (d.morning.time ? ', ' + d.morning.time : '') + trend
        })
      ]));
    } else {
      out.push(h('div', { class: 'hero empty' }, [
        h('p', { text: 'No morning reading for this day.' })
      ]));
    }

    // --- two tiles: neither says anything clinical -------------------
    var count = Store.completeCount(d);
    var monthName = MONTHS_LONG[Dates.parse(state.date).getMonth()];
    var logged = daysLoggedThisMonth();
    out.push(h('div', { class: 'bento' }, [
      h('div', { class: 'tile' }, [
        ring(count, 5),
        h('div', {}, [
          h('div', { class: 'tile-v', text: count + ' of 5' }),
          h('div', { class: 'tile-l', text: 'noted today' })
        ])
      ]),
      h('div', { class: 'tile' }, [
        h('div', {}, [
          h('div', { class: 'tile-v', text: logged + (logged === 1 ? ' day' : ' days') }),
          h('div', { class: 'tile-l', text: 'logged in ' + monthName })
        ])
      ])
    ]));

    // --- the week at a glance ----------------------------------------
    if (Store.dates().length > 1) out.push(weekChart(state.date));

    // --- the two things her notes' survival depends on ---------------
    out.push(survivalCard());

    // --- offer the range once, and only while it is missing ----------
    if (!Units.hasTarget('pre')) {
      out.push(h('button', {
        type: 'button', class: 'range-cta', onclick: sheetRange
      }, [
        h('span', {}, [
          h('b', { text: 'What did your doctor say to aim for?' }),
          h('span', { text: 'Add it once and your readings get a colour.' })
        ]),
        h('span', { class: 'go' }, UI.icon('chev'))
      ]));
    }

    out.push(h('p', { class: 'section-head', text: 'The day' }));

    var cards = [
      {
        title: 'Morning baseline',
        done: s.morning,
        sub: s.morning
          ? [d.morning.glucose != null ? Units.full(d.morning.glucose) : null,
             d.morning.sleep ? 'slept ' + labelFor(V.sleep, d.morning.sleep).toLowerCase() : null,
             d.morning.pain === 'none' ? 'no pain'
               : d.morning.pain ? labelFor(V.pain, d.morning.pain).toLowerCase() + ' pain' : null]
              .filter(Boolean).join(' · ')
          : 'Reading, sleep and pain when you wake',
        onclick: sheetMorning
      },
      {
        title: 'Movement',
        done: s.movement,
        sub: s.movement
          ? d.movement.length + (d.movement.length === 1 ? ' activity noted' : ' activities noted')
          : 'A walk, the stairs, housework',
        onclick: sheetMovement
      },
      {
        title: 'Food and drink',
        done: s.food,
        sub: s.food
          ? [(d.food.meals && d.food.meals.length) ? d.food.meals.length + ' noted' : null,
             d.food.hydration ? 'drank ' + labelFor(V.hydration, d.food.hydration).toLowerCase() : null]
              .filter(Boolean).join(' · ') || 'Noted'
          : 'Meals, snacks and how much you drank',
        onclick: sheetFood
      },
      {
        title: 'Stress and tiredness',
        done: s.stress,
        sub: s.stress
          ? [labelFor(V.emotional, d.stress.emotional), labelFor(V.fatigue, d.stress.fatigue)]
              .filter(Boolean).join(' · ')
          : 'How you felt in yourself',
        onclick: sheetStress
      },
      {
        title: 'End of day',
        done: s.summary,
        sub: s.summary
          ? (d.summary.notes ? d.summary.notes : (d.summary.triggers || []).concat(d.summary.helped || []).join(' · '))
          : 'Anything that set it off, anything that helped',
        onclick: sheetSummary
      }
    ];

    cards.forEach(function (c, i) { c.index = i; out.push(card(c)); });

    // --- plain arithmetic on today's own readings ---------------------
    var facts = Engine.dayFacts(d);
    if (facts.length) {
      out.push(h('p', { class: 'section-head', text: 'What today’s readings show' }));
      facts.slice(0, 4).forEach(function (f) {
        out.push(h('div', { class: 'obs' }, [
          h('div', { class: 'obs-kind', text: f.kind }),
          h('div', { class: 'obs-text', html: f.text })
        ]));
      });
    }

    return out;
  }

  /* ============================================================
     SHEETS
     ============================================================ */

  function doneAction() {
    return h('button', { type: 'button', class: 'btn btn-primary', text: 'Done', onclick: UI.close });
  }

  function sheetMorning() {
    UI.push(function () {
      var d = day();
      var m = d.morning || {};

      function set(key, value) {
        var dd = day();
        dd.morning = dd.morning || { time: Dates.nowTime() };
        dd.morning[key] = value;
        if (dd.morning.glucose == null && !dd.morning.sleep && !dd.morning.pain) dd.morning = null;
        commit(dd);
      }

      return {
        title: 'Morning baseline',
        body: [
          UI.field('Blood sugar reading',
            UI.readingButton({
              value: m.glucose,
              onclick: function () {
                UI.pad({
                  title: 'Morning reading',
                  value: m.glucose,
                  onDone: function (v) { set('glucose', v); }
                });
              }
            }),
            'Leave it out if you didn’t test.'),

          UI.field('What time?',
            UI.timeInput(m.time || Dates.nowTime(), function (v) { set('time', v); })),

          UI.field('How did you sleep?',
            UI.chips(V.sleep, m.sleep, function (v) { set('sleep', m.sleep === v ? null : v); })),

          UI.field('Any pain this morning?',
            UI.chips(V.pain, m.pain, function (v) { set('pain', m.pain === v ? null : v); }))
        ],
        actions: [doneAction()]
      };
    });
  }

  /* ---------------------------------------------------- movement */

  function sheetMovement() {
    UI.push(function () {
      var d = day();
      var list = d.movement || [];

      var items = list.map(function (m) {
        var change = (m.before != null && m.after != null) ? m.after - m.before : null;
        var mins = Dates.minutesBetween(m.startTime, m.afterTime);
        var sub = [];
        if (m.feeling) sub.push('felt ' + m.feeling.toLowerCase());
        if (m.before != null) sub.push('before ' + Units.out(m.before));
        if (m.after != null) sub.push('after ' + Units.out(m.after));
        if (mins != null) sub.push(Dates.humanMinutes(mins) + ' apart');

        return entryRow({
          time: m.startTime,
          label: 'Edit ' + (m.activity || 'this activity').toLowerCase(),
          title: [
            m.activity || 'Activity',
            change != null ? h('span', {
              class: 'delta ' + (change > 0.1 ? 'up' : change < -0.1 ? 'down' : 'flat'),
              text: '  ' + (change > 0 ? '+' : '') + Units.out(change)
            }) : null
          ],
          sub: sub.join(' · '),
          onOpen: function () { sheetMovementEntry(m); }
        });
      });

      return {
        title: 'Movement',
        body: [
          list.length ? h('div', {}, items)
                      : h('p', { class: 'hint', text: 'Nothing noted yet. A walk, the stairs, housework, anything that got you moving.' }),
          h('button', {
            type: 'button', class: 'btn btn-quiet', style: 'margin-top:.5rem',
            onclick: function () { sheetMovementEntry(null); }
          }, [UI.icon('plus'), 'Add an activity'])
        ],
        actions: [doneAction()]
      };
    });
  }

  function sheetMovementEntry(existing) {
    var draft = existing ? JSON.parse(JSON.stringify(existing)) : {
      id: uid(), activity: null, startTime: Dates.nowTime(),
      before: null, after: null, afterTime: null, feeling: null
    };

    UI.push(function () {
      return {
        title: existing ? 'Edit activity' : 'Add an activity',
        body: [
          UI.field('What were you doing?',
            UI.chips(V.activity, draft.activity, function (v) { draft.activity = v; UI.refresh(); })),

          UI.field('Started at',
            UI.timeInput(draft.startTime, function (v) { draft.startTime = v; })),

          UI.field('Reading before',
            UI.readingButton({
              value: draft.before,
              placeholder: 'Tap if you tested first',
              onclick: function () {
                UI.pad({ title: 'Reading before', value: draft.before,
                  onDone: function (v) { draft.before = v; UI.refresh(); } });
              }
            })),

          UI.field('Reading after',
            UI.readingButton({
              value: draft.after,
              placeholder: 'Tap if you tested after',
              onclick: function () {
                UI.pad({ title: 'Reading after', value: draft.after,
                  onDone: function (v) {
                    draft.after = v;
                    if (v != null && !draft.afterTime) draft.afterTime = Dates.nowTime();
                    UI.refresh();
                  } });
              }
            }),
            'The time between the two is what makes a pattern show up later.'),

          draft.after != null
            ? UI.field('Time of the second reading',
                UI.timeInput(draft.afterTime || Dates.nowTime(), function (v) { draft.afterTime = v; }))
            : null,

          UI.field('How did it feel?',
            UI.chips(V.feeling, draft.feeling, function (v) {
              draft.feeling = draft.feeling === v ? null : v; UI.refresh();
            }))
        ],
        actions: [
          h('button', {
            type: 'button', class: 'btn btn-primary',
            text: existing ? 'Save changes' : 'Add activity',
            onclick: function () {
              var dd = day();
              dd.movement = Store.upsert(dd.movement, draft);
              dd.movement.sort(function (a, b) { return (a.startTime || '').localeCompare(b.startTime || ''); });
              var saved = Store.save(dd);
              UI.pop();
              render();
              UI.toast(saved ? (existing ? 'Activity updated' : 'Activity noted')
                             : 'Not saved. See the message at the top.');
            }
          }),
          existing ? removeEntryAction({
            label: 'Remove this activity',
            confirmTitle: 'Remove this activity?',
            confirmMessage: 'It goes from this device, along with any readings you noted with it.',
            confirmLabel: 'Remove it',
            onRemove: function () {
              // UI.confirm closes the whole sheet stack before this runs, so there is
              // nothing to pop and she lands back on Today, same as Delete everything.
              var dd = day();
              dd.movement = Store.dropById(dd.movement, draft.id);
              var saved = Store.save(dd);
              render();
              UI.toast(saved ? 'Activity removed' : 'Not saved. See the message at the top.');
            }
          }) : null
        ]
      };
    });
  }

  /* ---------------------------------------------------- food */

  function sheetFood() {
    UI.push(function () {
      var d = day();
      var f = d.food || { meals: [], hydration: null, hungry: null };

      function set(key, value) {
        var dd = day();
        dd.food = dd.food || { meals: [], hydration: null, hungry: null };
        dd.food[key] = value;
        commit(dd);
      }

      var meals = (f.meals || []).map(function (m) {
        var change = (m.before != null && m.after != null) ? m.after - m.before : null;

        // A meal's two readings straddle the food, so their timing is
        // known by construction: before is pre-meal, after is post-meal.
        var sub = subLine([
          m.note || null,
          m.before != null ? h('span', {}, ['before ', reading(m.before, 'pre')]) : null,
          m.after != null ? h('span', {}, ['after ', reading(m.after, 'post')]) : null
        ]);

        return entryRow({
          time: m.time,
          label: 'Edit ' + (m.kind || 'this meal').toLowerCase(),
          title: [
            m.kind || 'Meal',
            change != null ? h('span', {
              class: 'delta ' + (change > 0.1 ? 'up' : change < -0.1 ? 'down' : 'flat'),
              text: '  ' + (change > 0 ? '+' : '') + Units.out(change)
            }) : null
          ],
          sub: sub,
          onOpen: function () { sheetMealEntry(m); }
        });
      });

      return {
        title: 'Food and drink',
        body: [
          h('p', { class: 'label', text: 'Meals and snacks' }),
          meals.length ? h('div', {}, meals) : h('p', { class: 'hint', text: 'Nothing noted yet.' }),
          h('button', {
            type: 'button', class: 'btn btn-quiet', style: 'margin:.4rem 0 1.6rem',
            onclick: function () { sheetMealEntry(); }
          }, [UI.icon('plus'), 'Add a meal or snack']),

          UI.field('How much did you drink today?',
            UI.chips(V.hydration, f.hydration, function (v) { set('hydration', f.hydration === v ? null : v); })),

          UI.field('Hungrier than usual?',
            UI.chips([{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }],
              f.hungry === true ? 'yes' : f.hungry === false ? 'no' : null,
              function (v) {
                var next = v === 'yes';
                set('hungry', f.hungry === next ? null : next);
              }))
        ],
        actions: [doneAction()]
      };
    });
  }

  function sheetMealEntry(existing) {
    // Deep-copied, so abandoning the sheet leaves her saved entry untouched.
    var draft = existing ? JSON.parse(JSON.stringify(existing)) : {
      id: uid(), kind: null, time: Dates.nowTime(), note: '', before: null, after: null, afterTime: null
    };

    UI.push(function () {
      return {
        title: existing ? 'Edit this meal' : 'Add a meal or snack',
        body: [
          UI.field('Which was it?',
            UI.chips(V.meal, draft.kind, function (v) { draft.kind = v; UI.refresh(); })),

          UI.field('Time', UI.timeInput(draft.time, function (v) { draft.time = v; })),

          UI.field('What did you have?',
            h('input', {
              type: 'text', value: draft.note, placeholder: 'Toast and tea',
              oninput: function (e) { draft.note = e.target.value; }
            }),
            'A few words is plenty.'),

          UI.field('Reading before eating',
            UI.readingButton({
              value: draft.before, placeholder: 'Tap if you tested',
              onclick: function () {
                UI.pad({ title: 'Reading before eating', value: draft.before,
                  onDone: function (v) { draft.before = v; UI.refresh(); } });
              }
            })),

          UI.field('Reading after eating',
            UI.readingButton({
              value: draft.after, placeholder: 'Tap if you tested',
              onclick: function () {
                UI.pad({ title: 'Reading after eating', value: draft.after,
                  onDone: function (v) {
                    draft.after = v;
                    if (v != null && !draft.afterTime) draft.afterTime = Dates.nowTime();
                    UI.refresh();
                  } });
              }
            })),

          draft.after != null
            ? UI.field('Time of the reading after',
                UI.timeInput(draft.afterTime || Dates.nowTime(), function (v) { draft.afterTime = v; }))
            : null
        ],
        actions: [
          h('button', {
            type: 'button', class: 'btn btn-primary', text: existing ? 'Save changes' : 'Add',
            onclick: function () {
              var dd = day();
              dd.food = dd.food || { meals: [], hydration: null, hungry: null };
              dd.food.meals = Store.upsert(dd.food.meals, draft);
              dd.food.meals.sort(function (a, b) { return (a.time || '').localeCompare(b.time || ''); });
              var saved = Store.save(dd);
              UI.pop();
              render();
              UI.toast(saved ? (existing ? 'Meal updated' : 'Noted')
                             : 'Not saved. See the message at the top.');
            }
          }),
          existing ? removeEntryAction({
            label: 'Remove this meal',
            confirmTitle: 'Remove this meal?',
            confirmMessage: 'It goes from this device, along with any readings you noted with it.',
            confirmLabel: 'Remove it',
            onRemove: function () {
              var dd = day();
              dd.food = dd.food || { meals: [], hydration: null, hungry: null };
              dd.food.meals = Store.dropById(dd.food.meals, draft.id);
              var saved = Store.save(dd);
              render();
              UI.toast(saved ? 'Meal removed' : 'Not saved. See the message at the top.');
            }
          }) : null
        ]
      };
    });
  }

  /* ---------------------------------------------------- range */

  function sheetRange() {
    UI.push(function () {
      var st = Store.settings();

      function set(key, v) { Store.setSetting(key, v); UI.refresh(); render(); }

      function padField(label, key, hint) {
        return UI.field(label,
          UI.readingButton({
            value: st[key],
            placeholder: 'Tap to add',
            onclick: function () {
              UI.pad({ title: label, value: st[key], onDone: function (v) { set(key, v); } });
            }
          }), hint);
      }

      return {
        title: 'What to aim for',
        body: [
          h('div', { class: 'panel', style: 'margin-bottom:1.6rem' }, [
            h('p', { text:
              'If your doctor gave you numbers to aim for, put them in here. ' +
              'Your readings will then show whether they are inside those numbers. ' +
              'Leave it empty and nothing is coloured.' }),
            h('p', { text:
              'Blood sugar is normally higher after food, so there are two sets. ' +
              'The app uses whichever fits when the reading was taken.' })
          ]),

          h('p', { class: 'section-head', text: 'First thing, and before meals' }),
          padField('Aim above', 'rangeLow'),
          padField('Aim below', 'rangeHigh'),

          (st.rangeLow != null && st.rangeHigh != null && st.rangeHigh <= st.rangeLow)
            ? h('p', { class: 'hint', style: 'color:var(--warn)',
                text: '“Aim below” needs to be the bigger number.' })
            : null,

          h('p', { class: 'section-head', text: 'After eating' }),
          padField('Aim below', 'postHigh',
            'Usually a couple of hours after a meal. The number to aim for is higher than the one above.'),

          (st.postHigh != null && st.rangeLow != null && st.postHigh <= st.rangeLow)
            ? h('p', { class: 'hint', style: 'color:var(--warn)',
                text: 'This needs to be bigger than “aim above”.' })
            : (st.postHigh != null && st.rangeHigh != null && st.postHigh < st.rangeHigh)
              ? h('p', { class: 'hint', style: 'color:var(--warn)',
                  text: 'That is lower than your before-meals number. Worth double-checking.' })
              : null,

          h('p', { class: 'obs-note', style: 'margin-top:1.4rem', text:
            'They’re your doctor’s numbers, not the app’s.' })
        ],
        actions: [doneAction()]
      };
    });
  }

  /* ---------------------------------------------------- stress */

  function sheetStress() {
    UI.push(function () {
      var d = day();
      var s = d.stress || {};

      function set(key, value) {
        var dd = day();
        dd.stress = dd.stress || {};
        dd.stress[key] = value;
        if (!dd.stress.emotional && !dd.stress.fatigue) dd.stress = null;
        commit(dd);
      }

      return {
        title: 'Stress and tiredness',
        body: [
          UI.field('How have you felt in yourself?',
            UI.chips(V.emotional, s.emotional, function (v) { set('emotional', s.emotional === v ? null : v); })),
          UI.field('And your energy?',
            UI.chips(V.fatigue, s.fatigue, function (v) { set('fatigue', s.fatigue === v ? null : v); }))
        ],
        actions: [doneAction()]
      };
    });
  }

  /* ---------------------------------------------------- summary */

  function sheetSummary() {
    UI.push(function () {
      var d = day();
      var s = d.summary || { notes: '', triggers: [], helped: [] };

      function set(key, value) {
        var dd = day();
        dd.summary = dd.summary || { notes: '', triggers: [], helped: [] };
        dd.summary[key] = value;
        commit(dd);
      }

      function toggle(key, value) {
        var list = (s[key] || []).slice();
        var i = list.indexOf(value);
        if (i > -1) list.splice(i, 1); else list.push(value);
        set(key, list);
      }

      return {
        title: 'End of day',
        body: [
          UI.field('Anything that seemed to set it off?',
            UI.chips(V.triggers, s.triggers, function (v) { toggle('triggers', v); }, true),
            'Tap as many as you like, or none.'),

          UI.field('Anything that helped?',
            UI.chips(V.helped, s.helped, function (v) { toggle('helped', v); }, true)),

          UI.field('Anything else worth remembering?',
            h('textarea', {
              placeholder: 'A few words about the day…',
              onchange: function (e) { set('notes', e.target.value); }
            }))
        ],
        actions: [doneAction()]
      };
    });
  }

  /* ============================================================
     HISTORY
     ============================================================ */

  /**
   * @param n  how many days to plot. 7 fits a dot and a label per day.
   *           Anything longer drops the per-day dots — 28 of them across a
   *           phone screen collide into a smear — and puts five dates inside
   *           the SVG instead. Nothing is averaged onto the chart; see
   *           the specification §9.2.1 for why.
   */
  function weekChart(endDate, n) {
    n = n || 7;
    var long = n > 7;
    var days = Store.span(endDate, n);
    var vals = days.map(function (d) { return d.morning ? d.morning.glucose : null; });
    var present = vals.filter(function (v) { return v != null; });

    if (!present.length) {
      return h('div', { class: 'chart' }, [
        h('p', { class: 'chart-empty',
          text: 'No morning readings in the last ' + (long ? '4 weeks' : '7 days') + '.' })
      ]);
    }

    var max = Math.max.apply(null, present);
    var min = Math.min.apply(null, present);
    // Keep a sane scale when every reading is identical.
    if (max - min < 0.4) { max += 0.4; min -= 0.4; }
    var pad = (max - min) * 0.28;
    var top = max + pad, floor = Math.max(0, min - pad);

    var W = 300, H = 130, L = 26, R = 10, T = 20, B = long ? 26 : 12;
    var plotW = W - L - R, plotH = H - T - B;

    function x(i) { return L + (plotW / (n - 1)) * i; }
    function y(v) { return T + plotH - ((v - floor) / (top - floor)) * plotH; }

    var svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label',
      'Morning readings for the last ' + (long ? '4 weeks' : '7 days') + '. Lowest ' + Units.out(min) +
      ', highest ' + Units.out(max) + ' ' + Units.label() + '.');

    function el(name, attrs) {
      var n = document.createElementNS(SVG, name);
      for (var k in attrs) n.setAttribute(k, attrs[k]);
      return n;
    }

    var ranged = Units.hasTarget('pre');       // the chart plots morning readings

    if (ranged) {
      // Her band, drawn behind everything. Clipped to the plot so an
      // out-of-view bound doesn't spill.
      var s = Store.settings();
      var bTop = Math.max(T, y(Math.min(s.rangeHigh, top)));
      var bBot = Math.min(T + plotH, y(Math.max(s.rangeLow, floor)));
      if (bBot > bTop) {
        svg.appendChild(el('rect', {
          class: 'ch-band', x: L, y: bTop, width: plotW, height: bBot - bTop
        }));
      }
      [[s.rangeHigh, bTop], [s.rangeLow, bBot]].forEach(function (p) {
        var v = p[0], yy = p[1];
        if (v > top || v < floor) return;
        svg.appendChild(el('line', { class: 'ch-bandline', x1: L, y1: yy, x2: W - R, y2: yy }));
        var t = el('text', { class: 'ch-bandtick', x: 0, y: yy + 3 });
        t.textContent = Units.out(v);
        svg.appendChild(t);
      });
    } else {
      // No range: reference lines at her own highest and lowest, so the
      // scale means something without implying a target.
      [max, min].forEach(function (v) {
        svg.appendChild(el('line', { class: 'ch-grid', x1: L, y1: y(v), x2: W - R, y2: y(v) }));
        var t = el('text', { class: 'ch-tick', x: 0, y: y(v) + 3 });
        t.textContent = Units.out(v);
        svg.appendChild(t);
      });
    }

    // Break the line across days with no reading rather than bridging
    // a gap that would imply readings we don't have.
    var runs = [], run = [];
    vals.forEach(function (v, i) {
      if (v == null) { if (run.length) { runs.push(run); run = []; } }
      else run.push({ i: i, v: v });
    });
    if (run.length) runs.push(run);

    runs.forEach(function (pts) {
      if (pts.length > 1) {
        var d = pts.map(function (p, k) { return (k ? 'L' : 'M') + x(p.i) + ' ' + y(p.v); }).join(' ');
        var area = d + ' L' + x(pts[pts.length - 1].i) + ' ' + (T + plotH) +
                       ' L' + x(pts[0].i) + ' ' + (T + plotH) + ' Z';
        svg.appendChild(el('path', { class: 'ch-fill', d: area }));
        svg.appendChild(el('path', { class: 'ch-line', d: d }));
      }
    });

    var lastIdx = -1;
    vals.forEach(function (v, i) { if (v != null) lastIdx = i; });

    vals.forEach(function (v, i) {
      if (v == null) return;
      var sc = ranged ? ' s-' + Units.state(v, 'pre') : '';
      if (i === lastIdx) {
        svg.appendChild(el('circle', { class: 'ch-halo' + sc, cx: x(i), cy: y(v), r: 9 }));
        svg.appendChild(el('circle', { class: 'ch-today' + sc, cx: x(i), cy: y(v), r: 4.6 }));
        var lbl = el('text', {
          class: 'ch-val', x: x(i), y: y(v) - 13,
          'text-anchor': i >= n - 2 ? 'end' : 'middle'
        });
        lbl.textContent = Units.out(v);
        svg.appendChild(lbl);
      } else if (!long) {
        svg.appendChild(el('circle', { class: 'ch-dot' + sc, cx: x(i), cy: y(v), r: 3.4 }));
      }
    });

    // Dates go inside the SVG on the long chart so they line up exactly
    // with the points rather than being spread evenly by flexbox.
    if (long) {
      [0, 7, 14, 21, n - 1].forEach(function (i, k, arr) {
        if (k && i === arr[k - 1]) return;
        var t = el('text', {
          class: 'ch-date', x: x(i), y: H - 6,
          'text-anchor': k === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle')
        });
        t.textContent = Dates.medium(days[i].date);
        svg.appendChild(t);
      });
    }

    /* No footer on the long chart: its dates are inside the SVG so they line
       up with the points. The short one keeps a day name under each column. */
    var footer = null;
    if (!long) {
      footer = h('div', { class: 'ch-labels' });
      days.forEach(function (d, i) {
        footer.appendChild(h('span', {
          class: i === lastIdx ? 'now' : '',
          text: Dates.dayShort(d.date)
        }));
      });
    }

    return h('div', { class: 'chart' + (ranged ? ' ranged' : '') }, [svg, footer]);
  }

  function screenHistory() {
    var out = [];
    var all = Store.dates();

    if (!all.length) {
      return [UI.emptyState('book', 'Nothing here yet',
        'Once you’ve noted a few days, they’ll show up here with a chart of your morning readings.')];
    }

    out.push(h('p', { class: 'section-head', text: 'Morning readings, last 4 weeks' }));
    out.push(weekChart(Dates.today(), 28));

    // Same span as the chart above it, and the same 28 days the
    // comparisons on Patterns are built from.
    var window28 = Store.span(Dates.today(), 28);
    var sum = Engine.summary(window28);
    if (sum.count) {
      out.push(h('p', {
        class: 'meter-label',
        style: 'margin-top:.7rem',
        text: 'Average ' + Units.full(sum.avg) + ' · lowest ' + Units.out(sum.min) +
              ' · highest ' + Units.out(sum.max) + ' · ' + sum.count +
              (sum.count === 1 ? ' reading' : ' readings')
      }));
    }

    /* One month at a time, and the arrows step between months that have
       something in them rather than through the calendar — a diary has gaps,
       and stepping into an empty March teaches her the arrows are unreliable. */
    var months = monthsWithData();
    if (months.indexOf(state.historyMonth) === -1) state.historyMonth = months[0];
    var at = months.indexOf(state.historyMonth);

    out.push(h('div', { class: 'month-nav' }, [
      h('button', {
        type: 'button', 'aria-label': 'Earlier month',
        disabled: at >= months.length - 1,
        onclick: function () { state.historyMonth = months[at + 1]; render(); }
      }, UI.icon('left')),
      h('button', {
        type: 'button', class: 'month-pick',
        onclick: months.length > 1 ? sheetMonths : null,
        disabled: months.length < 2
      }, [
        h('span', { class: 'month-name', text: monthLabel(state.historyMonth) }),
        months.length > 1 ? h('span', { class: 'month-hint', text: 'Tap to jump' }) : null
      ]),
      h('button', {
        type: 'button', 'aria-label': 'Later month',
        disabled: at <= 0,
        onclick: function () { state.historyMonth = months[at - 1]; render(); }
      }, UI.icon('right'))
    ]));

    var inMonth = all.filter(function (date) {
      return date.indexOf(state.historyMonth) === 0 && !Store.isEmpty(Store.get(date));
    });

    inMonth.forEach(function (date) {
      var d = Store.get(date);
      var count = Store.completeCount(d);
      var g = d.morning ? d.morning.glucose : null;

      out.push(h('button', {
        type: 'button', class: 'day-row',
        onclick: function () { state.date = date; state.tab = 'today'; render(); }
      }, [
        h('span', { class: 'd-date' }, [
          h('span', { class: 'd-day', text: Dates.friendly(date) }),
          h('span', { class: 'd-meta', text: count + ' of 5 noted' })
        ]),
        h('span', { class: 'd-val' + (g == null ? ' none' : ''), text: g == null ? '—' : Units.out(g) })
      ]));
    });

    out.push(h('p', { class: 'obs-note', style: 'margin-top:.8rem', text:
      inMonth.length + (inMonth.length === 1 ? ' day' : ' days') + ' noted in ' + monthLabel(state.historyMonth) }));

    return out;
  }

  /** Every month with something in it. Deliberate action, so a long list is fine. */
  function sheetMonths() {
    UI.push(function () {
      var months = monthsWithData();
      return {
        title: 'Jump to a month',
        body: months.map(function (ym) {
          var n = Store.dates().filter(function (d) {
            return d.indexOf(ym) === 0 && !Store.isEmpty(Store.get(d));
          }).length;
          return h('button', {
            type: 'button',
            class: 'day-row' + (ym === state.historyMonth ? ' current' : ''),
            onclick: function () { state.historyMonth = ym; UI.close(); render(); }
          }, [
            h('span', { class: 'd-date' }, [
              h('span', { class: 'd-day', text: monthLabel(ym) }),
              h('span', { class: 'd-meta', text: n + (n === 1 ? ' day' : ' days') })
            ]),
            ym === state.historyMonth ? h('span', { class: 'set-done' }, UI.icon('check')) : null
          ]);
        }),
        actions: [doneAction()]
      };
    });
  }

  /* ============================================================
     PATTERNS
     ============================================================ */

  function screenInsights() {
    var out = [];
    var days = Store.span(Dates.today(), 28);
    var result = Engine.patterns(days);

    out.push(h('div', { class: 'panel disclaimer' }, [
      h('b', { text: 'This is a diary, not a diagnosis. ' }),
      document.createTextNode(
        'Blood sugar moves for lots of reasons at once: food, sleep, stress, illness, medication, hormones. ' +
        'Readings a few times a day can’t tell those apart. So this page only shows what you wrote down, ' +
        'side by side. If something here looks important, show it to your doctor.'
      ),
      h('p', { class: 'disclaimer-more', text:
        'With this few days, some of what shows up here will be coincidence. ' +
        'If something matters, it’ll still be here in a month.' })
    ]));

    if (!result.ready) {
      out.push(UI.emptyState('search', 'Not enough to go on yet',
        'Comparisons need at least ' + result.need + ' days with a morning reading. You have ' +
        result.have + ' so far. Keep going, it’s worth it.'));
    } else if (!result.items.length) {
      out.push(UI.emptyState('search', 'Nothing stands out',
        'Across ' + result.have + ' days with a reading, nothing differs enough to be worth pointing at. ' +
        'That counts. Nothing stood out, and that’s worth knowing.'));
    } else {
      out.push(h('p', { class: 'section-head', text: 'Logged side by side' }));
      result.items.forEach(function (it) {
        out.push(h('div', { class: 'obs' }, [
          h('div', { class: 'obs-kind', text: it.kind }),
          h('div', { class: 'obs-text', html: it.text }),
          it.note ? h('div', { class: 'obs-note', text: it.note }) : null
        ]));
      });
    }

    // --- her own tags, counted ---------------------------------------
    var triggers = Engine.tally(days, 'triggers');
    var helped = Engine.tally(days, 'helped');

    if (triggers.length) {
      out.push(h('p', { class: 'section-head', text: 'What you said set it off' }));
      out.push(tallyList(triggers, false));
    }
    if (helped.length) {
      out.push(h('p', { class: 'section-head', text: 'What you said helped' }));
      out.push(tallyList(helped, true));
    }
    if (triggers.length || helped.length) {
      out.push(h('p', { class: 'obs-note', style: 'margin-top:.8rem',
        text: 'These are just your own notes from the last 4 weeks, added up.' }));
    }

    return out;
  }

  function tallyList(rows, good) {
    var max = rows[0].n;
    var wrap = h('div', { class: 'tally' });
    rows.slice(0, 8).forEach(function (r) {
      wrap.appendChild(h('div', { class: 'tally-row' + (good ? ' good' : '') }, [
        h('span', { class: 'tally-name', text: r.name }),
        h('span', { class: 'tally-bar' }, h('i', { style: 'width:' + (r.n / max * 100) + '%' })),
        h('span', { class: 'tally-n', text: r.n })
      ]));
    });
    return wrap;
  }

  /* ============================================================
     MORE
     ============================================================ */

  function seg(options, current, onPick) {
    var wrap = h('div', { class: 'seg' });
    options.forEach(function (o) {
      wrap.appendChild(h('button', {
        type: 'button',
        'aria-pressed': current === o.value ? 'true' : 'false',
        text: o.label,
        onclick: function () { onPick(o.value); }
      }));
    });
    return wrap;
  }

  function setRow(label, sub, control) {
    return h('div', { class: 'set-row' }, [
      h('span', { class: 'set-label' }, [label, sub ? h('small', { text: sub }) : null]),
      control
    ]);
  }

  function buttonRow(label, sub, onclick) {
    return h('button', { type: 'button', class: 'set-row', onclick: onclick }, [
      h('span', { class: 'set-label' }, [label, sub ? h('small', { text: sub }) : null]),
      UI.icon('chev', 'chev')
    ]);
  }

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = h('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.parentNode.removeChild(a); }, 2000);
  }

  function stamp() {
    return Dates.today().replace(/-/g, '');
  }

  /* Works even when localStorage is refusing writes — the backup is
     built from what is in memory, which is the copy at risk. */
  function backupNow() {
    if (!Store.dates().length) { UI.toast('Nothing to back up yet'); return; }
    download('daybook-backup-' + stamp() + '.json', Store.exportJSON(), 'application/json');
    // Recorded so the nudge can say how long it has been, and stop nagging.
    // Not recorded in demo mode: that file is not her notes.
    if (!Store.isDemo()) { Store.markBackedUp(); render(); }
    UI.toast('Backup saved to your downloads');
  }

  function screenMore() {
    var st = Store.settings();
    var out = [];

    out.push(h('p', { class: 'section-head', text: 'Reading it comfortably' }));
    out.push(h('div', { class: 'set-group' }, [
      setRow('Text size', null, seg([
        { value: 'normal', label: 'A' }, { value: 'large', label: 'A+' }, { value: 'xlarge', label: 'A++' }
      ], st.textSize, function (v) { Store.setSetting('textSize', v); applyAppearance(); render(); })),
      setRow('Theme', null, seg([
        { value: 'auto', label: 'Auto' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }
      ], st.theme, function (v) { Store.setSetting('theme', v); applyAppearance(); render(); }))
    ]));

    out.push(h('p', { class: 'section-head', text: 'Readings' }));
    out.push(h('div', { class: 'set-group' }, [
      setRow('Units', 'Whatever your meter shows. Changing it won’t alter anything you’ve already noted.',
        seg([{ value: 'mmol', label: 'mmol/L' }, { value: 'mgdl', label: 'mg/dL' }],
          st.units, function (v) { Store.setSetting('units', v); render(); })),
      buttonRow('What to aim for', (function () {
        var u = ' ' + Units.label();
        var pre = Units.hasTarget('pre')
          ? Units.out(st.rangeLow) + ' to ' + Units.out(st.rangeHigh) + u + ' before meals' : null;
        var post = Units.hasTarget('post')
          ? 'under ' + Units.out(st.postHigh) + u + ' after eating' : null;
        if (!pre && !post) return 'Not set. Nothing is coloured until it is.';
        return [pre, post].filter(Boolean).join(', ') + '. Tap to change.';
      })(), sheetRange)
    ]));

    out.push(h('p', { class: 'section-head', text: 'Your data' }));
    out.push(h('div', { class: 'set-group' }, [
      Store.isInstalled()
        ? setRow('On your home screen', 'Your notes are safe from being cleared.',
            h('span', { class: 'set-done' }, UI.icon('check')))
        : buttonRow('Put it on your home screen',
            'A web page loses what it saved after a week unopened. This stops that.', sheetInstall)
    ]));
    out.push(h('div', { class: 'set-group' }, [
      buttonRow('Export as a spreadsheet', 'Opens in Excel. Fine to hand to your doctor.', function () {
        if (!Store.dates().length) return UI.toast('Nothing to export yet');
        download('daybook-' + stamp() + '.csv', Store.exportCSV(), 'text/csv;charset=utf-8');
        UI.toast('Spreadsheet saved to your downloads');
      }),
      buttonRow('Back up everything', (function () {
        var b = Store.backupStatus();
        if (!b.hasAnything) return 'A file with all your days in it. Keep it somewhere safe.';
        if (b.neverBackedUp) return 'Not done yet. Worth doing today.';
        return b.daysSince === 0 ? 'Last saved today.'
             : 'Last saved ' + b.daysSince + (b.daysSince === 1 ? ' day ago.' : ' days ago.');
      })(), backupNow),
      buttonRow('Restore from a backup', 'Adds the days from a backup file to this device.', importBackup),
      buttonRow(Store.isDemo() ? 'Remove the demo' : 'Show me an example month',
        Store.isDemo()
          ? 'Puts your own notes back exactly as they were.'
          : 'A made-up month, so you can see how it all works. Your own notes are kept safe.',
        toggleDemo),
      buttonRow('Delete everything', 'Removes every day from this device. Can’t be undone.', function () {
        UI.confirm({
          title: 'Delete everything?',
          message: 'Every day you’ve noted will be removed from this device. If you don’t have a backup file, there’s no way to get it back.',
          confirmLabel: 'Yes, delete it all',
          danger: true,
          onConfirm: function () {
            var cleared = Store.clearAll();
            state.date = Dates.today();
            render();
            UI.toast(cleared ? 'Everything deleted'
                             : 'Cleared here, but the device wouldn’t save the change');
          }
        });
      })
    ]));

    out.push(h('p', { class: 'section-head', text: 'About' }));
    out.push(h('div', { class: 'prose' }, [
      h('p', { text: 'Everything you write stays on this device. Nothing is sent anywhere, there’s no account, and it works with no signal.' }),

      h('h3', { text: 'Why there’s no “hormone score”' }),
      h('p', { text: 'Adrenaline, cortisol and insulin all move blood sugar. It’s tempting to work out which one is doing it from the shape of a reading, but you can’t. A finger-prick a few times a day is far too coarse, and the three overlap. So do illness, infection, steroids and simply waking up.' }),
      h('p', { text: 'So this app doesn’t label your days. It keeps a diary and lays your notes side by side, so you and your doctor can see what actually goes together.' }),

      h('h3', { text: 'What roughly does what' }),
      h('ul', {}, [
        h('li', { html: '<b>Adrenaline</b> is the fast one: a fright, a rush, a sudden effort. It can lift blood sugar quickly by releasing stored glucose.' }),
        h('li', { html: '<b>Cortisol</b> is the slow one: ongoing stress, broken sleep, pain, illness. It tends to lift blood sugar gradually and keep it up, and it’s part of why mornings can be high.' }),
        h('li', { html: '<b>Insulin</b> is the one that brings it down. In type 2 the body often still makes it but responds to it poorly, so a high can sit there for hours.' })
      ]),
      h('p', { text: 'That’s background, not a way to read your own numbers. Your doctor can order tests that actually measure these things if there’s reason to.' }),

      h('h3', { text: 'One important thing' }),
      h('p', { text: 'This app gives no medical advice and no dosing advice. Never change medication because of something you read here. If you feel unwell, contact your doctor.' }),

      h('h3', { text: 'Version' }),
      h('p', { id: 'about-version', text: 'Checking…' })
    ]));

    showVersion();
    return out;
  }

  /**
   * Fill in the version line in About, by asking the worker that is actually running.
   *
   * Deliberately not a constant baked into the page: the page and the worker can disagree, and
   * when they do it is exactly the situation worth seeing. The worker is what serves her files,
   * so its cache name is the one that answers "did the update land".
   */
  function showVersion() {
    var say = function (text) {
      var el = document.getElementById('about-version');
      if (el) el.textContent = text;
    };
    var sw = navigator.serviceWorker;
    if (!sw || !sw.controller || typeof MessageChannel === 'undefined') {
      say('Not known on this device.');
      return;
    }

    var answered = false;
    var channel = new MessageChannel();
    channel.port1.onmessage = function (e) {
      if (answered) return;
      answered = true;
      say(e.data || 'Not known on this device.');
    };
    try {
      sw.controller.postMessage({ type: 'VERSION' }, [channel.port2]);
    } catch (err) {
      say('Not known on this device.');
      return;
    }
    // An older worker predates the question and will never reply, so do not leave her on "Checking".
    setTimeout(function () { if (!answered) { answered = true; say('Not known on this device.'); } }, 1500);
  }

  /* Demo data swaps in over her own, which is parked rather than
     replaced. Both directions are confirmed, because either one
     changes everything she can see. */
  function toggleDemo() {
    if (Store.isDemo()) {
      var n = Store.parkedCount();
      UI.confirm({
        title: 'Remove the demo?',
        message: n
          ? 'The example month goes away and your own ' + n + (n === 1 ? ' day comes' : ' days come') + ' back.'
          : 'The example month goes away and you start with an empty diary again.',
        confirmLabel: 'Remove it',
        onConfirm: function () {
          var ok = Store.exitDemo();
          state.date = Dates.today();
          render();
          UI.toast(ok ? 'Your own notes are back' : 'Could not switch back. Nothing was lost.');
        }
      });
      return;
    }

    var mine = Store.dates().filter(function (dt) { return !Store.isEmpty(Store.get(dt)); }).length;
    UI.confirm({
      title: 'Show an example month?',
      message: (mine
        ? 'Your ' + mine + (mine === 1 ? ' day is' : ' days are') + ' put to one side and come back when you remove the demo. Nothing is deleted. '
        : '') + 'The example is a made-up person.',
      confirmLabel: 'Show me',
      onConfirm: function () {
        var ok = Store.enterDemo(Demo.build(Dates.today()), Demo.RANGE);
        state.date = Dates.today();
        state.tab = 'today';
        render();
        UI.toast(ok ? 'Example month loaded' : 'Could not load it. Your notes are untouched.');
      }
    });
  }

  function importBackup() {
    var input = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var r = Store.importJSON(reader.result);
          render();
          if (!r.saved) {
            UI.toast('Restored ' + r.total + ' days, but they weren’t saved');
          } else if (r.added < r.total) {
            UI.toast('Added ' + r.added + '. The other ' + (r.total - r.added) + ' were already here.');
          } else {
            UI.toast('Restored ' + r.total + ' days');
          }
        } catch (e) {
          UI.toast('That doesn’t look like a backup file');
        }
      };
      reader.readAsText(file);
    });
    document.body.appendChild(input);
    input.click();
    setTimeout(function () { if (input.parentNode) input.parentNode.removeChild(input); }, 60000);
  }

  /* ============================================================
     RENDER
     ============================================================ */

  var TITLES = {
    history:  { eyebrow: 'Looking back', title: 'History' },
    insights: { eyebrow: 'Side by side', title: 'Patterns' },
    more:     { eyebrow: 'Your app', title: 'More' }
  };

  /* The only alarming thing the app is allowed to say. It stays on
     screen until a write succeeds, and offers the one action that
     still works: getting her data off the device. */
  var ALERTS = {
    unavailable: {
      title: 'Your notes aren’t being saved',
      body: 'This device isn’t letting the app store anything, so what you note now will be gone when you close it. ' +
            'Save a backup file, then show this message to whoever set the app up.'
    },
    quota: {
      title: 'There was no room to save',
      body: 'What you just noted may not have been kept. Save a backup file now, ' +
            'then show this message to whoever set the app up.'
    }
  };

  function renderAlert() {
    var el = document.getElementById('alert');
    var st = Store.status();
    UI.clear(el);
    el.className = 'alert';

    // A storage fault outranks the demo notice: it is the one that
    // costs her something.
    if (!st.ok) {
      var copy = ALERTS[st.reason] || ALERTS.unavailable;
      el.hidden = false;
      UI.append(el, [
        h('p', { class: 'alert-title', text: copy.title }),
        h('p', { class: 'alert-body', text: copy.body }),
        h('button', { type: 'button', class: 'btn', text: 'Save a backup file', onclick: backupNow })
      ]);
      return;
    }

    if (Store.isDemo()) {
      el.hidden = false;
      el.className = 'alert alert-demo';
      UI.append(el, [
        h('p', { class: 'alert-title', text: 'This is an example month' }),
        h('p', { class: 'alert-body', text:
          'Made-up notes for someone else, so you can see how the app works. ' +
          'Your own notes are safe and come back when you remove it.' }),
        h('button', { type: 'button', class: 'btn', text: 'Remove the demo', onclick: toggleDemo })
      ]);
      return;
    }

    el.hidden = true;
  }

  function renderScreen() {
    var view = document.getElementById('view');
    UI.clear(view);
    var content =
      state.tab === 'today'   ? screenToday()   :
      state.tab === 'history' ? screenHistory() :
      state.tab === 'insights' ? screenInsights() :
                                screenMore();
    UI.append(view, content);
  }

  function render() {
    var top = document.getElementById('topbar');
    UI.clear(top);

    if (state.tab === 'today') {
      UI.append(top, topbarToday());
    } else {
      var t = TITLES[state.tab];
      UI.append(top, [
        h('p', { class: 'eyebrow', text: t.eyebrow }),
        h('h1', { class: 'page-title', text: t.title })
      ]);
    }

    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      if (b.getAttribute('data-tab') === state.tab) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });

    renderAlert();
    renderUpdatePrompt();
    renderScreen();
  }

  /**
   * The "there's a newer one" prompt.
   *
   * Its own host rather than the alert's, because both replace their contents
   * and one would silently eat the other. Queueing is free: while a sheet is
   * open promptState returns 'busy' and nothing is drawn, and the next render
   * after she closes it draws it. No timer, no queue, no state to keep.
   */
  function renderUpdatePrompt() {
    var host = document.getElementById('update');
    if (!host) return;
    UI.clear(host);

    if (Updater.promptState(state.updateReady, document) !== 'ready') { host.hidden = true; return; }

    host.hidden = false;
    UI.append(host, [
      h('div', { class: 'update-words' }, [
        h('b', { text: 'There’s a newer Daybook' }),
        h('span', { text: 'Your notes stay exactly as they are.' })
      ]),
      h('button', { type: 'button', class: 'btn btn-quiet update-later', text: 'Not now',
        onclick: function () { state.updateReady = false; render(); } }),
      h('button', { type: 'button', class: 'btn btn-primary update-take', text: 'Get it',
        onclick: function () { if (updater) updater.take(); } })
    ]);
  }

  function applyAppearance() {
    var st = Store.settings();
    var root = document.documentElement;

    var theme = st.theme;
    if (theme === 'auto') {
      theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    root.setAttribute('data-theme', theme);

    root.style.setProperty('--root-size',
      st.textSize === 'xlarge' ? '24px' : st.textSize === 'large' ? '21px' : '18px');

    var meta = document.querySelector('meta[name="theme-color"]');
    // Read the ground straight off the stylesheet, so this can never drift
    // from the palette the way the two hard-coded hexes here just had.
    if (meta) {
      meta.setAttribute('content',
        getComputedStyle(root).getPropertyValue('--paper').trim() || '#F1F3F1');
    }
  }

  /* ---------------------------------------------------- boot */

  function boot() {
    Store.init();
    applyAppearance();

    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onChange = function () { if (Store.settings().theme === 'auto') applyAppearance(); };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }

    document.getElementById('tabbar').addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.tab') : null;
      if (!btn) return;
      state.tab = btn.getAttribute('data-tab');
      if (state.tab === 'today') state.date = state.date || Dates.today();
      render();
      document.getElementById('view').scrollIntoView({ block: 'start' });
    });

    document.getElementById('scrim').addEventListener('click', UI.close);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !document.getElementById('sheet').hidden) UI.pop();
    });

    // A new day while the app sits open overnight, and a newer Daybook while it sat closed.
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;

      if (state.tab === 'today') {
        if (Dates.diff(Dates.today(), state.date) < 0) state.date = Dates.today();
        render();
      }

      /* An installed app is resumed, not cold-started, so `load` below may not fire
         again for days. Without this, "Not now" was permanent: `updatefound` cannot
         fire twice for the same waiting worker, so nothing could ever raise the
         prompt again. Ask on every return to the foreground instead. */
      /* Checked for, not assumed. A cache holding this file next to an older
         js/update.js is exactly what the precache bug produced, and in that state
         every return to the foreground threw. Seen in the console while fixing it. */
      if (updater && typeof updater.recheck === 'function') updater.recheck(document);
    });

    render();

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').then(function (reg) {
          updater = Updater.watch(reg, function () {
            state.updateReady = true;
            render();
          });
        }).catch(function () { /* offline is a bonus, not a requirement */ });
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
