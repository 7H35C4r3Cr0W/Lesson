// Everything the app knows right now (cards, the child, progress) and the
// actions that change it. Screens read `state` and call these functions; they
// never talk to the server themselves.

import * as api from './api.js';
import { addRead, addRound, applyResult, dayString, isTrouble } from './logic.js';

export const DEFAULT_PREFS = Object.freeze({
  sessionSize: 10,        // questions in one practice round
  newPerSession: 4,       // brand-new cards mixed into a round
  sound: true,            // dings and pops
  speech: true,           // the reading voice (master switch)
  voiceMode: 'help',      // 'help' = only when needed; 'full' = read titles, questions and choices too
  speechRate: 0.85,       // the quiz voice (a six-year-old needs it slow; a saved value is kept)
  readRate: 0.7,          // the story voice: Read to me, word taps, sounding out, the Word Card, My words
  readChoices: true,      // in 'full' mode: read answer choices aloud outside the reading subjects
  gamesNeedPractice: false,
  freeRoam: false,        // true = every level open; false = finish a level to open the next
  testOut: true,          // tapping a locked level offers one round that can open every level up to it
  helper: true,           // show the 🙋 button when the Pi has a local model set up
  theme: 'night',         // 'night' (calm dark) or 'day' (soft cream)
  hiddenDecks: [],
});

export const state = {
  ready: false,
  online: true,
  version: '',
  subjects: [],
  decks: [],
  deckById: new Map(),
  cardById: new Map(),      // card id -> { card, deck }
  profiles: [],
  profile: null,
  stats: {},
  flags: [],
  tests: [],                // tests waiting to be taken
  days: {},                 // 'YYYY-MM-DD' -> { total, correct }
  rounds: {},               // deck id -> { best, last, count, lastAt, lastCorrect, lastTotal, passed }
  reads: {},                // deck id -> { count, scored, best, lastAt, last } (story reads, see logic.addRead)
  books: {},                // deck id -> { read: true, at } (books a grown-up ticked as read, see setBookRead)
  stars: 0,
  pinSet: false,
};

const PROFILE_KEY = 'starcards.profile';
const FINISH_KEY = 'starcards.finishes.v1';
const ROUNDS_KEY = 'starcards.rounds.v1';
const READS_KEY = 'starcards.reads.v1';

const listeners = new Set();
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(what) {
  for (const fn of Array.from(listeners)) fn(what);
}

// ---- derived views of the state --------------------------------------------

export function prefs() {
  return { ...DEFAULT_PREFS, ...((state.profile && state.profile.prefs) || {}) };
}

// Cards a grown-up reported as wrong are hidden from the child everywhere.
export function hiddenCards() {
  return new Set(state.flags.filter((f) => f.kind === 'issue').map((f) => f.card));
}

export function practiceFlags() {
  return new Set(state.flags.filter((f) => f.kind === 'practice').map((f) => f.card));
}

export function hiddenDecks() {
  return new Set(prefs().hiddenDecks);
}

export function flagFor(cardId, kind) {
  return state.flags.find((f) => f.card === cardId && f.kind === kind) || null;
}

// The decks the child can see in a subject (or all of them for the grown-up screens).
export function decksOf(subjectId, { includeHidden = false } = {}) {
  const hidden = hiddenDecks();
  return state.decks.filter((d) => d.subject === subjectId && (includeHidden || !hidden.has(d.id)));
}

export function visibleDecks() {
  const hidden = hiddenDecks();
  return state.decks.filter((d) => !hidden.has(d.id));
}

export function subjectById(id) {
  return state.subjects.find((sub) => sub.id === id) || null;
}

// Every card that currently needs extra practice, newest miss first.
export function troubleList() {
  const flagged = practiceFlags();
  const hidden = hiddenCards();
  const hiddenD = hiddenDecks();
  const out = [];
  for (const [id, entry] of state.cardById) {
    if (hidden.has(id) || hiddenD.has(entry.deck.id)) continue;      // skip decks the parent hid
    const stat = state.stats[id];
    const auto = isTrouble(stat);
    if (auto || flagged.has(id)) out.push({ ...entry, stat: stat || null, auto, flagged: flagged.has(id) });
  }
  out.sort((a, b) => ((b.stat && b.stat.at) || 0) - ((a.stat && a.stat.at) || 0));
  return out;
}

// What every level-path call needs: hidden cards, the open-every-level switch, the round scores.
export function levelOpts() {
  return { hidden: hiddenCards(), freeRoam: prefs().freeRoam, rounds: state.rounds };
}

// ---- loading ---------------------------------------------------------------

function indexContent(content) {
  state.version = content.version || '';
  state.subjects = content.subjects || [];
  state.decks = content.decks || [];
  state.deckById = new Map(state.decks.map((d) => [d.id, d]));
  state.cardById = new Map();
  for (const deck of state.decks) for (const card of deck.cards) state.cardById.set(card.id, { card, deck });
}

function applyState(data) {
  state.profile = data.profile;
  state.stats = data.stats || {};
  state.flags = data.flags || [];
  state.tests = data.tests || [];
  state.days = data.days || {};
  state.rounds = data.rounds || {};
  state.reads = data.reads || {};
  state.books = data.books || {};
  state.stars = data.stars || 0;
  state.pinSet = !!data.pinSet;
}

export async function boot() {
  const [content, people] = await Promise.all([api.get('/content.json'), api.get('/api/profiles')]);
  indexContent(content);
  state.profiles = people.profiles;
  state.pinSet = !!people.pinSet;
  const saved = api.storage.get(PROFILE_KEY);
  const chosen = state.profiles.find((p) => p.id === saved) || state.profiles[0];
  await loadProfile(chosen.id);
  state.ready = true;
  api.flush();
  flushFinishes();
  flushRounds();
  flushReads();
}

export async function loadProfile(id) {
  applyState(await api.get(`/api/state?profile=${id}`));
  api.storage.set(PROFILE_KEY, id);
  emit('profile');
}

export async function refresh() {
  if (!state.profile) return;
  const people = await api.get('/api/profiles');
  state.profiles = people.profiles;
  await loadProfile(state.profile.id);
}

// ---- answers ---------------------------------------------------------------

// Record one answer. The screen updates at once from our own copy of the rules;
// the server's copy arrives a moment later and wins.
export function record({ card, mode, correct, chosen = null, ms = null }) {
  const now = Date.now();
  const today = dayString(new Date(now));
  if (mode !== 'game') state.stats[card] = applyResult(state.stats[card], correct, now);
  if (correct) state.stars += 1;
  const day = state.days[today] || { total: 0, correct: 0 };
  state.days[today] = { total: day.total + 1, correct: day.correct + (correct ? 1 : 0) };
  api.enqueue(state.profile.id, {
    uid: api.newUid(), card, mode, correct, chosen, ms: ms == null ? null : Math.round(ms), at: now, day: today,
  });
  emit('stats');
}

function mergeServerStats(reply) {
  // Skip cards with answers still waiting to be sent: the server has not seen those yet.
  const waiting = api.queuedCards();
  for (const [card, stat] of Object.entries(reply.stats || {})) {
    if (!waiting.has(card)) state.stats[card] = stat;
  }
  // A star is a right answer or a story read: the Pi's count is only right once both queues are empty.
  if (!waiting.size && !readsWaiting() && typeof reply.stars === 'number') state.stars = reply.stars;
}

api.onQueueSynced((profileId, reply) => {
  if (!state.profile || profileId !== state.profile.id) return;
  mergeServerStats(reply);
  emit('stats');
});

api.onConnection((online) => {
  if (state.online !== online) {
    state.online = online;
    emit('online');
  }
});

// ---- rounds ----------------------------------------------------------------

// A finished Play round on a level: the score that decides whether the level is passed.
// The screen updates at once from our own copy of the rule; the round goes to the Pi from a
// queue in the tablet's storage, so a Wi-Fi blip cannot lose it.
//   mode: 'practice' (a round on the level) or 'testout' (one round that covers several levels)
export function recordRound({ deck, total, correct, mode = 'practice' }) {
  const now = Date.now();
  state.rounds[deck] = addRound(state.rounds[deck], correct, total, now);
  const waiting = api.storage.get(ROUNDS_KEY, []);
  const list = Array.isArray(waiting) ? waiting : [];
  list.push({ profile: state.profile.id, round: {
    uid: api.newUid(), deck, total, correct, mode, at: now, day: dayString(new Date(now)),
  } });
  api.storage.set(ROUNDS_KEY, list.slice(-200));
  emit('stats');
  flushRounds();
  return state.rounds[deck];
}

let sendingRounds = false;
export async function flushRounds() {
  if (sendingRounds) return;
  sendingRounds = true;
  try {
    for (;;) {
      const waiting = api.storage.get(ROUNDS_KEY, []);
      if (!Array.isArray(waiting) || !waiting.length) return;
      const item = waiting[0];
      let reply = null;
      try {
        reply = await api.post('/api/rounds', { profile: item.profile, ...item.round });
      } catch (err) {
        if (err.status === 0 || err.status >= 500) return;        // the Pi is away; try again later
        console.warn('Dropping a round the server refused:', err.message);
      }
      if (reply && reply.rounds && state.profile && item.profile === state.profile.id) mergeRounds(reply.rounds);
      // Re-read before removing: a new round may have joined the queue while we were sending.
      const now = api.storage.get(ROUNDS_KEY, []);
      api.storage.set(ROUNDS_KEY, (Array.isArray(now) ? now : []).filter((w) => w.round.uid !== item.round.uid));
    }
  } finally {
    sendingRounds = false;
  }
}

// The Pi's summary wins, except it cannot know yet about rounds still waiting in the queue.
function mergeRounds(summary) {
  for (const [deck, s] of Object.entries(summary)) {
    const mine = state.rounds[deck];
    state.rounds[deck] = mine && mine.count > s.count ? mine : s;
  }
  emit('stats');
}

export const getDeckReport = (deckId) =>
  api.get(`/api/decks/${encodeURIComponent(deckId)}/report?profile=${state.profile.id}`);

// ---- story reads -----------------------------------------------------------

// A finished read of a story on the Read screen. Every read earns one star. Like rounds, the
// screen updates at once from our own copy of the rule and the read goes to the Pi from a
// queue in the tablet's storage, so a Wi-Fi blip cannot lose it.
//   mode: 'self' (the child read it; errors = words he tapped for help) or
//         'scored' (a grown-up timed it and tapped the words read wrong; seconds required)
//   missed: the words (lower-case) tapped for help or marked wrong
export function recordRead({ deck, mode, words, errors, seconds = null, missed = [] }) {
  const now = Date.now();
  const secs = mode === 'scored' ? seconds : null;
  state.reads[deck] = addRead(state.reads[deck], { mode, words, errors, seconds: secs, at: now });
  state.stars += 1;
  const waiting = api.storage.get(READS_KEY, []);
  const list = Array.isArray(waiting) ? waiting : [];
  list.push({ profile: state.profile.id, read: {
    uid: api.newUid(), deck, mode, words, errors, seconds: secs, missed: missed.slice(0, 60), at: now, day: dayString(new Date(now)),
  } });
  api.storage.set(READS_KEY, list.slice(-200));
  emit('stats');
  flushReads();
  return state.reads[deck];
}

let sendingReads = false;
export async function flushReads() {
  if (sendingReads) return;
  sendingReads = true;
  try {
    for (;;) {
      const waiting = api.storage.get(READS_KEY, []);
      if (!Array.isArray(waiting) || !waiting.length) return;
      const item = waiting[0];
      let reply = null;
      try {
        reply = await api.post('/api/reads', { profile: item.profile, ...item.read });
      } catch (err) {
        if (err.status === 0 || err.status >= 500) return;        // the Pi is away; try again later
        console.warn('Dropping a read the server refused:', err.message);
      }
      // Re-read before removing: a new read may have joined the queue while we were sending.
      const now = api.storage.get(READS_KEY, []);
      const left = (Array.isArray(now) ? now : []).filter((w) => w.read.uid !== item.read.uid);
      api.storage.set(READS_KEY, left);
      if (reply && state.profile && item.profile === state.profile.id) {
        if (reply.reads) mergeReads(reply.reads);
        // The Pi's star count is right once it has seen everything: no reads left in this
        // queue and no answers still waiting in theirs (a star is an answer or a read).
        if (typeof reply.stars === 'number' && !left.length && !api.queueLength()) state.stars = reply.stars;
        emit('stats');
      }
    }
  } finally {
    sendingReads = false;
  }
}

// Reads still waiting for the Pi: their stars are on the screen but not in the Pi's count yet.
function readsWaiting() {
  const waiting = api.storage.get(READS_KEY, []);
  return Array.isArray(waiting) ? waiting.length : 0;
}

// The Pi's summary wins, except it cannot know yet about reads still waiting in the queue.
function mergeReads(summary) {
  for (const [deck, s] of Object.entries(summary)) {
    const mine = state.reads[deck];
    state.reads[deck] = mine && mine.count > s.count ? mine : s;
  }
}

export const getReadingReport = () => api.get(`/api/reading/report?profile=${state.profile.id}`);

// ---- the book checklist ----------------------------------------------------

// A grown-up ticks "we read this book" for this child (any level with a `book` or a story), or
// unticks it. The screen updates at once; the Pi's list arrives a moment later and wins. If the Pi
// says no, the tick goes back to what it was and the error is rethrown for the screen to show.
export async function setBookRead(deckId, read) {
  const pid = state.profile.id;
  const before = state.books[deckId];
  if (read) state.books[deckId] = { read: true, at: Date.now() };
  else delete state.books[deckId];
  emit('books');
  let reply;
  try {
    reply = await api.put(`/api/books/${encodeURIComponent(deckId)}`, { profile: pid, read: !!read });
  } catch (err) {
    if (state.profile && state.profile.id === pid) {       // unless another child was picked meanwhile
      if (before === undefined) delete state.books[deckId];
      else state.books[deckId] = before;
      emit('books');
    }
    throw err;
  }
  if (state.profile && state.profile.id === pid) {
    state.books = reply.books || {};
    emit('books');
  }
}

// ---- tests -----------------------------------------------------------------

// Hand in a finished test. If the Pi cannot be reached the result is kept on the
// tablet and handed in the next time the app opens.
export async function finishTest(testId, results, started) {
  const payload = { profile: state.profile.id, started, day: dayString(new Date()), results };
  state.tests = state.tests.filter((t) => t.id !== testId);
  try {
    const reply = await api.post(`/api/tests/${testId}/finish`, payload);
    mergeServerStats(reply);
    emit('stats');
    return reply.test;
  } catch (err) {
    if (err.status === 0 || err.status >= 500) {
      const waiting = api.storage.get(FINISH_KEY, []);
      const list = Array.isArray(waiting) ? waiting : [];
      list.push({ testId, payload });
      api.storage.set(FINISH_KEY, list);
      return null;
    }
    throw err;
  }
}

let sendingFinishes = false;
export async function flushFinishes() {
  if (sendingFinishes) return;
  sendingFinishes = true;
  let handled = 0;
  try {
    for (;;) {
      const waiting = api.storage.get(FINISH_KEY, []);
      if (!Array.isArray(waiting) || !waiting.length) break;
      const item = waiting[0];
      try {
        await api.post(`/api/tests/${item.testId}/finish`, item.payload);
      } catch (err) {
        if (err.status === 0 || err.status >= 500) break;      // the Pi is away; try again later
        // 404 / 409: the test was deleted or already handed in. Nothing left to do.
      }
      handled += 1;
      // Re-read before removing: a test handed in while we were sending must not be wiped.
      const now = api.storage.get(FINISH_KEY, []);
      api.storage.set(FINISH_KEY, (Array.isArray(now) ? now : []).filter((w) => w.testId !== item.testId));
    }
  } finally {
    sendingFinishes = false;
  }
  if (handled && state.profile) await loadProfile(state.profile.id);
}

// Was the app redeployed with new or edited decks since this page loaded?
export async function checkForUpdate() {
  try {
    const ping = await api.get('/api/ping');
    return !!(ping.content && state.version && ping.content !== state.version);
  } catch {
    return false;
  }
}

// A test handed in while the Pi was unreachable is kept on the tablet; send it as soon as
// the Pi is back, not only on the next full page load.
window.addEventListener('online', () => { flushFinishes(); flushRounds(); flushReads(); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { flushFinishes(); flushRounds(); flushReads(); }
});

export const listTests = () => api.get(`/api/tests?profile=${state.profile.id}`).then((r) => r.tests);
export const getTest = (id) => api.get(`/api/tests/${id}`).then((r) => r.test);
export const getReport = (days = 30) => api.get(`/api/report?profile=${state.profile.id}&days=${days}`);

export async function createTest(title, cards, config) {
  const reply = await api.post('/api/tests', { profile: state.profile.id, title, cards, config });
  const t = reply.test;
  state.tests.push({ id: t.id, title: t.title, config: t.config, cards: t.cards, created: t.created });
  emit('tests');
  return t;
}

export async function deleteTest(id) {
  await api.del(`/api/tests/${id}`);
  state.tests = state.tests.filter((t) => t.id !== id);
  emit('tests');
}

// ---- flags -----------------------------------------------------------------

export async function addFlag(card, kind, note = '') {
  const reply = await api.post('/api/flags', { profile: state.profile.id, card, kind, note });
  state.flags = state.flags.filter((f) => f.id !== reply.flag.id).concat(reply.flag);
  emit('flags');
  return reply.flag;
}

export async function removeFlag(id) {
  await api.del(`/api/flags/${id}`);
  state.flags = state.flags.filter((f) => f.id !== id);
  emit('flags');
}

export async function clearTrouble(card) {
  const reply = await api.post('/api/cards/clear-trouble', { profile: state.profile.id, card });
  Object.assign(state.stats, reply.stats);
  emit('stats');
}

// ---- the child and settings ------------------------------------------------

export async function saveProfile(changes) {
  const reply = await api.put(`/api/profiles/${state.profile.id}`, changes);
  state.profile = reply.profile;
  state.profiles = state.profiles.map((p) => (p.id === reply.profile.id ? reply.profile : p));
  emit('profile');
}

export function savePrefs(changes) {
  return saveProfile({ prefs: changes });
}

export async function setAvatar(avatar) {
  state.profile = { ...state.profile, avatar };
  emit('profile');
  await api.post(`/api/profiles/${state.profile.id}/avatar`, { avatar });
}

export async function addProfile(name, avatar) {
  const reply = await api.post('/api/profiles', { name, avatar });
  state.profiles.push(reply.profile);
  return reply.profile;
}

export async function removeProfile(id) {
  await api.del(`/api/profiles/${id}`);
  state.profiles = state.profiles.filter((p) => p.id !== id);
  if (state.profile.id === id) await loadProfile(state.profiles[0].id);
}

export async function resetProgress(scope, deck) {
  await api.post(`/api/profiles/${state.profile.id}/reset`, { scope, deck });
  await loadProfile(state.profile.id);
}

// ---- grown-up lock ---------------------------------------------------------

export async function unlockParent(pin) {
  const reply = await api.post('/api/parent/unlock', { pin });
  api.setParentToken(reply.token);
  return true;
}

export async function setPin(pin) {
  const reply = await api.post('/api/parent/pin', { pin });
  state.pinSet = reply.pinSet;
  api.setParentToken(reply.token);
}

export function lockParent() {
  api.setParentToken(null);
}

export const exportData = () => api.get('/api/export');
