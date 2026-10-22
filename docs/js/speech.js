// The reading voice: the tablet's built-in speech, or a natural voice the Pi renders itself
// (Piper, see README › Natural voice from the Pi) and serves as audio clips from /api/tts.
//
// iPad Safari has a few habits this file works around:
//   * it stays silent until the first tap, so unlock() is called from one
//   * the voice list arrives late, so we listen for 'voiceschanged'
//   * speak() straight after cancel() can be swallowed, so we leave a short gap
//   * 'end' sometimes never fires, so every utterance also has a timer
//   * utterances can be garbage-collected mid-sentence, so we hold a reference
//   * an AudioContext only plays once a tap has resumed it, so the Pi's clips go through the
//     one sfx.js wakes on the first touch instead of a second one of their own
//
// Word by word: speak(text, { onWord }) reports the word the voice has reached, so the Read
// screen can light one word at a time. The Pi's clips have a known length, so the words are
// spread over it by their letters (wordSchedule). The tablet's voice reports word boundaries
// on some devices only, so the same spread runs on a timer from an estimate that is tuned to
// the voice after every sentence it finishes; a real boundary event, when one comes, wins.

import { get as apiGet, storage } from './api.js';
import * as sfx from './sfx.js';
import { stripEmoji } from './logic.js';

const VOICE_KEY = 'starcards.voice';
const PI = 'pi:';                   // a saved voice id starting with this is one of the Pi's
const TTS_MAX_CHARS = 300;          // the server's cap; the pre-rendered cache uses the same rule
const TTS_TIMEOUT_MS = 10000;       // a clip the Pi cannot serve in this time is said by the tablet instead
const TTS_RETRY_MS = 30000;         // after a failed clip, leave the Pi alone for this long
// Word timing. A Piper clip starts with about 0.1 s of lead-in and ends with --sentence_silence
// 0.2 (see server.py), so its words are spread over [LEAD_S, duration - TAIL_S].
const LEAD_S = 0.08;
const TAIL_S = 0.25;
const SERVER_LEAD_MS = 0;           // light a word this much before the clip reaches it (raise if it feels late)
// The tablet's voice: seconds per weight unit (see wordWeights) at rate 1 before a voice has
// been measured. A ten-word sentence of fifty letters weighs 63, so it takes about 4 s at 0.7.
const PACE_START = 0.045;
const PACE_MIN = 0.015;             // a measurement outside this band is noise (an instant 'end', a stall)
const PACE_MAX = 0.4;
const PACE_MIN_WEIGHT = 12;         // learn the pace from sentences only: a lone word is mostly start-up
const START_FALLBACK_MS = 600;      // no 'start' event by then: run the word timers anyway
const synth = 'speechSynthesis' in window ? window.speechSynthesis : null;

// Clear, natural voices first. The list also keeps us off the joke voices iOS ships under en-US.
const PREFERRED = ['Samantha', 'Ava', 'Allison', 'Susan', 'Zoe', 'Nicky', 'Joelle', 'Evan', 'Tom', 'Aaron',
  'Google US English', 'Microsoft Aria', 'Microsoft Jenny', 'Microsoft Zira', 'Karen', 'Daniel', 'Moira'];
const NOVELTY = /albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|kathy|ralph|eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley/i;
// A downloaded (Enhanced / Premium / Siri) tablet voice, as opposed to the robotic built-in one.
const NATURAL = /natural|neural|enhanced|premium|siri/i;

let voices = [];            // the tablet's English voices
let chosen = null;          // the tablet voice in use; also the stand-in when a Pi clip cannot be fetched
let serverVoices = [];      // what /api/voices listed: [{ id, name, lang }], ids without the 'pi:' prefix
let serverDefault = null;   // the id the Pi suggests
let serverChosen = null;    // the Pi voice in use, or null for the tablet's own voice
let serverLoading = null;   // the /api/voices call in flight
let serverLoaded = false;   // true once the Pi answered, even with an empty list (the demo copy)
let serverDownUntil = 0;    // after a clip fails: the tablet speaks until this time (ms)
let unlocked = false;
let current = null;         // { finish } of what is being said: a tablet utterance or a Pi clip
let epoch = 0;              // bumped by stop(); lets speakEach bail when something else cancels speech
const pace = new Map();     // tablet voice URI -> measured seconds per weight unit at rate 1
// mode 'help' = speak only when needed (the word in a listening question, after a miss,
// the answer after two misses, 🔊 and Help taps); 'full' = also read titles, questions, choices.
let settings = { enabled: true, rate: 0.95, mode: 'help' };

// Is this voice id one of the Pi's (saved as 'pi:<id>') rather than a tablet voice URI?
export function isServerVoice(id) {
  return typeof id === 'string' && id.length > PI.length && id.startsWith(PI);
}

function findServerVoice(id) {
  return isServerVoice(id) ? serverVoices.find((v) => PI + v.id === id) || null : null;
}

function deviceQuality(v) {
  return NATURAL.test(`${v.name} ${v.voiceURI}`) ? 'natural' : 'basic';
}

function loadVoices() {
  if (!synth) return;
  voices = synth.getVoices().filter((v) => /^en([-_]|$)/i.test(v.lang));
  chooseVoice();
}

// The most natural voice on this device: enhanced/premium/neural voices first (on an iPad
// these are the ones downloaded under Settings > Accessibility > Spoken Content > Voices),
// then well-known good voices by name, US English before other accents, never the joke voices.
function score(v) {
  let s = 0;
  const name = v.name || '';
  if (NATURAL.test(name + v.voiceURI)) s += 6;
  if (/^en[-_]US/i.test(v.lang)) s += 2;
  const idx = PREFERRED.findIndex((p) => name.startsWith(p));
  if (idx >= 0) s += 4 - idx * 0.1;
  if (/compact/i.test(name + v.voiceURI)) s -= 2;
  if (/\bonline\b/i.test(name)) s -= 1;          // needs the internet; fine, but a local one is safer
  if (NOVELTY.test(name)) s -= 20;
  if (v.localService) s += 0.5;
  return s;
}

function pickDefault() {
  return voices.slice().sort((a, b) => score(b) - score(a))[0] || null;
}

// Match the saved choice to what is on hand right now (the tablet's list arrives late, the Pi's
// after a round trip): a Pi voice while the Pi still lists it, a tablet voice by its URI, the
// Pi's default when nothing was ever saved, else the best tablet voice. A saved Pi voice the Pi
// no longer has (the demo copy, Piper not installed) quietly becomes the best tablet voice. A
// tablet voice is always resolved too: it stands in when a Pi clip cannot be fetched.
function chooseVoice() {
  const saved = storage.get(VOICE_KEY);
  const device = typeof saved === 'string' && !isServerVoice(saved) ? voices.find((v) => v.voiceURI === saved) : null;
  chosen = device || pickDefault();
  if (isServerVoice(saved)) serverChosen = findServerVoice(saved);
  else if (saved) serverChosen = null;
  else serverChosen = serverDefault ? findServerVoice(PI + serverDefault) : null;
}

if (synth) {
  loadVoices();
  if (synth.addEventListener) synth.addEventListener('voiceschanged', loadVoices);
  else synth.onvoiceschanged = loadVoices;
}

export function available() {
  return !!synth;
}

// Ask the Pi which natural voices it has (none on the demo copy, or without Piper). configure()
// asks once at start-up and listVoices() asks again if needed: after an answer this is a no-op,
// after a call that could not reach the Pi the next one tries again. The settings page passes
// refresh: true to ask again anyway (voices installed on the Pi since the app was opened).
// Never rejects.
export function loadServerVoices({ refresh = false } = {}) {
  if (serverLoading) return serverLoading;
  if (serverLoaded && !refresh) return Promise.resolve(listServerVoices());
  serverLoading = apiGet('/api/voices').then((data) => {
    serverVoices = cleanServerVoices(data);
    const suggested = data && typeof data.default === 'string' ? data.default : null;
    serverDefault = serverVoices.some((v) => v.id === suggested) ? suggested : (serverVoices.length ? serverVoices[0].id : null);
    serverLoaded = true;
  }, () => {
    /* cannot reach the Pi, or an older server without voices: keep what we knew */
  }).then(() => {
    serverLoading = null;
    chooseVoice();
    return listServerVoices();
  });
  return serverLoading;
}

function cleanServerVoices(data) {
  const out = [];
  for (const v of data && Array.isArray(data.voices) ? data.voices : []) {
    if (!v || typeof v.id !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(v.id)) continue;
    out.push({ id: v.id, name: typeof v.name === 'string' && v.name.trim() ? v.name.trim() : v.id,
      lang: typeof v.lang === 'string' && v.lang ? v.lang : 'en-US' });
  }
  return out;
}

function listServerVoices() {
  return serverVoices.map((v) => ({ id: PI + v.id, name: `${v.name} (natural, from the Pi)`, lang: v.lang, server: true, quality: 'natural' }));
}

export function configure({ enabled, rate, mode }) {
  settings = { enabled: enabled !== false, rate: rate || 0.95, mode: mode === 'full' ? 'full' : 'help' };
  if (!settings.enabled) stop();
  loadServerVoices();
}

// True when the grown-up asked for everything to be read aloud (titles, questions, choices).
export function full() {
  return settings.enabled && settings.mode === 'full';
}

// Say something only in "read everything" mode. Resolves false otherwise.
export function speakExtra(text) {
  return full() ? speak(text) : Promise.resolve(false);
}

// The Pi's natural voices first (server: true), then the tablet's. Every entry carries a
// quality, 'natural' or 'basic', so the settings page can label them.
export function listVoices() {
  loadServerVoices();
  if (!voices.length) loadVoices();
  return listServerVoices().concat(voices.filter((v) => !NOVELTY.test(v.name))
    .map((v) => ({ id: v.voiceURI, name: v.name, lang: v.lang, server: false, quality: deviceQuality(v) })));
}

// Is the voice in use a natural one (the Pi's, or a downloaded tablet voice), or the basic
// built-in one? On an iPad the built-in voices sound robotic; Settings › Accessibility › Spoken
// Content › Voices offers Enhanced / Premium downloads that this app picks up automatically.
export function voiceQuality() {
  if (serverChosen) return 'natural';
  if (!chosen) return 'none';
  return deviceQuality(chosen);
}

export function currentVoice() {
  if (serverChosen) return PI + serverChosen.id;
  return chosen ? chosen.voiceURI : null;
}

export function setVoice(id) {
  if (isServerVoice(id)) {
    const hit = findServerVoice(id);
    if (!hit) return;
    serverChosen = hit;
    serverDownUntil = 0;             // a fresh pick gets a fresh try
    if (!chosen) chosen = pickDefault();
    storage.set(VOICE_KEY, id);
    return;
  }
  const hit = voices.find((v) => v.voiceURI === id);
  if (hit) {
    chosen = hit;
    serverChosen = null;
    storage.set(VOICE_KEY, id);
  }
}

// Call from inside a tap handler. iOS only lets a page talk after the user has touched it.
export function unlock() {
  sfx.unlock();                      // the Pi's clips play through sfx's AudioContext: one tap wakes both
  if (!synth || unlocked) return;
  unlocked = true;
  try {
    const hush = new SpeechSynthesisUtterance(' ');
    hush.volume = 0;
    synth.speak(hush);
  } catch {
    /* ignore */
  }
  if (!voices.length) loadVoices();
}

// Cancel the current utterance without counting as an external stop (speak() uses this
// to clear the previous sentence before starting its own).
function cancelCurrent() {
  if (current) {
    const done = current.finish;
    current = null;
    done(false);
  }
  if (synth) {
    try {
      synth.cancel();
    } catch {
      /* ignore */
    }
  }
}

export function stop() {
  epoch += 1;
  cancelCurrent();
}

// The /api/tts address for a sentence, with the same clean-up the server (and its pre-render)
// applies: emoji and control characters out, whitespace collapsed, at most 300 characters; the
// rate on the 0.05 grid between 0.5 and 1.5. The voice may carry its 'pi:' prefix or not, and
// without one the Pi uses its default voice. kind 'sound' (a letter sound, not a sentence) asks
// for a clip without the trailing pause. Null when nothing is left to say.
export function ttsUrl(text, voiceId, rate, kind = null) {
  // The cut may land between the two halves of a rare non-emoji astral character (𝒜): drop the
  // orphaned half, or encodeURIComponent throws.
  const clean = stripEmoji(String(text == null ? '' : text).replace(/[\u0000-\u001f\u007f]/g, ' '))
    .replace(/\s+/g, ' ').trim().slice(0, TTS_MAX_CHARS).replace(/[\ud800-\udbff]$/, '').trim();
  if (!clean) return null;
  const wanted = Number(rate);
  const speed = Math.min(1.5, Math.max(0.5, Math.round((Number.isFinite(wanted) && wanted > 0 ? wanted : 1) * 20) / 20));
  const voice = typeof voiceId === 'string' ? voiceId.replace(/^pi:/, '') : '';
  return `/api/tts?text=${encodeURIComponent(clean)}${voice ? `&voice=${encodeURIComponent(voice)}` : ''}&rate=${speed.toFixed(2)}${kind === 'sound' ? '&kind=sound' : ''}`;
}

function serverReady() {
  return !!serverChosen && Date.now() >= serverDownUntil;
}

// Is the voice speaking right now one of the Pi's? False when the tablet's own voice stands
// in: no Pi voice chosen (the demo copy, Piper not installed) or the Pi's last clip failed.
export function usingServerVoice() {
  return serverReady();
}

// ---- word timing -------------------------------------------------------------

// The words of a text as the voice counts them: whitespace-separated, punctuation attached.
export function wordsOf(text) {
  return String(text == null ? '' : text).trim().split(/\s+/).filter(Boolean);
}

// Where each word starts in the text (character offsets, for the tablet's boundary events).
export function wordStarts(text) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(String(text == null ? '' : text)))) out.push(m.index);
  return out;
}

// How long a word takes relative to the others: its letters plus one, at least 2, plus a
// pause of 2 after a comma, semicolon or colon and 3 after a full stop, ! or ? (a closing
// quote or bracket after the stop does not hide it).
export function wordWeights(words) {
  return words.map((word) => {
    const letters = (String(word).match(/[\p{L}\p{N}]/gu) || []).length;
    const tail = String(word).replace(/["'”’)\]]+$/u, '');
    let weight = Math.max(2, letters + 1);
    if (/[.!?]$/.test(tail)) weight += 3;
    else if (/[,;:]$/.test(tail)) weight += 2;
    return weight;
  });
}

// Start times (seconds) that spread the weights over [from, to], in order.
function spread(weights, from, to) {
  const total = weights.reduce((a, b) => a + b, 0);
  const span = Math.max(0, to - from);
  let before = 0;
  return weights.map((w) => {
    const t = from + (total ? (span * before) / total : 0);
    before += w;
    return t;
  });
}

// When each word of a Pi clip starts, given the clip's length: the words spread by weight over
// the clip minus Piper's lead-in and the sentence silence at its end (both shortened for a clip
// too short to hold them). One entry per word, never decreasing.
export function wordSchedule(text, seconds) {
  const total = Number(seconds) > 0 ? Number(seconds) : 0;
  const lead = Math.min(LEAD_S, total * 0.1);
  const tail = Math.min(TAIL_S, total * 0.3);
  return spread(wordWeights(wordsOf(text)), lead, Math.max(lead, total - tail));
}

// Fire light(i) for each word at its start time, counted from t0 (a performance.now() value).
// Returns a function that cancels what has not fired yet.
function runSchedule(times, t0, light) {
  const elapsed = performance.now() - t0;
  const timers = times.map((t, i) => setTimeout(() => light(i), Math.max(0, t * 1000 - elapsed)));
  return () => timers.forEach(clearTimeout);
}

// The tablet voice's measured pace, seconds per weight unit at rate 1.
function paceOf(voiceKey) {
  return pace.has(voiceKey) ? pace.get(voiceKey) : PACE_START;
}

// Tune a voice's pace toward a finished sentence's measured length (an exponential average).
function learnPace(voiceKey, seconds, rate, weight) {
  if (!(weight >= PACE_MIN_WEIGHT) || !(seconds > 0) || !(rate > 0)) return;
  const observed = (seconds * rate) / weight;
  if (observed < PACE_MIN || observed > PACE_MAX) return;
  pace.set(voiceKey, paceOf(voiceKey) * 0.6 + observed * 0.4);
}

// Follows the tablet's voice through a text, word by word, for speak(text, { onWord }).
//   start()       the voice began (the 'start' event, or the fallback timer): the estimated
//                 schedule starts ticking
//   boundary(e)   a 'boundary' event: when it names a word, the schedule is dropped and the
//                 events lead from here on
//   finish(ok)    the utterance ended (ok: on its own, so its length tunes the voice's pace)
//                 or was cut: pending timers are cleared and onWord(-1) is sent
// Boundary quirks tolerated: charIndex pointing at the space before the word (off by one),
// an engine reporting the END of each word (seen from the first event, which then lands at
// the end of the first word), and an engine that reports the same index every time (back to
// the timers, which then catch up).
function wordFollower(text, rate, voiceKey, onWord) {
  const words = wordsOf(text);
  const starts = wordStarts(text);
  const weights = wordWeights(words);
  const total = weights.reduce((a, b) => a + b, 0);
  const n = words.length;
  let t0 = null;
  let cancelTimers = null;
  let byEvents = false;
  let endMode = false;
  let events = 0;
  let lastChar = -1;
  let last = -1;
  let over = false;
  const light = (i) => {
    if (over || !onWord || i <= last || i >= n) return;
    last = i;
    onWord(i, n);
  };
  const startTimers = () => {
    if (cancelTimers) cancelTimers();
    cancelTimers = onWord ? runSchedule(spread(weights, 0, (total * paceOf(voiceKey)) / rate), t0, light) : null;
  };
  // The word that holds character c, else the next one (c on the space before it), else the last.
  const wordAt = (c) => {
    for (let i = 0; i < n; i++) if (c < starts[i] + words[i].length) return i;
    return n - 1;
  };
  return {
    start() {
      if (t0 != null || over) return;
      t0 = performance.now();
      if (!byEvents) startTimers();
    },
    boundary(e) {
      if (over || !onWord || !n || !e || e.name !== 'word') return;
      if (t0 == null) t0 = performance.now();
      const c = Math.max(0, Math.floor(Number(e.charIndex)) || 0);
      events += 1;
      if (events === 1 && c >= words[0].length && c <= words[0].length + 1) endMode = true;
      if (events > 1 && c === lastChar) {            // the engine is not really counting: back to the clock
        lastChar = -1;
        byEvents = false;
        startTimers();
        return;
      }
      lastChar = c;
      if (!byEvents) {
        byEvents = true;
        if (cancelTimers) cancelTimers();
        cancelTimers = null;
      }
      light(wordAt(endMode ? Math.max(0, c - 1) : c));
    },
    finish(ok) {
      if (over) return;
      over = true;
      if (cancelTimers) cancelTimers();
      if (ok && t0 != null) learnPace(voiceKey, (performance.now() - t0) / 1000, rate, total);
      if (onWord) onWord(-1, n);
    },
  };
}

// Say something. Resolves true when it finished, false if it was cut off or speech is off.
// Starting a new sentence always cuts off the one before it.
//   opts.rate    the voice's pace
//   opts.kind    'sound' for a letter sound (the Pi renders it without the trailing pause)
//   opts.onWord  onWord(index, count): the voice reached word `index` (0-based, of `count`
//                whitespace-separated words of the text); onWord(-1, count) when it ended or was cut
export function speak(text, opts = {}) {
  const words = String(text || '').trim();
  cancelCurrent();
  if (!settings.enabled || !words) return Promise.resolve(false);
  const url = serverReady() ? ttsUrl(words, serverChosen.id, opts.rate || settings.rate, opts.kind) : null;
  return url ? speakServer(url, words, opts) : speakDevice(words, opts);
}

// The tablet's own voice.
function speakDevice(words, opts) {
  if (!synth) return Promise.resolve(false);
  if (!voices.length) loadVoices();
  return new Promise((resolve) => {
    let settled = false;
    let guard = null;
    let startFallback = null;
    let ended = false;                               // the engine's own 'end', not the guard timer
    const utterance = new SpeechSynthesisUtterance(words);
    const rate = opts.rate || settings.rate;
    const follow = wordFollower(words, rate, chosen ? chosen.voiceURI : 'default', typeof opts.onWord === 'function' ? opts.onWord : null);
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      clearTimeout(startFallback);
      if (current && current.utterance === utterance) current = null;
      follow.finish(ok && ended);
      resolve(ok);
    };
    if (chosen) {
      utterance.voice = chosen;
      utterance.lang = chosen.lang;
    } else {
      utterance.lang = 'en-US';
    }
    utterance.rate = rate;
    utterance.pitch = 1;
    utterance.onstart = () => follow.start();
    utterance.onboundary = (e) => { if (!settled) follow.boundary(e); };
    utterance.onend = () => { ended = true; finish(true); };
    utterance.onerror = () => finish(false);
    current = { utterance, finish };
    // A beat after cancel(), or iOS drops the new sentence.
    setTimeout(() => {
      if (settled) return;
      try {
        if (synth.paused) synth.resume();
        synth.speak(utterance);
      } catch {
        finish(false);
        return;
      }
      guard = setTimeout(() => finish(true), 2500 + words.length * 140);
      startFallback = setTimeout(() => follow.start(), START_FALLBACK_MS);   // some engines never say 'start'
    }, 70);
  });
}

// The Pi's voice: fetch the clip (the browser keeps it; the server marks clips immutable),
// decode it with the shared AudioContext and play it through a buffer source. Anything going
// wrong (the Pi off or without Piper, a slow render, bad audio) hands the sentence to the
// tablet's own voice so the app never falls silent, and the Pi is left alone for a while.
function speakServer(url, words, opts) {
  return new Promise((resolve) => {
    let settled = false;
    let guard = null;
    let source = null;
    let cancelWords = null;
    const onWord = typeof opts.onWord === 'function' ? opts.onWord : null;
    const count = wordsOf(words).length;
    const me = {};
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      if (cancelWords) cancelWords();
      if (current === me) current = null;
      if (source) {
        try {
          source.onended = null;
          source.stop();
        } catch {
          /* already finished */
        }
      }
      if (onWord) onWord(-1, count);
      resolve(ok);
    };
    me.finish = finish;
    current = me;
    fetchClip(url).then((clip) => {
      if (settled) return;                       // cut off while the clip was on its way
      const ctx = sfx.context();
      source = ctx.createBufferSource();
      source.buffer = clip;
      source.connect(ctx.destination);           // not chained: older Safari's connect() returns nothing
      source.onended = () => finish(true);
      if (ctx.state !== 'running') {
        const resumed = ctx.resume();
        if (resumed && typeof resumed.catch === 'function') resumed.catch(() => {});
      }
      source.start(0);
      const t0 = performance.now();
      guard = setTimeout(() => finish(true), Math.ceil(clip.duration * 1000) + 1000);
      if (onWord) {                              // the clip's length is known: the words spread over it
        let last = -1;
        cancelWords = runSchedule(wordSchedule(words, clip.duration), t0 - SERVER_LEAD_MS, (i) => {
          if (settled || i <= last) return;
          last = i;
          onWord(i, count);
        });
      }
    }).catch((err) => {
      if (settled) return;
      serverDownUntil = Date.now() + TTS_RETRY_MS;
      console.warn(`The Pi's voice is not answering (${err && err.message ? err.message : err}); using the tablet's voice for a while.`);
      settled = true;                            // the tablet utterance takes over as `current`
      if (current === me) current = null;
      resolve(speakDevice(words, opts));
    });
  });
}

// The decoded clip, or a rejection: no Web Audio here, the Pi said no (503 without Piper, 5xx),
// could not be reached, took too long, or the bytes did not decode.
async function fetchClip(url) {
  const ctx = sfx.context();
  if (!ctx) throw new Error('no Web Audio');
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => { if (ctrl) ctrl.abort(); }, TTS_TIMEOUT_MS);
  try {
    const res = await fetch(url, ctrl ? { signal: ctrl.signal } : {});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = await res.arrayBuffer();
    return await decode(ctx, bytes);
  } finally {
    clearTimeout(timer);
  }
}

// decodeAudioData takes callbacks on older Safari and returns a promise elsewhere: serve both.
function decode(ctx, bytes) {
  return new Promise((resolve, reject) => {
    let maybe;
    try {
      maybe = ctx.decodeAudioData(bytes, resolve, reject);
    } catch (err) {
      reject(err);
      return;
    }
    if (maybe && typeof maybe.then === 'function') maybe.then(resolve, reject);
  });
}

// Warm the browser's cache with the next clip while this one plays (the Pi's voice only).
// Nothing is played, and a failure here is ignored: the real request will tell.
function prefetch(text, opts) {
  if (!serverReady()) return;
  const url = ttsUrl(String(text || '').trim(), serverChosen.id, opts.rate || settings.rate, opts.kind);
  if (!url) return;
  try {
    fetch(url).then((res) => (res.ok ? res.arrayBuffer() : null)).catch(() => {});
  } catch {
    /* ignore */
  }
}

// Say several things in order, telling the caller which one is being spoken so it
// can light up the matching button. Stops early if anything else starts speaking.
//   opts.rate    a speed for this run (the story screens read slower than the quiz)
//   opts.gapMs   the pause between items (default 180 ms)
//   opts.kind    passed to speak() (the sounds of a word are 'sound' clips)
//   opts.onWord  onWord(itemIndex, wordIndex, wordCount): the voice reached a word of an item
//                (wordIndex -1 when that item ended or was cut), see speak()
export async function speakEach(items, onItem, opts = {}) {
  const mine = epoch;              // if stop() is called from elsewhere, epoch changes and we bail
  const onWord = typeof opts.onWord === 'function' ? opts.onWord : null;
  for (let i = 0; i < items.length; i++) {
    if (mine !== epoch) break;
    if (onItem) onItem(i);
    const saying = speak(items[i], onWord ? { ...opts, onWord: (w, n) => onWord(i, w, n) } : opts);
    if (i + 1 < items.length) prefetch(items[i + 1], opts);     // the next clip is on its way meanwhile
    const ok = await saying;
    if (!ok || mine !== epoch) {
      if (onItem) onItem(-1);
      return false;
    }
    await new Promise((r) => setTimeout(r, opts.gapMs || 180));
    if (mine !== epoch || current) {     // something else started or stopped during the pause
      if (onItem) onItem(-1);
      return false;
    }
  }
  if (onItem) onItem(-1);
  return true;
}
