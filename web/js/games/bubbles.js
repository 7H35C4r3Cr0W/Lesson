// Bubble Pop: big see-through bubbles drift slowly around; pop the one holding
// the right answer. A wrong bubble just goes dim and keeps floating, nothing
// bursts in anger. Plain DOM (absolutely positioned divs moved with transforms),
// one rAF loop with delta time, no assets.

import { h, reducedMotion } from '../dom.js';
import { choiceButtons, missLadder, promptFace } from './engine.js';

export const meta = { id: 'bubbles', title: 'Bubble Pop', emoji: '🔵' };

const SPEED = 30;             // drift speed in px / s (never above 40)
const MIN_SIZE = 130;         // smallest bubble, px across
const MAX_SIZE = 230;
const FLOOR = 0.9;            // bubbles stay out of the bottom 10% of the area
const SPARKS = 8;
const TINTS = [
  ['rgba(120, 180, 255, 0.55)', 'rgba(80, 140, 230, 0.78)'],    // blue
  ['rgba(255, 150, 200, 0.5)', 'rgba(230, 100, 170, 0.72)'],    // pink
  ['rgba(130, 230, 190, 0.5)', 'rgba(60, 190, 140, 0.72)'],     // mint
  ['rgba(190, 160, 255, 0.5)', 'rgba(150, 110, 230, 0.72)'],    // lilac
  ['rgba(255, 200, 130, 0.5)', 'rgba(240, 150, 70, 0.72)'],     // peach
];

export function start(game) {
  const stage = game.stage;
  const promptBox = h('div', { class: 'game-prompt' });
  const area = h('div', { class: 'bubble-area', 'aria-hidden': 'true' });
  const fallback = h('div', { class: 'game-fallback' });
  stage.append(promptBox, area, fallback);

  let W = 600, H = 400;
  let q = null;
  let bubbles = [];             // { text, x, y, vx, vy, r, state, el }
  let buttons = [];
  let misses = 0;
  let locked = true;
  let still = false;            // prefers-reduced-motion: bubbles do not drift
  let last = 0;
  let raf = 0;
  let finished = false;

  // ---- layout

  // Bubbles are positioned inside the area's border (its padding box), so measure
  // that box, not the border box, or the right/bottom edge would be clipped.
  function layout() {
    W = Math.max(200, area.clientWidth);
    H = Math.max(150, area.clientHeight);
    bubbles.forEach(clampInto);
  }

  function clampInto(b) {
    const maxX = Math.max(b.r, W - b.r);
    const maxY = Math.max(b.r, H * FLOOR - b.r);
    if (b.x < b.r) { b.x = b.r; b.vx = Math.abs(b.vx); }
    if (b.x > maxX) { b.x = maxX; b.vx = -Math.abs(b.vx); }
    if (b.y < b.r) { b.y = b.r; b.vy = Math.abs(b.vy); }
    if (b.y > maxY) { b.y = maxY; b.vy = -Math.abs(b.vy); }
  }

  function bubbleSize(n) {
    const byWidth = (W - 24) / n - 14;
    const byHeight = H * FLOOR * 0.55;
    return Math.round(Math.max(MIN_SIZE, Math.min(MAX_SIZE, byWidth, byHeight)));
  }

  // Shrink the label until it sits comfortably inside the bubble.
  function fitText(span, size) {
    const single = !/\s/.test(span.textContent);
    const maxW = (size - 8) * 0.84;          // matches .bubble-text max-width inside the 4px border
    const maxH = size * 0.72;
    const fits = () => span.scrollWidth <= maxW && span.scrollHeight <= maxH;
    const shrink = (from) => {
      let fs = from;
      span.style.fontSize = `${fs}px`;
      while (fs > 16 && !fits()) {
        fs -= 2;
        span.style.fontSize = `${fs}px`;
      }
    };
    span.style.whiteSpace = single ? 'nowrap' : 'normal';
    shrink(Math.round(size * (single ? 0.36 : 0.26)));
    if (single && !fits()) {
      // A very long word in a small bubble: let it break across lines rather than spill out.
      span.style.whiteSpace = 'normal';
      shrink(Math.round(size * 0.26));
    }
  }

  // ---- questions

  function ask() {
    q = game.next();
    if (!q) {
      finished = true;
      cancelAnimationFrame(raf);
      return game.finish();
    }
    misses = 0;
    locked = true;
    still = reducedMotion();
    while (promptBox.firstChild) promptBox.removeChild(promptBox.firstChild);
    while (area.firstChild) area.removeChild(area.firstChild);
    while (fallback.firstChild) fallback.removeChild(fallback.firstChild);
    if (q.listen) {
      const btn = h('button', { class: 'listen listen-big small', type: 'button', 'aria-label': 'Hear the word' }, '🔊');
      btn.addEventListener('click', () => game.hear(q, false));
      promptBox.append(btn, ...promptFace(q));      // the word is shown AND said: a silent tablet must never hide it
    } else {
      promptBox.append(...promptFace(q),            // the drawing or picture clue, then the question
        h('button', { class: 'round speaker', type: 'button', 'aria-label': 'Hear it again', onclick: () => game.hear(q) }, '🔊'));
    }
    const made = choiceButtons(q, (choice) => choose(choice), { sizeClass: 'size-sm' });
    buttons = made.buttons;
    fallback.append(made.el);
    layout();                 // measure only once the prompt and the button row are in place
    spawn();
    game.hear(q);
    game.wait(350).then(() => { locked = false; });
  }

  // One bubble per choice, spread across the width in thirds (or halves) and
  // zig-zagged up and down so they never start on top of each other.
  function spawn() {
    const n = q.choices.length;
    const size = bubbleSize(n);
    const r = size / 2;
    const slotW = W / n;
    const usable = H * FLOOR;
    const bands = [0.34, 0.62, 0.42];
    bubbles = q.choices.map((text, i) => {
      const [tint, edge] = TINTS[(i + q.index) % TINTS.length];
      const span = h('span', { class: 'bubble-text' }, text);
      const el = h('div', { class: 'bubble', style: { width: `${size}px`, height: `${size}px`, '--tint': tint, '--tint-edge': edge } },
        h('div', { class: 'bubble-skin' }, span));
      const angle = Math.random() * Math.PI * 2;
      const speed = still ? 0 : SPEED * (0.8 + Math.random() * 0.4);
      const b = {
        text, r, el,
        x: slotW * i + slotW / 2,
        y: usable * bands[i % bands.length],
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        state: 'up',
      };
      clampInto(b);
      return b;
    });
    area.append(...bubbles.map((b) => b.el));
    bubbles.forEach((b) => fitText(b.el.firstChild.firstChild, size));
    for (let k = 0; k < 16; k++) {
      collide();
      bubbles.forEach(clampInto);
    }
    render();
  }

  // ---- answering

  const tappable = (b) => b.state === 'up' || b.state === 'glow';

  function choose(text) {
    if (locked || !q) return;
    const b = bubbles.find((x) => x.text === text && tappable(x));
    if (!b) return;
    if (text === q.answer) game.sfx('pop');           // the pop, then the engine's 'right'
    const correct = game.answer(q, text);
    const btn = buttons.find((x) => x.textContent === text);
    if (correct) {
      locked = true;
      b.state = 'popped';
      b.el.classList.add('pop');
      burst(b);
      bubbles.forEach((o) => {
        if (o !== b && o.state !== 'gone') {
          o.state = 'away';
          o.el.classList.add('away');
        }
      });
      buttons.forEach((x) => { x.disabled = true; });
      if (btn) btn.classList.add('right');
      game.wait(450).then(() => {
        if (!game.alive()) return;
        b.state = 'gone';
        b.el.classList.add('gone');
      });
      game.wait(800).then(() => {
        if (!game.alive()) return;
        bubbles.forEach((o) => {
          if (o.state === 'away') { o.state = 'gone'; o.el.classList.add('gone'); }
        });
      });
      game.wait(1200).then(() => game.alive() && ask());
      return;
    }
    misses += 1;
    b.state = 'dim';
    b.el.classList.add('dim');
    let revealed;
    if (btn) {
      revealed = missLadder(q, buttons, btn, misses, game);
    } else {
      // Same ladder as the engine's, should the button row ever be missing.
      revealed = misses >= 2 || bubbles.filter(tappable).length <= 1;
      if (revealed) game.say(`It's ${q.sayAnswer}. Tap it!`);
      else game.hear(q, false);
    }
    if (revealed) glowRight();
  }

  // Second miss: the right bubble turns green and holds still so the child can finish.
  function glowRight() {
    const right = bubbles.find((x) => x.text === q.answer && x.state !== 'gone');
    if (!right) return;
    right.state = 'glow';
    right.vx = 0;
    right.vy = 0;
    right.el.classList.remove('dim');
    right.el.classList.add('glow');
  }

  // A ring of sparkles flying out from the popped bubble.
  function burst(b) {
    const sparks = [];
    for (let i = 0; i < SPARKS; i++) {
      const a = (i / SPARKS) * Math.PI * 2 + 0.3;
      const d = b.r + 50 + Math.random() * 30;
      sparks.push(h('span', { class: 'bubble-spark', style: {
        left: `${b.x - 16}px`, top: `${b.y - 16}px`, '--dx': `${Math.cos(a) * d}px`, '--dy': `${Math.sin(a) * d}px`,
      } }, '✨'));
    }
    area.append(...sparks);
    game.wait(800).then(() => {
      if (!game.alive()) return;
      sparks.forEach((s) => s.remove());
    });
  }

  // ---- motion

  const drifts = (b) => b.state === 'up' || b.state === 'dim';
  const solid = (b) => drifts(b) || b.state === 'glow';

  // Gentle bubble-on-bubble bounce; a glowing bubble is a rock the others bounce off.
  function collide() {
    for (let i = 0; i < bubbles.length; i++) {
      for (let j = i + 1; j < bubbles.length; j++) {
        const a = bubbles[i], b = bubbles[j];
        if (!solid(a) || !solid(b)) continue;
        const am = drifts(a), bm = drifts(b);
        if (!am && !bm) continue;
        let dx = b.x - a.x, dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d < 0.001) { dx = 1; dy = 0; d = 1; }
        const min = a.r + b.r + 4;
        if (d >= min) continue;
        const nx = dx / d, ny = dy / d;
        const push = min - d;
        if (am && bm) {
          a.x -= nx * push / 2; a.y -= ny * push / 2;
          b.x += nx * push / 2; b.y += ny * push / 2;
        } else if (am) {
          a.x -= nx * push; a.y -= ny * push;
        } else {
          b.x += nx * push; b.y += ny * push;
        }
        if (am) {
          const va = a.vx * nx + a.vy * ny;
          if (va > 0) { a.vx -= 2 * va * nx; a.vy -= 2 * va * ny; }
        }
        if (bm) {
          const vb = b.vx * nx + b.vy * ny;
          if (vb < 0) { b.vx -= 2 * vb * nx; b.vy -= 2 * vb * ny; }
        }
      }
    }
  }

  function step(dt) {
    for (const b of bubbles) {
      if (b.state === 'away') {
        if (!still) b.y -= 70 * dt;          // float up and out while fading
        continue;
      }
      if (!drifts(b)) continue;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      clampInto(b);
    }
    collide();
    bubbles.forEach((b) => { if (drifts(b)) clampInto(b); });
  }

  function render() {
    for (const b of bubbles) {
      if (b.state === 'gone') continue;
      b.el.style.transform = `translate3d(${Math.round(b.x - b.r)}px, ${Math.round(b.y - b.r)}px, 0)`;
    }
  }

  // ---- input: one tap anywhere on a bubble pops it (hit-tested as a circle)

  area.addEventListener('pointerdown', (e) => {
    if (locked || !q) return;
    const rect = area.getBoundingClientRect();
    const px = e.clientX - rect.left - area.clientLeft, py = e.clientY - rect.top - area.clientTop;
    let best = null, bestD = Infinity;
    for (const b of bubbles) {
      if (!tappable(b)) continue;
      const d = Math.hypot(px - b.x, py - b.y);
      if (d < b.r + 12 && d < bestD) { best = b; bestD = d; }
    }
    if (!best) return;
    e.preventDefault();
    choose(best.text);
  });

  // ---- loop

  function frame(ts) {
    if (finished || !game.alive()) return;
    const dt = Math.min(0.05, (ts - last) / 1000 || 0.016);
    last = ts;
    step(dt);
    render();
    raf = requestAnimationFrame(frame);
  }

  // A rotate (or any big size change) re-places the bubbles in thirds at a size
  // that fits the new area, keeping which ones are dim or glowing. Small changes,
  // and anything mid-pop or in the first instant of a question, just clamp.
  const onResize = () => {
    const oldW = W, oldH = H;
    layout();
    if (!q || locked || !bubbles.length) return;
    if (Math.abs(W - oldW) < 40 && Math.abs(H - oldH) < 40) return;
    const states = new Map(bubbles.map((b) => [b.text, b.state]));
    bubbles.forEach((b) => b.el.remove());
    spawn();
    bubbles.forEach((b) => {
      const state = states.get(b.text);
      if (state === 'dim') { b.state = 'dim'; b.el.classList.add('dim'); }
      if (state === 'glow') { b.state = 'glow'; b.vx = 0; b.vy = 0; b.el.classList.add('glow'); }
    });
    render();
  };
  window.addEventListener('resize', onResize);
  game.scope.add(() => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', onResize);
  });

  ask();
  raf = requestAnimationFrame(frame);
}
