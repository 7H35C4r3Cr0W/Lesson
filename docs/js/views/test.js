// Taking a test a grown-up set up: a calm start screen, the questions, then the score.

import { h, clear } from '../dom.js';
import { canQuiz } from '../logic.js';
import * as store from '../store.js';
import * as speech from '../speech.js';
import { go, icon, tap, topBar } from '../ui.js';
import { showDone } from './practice.js';
import { runQuiz } from './quiz.js';

export function mount(root, scope, idText) {
  const test = store.state.tests.find((t) => String(t.id) === idText);
  if (!test) return go('/');
  // A card may have been removed or hidden since the test was made; the server marks those as not answered.
  const hidden = store.hiddenCards();
  const items = test.cards
    .map((id) => store.state.cardById.get(id))
    .filter((entry) => entry && canQuiz(entry.card, entry.deck) && !hidden.has(entry.card.id));
  if (!items.length) return go('/');

  const start = () => {
    clear(root);
    const started = Date.now();
    const starsBefore = store.state.stars;
    runQuiz(root, scope, {
      items,
      mode: 'test',
      feedback: !!test.config.feedback,
      exit: '/',
      onDone: async (results) => {
        clear(root);
        root.append(h('div', { class: 'splash' }, h('span', { class: 'splash-star' }, '⭐')));
        let saved = null;
        try {
          saved = await store.finishTest(test.id, results.map(({ card, deck, prompt, choices, chosen, ms }) =>
            ({ card, deck, prompt, choices, chosen, ms })), started);
        } catch (err) {
          console.warn('Could not hand in the test:', err.message);
        }
        if (!scope.alive) return;
        clear(root);
        // Use the server's marking when we have it; our own otherwise (the Pi was unreachable).
        const marked = saved ? saved.results : results;
        showDone(root, scope, { results: marked, starsBefore, again: null, exit: '/', heading: 'All done!', isTest: true });
      },
    });
  };

  root.append(h('section', { class: 'screen test-intro' },
    topBar(scope, { back: '/', backIcon: 'home', backLabel: 'Home', right: null }),
    h('div', { class: 'deck-hero' },
      h('div', { class: 'hero-emoji' }, '📝'),
      h('h2', { class: 'hero-title' }, test.title),
      h('p', { class: 'hero-sub' }, `${items.length} questions. Take your time and do your best!`),
      h('div', { class: 'hero-actions' },
        h('button', { class: 'btn primary big', type: 'button', onclick: tap(start) }, icon('play'), 'Start')))));
  speech.speakExtra(`Test time! ${items.length} questions. Take your time and do your best.`);
}
