// The question-and-choices screen shared by practice rounds and tests.
//
// Practice: friendly feedback, a second try, the answer shown after two misses,
//           and missed cards come back once at the end of the round.
// Test:     one try per question, no hints, and an "I don't know" button so the
//           child never has to guess.

import { h, clear, wait } from '../dom.js';
import { buildQuestion, sayAnswer, sayPrompt, speakable } from '../logic.js';
import * as store from '../store.js';
import * as speech from '../speech.js';
import * as sfx from '../sfx.js';
import * as help from '../help.js';
import { confirmDialog, frontFace, go, icon, sizeClass, starCounter, tap, wake } from '../ui.js';

const PRAISE = ['Yes!', 'You got it!', 'Great!', 'Nice work!', 'Super!', 'Way to go!'];

// opts:
//   items       [{ card, deck }] in asking order
//   mode        'practice' | 'test'
//   feedback    test only: show right/wrong after each answer
//   exit        where the close button goes
//   onDone      called with [{ card, deck, prompt, choices, chosen, answer, correct, ms }]
//               (one entry per card: the child's first answer to it)
export function runQuiz(root, scope, opts) {
  const { items, mode, exit, onDone } = opts;
  const isTest = mode === 'test';
  const showFeedback = !isTest || !!opts.feedback;
  const prefs = store.prefs();
  const canSpeak = speech.available() && prefs.speech;

  const queue = items.slice();
  const results = [];
  const cameBack = new Set();
  let index = 0;
  let turn = 0;              // bumps every question, so late timers from an old question do nothing

  const segments = h('div', { class: 'segments', role: 'progressbar', 'aria-label': 'Progress' });
  const stage = h('div', { class: 'quiz-stage' });
  const foot = h('div', { class: 'quiz-foot' });

  const leave = () => {
    speech.stop();
    go(exit);
  };
  const closeBtn = h('button', { class: 'round', type: 'button', 'aria-label': 'Stop', onclick: tap(() => {
    if (!isTest) return leave();
    confirmDialog('Stop the test?', 'The answers so far will not be saved.', 'Stop', leave);
  }) }, icon('close'));

  root.append(h('section', { class: `screen quiz ${isTest ? 'is-test' : ''}` },
    h('header', { class: 'bar' }, closeBtn, segments,
      isTest ? h('span', { class: 'bar-spacer' }) : starCounter(scope, { link: false })),
    stage, foot));

  function drawSegments() {
    clear(segments);
    queue.forEach((item, i) => {
      let cls = 'seg';
      if (i < index) cls += showFeedback && item.result === false ? ' miss' : ' done';
      else if (i === index) cls += ' now';
      segments.append(h('span', { class: cls }));
    });
    segments.setAttribute('aria-valuenow', String(index));
    segments.setAttribute('aria-valuemax', String(queue.length));
  }

  function next() {
    index += 1;
    if (index >= queue.length) {
      speech.stop();
      onDone(results);
      return;
    }
    ask();
  }

  function ask() {
    const mine = ++turn;
    const live = () => scope.alive && mine === turn;
    const item = queue[index];
    const { card, deck } = item;
    const question = buildQuestion(card, deck, Math.random, 3);
    // A reading card is said out loud (when there is a voice) AND shown: a tablet with the mute
    // switch on, or no voice, must never leave the child guessing which word is wanted.
    const listen = deck.kind === 'read' && canSpeak;      // say the word, replay it after a miss
    const promptSay = sayPrompt(card, deck.kind);
    let locked = true;
    let firstTry = true;
    let misses = 0;
    let shownAt = 0;
    let revealed = false;      // after two misses the answer is shown and can be tapped to go on

    drawSegments();
    clear(stage);
    clear(foot);

    const hearBtn = h('button', { class: `listen ${listen ? 'listen-big' : 'round speaker'}`, type: 'button',
      'aria-label': 'Hear it again' }, icon('speaker'));
    hearBtn.addEventListener('click', () => {
      wake();
      hearBtn.classList.add('speaking');
      speech.speak(promptSay).then(() => hearBtn.classList.remove('speaking'));
    });

    let lastWrong = null;
    const hint = h('div', { class: 'hint-bubble', hidden: true });
    const prompt = h('div', { class: 'prompt-card' },
      frontFace(card, deck), canSpeak ? hearBtn : null,
      // The 🙋 button (practice only): a spoken hint from the family's local model, if one is set up.
      !isTest && prefs.helper ? help.helpButton(store.state.profile.id,
        () => ({ card: card.id, choices: question.choices, chosen: lastWrong, revealed: misses >= 2 }),
        (text) => { hint.textContent = text; hint.hidden = false; }) : null,
      hint);

    const longest = question.choices.reduce((a, b) => (b.length > a.length ? b : a), '');
    const buttons = question.choices.map((choice) => {
      const btn = h('button', { class: `choice ${sizeClass(longest)}`, type: 'button', disabled: true }, choice);
      btn.addEventListener('click', () => choose(btn, choice));
      return btn;
    });
    const choicesEl = h('div', { class: `choices n${buttons.length}` }, buttons);
    stage.append(prompt, choicesEl);

    if (isTest) {
      foot.append(h('button', { class: 'btn ghost dont-know', type: 'button', onclick: tap(() => {
        if (!locked) settle(null, null);
      }) }, '🤷 I don’t know'));
    }

    // Choices wake up after a beat so a leftover tap from the last question cannot answer this one.
    wait(350).then(() => {
      if (!live()) return;
      locked = false;
      shownAt = performance.now();
      buttons.forEach((b) => { b.disabled = false; });
    });
    readAloud();

    // A listening question must say its word; anything else is read only in "read everything" mode,
    // or always when the deck asks for it (read-along subjects the child cannot read alone yet).
    async function readAloud() {
      if (!canSpeak || (!listen && !speech.full() && !deck.readAloud)) return;
      hearBtn.classList.add('speaking');
      const ok = await speech.speak(promptSay);
      hearBtn.classList.remove('speaking');
      if (!ok || !live() || listen) return;
      // Read each choice too, so a child who cannot read them yet can still answer.
      if ((!prefs.readChoices && !deck.readAloud) || deck.readChoices === false) return;
      await speech.speakEach(question.choices.map(speakable), (i) => {
        if (!live()) return;
        buttons.forEach((b, n) => b.classList.toggle('reading', n === i));
      });
    }

    function remember(chosen, correct) {
      if (!item.again) {
        results.push({
          card: card.id, deck: deck.id, prompt: question.prompt, choices: question.choices, chosen,
          answer: question.answer, correct, ms: Math.round(performance.now() - shownAt),
        });
      }
      item.result = correct;
      if (!isTest) {
        store.record({ card: card.id, mode: 'practice', correct, chosen, ms: performance.now() - shownAt });
      }
    }

    // Test mode, or the final state of a practice question.
    function settle(btn, chosen) {
      locked = true;
      speech.stop();
      buttons.forEach((b) => b.classList.remove('reading'));
      const correct = chosen === question.answer;
      remember(chosen, correct);
      if (!showFeedback) {
        if (btn) btn.classList.add('picked');
        sfx.play('tap');
        wait(480).then(() => live() && next());
        return;
      }
      if (correct) {
        btn.classList.add('right');
        sfx.play('right');
      } else {
        if (btn) btn.classList.add('wrong');
        buttons[question.choices.indexOf(question.answer)].classList.add('reveal');
        sfx.play('oops');
      }
      wait(correct ? 900 : 1700).then(() => live() && next());
    }

    function choose(btn, chosen) {
      // Once the answer is revealed, tapping it (the only enabled button) moves on.
      if (revealed) {
        if (chosen === question.answer && live()) next();
        return;
      }
      if (locked || !live()) return;
      wake();
      if (isTest) return settle(btn, chosen);
      speech.stop();
      buttons.forEach((b) => b.classList.remove('reading'));
      const correct = chosen === question.answer;
      if (firstTry) remember(chosen, correct);
      if (correct) {
        locked = true;
        btn.classList.add('right');
        sfx.play('right');
        if (firstTry) prompt.append(h('div', { class: 'praise' }, PRAISE[Math.floor(Math.random() * PRAISE.length)]));
        wait(950).then(() => live() && next());
        return;
      }
      // A miss: no buzzer, just "not that one". The card comes back once later in the round.
      misses += 1;
      lastWrong = chosen;
      btn.classList.add('wrong');
      btn.disabled = true;
      sfx.play('oops');
      if (firstTry && !item.again && !cameBack.has(card.id)) {
        cameBack.add(card.id);
        queue.push({ card, deck, again: true });
        drawSegments();
      }
      firstTry = false;
      const open = buttons.filter((b) => !b.disabled);
      if (misses >= 2 || open.length <= 1) reveal();
      else if (canSpeak) speech.speak(promptSay);     // a miss means "needs help": read the prompt again
    }

    // Two misses: show the answer, say it, and let the child tap it (or Next) to move on.
    function reveal() {
      revealed = true;
      locked = true;
      const rightBtn = buttons[question.choices.indexOf(question.answer)];
      buttons.forEach((b) => { b.disabled = true; });
      rightBtn.disabled = false;             // the child can tap the glowing answer to go on
      rightBtn.classList.add('reveal');
      if (canSpeak) speech.speak(sayAnswer(card, deck.kind));
      const nextBtn = h('button', { class: 'btn primary big next-btn', type: 'button', onclick: tap(() => live() && next()) },
        'Next', icon('next'));
      foot.append(nextBtn);
    }
  }

  scope.add(() => {
    turn += 1;
    speech.stop();
  });
  ask();
}
