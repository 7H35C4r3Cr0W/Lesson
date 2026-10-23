// Shared plumbing for the mini games: picking questions from the levels the child
// has reached, the frame around a game (close button, progress, stars), recording
// answers as stars, and the finish screen. Each game in this folder exports
//   meta  = { id, title, emoji, blurb, kinds: ['read','qa'] | null, needsDrag }
//   start(game)  where `game` is what createGame() returns.
//
// Games never move a card's mastery (mode 'game'), only earn stars, so a wild
// miss while flinging a bird cannot mark a word as "trouble".

import { h, clear, wait } from '../dom.js';
import { buildQuestion, canQuiz, levelPath, pickSession, sayAnswer, sayPrompt, speakable } from '../logic.js';
import * as store from '../store.js';
import * as speech from '../speech.js';
import * as sfx from '../sfx.js';
import { go, icon, starCounter, tap } from '../ui.js';
import { renderVisual } from '../visuals.js';
import { showDone } from '../views/practice.js';

export const ROUND = 8;              // questions per game round: short on purpose
export const CHOICES = 3;

// ---- questions -------------------------------------------------------------

// Cards the child is allowed to meet in a game: every unlocked level (or one
// deck, when a game is launched from a level page).
export function gamePool({ deckId = null, kinds = null } = {}) {
  const hidden = store.hiddenCards();
  const decks = deckId
    ? [store.state.deckById.get(deckId)].filter(Boolean)
    : store.state.subjects.flatMap((sub) =>
      levelPath(store.decksOf(sub.id), store.state.stats, store.levelOpts())
        .filter((l) => l.unlocked).map((l) => l.deck));
  const out = [];
  for (const deck of decks) {
    if (!deck || deck.quiz === false) continue;
    if (kinds && !kinds.includes(deck.kind)) continue;
    for (const card of deck.cards) {
      if (canQuiz(card, deck) && !hidden.has(card.id)) out.push({ card, deck });
    }
  }
  return out;
}

// Pick a round's worth of questions: trouble cards first, mostly cards already
// seen (so a game feels like winning), a couple of new ones.
export function pickQuestions(pool, count = ROUND) {
  if (!pool.length) return [];
  const byId = new Map(pool.map((e) => [e.card.id, e]));
  const picked = pickSession(pool.map((e) => e.card), store.state.stats, {
    size: count, maxNew: 2, now: Date.now(), rng: Math.random, practiceFlags: store.practiceFlags(),
  });
  return picked.map((card) => byId.get(card.id));
}

// ---- the game frame --------------------------------------------------------

export function createGame(root, scope, { meta, pool, exit = '/games', count = ROUND }) {
  const items = pickQuestions(pool, count);
  const prefs = store.prefs();
  const results = [];
  const starsBefore = store.state.stars;
  let index = -1;
  let wrongStreak = 0;
  let current = null;
  let answeredCurrent = false;
  let autoHear = false;        // the first hear() after next() is the game's automatic read-out

  const segments = h('div', { class: 'segments', role: 'progressbar', 'aria-label': 'Progress' });
  const stage = h('div', { class: 'game-stage' });
  const bar = h('header', { class: 'bar game-bar' },
    h('button', { class: 'round', type: 'button', 'aria-label': 'Stop', onclick: tap(() => { speech.stop(); go(exit); }) }, icon('close')),
    segments,
    starCounter(scope, { link: false }));
  root.append(h('section', { class: `screen game game-${meta.id}` }, bar, stage));

  const drawSegments = () => {
    clear(segments);
    items.forEach((item, i) => {
      let cls = 'seg';
      if (i < index || (i === index && answeredCurrent)) cls += item.correct === false ? ' miss' : ' done';
      else if (i === index) cls += ' now';
      segments.append(h('span', { class: cls }));
    });
  };

  const game = {
    meta,
    stage,
    scope,
    items,
    prefs,
    canSpeak: speech.available() && prefs.speech,
    alive: () => scope.alive,

    // The next question, with answer choices sized to how the round is going
    // (two choices after two misses in a row). null when the round is over.
    next() {
      index += 1;
      answeredCurrent = false;
      if (index >= items.length) {
        current = null;
        return null;
      }
      const { card, deck } = items[index];
      const choices = wrongStreak >= 2 ? 2 : CHOICES;
      current = { ...buildQuestion(card, deck, Math.random, choices), card, deck, index, total: items.length,
        say: sayPrompt(card, deck.kind), sayAnswer: sayAnswer(card, deck.kind), listen: deck.kind === 'read' };
      autoHear = true;
      drawSegments();
      return current;
    },

    // Say the prompt. For reading cards that is the word to find, which must always be
    // spoken. For written questions the automatic read-out happens only in "read
    // everything" mode; a tap on 🔊 (any later call) always speaks.
    async hear(q = current, withChoices = true) {
      if (!this.canSpeak || !q) return;
      const automatic = autoHear;
      autoHear = false;
      const always = q.deck.readAloud === true;        // read-along decks are always read out
      if (automatic && !q.listen && !speech.full() && !always) return;
      const ok = await speech.speak(q.say);
      if (!ok || q.listen || !withChoices || (!speech.full() && !always) || (!prefs.readChoices && !always)
        || q.deck.readChoices === false) return;
      await speech.speakEach(q.choices.map(speakable));
    },

    // Record an answer. Only the first answer to a question counts; later tries
    // just return whether they were right. Pass { silent: true } when the game reports a
    // soft miss (e.g. "built with help", a pair found after many tries) but has already
    // played its own happy sound, so the child never hears an "oops" on a success.
    answer(q, chosen, opts = {}) {
      const correct = chosen === q.answer;
      if (!answeredCurrent && q === current) {
        answeredCurrent = true;
        items[q.index].correct = correct;
        results.push({ card: q.card.id, correct });
        store.record({ card: q.card.id, mode: 'game', correct, chosen });
        wrongStreak = correct ? 0 : wrongStreak + 1;
        drawSegments();
      }
      if (!opts.silent) sfx.play(correct ? 'right' : 'oops');
      return correct;
    },

    // say = always (help: the word to find, the answer after misses). sayExtra = chatter
    // (greetings, countdowns, praise), only in "read everything" mode.
    say: (text) => (speech.available() && prefs.speech ? speech.speak(text) : Promise.resolve(false)),
    sayExtra: (text) => speech.speakExtra(text),
    sfx: (name) => sfx.play(name),
    wait,

    // A game that shows fewer questions than it was dealt (Memory's 4-6 pairs) trims the
    // round so the progress bar can fill up.
    trim(n) {
      if (n < items.length) items.length = Math.max(0, n);
      drawSegments();
    },

    finish() {
      speech.stop();
      clear(root);
      showDone(root, scope, {
        results, starsBefore, exit,
        again: () => go(`${location.hash.replace(/^#/, '').split('?')[0]}?${Date.now()}`),
      });
    },
  };

  scope.add(() => speech.stop());
  return game;
}

// What goes in a game's prompt box for one question, as elements to append: the
// thing the question is about, then the words. A card with a drawing ("How many
// cats?" over a row of cats, a clock, a ten-frame) gets that drawing, in a
// div.game-visual, above the text; a question card with only a picture clue gets
// the emoji beside the text (pass { emoji: false } when the game already shows
// it somewhere else). Reading cards are text only: the word is the whole point.
// The word is shown AND said: a silent tablet must never hide it.
export function promptFace(q, { emoji = true } = {}) {
  const out = [];
  if (!q.listen) {
    const visual = renderVisual(q.card.visual);
    if (visual) out.push(h('div', { class: 'game-visual' }, visual));
    else if (emoji && q.card.emoji) out.push(h('span', { class: 'game-prompt-emoji', 'aria-hidden': 'true' }, q.card.emoji));
  }
  out.push(h('span', { class: 'game-prompt-text' }, q.prompt));
  return out;
}

// A reusable "tap the right one" strip of big buttons, used by the simpler games.
export function choiceButtons(q, onPick, { sizeClass = '' } = {}) {
  const buttons = q.choices.map((choice) => {
    const btn = h('button', { class: `choice ${sizeClass}`, type: 'button' }, choice);
    btn.addEventListener('click', () => onPick(choice, btn));
    return btn;
  });
  return { el: h('div', { class: `choices n${buttons.length}` }, buttons), buttons };
}

// Standard miss handling for tap games: fade the wrong one, replay the prompt,
// and after the second miss light up the right answer so the child can finish.
export function missLadder(q, buttons, btn, misses, game) {
  btn.classList.add('wrong');
  btn.disabled = true;
  if (misses >= 2 || buttons.filter((b) => !b.disabled).length <= 1) {
    // Buttons are built in q.choices order; some games add an emoji to the label, so match by index.
    const right = buttons[q.choices.indexOf(q.answer)];
    if (!right) return true;
    right.classList.add('reveal');
    right.disabled = false;
    game.say(`It's ${q.sayAnswer}. Tap it!`);
    return true;
  }
  game.hear(q, false);
  return false;
}
