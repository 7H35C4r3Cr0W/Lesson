// The Read screen: a story on a paper page, one page at a time.
//
//   #/read/<deckId>
//
// Reading by himself (the default): tap a word to hear it (with 🔤 Sound it out on, it is
// sounded out first), press and hold a word for its Word Card (the word big with its sounds
// marked, 🔊 Say it, 🔤 Sound it out), 🎨 Show sounds marks the sounds under every word on
// the page, 👆 Follow along dims the page and lights one word at a time as he taps along,
// 🔊 Read to me reads the page, ▶ Next page turns it, and 👍 I read it! on the last page
// earns a star. Words he tapped (or held) for help are remembered for Grown-ups → Reading
// and for his word bank, My words. Three reads of a story earn its bookmark.
//
// Scored (a grown-up, behind a dialog): Start when the child begins, tap each word read
// wrong on every page, Finished at the end. The tablet works out words correct per minute
// and keeps it; the child only ever sees stars (no clock and no number per minute on screen).

import { h, clear } from '../dom.js';
import { cleanWord, countsAsWord, followStep, levelPath, passagePages, passageParagraphs, passageTokens, stickersEarned,
  trimWord, wcpmOf, wordCount } from '../logic.js';
import * as store from '../store.js';
import * as speech from '../speech.js';
import * as sfx from '../sfx.js';
import { sayItOut, wordParts } from '../phonics.js';
import { confetti, confirmDialog, go, icon, starCounter, starRow, tap, wake } from '../ui.js';
import { STICKERS } from './stickers.js';

const SAID_MS = 1000;          // how long a tapped word glows
const BUBBLE_MS = 2600;        // how long "Read the whole story first!" stays up
const MAX_SECONDS = 1800;      // the longest read the Pi accepts
const HOLD_MS = 450;           // press and hold this long for the Word Card
const HOLD_SLOP = 12;          // a finger that moves further than this (px) is scrolling, not holding
const SHAKE_MS = 400;          // the wobble of a word tapped too early in 👆 Follow along
const READS_FOR_BOOKMARK = 3;  // reads of one story that earn its bookmark
const DEFAULT_RATE = 0.7;      // the story voice's pace when the setting is missing
const SLOWER_BY = 0.2;         // 🐢 Slower takes this off the pace (never below 0.5)

// The story voice's pace (Grown-ups → Settings → readRate), slower still with 🐢 Slower on.
// Every bit of speech on the Read screen, the Word Card, the quiz's 📖 Story sheet and
// My words goes through this: a first grader needs the reading voice unhurried.
export function readRate(slower = false) {
  const rate = Number(store.prefs().readRate) || DEFAULT_RATE;
  return slower ? Math.max(0.5, rate - SLOWER_BY) : rate;
}

// ---- press and hold ---------------------------------------------------------

// Press and hold an element (a finger kept still for HOLD_MS, a mouse button held down, or a
// right-click) fires onHold(el) and swallows the click that follows the release, so the usual
// tap does not run as well. Attach it BEFORE the element's click handler: the swallow is a
// capturing listener and iPadOS 15 runs same-element listeners in the order they were added.
// A scroll gesture (the finger moving) never fires it; neither does a quick tap.
export function longPress(el, onHold) {
  let timer = null, x = 0, y = 0, held = false;
  const cancel = () => { clearTimeout(timer); timer = null; };
  el.addEventListener('pointerdown', (e) => {
    held = false;                                     // a new press: nothing left to swallow from the last one
    if (e.button > 0) return;                         // a right button: contextmenu below
    x = e.clientX;
    y = e.clientY;
    cancel();
    timer = setTimeout(() => {
      timer = null;
      held = true;
      if (el.isConnected) onHold(el);                 // not when the screen changed under the finger
    }, HOLD_MS);
  });
  el.addEventListener('pointermove', (e) => {
    if (timer && Math.hypot(e.clientX - x, e.clientY - y) > HOLD_SLOP) cancel();
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(type, cancel);
  el.addEventListener('click', (e) => {
    if (!held) return;
    held = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
  el.addEventListener('contextmenu', (e) => {         // a right-click, or Android's own long press
    e.preventDefault();
    if (held) return;                                 // the hold timer got there first
    cancel();
    held = true;
    onHold(el);
  });
}

// ---- the story page (shared with the quiz's 📖 Story peek) -----------------

// The story as a page of tappable words. Every word is a button that does not look like one.
//   onWordTap(el, token)   called with the word's button and the token as written
//   onWordHold(el, token)  press and hold; the Word Card by default, null for nothing
//   page                   which page to show (see passagePages); every page, with breaks, when null
export function storyElement(deck, { onWordTap = null, onWordHold = undefined, page = null } = {}) {
  const pages = passagePages(deck.passage ? deck.passage.text : '');
  const shown = page == null ? pages : [pages[page] || ''];
  const hold = onWordHold === undefined ? (el, token) => openWordCard(token, deck) : onWordHold;
  return h('div', { class: 'story', 'aria-label': deck.title }, shown.map((text, i) => [
    i ? h('div', { class: 'story-break', 'aria-hidden': 'true' }, '✦') : null,
    passageParagraphs(text).map((lines) =>
      h('p', { class: 'story-par' }, lines.map((line) =>
        h('span', { class: 'story-line' }, passageTokens(line).map((token, k) => [
          k ? ' ' : null,
          countsAsWord(token) ? wordButton(token, deck, onWordTap, hold) : h('span', { class: 'w-plain' }, token),
        ]))))),
  ]));
}

const wordInfo = new WeakMap();        // word button -> { token, deck }, for repainting it

function wordButton(token, deck, onWordTap, onWordHold) {
  const el = h('button', { class: 'w', type: 'button', dataset: { word: cleanWord(token) } }, token);
  wordInfo.set(el, { token, deck });
  if (onWordHold) longPress(el, () => { wake(); onWordHold(el, token); });     // before the click handler
  if (onWordTap) el.addEventListener('click', () => { wake(); onWordTap(el, token); });
  return el;
}

function flash(el) {
  el.classList.remove('said');
  void el.offsetWidth;          // restart the glow
  el.classList.add('said');
  setTimeout(() => el.classList.remove('said'), SAID_MS);
}

// The punctuation before and after the word in a token: '"Hi!"' → ['"', '!"'].
function edges(token, text) {
  const lead = token.match(/^[^\p{L}\p{N}'’]*/u)[0];
  return [lead, token.slice(lead.length + text.length)];
}

// A word's letters as sound parts, the flashcards' way: a dot under a single-letter sound, a
// line under a letter team, a silent letter greyed, an apostrophe or hyphen plain.
function partSpans(info) {
  return info.parts.map((p) => h('span', { class: `part ${p.kind}` }, p.text));
}

// How a tapped word is said: whole, or sound by sound while 🔤 Sound it out is on (the story's
// tricky words are always said whole). Returns an onWordTap handler for storyElement; it also
// works on any element whose text is the word (My words uses it on its tiles).
//   soundingOut()  reads the switch
//   rate()         the voice's pace (readRate; the Read screen passes its 🐢 Slower state)
export function wordSpeaker(deck, soundingOut, rate = readRate) {
  const tricky = new Set(((deck && deck.passage && deck.passage.tricky) || []).map(cleanWord));
  return (el, token) => {
    const word = trimWord(token);
    flash(el);
    if (!soundingOut() || tricky.has(cleanWord(token))) speech.speak(word, { rate: rate() });
    else soundItOut(el, token, word, rate());
  };
}

// Sound a word out on its own button: the letters split into sound parts (dots and lines
// like the flashcards), the part being said lit up, then the whole word, then back to how it was.
const sounding = new WeakMap();        // word button -> run number, so an old run cannot undo a newer one
async function soundItOut(el, token, word, rate) {
  const run = (sounding.get(el) || 0) + 1;
  sounding.set(el, run);
  const info = wordParts(token);
  const spoken = [];                   // index in what is said -> index of the part (silent parts are skipped)
  info.parts.forEach((p, i) => { if (p.sound) spoken.push(i); });
  const [lead, tail] = edges(token, info.text);
  const spans = partSpans(info);
  clear(el).append(lead, ...spans, tail);
  el.classList.add('sounding');
  await sayItOut(word, (k) => {
    if (sounding.get(el) !== run) return;
    spans.forEach((span, i) => span.classList.toggle('now', k >= 0 && spoken[k] === i));
    el.classList.toggle('whole', k === spoken.length);
  }, { rate });
  if (sounding.get(el) !== run) return;
  el.classList.remove('sounding', 'whole');
  if (wordInfo.has(el)) paintWord(el, isMarked(el));
  else el.textContent = token;
}

// ---- 🎨 Show sounds ---------------------------------------------------------

const marked = new WeakMap();          // word button -> its nodes with the sounds marked (built once)

// Draw a story word with its sounds marked (on), or as the plain token (off). A tricky word
// is drawn whole with the class `tricky` (pink, no marks).
function paintWord(el, on) {
  const info = wordInfo.get(el);
  if (!info) return;
  if (!on) {
    el.textContent = info.token;
    el.classList.remove('tricky');
    return;
  }
  let nodes = marked.get(el);
  if (!nodes) {
    const parts = wordParts(info.token, info.deck && info.deck.passage ? info.deck.passage.tricky : []);
    const [lead, tail] = edges(info.token, parts.text);
    nodes = { tricky: parts.tricky, list: parts.tricky ? [info.token] : [lead, ...partSpans(parts), tail] };
    marked.set(el, nodes);
  }
  clear(el).append(...nodes.list);
  el.classList.toggle('tricky', nodes.tricky);
}

// Is this word's story showing its sounds right now?
function isMarked(el) {
  const story = el.closest('.story');
  return !!story && story.classList.contains('sounded');
}

// 🎨 Show sounds on (or off) for one story element: the class on the story, every word repainted.
export function markStory(storyEl, on) {
  storyEl.classList.toggle('sounded', on);
  storyEl.querySelectorAll('.w').forEach((el) => paintWord(el, on));
}

// ---- the Word Card (press and hold a word) ---------------------------------

// A big flashcard for one word over the page: the word huge with its sounds marked (a tricky
// word whole, in pink, with "just know it"), 🔊 Say it, 🔤 Sound it out (not for a tricky word)
// and ✅ Got it. Tapping the dim backdrop closes it too; main.js removes it on any route change.
//   opts.rate  the voice's pace (the readRate setting unless the screen passes its own)
export function openWordCard(token, deck = null, { rate = readRate() } = {}) {
  const info = wordParts(token, deck && deck.passage ? deck.passage.tricky : []);
  if (!info.text) return null;
  document.querySelectorAll('.word-card-overlay').forEach((el) => el.remove());
  speech.stop();
  const canSpeak = speech.available() && store.prefs().speech;
  const spans = info.tricky ? [] : partSpans(info);
  const spoken = [];
  info.parts.forEach((p, i) => { if (p.sound) spoken.push(i); });
  const word = h('div', { class: `word-card-word${info.tricky ? ' tricky' : ''}` }, info.tricky ? info.text : spans);
  const close = () => { speech.stop(); overlay.remove(); };
  const big = (emoji, label, fn, cls = '', sound = 'tap') => h('button', { class: `btn big ${cls}`, type: 'button', onclick: tap(fn, sound) },
    h('span', { class: 'btn-emoji' }, emoji), label);
  let run = 0;
  const soundOut = async () => {
    const mine = ++run;
    await sayItOut(info.text, (k) => {
      if (mine !== run) return;
      spans.forEach((span, i) => span.classList.toggle('now', k >= 0 && spoken[k] === i));
      word.classList.toggle('whole', k === spoken.length);
    }, { rate });
  };
  const overlay = h('div', { class: 'overlay word-card-overlay', onclick: (e) => { if (e.target === overlay) close(); } },
    h('div', { class: 'word-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': info.text },
      word,
      info.tricky ? h('p', { class: 'word-card-note' }, 'A tricky word: just know it!') : null,
      h('div', { class: 'word-card-actions' },
        canSpeak ? big('🔊', 'Say it', () => speech.speak(info.text, { rate }), '', null) : null,
        canSpeak && !info.tricky ? big('🔤', 'Sound it out', soundOut, '', null) : null,
        big('✅', 'Got it', close, 'primary'))));
  document.body.append(overlay);
  if (speech.full()) speech.speak(info.text, { rate });    // "read everything" mode: say it on opening too
  return { close, info };
}

// ---- foot switches ----------------------------------------------------------

// A big toggle button that shows its state (.on and aria-pressed).
//   get() reads the setting, set(on) stores it
export function footSwitch(emoji, label, get, set, cls = '') {
  const btn = h('button', { class: `btn big toggle ${cls}`, type: 'button' },
    h('span', { class: 'btn-emoji' }, emoji), label);
  const paint = () => {
    btn.classList.toggle('on', !!get());
    btn.setAttribute('aria-pressed', String(!!get()));
  };
  btn.addEventListener('click', tap(() => { set(!get()); paint(); }, null));
  paint();
  return btn;
}

// The 🔤 Sound it out switch (also used by the quiz's 📖 Story sheet and My words).
export function soundSwitch(get, set) {
  return footSwitch('🔤', 'Sound it out', get, set, 'sound-switch');
}

// ---- the bookmark: three reads of a story ----------------------------------

// Three little books, one filled per read so far, and what it takes: "Read it 3 times to earn
// the bookmark" → "Read 2 of 3" → "🔖 Read 3 times!". `hint` adds the result card's nudge.
export function readDots(count, { hint = false } = {}) {
  const n = Math.max(0, Math.min(READS_FOR_BOOKMARK, Number(count) || 0));
  const earned = n >= READS_FOR_BOOKMARK;
  let text = earned ? `🔖 Read ${READS_FOR_BOOKMARK} times!`
    : n ? `Read ${n} of ${READS_FOR_BOOKMARK}` : `Read it ${READS_FOR_BOOKMARK} times to earn the bookmark`;
  if (hint && n && !earned) text += ' — read it again tomorrow!';
  return h('div', { class: `read-dots${earned ? ' earned' : ''}` },
    h('span', { class: 'read-dots-row', 'aria-hidden': 'true' },
      Array.from({ length: READS_FOR_BOOKMARK }, (_, i) => h('span', { class: `read-dot${i < n ? ' on' : ''}` }, '📖'))),
    h('span', { class: 'read-dots-text' }, text));
}

// A missed word on the result card: tap to hear it, press and hold for its Word Card.
//   rate()  the voice's pace
function wordChip(word, deck, rate) {
  const el = h('button', { class: 'word-chip', type: 'button' }, word);
  longPress(el, () => { wake(); openWordCard(word, deck, { rate: rate() }); });
  el.addEventListener('click', tap(() => { flash(el); speech.speak(word, { rate: rate() }); }, null));
  return el;
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
  let showSounds = false;                              // 🎨 Show sounds
  let following = false;                               // 👆 Follow along
  let slower = false;                                  // 🐢 Slower: the voice's pace, a step down
  let nextPageBtn = null;                              // the foot's ▶ Next page: pulses once a page is followed to its end
  let done = false;
  let bubbleTimer = null;

  const rate = () => readRate(slower);                 // every bit of speech on this screen uses it
  const sayWord = wordSpeaker(deck, () => soundingOut, rate);
  const onWordTap = (el, token) => {
    if (done) return;
    if (scoring && startedAt != null) {                // scoring: a tap marks (or unmarks) a word read wrong, quietly
      el.classList.toggle('miss');
      return;
    }
    if (following && !scoring) return followTap(el);   // following: a tap is "I read this one", no voice
    sayWord(el, token);
    if (!scoring) {                                    // by himself: a tapped word is one he wanted help with
      helps.add(cleanWord(token));
      el.classList.add('help');
    }
  };
  // Press and hold: the Word Card. By himself, that is a word he wanted help with too.
  const onWordHold = (el, token) => {
    if (done) return;
    openWordCard(token, deck, { rate: rate() });
    if (!scoring) {
      helps.add(cleanWord(token));
      el.classList.add('help');
    }
  };
  // Every page is built once, so marks and glows survive turning back and forth.
  const pageEls = pages.map((_, i) => storyElement(deck, { onWordTap, onWordHold, page: i }));
  const lineTexts = pages.map((p) => passageParagraphs(p).flat());
  const lineWords = pageEls.map((el) => Array.from(el.querySelectorAll('.story-line')).map((line) => Array.from(line.querySelectorAll('.w'))));
  const pageWords = pageEls.map((el) => Array.from(el.querySelectorAll('.w')));
  const pointers = pages.map(() => 0);                 // 👆 Follow along: the next word to read, per page
  const allWords = pageWords.flat();

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
    nextPageBtn = null;
    const row = h('div', { class: 'read-foot-row' });
    const big = (cls, icon_, label, fn) => h('button', { class: `btn big ${cls}`, type: 'button', onclick: tap(fn) },
      h('span', { class: 'btn-emoji' }, icon_), label);
    if (!scoring) {
      if (canSpeak) {
        row.append(h('button', { class: `btn big${speaking ? ' on' : ''}`, type: 'button', onclick: tap(readToMe, null) },
          h('span', { class: 'btn-emoji' }, speaking ? '⏹️' : '🔊'), speaking ? 'Stop' : 'Read to me'));
      }
      if (isLast()) row.append(big('primary', '👍', 'I read it!', iReadIt));
      else row.append((nextPageBtn = big('primary', '▶️', 'Next page', () => turn(1))));
      // The switches, above the main row: how a tapped word is said, the sound marks, reading
      // along, and the voice's pace.
      foot.append(h('div', { class: 'read-foot-row read-switches' },
        canSpeak ? soundSwitch(() => soundingOut, (on) => { soundingOut = on; }) : null,
        footSwitch('🎨', 'Show sounds', () => showSounds, setShowSounds, 'show-sounds'),
        footSwitch('👆', 'Follow along', () => following, setFollowing, 'follow-along'),
        canSpeak ? footSwitch('🐢', 'Slower', () => slower, (on) => { slower = on; }, 'slower') : null));
      if (nextPageBtn && following && pageFollowed(page)) nextPageBtn.classList.add('pulse');
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

  // 🎨 Show sounds: every word on every page drawn in sound parts (or back to plain text).
  function setShowSounds(on) {
    showSounds = on;
    pageEls.forEach((el) => markStory(el, on));
    fitStory();
  }

  // 👆 Follow along: the page dims and one word at a time lights up; he taps each word as he
  // reads it. Where he is on each page is kept, so turning back and forth loses nothing.
  function setFollowing(on) {
    following = on;
    pageEls.forEach((_, i) => paintFollow(i));
    if (nextPageBtn) nextPageBtn.classList.toggle('pulse', following && pageFollowed(page));
  }

  const pageFollowed = (i) => pageWords[i].length > 0 && pointers[i] >= pageWords[i].length;

  function paintFollow(i) {
    const p = pointers[i];
    pageEls[i].classList.toggle('following', following);
    pageWords[i].forEach((w, k) => {
      w.classList.toggle('read', following && k < p);
      w.classList.toggle('next', following && k === p);
      w.classList.toggle('dim', following && k > p);
    });
  }

  function followTap(el) {
    const list = pageWords[page];
    const idx = list.indexOf(el);
    if (idx < 0) return;
    const p = pointers[page];
    if (idx > p) return wobble(el);                    // not that one yet
    pointers[page] = followStep(p, idx);
    paintFollow(page);
    if (idx !== p) return;                             // went back to an earlier word
    sfx.play('tap');
    if (pageFollowed(page)) {                          // the page's last word: a sparkle, then on to the next page
      sfx.play('star');
      confetti(['⭐', '✨'], 10);
      if (nextPageBtn) nextPageBtn.classList.add('pulse');
    }
  }

  function wobble(el) {
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
    setTimeout(() => el.classList.remove('shake'), SHAKE_MS);
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
    }, { rate: rate() });
    if (!scope.alive || run !== readRun) return;
    speaking = false;
    if (!done && page === mine) drawFoot();
  }

  // 👍 I read it!: only after enough time to have read the whole story, so a quick tap earns nothing.
  function iReadIt() {
    if (performance.now() - openedAt < Math.max(8, words * 0.25) * 1000) {
      speech.speak('Read the whole story first!', { rate: rate() });
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
    const marked_ = allWords.filter((el) => el.classList.contains('miss'));
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
    const missed = Array.from(new Set(marked_.map((el) => el.dataset.word).filter(Boolean)));
    finish({ mode: 'scored', words, errors: Math.min(words, marked_.length), seconds, missed });
  }

  function setScoring(on) {
    scoring = on;
    startedAt = null;
    if (on) setFollowing(false);                       // scoring taps mark misses, not the words read
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

  // The result card: one star, a cheer, the bookmark row, and the numbers in small print for
  // the grown-up only. The missed words are chips: tap to hear one, hold for its Word Card.
  function showResult(read, summary) {
    clear(root);
    const scored = read.mode === 'scored';
    const title = scored ? 'Great reading!' : 'Nice reading!';
    const stickerBefore = stickersEarned(starsBefore, STICKERS.length);
    const stickerAfter = stickersEarned(store.state.stars, STICKERS.length);
    const chips = read.missed.map((w) => wordChip(w, deck, rate));
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
        readDots(summary && summary.count, { hint: true }),
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
