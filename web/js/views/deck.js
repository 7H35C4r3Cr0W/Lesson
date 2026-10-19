// One deck: choose to look through the cards or play the practice round.
// A story level (deck.passage) adds 📖 Read, the Read screen, in front of those.

import { h } from '../dom.js';
import { canQuiz, deckProgress, levelPath, needToPass } from '../logic.js';
import * as store from '../store.js';
import * as speech from '../speech.js';
import { go, starRow, tap, topBar } from '../ui.js';

export function mount(root, scope, deckId) {
  const deck = store.state.deckById.get(deckId);
  if (!deck) return go('/');
  const sub = store.subjectById(deck.subject) || {};
  const hidden = store.hiddenCards();
  const level = levelPath(store.decksOf(deck.subject), store.state.stats, store.levelOpts())
    .find((l) => l.deck.id === deck.id);
  // A locked level cannot be opened by typing its address either.
  if (level && !level.unlocked) return go(`/subject/${deck.subject}`);
  const p = deckProgress(deck, store.state.stats, hidden);
  const story = !!(deck.passage && deck.passage.text);          // any kind of deck can carry a story
  const reads = story ? store.state.reads[deck.id] : null;      // { count, scored, best, ... } or undefined
  const book = deck.book || null;
  // What this level takes: a round's worth of questions with 85% of them right.
  const roundSize = Math.min(store.prefs().sessionSize, deck.cards.filter((c) => canQuiz(c, deck) && !hidden.has(c.id)).length);
  let goal = '';
  if (level && level.passed) goal = '⭐⭐⭐ Passed!';
  else if (deck.quiz === false) goal = 'Flip and sort every card to open the next level';
  else if (roundSize) goal = `${story ? (deck.kind === 'read' ? 'Read the words, then get' : 'Read the story, then get') : 'Get'} ${needToPass(roundSize)} of ${roundSize} right for 3 stars`;
  const byLine = book ? [book.author ? `By ${book.author}` : '', book.source || ''].filter(Boolean).join(' · ') : '';

  root.append(h('section', { class: 'screen deck', style: { '--c': sub.color, '--t': sub.tint } },
    topBar(scope, { back: `/subject/${deck.subject}`, title: sub.title || '', emoji: sub.emoji || '' }),
    h('div', { class: 'deck-hero' },
      h('div', { class: 'hero-emoji' }, deck.emoji || sub.emoji),
      level ? h('div', { class: 'hero-level' }, `Level ${level.index + 1}`) : null,
      h('h2', { class: 'hero-title' }, deck.title),
      starRow(level ? level.stars : 0),
      goal ? h('div', { class: 'hero-goal' }, goal) : null,
      h('div', { class: 'hero-actions' },
        story
          ? h('button', { class: 'btn primary big', type: 'button', onclick: tap(() => go(`/read/${deck.id}`)) },
            h('span', { class: 'btn-emoji' }, '📖'), 'Read')
          : null,
        h('button', { class: 'btn big', type: 'button', onclick: tap(() => go(`/cards/${deck.id}`)) },
          h('span', { class: 'btn-emoji' }, '👀'), 'Look'),
        deck.quiz === false ? null
          : h('button', { class: `btn big${story ? '' : ' primary'}`, type: 'button', onclick: tap(() => go(`/practice/deck/${deck.id}`)) },
            h('span', { class: 'btn-emoji' }, '🎯'), 'Play')),
      // Small print for the grown-up sitting alongside.
      h('div', { class: 'grownup-note' },
        h('p', null, deck.about || ''),
        deck.tip ? h('p', null, h('strong', null, 'Tip: '), deck.tip) : null,
        byLine ? h('p', { class: 'fine' }, byLine) : null,
        book && book.blurb ? h('p', { class: 'fine' }, book.blurb) : null,
        book && book.borrow ? h('p', { class: 'fine' }, h('a', { href: book.borrow, target: '_blank', rel: 'noopener' }, 'Borrow it from the library')) : null,
        story && Array.isArray(deck.passage.focus) && deck.passage.focus.length
          ? h('p', { class: 'fine' }, `Sounds: ${deck.passage.focus.join(', ')}`) : null,
        story && Array.isArray(deck.passage.tricky) && deck.passage.tricky.length
          ? h('p', { class: 'fine' }, `Tricky words: ${deck.passage.tricky.join(', ')}`) : null,
        h('p', { class: 'fine' }, `${p.total} cards · ${p.mastered} mastered`,
          level && level.round ? ` · best round ${Math.floor(level.round.best * 100 + 1e-9)}%` : '',
          reads && reads.count ? ` · read ${reads.count} time${reads.count === 1 ? '' : 's'}` : '',
          reads && reads.best != null ? ` · best ${reads.best} words a minute` : '',
          (deck.standards || []).length ? ` · NC ${deck.standards.join(', ')}` : ''))))
  );
  speech.speakExtra(deck.sayTitle || deck.title);
}
