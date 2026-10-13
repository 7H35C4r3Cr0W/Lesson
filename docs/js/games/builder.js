// Word Builder: the child hears a word and builds it from letter tiles, one
// sound at a time. A right tile flies into its slot; a wrong tile only wobbles
// and dims for a moment, and after two misses in a row the next right tile
// glows. Reading cards only, single words (sentences are skipped).

import { h, clear, once, reducedMotion } from '../dom.js';

export const meta = { id: 'builder', title: 'Word Builder', emoji: '🧱' };

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
const TEAMS = ['sh', 'ch', 'th'];
const MIRRORS = { b: 'd', d: 'b', p: 'q', q: 'p' };   // a letter's mirror twin is never offered as a distractor
const EXTRA = 2;                                       // distractor tiles per word
const MAX_SKIPS = 10;                                  // sentences we may pass over before giving up
const ONE_ROW = 6;                                     // more tiles than this wrap to two rows
const FLIGHT = 300;                                    // ms for a tile to fly into its slot

function shuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// The tiles a word is built from: its sound-spellings when the card has them
// (and they really spell the word), otherwise one tile per letter.
function partsOf(card) {
  const text = String(card.text || '').trim();
  if (Array.isArray(card.parts) && card.parts.length && card.parts.join('') === text) return card.parts.slice();
  return Array.from(text);
}

// Two tiles that do not belong: letters or letter teams sharing no letter with the word.
function extrasFor(parts) {
  const taken = new Set(parts.join('').toLowerCase().split(''));
  for (const ch of Array.from(taken)) if (MIRRORS[ch]) taken.add(MIRRORS[ch]);
  const pool = LETTERS.concat(TEAMS).filter((t) => !t.split('').some((ch) => taken.has(ch)));
  return shuffle(pool).slice(0, EXTRA);
}

// Single words only: a sentence has far too many tiles for one screen.
function fits(q) {
  const text = String(q.card.text || '').trim();
  return text.length > 0 && !/\s/.test(text);
}

export function start(game) {
  const prompt = h('div', { class: 'game-prompt' });
  const slots = h('div', { class: 'builder-slots', role: 'group', 'aria-label': 'Your word so far' });
  const undo = h('button', { class: 'round builder-undo', type: 'button', 'aria-label': 'Take back the last tile' }, '⌫');
  const cheer = h('div', { class: 'builder-cheer', 'aria-live': 'polite' });
  const tiles = h('div', { class: 'builder-tiles' });
  const scene = h('div', { class: 'builder-scene' },
    prompt,
    h('div', { class: 'builder-word' }, slots, undo),
    cheer,
    tiles);
  game.stage.append(scene);

  let q = null;
  let parts = [];        // the word's tiles, in order
  let placed = [];       // tile buttons placed so far, in order (a stack)
  let slotEls = [];
  let tileEls = [];
  let wrongTaps = 0;     // misses on this word; more than one = "built with help"
  let wrongStreak = 0;   // misses in a row; two light up the next right tile
  let locked = true;
  let built = false;     // complete() has run for this word (guards a double landing)
  let skips = 0;
  let seq = 0;           // stamps each flight / dim so a stale timer never touches a re-used tile
  let confettiLayer = null;

  // ---- questions

  function ask() {
    q = game.next();
    while (q && !fits(q) && skips < MAX_SKIPS) {
      skips += 1;
      q = game.next();
    }
    if (!q || !fits(q)) return game.finish();
    parts = partsOf(q.card);
    placed = [];
    wrongTaps = 0;
    wrongStreak = 0;
    locked = true;
    built = false;
    clear(prompt);
    clear(slots);
    clear(tiles);
    clear(cheer);
    cheer.classList.remove('show');
    slots.classList.remove('done');
    undo.disabled = true;

    if (q.listen) {
      const btn = h('button', { class: 'listen listen-big small', type: 'button', 'aria-label': 'Hear the word' }, '🔊');
      btn.addEventListener('click', () => game.hear(q, false));
      // The word is shown as well as said: a tablet that stays silent (mute switch, no voice)
      // must never leave the child guessing what to build.
      prompt.append(btn, h('span', { class: 'game-prompt-text' }, q.prompt));
    } else {
      prompt.append(h('span', { class: 'game-prompt-text' }, q.prompt),
        h('button', { class: 'round speaker', type: 'button', 'aria-label': 'Hear it again', onclick: () => game.hear(q) }, '🔊'));
    }

    slotEls = parts.map(() => h('span', { class: 'builder-slot' }));
    slots.append(...slotEls);

    const all = shuffle(parts.concat(extrasFor(parts)));
    const cols = all.length > ONE_ROW ? Math.ceil(all.length / 2) : all.length;
    tiles.style.setProperty('--cols', String(cols));
    tileEls = all.map((text) => {
      const btn = h('button', { class: `builder-tile${text.length > 2 ? ' long' : ''}`, type: 'button' }, text);
      btn.addEventListener('click', () => pick(btn));
      return btn;
    });
    tiles.append(...tileEls);

    game.hear(q);
    game.wait(350).then(() => { locked = false; });
  }

  // ---- tiles

  function pick(btn) {
    if (locked || built || btn.classList.contains('used') || btn.classList.contains('flying')) return;
    if (placed.length >= parts.length) return;  // every slot is claimed, the last tile is still in the air
    if (btn.textContent === parts[placed.length]) {
      place(btn);
      return;
    }
    if (btn.classList.contains('wrong')) {      // already told once; a re-tap is not a second miss
      game.sfx('pop');
      return;
    }
    // Not this one: a wobble, a soft sound, and the word once more.
    wrongTaps += 1;
    wrongStreak += 1;
    game.sfx('oops');
    btn.classList.add('wrong');
    const stamp = String(++seq);
    btn.dataset.dim = stamp;
    game.wait(1000).then(() => {
      if (game.alive() && btn.dataset.dim === stamp) btn.classList.remove('wrong');
    });
    refreshHint();
    game.hear(q, false);
  }

  function place(btn) {
    wrongStreak = 0;
    game.sfx('tap');
    tileEls.forEach((b) => b.classList.remove('wrong'));   // a new letter is wanted now, so nothing stays dimmed
    btn.classList.remove('back');                           // a pop-in still running would hide the flight
    const slot = slotEls[placed.length];
    placed.push(btn);
    undo.disabled = false;
    refreshHint();
    const flight = reducedMotion() ? 0 : FLIGHT;
    if (flight) {
      const from = btn.getBoundingClientRect();
      const to = slot.getBoundingClientRect();
      btn.classList.add('flying');
      btn.style.transform = `translate(${to.left + to.width / 2 - (from.left + from.width / 2)}px, ${to.top + to.height / 2 - (from.top + from.height / 2)}px)`;
    }
    const stamp = String(++seq);
    btn.dataset.flight = stamp;
    game.wait(flight).then(() => {
      if (!game.alive() || btn.dataset.flight !== stamp) return;   // gone, or taken back and re-placed since
      const i = placed.indexOf(btn);
      if (i < 0) return;                        // taken back mid-flight
      slotEls[i].textContent = btn.textContent;
      slotEls[i].classList.add('filled');
      btn.classList.remove('flying');
      btn.classList.add('used');
      btn.style.transform = '';
      if (!built && placed.length === parts.length && placed.every((b) => b.classList.contains('used'))) complete();
    });
  }

  const takeBack = once(() => {
    if (locked || built || !placed.length) return;
    const btn = placed.pop();
    btn.dataset.flight = '';                    // a flight still in the air lands nowhere
    const slot = slotEls[placed.length];
    slot.textContent = '';
    slot.classList.remove('filled');
    btn.classList.remove('used', 'flying');
    btn.style.transform = '';
    btn.classList.add('back');
    game.wait(320).then(() => { if (game.alive()) btn.classList.remove('back'); });
    game.sfx('flip');
    undo.disabled = !placed.length;
    refreshHint();
  });
  undo.addEventListener('click', takeBack);

  // After two misses in a row the next right tile glows until it is tapped.
  function refreshHint() {
    tileEls.forEach((b) => b.classList.remove('hint'));
    if (locked || wrongStreak < 2 || placed.length >= parts.length) return;
    const want = parts[placed.length];
    const next = tileEls.find((b) => b.textContent === want && !b.classList.contains('used') && !placed.includes(b));
    if (next) next.classList.add('hint');
  }

  // ---- the word is built

  async function complete() {
    if (built) return;
    built = true;
    locked = true;
    undo.disabled = true;
    refreshHint();
    slots.classList.add('done');
    cheer.textContent = 'You built it!';
    cheer.classList.add('show');
    // One miss is still a win; more than that records as built-with-help, but the child
    // only ever hears a cheer (silent: no 'oops' from the engine on the soft miss).
    game.answer(q, wrongTaps <= 1 ? q.answer : 'built with help', { silent: true });
    game.sfx('win');
    stars();
    const started = Date.now();
    await Promise.race([
      game.say(q.sayAnswer).then((ok) => (ok && game.alive() ? game.sayExtra('You built it!') : false)),
      game.wait(3000),
    ]);
    if (!game.alive()) return;
    await game.wait(Math.max(0, 1500 - (Date.now() - started)));
    if (!game.alive()) return;
    ask();
  }

  function stars() {
    if (reducedMotion()) return;
    if (confettiLayer) confettiLayer.remove();
    const layer = h('div', { class: 'confetti', 'aria-hidden': 'true' });
    for (let i = 0; i < 24; i++) {
      layer.append(h('span', { style: {
        left: `${Math.random() * 100}%`,
        animationDelay: `${Math.random() * 0.4}s`,
        animationDuration: `${1.4 + Math.random() * 1.2}s`,
        fontSize: `${24 + Math.random() * 28}px`,
      } }, '⭐'));
    }
    document.body.append(layer);
    confettiLayer = layer;
    setTimeout(() => layer.remove(), 3000);
  }

  game.scope.add(() => { if (confettiLayer) confettiLayer.remove(); });

  ask();
}
