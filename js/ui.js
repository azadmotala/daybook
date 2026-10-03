/* ============================================================
   UI kit — tiny DOM helpers, a stacking bottom sheet, and a
   big-key number pad so she never has to fight the device keyboard.
   ============================================================ */

var UI = (function () {
  'use strict';

  /* ---------------------------------------------------- dom */

  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        var v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'text') el.textContent = v;
        else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      }
    }
    append(el, kids);
    return el;
  }

  function append(el, kids) {
    if (kids == null) return;
    if (!Array.isArray(kids)) kids = [kids];
    kids.forEach(function (k) {
      if (k == null || k === false) return;
      el.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
    });
  }

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
  }

  var ICONS = {
    check:    'M4 12.5l5 5L20 6.5',
    plus:     'M12 5v14M5 12h14',
    left:     'M15 5l-7 7 7 7',
    right:    'M9 5l7 7-7 7',
    close:    'M6 6l12 12M18 6L6 18',
    trash:    'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13',
    back:     'M9 5l-7 7 7 7M2 12h13',
    chev:     'M9 5l7 7-7 7',
    book:     'M4 5.5A1.5 1.5 0 0 1 5.5 4H19v16H5.5A1.5 1.5 0 0 1 4 18.5zM8 4v16',
    search:   'M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.8 15.8L21 21',
    download: 'M12 4v11M7.5 10.5L12 15l4.5-4.5M4 19h16'
  };

  /**
   * Every icon carries `.ico`, which gives it a default size. Without
   * a baseline an SVG with only a viewBox expands to fill its parent,
   * and any call site missing a size rule renders a giant glyph.
   * Specific rules (.tab svg, .card-mark svg, …) still win on
   * specificity, so this is a floor, not an override.
   */
  function icon(name, cls) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'ico' + (cls ? ' ' + cls : ''));
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', ICONS[name] || '');
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '2');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(p);
    return svg;
  }

  /* ---------------------------------------------------- toast */

  var toastTimer;
  function toast(message) {
    var el = document.getElementById('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2600);
  }

  /* ---------------------------------------------------- sheet stack */

  var stack = [];
  var lastFocus = null;

  function sheetEls() {
    return { sheet: document.getElementById('sheet'), scrim: document.getElementById('scrim') };
  }

  /**
   * push(build) — build() returns { title, body, actions, onBack }.
   * Rebuilt from scratch on every render, so it always reflects the
   * current draft state.
   */
  function push(build) {
    if (!stack.length) lastFocus = document.activeElement;
    stack.push(build);
    render();
  }

  function pop() {
    stack.pop();
    if (stack.length) render(); else close();
  }

  function close() {
    var e = sheetEls();
    stack = [];
    e.sheet.hidden = true;
    e.scrim.hidden = true;
    clear(e.sheet);
    document.body.style.overflow = '';
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    lastFocus = null;
  }

  function refresh() { if (stack.length) render(); }

  function render() {
    var e = sheetEls();
    var spec = stack[stack.length - 1]();

    clear(e.sheet);

    var closeBtn = h('button', {
      class: 'sheet-close',
      type: 'button',
      'aria-label': stack.length > 1 ? 'Back' : 'Close',
      onclick: function () { stack.length > 1 ? pop() : close(); }
    }, icon(stack.length > 1 ? 'back' : 'close'));

    e.sheet.appendChild(h('div', { class: 'sheet-head' }, [
      h('h2', { class: 'sheet-title', id: 'sheet-title', text: spec.title }),
      closeBtn
    ]));

    var body = h('div', { class: 'sheet-body' });
    append(body, spec.body);
    e.sheet.appendChild(body);

    if (spec.actions) {
      e.sheet.appendChild(h('div', { class: 'sheet-actions' }, spec.actions));
    }

    e.sheet.hidden = false;
    e.scrim.hidden = false;
    document.body.style.overflow = 'hidden';
    e.sheet.scrollTop = 0;
  }

  /* ---------------------------------------------------- inputs */

  /**
   * Tap-to-select row. options: [{value,label}] or ['a','b'].
   * multi:true toggles membership in an array instead of setting a value.
   */
  function chips(options, current, onPick, multi) {
    var wrap = h('div', { class: 'chips' });
    options.forEach(function (o) {
      var value = typeof o === 'string' ? o : o.value;
      var label = typeof o === 'string' ? o : o.label;
      var on = multi ? (current || []).indexOf(value) > -1 : current === value;
      wrap.appendChild(h('button', {
        type: 'button',
        class: 'chip',
        'aria-pressed': on ? 'true' : 'false',
        text: label,
        onclick: function () { onPick(value); }
      }));
    });
    return wrap;
  }

  function field(label, control, hint) {
    return h('div', { class: 'field' }, [
      h('label', { class: 'label', text: label }),
      hint ? h('p', { class: 'hint', text: hint }) : null,
      control
    ]);
  }

  /** Big tappable button that opens the number pad. */
  function readingButton(opts) {
    var has = opts.value != null;
    return h('button', {
      type: 'button',
      class: 'reading-btn',
      onclick: opts.onclick
    }, [
      has ? h('b', { text: Units.out(opts.value) }) : h('span', { class: 'placeholder', text: opts.placeholder || 'Tap to add a reading' }),
      has ? h('small', { text: Units.label() }) : null,
      h('span', { class: 'edit', text: has ? 'Change' : 'Add' })
    ]);
  }

  function timeInput(value, onChange) {
    return h('input', {
      type: 'time',
      value: value || '',
      onchange: function (ev) { onChange(ev.target.value); }
    });
  }

  /* ---------------------------------------------------- number pad */

  /**
   * pad({ title, value, onDone, onClear })
   * value / onDone are in mmol/L; the pad handles unit conversion.
   */
  function pad(opts) {
    var r = Units.range();
    var typed = opts.value != null ? Units.out(opts.value) : '';

    function commit() {
      var v = parseFloat(typed);
      opts.onDone(isNaN(v) ? null : Units.into(v));
      pop();
    }

    push(function () {
      var display = typed === '' ? '0' : typed;
      var num = parseFloat(typed);
      var warn = '';
      if (typed !== '' && !isNaN(num)) {
        if (num < r.min) warn = 'That’s very low. Worth checking the meter.';
        else if (num > r.max) warn = 'That’s higher than a meter usually reads. Worth checking.';
      }

      function key(labelOrNode, onclick, aria) {
        return h('button', { type: 'button', class: 'key', 'aria-label': aria, onclick: onclick },
          typeof labelOrNode === 'string' ? labelOrNode : labelOrNode);
      }

      function digit(d) {
        return key(d, function () {
          if (typed.replace('.', '').length >= 5) return;
          if (typed === '0' && d !== '.') typed = d; else typed += d;
          refresh();
        });
      }

      var keys = h('div', { class: 'keypad' });
      ['1', '2', '3', '4', '5', '6', '7', '8', '9'].forEach(function (d) { keys.appendChild(digit(d)); });

      keys.appendChild(r.dp > 0
        ? key('.', function () {
            if (typed.indexOf('.') === -1) { typed = (typed || '0') + '.'; refresh(); }
          }, 'decimal point')
        : h('span'));

      keys.appendChild(digit('0'));
      keys.appendChild(key(icon('close'), function () {
        typed = typed.slice(0, -1);
        refresh();
      }, 'delete last digit'));

      var actions = [
        h('button', { type: 'button', class: 'btn btn-primary', text: 'Save reading', onclick: commit })
      ];

      return {
        title: opts.title || 'Blood sugar reading',
        body: [
          h('div', { class: 'pad-value' }, [
            h('div', { class: 'pad-number' + (typed === '' ? ' empty' : ''), text: display }),
            h('div', { class: 'pad-unit', text: Units.label() }),
            h('div', { class: 'pad-warn', text: warn })
          ]),
          keys,
          opts.value != null ? h('div', { style: 'text-align:center' }, [
            h('button', {
              type: 'button', class: 'link-btn', text: 'Remove this reading',
              onclick: function () { opts.onDone(null); pop(); }
            })
          ]) : null
        ],
        actions: actions
      };
    });
  }

  /* ---------------------------------------------------- confirm */

  function confirm(opts) {
    push(function () {
      return {
        title: opts.title,
        body: h('p', { class: 'prose', text: opts.message }),
        actions: [
          h('button', { type: 'button', class: 'btn btn-quiet', text: 'Cancel', onclick: pop }),
          h('button', {
            type: 'button',
            class: 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary'),
            text: opts.confirmLabel || 'Confirm',
            onclick: function () { close(); opts.onConfirm(); }
          })
        ]
      };
    });
  }

  function emptyState(iconName, title, text) {
    return h('div', { class: 'empty-state' }, [
      icon(iconName),
      h('h3', { text: title }),
      h('p', { text: text })
    ]);
  }

  return {
    h: h, clear: clear, append: append, icon: icon, toast: toast,
    push: push, pop: pop, close: close, refresh: refresh,
    chips: chips, field: field, readingButton: readingButton, timeInput: timeInput,
    pad: pad, confirm: confirm, emptyState: emptyState
  };
})();
