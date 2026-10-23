// Memory Match: pairs of face-down star cards. One card of each pair shows the
// prompt side (a 🔊 that says the word, or the question), its twin shows the
// printed answer. Tap two; a match hops and stays up, anything else just turns
// back over. Untimed, no counter, nothing is ever "wrong" out loud.
//
// Recording: the engine only accepts an answer for the question it handed out
// last, and it deals questions in order, so we build the board from game.items
// (with the same helpers engine.next() uses) and keep one `pending` question.
// Whenever the pending pair has been found we record it and advance, so each
// pair is recorded exactly once, in engine order, with the right card.

import { h, reducedMotion } from '../dom.js';
import { answerOf, promptOf, sayAnswer, sayPrompt } from '../logic.js';
import { renderVisual } from '../visuals.js';

export const meta = { id: 'memory', title: 'Memory Match', emoji: '🃏' };

const PIECES = ['⭐', '🌟', '✨', '🎉', '💛'];
const PRAISE = ['You found them all!', 'All the pairs! Amazing!', 'Every pair! Great job!'];
const PROMPT_MAX = 40;
const NARROW = 820;              // stage width below this gets 4 pairs instead of 6

// Cut by whole characters (Array.from), so an emoji is never split in half.
function shorten(text, max) {
  const chars = Array.from(String(text == null ? '' : text).trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trim()}…` : chars.join('');
}

function sizeClass(text) {
  const n = text.length;
  return n <= 4 ? 'len-s' : n <= 12 ? 'len-m' : 'len-l';
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = list[i];
    list[i] = list[j];
    list[j] = t;
  }
  return list;
}

export function start(game) {
  const stage = game.stage;
  const board = h('div', { class: 'mem-board', role: 'group', 'aria-label': 'Memory cards' });
  stage.append(board);

  // The engine's current question. Pairs are handed to it in its own order.
  let pending = game.next();
  if (!pending) return game.finish();

  const width = stage.getBoundingClientRect().width || window.innerWidth;
  const count = Math.min(width < NARROW ? 4 : 6, game.items.length);
  game.trim(count);                 // the progress bar shows only the pairs on the board

  const pairs = game.items.slice(0, count).map(({ card, deck }, i) => ({
    i, card, deck,
    listen: deck.kind === 'read',
    prompt: shorten(promptOf(card, deck.kind), PROMPT_MAX),
    answer: String(answerOf(card, deck.kind)),
    say: sayPrompt(card, deck.kind),
    sayAnswer: sayAnswer(card, deck.kind),
    misses: 0, hinted: false, found: false, cards: [],
  }));

  const cards = [];
  for (const pair of pairs) {
    for (const side of ['prompt', 'answer']) {
      const card = { pair, side, el: null, up: false, seen: false, found: false };
      pair.cards.push(card);
      cards.push(card);
    }
  }
  shuffle(cards);

  const mate = (card) => (card.pair.cards[0] === card ? card.pair.cards[1] : card.pair.cards[0]);

  let first = null;
  let busy = true;
  let done = false;
  let foundPairs = 0;
  let flushing = false;
  let layer = null;

  // ---- board

  function faceContent(card) {
    const { pair, side } = card;
    const text = side === 'prompt' ? pair.prompt : pair.answer;
    // A listening pair's prompt side shows the word too (with its 🔊), so a silent tablet still works.
    const label = h('span', { class: `mem-text ${sizeClass(text)}` },
      side === 'prompt' && pair.listen ? h('span', { class: 'mem-ear', 'aria-hidden': 'true' }, '🔊 ') : null, text);
    if (side !== 'prompt' || pair.listen) return label;
    // A question card's prompt side shows what the question is about, small, above the
    // words: its drawing ("How many cats?" needs its cats) or else its picture clue.
    const visual = renderVisual(pair.card.visual);
    const pic = visual ? h('div', { class: 'mem-visual' }, visual)
      : pair.card.emoji ? h('span', { class: 'mem-emoji', 'aria-hidden': 'true' }, pair.card.emoji) : null;
    return pic ? h('div', { class: 'mem-qa' }, pic, label) : label;
  }

  function labelOf(card) {
    if (!card.up && !card.found) return 'Face-down card';
    if (card.side === 'prompt') return card.pair.prompt;
    return card.pair.answer;
  }

  for (const card of cards) {
    const el = h('button', { class: `mem-card ${card.side === 'prompt' ? 'is-prompt' : 'is-answer'}`, type: 'button', 'aria-label': 'Face-down card' },
      h('div', { class: 'mem-inner' },
        h('div', { class: 'mem-face mem-down', 'aria-hidden': 'true' }, h('span', { class: 'mem-star' }, '⭐')),
        h('div', { class: 'mem-face mem-up' }, faceContent(card))));
    el.addEventListener('click', () => tapCard(card));
    card.el = el;
    board.append(el);
  }

  // Two rows normally; three when the columns would get skinny and the count allows it.
  function layout() {
    const n = cards.length;
    let rows = 2;
    let cols = Math.ceil(n / rows);
    const w = stage.getBoundingClientRect().width || window.innerWidth;
    if (w / cols < 112 && n % 3 === 0) {
      rows = 3;
      cols = n / 3;
    }
    board.style.setProperty('--cols', String(cols));
    board.style.setProperty('--rows', String(rows));
  }

  // ---- recording (engine order)

  // Record the pending pair if the child has found it. Returns true when it did.
  function recordNext() {
    const pair = pending ? pairs[pending.index] : null;
    if (!pair || !pair.found) return false;
    // A pair found after 3+ mismatches still records as a miss, but it was just matched, so
    // keep the engine quiet (silent) — the positive match sound has already played.
    game.answer(pending, pair.misses >= 3 ? 'mismatch' : pending.answer, { silent: pair.misses >= 3 });
    pending = game.next();
    return true;
  }

  const nextReady = () => Boolean(pending && pairs[pending.index] && pairs[pending.index].found);

  // Record every found pair from the pending one onward, spacing the engine's
  // own sounds a little apart. Returns true when the engine played the match
  // ding itself (a pair recorded right now as a 'right'). A pair that is recorded
  // as a miss is never recorded on the tap: the engine would answer the child's
  // match with 'oops', so that record waits until after the local 'right'.
  function flush() {
    if (flushing || !nextReady()) return false;
    let dinged = false;
    if (pairs[pending.index].misses < 3) {
      recordNext();
      dinged = true;
    }
    if (nextReady()) {
      flushing = true;
      (async () => {
        await game.wait(dinged ? 170 : 500);
        while (game.alive() && nextReady()) {
          recordNext();
          await game.wait(170);
        }
        flushing = false;
      })();
    }
    return dinged;
  }

  // ---- play

  function flipUp(card) {
    card.up = true;
    card.seen = true;
    card.el.classList.add('open');
    card.el.classList.remove('hint');
    card.el.setAttribute('aria-label', labelOf(card));
    game.sfx('flip');
    // The prompt side always speaks (for a reading pair that IS the clue). The answer
    // side speaks only for question cards: a reading pair's printed word stays silent,
    // otherwise she could match the two by ear without reading anything.
    // A listening pair's word is the clue, so it is always said; printed questions and
    // answers are read only in "read everything" mode, like the quiz.
    if (card.side === 'prompt') (card.pair.listen ? game.say : game.sayExtra)(card.pair.say);
    else if (!card.pair.listen) game.sayExtra(card.pair.sayAnswer);
  }

  function flipDown(card) {
    card.up = false;
    card.el.classList.remove('open');
    card.el.setAttribute('aria-label', 'Face-down card');
  }

  function tapCard(card) {
    if (busy || done || card.found || card.up) return;
    flipUp(card);
    if (!first) {
      first = card;
      return;
    }
    const a = first;
    first = null;
    busy = true;
    if (a.pair === card.pair) matched(a, card);
    else mismatch(a, card);
  }

  async function matched(a, b) {
    const pair = a.pair;
    pair.found = true;
    for (const c of [a, b]) {
      c.found = true;
      c.el.classList.remove('open', 'hint');
      c.el.classList.add('found');
      c.el.disabled = true;
    }
    if (!flush()) game.sfx('right');          // flush() makes the engine play it
    foundPairs += 1;
    if (foundPairs >= pairs.length) return celebrate();
    await game.wait(350);
    if (!game.alive()) return;
    busy = false;
  }

  async function mismatch(a, b) {
    // Count a miss only when the child had already seen the first card's twin.
    if (mate(a).seen) a.pair.misses += 1;
    await game.wait(900);
    if (!game.alive()) return;
    flipDown(a);
    flipDown(b);
    game.sfx('tap');
    showHints();
    await game.wait(380);                      // let the flip-back finish
    if (!game.alive()) return;
    busy = false;
  }

  // After the second miss on a pair, its two stars glow so the child can finish.
  function showHints() {
    let fresh = null;
    for (const pair of pairs) {
      if (pair.found || pair.misses < 2) continue;
      for (const c of pair.cards) if (!c.up) c.el.classList.add('hint');
      if (!pair.hinted) {
        pair.hinted = true;
        fresh = pair;
      }
    }
    if (fresh) game.say('Tap the glowing stars!');
  }

  function confetti() {
    if (reducedMotion()) return;
    layer = h('div', { class: 'confetti', 'aria-hidden': 'true' });
    for (let i = 0; i < 24; i++) {
      layer.append(h('span', { style: {
        left: `${Math.random() * 100}%`,
        animationDelay: `${Math.random() * 0.4}s`,
        animationDuration: `${1.5 + Math.random() * 1.2}s`,
        fontSize: `${22 + Math.random() * 26}px`,
      } }, PIECES[i % PIECES.length]));
    }
    document.body.append(layer);
    setTimeout(() => {
      if (layer) layer.remove();
      layer = null;
    }, 3200);
  }

  async function celebrate() {
    done = true;
    await game.wait(450);
    if (!game.alive()) return;
    game.sfx('win');
    confetti();
    game.sayExtra(PRAISE[Math.floor(Math.random() * PRAISE.length)]);
    await game.wait(1900);
    if (!game.alive()) return;
    while (flushing) {                         // let a spaced-out catch-up finish first
      await game.wait(100);
      if (!game.alive()) return;
    }
    while (recordNext()) { /* make sure every pair reached the engine */ }
    game.finish();
  }

  // ---- wiring

  const onResize = () => layout();
  window.addEventListener('resize', onResize);
  game.scope.add(() => {
    window.removeEventListener('resize', onResize);
    if (layer) layer.remove();
    layer = null;
  });

  layout();
  game.sayExtra('Find the pairs! Tap two cards.');
  game.wait(400).then(() => { busy = false; });
}
