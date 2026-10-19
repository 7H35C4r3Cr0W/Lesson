// Sounding out a word: splits a word into its graphemes (single letters and letter teams)
// and says each sound, then the whole word. Used by the Read screen's 🔤 Sound it out switch.
//
// This is a rough built-in English inventory, not a dictionary: common teams are matched
// longest first, magic e makes the vowel before it long, c and g go soft before e/i/y, and
// y is a consonant at the front of a word and a vowel at the end. Tricky words are never
// sounded out (the screen says those whole), so the rules only have to be good for the
// decodable words a story is built from.

import * as speech from './speech.js';

// What the voice says for each sound. Best-effort spellings the tablet's voice reads well;
// a grown-up can tune them here. Keys ending in -soft / -long / y-ee / y-eye are picked by
// the rules below, everything else is the grapheme itself.
export const SOUNDS = {
  // consonants
  b: 'buh', c: 'kuh', d: 'duh', f: 'fff', g: 'guh', h: 'huh', j: 'juh', k: 'kuh', l: 'lll', m: 'mmm',
  n: 'nnn', p: 'puh', qu: 'kwuh', r: 'rrr', s: 'sss', t: 'tuh', v: 'vvv', w: 'wuh', x: 'ks', y: 'yuh', z: 'zzz',
  'c-soft': 'sss', 'g-soft': 'juh',
  // consonant teams (a double consonant is one sound)
  sh: 'shh', ch: 'chuh', th: 'thh', ng: 'ng', ck: 'kuh', ph: 'fff', wh: 'wuh', kn: 'nnn', wr: 'rrr',
  tch: 'chuh', dge: 'juh', ll: 'lll', ss: 'sss', ff: 'fff', zz: 'zzz',
  tt: 'tuh', pp: 'puh', dd: 'duh', bb: 'buh', gg: 'guh', mm: 'mmm', nn: 'nnn', rr: 'rrr',
  // short vowels
  a: 'aa', e: 'eh', i: 'ih', o: 'ah', u: 'uh',
  // long vowels: magic e (cake), or an open syllable at the end of the word (go, me)
  'a-long': 'ay', 'e-long': 'ee', 'i-long': 'eye', 'o-long': 'oh', 'u-long': 'you',
  // vowel teams
  ee: 'ee', ea: 'ee', ai: 'ay', ay: 'ay', eigh: 'ay', igh: 'eye', ie: 'eye',
  'y-ee': 'ee', 'y-eye': 'eye',          // y at the end of a word: happy / my
  oa: 'oh', oe: 'oh', ou: 'ow', ow: 'ow', oi: 'oy', oy: 'oy', aw: 'aw', au: 'aw', oo: 'oo', ue: 'you', ew: 'you',
  ar: 'ar', or: 'or', ore: 'or', er: 'er', ir: 'er', ur: 'er', air: 'air', are: 'air', ear: 'ear',
};

// Letter teams, longest first so "tch" wins over "ch" and "eigh" over "ei".
const TEAMS = ['eigh', 'tch', 'dge', 'igh', 'air', 'are', 'ear', 'ore',
  'sh', 'ch', 'th', 'ng', 'ck', 'ph', 'wh', 'kn', 'wr', 'qu',
  'ee', 'ea', 'ai', 'ay', 'oa', 'oe', 'oo', 'ou', 'ow', 'oi', 'oy', 'aw', 'au',
  'ar', 'or', 'er', 'ir', 'ur', 'ue', 'ew', 'ie',
  'll', 'ss', 'ff', 'zz', 'tt', 'pp', 'dd', 'bb', 'gg', 'mm', 'nn', 'rr'];
const START_ONLY = new Set(['kn', 'wr']);    // the silent letter is only silent at the front
const VOWELS = 'aeiou';

const isVowelKey = (key) => !!key && (VOWELS.includes(key[0]) || key.startsWith('y-'));
const isSingleConsonant = (key) => !!key && key.length === 1 && /[a-z]/.test(key) && !VOWELS.includes(key) && key !== 'y';

// The word as [{ text, sound }]: text is the letters of one sound, sound is what the voice
// says for it ('' for a silent letter, such as the e in "cake" or an apostrophe).
export function splitSounds(word) {
  const w = String(word || '').toLowerCase();
  const parts = [];
  let i = 0;
  while (i < w.length) {
    const team = TEAMS.find((t) => w.startsWith(t, i) && (i === 0 || !START_ONLY.has(t)));
    if (team) {
      parts.push({ text: team, key: team });
      i += team.length;
    } else {
      const ch = w[i];
      parts.push({ text: ch, key: /[a-z]/.test(ch) ? ch : null });
      i += 1;
    }
  }
  const n = parts.length;
  // c and g are soft before e, i or y (city, giant, gym).
  for (let k = 0; k < n - 1; k++) {
    const next = parts[k + 1].text[0];
    if (parts[k].key === 'c' && 'eiy'.includes(next)) parts[k].key = 'c-soft';
    else if (parts[k].key === 'g' && 'eiy'.includes(next)) parts[k].key = 'g-soft';
  }
  // y: a consonant at the front (yes), a vowel at the end (my, happy), short i in the middle (gym).
  parts.forEach((p, k) => {
    if (p.key !== 'y' || k === 0) return;
    if (k === n - 1) {
      const vowelsBefore = parts.slice(0, k).filter((q) => isVowelKey(q.key)).length;
      p.key = vowelsBefore ? 'y-ee' : 'y-eye';
    } else {
      p.key = 'i';
    }
  });
  if (n === 1 && (w === 'i' || w === 'a')) {
    parts[0].key = `${w}-long`;                           // the words "I" and "a"
  } else if (n >= 3 && parts[n - 1].key === 'e' && isSingleConsonant(parts[n - 2].key)
    && VOWELS.includes(parts[n - 3].key || '-') && parts[n - 3].key.length === 1) {
    parts[n - 3].key += '-long';                          // magic e: cake, hope, bike
    parts[n - 1].key = null;
  } else if (n >= 2 && parts[n - 1].key && parts[n - 1].key.length === 1 && 'eiou'.includes(parts[n - 1].key)) {
    const earlier = parts.slice(0, n - 1).some((q) => isVowelKey(q.key));
    // An open syllable at the end is long (go, hi, me); a final e after another vowel is silent (apple).
    if (parts[n - 1].key === 'e' && earlier) parts[n - 1].key = null;
    else parts[n - 1].key += '-long';
  }
  return parts.map((p) => ({ text: p.text, sound: p.key ? SOUNDS[p.key] || '' : '' }));
}

// What to say, in order: each sound that is not silent, then the whole word.
export function soundOut(word) {
  return splitSounds(word).map((p) => p.sound).filter(Boolean).concat([String(word)]);
}

// Say the word sound by sound, then whole. onPart(i) gets the index into soundOut(word) as
// each item starts, and -1 at the end. Resolves true when nothing cut it off.
export function sayItOut(word, onPart) {
  return speech.speakEach(soundOut(word), onPart);
}
