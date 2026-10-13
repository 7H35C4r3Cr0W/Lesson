// The reading voice, using the tablet's built-in speech (no internet, no audio files).
//
// iPad Safari has a few habits this file works around:
//   * it stays silent until the first tap, so unlock() is called from one
//   * the voice list arrives late, so we listen for 'voiceschanged'
//   * speak() straight after cancel() can be swallowed, so we leave a short gap
//   * 'end' sometimes never fires, so every utterance also has a timer
//   * utterances can be garbage-collected mid-sentence, so we hold a reference

import { storage } from './api.js';

const VOICE_KEY = 'starcards.voice';
const synth = 'speechSynthesis' in window ? window.speechSynthesis : null;

// Clear, natural voices first. The list also keeps us off the joke voices iOS ships under en-US.
const PREFERRED = ['Samantha', 'Ava', 'Allison', 'Susan', 'Zoe', 'Nicky', 'Joelle', 'Evan', 'Tom', 'Aaron',
  'Google US English', 'Microsoft Aria', 'Microsoft Jenny', 'Microsoft Zira', 'Karen', 'Daniel', 'Moira'];
const NOVELTY = /albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|kathy|ralph|eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley/i;

let voices = [];
let chosen = null;
let unlocked = false;
let current = null;         // { utterance, finish }
let epoch = 0;              // bumped by stop(); lets speakEach bail when something else cancels speech
// mode 'help' = speak only when needed (the word in a listening question, after a miss,
// the answer after two misses, 🔊 and Help taps); 'full' = also read titles, questions, choices.
let settings = { enabled: true, rate: 0.95, mode: 'help' };

function loadVoices() {
  if (!synth) return;
  voices = synth.getVoices().filter((v) => /^en([-_]|$)/i.test(v.lang));
  const saved = storage.get(VOICE_KEY);
  chosen = voices.find((v) => v.voiceURI === saved) || pickDefault();
}

// The most natural voice on this device: enhanced/premium/neural voices first (on an iPad
// these are the ones downloaded under Settings > Accessibility > Spoken Content > Voices),
// then well-known good voices by name, US English before other accents, never the joke voices.
function score(v) {
  let s = 0;
  const name = v.name || '';
  if (/natural|neural|enhanced|premium|siri/i.test(name + v.voiceURI)) s += 6;
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

if (synth) {
  loadVoices();
  if (synth.addEventListener) synth.addEventListener('voiceschanged', loadVoices);
  else synth.onvoiceschanged = loadVoices;
}

export function available() {
  return !!synth;
}

export function configure({ enabled, rate, mode }) {
  settings = { enabled: enabled !== false, rate: rate || 0.95, mode: mode === 'full' ? 'full' : 'help' };
  if (!settings.enabled) stop();
}

// True when the grown-up asked for everything to be read aloud (titles, questions, choices).
export function full() {
  return settings.enabled && settings.mode === 'full';
}

// Say something only in "read everything" mode. Resolves false otherwise.
export function speakExtra(text) {
  return full() ? speak(text) : Promise.resolve(false);
}

export function listVoices() {
  if (!voices.length) loadVoices();
  return voices.filter((v) => !NOVELTY.test(v.name)).map((v) => ({ id: v.voiceURI, name: v.name, lang: v.lang }));
}

export function currentVoice() {
  return chosen ? chosen.voiceURI : null;
}

export function setVoice(voiceURI) {
  const hit = voices.find((v) => v.voiceURI === voiceURI);
  if (hit) {
    chosen = hit;
    storage.set(VOICE_KEY, voiceURI);
  }
}

// Call from inside a tap handler. iOS only lets a page talk after the user has touched it.
export function unlock() {
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

// Say something. Resolves true when it finished, false if it was cut off or speech is off.
// Starting a new sentence always cuts off the one before it.
export function speak(text, opts = {}) {
  const words = String(text || '').trim();
  cancelCurrent();
  if (!synth || !settings.enabled || !words) return Promise.resolve(false);
  if (!voices.length) loadVoices();
  return new Promise((resolve) => {
    let settled = false;
    let guard = null;
    const utterance = new SpeechSynthesisUtterance(words);
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      if (current && current.utterance === utterance) current = null;
      resolve(ok);
    };
    if (chosen) {
      utterance.voice = chosen;
      utterance.lang = chosen.lang;
    } else {
      utterance.lang = 'en-US';
    }
    utterance.rate = opts.rate || settings.rate;
    utterance.pitch = 1;
    utterance.onend = () => finish(true);
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
    }, 70);
  });
}

// Say several things in order, telling the caller which one is being spoken so it
// can light up the matching button. Stops early if anything else starts speaking.
export async function speakEach(items, onItem) {
  const mine = epoch;              // if stop() is called from elsewhere, epoch changes and we bail
  for (let i = 0; i < items.length; i++) {
    if (mine !== epoch) break;
    if (onItem) onItem(i);
    const ok = await speak(items[i]);
    if (!ok || mine !== epoch) {
      if (onItem) onItem(-1);
      return false;
    }
    await new Promise((r) => setTimeout(r, 180));
    if (mine !== epoch || current) {     // something else started or stopped during the pause
      if (onItem) onItem(-1);
      return false;
    }
  }
  if (onItem) onItem(-1);
  return true;
}
