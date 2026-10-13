// The child's home screen: the subjects as big buttons, each showing how far
// along its path he is, then games, stickers, and the quick practice buttons.

import { h } from '../dom.js';
import { canQuiz, dayString, dayStreak, levelPath } from '../logic.js';
import * as store from '../store.js';
import { dialog, go, icon, meter, starCounter, tap } from '../ui.js';

const AVATARS = ['🦊', '🐶', '🐱', '🐼', '🐯', '🦁', '🐸', '🐵', '🦄', '🐲', '🦖', '🐙', '🦉', '🐧', '🚀', '⚽'];

function pickAvatar() {
  const box = dialog({
    title: 'Pick your buddy',
    body: h('div', { class: 'avatar-grid' }, AVATARS.map((emoji) =>
      h('button', { class: 'avatar-choice', type: 'button', 'aria-label': 'Choose this one', onclick: () => {
        store.setAvatar(emoji).catch(() => {});
        box.close();
      } }, emoji))),
    actions: [],
  });
}

export function mount(root, scope) {
  const { state } = store;
  const profile = state.profile;
  const again = store.troubleList().filter((t) => canQuiz(t.card, t.deck));
  const streak = dayStreak(state.days, dayString(new Date()));

  const avatar = h('button', { class: 'avatar', type: 'button', 'aria-label': 'Change your buddy', onclick: tap(pickAvatar) },
    profile.avatar);
  scope.add(store.subscribe((what) => {
    if (what === 'profile') avatar.textContent = store.state.profile.avatar;
  }));

  const tiles = state.subjects.map((sub) => {
    const decks = store.decksOf(sub.id);
    if (!decks.length) return null;
    const levels = levelPath(decks, state.stats, store.levelOpts());
    const done = levels.filter((l) => l.passed).length;
    const current = levels.find((l) => l.current);
    return h('button', { class: `tile subject-tile${done === levels.length ? ' all-done' : ''}`, type: 'button',
      style: { '--c': sub.color, '--t': sub.tint }, 'aria-label': `${sub.title}, level ${current ? current.index + 1 : 1} of ${levels.length}`,
      onclick: tap(() => go(`/subject/${sub.id}`)) },
    h('span', { class: 'tile-emoji' }, sub.emoji),
    h('span', { class: 'tile-title' }, sub.title),
    h('span', { class: 'tile-level' }, done === levels.length ? '🏆 All done!' : `Level ${current ? current.index + 1 : 1} of ${levels.length}`),
    meter(done, levels.length));
  });

  root.append(h('section', { class: 'screen home' },
    h('header', { class: 'home-head' },
      avatar,
      h('div', { class: 'hello' },
        h('div', { class: 'hello-name' }, profile.name ? `Hi, ${profile.name}!` : 'Hi!'),
        streak >= 2 ? h('div', { class: 'hello-streak' }, `🔥 ${streak} days in a row`) : null),
      starCounter(scope)),
    h('div', { class: 'scroll' },
      state.tests.map((test) =>
        h('button', { class: 'banner', type: 'button', onclick: tap(() => go(`/test/${test.id}`)) },
          h('span', { class: 'banner-emoji' }, '📝'),
          h('span', { class: 'banner-text' }, h('strong', null, 'Test time!'), h('span', null, test.title)),
          icon('next'))),
      h('div', { class: 'tiles subjects' }, tiles),
      h('div', { class: 'tiles extras' },
        h('button', { class: 'tile wide games', type: 'button', onclick: tap(() => go('/games')) },
          h('span', { class: 'tile-emoji' }, '🎮'), h('span', { class: 'tile-title' }, 'Games')),
        h('button', { class: 'tile wide book', type: 'button', onclick: tap(() => go('/stickers')) },
          h('span', { class: 'tile-emoji' }, '📒'), h('span', { class: 'tile-title' }, 'Stickers'))),
      h('div', { class: 'quick' },
        h('button', { class: 'quick-btn today', type: 'button', onclick: tap(() => go('/practice/today')) },
          h('span', { class: 'quick-emoji' }, '☀️'), h('span', null, 'Mix it up')),
        again.length
          ? h('button', { class: 'quick-btn again', type: 'button', onclick: tap(() => go('/practice/again')) },
            h('span', { class: 'quick-emoji' }, '🔁'), h('span', null, 'Try again'),
            h('span', { class: 'pill' }, String(again.length)))
          : null),
      h('div', { class: 'foot-links' },
        h('button', { class: 'grownups-link', type: 'button', onclick: tap(() => go('/grownups'), null) },
          icon('lock'), 'Grown-ups'),
        h('button', { class: 'grownups-link', type: 'button', onclick: tap(() => go('/lessons'), null) },
          h('span', { 'aria-hidden': 'true' }, '📋'), 'Lesson plans')))));
}
