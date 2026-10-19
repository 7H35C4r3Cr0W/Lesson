// Browser-side tests for the learning rules (web/js/logic.js), the DOM helper,
// the drawings, and the live card content. Open /tests/ on the Pi to run them.

import * as L from '../js/logic.js';
import { h } from '../js/dom.js';
import { renderVisual, SHAPE_NAMES } from '../js/visuals.js';

const groups = [];
let current = null;

function group(name) {
  current = { name, cases: [] };
  groups.push(current);
}
function test(name, fn) {
  current.cases.push({ name, fn });
}
function eq(a, b, msg = '') {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg} expected ${sb}, got ${sa}`);
}
function ok(v, msg = 'expected truthy') {
  if (!v) throw new Error(msg);
}

const rng = () => L.makeRng(7);

// ---- stats ------------------------------------------------------------------

group('Card stats (shared with the server)');
const vectors = await fetch('./stat_vectors.json').then((r) => r.json());
for (const vec of vectors.vectors) {
  test(vec.name, () => {
    let stat = null;
    for (const r of vec.results) stat = L.applyResult(stat, r, 1000);
    const got = {};
    for (const k of Object.keys(vec.expect)) got[k] = stat ? stat[k] : L.EMPTY_STAT[k];
    eq(got, vec.expect, 'stat');
    eq(L.levelOf(stat), vec.level, 'level');
    eq(L.isTrouble(stat), vec.trouble, 'trouble');
  });
}
test('EMPTY_STAT is frozen and not mutated', () => {
  const before = JSON.stringify(L.EMPTY_STAT);
  L.applyResult(null, true, 1);
  eq(JSON.stringify(L.EMPTY_STAT), before);
});
test('isDue: new cards are due, box 2 rests 12 hours, box 5 rests 12 days', () => {
  ok(L.isDue(null, 0));
  const s2 = { ...L.EMPTY_STAT, seen: 1, box: 2, at: 0 };
  ok(!L.isDue(s2, 11 * 3600e3));
  ok(L.isDue(s2, 13 * 3600e3));
  const s5 = { ...L.EMPTY_STAT, seen: 9, box: 5, at: 0 };
  ok(!L.isDue(s5, 11 * 86400e3));
  ok(L.isDue(s5, 13 * 86400e3));
  ok(L.isDue({ ...s5, box: 1 }, 1), 'a missed card comes straight back');
});

// ---- randomness and text ---------------------------------------------------

group('Shuffle and text');
test('seeded rng replays and shuffle keeps every item', () => {
  const a = L.shuffle([1, 2, 3, 4, 5, 6], rng());
  const b = L.shuffle([1, 2, 3, 4, 5, 6], rng());
  eq(a, b);
  eq(a.slice().sort(), [1, 2, 3, 4, 5, 6]);
});
test('speakable turns math into words', () => {
  eq(L.speakable('3 + 4 = ?'), '3 plus 4 equals what');
  eq(L.speakable('10 − 6 = ?'), '10 minus 6 equals what');
  eq(L.speakable('9 - 3'), '9 minus 3');
  eq(L.speakable('7 > 5'), '7 is greater than 5');
  eq(L.speakable('25¢'), '25 cents');
  eq(L.speakable('What is ___ + 2 = 5?'), 'What is blank plus 2 equals 5?');
});
test('stripEmoji removes pictures but keeps words', () => {
  eq(L.stripEmoji('cat 🐱'), 'cat');
  eq(L.stripEmoji('🍎🍎 + 🍎'), '+');
  eq(L.stripEmoji('well-being'), 'well-being');
});

// ---- questions ---------------------------------------------------------------

const readDeck = {
  id: 'd1', kind: 'read', cards: [
    { id: 'd1.cat', text: 'cat' }, { id: 'd1.cut', text: 'cut' }, { id: 'd1.cot', text: 'cot' },
    { id: 'd1.map', text: 'map' }, { id: 'd1.sun', text: 'sun' }, { id: 'd1.big', text: 'big' },
  ],
};
const qaDeck = {
  id: 'd2', kind: 'qa', cards: [
    { id: 'd2.a', q: '1 + 1 = ?', a: '2', wrong: ['1', '3', '4'] },
    { id: 'd2.b', q: 'Which is a fruit?', a: 'apple', wrong: ['apple', 'chair'] },
    { id: 'd2.c', q: 'No wrongs', a: 'yes' },
  ],
};

group('Building a question');
test('read decks: answer present, look-alikes preferred, no duplicates', () => {
  const q = L.buildQuestion(readDeck.cards[0], readDeck, rng(), 3);
  eq(q.choices.length, 3);
  ok(q.choices.includes('cat'));
  eq(new Set(q.choices).size, 3);
  ok(q.choices.includes('cut') || q.choices.includes('cot'), 'should pick a look-alike');
  eq(q.kind, 'read');
});
test('qa decks use the card\'s own wrong answers, filtered', () => {
  const q = L.buildQuestion(qaDeck.cards[1], qaDeck, rng(), 3);
  eq(q.choices.slice().sort(), ['apple', 'chair']);        // duplicate of the answer removed
  const q2 = L.buildQuestion(qaDeck.cards[0], qaDeck, rng(), 3);
  eq(q2.choices.length, 3);
  ok(q2.choices.includes('2'));
});
test('qa card with no wrong list borrows other answers', () => {
  const q = L.buildQuestion(qaDeck.cards[2], qaDeck, rng(), 3);
  ok(q.choices.includes('yes'));
  eq(q.choices.length, 3);
});
test('two-choice questions work', () => {
  eq(L.buildQuestion(readDeck.cards[0], readDeck, rng(), 2).choices.length, 2);
});

// ---- sessions ------------------------------------------------------------------

group('Picking a practice round');
const now = 1e12;
const cards = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}` }));
test('fills the round, trouble first, limited new cards', () => {
  const stats = {};
  stats.c0 = { seen: 3, correct: 1, wrong: 2, streak: 0, box: 1, recent: '100', at: now - 1 };   // trouble
  stats.c1 = { seen: 2, correct: 0, wrong: 2, streak: 0, box: 1, recent: '00', at: now - 1 };    // trouble
  for (let i = 2; i < 12; i++) stats[`c${i}`] = { seen: 2, correct: 2, wrong: 0, streak: 2, box: 3, recent: '11', at: now - 3 * 86400e3 }; // due
  const picked = L.pickSession(cards, stats, { size: 10, maxNew: 3, now, rng: rng() });
  eq(picked.length, 10);
  eq(new Set(picked.map((c) => c.id)).size, 10, 'no repeats');
  ok(picked.some((c) => c.id === 'c0') && picked.some((c) => c.id === 'c1'), 'trouble cards included');
  const fresh = picked.filter((c) => !stats[c.id]).length;
  ok(fresh <= 3, `at most 3 new, got ${fresh}`);
});
test('a small pool just returns everything once', () => {
  const picked = L.pickSession(cards.slice(0, 4), {}, { size: 10, maxNew: 2, now, rng: rng() });
  eq(picked.length, 4);
});
test('resting cards fill the round when nothing is due', () => {
  const stats = {};
  for (let i = 0; i < 30; i++) stats[`c${i}`] = { seen: 5, correct: 5, wrong: 0, streak: 5, box: 5, recent: '11111', at: now };
  eq(L.pickSession(cards, stats, { size: 8, maxNew: 2, now, rng: rng() }).length, 8);
});
test('practice flags count as trouble', () => {
  const picked = L.pickSession(cards, {}, { size: 3, maxNew: 1, now, rng: rng(), practiceFlags: new Set(['c29']) });
  ok(picked.some((c) => c.id === 'c29'));
});

group('Building a test');
const content = { decks: [readDeck, qaDeck, { id: 'd3', kind: 'read', cards: [{ id: 'd3.x', text: 'x' }, { id: 'd3.y', text: 'y' }, { id: 'd3.z', text: 'z' }] }] };
test('spreads questions across decks and groups them', () => {
  const { cards: ids, available } = L.buildTestCards({ decks: ['d1', 'd3'], count: 6, source: 'all' }, content, {}, { rng: rng() });
  eq(available, 9);
  eq(ids.length, 6);
  eq(ids.filter((id) => id.startsWith('d1.')).length, 3);
  eq(ids.filter((id) => id.startsWith('d3.')).length, 3);
  ok(ids.slice(0, 3).every((id) => id.startsWith('d1.')), 'grouped by deck');
});
test('count is capped by what is available and sources filter', () => {
  const stats = { 'd1.cat': { seen: 2, correct: 0, wrong: 2, streak: 0, box: 1, recent: '00', at: 1 } };
  eq(L.buildTestCards({ decks: ['d1'], count: 50, source: 'all' }, content, stats, { rng: rng() }).cards.length, 6);
  eq(L.buildTestCards({ decks: ['d1'], count: 50, source: 'trouble' }, content, stats, { rng: rng() }).cards, ['d1.cat']);
  eq(L.buildTestCards({ decks: ['d1'], count: 50, source: 'new' }, content, stats, { rng: rng() }).cards.length, 5);
  eq(L.buildTestCards({ decks: ['d1'], count: 50, source: 'seen' }, content, stats, { rng: rng() }).cards, ['d1.cat']);
  eq(L.buildTestCards({ decks: ['d1'], count: 50, source: 'all' }, content, stats, { rng: rng(), hidden: new Set(['d1.cat']) }).cards.length, 5);
});

// ---- levels ------------------------------------------------------------------

group('Level path');
const decks = [1, 2, 3, 4].map((n) => ({ id: `L${n}`, kind: 'read', cards: [{ id: `L${n}.a`, text: 'a' }, { id: `L${n}.b`, text: 'b' }] }));
const mastered = { seen: 3, correct: 3, wrong: 0, streak: 3, box: 4, recent: '111', at: 1 };
const passRound = { best: 0.9, last: 0.9, count: 1, lastAt: 1, lastCorrect: 9, lastTotal: 10, passed: true };
test('only level 1 is open at the start, and it is the frontier', () => {
  const path = L.levelPath(decks, {});
  eq(path.map((l) => l.unlocked), [true, false, false, false]);
  eq(path.map((l) => l.current), [true, false, false, false]);
  eq(path.map((l) => l.stars), [0, 0, 0, 0]);
});
test('a round at 85% or better passes a level and opens the next; less does not', () => {
  let path = L.levelPath(decks, {}, { rounds: { L1: { ...passRound, best: 0.8, last: 0.8, passed: false } } });
  eq(path.map((l) => l.unlocked), [true, false, false, false]);
  eq([path[0].passed, path[0].stars], [false, 2]);
  path = L.levelPath(decks, {}, { rounds: { L1: passRound } });
  eq(path.map((l) => l.unlocked), [true, true, false, false]);
  eq(path.map((l) => l.current), [false, true, false, false]);
  eq([path[0].passed, path[0].stars], [true, 3]);
  eq(L.levelPath(decks, {}, { rounds: { L1: { ...passRound, best: 0.85 } } })[1].unlocked, true, '85% exactly passes');
});
test('mastered cards alone do not open a level: only a passed round does', () => {
  const path = L.levelPath(decks, { 'L1.a': mastered, 'L1.b': mastered });
  eq(path.map((l) => l.unlocked), [true, false, false, false]);
  eq(path[0].passed, false);
});
test('a look-only level is passed once every card has been seen', () => {
  const look = [{ id: 'K1', kind: 'read', quiz: false, cards: [{ id: 'K1.a', text: 'a' }, { id: 'K1.b', text: 'b' }] }, decks[1]];
  eq(L.levelPath(look, { 'K1.a': mastered })[1].unlocked, false);
  const path = L.levelPath(look, { 'K1.a': mastered, 'K1.b': { ...mastered, box: 1 } });
  eq([path[0].passed, path[0].stars, path[1].unlocked], [true, 3, true]);
});
test('a passed level stays open even when the one before it is not; the frontier is the first unpassed open level', () => {
  const path = L.levelPath(decks, {}, { rounds: { L3: passRound } });     // passed under Open-every-level, then switched off
  eq(path.map((l) => l.unlocked), [true, false, true, true]);
  eq(path.map((l) => l.current), [true, false, false, false]);
});
test('free roam opens everything but points at the first level not yet passed', () => {
  const path = L.levelPath(decks, {}, { freeRoam: true, rounds: { L1: passRound } });
  eq(path.every((l) => l.unlocked), true);
  eq(path.map((l) => l.current), [false, true, false, false]);
});
test('round stars: 85% is three, 60% is two, finishing is one', () => {
  eq([1, 0.9, 0.85, 0.84, 0.6, 0.59, 0].map(L.roundStars), [3, 3, 3, 2, 2, 1, 1]);
  eq(L.levelStars(null), 0);
  eq(L.levelStars({ best: 0.7, count: 0 }), 0);
});
test('needToPass: 9 of 10, 7 of 8, 3 of 3, 17 of 20', () => {
  eq([10, 8, 3, 5, 6, 7, 12, 15, 20].map(L.needToPass), [9, 7, 3, 5, 6, 6, 11, 13, 17]);
});
test('addRound keeps the best score and the latest one', () => {
  let s = L.addRound(null, 5, 10, 100);
  eq([s.best, s.last, s.count, s.passed, s.lastCorrect, s.lastTotal, s.lastAt], [0.5, 0.5, 1, false, 5, 10, 100]);
  s = L.addRound(s, 9, 10, 200);
  eq([s.best, s.last, s.count, s.passed], [0.9, 0.9, 2, true]);
  s = L.addRound(s, 6, 8, 300);
  eq([s.best, s.last, s.count, s.passed, s.lastAt], [0.9, 0.75, 3, true, 300]);
});
test('deckProgress counts seen, mastered and trouble cards', () => {
  const p = L.deckProgress(decks[0], { 'L1.a': mastered, 'L1.b': { seen: 3, correct: 1, wrong: 2, streak: 0, box: 1, recent: '100', at: 1 } });
  eq([p.total, p.seen, p.mastered, p.trouble], [2, 2, 1, 1]);
  eq(L.deckProgress(decks[0], {}).seen, 0);
});
test('pickTestOut deals a fair share from every level, then shuffles', () => {
  const pools = decks.map((d) => ({ deck: d, cards: d.cards }));          // 4 levels x 2 cards
  const picked = L.pickTestOut(pools, 6, rng());
  eq(picked.length, 6);
  eq(new Set(picked.map((c) => c.id)).size, 6, 'no repeats');
  for (const d of decks) ok(picked.some((c) => c.id.startsWith(d.id + '.')), `${d.id} represented`);
  eq(L.pickTestOut(pools, 20, rng()).length, 8, 'capped by what the levels hold');
  eq(L.pickTestOut([], 10, rng()).length, 0);
});
test('nextDeck is the frontier', () => {
  eq(L.nextDeck(decks, {}, { rounds: { L1: passRound } }).id, 'L2');
  eq(L.nextDeck(decks, { 'L1.a': mastered, 'L1.b': mastered }).id, 'L1');
});

// ---- stickers and dates ------------------------------------------------------

group('Stickers and streaks');
test('sticker thresholds climb gently', () => {
  eq([1, 2, 3, 4].map(L.starsForSticker), [10, 25, 45, 70]);
  eq(L.stickersEarned(0, 60), 0);
  eq(L.stickersEarned(10, 60), 1);
  eq(L.stickersEarned(44, 60), 2);
  eq(L.stickersEarned(1e9, 60), 60);
});
test('day streak counts back from today or yesterday', () => {
  eq(L.dayStreak({ '2026-10-11': { total: 1 }, '2026-10-10': { total: 1 }, '2026-10-09': { total: 1 } }, '2026-10-11'), 3);
  eq(L.dayStreak({ '2026-10-10': { total: 1 }, '2026-10-09': { total: 1 } }, '2026-10-11'), 2);
  eq(L.dayStreak({ '2026-10-08': { total: 1 } }, '2026-10-11'), 0);
  eq(L.dayStreak({}, '2026-10-11'), 0);
});

// ---- stories ------------------------------------------------------------------

group('Stories');
const story = 'Sam has a cat.\nThe cat is Max.\n\nMax naps on the mat.\nSam pats Max.';
test('wordCount follows the shared word rules', () => {
  eq(L.wordCount(story), 16);
  eq(L.wordCount('"Hi!" - 3 ... Max\'s cat-nap'), 3);     // Hi, Max's, cat-nap; the dash, dots and digit do not count
  eq(L.wordCount(''), 0);
  eq(L.wordCount('***\nSam ran.\n***\nSam sat.'), 4);     // page breaks are not words
});
test('cleanWord trims punctuation, lower-cases and drops a possessive', () => {
  eq(L.cleanWord("Max's"), 'max');
  eq(L.cleanWord('"Hi!"'), 'hi');
  eq(L.cleanWord("don't"), "don't");
  eq(L.cleanWord('cat-nap,'), 'cat-nap');
  eq(L.trimWord('"Hi!"'), 'Hi');
  eq([L.countsAsWord('-'), L.countsAsWord('3'), L.countsAsWord('a.')], [false, false, true]);
});
test('passageParagraphs: paragraphs of trimmed lines, blanks dropped', () => {
  eq(L.passageParagraphs(story), [['Sam has a cat.', 'The cat is Max.'], ['Max naps on the mat.', 'Sam pats Max.']]);
  eq(L.passageParagraphs('  One.  \r\n\r\n\r\nTwo.\n'), [['One.'], ['Two.']]);
  eq(L.passageParagraphs(''), []);
  eq(L.passageTokens('  Sam  has a cat. '), ['Sam', 'has', 'a', 'cat.']);
});
test('passagePages: *** on its own line turns the page', () => {
  eq(L.passagePages('Page one.\n***\nPage two.\n\nMore.'), ['Page one.', 'Page two.\n\nMore.']);
  eq(L.passagePages(story), [story]);
  eq(L.passagePages('***\nOnly.\n***'), ['Only.']);
  eq(L.passageParagraphs('A.\n***\nB.'), [['A.', 'B.']]);     // the break itself is never a line
});
test('wcpmOf: 58 words, 3 errors, 72 seconds → 46; no time → null; never below 0', () => {
  eq(L.wcpmOf(58, 3, 72), 46);
  eq(L.wcpmOf(58, 3, 0), null);
  eq(L.wcpmOf(58, 3, null), null);
  eq(L.wcpmOf(10, 12, 30), 0);
});
test('addRead keeps the count, the scored count, the best wcpm and the last read', () => {
  let s = L.addRead(null, { mode: 'self', words: 58, errors: 2, at: 100 });
  eq(s, { count: 1, scored: 0, best: null, lastAt: 100, last: { mode: 'self', words: 58, errors: 2, seconds: null, wcpm: null, at: 100 } });
  s = L.addRead(s, { mode: 'scored', words: 58, errors: 3, seconds: 72, at: 200 });
  eq([s.count, s.scored, s.best, s.lastAt, s.last.wcpm, s.last.seconds], [2, 1, 46, 200, 46, 72]);
  s = L.addRead(s, { mode: 'scored', words: 58, errors: 10, seconds: 90, at: 300 });
  eq([s.count, s.scored, s.best, s.last.wcpm], [3, 2, 46, 32]);
  s = L.addRead(s, { mode: 'self', words: 58, errors: 0, seconds: 50, at: 400 });     // a self read never carries a time
  eq([s.count, s.scored, s.best, s.last.seconds, s.last.wcpm], [4, 2, 46, null, null]);
});
const P = await import('../js/phonics.js');
test('splitSounds: letter teams, magic e, soft c, y at the end, silent letters', () => {
  const letters = (w) => P.splitSounds(w).map((p) => p.text);
  const sounds = (w) => P.splitSounds(w).map((p) => p.sound);
  eq(letters('ship'), ['sh', 'i', 'p']);
  eq(letters('thack'), ['th', 'a', 'ck']);
  eq(letters('match'), ['m', 'a', 'tch']);
  eq(letters('bridge'), ['b', 'r', 'i', 'dge']);
  eq(letters('darkness'), ['d', 'ar', 'k', 'n', 'e', 'ss']);      // kn only at the front of a word
  eq(sounds('cake'), ['kuh', 'ay', 'kuh', '']);
  eq(sounds('city'), ['sss', 'ih', 'tuh', 'ee']);
  eq(sounds('my'), ['mmm', 'eye']);
  eq(sounds('yes'), ['yuh', 'eh', 'sss']);
  eq(sounds('go'), ['guh', 'oh']);
  eq(sounds('know'), ['nnn', 'ow']);
  eq(sounds('apple'), ['aa', 'puh', 'lll', '']);
  eq(sounds("don't"), ['duh', 'ah', 'nnn', '', 'tuh']);
  eq(P.soundOut('Cat'), ['kuh', 'aa', 'tuh', 'Cat']);
  eq(P.soundOut('I'), ['eye', 'I']);
});
test('splitSounds: g stays hard in get, give, girl and tiger, soft in gem and cage', () => {
  const first = (w) => P.splitSounds(w)[0].sound;
  for (const w of ['get', 'gets', 'getting', 'give', 'giving', 'gives', 'gift', 'girl', 'girls', 'giggled']) eq(first(w), 'guh', w);
  eq(P.splitSounds('forgetting')[2].sound, 'guh', 'forgetting');     // f, or, g ...
  eq(P.splitSounds('beginning')[2].sound, 'guh', 'beginning');
  eq(P.splitSounds('tiger')[2].sound, 'guh', 'tiger');
  eq(P.splitSounds('begin')[2].sound, 'guh', 'begin');
  eq(first('gem'), 'juh', 'gem');
  eq(first('giant'), 'juh', 'giant');
  eq(first('gate'), 'guh', 'gate');
});
test('splitSounds: magic e works across a soft c or g (cage, race, ice)', () => {
  const sounds = (w) => P.splitSounds(w).map((p) => p.sound);
  eq(sounds('cage'), ['kuh', 'ay', 'juh', '']);
  eq(sounds('race'), ['rrr', 'ay', 'sss', '']);
  eq(sounds('ice'), ['eye', 'sss', '']);
  eq(sounds('huge'), ['huh', 'you', 'juh', '']);
  eq(sounds('since'), ['sss', 'ih', 'nnn', 'sss', '']);                 // n before the c: no magic e
  eq(sounds('village'), ['vvv', 'ih', 'lll', 'aa', 'juh', '']);         // two syllables: the a stays short
  eq(sounds('office'), ['ah', 'fff', 'ih', 'sss', '']);
});
test('splitSounds: magic e under an ending s or d (cakes, named, faces, hated), never across x, give stays short', () => {
  const sounds = (w) => P.splitSounds(w).map((p) => p.sound);
  eq(sounds('cakes'), ['kuh', 'ay', 'kuh', '', 'sss']);
  eq(sounds('grapes'), ['guh', 'rrr', 'ay', 'puh', '', 'sss']);
  eq(sounds('named'), ['nnn', 'ay', 'mmm', '', 'duh']);
  eq(sounds('smiled'), ['sss', 'mmm', 'eye', 'lll', '', 'duh']);
  eq(sounds('faces'), ['fff', 'ay', 'sss', 'eh', 'sss']);               // -es after a hiss is a syllable
  eq(sounds('hated'), ['huh', 'ay', 'tuh', 'eh', 'duh']);               // -ed after t is a syllable
  eq(sounds('opened'), ['ah', 'puh', 'eh', 'nnn', '', 'duh']);          // a two-syllable base keeps its short vowel
  eq(sounds('fixed'), ['fff', 'ih', 'ks', '', 'duh']);
  eq(sounds('boxes'), ['buh', 'ah', 'ks', 'eh', 'sss']);
  eq(sounds('axe'), ['aa', 'ks', '']);
  eq(sounds('give'), ['guh', 'ih', 'vvv', '']);
  eq(sounds('lived'), ['lll', 'ih', 'vvv', '', 'duh']);
  eq(sounds('five'), ['fff', 'eye', 'vvv', '']);
  eq(sounds('cats'), ['kuh', 'aa', 'tuh', 'sss']);
});
test('splitSounds: an ending -ed or -es is a syllable only after t / d or a hiss (wanted, wishes; jumped, asked, apples are not)', () => {
  const sounds = (w) => P.splitSounds(w).map((p) => p.sound);
  eq(sounds('jumped'), ['juh', 'uh', 'mmm', 'puh', '', 'duh']);
  eq(sounds('asked'), ['aa', 'sss', 'kuh', '', 'duh']);
  eq(sounds('played'), ['puh', 'lll', 'ay', '', 'duh']);
  eq(sounds('hopped'), ['huh', 'ah', 'puh', '', 'duh']);
  eq(sounds('wanted'), ['wuh', 'aa', 'nnn', 'tuh', 'eh', 'duh']);
  eq(sounds('patted'), ['puh', 'aa', 'tuh', 'eh', 'duh']);
  eq(sounds('needed'), ['nnn', 'ee', 'duh', 'eh', 'duh']);
  eq(sounds('wishes'), ['wuh', 'ih', 'shh', 'eh', 'sss']);
  eq(sounds('apples'), ['aa', 'puh', 'lll', '', 'sss']);
  eq(sounds('elves'), ['eh', 'lll', 'vvv', '', 'sss']);
  eq(sounds('hundred'), ['huh', 'uh', 'nnn', 'duh', 'rrr', 'eh', 'duh']);   // not an ending
  eq(sounds('red'), ['rrr', 'eh', 'duh']);
  eq(sounds('sled'), ['sss', 'lll', 'eh', 'duh']);
  eq(sounds('yes'), ['yuh', 'eh', 'sss']);
});

// ---- DOM and drawings ---------------------------------------------------------

group('Safety of the page builder');
test('text is never parsed as HTML', () => {
  const el = h('div', null, '<img src=x onerror=alert(1)>');
  eq(el.childElementCount, 0);
  eq(el.textContent, '<img src=x onerror=alert(1)>');
});
test('props: class, dataset, style vars, events', () => {
  let hit = 0;
  const el = h('button', { class: 'a b', dataset: { x: '1' }, style: { '--c': 'red', color: 'blue' }, onclick: () => hit++, hidden: false }, 'hi');
  eq(el.className, 'a b');
  eq(el.dataset.x, '1');
  eq(el.style.getPropertyValue('--c'), 'red');
  el.click();
  eq(hit, 1);
  eq(el.hidden, false);
});

group('Drawings');
const visuals = [
  { type: 'clock', h: 3, m: 30 }, { type: 'digital', h: 12, m: 0 }, { type: 'coins', coins: ['penny', 'nickel', 'dime', 'quarter'] },
  { type: 'coins', coins: ['dime', 'dime', 'penny', 'penny', 'penny', 'penny', 'penny', 'penny'], label: 'none' },
  { type: 'blocks', tens: 3, ones: 4 }, { type: 'blocks', tens: 0, ones: 0 }, { type: 'tenframe', n: 7 }, { type: 'tenframe', n: 17 },
  { type: 'count', emoji: '🍎', n: 12 }, { type: 'fraction', shape: 'circle', parts: 4, shaded: 1 },
  { type: 'fraction', shape: 'rectangle', parts: 2, shaded: 1 }, { type: 'tally', n: 7 }, { type: 'numberline', from: 0, to: 20, mark: 13 },
  { type: 'measure', len: 6, emoji: '✏️' }, { type: 'graph', rows: [{ label: '🍎', n: 3 }, { label: '🍌', n: 5 }] },
  ...SHAPE_NAMES.map((shape) => ({ type: 'shape', shape })),
];
for (const spec of visuals) {
  test(`${spec.type}${spec.shape ? ' ' + spec.shape : ''} draws`, () => {
    const el = renderVisual(spec);
    ok(el instanceof Element, 'returns an element');
    ok(el.getAttribute('aria-label') !== null, 'has a label');
  });
}
test('unknown visuals return null instead of throwing', () => {
  eq(renderVisual({ type: 'hologram' }), null);
  eq(renderVisual(null), null);
});

// ---- games -----------------------------------------------------------------------

group('Games load');
const { GAMES } = await import('../js/views/games.js');
for (const game of GAMES) {
  test(`${game.title} module loads and follows the engine contract`, async () => {
    const mod = await game.load();          // a syntax error anywhere in the file fails here
    ok(mod.meta && mod.meta.id === game.id, `meta.id should be ${game.id}`);
    eq(typeof mod.start, 'function', 'start()');
  });
}

// ---- the live content ---------------------------------------------------------

group('Card content on this Pi');
const bundle = await fetch('../content.json').then((r) => r.json()).catch(() => null);
test('content loads', () => {
  ok(bundle && Array.isArray(bundle.decks) && bundle.decks.length > 0, 'no decks');
});
if (bundle) {
  const subjectIds = new Set(bundle.subjects.map((s) => s.id));
  const seen = new Set();
  test('every deck belongs to a subject and has cards', () => {
    for (const d of bundle.decks) {
      ok(subjectIds.has(d.subject), `${d.id}: unknown subject ${d.subject}`);
      ok(d.cards.length > 0, `${d.id}: no cards`);
    }
  });
  test('card ids are unique everywhere', () => {
    for (const d of bundle.decks) for (const c of d.cards) {
      ok(!seen.has(c.id), `duplicate id ${c.id}`);
      seen.add(c.id);
    }
  });
  test('every quizzable card makes a sound question with its answer among the choices', () => {
    for (const d of bundle.decks) {
      if (d.quiz === false) continue;
      for (const c of d.cards) {
        if (c.quiz === false) continue;
        const q = L.buildQuestion(c, d, Math.random, 3);
        ok(q.choices.includes(q.answer), `${c.id}: answer missing from choices`);
        ok(new Set(q.choices).size === q.choices.length, `${c.id}: duplicate choices`);
        ok(q.choices.length >= 2, `${c.id}: fewer than two choices`);
      }
    }
  });
  test('every visual on a card draws', () => {
    for (const d of bundle.decks) for (const c of d.cards) {
      if (c.visual) ok(renderVisual(c.visual), `${c.id}: visual did not draw`);
    }
  });
  test('read cards: parts join to the text', () => {
    for (const d of bundle.decks) {
      if (d.kind !== 'read') continue;
      for (const c of d.cards) if (c.parts) eq(c.parts.join(''), c.text, c.id);
    }
  });
  // Mirrors check_passage() in tools/validate_content.py: a one-page story is 30-120 words, a book
  // is up to 10 pages of 20-120 words each, and a story has 8 or more questions, read aloud.
  test('story levels: 30–120 words (20–120 a page), 8 or more cards, a level, questions read aloud, and every card builds', () => {
    for (const d of bundle.decks) {
      if (!d.passage) continue;
      ok(d.passage && typeof d.passage.text === 'string' && d.passage.text.trim(), `${d.id}: no story text`);
      const pages = L.passagePages(d.passage.text);
      ok(pages.length >= 1 && pages.length <= 10, `${d.id}: ${pages.length} pages`);
      ok(d.cards.length >= 8, `${d.id}: only ${d.cards.length} cards`);
      ok(typeof d.passage.level === 'string' && d.passage.level, `${d.id}: passage.level missing`);
      if (d.kind === 'qa') {          // a read deck's passage is a shelf of its words: no questions, any length
        if (pages.length === 1) {
          const n = L.wordCount(d.passage.text);
          ok(n >= 30 && n <= 120, `${d.id}: ${n} words`);
        } else {
          pages.forEach((page, i) => {
            const n = L.wordCount(page);
            ok(n >= 20 && n <= 120, `${d.id}: page ${i + 1} has ${n} words`);
          });
        }
        ok(d.readAloud === true, `${d.id}: readAloud should be true`);
        ok(d.readChoices === false, `${d.id}: readChoices should be false`);
      }
      for (const c of d.cards) {
        if (d.quiz === false || c.quiz === false) continue;
        const q = L.buildQuestion(c, d, Math.random, 3);
        ok(q.choices.includes(q.answer) && q.choices.length >= 2, `${c.id}: question does not build`);
      }
    }
  });
}

// ---- runner --------------------------------------------------------------------

async function run() {
  const results = document.getElementById('results');
  const summary = document.getElementById('summary');
  results.textContent = '';
  let pass = 0, fail = 0;
  for (const g of groups) {
    const box = h('div', { class: 'group' }, h('h2', null, g.name));
    for (const c of g.cases) {
      try {
        await c.fn();
        pass++;
        box.append(h('div', { class: 'case ok' }, c.name));
      } catch (err) {
        fail++;
        box.append(h('div', { class: 'case bad' }, c.name, h('span', { class: 'why' }, err.message)));
      }
    }
    results.append(box);
  }
  summary.textContent = fail ? `${fail} failed, ${pass} passed` : `All ${pass} checks passed`;
  summary.className = `summary ${fail ? 'fail' : 'pass'}`;
  window.__selfcheck = { pass, fail };
}
document.getElementById('rerun').addEventListener('click', run);
run();
