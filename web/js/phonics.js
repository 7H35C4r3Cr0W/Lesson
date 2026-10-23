// Sounding out a word: splits a word into its graphemes (single letters and letter teams)
// and says each sound, then the whole word. Used by the Read screen's 🔤 Sound it out switch.
//
// This is a rough built-in English inventory, not a dictionary: common teams are matched
// longest first, magic e makes the vowel before it long, c and g go soft before e/i/y, and
// y is a consonant at the front of a word and a vowel at the end. Tricky words are never
// sounded out (the screen says those whole), so the rules only have to be good for the
// decodable words a story is built from.

import * as speech from './speech.js';
import { cleanWord, trimWord } from './logic.js';

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

// The same sounds for the natural voice on the Pi (Piper, whose text rules are espeak-ng's),
// chosen by rendering candidates on the Pi and matching the audio against reference words
// (scratchpad tune_sounds.py): "aa"/"ah" both came out as the o in hot, "eh" as a long a,
// "ih" as a long i and "ow" as oh, while held consonants (fff, sss) were fine. Keep the keys
// identical to SOUNDS. A value "text|0.6" means: say text, but play only the first 60% of the
// clip (speech.js), which isolates a short vowel from its carrier consonant.
export const SOUNDS_PI = {
  // consonants: a held sound where the voice can hold one (fff, sss, mmm), else the sound plus a short uh
  b: 'buh', c: 'kuh', d: 'duh', f: 'fff', g: 'guh', h: 'huh', j: 'juh', k: 'kuh', l: 'lll', m: 'mmm',
  n: 'nnn', p: 'puh', qu: 'kwuh', r: 'rrr', s: 'sss', t: 'tuh', v: 'vvv', w: 'wuh', x: 'ks', y: 'yuh', z: 'zzz',
  'c-soft': 'sss', 'g-soft': 'juh',
  sh: 'shh', ch: 'chuh', th: 'thh', ng: 'ung', ck: 'kuh', ph: 'fff', wh: 'wuh', kn: 'nnn', wr: 'rrr',
  tch: 'chuh', dge: 'juh', ll: 'lll', ss: 'sss', ff: 'fff', zz: 'zzz',
  tt: 'tuh', pp: 'puh', dd: 'duh', bb: 'buh', gg: 'guh', mm: 'mmm', nn: 'nnn', rr: 'rrr',
  // short vowels: the voice has no spelling for a bare short a, e, i or u, so a tiny carrier word is
  // rendered and only its first part is played ("text|keep" = play that fraction of the clip)
  a: 'ap|0.65', e: 'ech|0.65', i: 'iss|0.55', o: 'ah', u: 'up|0.65',
  // long vowels are the letter names, which is exactly their sound
  'a-long': 'A', 'e-long': 'ee', 'i-long': 'I', 'o-long': 'O', 'u-long': 'U',
  ee: 'ee', ea: 'ee', ai: 'A', ay: 'A', eigh: 'A', igh: 'I', ie: 'I',
  'y-ee': 'ee', 'y-eye': 'I',
  oa: 'O', oe: 'O', ou: 'ouw', ow: 'ouw', oi: 'oy', oy: 'oy', aw: 'aw', au: 'aw', oo: 'ooo', ue: 'U', ew: 'U',
  ar: 'ar', or: 'or', ore: 'or', er: 'er', ir: 'er', ur: 'er', air: 'air', are: 'air', ear: 'ear',
};

// Which table applies right now: the Pi's when a server voice is speaking, else the tablet's.
function soundTable() {
  try {
    return typeof speech.usingServerVoice === 'function' && speech.usingServerVoice() ? SOUNDS_PI : SOUNDS;
  } catch (err) {
    return SOUNDS;
  }
}

// Letter teams, longest first so "tch" wins over "ch" and "eigh" over "ei".
const TEAMS = ['eigh', 'tch', 'dge', 'igh', 'air', 'are', 'ear', 'ore',
  'sh', 'ch', 'th', 'ng', 'ck', 'ph', 'wh', 'kn', 'wr', 'qu',
  'ee', 'ea', 'ai', 'ay', 'oa', 'oe', 'oo', 'ou', 'ow', 'oi', 'oy', 'aw', 'au',
  'ar', 'or', 'er', 'ir', 'ur', 'ue', 'ew', 'ie',
  'll', 'ss', 'ff', 'zz', 'tt', 'pp', 'dd', 'bb', 'gg', 'mm', 'nn', 'rr'];
const START_ONLY = new Set(['kn', 'wr']);    // the silent letter is only silent at the front
const VOWELS = 'aeiou';

// Words where g stays hard before e, i or y (get, give, girl, tiger). English has no rule for
// these, so the common ones are listed; a word with an ending is checked by its base word
// (gives, giving, getting, giggled, beginning).
const HARD_G = new Set(['get', 'give', 'given', 'gift', 'girl', 'begin', 'forget', 'forgive', 'together',
  'tiger', 'geese', 'gear', 'giggle', 'gill', 'gig', 'giddy', 'gecko', 'gibbon', 'gimme', 'girth', 'gizmo',
  'target', 'eager', 'burger', 'hamburger', 'bogey', 'gilded']);
const G_ENDINGS = ['s', 'es', 'd', 'ed', 'ing', 'er', 'ers', 'est', 'y'];

function hardG(word) {
  const w = word.replace(/[^a-z]/g, '');
  if (HARD_G.has(w)) return true;
  return G_ENDINGS.some((end) => {
    if (!w.endsWith(end) || w.length <= end.length + 1) return false;
    const base = w.slice(0, -end.length);
    return HARD_G.has(base) || HARD_G.has(`${base}e`)                       // gives, giving
      || (base.length > 2 && base[base.length - 1] === base[base.length - 2]
        && HARD_G.has(base.slice(0, -1)));                                    // getting, beginning
  });
}

// Words where a final -ve keeps the vowel short (English never ends a word in v, so the e is
// only there for spelling): give, live, have, love. Checked with an ending s or d too (gives, lived).
const SHORT_VE = new Set(['give', 'live', 'have', 'love', 'dove', 'glove', 'shove', 'above']);
const shortVe = (w) => SHORT_VE.has(w) || (/[sd]$/.test(w) && SHORT_VE.has(w.slice(0, -1)));
// Sounds after which an ending -es is a syllable of its own (faces, boxes, wishes), not a silent e (cakes).
const HISS = new Set(['s', 'ss', 'z', 'zz', 'x', 'sh', 'ch', 'tch', 'dge', 'c-soft', 'g-soft']);
// Words that end in -ed without it being an ending: the e is heard (hundred, wicked, naked).
const ED_HEARD = new Set(['hundred', 'kindred', 'hatred', 'sacred', 'wicked', 'naked', 'rugged', 'ragged', 'jagged',
  'crooked', 'wretched', 'beloved', 'dogged', 'legged']);

const isVowelKey = (key) => !!key && (VOWELS.includes(key[0]) || key.startsWith('y-'));
// A soft c or g is still one consonant letter, so magic e works across it (cage, race, ice);
// x is two sounds (/ks/), so it never is one (axe, fixed, boxes), as in tools/decodability.py.
const isSingleConsonant = (key) => !!key && (key === 'c-soft' || key === 'g-soft'
  || (key.length === 1 && /[a-z]/.test(key) && !VOWELS.includes(key) && key !== 'y' && key !== 'x'));

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
  // c and g are soft before e, i or y (city, giant, gym), except the hard-g words above.
  const keepHardG = hardG(w);
  for (let k = 0; k < n - 1; k++) {
    const next = parts[k + 1].text[0];
    if (parts[k].key === 'c' && 'eiy'.includes(next)) parts[k].key = 'c-soft';
    else if (parts[k].key === 'g' && 'eiy'.includes(next) && !keepHardG) parts[k].key = 'g-soft';
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
  // Magic e (cake, hope, bike): also under an ending s or d when the base is one syllable (cakes,
  // named; opened and visited are left alone), and across a soft c or g in a one-syllable word only
  // (cage, race, ice; village and office keep their short vowel). The short -ve words are listed.
  const tail = n >= 2 && (parts[n - 1].key === 's' || parts[n - 1].key === 'd') ? 1 : 0;
  const e = n - 1 - tail;                                 // where a final e would be
  const before = e >= 1 ? parts[e - 1].key : null;        // the sound in front of it
  const soft = before === 'c-soft' || before === 'g-soft';
  const magic = e >= 2 && parts[e].key === 'e' && isSingleConsonant(before)
    && VOWELS.includes(parts[e - 2].key || '-') && parts[e - 2].key.length === 1
    && (!(tail || soft) || !parts.slice(0, e - 2).some((q) => isVowelKey(q.key)))
    && !shortVe(w);
  if (n === 1 && (w === 'i' || w === 'a')) {
    parts[0].key = `${w}-long`;                           // the words "I" and "a"
  } else if (magic) {
    parts[e - 2].key += '-long';
    if (!tail) parts[e].key = null;                       // cake; under an ending the rule below decides
  } else if (n >= 2 && parts[n - 1].key && parts[n - 1].key.length === 1 && 'eiou'.includes(parts[n - 1].key)) {
    const earlier = parts.slice(0, n - 1).some((q) => isVowelKey(q.key));
    // An open syllable at the end is long (go, hi, me); a final e after another vowel is silent (apple).
    if (parts[n - 1].key === 'e' && earlier) parts[n - 1].key = null;
    else parts[n - 1].key += '-long';
  }
  // An ending -es or -ed is a syllable of its own only after a hiss (boxes, faces) or a t / d
  // (wanted, hated); after any other sound the e is silent and only the s or d is heard (cakes,
  // apples, elves, jumped, asked, played). A word that merely ends in those letters keeps its e
  // (yes, red: no vowel before the e; hundred, wicked: listed).
  if (tail && parts[e].key === 'e' && before && parts.slice(0, e).some((q) => isVowelKey(q.key))
    && !(parts[n - 1].key === 'd' && ED_HEARD.has(w))) {
    const heard = parts[n - 1].key === 's' ? HISS.has(before) : ['t', 'd', 'tt', 'dd'].includes(before);
    if (!heard) parts[e].key = null;
  }
  const table = soundTable();
  return parts.map((p) => ({ text: p.text, sound: p.key ? table[p.key] || '' : '' }));
}

// A story word as the Word Card and 🎨 Show sounds draw it: the letters as written (the
// punctuation around the token dropped, the case kept) cut into sound parts.
//   text    the word as written: "Max's", "don't", "Sam"
//   clean   the dictionary word (cleanWord): "max", "don't", "sam"
//   tricky  true when the word is in the story's tricky list: drawn whole, no marks
//   parts   [{ text, sound, kind }] with kind 'sound' (one letter, a dot under it), 'team'
//           (a letter team, a line under it), 'silent' (a silent letter, greyed, no mark) or
//           'punct' (an apostrophe or hyphen: shown, but not a sound and not a letter)
export function wordParts(token, trickyList = []) {
  const text = trimWord(token);
  const clean = cleanWord(token);
  const tricky = (Array.isArray(trickyList) ? trickyList : []).some((t) => cleanWord(t) === clean);
  let at = 0;
  const parts = splitSounds(text).map((p) => {
    const piece = text.slice(at, at + p.text.length);     // splitSounds lower-cases; keep the case as written
    at += p.text.length;
    const kind = !/\p{L}/u.test(piece) ? 'punct' : !p.sound ? 'silent' : p.text.length > 1 ? 'team' : 'sound';
    return { text: piece, sound: p.sound, kind };
  });
  return { text, clean, tricky, parts };
}

// What to say, in order: each sound that is not silent, then the whole word.
export function soundOut(word) {
  return splitSounds(word).map((p) => p.sound).filter(Boolean).concat([String(word)]);
}

// Say the word sound by sound, then whole. onPart(i) gets the index into soundOut(word) as
// each item starts, and -1 at the end. Resolves true when nothing cut it off.
//   opts.rate   the voice's pace (the screens pass the readRate setting)
//   opts.gapMs  the pause between sounds; longer than a sentence's so the sounds do not blur
export function sayItOut(word, onPart, opts = {}) {
  return speech.speakEach(soundOut(word), onPart, { gapMs: 320, kind: 'sound', ...opts });
}
