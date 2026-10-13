// The grown-up area: the lock, the tab bar, and the overview page.
//
// The lock is a child lock. With no PIN set it asks a times-table question; with
// a PIN set the server also refuses grown-up actions without it.

import { h, clear, appendAll } from '../../dom.js';
import { dayString, dayStreak, deckProgress, levelPath, sumProgress } from '../../logic.js';
import * as store from '../../store.js';
import { dateTime, duration, go, meter, pct, toast } from '../../ui.js';
import * as levelsPage from './levels.js';
import * as testsPage from './tests.js';
import * as cardsPage from './cards.js';
import * as settingsPage from './settings.js';

let unlocked = false;

// Called by the router whenever the child's side of the app is showing.
export function lock() {
  if (!unlocked) return;
  unlocked = false;
  store.lockParent();
}

const TABS = [
  ['overview', 'Overview'],
  ['levels', 'Levels'],
  ['tests', 'Tests'],
  ['practice', 'Needs practice'],
  ['cards', 'Cards'],
  ['settings', 'Settings'],
  ['lessons', 'Lesson plans'],       // the teacher view: its own route, no lock
];

const PAGES = {
  overview: { tab: 'overview', draw: overview },
  levels: { tab: 'levels', draw: levelsPage.list },
  level: { tab: 'levels', draw: levelsPage.detail },
  tests: { tab: 'tests', draw: testsPage.list },
  newtest: { tab: 'tests', draw: testsPage.builder },
  test: { tab: 'tests', draw: testsPage.detail },
  practice: { tab: 'practice', draw: cardsPage.needsPractice },
  cards: { tab: 'cards', draw: cardsPage.browser },
  settings: { tab: 'settings', draw: settingsPage.draw },
};

export function mount(root, scope, page = 'overview', arg = '') {
  if (!unlocked) {
    gate(root, scope, () => {
      unlocked = true;
      clear(root);
      mount(root, scope, page, arg);
    });
    return;
  }
  const entry = PAGES[page] || PAGES.overview;
  const body = h('div', { class: 'scroll grown-body' });
  root.append(h('section', { class: 'screen grown' },
    h('header', { class: 'grown-bar' },
      h('strong', { class: 'grown-brand' }, '⭐ Star Cards'),
      h('nav', { class: 'tabs', 'aria-label': 'Grown-up pages' }, TABS.map(([id, label]) =>
        h('a', { class: `tab${entry.tab === id ? ' active' : ''}`, href: id === 'lessons' ? '#/lessons' : `#/grownups/${id}` }, label))),
      h('button', { class: 'btn small primary', type: 'button', onclick: () => go('/') }, 'Done')),
    body));
  const redraw = () => {
    if (!scope.alive) return;
    clear(body);
    entry.draw(body, scope, arg, redraw);
  };
  redraw();
}

// ---- the lock --------------------------------------------------------------

function gate(root, scope, onOpen) {
  const usePin = store.state.pinSet;
  const a = 6 + Math.floor(Math.random() * 4);
  const b = 6 + Math.floor(Math.random() * 4);
  let typed = '';
  let busy = false;
  const display = h('div', { class: 'gate-display', 'aria-live': 'polite' });
  const message = h('p', { class: 'gate-message' });

  const drawDisplay = () => {
    display.textContent = usePin ? '•'.repeat(typed.length) || ' ' : typed || ' ';
  };

  // Tear down this screen's keyboard listener before handing over, or it keeps
  // submitting the lock behind the grown-up pages.
  const open = () => {
    document.removeEventListener('keydown', onKey);
    onOpen();
  };

  async function submit() {
    if (busy || !typed) return;
    if (!usePin) {
      if (Number(typed) === a * b) return open();
      typed = '';
      drawDisplay();
      message.textContent = 'Not quite. Try again.';
      return;
    }
    busy = true;
    try {
      await store.unlockParent(typed);
      open();
    } catch (err) {
      typed = '';
      drawDisplay();
      message.textContent = err.status === 0 ? 'Cannot reach the Pi.' : err.message;
    } finally {
      busy = false;
    }
  }

  const press = (key) => {
    message.textContent = '';
    if (key === '⌫') typed = typed.slice(0, -1);
    else if (key === 'OK') return submit();
    else if (typed.length < 8) typed += key;
    drawDisplay();
  };

  const onKey = (e) => {
    if (/^\d$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') press('⌫');
    else if (e.key === 'Enter') press('OK');
  };
  document.addEventListener('keydown', onKey);
  scope.add(() => document.removeEventListener('keydown', onKey));

  drawDisplay();
  root.append(h('section', { class: 'screen gate' },
    h('div', { class: 'gate-card' },
      h('h1', null, '🔒 Grown-ups only'),
      h('p', { class: 'gate-ask' }, usePin ? 'Enter your PIN' : `What is ${a} × ${b}?`),
      display,
      message,
      h('div', { class: 'keypad' }, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', 'OK'].map((key) =>
        h('button', { class: `key${key === 'OK' ? ' ok' : ''}`, type: 'button', onclick: () => press(key) }, key))),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => go('/') }, 'Back to the cards'))));
}

// ---- overview --------------------------------------------------------------

function statBox(value, label) {
  return h('div', { class: 'stat-box' }, h('div', { class: 'stat-value' }, value), h('div', { class: 'stat-label' }, label));
}

function lastDays(count) {
  const out = [];
  const cursor = new Date();
  cursor.setHours(12, 0, 0, 0);
  for (let i = 0; i < count; i++) {
    out.unshift(dayString(cursor));
    cursor.setDate(cursor.getDate() - 1);
  }
  return out;
}

function overview(body, scope) {
  const { state } = store;
  const hidden = store.hiddenCards();
  const today = dayString(new Date());
  const all = sumProgress(store.visibleDecks().map((d) => deckProgress(d, state.stats, hidden)));
  const opts = store.levelOpts();
  const paths = new Map(state.subjects.map((sub) => [sub.id, levelPath(store.decksOf(sub.id), state.stats, opts)]));
  const levelsAll = Array.from(paths.values()).reduce((n, lv) => n + lv.length, 0);
  const passedAll = Array.from(paths.values()).reduce((n, lv) => n + lv.filter((l) => l.passed).length, 0);
  const trouble = store.troubleList();
  const week = lastDays(7).reduce((acc, day) => {
    const d = state.days[day];
    return d ? { total: acc.total + d.total, correct: acc.correct + d.correct } : acc;
  }, { total: 0, correct: 0 });

  const name = state.profile.name || 'Your child';
  const people = state.profiles.length > 1
    ? h('select', { class: 'input', 'aria-label': 'Child', onchange: async (e) => {
      await store.loadProfile(Number(e.target.value));
      go(`/grownups/overview?${Date.now()}`);
    } }, state.profiles.map((p) => h('option', { value: String(p.id), selected: p.id === state.profile.id },
      `${p.avatar} ${p.name || 'Child ' + p.id}`)))
    : null;

  const chart = h('div', { class: 'day-chart', role: 'img', 'aria-label': 'Answers per day for the last 14 days' });
  const days = lastDays(14);
  const most = Math.max(10, ...days.map((d) => (state.days[d] ? state.days[d].total : 0)));
  for (const day of days) {
    const d = state.days[day] || { total: 0, correct: 0 };
    chart.append(h('div', { class: 'day-col', title: `${day}: ${d.correct} right of ${d.total}` },
      h('div', { class: 'day-bar', style: { height: `${(d.total / most) * 100}%` } },
        h('div', { class: 'day-bar-right', style: { height: d.total ? `${(d.correct / d.total) * 100}%` : '0%' } })),
      h('div', { class: 'day-name' }, day === today ? 'Today' : String(Number(day.slice(8))))));
  }

  const subjectRows = h('tbody');
  const missBox = h('div', { class: 'panel' }, h('h2', null, 'Latest misses'), h('p', { class: 'muted' }, 'Loading…'));
  const timeBox = statBox('…', 'practice time, 30 days');

  appendAll(body,
    h('div', { class: 'page-head' },
      h('h1', null, `${state.profile.avatar} ${name}`), people,
      h('span', { class: 'spacer' }),
      h('a', { class: 'btn primary', href: '#/grownups/newtest' }, 'Make a test')),
    !state.profile.name
      ? h('p', { class: 'notice' }, 'Welcome! Add your child’s name and pick which decks to show in ',
        h('a', { href: '#/grownups/settings' }, 'Settings'), ' and ', h('a', { href: '#/grownups/cards' }, 'Cards'), '.')
      : null,
    window.STARCARDS_STATIC
      ? h('p', { class: 'notice' }, 'This is the public demo copy: progress is saved only in this browser, nothing is uploaded, ',
        'and the 🙋 Help button is off. The home version keeps everything on your own computer.')
      : null,
    h('div', { class: 'stat-row' },
      statBox(`⭐ ${state.stars}`, 'stars earned'),
      statBox(`${passedAll} / ${levelsAll}`, 'levels passed (85%+)'),
      statBox(`${dayStreak(state.days, today)}`, 'days in a row'),
      statBox(`${all.mastered} / ${all.total}`, 'cards mastered'),
      statBox(pct(week.correct, week.total), `right this week (${week.total} answers)`),
      statBox(String(trouble.length), 'need practice'),
      timeBox),
    h('div', { class: 'panel' }, h('h2', null, 'Last 14 days'),
      h('p', { class: 'muted' }, 'Bar height is how many answers; the green part is how many were right.'), chart),
    h('div', { class: 'panel' }, h('h2', null, 'By subject'),
      h('table', { class: 'table' },
        h('thead', null, h('tr', null, ['Subject', 'Levels passed', 'Cards mastered', '', 'Right (30 days)', 'Last practiced']
          .map((t) => h('th', null, t)))),
        subjectRows)),
    missBox);

  const fillSubjects = (byDeck) => {
    clear(subjectRows);
    for (const sub of state.subjects) {
      const decks = store.decksOf(sub.id);
      if (!decks.length) continue;
      const p = sumProgress(decks.map((d) => deckProgress(d, state.stats, hidden)));
      const ids = new Set(decks.map((d) => d.id));
      const recent = byDeck.filter((r) => ids.has(r.deck));
      const total = recent.reduce((n, r) => n + r.total, 0);
      const correct = recent.reduce((n, r) => n + r.correct, 0);
      const last = recent.reduce((t, r) => Math.max(t, r.last || 0), 0);
      subjectRows.append(h('tr', null,
        h('td', null, h('a', { href: `#/grownups/cards/${sub.id}` }, `${sub.emoji} ${sub.title}`)),
        h('td', null, h('a', { href: `#/grownups/levels/${sub.id}` },
          `${(paths.get(sub.id) || []).filter((l) => l.passed).length} / ${p.decks}`)),
        h('td', null, `${p.mastered} / ${p.total}`),
        h('td', { class: 'meter-cell' }, meter(p.mastered, p.total)),
        h('td', null, total ? `${pct(correct, total)} of ${total}` : '–'),
        h('td', null, last ? dateTime(last) : '–')));
    }
  };
  fillSubjects([]);

  store.getReport(30).then((report) => {
    if (!scope.alive) return;
    fillSubjects(report.byDeck);
    const ms = report.byDay.reduce((n, r) => n + (r.ms || 0), 0);
    timeBox.firstChild.textContent = duration(ms);
    clear(missBox).append(h('h2', null, 'Latest misses'));
    const rows = report.misses.slice(0, 12).map((miss) => {
      const entry = state.cardById.get(miss.card);
      if (!entry) return null;
      const { card, deck } = entry;
      return h('tr', null,
        h('td', null, deck.kind === 'read' ? card.text : card.q),
        h('td', null, deck.kind === 'read' ? '' : card.a),
        h('td', { class: 'bad' }, miss.chosen || (miss.mode === 'learn' ? 'said “not yet”' : 'no answer')),
        h('td', null, deck.title),
        h('td', null, dateTime(miss.at)));
    }).filter(Boolean);
    if (!rows.length) missBox.append(h('p', { class: 'muted' }, 'No misses yet.'));
    else {
      missBox.append(h('table', { class: 'table' },
        h('thead', null, h('tr', null, ['Card', 'Answer', 'Chose', 'Deck', 'When'].map((t) => h('th', null, t)))),
        h('tbody', null, rows)),
      h('p', null, h('a', { href: '#/grownups/practice' }, 'See every card that needs practice')));
    }
  }).catch((err) => {
    if (scope.alive) toast(err.message);
  });
}
