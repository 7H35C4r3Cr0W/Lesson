// Mystery Picture: a big friendly emoji hides behind nine coloured tiles. Every
// right answer flips one tile away, in a random order, until the picture shows.
// Calm on purpose: no clock, no lives, a miss just fades the wrong button and
// replays the prompt; the picture is always revealed at the end of the round.

import { h } from '../dom.js';
import { choiceButtons, missLadder, promptFace } from './engine.js';

export const meta = { id: 'mystery', title: 'Mystery Picture', emoji: '🖼️' };

// The hidden pictures. `art` is the article to say in front of the name.
const PICTURES = [
  { emoji: '🦄', name: 'unicorn' },
  { emoji: '🐳', name: 'whale' },
  { emoji: '🚀', name: 'rocket' },
  { emoji: '🏰', name: 'castle' },
  { emoji: '🌈', name: 'rainbow' },
  { emoji: '🦖', name: 'dinosaur' },
  { emoji: '🎠', name: 'merry-go-round' },
  { emoji: '🐼', name: 'panda' },
  { emoji: '🍉', name: 'watermelon' },
  { emoji: '⛵', name: 'sailboat' },
  { emoji: '🐙', name: 'octopus', art: 'an' },
  { emoji: '🦋', name: 'butterfly' },
  { emoji: '🐢', name: 'turtle' },
  { emoji: '🧸', name: 'teddy bear' },
  { emoji: '🌻', name: 'sunflower' },
  { emoji: '🐧', name: 'penguin' },
  { emoji: '🚂', name: 'train' },
  { emoji: '🦊', name: 'fox' },
  { emoji: '🍦', name: 'ice cream', art: 'an' },
  { emoji: '🐸', name: 'frog' },
];

// Tile colours, shuffled each round so the grid never looks the same twice.
const TILE_COLOURS = ['#ff8fab', '#ffb347', '#ffe066', '#8fd694', '#7cc6fe', '#b39ddb', '#ff9e80', '#80deea', '#f6a5c0'];
const SPARKS = ['✨', '⭐', '🌟', '💫'];
const TILES = 9;

let lastPicture = -1;        // avoid showing the same picture two rounds running

function shuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function pickPicture() {
  let i = Math.floor(Math.random() * PICTURES.length);
  if (PICTURES.length > 1 && i === lastPicture) i = (i + 1) % PICTURES.length;
  lastPicture = i;
  return PICTURES[i];
}

// Same thresholds as the quiz's size classes, keyed on the longest choice so
// all the buttons in one question match.
function sizeFor(choices) {
  const n = Math.max(...choices.map((c) => Array.from(String(c)).length));
  if (n <= 4) return 'size-xl';
  if (n <= 8) return 'size-lg';
  if (n <= 16) return 'size-md';
  if (n <= 40) return 'size-sm';
  return 'size-xs';
}

export function start(game) {
  const picture = pickPicture();
  const prompt = h('div', { class: 'game-prompt' });
  const pic = h('div', { class: 'mystery-pic', 'aria-hidden': 'true' }, picture.emoji);
  const grid = h('div', { class: 'mystery-grid', 'aria-hidden': 'true' });
  const frame = h('div', { class: 'mystery-frame', role: 'img', 'aria-label': 'A hidden picture' }, pic, grid);
  const scene = h('div', { class: 'mystery-scene' }, frame);
  const choiceBox = h('div', { class: 'mystery-choices' });
  game.stage.append(prompt, scene, choiceBox);

  // Nine covered cells; `order` is the sequence they flip away in.
  const colours = shuffle(TILE_COLOURS);
  const cells = [];
  const tiles = [];
  for (let i = 0; i < TILES; i++) {
    const tile = h('div', { class: 'mystery-tile', style: { background: colours[i] } }, h('span', { class: 'mystery-q' }, '?'));
    const cell = h('div', { class: 'mystery-cell' }, tile);
    tiles.push(tile);
    cells.push(cell);
    grid.append(cell);
  }
  const order = shuffle(cells.map((_, i) => i));
  let removed = 0;

  let q = null;
  let misses = 0;
  let locked = true;
  let buttons = [];

  // The frame is a square that fits whatever room is left between the prompt
  // and the buttons, never so small that the tiles turn into slivers.
  function layout() {
    const rect = scene.getBoundingClientRect();
    const room = Math.min(rect.width, rect.height) - 8;
    const size = Math.max(240, Math.min(420, room || 420));
    frame.style.setProperty('--mystery-size', `${Math.round(size)}px`);
  }

  function sparkle(cell, x, y, delay = 0) {
    const spark = h('span', { class: 'mystery-spark', 'aria-hidden': 'true',
      style: { left: `${x}%`, top: `${y}%`, animationDelay: `${delay}ms` } },
    SPARKS[Math.floor(Math.random() * SPARKS.length)]);
    cell.append(spark);
    game.wait(1000 + delay).then(() => { if (spark.parentNode) spark.parentNode.removeChild(spark); });
  }

  function flipTile(index, delay = 0) {
    const tile = tiles[index];
    if (tile.classList.contains('gone')) return;
    // Two values: one per transitioned property (transform, then opacity).
    tile.style.transitionDelay = delay ? `${delay}ms, ${delay + 200}ms` : '';
    tile.classList.add('gone');
    sparkle(cells[index], 50, 50, delay);
  }

  // One tile goes for each right answer, in the shuffled order.
  function uncoverOne() {
    if (removed >= order.length) return;
    flipTile(order[removed]);
    removed += 1;
    game.wait(180).then(() => game.alive() && game.sfx('star'));
  }

  function ask() {
    q = game.next();
    if (!q) return finale();
    misses = 0;
    locked = true;
    while (prompt.firstChild) prompt.removeChild(prompt.firstChild);
    while (choiceBox.firstChild) choiceBox.removeChild(choiceBox.firstChild);
    if (q.listen) {
      const btn = h('button', { class: 'listen listen-big small', type: 'button', 'aria-label': 'Hear the word' }, '🔊');
      btn.addEventListener('click', () => game.hear(q, false));
      prompt.append(btn, ...promptFace(q));      // the word is shown AND said: a silent tablet must never hide it
    } else {
      prompt.append(...promptFace(q),            // the drawing or picture clue, then the question
        h('button', { class: 'round speaker', type: 'button', 'aria-label': 'Hear it again', onclick: () => game.hear(q) }, '🔊'));
    }
    const size = sizeFor(q.choices);
    const built = choiceButtons(q, pick, { sizeClass: size });
    built.el.classList.add(size);
    buttons = built.buttons;
    choiceBox.append(built.el);
    layout();
    game.hear(q);
    game.wait(350).then(() => { locked = false; });
  }

  function pick(choice, btn) {
    if (locked) return;
    const correct = game.answer(q, choice);
    if (correct) {
      locked = true;
      btn.classList.remove('reveal');
      btn.classList.add('right');
      buttons.forEach((b) => { b.disabled = true; });
      uncoverOne();
      game.wait(1100).then(() => game.alive() && ask());
      return;
    }
    misses += 1;
    missLadder(q, buttons, btn, misses, game);
  }

  // Round over: whatever is still covered flips away, the picture pops, and
  // we say what it was before handing over to the stars screen.
  async function finale() {
    locked = true;
    while (prompt.firstChild) prompt.removeChild(prompt.firstChild);
    while (choiceBox.firstChild) choiceBox.removeChild(choiceBox.firstChild);
    const art = picture.art || 'a';
    const line = `It's ${art} ${picture.name}!`;
    prompt.append(h('span', { class: 'game-prompt-text' }, line));

    let delay = 0;
    for (let i = removed; i < order.length; i++) {
      flipTile(order[i], delay);
      delay += 90;
    }
    removed = order.length;
    await game.wait(delay + 250);
    if (!game.alive()) return;

    frame.classList.add('revealed');
    pic.classList.add('show');
    game.sfx('win');
    for (let i = 0; i < 10; i++) {
      sparkle(frame, -8 + Math.random() * 116, -8 + Math.random() * 116, i * 70);
    }
    await Promise.all([game.sayExtra(line), game.wait(1600)]);
    if (!game.alive()) return;
    game.finish();
  }

  const onResize = () => layout();
  window.addEventListener('resize', onResize);
  game.scope.add(() => window.removeEventListener('resize', onResize));

  layout();
  ask();
}
