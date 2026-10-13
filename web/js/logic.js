// The learning rules, with no screen, network or clock attached, so every rule
// here can be unit tested (see web/tests). Anything random takes an rng and
// anything about time takes `now`.

export const EMPTY_STAT = Object.freeze({ seen: 0, correct: 0, wrong: 0, streak: 0, box: 0, recent: '', at: 0 });

const HOUR = 3600000;
const DAY = 24 * HOUR;
// How long a card rests after a right answer, by Leitner box. Box 1 (just missed) comes straight back.
export const BOX_WAIT_MS = [0, 0, 12 * HOUR, 2 * DAY, 5 * DAY, 12 * DAY];

// ---- one card's stats ------------------------------------------------------

// Fold one answer into a card's stats. Mirrors apply_result() in server.py;
// both are checked against tests/stat_vectors.json.
export function applyResult(stat, correct, at) {
  const s = stat || EMPTY_STAT;
  return {
    seen: s.seen + 1,
    correct: s.correct + (correct ? 1 : 0),
    wrong: s.wrong + (correct ? 0 : 1),
    streak: correct ? s.streak + 1 : 0,
    box: correct ? (s.box <= 0 ? 2 : Math.min(5, s.box + 1)) : 1,
    recent: (s.recent + (correct ? '1' : '0')).slice(-6),
    at,
  };
}

export function levelOf(stat) {
  if (!stat || !stat.seen) return 'new';
  return stat.box >= 4 ? 'mastered' : 'learning';
}

// "Trouble" = missed at least two of the last three tries. Two right in a row clears it.
export function isTrouble(stat) {
  if (!stat || stat.seen < 2) return false;
  const lastThree = stat.recent.slice(-3);
  return lastThree.split('0').length - 1 >= 2;
}

export function isDue(stat, now) {
  if (!stat || !stat.seen) return true;
  const box = Math.max(0, Math.min(5, stat.box));
  return now - stat.at >= BOX_WAIT_MS[box];
}

export function accuracy(stat) {
  return stat && stat.seen ? stat.correct / stat.seen : null;
}

// ---- randomness ------------------------------------------------------------

// Small seeded generator (mulberry32) so tests can replay a shuffle exactly.
export function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(list, rng) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---- cards -----------------------------------------------------------------

// A "read" deck is words or sentences to read: the text is the answer.
// A "qa" deck is questions: `a` is the answer.
export function answerOf(card, kind) {
  return kind === 'read' ? card.text : card.a;
}

export function promptOf(card, kind) {
  return kind === 'read' ? card.text : card.q;
}

export function canQuiz(card, deck) {
  return deck.quiz !== false && card.quiz !== false;
}

const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}]/gu;

export function stripEmoji(text) {
  return String(text).replace(EMOJI, '').replace(/\s{2,}/g, ' ').trim();
}

// Turn card text into something the tablet's voice reads well: no emoji names,
// and maths symbols as words.
export function speakable(text) {
  return stripEmoji(text)
    .replace(/_{2,}/g, ' blank ')
    .replace(/\s*\+\s*/g, ' plus ')
    .replace(/\s*−\s*/g, ' minus ')
    .replace(/(\d)\s*-\s*(?=\d)/g, '$1 minus ')
    .replace(/\s*=\s*\?/g, ' equals what')
    .replace(/\s*=\s*/g, ' equals ')
    .replace(/\s*>\s*/g, ' is greater than ')
    .replace(/\s*<\s*/g, ' is less than ')
    .replace(/\s*¢/g, ' cents')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// What the voice should say for the front and back of a card.
export function sayPrompt(card, kind) {
  if (kind === 'read') return card.say || speakable(card.text);
  return card.sayQ || speakable(card.q);
}

export function sayAnswer(card, kind) {
  if (kind === 'read') return card.say || speakable(card.text);
  return card.sayA || speakable(card.a);
}

// ---- building a question ---------------------------------------------------

function unique(list) {
  return Array.from(new Set(list));
}

// How easily a six-year-old could confuse `other` with `answer` (higher = more alike).
function lookAlike(answer, other) {
  const a = answer.toLowerCase();
  const b = other.toLowerCase();
  let score = 0;
  if (a[0] === b[0]) score += 2;
  if (a[a.length - 1] === b[b.length - 1]) score += 1;
  if (Math.abs(a.length - b.length) <= 1) score += 1;
  return score;
}

// One multiple-choice question for a card.
//   read decks: the child hears the word and taps it; wrong choices are look-alike words from the same deck.
//   qa decks:   the child sees the question; wrong choices are the card's own `wrong` list.
export function buildQuestion(card, deck, rng, maxChoices = 3) {
  const answer = answerOf(card, deck.kind);
  let wrong;
  if (deck.kind === 'qa' && Array.isArray(card.wrong) && card.wrong.length) {
    wrong = unique(card.wrong.filter((w) => w !== answer)).slice(0, maxChoices - 1);
  } else {
    const others = unique(
      deck.cards.filter((c) => c.id !== card.id).map((c) => answerOf(c, deck.kind)).filter((t) => t && t !== answer)
    );
    wrong = others
      .map((text) => ({ text, score: lookAlike(answer, text) + rng() * 2.5 }))
      .sort((x, y) => y.score - x.score)
      .slice(0, maxChoices - 1)
      .map((x) => x.text);
  }
  return {
    card: card.id,
    deck: deck.id,
    kind: deck.kind,
    prompt: promptOf(card, deck.kind),
    answer,
    choices: shuffle([answer, ...wrong], rng),
  };
}

// ---- choosing what to practise ---------------------------------------------

// Pick the cards for one practice session from a pool of cards.
// Order of priority: trouble cards, a few new ones (in deck order: decks run
// easy to hard), cards that are due, then anything else, so a session is
// always full when the pool is big enough.
export function pickSession(cards, stats, opts) {
  const { size = 10, maxNew = 4, now, rng, practiceFlags = new Set() } = opts;
  const trouble = [], fresh = [], dueLearning = [], dueReview = [], resting = [];
  for (const card of cards) {
    const st = stats[card.id];
    if (isTrouble(st) || practiceFlags.has(card.id)) trouble.push(card);
    else if (!st || !st.seen) fresh.push(card);
    else if (!isDue(st, now)) resting.push(card);
    else if (levelOf(st) === 'learning') dueLearning.push(card);
    else dueReview.push(card);
  }
  const picked = [];
  const take = (list, n) => {
    const room = Math.max(0, Math.min(n, size - picked.length));
    picked.push(...list.splice(0, room));
  };
  const troubleMixed = shuffle(trouble, rng);
  take(troubleMixed, Math.ceil(size * 0.4));
  take(fresh, maxNew);
  take(shuffle(dueLearning, rng), size);
  take(shuffle(dueReview, rng), size);
  take(shuffle(resting, rng), size);
  take(fresh, size);
  take(troubleMixed, size);
  return shuffle(picked, rng);
}

// Pick the cards for a test-out round: `pools` = [{ deck, cards }] for every level being skipped,
// in path order. Questions are dealt one level at a time so each level gets a fair share, then
// shuffled. Returns at most `size` cards (fewer when the levels are small).
export function pickTestOut(pools, size, rng) {
  const piles = pools.map((p) => shuffle(p.cards, rng)).filter((c) => c.length);
  const picked = [];
  while (picked.length < size && piles.some((c) => c.length)) {
    for (const pile of piles) {
      if (picked.length >= size) break;
      if (pile.length) picked.push(pile.pop());
    }
  }
  return shuffle(picked, rng);
}

// Pick the cards for a test a grown-up is setting up.
//   config.decks  deck ids to draw from
//   config.count  how many questions
//   config.source 'all' | 'seen' | 'new' | 'learning' | 'trouble' | 'missed'
// Cards are dealt one deck at a time so every chosen deck gets a fair share,
// then grouped by deck so the child is not thrown between subjects every question.
export function buildTestCards(config, content, stats, opts) {
  const { rng, hidden = new Set(), practiceFlags = new Set() } = opts;
  const wanted = new Set(config.decks);
  const fits = (card) => {
    const st = stats[card.id];
    switch (config.source) {
      case 'seen': return !!(st && st.seen);
      case 'new': return !st || !st.seen;
      case 'learning': return levelOf(st) === 'learning';
      case 'trouble': return isTrouble(st) || practiceFlags.has(card.id);
      case 'missed': return !!(st && st.wrong > 0);
      default: return true;
    }
  };
  const piles = [];
  content.decks.forEach((deck, deckIndex) => {
    if (!wanted.has(deck.id)) return;
    const pool = deck.cards.filter((c) => canQuiz(c, deck) && !hidden.has(c.id) && fits(c));
    if (pool.length) piles.push({ deckIndex, cards: shuffle(pool, rng) });
  });
  const available = piles.reduce((n, p) => n + p.cards.length, 0);
  const count = Math.max(0, Math.min(config.count, available));
  const picked = [];
  let order = shuffle(piles, rng);
  while (picked.length < count) {
    order = order.filter((p) => p.cards.length);
    for (const pile of order) {
      if (picked.length >= count) break;
      picked.push({ deckIndex: pile.deckIndex, id: pile.cards.pop().id });
    }
  }
  picked.sort((a, b) => a.deckIndex - b.deckIndex);
  return { cards: picked.map((p) => p.id), available };
}

// ---- progress --------------------------------------------------------------

// A level is passed with 85% or better on one Play round (PASS_MARK in server.py is the same number).
export const PASS_MARK = 0.85;

// Stars for one finished round: three = passed, two = most of them right, one = finished it.
export function roundStars(share) {
  return share >= PASS_MARK ? 3 : share >= 0.6 ? 2 : 1;
}

// How many right answers a round of `total` questions needs to pass (10 → 9, 8 → 7, 3 → 3).
export function needToPass(total) {
  return Math.ceil((total * 85) / 100);
}

// Fold one finished round into a deck's round summary (the shape the server sends as state.rounds).
export function addRound(summary, correct, total, at) {
  const s = summary || { best: 0, last: 0, count: 0, lastAt: 0, lastCorrect: 0, lastTotal: 0 };
  const score = total ? correct / total : 0;
  const best = Math.max(s.best, score);
  return { best, last: score, count: s.count + 1, lastAt: at, lastCorrect: correct, lastTotal: total, passed: best >= PASS_MARK };
}

// The stars shown on a level: its best round so far.
export function levelStars(summary) {
  return summary && summary.count ? roundStars(summary.best) : 0;
}

// Progress through one deck's cards: how many seen, mastered, in trouble.
export function deckProgress(deck, stats, hidden = new Set()) {
  let total = 0, seen = 0, mastered = 0, trouble = 0, right = 0, tries = 0;
  for (const card of deck.cards) {
    if (hidden.has(card.id)) continue;
    total++;
    const st = stats[card.id];
    if (!st || !st.seen) continue;
    seen++;
    right += st.correct;
    tries += st.seen;
    if (levelOf(st) === 'mastered') mastered++;
    if (isTrouble(st)) trouble++;
  }
  return { total, seen, mastered, trouble, accuracy: tries ? right / tries : null };
}

export function sumProgress(list) {
  const out = { total: 0, seen: 0, mastered: 0, trouble: 0, decks: list.length };
  for (const p of list) {
    out.total += p.total;
    out.seen += p.seen;
    out.mastered += p.mastered;
    out.trouble += p.trouble;
  }
  return out;
}

// Has the child passed this level? A Play round at PASS_MARK or better. A look-only deck
// (quiz: false) has no round to score, so it is passed once every card has been flipped and
// sorted (Got it / Not yet) in the flashcards.
export function levelPassed(deck, progress, summary) {
  if (deck.quiz === false) return progress.total > 0 && progress.seen >= progress.total;
  return !!summary && summary.count > 0 && summary.best >= PASS_MARK;
}

// The decks of a subject as a path of levels, like a world map.
//   level 1 is always open; each later level opens once the one before it is passed
//   (three stars: a round at 85% or better), and a level once passed stays open even if
//   the one before it is not (passed under Open-every-level, or while a deck was hidden).
//   freeRoam opens everything. `current` marks the frontier: where the child should go next.
//   rounds: { deckId: round summary } (state.rounds)
// Returns [{ deck, index, progress, round, stars, passed, unlocked, current }] in path order.
export function levelPath(decks, stats, { hidden = new Set(), freeRoam = false, rounds = {} } = {}) {
  const levels = [];
  let previousPassed = true;
  for (const deck of decks) {
    const progress = deckProgress(deck, stats, hidden);
    const round = rounds[deck.id] || null;
    const passed = levelPassed(deck, progress, round);
    const stars = deck.quiz === false ? (passed ? 3 : progress.seen ? 1 : 0) : levelStars(round);
    const unlocked = freeRoam || levels.length === 0 || previousPassed || passed;
    levels.push({ deck, index: levels.length, progress, round, stars, passed, unlocked, current: false });
    previousPassed = passed;
  }
  // "Where to go next": the first open level not yet passed (in the usual chain that is the
  // newest open one), or the last open level when everything open is passed.
  const open = levels.filter((l) => l.unlocked);
  const frontier = open.find((l) => !l.passed) || open[open.length - 1];
  if (frontier) frontier.current = true;
  return levels;
}

// The deck to nudge the child toward: the frontier of the path.
export function nextDeck(decks, stats, opts) {
  const level = levelPath(decks, stats, opts).find((l) => l.current);
  return level ? level.deck : null;
}

export function isUnlocked(deck, decks, stats, opts) {
  const level = levelPath(decks, stats, opts).find((l) => l.deck.id === deck.id);
  return !!level && level.unlocked;
}

// ---- stickers --------------------------------------------------------------

// Sticker n (1-based) arrives at 10, 25, 45, 70 ... stars: quick early wins, then a steady pace.
export function starsForSticker(n) {
  return (5 * n * (n + 3)) / 2;
}

export function stickersEarned(stars, max) {
  let n = 0;
  while (n < max && stars >= starsForSticker(n + 1)) n++;
  return n;
}

// ---- dates -----------------------------------------------------------------

export function dayString(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// How many days in a row (ending today, or yesterday if today has not started) had practice.
export function dayStreak(days, today) {
  const cursor = new Date(`${today}T12:00:00`);
  if (!days[today]) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (days[dayString(cursor)]) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}
