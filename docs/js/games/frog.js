// Frog Hop: a frog sits on a number line of lily pads, 0 to 20. Tap the answer
// and the frog hops there one pad at a time, so every sum is also a count. For
// math cards only. The pads are scenery: the big buttons are the only tap
// targets, so nothing needs aiming. A subtraction starts the frog on the first
// number and hops it backwards.

import { h } from '../dom.js';
import { choiceButtons, missLadder } from './engine.js';

export const meta = { id: 'frog', title: 'Frog Hop', emoji: '🐸' };

const LAST_PAD = 20;           // pads 0..20
const HOP_MS = 220;            // one hop per pad
const MIN_PAD = 56;            // never squeeze a pad narrower than this in one-row mode
const PAD_GAP = 6;             // keep in step with .frog-pond { gap } in app.css
const POND_PAD_X = 28;         // left + right padding of .frog-pond

export function start(game) {
  const prompt = h('div', { class: 'game-prompt' });
  const pads = [];
  for (let n = 0; n <= LAST_PAD; n++) {
    pads.push(h('div', { class: n === 11 ? 'lily row2-first' : 'lily' }, String(n)));
  }
  const frogFace = h('span', { class: 'frog-face' }, '🐸');
  const frogHop = h('div', { class: 'frog-hop' }, frogFace);
  const frog = h('div', { class: 'frog' }, frogHop);
  const pond = h('div', { class: 'frog-pond', 'aria-hidden': 'true' }, pads, frog);
  const choicesBox = h('div', { class: 'frog-choices' });
  game.stage.append(h('div', { class: 'frog-scene' }, prompt, pond, choicesBox));

  let q = null;
  let misses = 0;
  let locked = true;
  let buttons = [];
  let at = 0;                  // the pad the frog is sitting on
  let target = null;           // the pad to hop to, or null when the answer is not a number 0..20

  // ---- the number line

  // One row of 21 pads when they fit at MIN_PAD each, otherwise 0-10 over 11-20.
  function layout() {
    const inner = pond.clientWidth - POND_PAD_X;
    const oneRow = inner >= (LAST_PAD + 1) * MIN_PAD + LAST_PAD * PAD_GAP;
    pond.classList.toggle('two-rows', !oneRow);
    placeFrog(at, false);
  }

  // Centre of a pad, in the pond's padding box (where the frog's left/top live).
  function padCenter(n) {
    const pr = pond.getBoundingClientRect();
    const r = pads[n].getBoundingClientRect();
    return {
      x: r.left - pr.left - pond.clientLeft + r.width / 2,
      y: r.top - pr.top - pond.clientTop + r.height / 2,
    };
  }

  // Restart the little arc animation (remove, reflow, add).
  function bounce() {
    frogHop.classList.remove('hopping');
    void frogHop.offsetWidth;
    frogHop.classList.add('hopping');
  }

  function placeFrog(n, animate) {
    const { x, y } = padCenter(n);
    if (!animate) {
      frog.classList.add('no-anim');
      frog.style.transform = `translate(${x}px, ${y}px)`;
      void frog.offsetWidth;                 // land the move before the transition comes back
      frog.classList.remove('no-anim');
      return;
    }
    frog.style.transform = `translate(${x}px, ${y}px)`;
    bounce();
  }

  // Hop pad by pad to n: a pop and a lit pad on each landing (the last landing
  // gets the 'right' sound instead). false when the screen went away mid-hop.
  async function hopTo(n) {
    const dir = n > at ? 1 : -1;
    while (at !== n) {
      at += dir;
      placeFrog(at, true);
      await game.wait(HOP_MS);
      if (!game.alive()) return false;
      pads[at].classList.add('lit');
      if (at !== n) game.sfx('pop');
    }
    return true;
  }

  function shake() {
    frogFace.classList.remove('shake');
    void frogFace.offsetWidth;
    frogFace.classList.add('shake');
    game.wait(500).then(() => { if (game.alive()) frogFace.classList.remove('shake'); });
  }

  function splash() {
    const { x, y } = padCenter(at);
    const drops = ['d1', 'd2', 'd3', 'd4'].map((k) => {
      const d = h('span', { class: `frog-drop ${k}`, 'aria-hidden': 'true' }, '💧');
      d.style.left = `${x}px`;
      d.style.top = `${y}px`;
      return d;
    });
    pond.append(...drops);
    game.wait(900).then(() => { if (game.alive()) drops.forEach((d) => d.remove()); });
  }

  // ---- reading the card

  // "7" -> 7 when it is a whole number on the line; anything else -> null.
  function padOf(text) {
    const t = String(text == null ? '' : text).trim();
    if (!/^\d+$/.test(t)) return null;
    const n = Number(t);
    return n <= LAST_PAD ? n : null;
  }

  // "10 − 6 = ?" (or "10 - 6"): start on 10 and hop backwards. Everything else starts on 0.
  function startPad(question) {
    const m = /^\s*(\d+)\s*[−–-]\s*\d/.exec(question.prompt);
    if (!m) return 0;
    const a = Number(m[1]);
    return a <= LAST_PAD ? a : 0;
  }

  // ---- questions

  function ask() {
    q = game.next();
    if (!q) return game.finish();
    misses = 0;
    locked = true;
    target = padOf(q.answer);
    at = target == null ? 0 : startPad(q);
    pads.forEach((p) => p.classList.remove('here', 'lit', 'goal'));
    pads[at].classList.add('here');
    while (prompt.firstChild) prompt.removeChild(prompt.firstChild);
    while (choicesBox.firstChild) choicesBox.removeChild(choicesBox.firstChild);
    if (q.listen) {
      const btn = h('button', { class: 'listen listen-big small', type: 'button', 'aria-label': 'Hear the word' }, '🔊');
      btn.addEventListener('click', () => game.hear(q, false));
      prompt.append(btn, h('span', { class: 'game-prompt-text' }, 'Find the word you hear!'));
    } else {
      prompt.append(h('span', { class: 'game-prompt-text' }, q.prompt),
        h('button', { class: 'round speaker', type: 'button', 'aria-label': 'Hear it again', onclick: () => game.hear(q) }, '🔊'));
    }
    const made = choiceButtons(q, pick, { sizeClass: 'size-lg' });
    buttons = made.buttons;
    choicesBox.append(made.el);
    layout();                                // rows for this width, frog on its start pad
    game.hear(q);
    game.wait(350).then(() => { locked = false; });
  }

  function pick(choice, btn) {
    if (locked) return;
    // A right hop plays its sound on landing (celebrate), so keep the engine quiet for it.
    const correct = game.answer(q, choice, { silent: choice === q.answer });
    if (!correct) {
      misses += 1;
      shake();
      missLadder(q, buttons, btn, misses, game);
      return;
    }
    locked = true;
    btn.classList.remove('reveal');
    btn.classList.add('right');
    buttons.forEach((b) => { b.disabled = true; });
    celebrate();
  }

  async function celebrate() {
    if (target != null && target !== at) {
      const ok = await hopTo(target);
      if (!ok) return;
      game.sfx('right');
    } else {
      // Already there (7 − 0), or the answer is not on the line: a happy jump in place.
      bounce();
      await game.wait(HOP_MS);
      if (!game.alive()) return;
      game.sfx('star');
    }
    if (target != null) pads[at].classList.add('goal');
    splash();
    await game.wait(1100);
    if (!game.alive()) return;
    ask();
  }

  // Re-lay the pads and re-seat the frog when the screen turns or the pond
  // changes size for any other reason (a ResizeObserver catches the cases a
  // window resize event misses, such as the prompt box growing).
  const onResize = () => { if (game.alive()) layout(); };
  window.addEventListener('resize', onResize);
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null;
  if (observer) observer.observe(pond);
  game.scope.add(() => {
    window.removeEventListener('resize', onResize);
    if (observer) observer.disconnect();
  });

  ask();
}
