// Grown-up level pages: every level with its score and whether it is passed (a Play round at
// 85% or better), and one level opened up: every round played on it and every wrong answer.

import { h, clear, appendAll } from '../../dom.js';
import { PASS_MARK, canQuiz, deckProgress, levelPassed, levelPath, needToPass } from '../../logic.js';
import * as store from '../../store.js';
import { confirmDialog, dateTime, go, toast } from '../../ui.js';

const PASS_PCT = Math.round(PASS_MARK * 100);

function fail(err) {
  toast(err.status === 401 ? 'Your PIN timed out. Tap Done and come back in.' : err.message);
}

function cardFront(card, deck) {
  return deck.kind === 'read' ? card.text : card.q;
}

// A read card's "answer" is the word itself, so that column shows its note, if any.
function cardAnswer(card, deck) {
  return deck.kind === 'read' ? (card.note || '–') : card.a;
}

// Rounded DOWN, so 84.6% never reads "85%" next to "under 85%" (17/20 still prints 85%).
function percent(share) {
  return `${Math.floor(share * 100 + 1e-9)}%`;
}

function statBox(value, label) {
  return h('div', { class: 'stat-box' }, h('div', { class: 'stat-value' }, value), h('div', { class: 'stat-label' }, label));
}

// One level's standing as a chip.
function statusChip(level) {
  if (!level.unlocked) return h('span', { class: 'lvl lvl-locked' }, '🔒 locked');
  if (level.passed) return h('span', { class: 'lvl lvl-passed' }, level.deck.quiz === false ? '✓ looked through' : '✓ passed');
  if (level.round) return h('span', { class: 'lvl lvl-notyet' }, `not yet · best ${percent(level.round.best)}`);
  return h('span', { class: 'lvl lvl-open' }, level.progress.seen ? 'started' : 'not played');
}

// How many questions a Play round on this deck asks, and how many right that needs.
function roundGoal(deck) {
  const hidden = store.hiddenCards();
  const n = Math.min(store.prefs().sessionSize, deck.cards.filter((c) => canQuiz(c, deck) && !hidden.has(c.id)).length);
  return { n, need: needToPass(n) };
}

function subjectPaths() {
  const opts = store.levelOpts();
  return store.state.subjects
    .map((sub) => ({ sub, levels: levelPath(store.decksOf(sub.id), store.state.stats, opts) }))
    .filter((e) => e.levels.length);
}

// ---- every level -----------------------------------------------------------

// #/grownups/levels              every subject
// #/grownups/levels/<subjectId>  one subject
export function list(body, scope, arg) {
  const { state } = store;
  const paths = subjectPaths();
  const shown = paths.filter((e) => !arg || e.sub.id === arg);
  const every = paths.flatMap((e) => e.levels);
  const passed = every.filter((l) => l.passed).length;
  const tried = every.filter((l) => l.round && !l.passed).length;
  const roundsPlayed = Object.values(state.rounds).reduce((n, r) => n + (r.count || 0), 0);
  const size = store.prefs().sessionSize;

  const picker = h('select', { class: 'input', 'aria-label': 'Subject',
    onchange: (e) => go(`/grownups/levels${e.target.value ? `/${e.target.value}` : ''}`) },
  h('option', { value: '', selected: !arg }, 'All subjects'),
  paths.map((e) => h('option', { value: e.sub.id, selected: arg === e.sub.id }, `${e.sub.emoji} ${e.sub.title}`)));

  appendAll(body,
    h('div', { class: 'page-head' }, h('h1', null, 'Levels'), picker, h('span', { class: 'spacer' }),
      h('a', { class: 'btn', href: '#/grownups/cards' }, 'Show / hide decks')),
    h('p', { class: 'muted' }, `Pass mark ${PASS_PCT}%. A level is passed, and opens the next one, when a Play round on it scores `,
      `${PASS_PCT}% or better: with ${size} questions in a round that is ${needToPass(size)} right. Rounds under the mark are `,
      'listed but do not count as progress. Tap a level for every round played on it and every wrong answer.'),
    h('div', { class: 'stat-row' },
      statBox(`${passed} / ${every.length}`, 'levels passed'),
      statBox(String(roundsPlayed), 'rounds played'),
      statBox(String(tried), 'tried, not passed yet'),
      statBox(String(store.troubleList().length), 'cards need practice')),
    ...shown.map(({ sub, levels }) => subjectPanel(sub, levels)));
}

function subjectPanel(sub, levels) {
  const { state } = store;
  const done = levels.filter((l) => l.passed).length;
  return h('div', { class: 'panel' },
    h('div', { class: 'page-head' }, h('h2', null, `${sub.emoji} ${sub.title}`),
      h('span', { class: 'muted' }, `${done} of ${levels.length} passed`)),
    h('table', { class: 'table' },
      h('thead', null, h('tr', null, ['#', 'Level', 'Status', 'Best', 'Last round', 'Rounds', 'Cards missed', 'Mastered']
        .map((t) => h('th', null, t)))),
      h('tbody', null, levels.map((level) => {
        const { deck, round, progress } = level;
        const missed = deck.cards.filter((c) => state.stats[c.id] && state.stats[c.id].wrong > 0).length;
        return h('tr', { class: level.passed ? 'row-passed' : level.unlocked ? '' : 'row-off' },
          h('td', null, String(level.index + 1)),
          h('td', null, h('a', { href: `#/grownups/level/${deck.id}` }, `${deck.emoji || ''} ${deck.title}`)),
          h('td', null, statusChip(level)),
          h('td', { class: round ? (round.best >= PASS_MARK ? 'score-pass' : 'score-fail') : '' },
            round ? percent(round.best) : deck.quiz === false ? h('span', { class: 'muted' }, 'look only') : '–'),
          h('td', null, round ? [`${round.lastCorrect} / ${round.lastTotal}`, h('div', { class: 'muted small' }, dateTime(round.lastAt))] : '–'),
          h('td', null, String(round ? round.count : 0)),
          h('td', null, missed ? h('a', { href: `#/grownups/level/${deck.id}` }, String(missed)) : '0'),
          h('td', null, `${progress.mastered} / ${progress.total}`));
      }))));
}

// ---- one level -------------------------------------------------------------

// #/grownups/level/<deckId>
export function detail(body, scope, deckId, redraw) {
  const { state } = store;
  const deck = state.deckById.get(deckId);
  if (!deck) {
    body.append(h('p', { class: 'notice' }, 'No such level. ', h('a', { href: '#/grownups/levels' }, 'Back to Levels')));
    return;
  }
  const sub = store.subjectById(deck.subject) || {};
  const levels = levelPath(store.decksOf(deck.subject), state.stats, store.levelOpts());
  const level = levels.find((l) => l.deck.id === deck.id) || null;
  const p = deckProgress(deck, state.stats, store.hiddenCards());
  const round = state.rounds[deck.id] || null;
  const { n, need } = roundGoal(deck);
  const name = state.profile.name || 'Your child';
  // A deck hidden from the child is off the path; show it as an open level anyway.
  const standing = level || { deck, round, progress: p, unlocked: true, passed: levelPassed(deck, p, round) };

  const roundsBox = h('div', { class: 'panel' }, h('h2', null, 'Rounds'), h('p', { class: 'muted' }, 'Loading…'));
  const missBox = h('div', { class: 'panel' }, h('h2', null, `What ${name} got wrong`), h('p', { class: 'muted' }, 'Loading…'));

  appendAll(body,
    h('div', { class: 'page-head' },
      h('h1', null, `${deck.emoji || ''} ${deck.title}`),
      h('span', { class: 'muted' }, level
        ? `Level ${level.index + 1} of ${levels.length} · ${sub.emoji || ''} ${sub.title || ''}`
        : `${sub.title || ''} · hidden from the child's path`),
      h('span', { class: 'spacer' }),
      h('a', { class: 'btn', href: `#/grownups/levels/${deck.subject}` }, 'All levels'),
      h('a', { class: 'btn', href: `#/grownups/cards/${deck.id}` }, 'Cards in this deck'),
      deck.quiz === false ? null : h('a', { class: 'btn primary', href: `#/practice/deck/${deck.id}` }, 'Play a round')),
    h('div', { class: 'stat-row' },
      h('div', { class: 'stat-box' }, h('div', { class: 'stat-value' }, statusChip(standing)), h('div', { class: 'stat-label' }, 'status')),
      statBox(round ? percent(round.best) : '–', 'best round'),
      statBox(round ? `${round.lastCorrect} / ${round.lastTotal}` : '–', round ? `last round · ${dateTime(round.lastAt)}` : 'last round'),
      statBox(String(round ? round.count : 0), 'rounds played'),
      statBox(`${p.mastered} / ${p.total}`, 'cards mastered'),
      deck.quiz === false
        ? statBox('👀', 'look-only level: passed once every card is seen')
        : statBox(`${need} of ${n}`, `right answers to pass (${PASS_PCT}%)`)),
    roundsBox,
    missBox,
    h('div', { class: 'form-actions' },
      h('button', { class: 'btn small', type: 'button', onclick: () =>
        confirmDialog('Start this level over?', 'Its rounds are forgotten and every card in it goes back to “new”. Stars already earned are kept.',
          'Start over', () => { store.resetProgress('deck', deck.id).then(redraw).catch(fail); }, true) }, 'Start this level over')));

  store.getDeckReport(deck.id).then((report) => {
    if (!scope.alive) return;
    clear(roundsBox).append(h('h2', null, 'Rounds'));
    if (!report.rounds.length) {
      roundsBox.append(h('p', { class: 'muted' }, deck.quiz === false ? 'A look-only level has no rounds to score.' : 'No rounds played yet.'));
    } else {
      roundsBox.append(h('table', { class: 'table' },
        h('thead', null, h('tr', null, ['When', 'Score', '', 'Result'].map((t) => h('th', null, t)))),
        h('tbody', null, report.rounds.map((r) => {
          const share = r.total ? r.correct / r.total : 0;
          const ok = share >= PASS_MARK;
          return h('tr', null,
            h('td', null, dateTime(r.at)),
            h('td', null, `${r.correct} / ${r.total}`),
            h('td', { class: ok ? 'score-pass' : 'score-fail' }, percent(share)),
            h('td', null, h('span', { class: `lvl ${ok ? 'lvl-passed' : 'lvl-notyet'}` },
              `${r.mode === 'testout' ? '⚡ test-out: ' : ''}${ok ? (r.mode === 'testout' ? 'passed' : '✓ passed') : `under ${PASS_PCT}%`}`)));
        }))));
    }

    // Every miss on this level, grouped by card, most-missed first.
    const byCard = new Map();
    for (const miss of report.misses) {
      const entry = byCard.get(miss.card) || { card: miss.card, times: 0, chose: new Map(), last: 0 };
      const what = miss.chosen || (miss.mode === 'learn' ? 'said “not yet”' : 'no answer');
      entry.times += 1;
      entry.chose.set(what, (entry.chose.get(what) || 0) + 1);
      entry.last = Math.max(entry.last, miss.at);
      byCard.set(miss.card, entry);
    }
    const rows = Array.from(byCard.values()).sort((a, b) => b.times - a.times || b.last - a.last).map((entry) => {
      const card = deck.cards.find((c) => c.id === entry.card);
      if (!card) return null;
      const stat = state.stats[card.id];
      const chose = Array.from(entry.chose.entries()).sort((a, b) => b[1] - a[1])
        .map(([what, k]) => (k > 1 ? `${what} ×${k}` : what)).join(' · ');
      return h('tr', null,
        h('td', null, h('strong', null, cardFront(card, deck)), card.emoji ? ` ${card.emoji}` : ''),
        h('td', null, cardAnswer(card, deck)),
        h('td', { class: 'bad' }, chose),
        h('td', null, String(entry.times)),
        h('td', null, stat ? `${stat.correct} / ${stat.seen}` : h('span', { class: 'muted' }, '–')),
        h('td', null, dateTime(entry.last)));
    }).filter(Boolean);
    clear(missBox).append(h('h2', null, `What ${name} got wrong`));
    if (!rows.length) {
      missBox.append(h('p', null, '🎉 No wrong answers on this level yet.'));
    } else {
      missBox.append(
        h('p', { class: 'muted' }, 'Every wrong answer ever given on this level, most-missed card first. “Right / tries” is the card’s record now.'),
        h('table', { class: 'table' },
          h('thead', null, h('tr', null, ['Card', 'Answer', 'Chose', 'Times wrong', 'Right / tries', 'Last missed'].map((t) => h('th', null, t)))),
          h('tbody', null, rows)));
    }
  }).catch((err) => {
    if (scope.alive) fail(err);
  });
}
