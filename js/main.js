// Start-up and the router. Screens live in ./views; each exports
// mount(root, scope, ...params). scope.add(fn) registers clean-up for when the
// screen is replaced, and scope.alive turns false at that moment so anything
// still waiting on a timer or the network can tell it is no longer on screen.

import { h, clear } from './dom.js';
import * as store from './store.js';
import * as speech from './speech.js';
import * as sfx from './sfx.js';
import * as help from './help.js';
import { wake } from './ui.js';
import * as home from './views/home.js';
import * as subject from './views/subject.js';
import * as deck from './views/deck.js';
import * as cards from './views/cards.js';
import * as practice from './views/practice.js';
import * as test from './views/test.js';
import * as stickers from './views/stickers.js';
import * as games from './views/games.js';
import * as grownups from './views/grownups/index.js';
import * as lessons from './views/lessons.js';

const ROUTES = [
  [/^\/$/, home],
  [/^\/subject\/([\w-]+)$/, subject],
  [/^\/deck\/([\w.-]+)$/, deck],
  [/^\/cards\/([\w.-]+)$/, cards],
  [/^\/practice\/(today|again)$/, practice],
  [/^\/practice\/(deck)\/([\w.-]+)$/, practice],
  [/^\/test\/(\d+)$/, test],
  [/^\/stickers$/, stickers],
  [/^\/games(?:\/([\w-]+))?(?:\/([\w.-]+))?$/, games],
  [/^\/lessons(?:\/([\w-]+))?$/, lessons],
  [/^\/grownups(?:\/([\w-]+))?(?:\/([\w.-]+))?$/, grownups],
];

const root = document.getElementById('app');
let scope = null;

function applyPrefs() {
  const prefs = store.prefs();
  speech.configure({ enabled: prefs.speech && prefs.voiceMode !== 'off', rate: prefs.speechRate, mode: prefs.voiceMode });
  sfx.configure({ on: prefs.sound });
  document.body.dataset.theme = prefs.theme === 'day' ? 'day' : 'night';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = prefs.theme === 'day' ? '#f1e9db' : '#1b2340';
}

function render() {
  if (!store.state.ready) return;
  const path = (location.hash.replace(/^#/, '') || '/').split('?')[0];
  if (scope) {
    scope.alive = false;
    for (const fn of scope.cleanups.splice(0)) {
      try {
        fn();
      } catch (err) {
        console.warn(err);
      }
    }
  }
  speech.stop();
  document.querySelectorAll('.overlay').forEach((el) => el.remove());
  clear(root);
  scope = { alive: true, cleanups: [], add(fn) { this.cleanups.push(fn); } };
  if (!path.startsWith('/grownups')) grownups.lock();
  document.body.classList.toggle('grownup-mode', path.startsWith('/grownups') || path.startsWith('/lessons'));
  for (const [pattern, view] of ROUTES) {
    const match = pattern.exec(path);
    if (match) {
      window.scrollTo(0, 0);
      view.mount(root, scope, ...match.slice(1));
      return;
    }
  }
  location.replace('#/');
}

function showStartupProblem(retry) {
  clear(root).append(h('div', { class: 'startup-problem' },
    h('div', { class: 'empty-emoji' }, '🔌'),
    h('h1', null, 'Can’t find the cards'),
    h('p', null, 'Ask a grown-up to check that the little computer (the Pi) is on and on the Wi-Fi.'),
    h('button', { class: 'btn primary big', type: 'button', onclick: retry }, 'Try again')));
}

async function start() {
  try {
    await store.boot();
  } catch (err) {
    console.warn('Start-up failed:', err);
    showStartupProblem(() => {
      clear(root).append(h('div', { class: 'splash' }, h('span', { class: 'splash-star' }, '⭐')));
      start();
    });
    return;
  }
  applyPrefs();
  store.subscribe((what) => {
    if (what === 'profile') applyPrefs();
  });
  help.detect();          // the 🙋 button appears on the next screen if a local model is set up
  render();
  // ?audit in the address turns on the ergonomics checker (see audit.js).
  if (/[?&]audit/.test(location.search)) import('./audit.js').catch((err) => console.warn(err));
}

window.addEventListener('hashchange', render);

// iOS only lets a page make sound after a real touch, so wake audio on the very first one.
document.addEventListener('touchend', wake, { capture: true, passive: true });
document.addEventListener('click', wake, { capture: true });

// Keep the page still: no pinch zoom, no double-tap zoom, no long-press menu on kid screens.
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());
document.addEventListener('contextmenu', (e) => {
  if (!document.body.classList.contains('grownup-mode')) e.preventDefault();
});
// An empty touchstart listener is what makes :active styles work on iOS.
document.addEventListener('touchstart', () => {}, { passive: true });

// A home-screen (standalone) web app never reloads on its own, so when the tablet comes
// back to the app, quietly check whether the Pi was redeployed with new or edited decks
// and reload if so, but never in the middle of a lesson.
document.addEventListener('visibilitychange', async () => {
  if (document.hidden || !store.state.ready) return;
  const path = (location.hash.replace(/^#/, '') || '/').split('?')[0];
  if (path !== '/' && path !== '/stickers') return;      // only reload from a safe, idle screen
  if (await store.checkForUpdate()) location.reload();
});

// A small notice when answers are waiting for the Pi to come back.
const offline = h('div', { class: 'offline-pill', hidden: true }, '☁️ Saving when the Pi is back');
document.body.append(offline);
store.subscribe((what) => {
  if (what === 'online') offline.hidden = store.state.online;
});

start();
