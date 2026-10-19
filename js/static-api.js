// A stand-in for server.py for the copy of Star Cards published as a plain static site
// (GitHub Pages). There is no Pi and no database there: everything is kept in THIS browser's
// storage, so every visitor has their own private progress and nothing is shared with anyone
// (clear the browser's site data and it is gone). The 🙋 Help button is off, because it needs a
// model running on the family's own network. Requests and replies have the same shapes as
// server.py, so the rest of the app does not know the difference.

import { applyResult, dayString } from './logic.js';

const KEY = 'starcards.static.v1';
const APP = 'Star Cards';
const VERSION = '1.1.0';
const PASS_MARK = 0.85;
const MAX_PROFILES = 8;
const MAX_ATTEMPTS = 6000;          // oldest answers fall off; stars are kept in a counter
const MAX_TEST_CARDS = 100;
const DAY_MS = 86400000;
const MODES = ['learn', 'practice', 'test', 'game'];
const UID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

class StaticError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let content = null;          // { raw, decks: Map, cards: Map(cardId -> { deck, kind, card }) }
let db = null;
const seenUids = new Map();  // profile id -> Set of attempt uids (not persisted; rebuilt on load)

// ---- storage ---------------------------------------------------------------

function emptyData() {
  return { stats: {}, attempts: [], rounds: [], reads: [], tests: [], flags: [], books: {}, stars: 0 };
}

function fresh() {
  return { profiles: [{ id: 1, name: '', avatar: '🦊', prefs: {} }], nextId: 2, nextTestId: 1, nextFlagId: 1,
    issueFlags: [], pin: null, data: { 1: emptyData() } };
}

function load() {
  if (db) return;
  try {
    const raw = localStorage.getItem(KEY);
    db = raw ? JSON.parse(raw) : null;
  } catch {
    db = null;
  }
  if (!db || !Array.isArray(db.profiles) || !db.profiles.length) db = fresh();
  // A visitor's saved data may predate a list (reads came after rounds, the book ticks after reads):
  // fill in whatever is missing.
  for (const p of db.profiles) db.data[p.id] = Object.assign(emptyData(), db.data[p.id] || {});
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(db));
  } catch {
    /* storage full or blocked: the session still works in memory */
  }
}

async function ready() {
  load();
  if (content) return;
  const res = await fetch('content.json', { cache: 'no-store' });
  if (!res.ok) throw new StaticError(0, 'Cannot load the cards');
  const raw = await res.json();
  const decks = new Map();
  const cards = new Map();
  for (const deck of raw.decks || []) {
    decks.set(deck.id, deck);
    for (const card of deck.cards) cards.set(card.id, { deck: deck.id, kind: deck.kind, card });
  }
  content = { raw, decks, cards };
}

// ---- small helpers ---------------------------------------------------------

const now = () => Date.now();
const isInt = (v) => Number.isInteger(v);

function wantInt(obj, key, lo, hi, def) {
  const v = obj ? obj[key] : undefined;
  if (v === undefined && def !== undefined) return def;
  if (!isInt(v) || v < lo || v > hi) throw new StaticError(400, `'${key}' must be between ${lo} and ${hi}`);
  return v;
}

function wantStr(obj, key, max, { def = undefined, allowEmpty = true } = {}) {
  const v = obj ? obj[key] : undefined;
  if (v === undefined || v === null) {
    if (def !== undefined) return def;
    if (allowEmpty) return '';
    throw new StaticError(400, `'${key}' is missing`);
  }
  if (typeof v !== 'string') throw new StaticError(400, `'${key}' must be text`);
  const s = v.trim().slice(0, max);
  if (!s && !allowEmpty) throw new StaticError(400, `'${key}' is empty`);
  return s;
}

function clip(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function qInt(q, key, def, lo = 1, hi = 1e9) {
  const raw = q.get(key);
  if (raw === null) {
    if (def !== undefined) return def;
    throw new StaticError(400, `'${key}' is missing`);
  }
  const v = Number(raw);
  if (!isInt(v) || v < lo || v > hi) throw new StaticError(400, `'${key}' must be between ${lo} and ${hi}`);
  return v;
}

function cleanAt(at) {
  const t = now();
  return isInt(at) && Math.abs(at - t) <= DAY_MS ? at : t;
}

function cleanDay(day, at) {
  if (typeof day === 'string' && DAY_RE.test(day)) {
    const theirs = new Date(`${day}T12:00:00`).getTime();
    if (Math.abs(theirs - at) <= 2 * DAY_MS) return day;
  }
  return dayString(new Date(at));
}

function cardAnswer(card, kind) {
  return kind === 'read' ? card.text : card.a;
}

// Words correct per minute (same as wcpm_of in server.py and wcpmOf in logic.js); null without a time.
function wcpmOf(words, errors, seconds) {
  return isInt(seconds) && seconds > 0 ? Math.max(0, Math.round(((words - errors) / seconds) * 60)) : null;
}

// The words a read went wrong on: lower-case text only, at most 60 of 40 characters (as server.py keeps them).
function cleanMissed(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new StaticError(400, "'missed' must be a list of words");
  const out = [];
  for (const w of raw) {
    if (typeof w !== 'string') continue;
    const s = w.trim().toLowerCase().slice(0, 40);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= 60) break;
  }
  return out;
}

function findProfile(pid) {
  const p = db.profiles.find((x) => x.id === pid);
  if (!p) throw new StaticError(404, 'No such profile');
  return p;
}

function dataOf(pid) {
  findProfile(pid);
  if (!db.data[pid]) db.data[pid] = emptyData();
  return db.data[pid];
}

function uidsOf(pid) {
  if (!seenUids.has(pid)) seenUids.set(pid, new Set(dataOf(pid).attempts.map((a) => a.uid)));
  return seenUids.get(pid);
}

const profileJson = (p) => ({ id: p.id, name: p.name, avatar: p.avatar, prefs: { ...(p.prefs || {}) } });

function knownCards(ids, limit) {
  if (!Array.isArray(ids) || !ids.length) throw new StaticError(400, 'Pick at least one card');
  const out = [];
  for (const id of ids) {
    if (typeof id === 'string' && content.cards.has(id) && !out.includes(id)) out.push(id);
    if (out.length >= limit) break;
  }
  if (!out.length) throw new StaticError(400, 'No known cards');
  return out;
}

// ---- progress --------------------------------------------------------------

// Insert one attempt and fold it into the card's stats. Returns false for a replayed uid.
function record(pid, d, item, touched, testId = null) {
  const uids = uidsOf(pid);
  if (uids.has(item.uid)) return false;
  uids.add(item.uid);
  d.attempts.push({ uid: item.uid, card: item.card, deck: item.deck, mode: item.mode, correct: item.correct,
    chosen: item.chosen, ms: item.ms, test: testId, at: item.at, day: item.day });
  if (d.attempts.length > MAX_ATTEMPTS) d.attempts.splice(0, d.attempts.length - MAX_ATTEMPTS);
  if (item.correct) d.stars += 1;
  if (item.mode !== 'game') {
    d.stats[item.card] = applyResult(d.stats[item.card], item.correct, item.at);
    touched[item.card] = d.stats[item.card];
  }
  return true;
}

function roundSummary(d, deckId = null) {
  const out = {};
  const rounds = d.rounds.filter((r) => (r.mode === 'practice' || r.mode === 'testout') && (deckId === null || r.deck === deckId))
    .sort((a, b) => a.at - b.at);
  for (const r of rounds) {
    const score = r.total ? Math.round((r.correct / r.total) * 10000) / 10000 : 0;
    const s = out[r.deck] || (out[r.deck] = { best: 0, last: 0, count: 0, lastAt: 0, lastCorrect: 0, lastTotal: 0 });
    s.count += 1;
    s.best = Math.max(s.best, score);
    Object.assign(s, { last: score, lastAt: r.at, lastCorrect: r.correct, lastTotal: r.total });
  }
  for (const s of Object.values(out)) s.passed = s.best >= PASS_MARK;
  return out;
}

// Per story: reads so far, best words per minute of the scored ones, the latest read. Same shape as
// read_summary() in server.py and addRead() in logic.js. Reads go in time order (sort is stable, so
// two reads with the same stamp keep their arrival order, like the server's "ORDER BY at, id").
function readSummary(d, deckId = null) {
  const out = {};
  const reads = d.reads.filter((r) => deckId === null || r.deck === deckId).sort((a, b) => a.at - b.at);
  for (const r of reads) {
    const s = out[r.deck] || (out[r.deck] = { count: 0, scored: 0, best: null, lastAt: 0, last: null });
    s.count += 1;
    if (r.mode === 'scored') {
      s.scored += 1;
      if (r.wcpm !== null && (s.best === null || r.wcpm > s.best)) s.best = r.wcpm;
    }
    s.lastAt = r.at;
    s.last = { mode: r.mode, words: r.words, errors: r.errors, seconds: r.seconds, wcpm: r.wcpm, at: r.at };
  }
  return out;
}

// Per book a grown-up ticked as read for this child: that it was, and when (the first tick's time).
// Same shape as books_of() in server.py, in the same order (first tick first, then by deck id).
function booksOf(d) {
  const out = {};
  const ticks = Object.entries(d.books)
    .sort((a, b) => a[1].at - b[1].at || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [deck, b] of ticks) out[deck] = { read: true, at: b.at };
  return out;
}

function flagsOf(pid) {
  const d = dataOf(pid);
  return d.flags.concat(db.issueFlags).slice().sort((a, b) => b.at - a.at)
    .map((f) => ({ id: f.id, card: f.card, kind: f.kind, note: f.note, at: f.at }));
}

function testJson(t, full) {
  const out = { id: t.id, title: t.title, config: t.config, status: t.status, created: t.created,
    started: t.started, finished: t.finished, total: t.total == null ? t.cards.length : t.total, correct: t.correct };
  if (full) {
    out.profile = t.profile;
    out.cards = t.cards;
    out.results = t.results || [];
  }
  return out;
}

function findTest(id) {
  for (const p of db.profiles) {
    const t = (db.data[p.id] || emptyData()).tests.find((x) => x.id === id);
    if (t) return t;
  }
  throw new StaticError(404, 'No such test');
}

// ---- GET handlers ----------------------------------------------------------

function stateOf(pid) {
  const prof = findProfile(pid);
  const d = dataOf(pid);
  const since = dayString(new Date(now() - 60 * DAY_MS));
  const days = {};
  for (const a of d.attempts) {
    if (a.day < since) continue;
    const x = days[a.day] || (days[a.day] = { total: 0, correct: 0 });
    x.total += 1;
    if (a.correct) x.correct += 1;
  }
  return {
    profile: profileJson(prof), stats: d.stats, flags: flagsOf(pid),
    tests: d.tests.filter((t) => t.status === 'assigned')
      .map((t) => ({ id: t.id, title: t.title, config: t.config, cards: t.cards, created: t.created })),
    days, stars: d.stars, pinSet: !!db.pin, today: dayString(new Date()), rounds: roundSummary(d),
    reads: readSummary(d), books: booksOf(d),
  };
}

function report(pid, days) {
  const d = dataOf(pid);
  const since = dayString(new Date(now() - days * DAY_MS));
  const byDayMap = new Map();
  const byDeckMap = new Map();
  for (const a of d.attempts) {
    if (a.day < since) continue;
    const k = `${a.day}|${a.mode}`;
    const x = byDayMap.get(k) || { day: a.day, mode: a.mode, total: 0, correct: 0, ms: 0 };
    x.total += 1;
    x.correct += a.correct ? 1 : 0;
    x.ms += a.ms || 0;
    byDayMap.set(k, x);
    if (a.mode === 'game') continue;
    const y = byDeckMap.get(a.deck) || { deck: a.deck, total: 0, correct: 0, ms: 0, last: 0 };
    y.total += 1;
    y.correct += a.correct ? 1 : 0;
    y.ms += a.ms || 0;
    y.last = Math.max(y.last, a.at);
    byDeckMap.set(a.deck, y);
  }
  const byDay = Array.from(byDayMap.values()).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const misses = d.attempts.filter((a) => !a.correct && a.mode !== 'game').sort((a, b) => b.at - a.at).slice(0, 400)
    .map((a) => ({ card: a.card, deck: a.deck, mode: a.mode, chosen: a.chosen, at: a.at }));
  const rounds = d.rounds.slice().sort((a, b) => b.at - a.at).slice(0, 500)
    .map((r) => ({ deck: r.deck, mode: r.mode, total: r.total, correct: r.correct, day: r.day, at: r.at }));
  return { since, byDay, byDeck: Array.from(byDeckMap.values()), misses, rounds, passMark: PASS_MARK };
}

function deckReport(pid, deckId) {
  if (!content.decks.has(deckId)) throw new StaticError(404, 'Unknown deck');
  const d = dataOf(pid);
  const rounds = d.rounds.filter((r) => r.deck === deckId).sort((a, b) => b.at - a.at).slice(0, 200)
    .map((r) => ({ mode: r.mode, total: r.total, correct: r.correct, day: r.day, at: r.at }));
  const misses = d.attempts.filter((a) => a.deck === deckId && !a.correct && a.mode !== 'game')
    .sort((a, b) => b.at - a.at).slice(0, 500)
    .map((a) => ({ card: a.card, mode: a.mode, chosen: a.chosen, at: a.at }));
  return { deck: deckId, rounds, misses, summary: roundSummary(d, deckId)[deckId] || null, passMark: PASS_MARK };
}

// Every story read, for the grown-up Reading page: reads per story newest first (stories in order of
// their latest read, at most 50 reads each) and the words to practise, counted over every read.
function readingReport(pid) {
  const d = dataOf(pid);
  const summaries = readSummary(d);
  const perDeck = new Map();
  const words = new Map();
  // Newest first; reverse before the stable sort so same-stamp reads come latest-arrived first ("at DESC, id DESC").
  for (const r of d.reads.slice().reverse().sort((a, b) => b.at - a.at)) {
    for (const w of r.missed) {
      const x = words.get(w) || { word: w, times: 0, lastAt: 0 };
      x.times += 1;
      x.lastAt = Math.max(x.lastAt, r.at);
      words.set(w, x);
    }
    if (!perDeck.has(r.deck)) perDeck.set(r.deck, []);
    const reads = perDeck.get(r.deck);
    if (reads.length < 50) {
      reads.push({ mode: r.mode, words: r.words, errors: r.errors, seconds: r.seconds, wcpm: r.wcpm,
        missed: r.missed.slice(), day: r.day, at: r.at });
    }
  }
  const missed = Array.from(words.values())
    .sort((a, b) => b.times - a.times || b.lastAt - a.lastAt || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0))
    .slice(0, 60);
  const decks = Array.from(perDeck, ([deck, reads]) => ({ deck, summary: summaries[deck] || null, reads }));
  return { decks, missed, stars: d.stars };
}

function exportAll() {
  const out = { app: APP, version: VERSION, exported: now(), profiles: db.profiles.map(profileJson),
    card_stats: [], attempts: [], flags: db.issueFlags.map((f) => ({ ...f, profile_id: 0 })), tests: [], rounds: [],
    reads: [], books: [] };
  for (const p of db.profiles) {
    const d = dataOf(p.id);
    for (const [card, s] of Object.entries(d.stats)) out.card_stats.push({ profile_id: p.id, card_id: card, ...s });
    out.attempts.push(...d.attempts.map((a) => ({ profile_id: p.id, ...a })));
    out.flags.push(...d.flags.map((f) => ({ profile_id: p.id, ...f })));
    out.tests.push(...d.tests.map((t) => ({ profile_id: p.id, ...t })));
    out.rounds.push(...d.rounds.map((r) => ({ profile_id: p.id, ...r })));
    out.reads.push(...d.reads.map((r) => ({ profile_id: p.id, ...r })));
    for (const [deck, b] of Object.entries(d.books)) out.books.push({ profile_id: p.id, deck_id: deck, read: 1, at: b.at });
  }
  return out;
}

// ---- POST handlers ---------------------------------------------------------

function postAttempts(body) {
  const pid = wantInt(body, 'profile', 1, 1e9);
  const d = dataOf(pid);
  const items = body.attempts;
  if (!Array.isArray(items) || items.length > 500) throw new StaticError(400, 'Bad attempts list');
  const touched = {};
  let added = 0, skipped = 0;
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') throw new StaticError(400, 'Bad attempt');
    if (typeof raw.uid !== 'string' || !UID_RE.test(raw.uid)) throw new StaticError(400, 'Bad attempt id');
    if (!MODES.includes(raw.mode)) throw new StaticError(400, 'Bad attempt mode');
    if (typeof raw.correct !== 'boolean') throw new StaticError(400, 'Bad attempt result');
    const entry = typeof raw.card === 'string' ? content.cards.get(raw.card) : null;
    if (!entry) {
      skipped += 1;
      continue;
    }
    const ms = isInt(raw.ms) ? Math.max(0, Math.min(raw.ms, 3600000)) : null;
    const at = cleanAt(raw.at);
    if (record(pid, d, { uid: raw.uid, card: raw.card, deck: entry.deck, mode: raw.mode, correct: raw.correct,
      chosen: clip(raw.chosen, 200) || null, ms, at, day: cleanDay(raw.day, at) }, touched)) added += 1;
  }
  save();
  return { added, skipped, stats: touched, stars: d.stars };
}

function postRound(body) {
  const pid = wantInt(body, 'profile', 1, 1e9);
  const d = dataOf(pid);
  if (typeof body.uid !== 'string' || !UID_RE.test(body.uid)) throw new StaticError(400, 'Bad round id');
  if (typeof body.deck !== 'string' || !content.decks.has(body.deck)) throw new StaticError(400, 'Unknown deck');
  const total = wantInt(body, 'total', 1, 100);
  const correct = wantInt(body, 'correct', 0, 100);
  if (correct > total) throw new StaticError(400, 'correct cannot be more than total');
  const mode = body.mode === undefined ? 'practice' : body.mode;
  if (!['practice', 'testout', 'learn'].includes(mode)) throw new StaticError(400, 'Bad round mode');
  const at = cleanAt(body.at);
  if (!d.rounds.some((r) => r.uid === body.uid)) {
    d.rounds.push({ uid: body.uid, deck: body.deck, mode, total, correct, day: cleanDay(body.day, at), at });
    save();
  }
  return { rounds: roundSummary(d, body.deck) };
}

// One finished read of a story (same checks as h_reads in server.py). A replayed uid changes nothing.
function postRead(body) {
  const pid = wantInt(body, 'profile', 1, 1e9);
  const d = dataOf(pid);
  if (typeof body.uid !== 'string' || !UID_RE.test(body.uid)) throw new StaticError(400, 'Bad read id');
  const deck = typeof body.deck === 'string' ? content.decks.get(body.deck) : null;
  if (!deck) throw new StaticError(400, 'Unknown deck');
  if (!deck.passage || typeof deck.passage !== 'object') throw new StaticError(400, 'This level has no story');
  const mode = body.mode;
  if (mode !== 'self' && mode !== 'scored') throw new StaticError(400, 'Bad read mode');
  const words = wantInt(body, 'words', 1, 600);
  const errors = wantInt(body, 'errors', 0, 600);
  if (errors > words) throw new StaticError(400, 'errors cannot be more than words');
  const seconds = mode === 'scored' ? wantInt(body, 'seconds', 1, 1800) : null;
  const wcpm = mode === 'scored' ? wcpmOf(words, errors, seconds) : null;
  const missed = cleanMissed(body.missed);
  const at = cleanAt(body.at);
  if (!d.reads.some((r) => r.uid === body.uid)) {
    d.reads.push({ uid: body.uid, deck: deck.id, mode, words, errors, seconds, wcpm, missed,
      day: cleanDay(body.day, at), at });
    d.stars += 1;                 // every finished read earns a star, however it went
    save();
  }
  return { reads: readSummary(d, deck.id), stars: d.stars };
}

// A grown-up ticks "we read this book" for one child, or unticks it (same checks as h_book_set in
// server.py): any level that is a book (a `book` object) or carries a story (a `passage`) can be
// ticked. Ticking again keeps the first date; unticking forgets it.
function setBook(deckId, body) {
  const pid = wantInt(body, 'profile', 1, 1e9);
  const d = dataOf(pid);
  const deck = content.decks.get(deckId);
  const hasBook = !!deck && !!deck.book && typeof deck.book === 'object' && !Array.isArray(deck.book);
  if (!deck || !(hasBook || deck.passage)) throw new StaticError(400, 'Not a book');
  if (typeof body.read !== 'boolean') throw new StaticError(400, "'read' must be true or false");
  if (body.read) {
    if (!d.books[deckId]) d.books[deckId] = { read: true, at: now() };
  } else {
    delete d.books[deckId];
  }
  save();
  return { books: booksOf(d) };
}

function finishTest(testId, body) {
  const pid = wantInt(body, 'profile', 1, 1e9);
  const d = dataOf(pid);
  const results = body.results;
  if (!Array.isArray(results) || results.length > MAX_TEST_CARDS) throw new StaticError(400, 'Bad results list');
  const finished = now();
  let started = body.started;
  if (!isInt(started) || !(finished - started > 0 && finished - started < DAY_MS)) started = null;
  const day = cleanDay(body.day, finished);
  const t = d.tests.find((x) => x.id === testId);
  if (!t) throw new StaticError(404, 'No such test');
  if (t.status !== 'assigned') throw new StaticError(409, 'This test is already finished');
  const byCard = new Map();
  for (const raw of results) {
    const cid = raw && typeof raw === 'object' ? raw.card : null;
    if (typeof cid === 'string' && t.cards.includes(cid) && !byCard.has(cid)) byCard.set(cid, raw);
  }
  const touched = {};
  const saved = [];
  let right = 0;
  t.cards.forEach((cid, n) => {
    const raw = byCard.get(cid) || {};
    const entry = content.cards.get(cid);
    const chosen = clip(raw.chosen, 300) || null;
    const answer = entry ? cardAnswer(entry.card, entry.kind) : clip(raw.answer, 300);
    const correct = chosen !== null && chosen === answer;
    const ms = isInt(raw.ms) ? Math.max(0, Math.min(raw.ms, 3600000)) : null;
    const choices = Array.isArray(raw.choices) ? raw.choices.slice(0, 6).map((x) => clip(x, 300)) : [];
    saved.push({ card: cid, deck: entry ? entry.deck : clip(raw.deck, 80), prompt: clip(raw.prompt, 300), answer,
      chosen, choices, correct, ms });
    if (correct) right += 1;
    if (entry) {
      record(pid, d, { uid: `t${testId}-${n}`, card: cid, deck: entry.deck, mode: 'test', correct, chosen, ms,
        at: finished, day }, touched, testId);
    }
  });
  Object.assign(t, { status: 'done', started, finished, total: saved.length, correct: right, results: saved });
  save();
  return { test: testJson(t, true), stats: touched, stars: d.stars };
}

function createTest(body) {
  const pid = wantInt(body, 'profile', 1, 1e9);
  const d = dataOf(pid);
  const title = wantStr(body, 'title', 80, { def: 'Test' }) || 'Test';
  const cards = knownCards(body.cards, MAX_TEST_CARDS);
  const raw = body.config && typeof body.config === 'object' ? body.config : {};
  const decks = Array.isArray(raw.decks) ? raw.decks : [];
  const config = {
    decks: decks.filter((x) => typeof x === 'string' && content.decks.has(x)).slice(0, 400),
    source: ['all', 'trouble', 'learning', 'new', 'seen', 'missed', 'custom'].includes(raw.source) ? raw.source : 'all',
    feedback: !!raw.feedback,
    readAloud: raw.readAloud === undefined ? true : !!raw.readAloud,
  };
  const t = { id: db.nextTestId++, profile: pid, title, config, cards, status: 'assigned', created: now(),
    started: null, finished: null, total: null, correct: null, results: null };
  d.tests.push(t);
  save();
  return { test: testJson(t, true) };
}

function deleteTest(id) {
  for (const p of db.profiles) {
    const d = dataOf(p.id);
    const i = d.tests.findIndex((t) => t.id === id);
    if (i >= 0) {
      d.tests.splice(i, 1);
      save();
      return { ok: true };
    }
  }
  throw new StaticError(404, 'No such test');
}

function addFlag(body) {
  const kind = body.kind;
  if (!['practice', 'issue'].includes(kind)) throw new StaticError(400, 'Bad flag kind');
  if (typeof body.card !== 'string' || !content.cards.has(body.card)) throw new StaticError(400, 'Unknown card');
  const note = wantStr(body, 'note', 300, { def: '' });
  // "issue" means the card itself is wrong, which is true for every child, so it is stored once.
  const list = kind === 'issue' ? db.issueFlags : dataOf(wantInt(body, 'profile', 1, 1e9)).flags;
  let flag = list.find((f) => f.card === body.card && f.kind === kind);
  if (flag) flag.note = note;
  else {
    flag = { id: db.nextFlagId++, card: body.card, kind, note, at: now() };
    list.push(flag);
  }
  save();
  return { flag: { id: flag.id, card: flag.card, kind: flag.kind, note: flag.note, at: flag.at } };
}

function deleteFlag(id) {
  const lists = [db.issueFlags, ...db.profiles.map((p) => dataOf(p.id).flags)];
  for (const list of lists) {
    const i = list.findIndex((f) => f.id === id);
    if (i >= 0) {
      list.splice(i, 1);
      save();
      return { ok: true };
    }
  }
  throw new StaticError(404, 'No such flag');
}

function clearTrouble(body) {
  const pid = wantInt(body, 'profile', 1, 1e9);
  const d = dataOf(pid);
  const card = wantStr(body, 'card', 120, { allowEmpty: false });
  const s = d.stats[card];
  if (!s) return { stats: {} };
  s.recent = '';
  s.box = Math.max(s.box, 2);
  save();
  return { stats: { [card]: s } };
}

function cleanPrefs(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new StaticError(400, 'Bad prefs');
  const out = {};
  if ('sessionSize' in raw) out.sessionSize = wantInt(raw, 'sessionSize', 3, 30);
  if ('newPerSession' in raw) out.newPerSession = wantInt(raw, 'newPerSession', 1, 15);
  for (const key of ['sound', 'speech', 'readChoices', 'gamesNeedPractice', 'freeRoam', 'helper', 'testOut']) {
    if (key in raw) {
      if (typeof raw[key] !== 'boolean') throw new StaticError(400, `'${key}' must be true or false`);
      out[key] = raw[key];
    }
  }
  if ('theme' in raw) {
    if (!['night', 'day'].includes(raw.theme)) throw new StaticError(400, 'Bad theme');
    out.theme = raw.theme;
  }
  if ('voiceMode' in raw) {
    if (!['help', 'full', 'off'].includes(raw.voiceMode)) throw new StaticError(400, 'Bad voiceMode');
    out.voiceMode = raw.voiceMode;
  }
  // The quiz voice and the story voice (Read to me, word taps, sounding out) have their own speeds.
  for (const [key, lo, hi] of [['speechRate', 0.5, 1.5], ['readRate', 0.5, 1.2]]) {
    if (key in raw) {
      const r = raw[key];
      if (typeof r !== 'number' || !(r >= lo && r <= hi)) throw new StaticError(400, `Bad ${key}`);
      out[key] = Math.round(r * 100) / 100;
    }
  }
  if ('hiddenDecks' in raw) {
    if (!Array.isArray(raw.hiddenDecks) || raw.hiddenDecks.length > 1000) throw new StaticError(400, 'Bad hiddenDecks');
    out.hiddenDecks = Array.from(new Set(raw.hiddenDecks.filter((x) => typeof x === 'string' && x.length <= 80))).sort();
  }
  return out;
}

function createProfile(body) {
  if (db.profiles.length >= MAX_PROFILES) throw new StaticError(400, `At most ${MAX_PROFILES} children`);
  const p = { id: db.nextId++, name: wantStr(body, 'name', 24, { def: '' }),
    avatar: wantStr(body, 'avatar', 16, { def: '🦊' }) || '🦊', prefs: {} };
  db.profiles.push(p);
  db.data[p.id] = emptyData();
  save();
  return { profile: profileJson(p) };
}

function updateProfile(pid, body) {
  const p = findProfile(pid);
  p.name = wantStr(body, 'name', 24, { def: p.name });
  p.avatar = wantStr(body, 'avatar', 16, { def: p.avatar }) || p.avatar;
  if ('prefs' in body) p.prefs = { ...(p.prefs || {}), ...cleanPrefs(body.prefs) };
  save();
  return { profile: profileJson(p) };
}

function deleteProfile(pid) {
  if (db.profiles.length <= 1) throw new StaticError(400, 'Keep at least one child');
  findProfile(pid);
  db.profiles = db.profiles.filter((p) => p.id !== pid);
  delete db.data[pid];
  seenUids.delete(pid);
  save();
  return { ok: true };
}

function resetProfile(pid, body) {
  const d = dataOf(pid);
  const scope = body.scope;
  if (scope === 'all') {
    const kept = d.flags.filter((f) => f.kind !== 'practice');
    Object.assign(d, emptyData(), { flags: kept });
    seenUids.delete(pid);
  } else if (scope === 'deck') {
    const deck = typeof body.deck === 'string' ? content.decks.get(body.deck) : null;
    if (!deck) throw new StaticError(400, 'Unknown deck');
    for (const card of deck.cards) delete d.stats[card.id];
    d.rounds = d.rounds.filter((r) => r.deck !== deck.id);
    const kept = d.reads.filter((r) => r.deck !== deck.id);
    d.stars = Math.max(0, d.stars - (d.reads.length - kept.length));   // those reads' stars go with them
    d.reads = kept;
    delete d.books[deck.id];
  } else {
    throw new StaticError(400, 'scope must be all or deck');
  }
  save();
  return { ok: true };
}

function setAvatar(pid, body) {
  const p = findProfile(pid);
  p.avatar = wantStr(body, 'avatar', 16, { allowEmpty: false });
  save();
  return { ok: true };
}

function unlock(body) {
  if (!db.pin) return { token: null, pinSet: false };
  const pin = wantStr(body, 'pin', 8, { allowEmpty: false });
  if (pin !== db.pin) throw new StaticError(403, 'Wrong PIN');
  return { token: `static-${now()}`, pinSet: true };
}

function setPin(body) {
  if (body.pin === null || body.pin === undefined) {
    db.pin = null;
    save();
    return { pinSet: false, token: null };
  }
  if (typeof body.pin !== 'string' || !/^\d{4,8}$/.test(body.pin)) throw new StaticError(400, 'A PIN is 4 to 8 digits');
  db.pin = body.pin;
  save();
  return { pinSet: true, token: `static-${now()}` };
}

// ---- the dispatcher --------------------------------------------------------

export async function handle(method, path, body) {
  await ready();
  const url = new URL(path, location.href);
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const q = url.searchParams;
  const b = body && typeof body === 'object' ? body : {};
  let r;
  if (p === '/content.json') return content.raw;
  if (method === 'GET') {
    if (p === '/api/ping') {
      return { ok: true, app: APP, version: VERSION, content: content.raw.version, help: false, static: true };
    }
    if (p === '/api/profiles') return { profiles: db.profiles.map(profileJson), pinSet: !!db.pin };
    if (p === '/api/state') return stateOf(qInt(q, 'profile'));
    if (p === '/api/report') return report(qInt(q, 'profile'), qInt(q, 'days', 30, 1, 366));
    if ((r = p.match(/^\/api\/decks\/([\w.-]+)\/report$/))) return deckReport(qInt(q, 'profile'), r[1]);
    if (p === '/api/reading/report') return readingReport(qInt(q, 'profile'));
    if (p === '/api/tests') {
      const d = dataOf(qInt(q, 'profile'));
      return { tests: d.tests.slice().sort((x, y) => (y.finished || y.created) - (x.finished || x.created))
        .slice(0, 500).map((t) => testJson(t, false)) };
    }
    if ((r = p.match(/^\/api\/tests\/(\d+)$/))) return { test: testJson(findTest(Number(r[1])), true) };
    if (p === '/api/export') return exportAll();
  } else if (method === 'POST') {
    if (p === '/api/attempts') return postAttempts(b);
    if (p === '/api/rounds') return postRound(b);
    if (p === '/api/reads') return postRead(b);
    if ((r = p.match(/^\/api\/tests\/(\d+)\/finish$/))) return finishTest(Number(r[1]), b);
    if ((r = p.match(/^\/api\/profiles\/(\d+)\/avatar$/))) return setAvatar(Number(r[1]), b);
    if ((r = p.match(/^\/api\/profiles\/(\d+)\/reset$/))) return resetProfile(Number(r[1]), b);
    if (p === '/api/parent/unlock') return unlock(b);
    if (p === '/api/parent/pin') return setPin(b);
    if (p === '/api/help') throw new StaticError(503, 'The helper is not set up');
    if (p === '/api/tests') return createTest(b);
    if (p === '/api/flags') return addFlag(b);
    if (p === '/api/cards/clear-trouble') return clearTrouble(b);
    if (p === '/api/profiles') return createProfile(b);
  } else if (method === 'PUT') {
    if ((r = p.match(/^\/api\/profiles\/(\d+)$/))) return updateProfile(Number(r[1]), b);
    if ((r = p.match(/^\/api\/books\/([\w.-]+)$/))) return setBook(r[1], b);
  } else if (method === 'DELETE') {
    if ((r = p.match(/^\/api\/tests\/(\d+)$/))) return deleteTest(Number(r[1]));
    if ((r = p.match(/^\/api\/flags\/(\d+)$/))) return deleteFlag(Number(r[1]));
    if ((r = p.match(/^\/api\/profiles\/(\d+)$/))) return deleteProfile(Number(r[1]));
  }
  throw new StaticError(404, 'Not found');
}
