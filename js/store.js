/* ============================================================
   Store — everything lives on this device, in localStorage.
   Glucose is stored canonically in mmol/L and converted for
   display, so switching units never rewrites her history.
   ============================================================ */

var Store = (function () {
  'use strict';

  /* Storage keys are deliberately not named after the app, so a future
     rename is a display change and nothing more. Nothing has shipped
     under any other key, so there is no migration to carry. */
  var PREFIX    = 'diary.';
  var DAYS_KEY  = PREFIX + 'days.v1';
  var SET_KEY   = PREFIX + 'settings.v1';
  var PARK_KEY  = PREFIX + 'parked.v1';   // her real data while demo is on

  var defaults = {
    units: 'mmol',        // 'mmol' | 'mgdl'
    theme: 'auto',        // 'auto' | 'light' | 'dark'
    textSize: 'normal',   // 'normal' | 'large' | 'xlarge'

    /* Her target range for the MORNING reading only, in canonical
       mmol/L, as given by her doctor.

       Fasting and post-meal targets are different numbers — roughly
       4–7 vs under 8.5 mmol/L under NICE, 80–130 vs under 180 mg/dL
       under ADA — so one range cannot serve both. Only `morning.glucose`
       is ever compared against this. Do not extend it to meal readings
       without adding a separate post-meal pair.

       Null by default and never guessed: targets shift with age (older
       patients are often set a deliberately relaxed one to avoid hypos)
       and with which country's guidance you follow. With these unset,
       no colour appears anywhere in the app. */
    rangeLow: null,
    rangeHigh: null,

    /* Upper bound for a reading taken after eating. Guidance gives this
       as a ceiling only (NICE: under 8.5 mmol/L; ADA: under 180 mg/dL),
       so there is no separate post-meal floor — a low reading is a low
       reading whenever it happens, and `rangeLow` serves both. */
    postHigh: null,

    /* True while demo data is loaded. Her real days are parked, not
       replaced, and come back when it is switched off. */
    demo: false,

    /* When she last saved a backup file, ISO, or null. Drives the nudge
       in §11.3 — not a record of anything she did in the diary. */
    lastBackupAt: null
  };

  var days = {};
  var settings = {};

  /* Storage health. If writing ever stops working she must be told
     immediately — a day logged into nothing is worse than no app.
     reason: null | 'unavailable' | 'quota' */
  var storage = { ok: true, reason: null };

  function isQuotaError(e) {
    if (!e) return false;
    return e.name === 'QuotaExceededError' ||
           e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
           e.code === 22 || e.code === 1014;
  }

  function fail(e) {
    storage.ok = false;
    storage.reason = isQuotaError(e) ? 'quota' : 'unavailable';
    return false;
  }

  /** Can we actually write to this device at all? */
  function probe() {
    var k = PREFIX + 'probe';
    try {
      localStorage.setItem(k, '1');
      var back = localStorage.getItem(k);
      localStorage.removeItem(k);
      if (back !== '1') return fail(null);
      storage.ok = true;
      storage.reason = null;
      return true;
    } catch (e) {
      return fail(e);
    }
  }

  function read(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function write(key, value) {
    var text;
    try {
      text = JSON.stringify(value);
    } catch (e) {
      return fail(e);
    }
    try {
      localStorage.setItem(key, text);
      // Some browsers accept the write and quietly drop it, so read it
      // back rather than trusting that setItem didn't throw.
      if (localStorage.getItem(key) !== text) return fail(null);
      storage.ok = true;
      storage.reason = null;
      return true;
    } catch (e) {
      return fail(e);
    }
  }

  function status() {
    return { ok: storage.ok, reason: storage.reason };
  }

  function init() {
    probe();
    days = read(DAYS_KEY, {}) || {};
    var s = read(SET_KEY, {}) || {};
    settings = {};
    for (var k in defaults) settings[k] = (k in s) ? s[k] : defaults[k];
  }

  /* ---------------------------------------------------- days */

  function blankDay(date) {
    return {
      date: date,
      morning: null,
      movement: [],
      food: null,
      stress: null,
      summary: null,
      updatedAt: null
    };
  }

  function get(date) {
    var d = days[date];
    if (!d) return blankDay(date);
    // tolerate older/partial records
    if (!d.movement) d.movement = [];
    return d;
  }

  function save(day) {
    day.updatedAt = new Date().toISOString();
    days[day.date] = day;
    return write(DAYS_KEY, days);
  }

  function remove(date) {
    delete days[date];
    return write(DAYS_KEY, days);
  }

  /**
   * Put an entry into a list of entries, replacing the one with the same `id` if it is already
   * there and appending it if it is not. Used by both the movement list and the meals list.
   *
   * **Why this is here and not inline in a sheet.** It decides whether an edit updates her existing
   * activity or silently becomes a second one beside it. Getting that wrong duplicates an entry or
   * drops it, which is B4 territory, and it is the only part of editing an entry that is pure
   * enough to test without a browser. Returns a new array; the caller decides whether to keep it.
   */
  function upsert(list, entry) {
    var out = (list || []).slice();
    if (!entry || entry.id == null) return out;
    for (var i = 0; i < out.length; i++) {
      if (out[i] && out[i].id === entry.id) { out[i] = entry; return out; }
    }
    out.push(entry);
    return out;
  }

  /** Drop the entry with this `id`. Returns a new array, and is a no-op if it is not there. */
  function dropById(list, id) {
    return (list || []).filter(function (x) { return !x || x.id !== id; });
  }

  /** Every logged date, newest first. */
  function dates() {
    return Object.keys(days).sort().reverse();
  }

  /** Day records for the N days ending at `endDate`, oldest first. */
  function span(endDate, n) {
    var out = [];
    for (var i = n - 1; i >= 0; i--) out.push(get(Dates.add(endDate, -i)));
    return out;
  }

  function isEmpty(day) {
    return !day.morning && !day.food && !day.stress && !day.summary &&
           (!day.movement || day.movement.length === 0);
  }

  /** Which of the five sections have something in them. */
  function sections(day) {
    return {
      morning:  !!day.morning,
      movement: !!(day.movement && day.movement.length),
      food:     !!(day.food && (day.food.hydration || (day.food.meals && day.food.meals.length) || day.food.hungry != null)),
      stress:   !!(day.stress && (day.stress.emotional || day.stress.fatigue)),
      summary:  !!(day.summary && ((day.summary.notes && day.summary.notes.trim()) ||
                                   (day.summary.triggers && day.summary.triggers.length) ||
                                   (day.summary.helped && day.summary.helped.length)))
    };
  }

  function completeCount(day) {
    var s = sections(day), n = 0;
    for (var k in s) if (s[k]) n++;
    return n;
  }

  /* ---------------------------------------------------- settings */

  function getSettings() { return settings; }

  function setSetting(key, value) {
    settings[key] = value;
    return write(SET_KEY, settings);
  }

  /* ---------------------------------------------------- export */

  function exportJSON() {
    return JSON.stringify({
      app: 'Daybook',
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: settings,
      days: days
    }, null, 2);
  }

  function importJSON(text) {
    var data = JSON.parse(text);
    if (!data || !data.days) throw new Error('This file does not look like a Daybook backup.');
    var added = 0;
    for (var date in data.days) {
      if (!days[date]) added++;
      days[date] = data.days[date];
    }
    return {
      total: Object.keys(data.days).length,
      added: added,
      saved: write(DAYS_KEY, days)
    };
  }

  function csvCell(v) {
    if (v == null) return '';
    var s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /**
   * One row per event, so the file opens sensibly in a spreadsheet
   * and can be handed to a clinician without explanation.
   */
  function exportCSV() {
    var u = settings.units;
    var head = ['date', 'time', 'type', 'detail', 'glucose_before', 'glucose_after', 'change', 'units', 'note'];
    var rows = [head];

    dates().slice().reverse().forEach(function (date) {
      var d = get(date);

      if (d.morning) {
        rows.push([date, d.morning.time || '', 'morning',
          'sleep: ' + (d.morning.sleep || '-') + '; pain: ' + (d.morning.pain || '-'),
          Units.out(d.morning.glucose, u), '', '', Units.label(u), '']);
      }

      (d.movement || []).forEach(function (m) {
        var change = (m.before != null && m.after != null) ? Units.out(m.after - m.before, u, true) : '';
        rows.push([date, m.startTime || '', 'movement',
          (m.activity || '') + (m.feeling ? '; felt ' + m.feeling : ''),
          Units.out(m.before, u), Units.out(m.after, u), change, Units.label(u), '']);
      });

      if (d.food) {
        (d.food.meals || []).forEach(function (m) {
          var change = (m.before != null && m.after != null) ? Units.out(m.after - m.before, u, true) : '';
          rows.push([date, m.time || '', 'food', (m.kind || '') + (m.note ? ': ' + m.note : ''),
            Units.out(m.before, u), Units.out(m.after, u), change, Units.label(u), '']);
        });
        rows.push([date, '', 'hydration', d.food.hydration || '', '', '', '', '',
          d.food.hungry ? 'often hungry' : '']);
      }

      if (d.stress) {
        rows.push([date, '', 'stress',
          'emotional: ' + (d.stress.emotional || '-') + '; fatigue: ' + (d.stress.fatigue || '-'),
          '', '', '', '', '']);
      }

      if (d.summary) {
        rows.push([date, '', 'summary',
          'set off: ' + ((d.summary.triggers || []).join(' / ') || '-') +
          '; helped: ' + ((d.summary.helped || []).join(' / ') || '-'),
          '', '', '', '', d.summary.notes || '']);
      }
    });

    return rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
  }

  function clearAll() {
    days = {};
    return write(DAYS_KEY, days);
  }

  /* ---------------------------------------------------- demo mode

     Her own days are moved aside, never overwritten. If anything in
     here fails to write, nothing is swapped and she keeps what she
     had — losing real days to a demo would be unforgivable.        */

  function isDemo() { return !!settings.demo; }

  function enterDemo(demoDays, demoSettings) {
    if (settings.demo) return false;

    var parked = { days: days, settings: JSON.parse(JSON.stringify(settings)) };
    if (!write(PARK_KEY, parked)) return false;

    var realDays = days, realSettings = settings;
    days = demoDays;
    settings = JSON.parse(JSON.stringify(settings));
    for (var k in demoSettings) settings[k] = demoSettings[k];
    settings.demo = true;

    if (write(DAYS_KEY, days) && write(SET_KEY, settings)) return true;

    // Roll back rather than leave her half-swapped.
    days = realDays;
    settings = realSettings;
    write(DAYS_KEY, days);
    write(SET_KEY, settings);
    return false;
  }

  function exitDemo() {
    if (!settings.demo) return false;
    var parked = read(PARK_KEY, null);

    days = (parked && parked.days) ? parked.days : {};
    if (parked && parked.settings) settings = parked.settings;
    settings.demo = false;

    var ok = write(DAYS_KEY, days) && write(SET_KEY, settings);
    if (ok) { try { localStorage.removeItem(PARK_KEY); } catch (e) {} }
    return ok;
  }

  /* ---------------------------------------------------- survival

     Two halves of one requirement. Mobile Safari clears a site's
     script-writable storage after roughly seven days unopened, and for
     an app that keeps everything locally that is total, silent,
     unrecoverable loss. An installed app is exempt from that eviction;
     it is not exempt from a lost or replaced device. So: install, and
     back up.                                                          */

  var BACKUP_NUDGE_DAYS = 7;

  /**
   * Is the app installed to the home screen?
   *
   * Two checks because the platforms disagree: `display-mode: standalone` is the standard, and
   * `navigator.standalone` is what iOS Safari actually sets. **Answered honestly** — a false
   * positive here would hide the one piece of setup her data's survival depends on.
   */
  function isInstalled(win) {
    var w = win || (typeof window !== 'undefined' ? window : null);
    if (!w) return false;
    if (w.navigator && w.navigator.standalone === true) return true;
    if (typeof w.matchMedia !== 'function') return false;
    return w.matchMedia('(display-mode: standalone)').matches === true;
  }

  /**
   * Whether to ask her to back up, and why.
   *
   * Never nudges about an empty diary: there is nothing to lose yet, and a prompt before she has
   * written anything only teaches her to dismiss prompts. Being installed does not switch it off —
   * that removes the eviction risk, not the lost-device one.
   */
  function backupStatus() {
    var logged = dates().filter(function (d) { return !isEmpty(get(d)); }).length;
    var last = settings.lastBackupAt;
    var daysSince = null;
    if (last) {
      daysSince = Math.floor((Date.now() - new Date(last).getTime()) / 86400000);
      if (isNaN(daysSince)) daysSince = null;
    }
    return {
      hasAnything: logged > 0,
      days: logged,
      lastBackupAt: last,
      daysSince: daysSince,
      neverBackedUp: last === null,
      needsBackup: logged > 0 && (last === null || daysSince >= BACKUP_NUDGE_DAYS)
    };
  }

  function markBackedUp() {
    return setSetting('lastBackupAt', new Date().toISOString());
  }

  /** How many real days are waiting behind the demo. */
  function parkedCount() {
    var parked = read(PARK_KEY, null);
    return (parked && parked.days) ? Object.keys(parked.days).length : 0;
  }

  return {
    init: init,
    status: status,
    get: get,
    save: save,
    remove: remove,
    upsert: upsert,
    dropById: dropById,
    dates: dates,
    span: span,
    isEmpty: isEmpty,
    sections: sections,
    completeCount: completeCount,
    blankDay: blankDay,
    settings: getSettings,
    setSetting: setSetting,
    exportJSON: exportJSON,
    importJSON: importJSON,
    exportCSV: exportCSV,
    clearAll: clearAll,
    isDemo: isDemo,
    enterDemo: enterDemo,
    exitDemo: exitDemo,
    parkedCount: parkedCount,
    isInstalled: isInstalled,
    backupStatus: backupStatus,
    markBackedUp: markBackedUp,
    BACKUP_NUDGE_DAYS: BACKUP_NUDGE_DAYS
  };
})();


/* ============================================================
   Units — canonical storage is mmol/L.
   ============================================================ */

var Units = (function () {
  'use strict';

  var FACTOR = 18.0182;

  // Plausible entry ranges. Outside these we warn but never block —
  // it's her reading, not ours to reject.
  var RANGES = {
    mmol: { min: 1.1, max: 33.3, dp: 1, label: 'mmol/L' },
    mgdl: { min: 20,  max: 600,  dp: 0, label: 'mg/dL' }
  };

  function label(u) { return RANGES[u || Store.settings().units].label; }
  function range(u) { return RANGES[u || Store.settings().units]; }

  /** Display value (in the user's unit) from a stored mmol/L value. */
  function out(mmol, u, signed) {
    if (mmol == null || isNaN(mmol)) return '';
    u = u || Store.settings().units;
    var r = RANGES[u];
    var v = u === 'mgdl' ? mmol * FACTOR : mmol;
    var s = v.toFixed(r.dp);
    if (signed && v > 0) s = '+' + s;
    return s;
  }

  /** Stored mmol/L value from a number the user typed in their unit. */
  function into(value, u) {
    if (value == null || value === '' || isNaN(value)) return null;
    u = u || Store.settings().units;
    var v = parseFloat(value);
    return u === 'mgdl' ? v / FACTOR : v;
  }

  /** Formatted with unit, e.g. "8.4 mmol/L". */
  function full(mmol, u) {
    if (mmol == null) return '—';
    return out(mmol, u) + ' ' + label(u);
  }

  /**
   * The pair of bounds that applies to a reading taken at `when`.
   *
   * 'pre'  — waking, or before a meal. Both are measured the same way.
   * 'post' — after eating, where the ceiling is higher.
   *
   * The floor is shared: a hypo is a hypo whatever time it happens, and
   * guidance gives post-meal as a ceiling only.
   *
   * @returns {lo, hi} or null when that pair has not been filled in.
   */
  function bounds(when) {
    var s = Store.settings();
    var lo = s.rangeLow;
    var hi = when === 'post' ? s.postHigh : s.rangeHigh;
    if (lo == null || hi == null || hi <= lo) return null;
    return { lo: lo, hi: hi };
  }

  /** Is there a usable range for readings taken at `when`? */
  function hasTarget(when) { return bounds(when) != null; }

  /**
   * Where a reading sits against the range for its own timing.
   *
   * `when` is mandatory in spirit: passing a post-meal reading without
   * it measures it against the fasting ceiling and will report a normal
   * post-breakfast number as above range.
   *
   * @param when 'pre' (default) | 'post'
   * @returns 'low' | 'in' | 'high', or null when that range is unset.
   *          Null means "we were not told", never "unremarkable".
   */
  function state(mmol, when) {
    if (mmol == null) return null;
    var b = bounds(when);
    if (!b) return null;
    if (mmol < b.lo) return 'low';
    if (mmol > b.hi) return 'high';
    return 'in';
  }

  var STATE_WORDS = { low: 'Below range', in: 'In range', high: 'Above range' };
  function stateWord(st) { return STATE_WORDS[st] || ''; }

  return {
    out: out, into: into, full: full, label: label, range: range,
    bounds: bounds, hasTarget: hasTarget, state: state, stateWord: stateWord
  };
})();


/* ============================================================
   Dates — local time throughout. A day is the day she lived,
   not a UTC boundary.
   ============================================================ */

var Dates = (function () {
  'use strict';

  var DAY_NAMES  = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var DAY_SHORT  = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS     = ['January', 'February', 'March', 'April', 'May', 'June',
                    'July', 'August', 'September', 'October', 'November', 'December'];

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function iso(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function today() { return iso(new Date()); }

  function parse(s) {
    var p = s.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }

  function add(s, n) {
    var d = parse(s);
    d.setDate(d.getDate() + n);
    return iso(d);
  }

  function diff(a, b) {
    return Math.round((parse(a) - parse(b)) / 86400000);
  }

  function dayName(s)  { return DAY_NAMES[parse(s).getDay()]; }
  function dayShort(s) { return DAY_SHORT[parse(s).getDay()]; }

  /** "Today", "Yesterday", or "Tuesday 5 August". */
  function friendly(s) {
    var d = diff(today(), s);
    if (d === 0) return 'Today';
    if (d === 1) return 'Yesterday';
    if (d === -1) return 'Tomorrow';
    var dt = parse(s);
    return DAY_NAMES[dt.getDay()] + ' ' + dt.getDate() + ' ' + MONTHS[dt.getMonth()];
  }

  function medium(s) {
    var dt = parse(s);
    return dt.getDate() + ' ' + MONTHS[dt.getMonth()].slice(0, 3);
  }

  function nowTime() {
    var d = new Date();
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /** Minutes between two "HH:MM" strings, or null. */
  function minutesBetween(a, b) {
    if (!a || !b) return null;
    var pa = a.split(':'), pb = b.split(':');
    var ma = (+pa[0]) * 60 + (+pa[1]);
    var mb = (+pb[0]) * 60 + (+pb[1]);
    var d = mb - ma;
    if (d < 0) d += 1440;          // crossed midnight
    return d;
  }

  function humanMinutes(m) {
    if (m == null) return '';
    if (m < 60) return m + ' minutes';
    var h = Math.floor(m / 60), r = m % 60;
    return h + (h === 1 ? ' hour' : ' hours') + (r ? ' ' + r + ' min' : '');
  }

  return {
    iso: iso, today: today, parse: parse, add: add, diff: diff,
    dayName: dayName, dayShort: dayShort, friendly: friendly, medium: medium,
    nowTime: nowTime, minutesBetween: minutesBetween, humanMinutes: humanMinutes
  };
})();
