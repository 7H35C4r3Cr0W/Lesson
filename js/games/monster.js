// Feed the Monster: a hungry monster asks for one answer; tap the right snack
// and it flies into its mouth. Wrong snacks get spat back out, no harm done.

import { h } from '../dom.js';
import { missLadder } from './engine.js';

export const meta = { id: 'monster', title: 'Feed the Monster', emoji: '👾' };

const MONSTERS = ['👾', '🐲', '🦖', '🐙', '🦁', '🐸'];
const SNACKS = ['🍎', '🍕', '🍪', '🍌', '🧁', '🍉', '🥕', '🍇'];

export function start(game) {
  const monster = h('div', { class: 'monster', 'aria-hidden': 'true' }, MONSTERS[Math.floor(Math.random() * MONSTERS.length)]);
  const bubble = h('div', { class: 'monster-bubble' });
  const prompt = h('div', { class: 'game-prompt' });
  const plates = h('div', { class: 'plates' });
  const scene = h('div', { class: 'monster-scene' }, h('div', { class: 'monster-wrap' }, bubble, monster), prompt, plates);
  game.stage.append(scene);

  let q = null;
  let misses = 0;
  let locked = true;
  let buttons = [];

  function ask() {
    q = game.next();
    if (!q) return game.finish();
    misses = 0;
    locked = true;
    monster.className = 'monster';
    while (prompt.firstChild) prompt.removeChild(prompt.firstChild);
    while (plates.firstChild) plates.removeChild(plates.firstChild);
    bubble.textContent = q.listen ? 'I want the word you hear!' : 'Feed me the answer!';
    if (q.listen) {
      const btn = h('button', { class: 'listen listen-big small', type: 'button', 'aria-label': 'Hear the word' }, '🔊');
      btn.addEventListener('click', () => game.hear(q, false));
      prompt.append(btn);
    } else {
      prompt.append(h('span', { class: 'game-prompt-text' }, q.prompt),
        h('button', { class: 'round speaker', type: 'button', 'aria-label': 'Hear it again', onclick: () => game.hear(q) }, '🔊'));
    }
    buttons = q.choices.map((choice, i) => {
      const btn = h('button', { class: 'plate', type: 'button' },
        h('span', { class: 'plate-snack', 'aria-hidden': 'true' }, SNACKS[(i + q.index) % SNACKS.length]),
        h('span', { class: 'plate-text' }, choice));
      btn.addEventListener('click', () => pick(choice, btn));
      return btn;
    });
    plates.append(...buttons);
    game.hear(q);
    game.wait(350).then(() => { locked = false; });
  }

  function pick(choice, btn) {
    if (locked) return;
    const correct = game.answer(q, choice);
    if (correct) {
      locked = true;
      // Fly the plate into the mouth.
      const from = btn.getBoundingClientRect();
      const to = monster.getBoundingClientRect();
      btn.style.transition = 'transform 0.55s cubic-bezier(0.4, 0, 0.6, 1), opacity 0.2s 0.45s';
      btn.style.transform = `translate(${to.left + to.width / 2 - (from.left + from.width / 2)}px, ${to.top + to.height / 2 - (from.top + from.height / 2)}px) scale(0.3)`;
      btn.style.opacity = '0';
      game.wait(520).then(() => {
        if (!game.alive()) return;
        monster.classList.add('chomp');
        game.sfx('munch');
        bubble.textContent = ['Yum!', 'Delicious!', 'More please!', 'Mmm!'][Math.floor(Math.random() * 4)];
      });
      game.wait(1400).then(() => game.alive() && ask());
      return;
    }
    misses += 1;
    monster.classList.add('yuck');
    bubble.textContent = 'Yuck! Not that one.';
    game.wait(500).then(() => monster.classList.remove('yuck'));
    missLadder(q, buttons, btn, misses, game);
  }

  ask();
}
