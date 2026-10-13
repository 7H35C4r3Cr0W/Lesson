// Tests: the list and history, the builder, and one test's question-by-question results.

import { h, clear, appendAll } from '../../dom.js';
import { buildTestCards, canQuiz } from '../../logic.js';
import * as store from '../../store.js';
import { confirmDialog, dateTime, duration, go, pct, shortDate, toast } from '../../ui.js';

const SOURCES = [
  ['all', 'Every card in the chosen decks'],
  ['seen', 'Only cards already practiced'],
  ['trouble', 'Only cards that need practice'],
  ['learning', 'Only cards still being learned'],
  ['missed', 'Only cards missed at least once'],
  ['new', 'Only cards never seen'],
];

function fail(err) {
  toast(err.status === 401 ? 'Your PIN timed out. Tap Done and come back in.' : err.message);
}

// Disable a button for the duration of its async handler, so a double-tap cannot fire it twice.
function once(event, fn) {
  const btn = event.currentTarget;
  btn.disabled = true;
  Promise.resolve(fn()).finally(() => { btn.disabled = false; });
}

// ---- list and history ------------------------------------------------------

export function list(body, scope) {
  const waitingBox = h('div', { class: 'panel' }, h('h2', null, 'Waiting to be taken'));
  const historyBox = h('div', { class: 'panel' }, h('h2', null, 'History'), h('p', { class: 'muted' }, 'Loading…'));
  body.append(
    h('div', { class: 'page-head' }, h('h1', null, 'Tests'), h('span', { class: 'spacer' }),
      h('a', { class: 'btn primary', href: '#/grownups/newtest' }, 'Make a test')),
    waitingBox, historyBox);

  const drawWaiting = () => {
    clear(waitingBox).append(h('h2', null, 'Waiting to be taken'));
    if (!store.state.tests.length) {
      waitingBox.append(h('p', { class: 'muted' }, 'Nothing waiting. A test you save shows up as a “Test time!” button on the home screen.'));
      return;
    }
    waitingBox.append(h('table', { class: 'table' }, h('tbody', null, store.state.tests.map((t) => h('tr', null,
      h('td', null, h('strong', null, t.title)),
      h('td', null, `${t.cards.length} questions`),
      h('td', null, `made ${shortDate(t.created)}`),
      h('td', { class: 'actions' },
        h('button', { class: 'btn small primary', type: 'button', onclick: () => go(`/test/${t.id}`) }, 'Start now'),
        h('button', { class: 'btn small', type: 'button', onclick: () =>
          confirmDialog('Delete this test?', `“${t.title}” has not been taken yet.`, 'Delete', () => {
            store.deleteTest(t.id).then(drawWaiting).catch(fail);
          }, true) }, 'Delete')))))));
  };
  drawWaiting();

  store.listTests().then((tests) => {
    if (!scope.alive) return;
    const done = tests.filter((t) => t.status === 'done');
    clear(historyBox).append(h('h2', null, 'History'));
    if (!done.length) {
      historyBox.append(h('p', { class: 'muted' }, 'No finished tests yet.'));
      return;
    }
    const right = done.reduce((n, t) => n + (t.correct || 0), 0);
    const total = done.reduce((n, t) => n + (t.total || 0), 0);
    historyBox.append(
      h('p', { class: 'muted' }, `${done.length} tests taken · ${pct(right, total)} right overall`),
      h('table', { class: 'table' },
        h('thead', null, h('tr', null, ['Date', 'Test', 'Score', '', 'Time', ''].map((t) => h('th', null, t)))),
        h('tbody', null, done.map((t) => h('tr', null,
          h('td', null, dateTime(t.finished)),
          h('td', null, h('a', { href: `#/grownups/test/${t.id}` }, t.title)),
          h('td', null, h('strong', null, `${t.correct} / ${t.total}`)),
          h('td', null, h('span', { class: `score-chip ${scoreClass(t.correct, t.total)}` }, pct(t.correct, t.total))),
          h('td', null, t.started ? duration(t.finished - t.started) : '–'),
          h('td', { class: 'actions' }, h('a', { class: 'btn small', href: `#/grownups/test/${t.id}` }, 'Details')))))));
  }).catch(fail);
}

function scoreClass(correct, total) {
  const share = total ? correct / total : 0;
  return share >= 0.9 ? 'high' : share >= 0.7 ? 'mid' : 'low';
}

// ---- builder ---------------------------------------------------------------

// #/grownups/newtest            a blank builder
// #/grownups/newtest/trouble    pre-set to the cards that need practice
export function builder(body, scope, preset) {
  const { state } = store;
  const hidden = store.hiddenCards();
  const practiceFlags = store.practiceFlags();
  const troubleDecks = new Set(store.troubleList().map((t) => t.deck.id));
  const startedDecks = new Set(store.visibleDecks().filter((d) => d.cards.some((c) => state.stats[c.id])).map((d) => d.id));

  const chosen = new Set(preset === 'trouble' ? troubleDecks : startedDecks);
  let source = preset === 'trouble' ? 'trouble' : 'all';
  let count = 10;
  let feedback = false;

  const today = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const title = h('input', { class: 'input wide', type: 'text', maxLength: 80,
    value: preset === 'trouble' ? `Practice test · ${today}` : `Test · ${today}` });
  const countLabel = h('strong', { class: 'count-value' });
  const fitNote = h('p', { class: 'muted' });
  const saveBtn = h('button', { class: 'btn', type: 'button', onclick: () => save(false) }, 'Save for later');
  const startBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => save(true) }, 'Save and start now');
  const tree = h('div', { class: 'deck-tree' });

  const config = () => ({ decks: Array.from(chosen), count, source });
  const pick = () => buildTestCards(config(), state, state.stats, { rng: Math.random, hidden, practiceFlags });

  const refresh = () => {
    const { available } = buildTestCards({ ...config(), count: 0 }, state, state.stats,
      { rng: Math.random, hidden, practiceFlags });
    countLabel.textContent = String(count);
    const real = Math.min(count, available);
    fitNote.textContent = !chosen.size ? 'Pick at least one deck below.'
      : available === 0 ? 'No cards match. Try a different “Which cards” choice or more decks.'
        : available < count ? `Only ${available} cards match, so the test will have ${real} questions.`
          : `${available} cards match. The test will pick ${real} of them, spread across the chosen decks.`;
    saveBtn.disabled = startBtn.disabled = real === 0;
  };

  const drawTree = () => {
    clear(tree);
    for (const sub of state.subjects) {
      const decks = store.decksOf(sub.id).filter((d) => d.quiz !== false);
      if (!decks.length) continue;
      const allOn = decks.every((d) => chosen.has(d.id));
      const someOn = decks.some((d) => chosen.has(d.id));
      const subBox = h('input', { type: 'checkbox', checked: allOn, onchange: (e) => {
        decks.forEach((d) => (e.target.checked ? chosen.add(d.id) : chosen.delete(d.id)));
        drawTree();
        refresh();
      } });
      subBox.indeterminate = someOn && !allOn;
      tree.append(h('details', { class: 'tree-subject', open: someOn },
        h('summary', null, h('label', { class: 'check' }, subBox, h('span', null, `${sub.emoji} ${sub.title}`)),
          h('span', { class: 'muted' }, ` ${decks.filter((d) => chosen.has(d.id)).length} of ${decks.length} decks`)),
        h('div', { class: 'tree-decks' }, decks.map((d) => h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: chosen.has(d.id), onchange: (e) => {
            if (e.target.checked) chosen.add(d.id);
            else chosen.delete(d.id);
            drawTree();
            refresh();
          } }),
          h('span', null, `${d.emoji || ''} ${d.title}`),
          h('span', { class: 'muted' }, ` ${d.cards.filter((c) => canQuiz(c, d)).length}`,
            startedDecks.has(d.id) ? ' · started' : ''))))));
    }
  };

  const quickSet = (ids) => {
    chosen.clear();
    ids.forEach((id) => chosen.add(id));
    drawTree();
    refresh();
  };

  async function save(startNow) {
    const { cards } = pick();
    if (!cards.length) return;
    saveBtn.disabled = startBtn.disabled = true;
    try {
      const test = await store.createTest(title.value.trim() || 'Test', cards,
        { decks: Array.from(chosen), source, feedback, readAloud: true });
      if (startNow) go(`/test/${test.id}`);
      else {
        toast('Saved. It is waiting on the home screen.');
        go('/grownups/tests');
      }
    } catch (err) {
      fail(err);
      refresh();
    }
  }

  const step = (delta) => {
    count = Math.max(1, Math.min(100, count + delta));
    refresh();
  };

  body.append(
    h('div', { class: 'page-head' }, h('h1', null, 'Make a test'), h('span', { class: 'spacer' }),
      h('a', { class: 'btn', href: '#/grownups/tests' }, 'Cancel')),
    h('div', { class: 'panel form' },
      h('label', { class: 'field' }, h('span', null, 'Name'), title),
      h('div', { class: 'field' }, h('span', null, 'How many questions'),
        h('div', { class: 'stepper' },
          h('button', { class: 'btn small', type: 'button', 'aria-label': 'Five fewer', onclick: () => step(-5) }, '−5'),
          h('button', { class: 'btn small', type: 'button', 'aria-label': 'One fewer', onclick: () => step(-1) }, '−'),
          countLabel,
          h('button', { class: 'btn small', type: 'button', 'aria-label': 'One more', onclick: () => step(1) }, '+'),
          h('button', { class: 'btn small', type: 'button', 'aria-label': 'Five more', onclick: () => step(5) }, '+5'))),
      h('label', { class: 'field' }, h('span', null, 'Which cards'),
        h('select', { class: 'input', onchange: (e) => { source = e.target.value; refresh(); } },
          SOURCES.map(([value, label]) => h('option', { value, selected: value === source }, label)))),
      h('label', { class: 'check field' },
        h('input', { type: 'checkbox', checked: feedback, onchange: (e) => { feedback = e.target.checked; } }),
        h('span', null, 'Show right or wrong after each question (off = a true test, the score comes at the end)')),
      fitNote,
      h('div', { class: 'form-actions' }, saveBtn, startBtn)),
    h('div', { class: 'panel' },
      h('div', { class: 'page-head' }, h('h2', null, 'Decks to draw from'), h('span', { class: 'spacer' }),
        h('button', { class: 'btn small', type: 'button', onclick: () => quickSet(startedDecks) }, 'Started decks'),
        h('button', { class: 'btn small', type: 'button', onclick: () => quickSet(troubleDecks) }, 'Decks with trouble cards'),
        h('button', { class: 'btn small', type: 'button', onclick: () => quickSet([]) }, 'None')),
      tree));
  drawTree();
  refresh();
}

// ---- one finished test -----------------------------------------------------

export function detail(body, scope, idText) {
  body.append(h('p', { class: 'muted' }, 'Loading…'));
  store.getTest(idText).then((test) => {
    if (!scope.alive) return;
    clear(body);
    const { state } = store;
    const missed = test.results.filter((r) => !r.correct);
    const live = (r) => state.cardById.has(r.card);

    const retest = async () => {
      const cards = missed.filter(live).map((r) => r.card);
      if (!cards.length) return toast('Those cards are no longer in the app.');
      try {
        await store.createTest(`Retest: ${test.title}`.slice(0, 80), cards, { ...test.config, source: 'custom' });
        toast('Retest saved. It is waiting on the home screen.');
        go('/grownups/tests');
      } catch (err) {
        fail(err);
      }
    };
    const flagAll = async () => {
      try {
        for (const r of missed.filter(live)) await store.addFlag(r.card, 'practice', `Missed on “${test.title}”`);
        toast(`${missed.filter(live).length} cards added to Needs practice.`);
      } catch (err) {
        fail(err);
      }
    };

    appendAll(body,
      h('div', { class: 'page-head' },
        h('h1', null, test.title), h('span', { class: 'spacer' }),
        h('a', { class: 'btn', href: '#/grownups/tests' }, 'All tests')),
      test.status !== 'done'
        ? h('p', { class: 'notice' }, 'This test has not been taken yet.')
        : h('div', { class: 'stat-row' },
          h('div', { class: 'stat-box' }, h('div', { class: 'stat-value' }, `${test.correct} / ${test.total}`),
            h('div', { class: 'stat-label' }, 'score')),
          h('div', { class: 'stat-box' }, h('div', { class: `stat-value ${scoreClass(test.correct, test.total)}` },
            pct(test.correct, test.total)), h('div', { class: 'stat-label' }, 'right')),
          h('div', { class: 'stat-box' }, h('div', { class: 'stat-value' },
            test.started ? duration(test.finished - test.started) : '–'), h('div', { class: 'stat-label' }, 'time taken')),
          h('div', { class: 'stat-box' }, h('div', { class: 'stat-value' }, dateTime(test.finished)),
            h('div', { class: 'stat-label' }, 'finished'))),
      missed.length ? h('div', { class: 'form-actions' },
        h('button', { class: 'btn primary', type: 'button', onclick: (e) => once(e, retest) }, `Retest the ${missed.length} missed`),
        h('button', { class: 'btn', type: 'button', onclick: (e) => once(e, flagAll) }, 'Add missed cards to Needs practice')) : null,
      h('div', { class: 'panel' }, h('h2', null, 'Question by question'),
        h('table', { class: 'table' },
          h('thead', null, h('tr', null, ['#', '', 'Question', 'Answered', 'Right answer', 'Deck', 'Time'].map((t) => h('th', null, t)))),
          h('tbody', null, test.results.map((r, i) => {
            const deck = state.deckById.get(r.deck);
            return h('tr', { class: r.correct ? '' : 'row-miss' },
              h('td', null, String(i + 1)),
              h('td', null, r.correct ? '✅' : '❌'),
              h('td', null, r.prompt || r.answer),
              h('td', { class: r.correct ? '' : 'bad' }, r.chosen == null ? '(no answer)' : r.chosen),
              h('td', null, r.answer),
              h('td', null, deck ? deck.title : r.deck),
              h('td', null, r.ms == null ? '–' : duration(r.ms)));
          })))),
      h('div', { class: 'form-actions' },
        h('button', { class: 'btn danger', type: 'button', onclick: () =>
          confirmDialog('Delete this test?', 'It will be removed from the history. Practice progress is kept.', 'Delete', () => {
            store.deleteTest(test.id).then(() => go('/grownups/tests')).catch(fail);
          }, true) }, 'Delete this test')));
  }).catch((err) => {
    if (!scope.alive) return;
    clear(body).append(h('p', { class: 'notice' }, err.status === 404 ? 'That test no longer exists.' : err.message),
      h('a', { class: 'btn', href: '#/grownups/tests' }, 'All tests'));
  });
}
