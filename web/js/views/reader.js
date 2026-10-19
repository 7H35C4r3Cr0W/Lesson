// The Read screen: a story on a paper page, one page at a time.
//
//   #/read/<deckId>
//
// Reading by himself (the default): tap a word to hear it (with 🔤 Sound it out on, it is
// sounded out first), 🔊 Read to me reads the page, ▶ Next page turns it, and 👍 I read it!
// on the last page earns a star. Words he tapped for help are remembered for Grown-ups → Reading.
//
// Scored (a grown-up, behind a dialog): Start when the child begins, tap each word read
// wrong on every page, Finished at the end. The tablet works out words correct per minute
// and keeps it; the child only ever sees stars (no clock and no number per minute on screen).

import { h, clear } from '../dom.js';
import { cleanWord, countsAsWord, levelPath, passagePages, passageParagraphs, passageTokens, stickersEarned, trimWord,
  wcpmOf, wordCount } from '../logic.js';
import * as store from '../store.js';
import * as speech from '../speech.js';
import * as sfx from '../sfx.js';
import { sayItOut, splitSounds } from '../phonics.js';
import { confetti, confirmDialog, go, icon, starCounter, starRow, tap, wake } from '../ui.js';
import { STICKERS } from './stickers.js';

const SAID_MS = 1000;          // how long a tapped word glows
const BUBBLE_MS = 2600;        // how long "Read the whole story first!" stays up
const MAX_SECONDS = 1800;      // the longest read the Pi accepts

// ---- the story page (shared with the quiz's 📖 Story peek) -----------------

// The story as a page of tappable words. Every word is a button that does not look like one.
//   onWordTap(el, token)  called with the word's button and the token as written
//   page                  which page to show (see passagePages); every page, with breaks, when null
export function storyElement(deck, { onWordTap = null, page = null } = {}) {
  const pages = passagePages(deck.passage ? deck.passage.text : '');
  const shown = page == null ? pages : [pages[page] || ''];
  return h('div', { class: 'story', 'aria-label': deck.title }, shown.map((text, i) => [
    i ? h('div', { class: 'story-break', 'aria-hidden': 'true' }, '✦') : null,
    passageParagraphs(text).map((lines) =>
      h('p', { class: 'story-par' }, lines.map((line) =>
        h('span', { class: 'story-line' }, passageTokens(line).map((token, k) => [
          k ? ' ' : null,
          countsAsWord(token) ? wordButton(token, onWordTap) : h('span', { class: 'w-plain' }, token),
        ]))))),
  ]));
}

function wordButton(token, onWordTap) {
  const el = h('button', { class: 'w', type: 'button', dataset: { word: cleanWord(token) } }, token);
  if (onWordTap) el.addEventListener('click', () => { wake(); onWordTap(el, token); });
  return el;
}

function flash(el) {
  el.classList.remove('said');
  void el.offsetWidth;          // restart the glow
  el.classList.add('said');
  setTimeout(() => el.classList.remove('said'), SAID_MS);
}

// How a tapped word is said: whole, or sound by sound while 🔤 Sound it out is on (the story's
// tricky words are always said whole). Returns an onWordTap handler for storyElement.
//   soundingOut()  reads the switch
export function wordSpeaker(deck, soundingOut) {
  const tricky = new Set(((deck.passage && deck.passage.tricky) || []).map(cleanWord));
  return (el, token) => {
    const word = trimWord(token);
    flash(el);
    if (!soundingOut() || tricky.has(cleanWord(token))) speech.speak(word);
    else soundItOut(el, token, word);
  };
}

// Sound a word out on its own button: the letters split into sound parts (dots and lines
// like the flashcards), the part being said lit up, then the whole word, then back to plain text.
const sounding = new WeakMap();        // word button -> run number, so an old run cannot undo a newer one
async function soundItOut(el, token, word) {
  const run = (sounding.get(el) || 0) + 1;
  sounding.set(el, run);
  const parts = splitSounds(word);
  const spoken = [];                   // index in what is said -> index of the part (silent parts are skipped)
  parts.forEach((p, i) => { if (p.sound) spoken.push(i); });
  const lead = token.match(/^[^\p{L}\p{N}'’]*/u)[0];
  const tail = token.slice(lead.length + word.length);
  let at = 0;
  const spans = parts.map((p) => {
    const span = h('span', { class: `part${p.text.length > 1 ? ' team' : ''}${p.sound ? '' : ' silent'}` }, word.slice(at, at + p.text.length));
    at += p.text.length;
    return span;
  });
  clear(el).append(lead, ...spans, tail);
  el.classList.add('sounding');
  await sayItOut(word, (k) => {
    if (sounding.get(el) !== run) return;
    spans.forEach((span, i) => span.classList.toggle('now', k >= 0 && spoken[k] === i));
    el.classList.toggle('whole', k === spoken.length);
  });
  if (sounding.get(el) !== run) return;
  el.classList.remove('sounding', 'whole');
  el.textContent = token;
}

// The 🔤 Sound it out switch. get() reads the setting, set(on) stores it.
export function soundSwitch(get, set) {
  const btn = h('button', { class: 'btn big toggle sound-switch', type: 'button' },
    h('span', { class: 'btn-emoji' }, '🔤'), 'Sound it out');
  const paint = () => {
    btn.classList.toggle('on', !!get());
    btn.setAttribute('aria-pressed', String(!!get()));
  };
  btn.addEventListener('click', tap(() => { set(!get()); paint(); }, null));
  paint();
  return btn;
}

// ---- the screen -------------------------------------------------------------

export function mount(root, scope, deckId) {
  const deck = store.state.deckById.get(deckId);
  if (!deck || !deck.passage || !deck.passage.text) return go(`/deck/${deckId}`);
  const level = levelPath(store.decksOf(deck.subject), store.state.stats, store.levelOpts()).find((l) => l.deck.id === deck.id);
  // A locked level cannot be opened by typing its address either.
  if (level && !level.unlocked) return go(`/subject/${deck.subject}`);
  const sub = store.subjectById(deck.subject) || {};
  const canSpeak = speech.available() && store.prefs().speech;
  const text = deck.passage.text;
  const pages = passagePages(text);
  if (!pages.length) return go(`/deck/${deck.id}`);    // a passage of only page breaks has nothing to read
  const paged = pages.length > 1;
  const words = wordCount(text);                       // the whole story, every page
  const openedAt = performance.now();
  const starsBefore = store.state.stars;
  const before = store.state.reads[deck.id] || null;   // for "Last time · Best" on the result card
  const helps = new Set();                             // words he tapped for help, reading by himself
  let page = 0;
  let scoring = false;                                 // the grown-up's scoring mode
  let startedAt = null;                                // performance.now() at Start; never shown
  let speaking = false;                                // 🔊 Read to me is running
  let readRun = 0;
  let soundingOut = false;                             // 🔤 Sound it out
  let done = false;
  let bubbleTimer = null;

  const sayWord = wordSpeaker(deck, () => soundingOut);
  const onWordTap = (el, token) => {
    if (done) return;
    if (scoring && startedAt != null) {                // scoring: a tap marks (or unmarks) a word read wrong, quietly
      el.classList.toggle('miss');
      return;
    }
    sayWord(el, token);
    if (!scoring) {                                    // by himself: a tapped word is one he wanted help with
      helps.add(cleanWord(token));
      el.classList.add('help');
    }
  };
  // Every page is built once, so marks and glows survive turning back and forth.
  const pageEls = pages.map((_, i) => storyElement(deck, { onWordTap, page: i }));
  const lineTexts = pages.map((p) => passageParagraphs(p).flat());
  const lineWords = pageEls.map((el) => Array.from(el.querySelectorAll('.story-line')).map((line) => Array.from(line.querySelectorAll('.w'))));
  const allWords = pageEls.flatMap((el) => Array.from(el.querySelectorAll('.w')));

  const pageLabel = h('div', { class: 'read-page-label' });
  const stage = h('div', { class: 'read-stage scroll' });
  const bubble = h('div', { class: 'read-bubble', hidden: true });
  const foot = h('div', { class: 'read-foot' });
  const prevBtn = h('button', { class: 'round nav-arrow', type: 'button', 'aria-label': 'Page before', onclick: tap(() => turn(-1)) }, icon('back'));
  const nextBtn = h('button', { class: 'round nav-arrow', type: 'button', 'aria-label': 'Next page', onclick: tap(() => turn(1)) }, icon('next'));
  const emoji = deck.emoji || sub.emoji || '';

  root.append(h('section', { class: 'screen reader', style: { '--c': sub.color, '--t': sub.tint } },
    h('header', { class: 'bar' },
      h('button', { class: 'round', type: 'button', 'aria-label': 'Close', onclick: tap(() => go(`/deck/${deck.id}`)) }, icon('close')),
      h('div', { class: 'bar-title-wrap' },
        h('h1', { class: 'bar-title' }, emoji ? h('span', { class: 'bar-emoji' }, emoji) : null, deck.title),
        paged ? pageLabel : null),
      starCounter(scope, { link: false })),
    h('div', { class: 'read-body' }, paged ? prevBtn : null, stage, paged ? nextBtn : null),
    foot));

  const isLast = () => page === pages.length - 1;

  function showPage(i) {
    speech.stop();
    speaking = false;
    page = i;
    clear(stage).append(pageEls[page]);
    stage.scrollTop = 0;
    pageLabel.textContent = `Page ${page + 1} of ${pages.length}`;
    prevBtn.disabled = page === 0;
    nextBtn.disabled = isLast();
    drawFoot();
    fitStory();
  }

  function turn(step) {
    const target = page + step;
    if (target < 0 || target >= pages.length || done) return;
    showPage(target);
  }

  // Shrink the type a step at a time when the whole page would not fit the stage, so a usual
  // story sits on one screen in landscape with the buttons showing; past the floor it scrolls.
  function fitStory() {
    const story = pageEls[page];
    story.style.removeProperty('--read-size');
    story.style.removeProperty('--read-leading');
    const fits = () => stage.scrollHeight <= stage.clientHeight;
    const mark = () => stage.classList.toggle('can-scroll', !fits());   // a fade says "more below"
    if (!stage.clientHeight || fits()) return mark();
    const base = Math.round(parseFloat(getComputedStyle(story).fontSize)) || 32;
    for (const [px, leading] of [[base, 1.6], [base, 1.5], [base - 2, 1.5], [base - 4, 1.5], [base - 6, 1.5]]) {
      if (px < 26) return;
      story.style.setProperty('--read-size', `${px}px`);
      story.style.setProperty('--read-leading', String(leading));
      if (fits()) return mark();
    }
    mark();
  }

  function drawFoot() {
    clear(foot).append(bubble);
    const row = h('div', { class: 'read-foot-row' });
    const big = (cls, icon_, label, fn) => h('button', { class: `btn big ${cls}`, type: 'button', onclick: tap(fn) },
      h('span', { class: 'btn-emoji' }, icon_), label);
    if (!scoring) {
      if (canSpeak) {
        row.append(h('button', { class: `btn big${speaking ? ' on' : ''}`, type: 'button', onclick: tap(readToMe, null) },
          h('span', { class: 'btn-emoji' }, speaking ? '⏹️' : '🔊'), speaking ? 'Stop' : 'Read to me'));
        row.append(soundSwitch(() => soundingOut, (on) => { soundingOut = on; }));
      }
      row.append(isLast() ? big('primary', '👍', 'I read it!', iReadIt) : big('primary', '▶️', 'Next page', () => turn(1)));
    } else if (startedAt == null) {
      row.append(big('primary', '▶️', 'Start', startScoring));
    } else {
      row.append(isLast() ? big('primary', '✅', 'Finished', finishScoring) : big('primary', '▶️', 'Next page', () => turn(1)));
    }
    foot.append(row);
    if (scoring) {
      foot.append(h('p', { class: 'read-hint' }, startedAt == null
        ? 'Tap Start when the child begins reading.'
        : 'Tap each word that was read wrong, then tap Finished.'));
    }
    foot.append(h('button', { class: 'btn ghost small read-mode-toggle', type: 'button', onclick: tap(toggleMode, null) },
      scoring ? 'Back to reading by myself' : 'Grown-up: score this read'));
  }

  function showBubble(message) {
    bubble.textContent = message;
    bubble.hidden = false;
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => { bubble.hidden = true; }, BUBBLE_MS);
  }

  // 🔊 Read to me: the page line by line, each line lit up as it is read. Tapping again stops.
  async function readToMe() {
    if (speaking) {
      speech.stop();                                   // speakEach bails out and the button turns back
      return;
    }
    const run = ++readRun;
    const mine = page;
    speaking = true;
    drawFoot();
    const rows = lineWords[mine];
    await speech.speakEach(lineTexts[mine].map((line) => line.replace(/["“”]/g, '')), (i) => {
      rows.forEach((ws, n) => ws.forEach((w) => w.classList.toggle('reading', n === i)));
    });
    if (!scope.alive || run !== readRun) return;
    speaking = false;
    if (!done && page === mine) drawFoot();
  }

  // 👍 I read it!: only after enough time to have read the whole story, so a quick tap earns nothing.
  function iReadIt() {
    if (performance.now() - openedAt < Math.max(8, words * 0.25) * 1000) {
      speech.speak('Read the whole story first!');
      showBubble('Read the whole story first!');
      return;
    }
    finish({ mode: 'self', words, errors: Math.min(words, helps.size), seconds: null, missed: Array.from(helps) });
  }

  function startScoring() {
    speech.stop();
    startedAt = performance.now();
    // The words-per-minute sum uses the whole story, so the clock must start on page 1
    // even if the grown-up paged ahead before tapping Start.
    if (page !== 0) showPage(0);
    else drawFoot();
  }

  function finishScoring() {
    const marked = allWords.filter((el) => el.classList.contains('miss'));
    const seconds = Math.min(MAX_SECONDS, Math.max(1, Math.round((performance.now() - startedAt) / 1000)));
    // A Start-then-Finished slip would record hundreds of words a minute and sit in "best" for good:
    // nobody reads faster than about eight words a second, so a quicker "read" goes back to Start.
    if (seconds < Math.max(3, Math.round(words / 8))) {
      startedAt = null;
      allWords.forEach((el) => el.classList.remove('miss'));
      showBubble('That was quick! Tap Start when the reading begins, Finished at the end.');
      drawFoot();
      return;
    }
    const missed = Array.from(new Set(marked.map((el) => el.dataset.word).filter(Boolean)));
    finish({ mode: 'scored', words, errors: Math.min(words, marked.length), seconds, missed });
  }

  function setScoring(on) {
    scoring = on;
    startedAt = null;
    if (!on) allWords.forEach((el) => el.classList.remove('miss'));
    showPage(0);                                       // scoring starts from the first page
  }

  function toggleMode() {
    if (scoring) return setScoring(false);
    confirmDialog('Score this read?',
      'Tap Start when the child begins reading. Tap any word read wrong. Tap Finished at the end. '
      + 'The tablet works out words per minute; the child only sees stars.',
      'Start scoring', () => setScoring(true));
  }

  function finish(read) {
    done = true;
    speech.stop();
    const summary = store.recordRead({ deck: deck.id, ...read });
    showResult(read, summary);
  }

  // The result card: one star, a cheer, and the numbers in small print for the grown-up only.
  function showResult(read, summary) {
    clear(root);
    const scored = read.mode === 'scored';
    const title = scored ? 'Great reading!' : 'Nice reading!';
    const stickerBefore = stickersEarned(starsBefore, STICKERS.length);
    const stickerAfter = stickersEarned(store.state.stars, STICKERS.length);
    const chips = read.missed.map((w) => h('span', { class: 'word-chip' }, w));
    const note = [];
    if (scored) {
      const wcpm = wcpmOf(read.words, read.errors, read.seconds);
      note.push(h('p', null, `${read.words} words · ${read.errors} missed · ${clock(read.seconds)} → ${wcpm} words correct per minute`));
      const history = [];
      if (before && before.last && before.last.mode === 'scored' && before.last.wcpm != null) history.push(`Last time: ${before.last.wcpm}`);
      if (before && before.best != null) history.push(`Best: ${summary.best}${wcpm > before.best ? ' (new best!)' : ''}`);
      if (history.length) note.push(h('p', null, history.join(' · ')));
      if (chips.length) note.push(h('p', { class: 'word-chips' }, 'Missed: ', chips));
    } else {
      note.push(chips.length ? h('p', { class: 'word-chips' }, 'Asked for help with: ', chips) : h('p', null, 'Read it with no help!'));
    }
    root.append(h('section', { class: 'screen done reader-done' },
      h('div', { class: 'done-card' },
        h('div', { class: 'done-stars' }, starRow(1, 1)),
        h('h1', null, title),
        stickerAfter > stickerBefore
          ? h('button', { class: 'new-sticker', type: 'button', onclick: tap(() => go('/stickers')) },
            h('span', { class: 'new-sticker-emoji' }, STICKERS[stickerAfter - 1]), h('span', null, 'New sticker!'))
          : null,
        h('div', { class: 'done-actions' },
          h('button', { class: 'btn big', type: 'button', onclick: tap(() => go(`/read/${deck.id}?${Date.now()}`)) },
            h('span', { class: 'btn-emoji' }, '📖'), 'Read again'),
          h('button', { class: 'btn primary big', type: 'button', onclick: tap(() => go(`/practice/deck/${deck.id}`)) },
            h('span', { class: 'btn-emoji' }, '🎯'), 'Play')),
        h('button', { class: 'btn ghost done-map', type: 'button', onclick: tap(() => go(`/deck/${deck.id}`)) },
          icon('back'), 'Back to the level'),
        h('div', { class: 'grownup-note read-note' }, note))));
    sfx.play('win');
    confetti();
    speech.speakExtra(title);
  }

  const onResize = () => { if (!done) fitStory(); };
  window.addEventListener('resize', onResize);
  scope.add(() => {
    window.removeEventListener('resize', onResize);
    clearTimeout(bubbleTimer);
    speech.stop();
  });

  showPage(0);
  speech.speakExtra(deck.sayTitle || deck.title);
}

function clock(seconds) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
