// The sticker book. Stickers come from stars, and stars come from right answers,
// so the only way to fill the book is to practise. Nothing here is random.

import { h } from '../dom.js';
import { starsForSticker, stickersEarned } from '../logic.js';
import { state } from '../store.js';
import * as speech from '../speech.js';
import { meter, topBar } from '../ui.js';

// Order matters: sticker n is always the same sticker. Only emoji old enough for any iPad that runs this app.
export const STICKERS = [
  '🐶', '🐱', '🦊', '🐼', '🐸', '🦁', '🐯', '🐵', '🐧', '🦄',
  '🐢', '🐙', '🦋', '🐝', '🐬', '🦖', '🦕', '🐳', '🦉', '🦈',
  '🚀', '🚂', '🚒', '🚜', '🚁', '⛵', '🏎️', '🚲', '🛸', '🎈',
  '⚽', '🏀', '⚾', '🎸', '🥁', '🎨', '🧩', '🪁', '🎯', '🏆',
  '🍎', '🍓', '🍉', '🍕', '🍦', '🍩', '🧁', '🍪', '🌮', '🍿',
  '🌈', '🌻', '🌵', '🍄', '⛄', '🌙', '🪐', '🌋', '💎', '👑',
];

export function mount(root, scope) {
  const earned = stickersEarned(state.stars, STICKERS.length);
  const done = earned >= STICKERS.length;
  const floor = earned ? starsForSticker(earned) : 0;
  const goal = done ? floor : starsForSticker(earned + 1);
  const left = Math.max(0, goal - state.stars);

  root.append(h('section', { class: 'screen stickers' },
    topBar(scope, { back: '/', backIcon: 'home', backLabel: 'Home', title: 'My stickers', emoji: '📒', right: null }),
    h('div', { class: 'scroll' },
      h('div', { class: 'sticker-next' },
        h('div', { class: 'sticker-next-text' },
          h('strong', null, `⭐ ${state.stars}`),
          done ? ' You have every sticker!' : ` ${left} more for the next sticker`),
        done ? null : meter(state.stars - floor, goal - floor)),
      h('div', { class: 'sticker-grid' }, STICKERS.map((emoji, i) =>
        h('div', { class: `sticker ${i < earned ? 'have' : 'locked'}`, 'aria-label': i < earned ? 'sticker' : 'locked sticker' },
          i < earned ? emoji : '?')))))
  );
  speech.speakExtra(done ? 'You have every sticker!' : `${left} more stars for your next sticker.`);
}
