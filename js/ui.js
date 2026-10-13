// Shared screen pieces: the top bar, icons, card faces, celebration, dialogs.

import { h, s, once, reducedMotion } from './dom.js';
import { state, subscribe } from './store.js';
import * as speech from './speech.js';
import * as sfx from './sfx.js';
import { renderVisual } from './visuals.js';

export function go(path) {
  location.hash = `#${path}`;
}

// ---- icons -----------------------------------------------------------------

const ICONS = {
  back: ['M15 5l-7 7 7 7'],
  next: ['M9 5l7 7-7 7'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  redo: ['M19 6v5h-5', 'M19 11a7.5 7.5 0 1 0-1.2 6.5'],
  speaker: ['M4 9.5h3.5L12 5.5v13l-4.5-4H4z', 'M15.5 9a4.2 4.2 0 0 1 0 6', 'M18 6.5a7.6 7.6 0 0 1 0 11'],
  home: ['M4 11.5L12 5l8 6.5', 'M6.5 10v9h11v-9'],
  lock: ['M7 11V8a5 5 0 0 1 10 0v3', 'M5.5 11h13v9h-13z'],
  flag: ['M6 21V4', 'M6 5h11l-2.5 4 2.5 4H6'],
  plus: ['M12 5v14', 'M5 12h14'],
  trash: ['M5 7h14', 'M9 7V4.5h6V7', 'M7 7l1 13h8l1-13'],
  play: ['M8 5.5v13l11-6.5z'],
};

export function icon(name, cls = '') {
  return s('svg', { viewBox: '0 0 24 24', class: `icon ${cls}`, 'aria-hidden': 'true', fill: 'none',
    stroke: 'currentColor', 'stroke-width': 2.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
  ICONS[name].map((d) => s('path', { d })));
}

// ---- sound helpers ---------------------------------------------------------

// Every tap handler on a kid screen goes through this once, so the first touch wakes up audio on iOS.
export function wake() {
  speech.unlock();
  sfx.unlock();
}

export function tap(fn, sound = 'tap') {
  return once((event) => {
    wake();
    if (sound) sfx.play(sound);
    fn(event);
  });
}

export function speakerButton(getText, { cls = '', label = 'Hear it' } = {}) {
  const btn = h('button', { class: `round speaker ${cls}`, type: 'button', 'aria-label': label }, icon('speaker'));
  btn.addEventListener('click', () => {
    wake();
    btn.classList.add('speaking');
    speech.speak(typeof getText === 'function' ? getText() : getText).then(() => btn.classList.remove('speaking'));
  });
  return btn;
}

// ---- top bar ---------------------------------------------------------------

// scope.add(fn) registers clean-up for when the screen goes away.
export function starCounter(scope, { link = true } = {}) {
  const count = h('span', { class: 'star-num' }, String(state.stars));
  const el = h(link ? 'button' : 'div', { class: 'star-count', type: link ? 'button' : null,
    'aria-label': `${state.stars} stars. Open sticker book` }, h('span', { class: 'star-icon' }, '⭐'), count);
  if (link) el.addEventListener('click', tap(() => go('/stickers')));
  let shown = state.stars;
  scope.add(subscribe(() => {
    if (state.stars === shown) return;
    shown = state.stars;
    count.textContent = String(shown);
    el.classList.remove('bump');
    void el.offsetWidth;      // restart the CSS animation
    el.classList.add('bump');
  }));
  return el;
}

export function topBar(scope, { back = null, title = '', emoji = '', right = undefined, backIcon = 'back',
  backLabel = 'Back' } = {}) {
  const left = back == null
    ? h('span', { class: 'bar-spacer' })
    : h('button', { class: 'round', type: 'button', 'aria-label': backLabel,
      onclick: tap(() => (typeof back === 'function' ? back() : go(back))) }, icon(backIcon));
  return h('header', { class: 'bar' },
    left,
    h('h1', { class: 'bar-title' }, emoji ? h('span', { class: 'bar-emoji' }, emoji) : null, title),
    right === undefined ? starCounter(scope) : right || h('span', { class: 'bar-spacer' }));
}

// ---- card faces ------------------------------------------------------------

export function sizeClass(text) {
  const n = Array.from(String(text)).length;
  if (n <= 4) return 'size-xl';
  if (n <= 8) return 'size-lg';
  if (n <= 16) return 'size-md';
  if (n <= 40) return 'size-sm';
  return 'size-xs';
}

// A word with its sounds marked: a dot under each single-letter sound, a line
// under letter teams, and the tricky part (if any) in a different colour.
export function wordWithSounds(card) {
  if (!Array.isArray(card.parts) || card.parts.join('') !== card.text) {
    return h('span', { class: 'word' }, card.text);
  }
  const tricky = new Set(card.tricky || []);
  return h('span', { class: 'word sounded' }, card.parts.map((part, i) =>
    h('span', { class: `part${part.length > 1 ? ' team' : ''}${tricky.has(i) ? ' tricky' : ''}` }, part)));
}

// The front of a flashcard.
export function frontFace(card, deck) {
  if (deck.kind === 'read') {
    return h('div', { class: `face-text ${sizeClass(card.text)}` }, wordWithSounds(card));
  }
  return h('div', { class: 'face-qa' },
    card.emoji ? h('div', { class: 'face-emoji' }, card.emoji) : null,
    renderVisual(card.visual),
    h('div', { class: `face-text ${sizeClass(card.q)}` }, card.q));
}

// The back of a flashcard: the picture or the answer.
export function backFace(card, deck) {
  if (deck.kind === 'read') {
    return h('div', { class: 'face-qa' },
      card.emoji ? h('div', { class: 'face-emoji' }, card.emoji) : null,
      h('div', { class: `face-text ${sizeClass(card.text)}` }, wordWithSounds(card)),
      card.note ? h('div', { class: 'face-note' }, card.note) : null);
  }
  return h('div', { class: 'face-qa' },
    h('div', { class: `face-text answer ${sizeClass(card.a)}` }, card.a),
    card.note ? h('div', { class: 'face-note' }, card.note) : null);
}

export function starRow(n, max = 3) {
  return h('span', { class: 'stars', 'aria-label': `${n} of ${max} stars` },
    Array.from({ length: max }, (_, i) => h('span', { class: i < n ? 'on' : 'off' }, '★')));
}

export function meter(value, total) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  return h('div', { class: 'meter', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 },
    h('div', { class: 'meter-fill', style: { width: `${pct}%` } }));
}

// ---- celebration -----------------------------------------------------------

export function confetti(pieces = ['⭐', '🌟', '✨', '🎉', '💛'], count = 26) {
  if (reducedMotion()) return;
  const layer = h('div', { class: 'confetti', 'aria-hidden': 'true' });
  for (let i = 0; i < count; i++) {
    layer.append(h('span', { style: {
      left: `${Math.random() * 100}%`,
      animationDelay: `${Math.random() * 0.5}s`,
      animationDuration: `${1.6 + Math.random() * 1.4}s`,
      fontSize: `${22 + Math.random() * 26}px`,
    } }, pieces[i % pieces.length]));
  }
  document.body.append(layer);
  setTimeout(() => layer.remove(), 3600);
}

// ---- dialogs (grown-up screens) --------------------------------------------

export function dialog({ title, body, actions }) {
  const close = () => overlay.remove();
  const panel = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('h2', null, title),
    h('div', { class: 'dialog-body' }, body),
    h('div', { class: 'dialog-actions' }, actions.map((a) =>
      h('button', { class: `btn ${a.kind || ''}`, type: 'button', onclick: () => {
        if (a.run && a.run() === false) return;
        close();
      } }, a.label))));
  const overlay = h('div', { class: 'overlay', onclick: (e) => {
    if (e.target === overlay) close();
  } }, panel);
  document.body.append(overlay);
  return { close, panel };
}

export function confirmDialog(title, message, yesLabel, onYes, danger = false) {
  return dialog({
    title,
    body: h('p', null, message),
    actions: [{ label: 'Cancel' }, { label: yesLabel, kind: danger ? 'danger' : 'primary', run: onYes }],
  });
}

let toastTimer = null;
export function toast(message) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = h('div', { class: 'toast', role: 'status' });
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ---- small formatters ------------------------------------------------------

export function pct(part, whole) {
  return whole ? `${Math.round((part / whole) * 100)}%` : '–';
}

export function shortDate(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function dateTime(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function duration(ms) {
  if (!ms || ms < 0) return '–';
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`;
}
