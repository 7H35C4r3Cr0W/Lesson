// One deck: choose to look through the cards or play the practice round.
// A story level (deck.passage) adds 📖 Read, the Read screen, in front of those, and the
// bookmark row (three reads earn it). A deck that stands for a real book (deck.book) adds
// "We read this book" to the grown-up note: a tick per child, saved on the Pi.

import { h } from '../dom.js';
import { canQuiz, deckProgress, levelPath, needToPass } from '../logic.js';
import * as store from '../store.js';
import * as speech from '../speech.js';
import { go, shortDate, starRow, tap, toast, topBar } from '../ui.js';
import { readDots } from './reader.js';

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

  // "We read this book": bound to state.books[deck.id] ({ read, at }); the tick goes to the Pi at
  // once (store.setBookRead is optimistic) and comes back if the Pi refuses it.
  function bookRow() {
    if (!book) return null;
    const canSet = typeof store.setBookRead === 'function';
    const box = h('input', { type: 'checkbox', class: 'switch', disabled: !canSet, 'aria-label': 'We read this book' });
    const date = h('span', { class: 'book-read-date' });
    const paint = () => {
      const entry = (store.state.books || {})[deck.id];
      box.checked = !!(entry && entry.read !== false);
      date.textContent = entry && entry.at ? `(read on ${shortDate(entry.at)})` : '';
    };
    box.addEventListener('change', () => {
      if (!canSet) return;
      store.setBookRead(deck.id, box.checked)
        .catch((err) => {
          toast((err && err.message) || 'Could not save that');
          if (scope.alive) paint();
        });
      paint();
    });
    paint();
    scope.add(store.subscribe((what) => {
      if (what === 'books' && scope.alive) paint();
    }));
    return h('label', { class: 'book-read-row' }, box, h('span', null, 'We read this book'), date);
  }

  root.append(h('section', { class: 'screen deck', style: { '--c': sub.color, '--t': sub.tint } },
    topBar(scope, { back: `/subject/${deck.subject}`, title: sub.title || '', emoji: sub.emoji || '' }),
    h('div', { class: 'deck-hero' },
      h('div', { class: 'hero-emoji' }, deck.emoji || sub.emoji),
      level ? h('div', { class: 'hero-level' }, `Level ${level.index + 1}`) : null,
      h('h2', { class: 'hero-title' }, deck.title),
      starRow(level ? level.stars : 0),
      goal ? h('div', { class: 'hero-goal' }, goal) : null,
      story ? readDots(reads ? reads.count : 0) : null,
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
        bookRow(),
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
