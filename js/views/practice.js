// A practice round: pick the cards, run the quiz, celebrate.
//
//   #/practice/deck/<deckId>   one deck: a LEVEL. The round is scored; 85% or better passes it.
//   #/practice/testout/<deckId> TEST OUT: one round drawn from every level between the child's
//                              frontier and this (locked) level; 85% passes them all at once.
//   #/practice/today           keep going with every deck already started
//   #/practice/again           the "try again" pile (cards that need more practice)

import { h, clear } from '../dom.js';
import { PASS_MARK, canQuiz, levelPath, needToPass, pickSession, pickTestOut, roundStars, stickersEarned } from '../logic.js';
import * as store from '../store.js';
import * as sfx from '../sfx.js';
import * as speech from '../speech.js';
import { confetti, go, icon, starRow, tap, topBar } from '../ui.js';
import { runQuiz } from './quiz.js';
import { STICKERS } from './stickers.js';

// Cards for "today": everything in decks the child has started, or the very first deck on day one.
export function todayPool() {
  const hidden = store.hiddenCards();
  const decks = store.visibleDecks().filter((d) => d.quiz !== false);
  const started = decks.filter((d) => d.cards.some((c) => store.state.stats[c.id]));
  const source = started.length ? started : decks.slice(0, 1);
  return source.flatMap((deck) => deck.cards.filter((c) => canQuiz(c, deck) && !hidden.has(c.id)).map((card) => ({ card, deck })));
}

function poolFor(kind, id) {
  const hidden = store.hiddenCards();
  if (kind === 'deck') {
    const deck = store.state.deckById.get(id);
    if (!deck) return null;
    return {
      title: deck.title, emoji: deck.emoji, exit: `/deck/${deck.id}`,
      pool: deck.cards.filter((c) => canQuiz(c, deck) && !hidden.has(c.id)).map((card) => ({ card, deck })),
    };
  }
  if (kind === 'again') {
    return {
      title: 'Try again', emoji: '🔁', exit: '/',
      pool: store.troubleList().filter((t) => canQuiz(t.card, t.deck)).map(({ card, deck }) => ({ card, deck })),
    };
  }
  if (kind === 'today') return { title: 'Today', emoji: '☀️', exit: '/', pool: todayPool() };
  if (kind === 'testout') return testOutPlan(id);
  return null;
}

// Test out: every level from the first one not yet passed up to the tapped level, as one pool
// per level so the round can give each level a fair share of questions.
function testOutPlan(id) {
  const deck = store.state.deckById.get(id);
  if (!deck || !store.prefs().testOut) return null;
  const hidden = store.hiddenCards();
  const levels = levelPath(store.decksOf(deck.subject), store.state.stats, store.levelOpts());
  const target = levels.findIndex((l) => l.deck.id === deck.id);
  if (target < 0) return null;
  let from = levels.findIndex((l) => !l.passed);
  if (from < 0 || from > target) from = target;
  const span = levels.slice(from, target + 1).filter((l) => l.deck.quiz !== false && !l.passed);
  const pools = span.map((l) => ({ deck: l.deck, cards: l.deck.cards.filter((c) => canQuiz(c, l.deck) && !hidden.has(c.id)) }))
    .filter((p) => p.cards.length);
  if (!pools.length) return null;
  return {
    title: 'Test out', emoji: '⚡', exit: `/subject/${deck.subject}`,
    pool: pools.flatMap((p) => p.cards.map((card) => ({ card, deck: p.deck }))),
    testOut: { pools, target: deck, first: span[0].index + 1, last: span[span.length - 1].index + 1 },
  };
}

export function mount(root, scope, kind, id) {
  const plan = poolFor(kind, id);
  if (!plan || !plan.pool.length) {
    root.append(h('section', { class: 'screen' }, topBar(scope, { back: '/', backIcon: 'home', backLabel: 'Home' }),
      h('div', { class: 'empty' }, h('div', { class: 'empty-emoji' }, '🌈'), h('p', null, 'Nothing to practice here yet.'))));
    return;
  }
  const prefs = store.prefs();
  const byId = new Map(plan.pool.map((entry) => [entry.card.id, entry]));
  const picked = plan.testOut
    ? pickTestOut(plan.testOut.pools, prefs.sessionSize, Math.random)
    : pickSession(plan.pool.map((e) => e.card), store.state.stats, {
      size: prefs.sessionSize, maxNew: prefs.newPerSession, now: Date.now(), rng: Math.random,
      practiceFlags: store.practiceFlags(),
    });
  const starsBefore = store.state.stars;
  runQuiz(root, scope, {
    items: picked.map((card) => byId.get(card.id)),
    mode: 'practice',
    exit: plan.exit,
    onDone: (results) => {
      const total = results.length;
      const right = results.filter((r) => r.correct).length;
      let where = { exit: plan.exit };
      if (kind === 'deck') {
        // A round on a level is scored: 85% or better passes the level and opens the next one.
        store.recordRound({ deck: id, total, correct: right });
        where = afterLevel(store.state.deckById.get(id), { exit: plan.exit, total });
      } else if (kind === 'testout') {
        // One score for every level covered: 85% passes them all, less passes none.
        for (const p of plan.testOut.pools) store.recordRound({ deck: p.deck.id, total, correct: right, mode: 'testout' });
        where = afterTestOut(plan.testOut, total > 0 && right / total >= PASS_MARK, total);
      }
      clear(root);
      showDone(root, scope, {
        results, starsBefore,
        again: () => go(`/practice/${kind}${id ? `/${id}` : ''}?${Date.now()}`),
        ...where,
      });
    },
  });
}

// Where the end-of-round buttons lead after a round (or a look through the cards) on a LEVEL.
//   passed:     "Next level" points straight at the newly opened level, and "Back to the map"
//               shows the path with its new stars, instead of dropping the child back on the
//               level he just finished.
//   not passed: say exactly what it takes and make "Try again" the big button.
export function afterLevel(deck, { exit, total = 0 } = {}) {
  if (!deck) return { exit };
  const map = `/subject/${deck.subject}`;
  const levels = levelPath(store.decksOf(deck.subject), store.state.stats, store.levelOpts());
  const here = levels.findIndex((l) => l.deck.id === deck.id);
  if (here < 0) return { exit };
  const after = levels[here + 1] || null;
  if (levels[here].passed) {
    if (after && after.unlocked) {
      return { exit: map, next: { label: 'Next level', emoji: after.deck.emoji || '⭐', path: `/deck/${after.deck.id}` } };
    }
    return { exit: map, heading: after ? null : 'You finished the path!' };
  }
  const more = after ? ' and the next level' : '';        // the last level has nothing to open
  let note = `Get 3 stars${more}.`;
  if (deck.quiz === false) note = `Flip and sort every card${after ? ' to open the next level' : ''}.`;
  else if (total) note = `Get ${needToPass(total)} out of ${total} for 3 stars${more}.`;
  return { exit: map, heading: 'Good try!', note, retry: true };
}

// After a test-out round: passed opens every level covered and points at the one the child
// tapped; not passed says what it takes and offers another go.
function afterTestOut({ target, first, last }, passed, total) {
  const map = `/subject/${target.subject}`;
  const span = first === last ? `Level ${first}` : `Levels ${first} to ${last}`;
  if (passed) {
    return { exit: map, heading: 'You tested out!', note: `${span} ${first === last ? 'is' : 'are'} open!`,
      next: { label: `Level ${last}`, emoji: target.emoji || '⭐', path: `/deck/${target.id}` } };
  }
  return { exit: map, heading: 'Good try!', retry: true,
    note: `Get ${needToPass(total)} out of ${total} to test out of ${span.toLowerCase()}.` };
}

// The end-of-round screen, also used after flashcards and tests.
//   next   { label, emoji, path }: the big button moves the child forward
//   retry  the level is not passed yet: "Try again" is the big button, no confetti
//   note   one short line under the score (what passing takes)
export function showDone(root, scope, { results, starsBefore, again, exit, heading = null, note = null, isTest = false,
  next = null, retry = false }) {
  const total = results.length;
  const right = results.filter((r) => r.correct).length;
  const share = total ? right / total : 1;
  const stars = roundStars(share);            // three stars = passed; finishing always earns one
  const before = stickersEarned(starsBefore, STICKERS.length);
  const after = stickersEarned(store.state.stars, STICKERS.length);
  const title = heading || (stars === 3 ? 'Amazing!' : stars === 2 ? 'Great job!' : 'You did it!');
  const home = isTest ? '/' : exit;
  const tryAgain = !!(retry && again);

  root.append(h('section', { class: 'screen done' },
    h('div', { class: 'done-card' },
      h('div', { class: 'done-stars' }, starRow(stars)),
      h('h1', null, title),
      h('p', { class: 'done-score' }, `${right} out of ${total}`),
      note ? h('p', { class: 'done-note' }, note) : null,
      after > before
        ? h('button', { class: 'new-sticker', type: 'button', onclick: tap(() => go('/stickers')) },
          h('span', { class: 'new-sticker-emoji' }, STICKERS[after - 1]), h('span', null, 'New sticker!'))
        : null,
      h('div', { class: 'done-actions' },
        again ? h('button', { class: `btn big${tryAgain ? ' primary' : ''}`, type: 'button', onclick: tap(again),
          'aria-label': tryAgain ? 'Try again' : 'Play again' }, icon('redo'), tryAgain ? 'Try again' : 'Again') : null,
        next
          ? h('button', { class: 'btn primary big next-level', type: 'button', onclick: tap(() => go(next.path)),
            'aria-label': next.label }, next.emoji ? h('span', { class: 'btn-emoji' }, next.emoji) : null, next.label, icon('next'))
          : tryAgain ? null
            : h('button', { class: 'btn primary big', type: 'button', onclick: tap(() => go(home)),
              'aria-label': 'Done' }, icon('check'), 'Done')),
      // With a Next or Try-again button the map is still one small tap away.
      next || tryAgain ? h('button', { class: 'btn ghost done-map', type: 'button', onclick: tap(() => go(home)) },
        icon('home'), 'Back to the map') : null)));
  if (retry) {
    sfx.play('tap');
    if (note) speech.speak(`${title} ${note}`);       // not passed = he needs help: say what to do next
  } else {
    sfx.play('win');
    confetti();
    speech.speakExtra(`${title} ${right} out of ${total}.`);
  }
}
