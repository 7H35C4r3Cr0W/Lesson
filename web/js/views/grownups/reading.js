// The grown-up Reading page: every story the child has read, how smoothly, and the words to practice.
//
//   #/grownups/reading
//
// A "read" is one pass through a story on the Read screen. Reading by himself, the child taps any
// word he needs (the tablet says it) and those taps are kept as words to practice. A grown-up can
// instead score a read: Start, tap each word read wrong, Finished, and the tablet works out words
// correct per minute (WCPM), the number the school's mCLASS/DIBELS check reports. The child never
// sees a time or a number per minute, only stars.
//
// The per-story summaries (reads, best, last) come from store.state.reads; the full history and the
// missed-word list come from the reading report, which loads after the page is drawn (like the
// Levels page loads a level's rounds).

import { h, clear, appendAll } from '../../dom.js';
import * as logic from '../../logic.js';
import * as store from '../../store.js';
import { dateTime, toast } from '../../ui.js';

// ---- the shared word rules -------------------------------------------------

// logic.js owns these (the server counts words the same way). The stand-ins follow the same
// rules so this page and the lesson plans draw on a build that does not carry them yet.
function stripToken(token) {
  return token.replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, '');
}

function localWordCount(text) {
  return String(text || '').split(/\s+/).filter((t) => /[A-Za-z]/.test(stripToken(t))).length;
}

function localPassageParagraphs(text) {
  return String(text || '').split(/\n\s*\n/)
    .map((par) => par.split('\n').map((line) => line.trim()).filter((line) => line && line !== '***'))
    .filter((lines) => lines.length);
}

function localWcpmOf(words, errors, seconds) {
  if (!(seconds > 0)) return null;
  return Math.max(0, Math.round(((words - errors) / seconds) * 60));
}

export const wordCount = logic.wordCount || localWordCount;
export const passageParagraphs = logic.passageParagraphs || localPassageParagraphs;
export const wcpmOf = logic.wcpmOf || localWcpmOf;

// A story's pages: the text split on lines that are exactly `***`. A story with no page breaks is one page.
function localPassagePages(text) {
  const pages = [[]];
  for (const line of String(text || '').split('\n')) {
    if (line.trim() === '***') pages.push([]);
    else pages[pages.length - 1].push(line);
  }
  return pages.map((lines) => lines.join('\n')).filter((page) => page.trim());
}

export const passagePages = logic.passagePages || localPassagePages;

// ---- small pieces shared with the level page -------------------------------

function fail(err) {
  toast(err.status === 401 ? 'Your PIN timed out. Tap Done and come back in.' : err.message);
}

function statBox(value, label) {
  return h('div', { class: 'stat-box' }, h('div', { class: 'stat-value' }, value), h('div', { class: 'stat-label' }, label));
}

// Rounded DOWN, like the Levels page, so 94.6% never reads "95%".
function percent(share) {
  return `${Math.floor(share * 100 + 1e-9)}%`;
}

// The share of words read right on one read.
export function accuracyOf(read) {
  return read && read.words ? percent((read.words - read.errors) / read.words) : '–';
}

// Seconds as m:ss ("1:12"). A read by himself has no time.
export function clockTime(seconds) {
  if (seconds == null || !(seconds > 0)) return '–';
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function modeChip(mode) {
  return mode === 'scored' ? h('span', { class: 'lvl lvl-open' }, 'scored') : h('span', { class: 'lvl' }, 'self');
}

// The store's read summaries (deck id → { count, scored, best, lastAt, last }); {} on a build without them.
export function summaries() {
  const reads = store.state.reads;
  return reads && typeof reads === 'object' ? reads : {};
}

// How many stories (decks that still exist) have been read at least once.
export function storiesRead(reads = summaries()) {
  return Object.entries(reads).filter(([id, s]) => s && s.count > 0 && store.state.deckById.has(id)).length;
}

// The reading report, or null on a build whose store cannot fetch one yet.
export function loadReport() {
  if (typeof store.getReadingReport !== 'function') return Promise.resolve(null);
  return store.getReadingReport();
}

// The newest scored read in a list of reads (summary `last` objects or report reads).
function latestScored(reads) {
  let found = null;
  for (const r of reads) if (r && r.mode === 'scored' && (!found || (r.at || 0) > (found.at || 0))) found = r;
  return found;
}

// The words missed most often across a list of reads, as "word ×3" text, at most `n` of them.
function topMissed(reads, n = 5) {
  const counts = new Map();
  for (const r of reads) for (const w of (Array.isArray(r.missed) ? r.missed : [])) counts.set(w, (counts.get(w) || 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([w, k]) => (k > 1 ? `${w} ×${k}` : w));
}

// Every read of one story, newest first (also used on the level page).
export function readsTable(reads) {
  return h('table', { class: 'table' },
    h('thead', null, h('tr', null, ['When', 'Mode', 'Missed / words', 'Time', 'WPM', 'Missed words'].map((t) => h('th', null, t)))),
    h('tbody', null, reads.map((r) => h('tr', null,
      h('td', null, dateTime(r.at)),
      h('td', null, modeChip(r.mode)),
      h('td', null, `${r.errors} / ${r.words}`),
      h('td', null, clockTime(r.seconds)),
      h('td', null, r.mode === 'scored' && r.wcpm != null ? String(r.wcpm) : '–'),
      h('td', null, Array.isArray(r.missed) && r.missed.length ? r.missed.join(', ') : h('span', { class: 'muted' }, 'none'))))));
}

// The subjects that hold stories, each with its story decks in path order. A deck hidden from the
// child is off the path (no number) but still listed, so no read is ever out of sight.
function storySubjects() {
  return store.state.subjects.map((sub) => {
    const every = store.decksOf(sub.id, { includeHidden: true });
    const shown = store.decksOf(sub.id);
    if (!every.some((d) => d.passage)) return null;
    const rows = [];
    shown.forEach((d, i) => { if (d.passage) rows.push({ sub, deck: d, number: String(i + 1), hidden: false }); });
    for (const d of every) if (d.passage && !shown.includes(d)) rows.push({ sub, deck: d, number: '–', hidden: true });
    return { sub, rows };
  }).filter(Boolean);
}

// ---- the page --------------------------------------------------------------

function intro(name) {
  // Grade 1 oral reading fluency "At Benchmark" goals, middle and end of year: words correct per minute
  // and accuracy (DIBELS 8th Edition benchmark goals, University of Oregon, July 2020; NC's mCLASS uses them).
  const MOY = 21;
  const EOY = 39;
  const ACC_MOY = '87%';
  const ACC_EOY = '91%';
  return h('div', { class: 'notice', style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
    h('p', null, h('strong', null, 'What this is. '), `Every story level has a 📖 Read button. ${name} reads the story from the tablet; `,
      'a tap on any word says it out loud and keeps it as a word he asked for. At the end he taps ',
      h('strong', null, '👍 I read it!'), ' and earns a star.'),
    h('p', null, h('strong', null, 'Scoring a read. '), 'On the story screen tap ', h('strong', null, 'Grown-up: score this read'),
      ', then ', h('strong', null, 'Start'), ' as he begins. Tap each word he reads wrong (tap again to undo). Tap ',
      h('strong', null, 'Finished'), ' when he stops. The tablet works out words correct per minute; he only sees stars, never a timer or a number.'),
    h('p', null, h('strong', null, 'What the numbers mean. '), 'WPM is words correct per minute: the words in the story minus the misses, ',
      'divided by the minutes it took. It is the same measure as the mCLASS/DIBELS check used in NC schools. Accuracy is the share of ',
      `words read right. First-graders are on track at ${MOY} words correct per minute in the middle of the year and ${EOY} by the end of the year, `,
      `with accuracy of ${ACC_MOY} and ${ACC_EOY} (DIBELS 8 benchmarks). Those are the floor for "on track", not a target: a typical first-grader reads about 29 in winter and 60 in spring.`),
    h('p', null, h('strong', null, 'Accuracy comes first: '), 'a child who reads slowly but correctly is on the right track; speed grows with repeated reading. ',
      'Read the same story three times (cold, warm, hot) and watch the number climb.'));
}

export function draw(body, scope) {
  const { state } = store;
  const name = state.profile.name || 'Your child';
  const groups = storySubjects();
  const stories = groups.flatMap((g) => g.rows);
  const first = groups.length ? groups[0].sub : null;
  const sums = summaries();
  const all = Object.values(sums).filter(Boolean);
  const readsAll = all.reduce((n, s) => n + (s.count || 0), 0);
  let bestAll = null;
  for (const s of all) if (typeof s.best === 'number' && (bestAll == null || s.best > bestAll)) bestAll = s.best;
  const latestFromSums = latestScored(all.map((s) => s.last));

  const latestBox = statBox(latestFromSums ? String(latestFromSums.wcpm) : '–',
    latestFromSums ? `latest words per minute · ${dateTime(latestFromSums.at)}` : 'latest words per minute');
  const wordsBox = statBox('…', 'words to practice');

  // With one story subject the buttons go straight to it; with more (Stories, Story Time) to the lists.
  const one = groups.length === 1 ? first : null;
  appendAll(body,
    h('div', { class: 'page-head' },
      h('h1', null, 'Reading'),
      h('span', { class: 'spacer' }),
      first ? h('a', { class: 'btn', href: one ? `#/grownups/levels/${one.id}` : '#/grownups/levels' }, 'Story levels') : null,
      first ? h('a', { class: 'btn', href: one ? `#/lessons/${one.id}` : '#/lessons' }, 'Lesson plans') : null),
    intro(name));

  if (!stories.length) {
    body.append(h('p', { class: 'muted' }, 'No story levels yet. A story is a deck with a passage (see CONTENT.md); ',
      'as soon as one is read, it shows up here with every read and the words to practice.'));
    return;
  }

  const tbody = h('tbody');
  const wordsPanel = h('div', { class: 'panel' }, h('h2', null, 'Words to practice'), h('p', { class: 'muted' }, 'Loading…'));

  appendAll(body,
    h('div', { class: 'stat-row' },
      statBox(`${storiesRead(sums)} / ${stories.length}`, 'stories read'),
      statBox(String(readsAll), 'reads in all'),
      statBox(bestAll == null ? '–' : String(bestAll), 'best words per minute'),
      latestBox,
      wordsBox),
    h('div', { class: 'panel' },
      h('h2', null, 'Every story'),
      h('p', { class: 'muted' }, 'Reads counts every pass through a story, by himself or scored. WPM comes from scored reads only; ',
        'accuracy is the share of words read right on the last scored read. Missed words are the ones tapped for help or marked wrong, ',
        'most often first. Tap a story for every read of it.'),
      h('table', { class: 'table' },
        h('thead', null, h('tr', null, ['#', 'Story', 'Reads', 'Last read', 'Last WPM', 'Best WPM', 'Accuracy', 'Missed words']
          .map((t) => h('th', null, t)))),
        tbody)),
    wordsPanel);

  // The table from what is at hand; drawn again once the report brings the history. With more
  // than one story subject (Stories, Story Time) each gets a header row.
  const fillRows = (report) => {
    clear(tbody);
    const byDeck = report ? new Map((report.decks || []).map((e) => [e.deck, e])) : null;
    for (const { sub, rows } of groups) {
      if (groups.length > 1) {
        tbody.append(h('tr', null, h('td', { colspan: 8 }, h('strong', null, `${sub.emoji} ${sub.title}`),
          h('span', { class: 'muted small' }, ` · ${rows.length} ${rows.length === 1 ? 'story' : 'stories'}`))));
      }
      for (const { deck, number, hidden } of rows) {
        const entry = byDeck ? byDeck.get(deck.id) : null;
        const s = sums[deck.id] || (entry && entry.summary) || null;
        const count = s ? s.count || 0 : 0;
        const last = s && s.last ? s.last : null;
        const reads = entry ? (entry.reads || []) : null;
        const lastScored = reads ? latestScored(reads) : last && last.mode === 'scored' ? last : null;
        const waiting = !report && count > 0;         // the report has not arrived yet
        const missed = reads ? topMissed(reads) : [];
        tbody.append(h('tr', { class: hidden ? 'row-off' : '' },
          h('td', null, number),
          h('td', null,
            h('a', { href: `#/grownups/level/${deck.id}` }, `${deck.emoji || ''} ${deck.title}`),
            hidden ? [' ', h('span', { class: 'lvl lvl-hidden' }, 'hidden')] : null),
          h('td', null, String(count)),
          h('td', null, last ? [dateTime(last.at), ' ', modeChip(last.mode)] : '–'),
          h('td', null, lastScored ? String(lastScored.wcpm) : waiting && !lastScored ? '…' : '–'),
          h('td', null, s && typeof s.best === 'number' ? String(s.best) : '–'),
          h('td', null, lastScored ? accuracyOf(lastScored) : waiting ? '…' : '–'),
          h('td', null, missed.length ? missed.join(', ') : waiting ? '…' : '–')));
      }
    }
  };
  fillRows(null);

  loadReport().then((report) => {
    if (!scope.alive) return;
    if (!report) {
      // A server without the reading report: the summary columns stand, the rest is simply not there.
      fillRows({ decks: [] });
      wordsBox.firstChild.textContent = '–';
      clear(wordsPanel).append(h('h2', null, 'Words to practice'),
        h('p', { class: 'muted' }, 'The read history is not available on this server yet.'));
      return;
    }
    fillRows(report);
    const everyRead = (report.decks || []).flatMap((e) => e.reads || []);
    const latest = latestScored(everyRead);
    latestBox.firstChild.textContent = latest ? String(latest.wcpm) : '–';
    latestBox.lastChild.textContent = latest ? `latest words per minute · ${dateTime(latest.at)}` : 'latest words per minute';
    const missed = Array.isArray(report.missed) ? report.missed : [];
    wordsBox.firstChild.textContent = String(missed.length);

    // Every read of every story, one fold-out per story in path order.
    const byDeck = new Map((report.decks || []).map((e) => [e.deck, e]));
    for (const { deck } of stories) {
      const entry = byDeck.get(deck.id);
      const reads = entry ? (entry.reads || []) : [];
      if (!reads.length) continue;
      body.insertBefore(h('details', { class: 'panel' },
        h('summary', null, h('h2', null, `${deck.emoji || ''} ${deck.title}`),
          h('span', { class: 'muted' }, `${reads.length} ${reads.length === 1 ? 'read' : 'reads'}`)),
        readsTable(reads)), wordsPanel);
    }

    clear(wordsPanel).append(h('h2', null, 'Words to practice'));
    if (!missed.length) {
      wordsPanel.append(h('p', null, readsAll || everyRead.length
        ? '🎉 No words tapped for help or marked wrong yet.'
        : 'The words he taps for help, or you mark wrong while scoring, collect here.'));
    } else {
      wordsPanel.append(
        h('p', { class: 'muted' }, 'Every word tapped for help or marked wrong, most often first. Write them on cards, find them in the story again, and read it once more.'),
        h('div', { class: 'form-actions' }, missed.map((m) =>
          h('span', { class: 'lvl lvl-notyet' }, m.times > 1 ? `${m.word} ×${m.times}` : m.word))));
    }
  }).catch((err) => {
    if (!scope.alive) return;
    fail(err);
    // The summary columns stand on their own; the history and the words to practice did not arrive.
    fillRows({ decks: [] });
    wordsBox.firstChild.textContent = '–';
    clear(wordsPanel).append(h('h2', null, 'Words to practice'),
      h('p', { class: 'muted' }, 'The read history could not be loaded just now. Open Reading again to retry.'));
  });
}
