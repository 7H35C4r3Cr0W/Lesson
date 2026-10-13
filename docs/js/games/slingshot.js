// Slingshot: pull the bird back and fling it at the tower holding the right
// answer. Tapping a tower also fires the bird at it, so aiming never stands
// between the child and the answer. Canvas, pointer events, no assets.

import { h } from '../dom.js';
import { choiceButtons } from './engine.js';

export const meta = { id: 'slingshot', title: 'Slingshot', emoji: '🎯', needsDrag: true };

// These three are recomputed from the live canvas size in layout(), so a full pull always
// reaches the towers whatever the screen shape. The values here are just placeholders.
let GRAVITY = 1500;            // world px / s²
let PULL_MAX = 120;            // how far the bird can be pulled back
let POWER = 9.5;               // launch speed per px of pull
const BIRDS = ['🐦', '🐤', '🦉', '🐧', '🦜'];
const WOOD = ['#d9a066', '#c98a4b', '#e0b07a'];

export function start(game) {
  const stage = game.stage;
  const canvas = h('canvas', { class: 'game-canvas', 'aria-label': 'Slingshot game. Tap a tower to fire at it.' });
  const promptBox = h('div', { class: 'game-prompt' });
  const fallback = h('div', { class: 'game-fallback' });
  stage.append(promptBox, canvas, fallback);
  const ctx = canvas.getContext('2d');

  let W = 800, H = 500, dpr = 1;
  let q = null;
  let towers = [];
  let bird = null;              // { x, y, vx, vy, state: 'rest'|'drag'|'fly', spin }
  let particles = [];
  let misses = 0;
  let locked = true;
  let last = 0;
  let raf = 0;
  let sling = { x: 0, y: 0 };
  let birdEmoji = BIRDS[Math.floor(Math.random() * BIRDS.length)];
  let clouds = [];
  let flashText = null;

  function layout() {
    // Size the backing store from the canvas's OWN flex-computed box (not the stage), so the
    // drawing is not squashed and pointer hit-testing (which uses the canvas rect) lines up.
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(280, canvas.clientWidth || stage.clientWidth || 320);
    H = Math.max(220, canvas.clientHeight || 300);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Sling a little below the middle: room above for the arc, room below to pull the bird down.
    sling = { x: Math.round(W * 0.15), y: Math.round(H * 0.55) };
    PULL_MAX = Math.round(Math.min(150, Math.max(90, H * 0.34)));
    if (!clouds.length) clouds = [0.3, 0.55, 0.8].map((f, i) => ({ x: W * f, y: 30 + i * 26, s: 0.8 + i * 0.3 }));
    placeTowers();
    // Scale gravity to the height and power to the real distance, so a full pull always
    // reaches the farthest tower (its flat range works out to ~1.7x the distance to it).
    GRAVITY = Math.round(H * 2.6);
    const reach = towers.length ? towers[towers.length - 1].x - sling.x : W * 0.7;
    POWER = Math.sqrt(1.7 * reach * GRAVITY) / PULL_MAX;
    if (bird && bird.state !== 'fly') resetBird();
  }

  function placeTowers() {
    if (!q) return;
    const n = q.choices.length;
    const slotW = (W * 0.54) / n;
    const signW = Math.min(slotW - 16, 220);
    const old = new Map(towers.map((t) => [t.text, t]));
    towers = q.choices.map((text, i) => {
      const x = W * 0.40 + slotW * i + slotW / 2;
      const blocks = 2 + ((i + q.index) % 2);               // 2 or 3 blocks: keeps the flight path clear
      const blockH = 30;
      const top = H - 40 - blocks * blockH - 66;
      // A resize (rotation) mid-question keeps ruled-out, glowing and falling towers as they were.
      const was = old.get(text);
      const same = !!(was && was.qIndex === q.index);
      return { text, x, signW, signH: 66, top, blocks, blockH, qIndex: q.index,
        state: same ? was.state : 'up', wobble: same ? was.wobble : 0, glow: same ? was.glow : false,
        pieces: same && was.pieces ? was.pieces.map((p) => ({ ...p, x: p.x + (x - was.x), y: p.y + (top - was.top) })) : null };
    });
  }

  function resetBird() {
    bird = { x: sling.x, y: sling.y, vx: 0, vy: 0, state: 'rest', spin: 0 };
  }

  // ---- questions

  function ask() {
    q = game.next();
    if (!q) {
      cancelAnimationFrame(raf);        // the loop must not run another frame over the done screen
      return game.finish();
    }
    misses = 0;
    locked = true;
    flashText = null;
    particles = [];
    while (promptBox.firstChild) promptBox.removeChild(promptBox.firstChild);
    if (q.listen) {
      const btn = h('button', { class: 'listen listen-big small', type: 'button', 'aria-label': 'Hear the word' }, '🔊');
      btn.addEventListener('click', () => game.hear(q, false));
      promptBox.append(btn, h('span', { class: 'game-prompt-text' }, q.prompt));      // the word is shown AND said: a silent tablet must never hide it
    } else {
      promptBox.append(h('span', { class: 'game-prompt-text' }, q.prompt),
        h('button', { class: 'round speaker', type: 'button', 'aria-label': 'Hear it again', onclick: () => game.hear(q) }, '🔊'));
    }
    // The button row under the canvas changes the canvas's height, so build it before measuring.
    drawFallback();
    fallback.dataset.q = String(q.index);
    layout();
    resetBird();
    game.hear(q);
    game.wait(300).then(() => { locked = false; });
  }

  function hitTower(tower) {
    if (locked || tower.state !== 'up') return;
    const correct = game.answer(q, tower.text);
    if (correct) {
      locked = true;
      tower.state = 'falling';
      tower.pieces = Array.from({ length: tower.blocks + 1 }, (_, i) => ({
        x: tower.x + (Math.random() - 0.5) * 20, y: tower.top + 70 + i * tower.blockH,
        vx: (Math.random() - 0.3) * 320, vy: -150 - Math.random() * 250, spin: (Math.random() - 0.5) * 8, a: 0,
      }));
      burst(tower.x, tower.top + 40, '#f5b942');
      flashText = { text: 'Yes!', x: tower.x, y: tower.top - 30, t: 0 };
      game.sfx('win');
      game.wait(1500).then(() => game.alive() && ask());
    } else {
      misses += 1;
      tower.wobble = 1;
      tower.state = misses >= 2 ? 'up' : 'down';
      if (misses >= 2) {
        const right = towers.find((t) => t.text === q.answer);
        right.glow = true;
        towers.forEach((t) => { if (t !== right) t.state = 'down'; });
        game.say(`It's ${q.sayAnswer}. Hit that one!`);
      } else {
        game.hear(q, false);
      }
      resetBird();
    }
  }

  function burst(x, y, color) {
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      particles.push({ x, y, vx: Math.cos(a) * (120 + Math.random() * 160), vy: Math.sin(a) * (120 + Math.random() * 160) - 80,
        life: 0.9, color });
    }
  }

  // Fire at a tower automatically (the tap alternative to dragging). It lobs the bird up
  // over every tower and drops it onto the tapped one, so even the far tower sitting behind
  // taller ones is always reachable.
  function autoFire(tower) {
    if (locked || bird.state === 'fly') return;
    const topMost = Math.min.apply(null, towers.map((t) => t.top));
    // Peak above the tallest tower, and always well above the sling: on a tall (portrait)
    // canvas the towers sit far below the sling, and a lob computed from a peak under the
    // sling flies too fast and overshoots.
    const apex = Math.min(Math.max(12, topMost - Math.round(H * 0.14)), sling.y - 60);
    const ty = tower.top + 28;
    const vUp = Math.sqrt(2 * GRAVITY * (sling.y - apex));
    const T = vUp / GRAVITY + Math.sqrt(2 * Math.max(10, ty - apex) / GRAVITY);
    bird.state = 'fly';
    bird.x = sling.x;
    bird.y = sling.y;
    bird.vx = (tower.x - sling.x) / T;
    bird.vy = -vUp;
    game.sfx('whoosh');
  }

  // ---- physics

  function step(dt) {
    towers.forEach((t) => {
      if (t.wobble > 0) t.wobble = Math.max(0, t.wobble - dt * 2.2);
      if (t.pieces) {
        t.pieces.forEach((p) => {
          p.vy += GRAVITY * dt;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.a += p.spin * dt;
          if (p.y > H - 40) { p.y = H - 40; p.vy *= -0.3; p.vx *= 0.7; }
        });
      }
    });
    particles.forEach((p) => {
      p.vy += GRAVITY * 0.6 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
    });
    particles = particles.filter((p) => p.life > 0);
    if (flashText) flashText.t += dt;

    if (bird.state !== 'fly') return;
    bird.vy += GRAVITY * dt;
    bird.x += bird.vx * dt;
    bird.y += bird.vy * dt;
    bird.spin += dt * 6;
    for (const t of towers) {
      if (t.state === 'falling') continue;
      const half = t.signW / 2;
      const bottom = H - 40;
      if (bird.x > t.x - half && bird.x < t.x + half && bird.y > t.top - 10 && bird.y < bottom) {
        if (t.state === 'down') {               // already ruled out: bounce off
          bird.vx = -Math.abs(bird.vx) * 0.3;
          bird.vy = -200;
          bird.x = t.x - half - 20;
          game.sfx('pop');
          t.wobble = 0.6;
          continue;
        }
        burst(bird.x, bird.y, '#fff');
        hitTower(t);
        if (bird.state === 'fly') resetBird();
        return;
      }
    }
    // The grass only stops the bird while it is coming DOWN. A bird launched upward from a
    // low pull must be allowed to rise, not reset on its first frame near the ground line.
    if ((bird.vy > 0 && bird.y > H - 44) || bird.x > W + 60 || bird.x < -60) {
      game.sfx('pop');
      resetBird();
    }
  }

  // ---- drawing

  const readFont = (getComputedStyle(document.body).getPropertyValue('--font-read') || 'sans-serif').trim() || 'sans-serif';
  function fitText(text, maxW, maxSize) {
    let size = maxSize;
    ctx.font = `800 ${size}px ${readFont}`;
    while (size > 14 && ctx.measureText(text).width > maxW) {
      size -= 2;
      ctx.font = `800 ${size}px ${readFont}`;
    }
    return size;
  }

  function trajectory() {
    const pts = [];
    let x = bird.x, y = bird.y;
    const dx = sling.x - bird.x, dy = sling.y - bird.y;
    let vx = dx * POWER, vy = dy * POWER;
    const dt = 1 / 30;
    for (let i = 0; i < 28; i++) {
      vy += GRAVITY * dt;
      x += vx * dt;
      y += vy * dt;
      if (y > H - 40) break;
      if (i % 2 === 0) pts.push([x, y]);
    }
    return pts;
  }

  function draw() {
    // sky and ground
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#bfe3ff');
    sky.addColorStop(1, '#eef9ff');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff';
    ctx.globalAlpha = 0.9;
    for (const c of clouds) {
      ctx.beginPath();
      ctx.arc(c.x, c.y, 22 * c.s, 0, Math.PI * 2);
      ctx.arc(c.x + 24 * c.s, c.y - 8 * c.s, 26 * c.s, 0, Math.PI * 2);
      ctx.arc(c.x + 50 * c.s, c.y, 20 * c.s, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#7ccf6a';
    ctx.fillRect(0, H - 40, W, 40);
    ctx.fillStyle = '#5fb24f';
    ctx.fillRect(0, H - 40, W, 6);

    // slingshot
    ctx.strokeStyle = '#8d5a2b';
    ctx.lineWidth = 12;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(sling.x, H - 40);
    ctx.lineTo(sling.x, sling.y + 10);
    ctx.moveTo(sling.x - 22, sling.y - 24);
    ctx.lineTo(sling.x, sling.y + 10);
    ctx.lineTo(sling.x + 22, sling.y - 24);
    ctx.stroke();
    if (bird.state === 'drag' || bird.state === 'rest') {
      ctx.strokeStyle = '#4a3220';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(sling.x - 22, sling.y - 24);
      ctx.lineTo(bird.x, bird.y);
      ctx.lineTo(sling.x + 22, sling.y - 24);
      ctx.stroke();
    }
    if (bird.state === 'drag') {
      ctx.fillStyle = 'rgba(43,45,66,0.35)';
      for (const [x, y] of trajectory()) {
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // towers
    for (const t of towers) {
      const wob = Math.sin(t.wobble * 20) * t.wobble * 8;
      if (t.state === 'falling' && t.pieces) {
        for (const p of t.pieces) {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.a);
          ctx.fillStyle = WOOD[1];
          ctx.fillRect(-t.signW / 4, -t.blockH / 2, t.signW / 2, t.blockH - 4);
          ctx.restore();
        }
        continue;
      }
      ctx.save();
      ctx.translate(t.x + wob, 0);
      ctx.globalAlpha = t.state === 'down' ? 0.35 : 1;
      for (let i = 0; i < t.blocks; i++) {
        const y = H - 40 - (i + 1) * t.blockH;
        ctx.fillStyle = WOOD[i % WOOD.length];
        roundRect(-t.signW / 2 + 10, y + 2, t.signW - 20, t.blockH - 4, 8);
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.12)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      // sign
      ctx.fillStyle = t.glow ? '#dff5ea' : '#fff';
      ctx.strokeStyle = t.glow ? '#2fae77' : '#2b2d42';
      ctx.lineWidth = t.glow ? 6 : 4;
      roundRect(-t.signW / 2, t.top, t.signW, t.signH, 18);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#2b2d42';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      fitText(t.text, t.signW - 28, 44);
      ctx.fillText(t.text, 0, t.top + t.signH / 2 + 2);
      ctx.restore();
    }

    // particles
    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // bird
    ctx.save();
    ctx.translate(bird.x, bird.y);
    if (bird.state === 'fly') ctx.rotate(Math.sin(bird.spin) * 0.3);
    ctx.font = '48px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(birdEmoji, 0, 0);
    ctx.restore();

    if (flashText) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - flashText.t / 1.4);
      ctx.fillStyle = '#1f8558';
      ctx.font = '900 44px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(flashText.text, flashText.x, flashText.y - flashText.t * 40);
      ctx.restore();
    }
  }

  function roundRect(x, y, w, hgt, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + hgt, r);
    ctx.arcTo(x + w, y + hgt, x, y + hgt, r);
    ctx.arcTo(x, y + hgt, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ---- input

  let dragging = false;
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  canvas.addEventListener('pointerdown', (e) => {
    // One finger at a time: a second finger on a tower mid-drag must not fire the bird.
    if (locked || dragging || e.isPrimary === false || bird.state === 'fly') return;
    const p = pos(e);
    const near = Math.hypot(p.x - bird.x, p.y - bird.y) < 70;
    if (near) {
      dragging = true;
      bird.state = 'drag';
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    const tower = towers.find((t) => Math.abs(p.x - t.x) < t.signW / 2 + 14 && p.y > t.top - 20 && p.y < H - 40);
    if (tower && tower.state === 'up') autoFire(tower);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const p = pos(e);
    let dx = p.x - sling.x, dy = p.y - sling.y;
    const d = Math.hypot(dx, dy);
    if (d > PULL_MAX) { dx *= PULL_MAX / d; dy *= PULL_MAX / d; }
    bird.x = sling.x + dx;
    // Never let the bird be dragged into the grass; keeps it aimable and off the ground line.
    bird.y = Math.min(sling.y + dy, H - 48);
  });
  const release = (e) => {
    if (!dragging) return;
    dragging = false;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const dx = sling.x - bird.x, dy = sling.y - bird.y;
    if (Math.hypot(dx, dy) < 18) return resetBird();
    bird.state = 'fly';
    bird.vx = dx * POWER;
    bird.vy = dy * POWER;
    game.sfx('whoosh');
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  // Big buttons under the canvas too, for a child who would rather just tap the answer.
  function drawFallback() {
    while (fallback.firstChild) fallback.removeChild(fallback.firstChild);
    if (!q) return;
    const { el } = choiceButtons(q, (choice) => {
      const tower = towers.find((t) => t.text === choice);
      if (tower) autoFire(tower);
    }, { sizeClass: 'size-sm' });
    fallback.append(el);
  }

  // ---- loop

  function frame(ts) {
    if (!game.alive()) return;
    const dt = Math.min(0.05, (ts - last) / 1000 || 0.016);
    last = ts;
    step(dt);
    draw();
    if (q && fallback.childElementCount === 0) drawFallback();
    if (q && fallback.firstChild && fallback.dataset.q !== String(q.index)) {
      fallback.dataset.q = String(q.index);
      drawFallback();
    }
    raf = requestAnimationFrame(frame);
  }

  const onResize = () => {
    layout();
    if (bird && bird.state === 'fly') resetBird();     // the towers moved; a flight aimed at the old spots is void
  };
  window.addEventListener('resize', onResize);
  game.scope.add(() => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', onResize);
  });

  resetBird();
  ask();
  raf = requestAnimationFrame(frame);
}
