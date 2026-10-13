// Flashcards: page through a deck one card at a time.
//
// The routine is the one a teacher uses with a card in hand: look and try it,
// flip to check (the tablet says it), then sort it into "got it" or "not yet".
// "Not yet" cards come back a few cards later.

import { h, clear } from '../dom.js';
import { sayAnswer, sayPrompt } from '../logic.js';
import * as store from '../store.js';
import * as speech from '../speech.js';
import * as sfx from '../sfx.js';
import * as help from '../help.js';
import { backFace, frontFace, go, icon, starCounter, tap, wake } from '../ui.js';
import { afterLevel, showDone } from './practice.js';

const COME_BACK_AFTER = 4;     // a "not yet" card returns this many cards later
const MAX_RETURNS = 2;

export function mount(root, scope, deckId) {
  const deck = store.state.deckById.get(deckId);
  if (!deck) return go('/');
  const hidden = store.hiddenCards();
  const queue = deck.cards.filter((c) => !hidden.has(c.id)).map((card) => ({ card, returns: 0 }));
  if (!queue.length) return go(`/deck/${deck.id}`);

  const canSpeak = speech.available() && store.prefs().speech;
  const speakFront = deck.kind === 'qa' && deck.speakFront !== false;
  const starsBefore = store.state.stars;
  const rated = new Map();       // card id -> first rating this round
  let index = 0;
  let flipped = false;
  let swipedAt = 0;
  let lastFlip = 0;      // an excited double-tap must not flip the card straight back

  const counter = h('h1', { class: 'bar-title counter' });
  const front = h('div', { class: 'flip-face flip-front' });
  const back = h('div', { class: 'flip-face flip-back' });
  const inner = h('div', { class: 'flip-inner' }, front, back);
  const flipCard = h('div', { class: 'flip', role: 'button', tabIndex: 0, 'aria-label': 'Flip the card' }, inner);
  const hint = h('div', { class: 'hint-bubble', hidden: true });
  const helpBtn = store.prefs().helper ? help.helpButton(store.state.profile.id,
    () => ({ card: queue[index].card.id, revealed: flipped }),
    (text) => { hint.textContent = text; hint.hidden = false; }) : null;
  const foot = h('div', { class: 'cards-foot' });
  const prevBtn = h('button', { class: 'round nav-arrow', type: 'button', 'aria-label': 'Card before',
    onclick: tap(() => move(-1)) }, icon('back'));
  const nextBtn = h('button', { class: 'round nav-arrow', type: 'button', 'aria-label': 'Next card',
    onclick: tap(() => move(1)) }, icon('next'));
  const stage = h('div', { class: 'cards-stage' }, prevBtn, h('div', { class: 'flip-wrap' }, flipCard, helpBtn, hint), nextBtn);

  root.append(h('section', { class: 'screen cards' },
    h('header', { class: 'bar' },
      h('button', { class: 'round', type: 'button', 'aria-label': 'Stop', onclick: tap(() => go(`/deck/${deck.id}`)) },
        icon('close')),
      counter, starCounter(scope, { link: false })),
    stage, foot));

  function finish() {
    speech.stop();
    if (!rated.size) return go(`/deck/${deck.id}`);
    clear(root);
    const exit = `/deck/${deck.id}`;
    showDone(root, scope, {
      results: Array.from(rated.values()).map((correct) => ({ correct })),
      starsBefore,
      again: () => go(`/cards/${deck.id}?${Date.now()}`),
      // Looked through the cards? The natural next step is to play this level. A look-only
      // level has no round to score, so looking at every card is what passes it.
      ...(deck.quiz === false
        ? afterLevel(deck, { exit })
        : { exit: `/subject/${deck.subject}`, next: { label: 'Play', emoji: '🎯', path: `/practice/deck/${deck.id}` } }),
    });
  }

  function show() {
    const { card } = queue[index];
    flipped = false;
    flipCard.classList.remove('flipped');
    clear(front).append(frontFace(card, deck));
    clear(back).append(backFace(card, deck));
    counter.textContent = `${index + 1} / ${queue.length}`;
    prevBtn.disabled = index === 0;
    hint.hidden = true;
    drawFoot();
    speech.stop();
    if (canSpeak && speakFront) speech.speakExtra(sayPrompt(card, deck.kind));
  }

  function drawFoot() {
    const { card } = queue[index];
    clear(foot);
    // Element.append() would print a null as the word "null"; h() skips them.
    if (!flipped) {
      foot.append(h('div', { class: 'foot-row' },
        canSpeak && speakFront
          ? h('button', { class: 'btn big', type: 'button', 'aria-label': 'Hear the question',
            onclick: () => { wake(); speech.speak(sayPrompt(card, deck.kind)); } }, icon('speaker'), 'Hear')
          : null,
        h('button', { class: 'btn primary big', type: 'button', onclick: tap(flip, null) },
          h('span', { class: 'btn-emoji' }, '👆'), 'Check')));
      return;
    }
    foot.append(h('div', { class: 'foot-row' },
      h('button', { class: 'btn big not-yet', type: 'button', onclick: tap(() => rate(false)) },
        h('span', { class: 'btn-emoji' }, '🔁'), 'Not yet'),
      canSpeak ? h('button', { class: 'round speaker', type: 'button', 'aria-label': 'Hear it again',
        onclick: () => { wake(); speech.speak(sayAnswer(card, deck.kind)); } }, icon('speaker')) : null,
      h('button', { class: 'btn primary big got-it', type: 'button', onclick: tap(() => rate(true)) },
        h('span', { class: 'btn-emoji' }, '⭐'), 'Got it')));
  }

  function flip() {
    if (performance.now() - lastFlip < 450) return;
    lastFlip = performance.now();
    wake();
    flipped = !flipped;
    flipCard.classList.toggle('flipped', flipped);
    sfx.play('flip');
    drawFoot();
    const { card } = queue[index];
    if (flipped && canSpeak) speech.speak(sayAnswer(card, deck.kind));
    else speech.stop();
  }

  function rate(correct) {
    const entry = queue[index];
    store.record({ card: entry.card.id, mode: 'learn', correct });
    if (!rated.has(entry.card.id)) rated.set(entry.card.id, correct);
    sfx.play(correct ? 'star' : 'tap');
    if (!correct && entry.returns < MAX_RETURNS) {
      const at = Math.min(queue.length, index + 1 + COME_BACK_AFTER);
      queue.splice(at, 0, { card: entry.card, returns: entry.returns + 1 });
    }
    move(1);
  }

  function move(step) {
    const target = index + step;
    if (target < 0) return;
    if (target >= queue.length) return finish();
    index = target;
    show();
  }

  // Tap flips; a sideways swipe turns the page.
  flipCard.addEventListener('click', () => {
    if (performance.now() - swipedAt > 350) flip();
  });
  let downX = null;
  stage.addEventListener('pointerdown', (e) => { downX = e.clientX; });
  stage.addEventListener('pointerup', (e) => {
    if (downX == null) return;
    const dx = e.clientX - downX;
    downX = null;
    if (Math.abs(dx) < 70) return;
    swipedAt = performance.now();
    wake();
    move(dx < 0 ? 1 : -1);
  });
  stage.addEventListener('pointercancel', () => { downX = null; });

  const onKey = (e) => {
    if (e.key === 'ArrowRight') move(1);
    else if (e.key === 'ArrowLeft') move(-1);
    else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); }
  };
  document.addEventListener('keydown', onKey);
  scope.add(() => {
    document.removeEventListener('keydown', onKey);
    speech.stop();
  });

  show();
}
