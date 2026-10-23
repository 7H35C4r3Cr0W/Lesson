// Rocket Launch: a rocket waits on its pad beside a fuel gauge with one segment
// per question. Every right answer pours in a segment of fuel (🔥 whoosh, pop)
// and the rocket rumbles a little more. When the round is done the gauge is
// full: 3, 2, 1 and the rocket lifts off in a trail of smoke and stars.
// Pure DOM and CSS, no canvas, tap only.

import { h, clear } from '../dom.js';
import { choiceButtons, missLadder, promptFace } from './engine.js';

export const meta = { id: 'rocket', title: 'Rocket Launch', emoji: '🚀' };

const PUFFS = ['💨', '☁️', '💨', '☁️', '💨'];
const STAR_COUNT = 14;
const MAX_SHAKE = 4;           // px of rumble when the gauge is full
const FLAME_MIN = 0.55;        // flame scale with an empty gauge
const FLAME_FULL = 1.25;       // flame scale with a full gauge
const FLAME_LAUNCH = 2.1;      // flame scale during lift-off
const BUMP_MS = 480;           // length of the rocket-bump animation in app.css

// Narrower column than the quiz screen, so one size down from ui.js's sizeClass().
function sizeFor(choices) {
  const longest = choices.reduce((a, b) => (Array.from(b).length > Array.from(a).length ? b : a), '');
  const n = Array.from(longest).length;
  if (n <= 4) return 'size-lg';
  if (n <= 8) return 'size-md';
  if (n <= 16) return 'size-sm';
  return 'size-xs';
}

export function start(game) {
  const total = Math.max(1, game.items.length);

  // ---- build the scene
  const prompt = h('div', { class: 'game-prompt' });
  const rocket = h('span', { class: 'rocket', 'aria-hidden': 'true' }, '🚀');
  const flame = h('span', { class: 'rocket-flame', 'aria-hidden': 'true' }, '🔥');
  const lift = h('div', { class: 'rocket-lift' }, rocket, flame);
  const base = h('div', { class: 'rocket-base', 'aria-hidden': 'true' });
  const pad = h('div', { class: 'rocket-pad' }, lift, base);

  const segs = Array.from({ length: total }, () =>
    h('span', { class: 'fuel-seg' }, h('span', { class: 'fuel-fire', 'aria-hidden': 'true' }, '🔥')));
  const gauge = h('div', { class: 'fuel-gauge', role: 'img', 'aria-label': 'Fuel gauge' },
    h('span', { class: 'fuel-cap', 'aria-hidden': 'true' }, '⛽'),
    h('div', { class: 'fuel-tube' }, segs));

  const choiceBox = h('div', { class: 'rocket-choices' });
  const stars = h('div', { class: 'rocket-stars', 'aria-hidden': 'true' });
  const count = h('div', { class: 'rocket-count', 'aria-live': 'polite' });
  const body = h('div', { class: 'rocket-body' }, stars, pad, gauge, choiceBox, count);
  const scene = h('div', { class: 'rocket-scene' }, prompt, body);
  game.stage.append(scene);

  let q = null;
  let misses = 0;
  let locked = true;
  let buttons = [];
  let fuel = 0;

  setFuelLook(0);

  // ---- fuel

  function setFuelLook(level) {
    const f = Math.min(1, level / total);
    rocket.style.setProperty('--shake', `${(f * MAX_SHAKE).toFixed(2)}px`);
    flame.style.setProperty('--flame', String((FLAME_MIN + f * (FLAME_FULL - FLAME_MIN)).toFixed(3)));
  }

  function addFuel() {
    if (fuel >= total) return;
    const seg = segs[fuel];
    fuel += 1;
    seg.classList.add('lit');
    setFuelLook(fuel);
    game.sfx('pop');
    // a quick hop and a puff at the engine so the whoosh reads as "fuel went in"
    rocket.classList.remove('bump');
    void rocket.offsetWidth;                  // restart the animation if it is still running
    rocket.classList.add('bump');
    game.wait(BUMP_MS).then(() => game.alive() && rocket.classList.remove('bump'));   // back to rumbling
    const puff = spawnPuff();
    puff.classList.add('fuel-puff');
  }

  function spawnPuff() {
    const puff = h('span', { class: 'rocket-puff', 'aria-hidden': 'true' }, PUFFS[Math.floor(Math.random() * PUFFS.length)]);
    puff.style.left = `${35 + Math.random() * 30}%`;
    puff.style.fontSize = `${26 + Math.random() * 22}px`;
    lift.append(puff);
    game.wait(1000).then(() => game.alive() && puff.remove());
    return puff;
  }

  // ---- questions

  function ask() {
    q = game.next();
    if (!q) return liftoff();
    misses = 0;
    locked = true;
    clear(prompt);
    clear(choiceBox);
    if (q.listen) {
      const btn = h('button', { class: 'listen listen-big small', type: 'button', 'aria-label': 'Hear the word' }, '🔊');
      btn.addEventListener('click', () => game.hear(q, false));
      prompt.append(btn, ...promptFace(q));      // the word is shown AND said: a silent tablet must never hide it
    } else {
      prompt.append(...promptFace(q),            // the drawing or picture clue, then the question
        h('button', { class: 'round speaker', type: 'button', 'aria-label': 'Hear it again', onclick: () => game.hear(q) }, '🔊'));
    }
    const built = choiceButtons(q, pick, { sizeClass: sizeFor(q.choices) });
    buttons = built.buttons;
    choiceBox.append(built.el);
    game.hear(q);
    game.wait(350).then(() => { locked = false; });
  }

  function pick(choice, btn) {
    if (locked || btn.disabled) return;
    const correct = game.answer(q, choice);
    if (correct) {
      locked = true;
      btn.classList.remove('reveal');
      btn.classList.add('right');
      buttons.forEach((b) => { b.disabled = true; });
      addFuel();
      game.wait(1100).then(() => game.alive() && ask());
      return;
    }
    misses += 1;
    missLadder(q, buttons, btn, misses, game);
  }

  // ---- lift-off

  // Say something and hold the beat for at least `minMs`, even when speech is off
  // or finishes quickly, so the countdown keeps a steady rhythm.
  async function sayFor(text, minMs) {
    const t0 = performance.now();
    await game.sayExtra(text);        // the countdown is celebration, not help
    const left = minMs - (performance.now() - t0);
    if (left > 0) await game.wait(left);
  }

  function showCount(text) {
    clear(count);
    count.append(h('span', { class: 'rocket-count-num' }, text));
  }

  async function smokeTrail() {
    for (let i = 0; i < 26; i++) {
      await game.wait(80);
      if (!game.alive()) return;
      spawnPuff();
    }
  }

  function sprinkleStars() {
    for (let i = 0; i < STAR_COUNT; i++) {
      const star = h('span', { class: 'rocket-star' }, i % 4 === 0 ? '🌟' : '⭐');
      star.style.left = `${4 + Math.random() * 92}%`;
      star.style.top = `${2 + Math.random() * 62}%`;
      star.style.fontSize = `${22 + Math.random() * 30}px`;
      star.style.animationDelay = `${(Math.random() * 0.6).toFixed(2)}s`;
      stars.append(star);
    }
  }

  async function liftoff() {
    locked = true;
    clear(choiceBox);
    clear(prompt);
    prompt.append(h('span', { class: 'game-prompt-text' }, 'Fuel is full! Get ready…'));
    segs.forEach((s) => s.classList.add('lit'));     // the gauge is always full at the end
    setFuelLook(total);
    rocket.style.setProperty('--shake', `${MAX_SHAKE + 2}px`);   // straining at the pad
    scene.classList.add('ready');
    await game.wait(500);
    if (!game.alive()) return;

    for (const n of ['3', '2', '1']) {
      showCount(n);
      game.sfx('tap');
      await sayFor(n, 900);
      if (!game.alive()) return;
    }

    showCount('🚀');
    clear(prompt);
    prompt.append(h('span', { class: 'game-prompt-text' }, 'Blast off!'));
    game.sayExtra('Blast off!');
    scene.classList.add('launching');
    lift.classList.add('go');
    flame.style.setProperty('--flame', String(FLAME_LAUNCH));
    game.sfx('whoosh');
    smokeTrail();
    game.wait(1100).then(() => {
      if (!game.alive()) return;
      game.sfx('win');
      sprinkleStars();
      clear(count);
    });
    await game.wait(2600);
    if (!game.alive()) return;
    game.finish();
  }

  ask();
}
