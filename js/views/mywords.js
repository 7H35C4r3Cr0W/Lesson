// My words: the child's word bank.
//
//   #/mywords
//
// Every word he asked for help with in a story (tapped or held on the Read screen, or marked
// by a grown-up scoring a read) collects here as a big paper tile: tap to hear it (sound by
// sound with 🔤 Sound it out on), press and hold for its Word Card, 📖 Read it to open the
// story it came from. The list is the Pi's reading report, so nothing new is stored.

import { h, clear } from '../dom.js';
import * as store from '../store.js';
import * as speech from '../speech.js';
import { go, tap, topBar, wake } from '../ui.js';
import { footSwitch, longPress, openWordCard, readRate, soundSwitch, wordSpeaker } from './reader.js';

const MAX_WORDS = 30;

// The subject the stories live in: the first one with a story deck.
function storySubject() {
  return store.state.subjects.find((sub) => store.decksOf(sub.id).some((d) => d.passage && d.passage.text)) || null;
}

// The words to show, from the reading report: the missed list (most often first, at most
// MAX_WORDS) and, for each word, the stories it came from, the most recent read first.
//   → [{ word, times, decks: [deckId…] }]
export function wordBank(report) {
  const sources = new Map();                 // word -> [{ deck, at }]
  for (const d of (report && Array.isArray(report.decks) ? report.decks : [])) {
    for (const r of (d && Array.isArray(d.reads) ? d.reads : [])) {
      for (const w of (r && Array.isArray(r.missed) ? r.missed : [])) {
        if (typeof w !== 'string') continue;
        if (!sources.has(w)) sources.set(w, []);
        sources.get(w).push({ deck: d.deck, at: Number(r.at) || 0 });
      }
    }
  }
  return (report && Array.isArray(report.missed) ? report.missed : [])
    .filter((m) => m && typeof m.word === 'string' && m.word)
    .slice()
    .sort((a, b) => (Number(b.times) || 0) - (Number(a.times) || 0) || (Number(b.lastAt) || 0) - (Number(a.lastAt) || 0))
    .slice(0, MAX_WORDS)
    .map((m) => {
      const from = (sources.get(m.word) || []).slice().sort((a, b) => b.at - a.at).map((s) => s.deck).filter(Boolean);
      return { word: m.word, times: Number(m.times) || 0, decks: Array.from(new Set(from)) };
    });
}

export function mount(root, scope) {
  const sub = storySubject() || {};
  const canSpeak = speech.available() && store.prefs().speech;
  let soundingOut = false;                   // 🔤 Sound it out
  let slower = false;                        // 🐢 Slower
  const rate = () => readRate(slower);

  const body = h('div', { class: 'scroll mywords-body' }, h('p', { class: 'mywords-loading' }, 'Finding your words…'));
  root.append(h('section', { class: 'screen mywords', style: { '--c': sub.color, '--t': sub.tint } },
    topBar(scope, { back: '/', title: 'My words', emoji: '🔤' }),
    body));
  scope.add(() => speech.stop());

  const readStory = () => go(sub.id ? `/subject/${sub.id}` : '/');

  // Nothing yet (or the Pi did not answer): where words come from, and the way to a story.
  function showEmpty() {
    clear(body).append(h('div', { class: 'empty mywords-empty' },
      h('div', { class: 'empty-emoji' }, '🌈'),
      h('p', null, 'Words you ask for help with will collect here.'),
      h('button', { class: 'btn primary big', type: 'button', onclick: tap(readStory) },
        h('span', { class: 'btn-emoji' }, '📚'), 'Read a story')));
  }

  function showWords(words) {
    // Element.append() would print a null as the word "null", so the switches row is added only when there is one.
    clear(body);
    if (canSpeak) {
      body.append(h('div', { class: 'mywords-switches' },
        soundSwitch(() => soundingOut, (on) => { soundingOut = on; }),
        footSwitch('🐢', 'Slower', () => slower, (on) => { slower = on; }, 'slower')));
    }
    body.append(h('div', { class: 'word-grid' }, words.map(wordCell)));
  }

  // One word: the tile says it (tap) or opens its Word Card (hold); 📖 Read it opens the story.
  function wordCell({ word, times, decks }) {
    const deck = decks.map((id) => store.state.deckById.get(id)).find(Boolean) || null;
    const say = wordSpeaker(deck, () => soundingOut, rate);
    const text = h('span', { class: 'word-tile-word' }, word);
    const tile = h('button', { class: 'word-tile', type: 'button', 'aria-label': word },
      text,
      h('span', { class: 'word-tile-meta' }, `×${times}${deck ? ` · from ${deck.title}` : ''}`));
    longPress(tile, () => { wake(); openWordCard(word, deck, { rate: rate() }); });     // before the click handler
    tile.addEventListener('click', tap(() => say(text, word), null));
    return h('div', { class: 'word-cell' }, tile,
      deck ? h('button', { class: 'btn ghost small word-tile-read', type: 'button', onclick: tap(() => go(`/read/${deck.id}`)) },
        h('span', { class: 'btn-emoji' }, '📖'), 'Read it') : null);
  }

  Promise.resolve()
    .then(() => (typeof store.getReadingReport === 'function' ? store.getReadingReport() : null))
    .then((report) => {
      if (!scope.alive) return;
      const words = wordBank(report);
      if (words.length) showWords(words);
      else showEmpty();
    })
    .catch((err) => {
      if (!scope.alive) return;
      console.warn('My words: could not load the reading report', err);
      showEmpty();
    });
  speech.speakExtra('My words');
}
