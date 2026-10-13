// The games hub, and the launcher that runs one game.
//
//   #/games                 pick a game (questions come from every level reached)
//   #/games/<id>            play that game
//   #/games/<id>/<deckId>   play it with one level's cards (from a level page)
//   #/games/random[/<deckId>]  surprise me

import { h } from '../dom.js';
import * as store from '../store.js';
import * as speech from '../speech.js';
import { go, tap, topBar } from '../ui.js';
import { createGame, gamePool } from '../games/engine.js';

// Each game lives in ../games/<id>.js. Loaded only when played.
export const GAMES = [
  { id: 'slingshot', title: 'Slingshot', emoji: '🎯', blurb: 'Fling a bird at the tower with the right answer.', load: () => import('../games/slingshot.js') },
  { id: 'monster', title: 'Feed the Monster', emoji: '👾', blurb: 'The monster is hungry for one answer. Feed it!', load: () => import('../games/monster.js') },
  { id: 'bubbles', title: 'Bubble Pop', emoji: '🔵', blurb: 'Pop the bubble with the right answer.', load: () => import('../games/bubbles.js') },
  { id: 'frog', title: 'Frog Hop', emoji: '🐸', blurb: 'Hop along the number line to the answer.', kinds: ['qa'], subjects: ['math'], load: () => import('../games/frog.js') },
  { id: 'builder', title: 'Word Builder', emoji: '🧱', blurb: 'Hear a word, then build it from letter tiles.', kinds: ['read'],
    filter: (e) => !/\s/.test(String(e.card.text || '').trim()),       // single words: a sentence is far too many tiles
    load: () => import('../games/builder.js') },
  { id: 'memory', title: 'Memory Match', emoji: '🃏', blurb: 'Find the matching pairs.', load: () => import('../games/memory.js') },
  { id: 'mystery', title: 'Mystery Picture', emoji: '🖼️', blurb: 'Every right answer uncovers more of a hidden picture.', load: () => import('../games/mystery.js') },
  { id: 'rocket', title: 'Rocket Launch', emoji: '🚀', blurb: 'Fuel the rocket with right answers and blast off!', load: () => import('../games/rocket.js') },
];

function poolFor(game, deckId) {
  let pool = gamePool({ deckId, kinds: game.kinds || null });
  if (game.filter) pool = pool.filter(game.filter);
  if (!game.subjects || deckId) return pool;
  return pool.filter((e) => game.subjects.includes(e.deck.subject));
}

export function mount(root, scope, gameId, deckId) {
  if (!gameId) return hub(root, scope, null);
  if (gameId === 'play') return hub(root, scope, deckId);        // #/games/play/<deckId>: the hub for one level
  let game = GAMES.find((g) => g.id === gameId);
  if (gameId === 'random') {
    const options = GAMES.filter((g) => poolFor(g, deckId).length >= 3);
    game = options[Math.floor(Math.random() * options.length)];
  }
  if (!game) return go('/games');
  const pool = poolFor(game, deckId);
  if (pool.length < 3) {
    root.append(h('section', { class: 'screen' }, topBar(scope, { back: '/games', title: game.title, emoji: game.emoji }),
      h('div', { class: 'empty' }, h('div', { class: 'empty-emoji' }, '🔒'),
        h('p', null, 'Play a few levels first, then this game opens up!'))));
    speech.speak('Play a few levels first, then this game opens up!');      // the screen is a dead end: say why
    return;
  }
  root.append(h('div', { class: 'splash' }, h('span', { class: 'splash-star' }, game.emoji)));
  game.load().then((mod) => {
    if (!scope.alive) return;
    while (root.firstChild) root.removeChild(root.firstChild);
    const exit = deckId ? `/games/play/${deckId}` : '/games';
    const g = createGame(root, scope, { meta: mod.meta, pool, exit });
    mod.start(g);
  }).catch((err) => {
    console.warn('Game failed to load', err);
    if (!scope.alive) return;
    while (root.firstChild) root.removeChild(root.firstChild);
    root.append(h('section', { class: 'screen' }, topBar(scope, { back: '/games', title: game.title, emoji: game.emoji }),
      h('div', { class: 'empty' }, h('div', { class: 'empty-emoji' }, '🙈'), h('p', null, 'That game is not working right now.'))));
  });
}

function hub(root, scope, deckId) {
  const deck = deckId ? store.state.deckById.get(deckId) : null;
  const suffix = deck ? `/${deck.id}` : '';
  const tiles = GAMES.map((game) => {
    const open = poolFor(game, deckId).length >= 3;
    return h('button', { class: `tile game-tile${open ? '' : ' locked'}`, type: 'button',
      'aria-label': open ? game.title : `${game.title}, locked`,
      onclick: tap(() => (open ? go(`/games/${game.id}${suffix}`) : speech.speak('Play a few levels first!'))) },
    h('span', { class: 'tile-emoji' }, open ? game.emoji : '🔒'),
    h('span', { class: 'tile-title' }, game.title));
  });
  root.append(h('section', { class: 'screen games-hub' },
    topBar(scope, { back: deck ? `/deck/${deck.id}` : '/', backIcon: deck ? 'back' : 'home', backLabel: deck ? 'Back' : 'Home',
      title: deck ? deck.title : 'Games', emoji: deck ? deck.emoji : '🎮' }),
    h('div', { class: 'scroll' },
      h('button', { class: 'quick-btn surprise', type: 'button', onclick: tap(() => go(`/games/random${suffix}`)) },
        h('span', { class: 'quick-emoji' }, '🎲'), h('span', null, 'Surprise me!')),
      h('div', { class: 'tiles games' }, tiles))));
  speech.speakExtra(deck ? `Pick a game to play with ${deck.title}.` : 'Pick a game!');
}
