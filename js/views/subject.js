// One subject as a winding path of levels, like a world map.
//
// Each deck is a level. Levels show the stars of their best round, the level the
// child is on has their buddy standing on it and pulses, and later levels are
// locked until the one before is passed (three stars: a round at 85% or better).
// Groups become signposts along the way.

import { h, s } from '../dom.js';
import { levelPath, needToPass } from '../logic.js';
import * as store from '../store.js';
import * as speech from '../speech.js';
import * as sfx from '../sfx.js';
import { confirmDialog, go, starRow, tap, topBar, wake } from '../ui.js';

const STEP = 164;          // vertical distance between levels (CSS px)
const TOP = 120;           // room above the first level (the buddy and the first signpost sit there)
const BOTTOM = 150;        // room below the last one for the finish flag

// Nodes zig-zag across the width: left, middle-left, right, middle-right ...
const LANES = [0.2, 0.42, 0.8, 0.58];

export function mount(root, scope, subjectId) {
  const sub = store.subjectById(subjectId);
  const decks = sub ? store.decksOf(subjectId) : [];
  if (!sub || !decks.length) return go('/');
  const prefs = store.prefs();
  const levels = levelPath(decks, store.state.stats, store.levelOpts());
  const done = levels.filter((l) => l.passed).length;

  // A locked level can be tested out of: one round drawn from every level up to it.
  function offerTestOut(level, i) {
    let from = levels.findIndex((l) => !l.passed);
    if (from < 0 || from > i) from = i;
    const span = from === i ? `level ${i + 1}` : `levels ${from + 1} to ${i + 1}`;
    const size = prefs.sessionSize;
    speech.speak(`Already know this? Test out of ${span}!`);
    confirmDialog('⚡ Test out?', `Answer ${size} questions from ${span}. Get ${needToPass(size)} right and they all open!`,
      "Let's go!", () => go(`/practice/testout/${level.deck.id}`));
  }
  const groups = sub.groups || [];
  const groupTitle = (id) => (groups.find((g) => g.id === id) || {}).title || '';

  const map = h('div', { class: 'level-map', style: { height: `${TOP + (levels.length - 1) * STEP + BOTTOM}px` } });
  const scroller = h('div', { class: 'scroll map-scroll' }, map);

  root.append(h('section', { class: 'screen subject', style: { '--c': sub.color, '--t': sub.tint } },
    topBar(scope, { back: '/', backIcon: 'home', backLabel: 'Home', title: sub.title, emoji: sub.emoji }),
    h('div', { class: 'map-summary' }, h('span', null, `${done} of ${levels.length} levels done`), starRow(Math.min(3, Math.round((done / levels.length) * 3)))),
    scroller));

  // Positions are a fraction of the width, so the path adapts to portrait and landscape.
  const draw = () => {
    const width = map.clientWidth || 700;
    const points = levels.map((level, i) => ({
      x: Math.round(LANES[i % LANES.length] * width),
      y: TOP + i * STEP,
    }));

    // The dotted road behind the nodes.
    let d = '';
    points.forEach((p, i) => {
      if (i === 0) d += `M ${p.x} ${p.y}`;
      else {
        const prev = points[i - 1];
        const midY = (prev.y + p.y) / 2;
        d += ` C ${prev.x} ${midY}, ${p.x} ${midY}, ${p.x} ${p.y}`;
      }
    });
    const last = points[points.length - 1];
    d += ` C ${last.x} ${last.y + 60}, ${width / 2} ${last.y + 60}, ${width / 2} ${last.y + 110}`;
    const road = s('svg', { class: 'map-road', width, height: map.clientHeight, 'aria-hidden': 'true' },
      s('path', { d, fill: 'none', stroke: 'rgba(43,45,66,0.18)', 'stroke-width': 26, 'stroke-linecap': 'round' }),
      s('path', { d, fill: 'none', stroke: '#fff', 'stroke-width': 8, 'stroke-dasharray': '2 22', 'stroke-linecap': 'round' }));

    const nodes = [];
    const signposted = new Set();     // one signpost per group, where it first appears on the path
    levels.forEach((level, i) => {
      const p = points[i];
      const { deck, progress, stars } = level;
      if (!signposted.has(deck.group) && groupTitle(deck.group)) {
        signposted.add(deck.group);
        // Signposts sit on the far side of the road from the node, a little above it.
        nodes.push(h('div', { class: 'signpost', style: { top: `${p.y - 100}px`, left: p.x >= width / 2 ? '14px' : null, right: p.x < width / 2 ? '14px' : null } },
          groupTitle(deck.group)));
      }
      const state = !level.unlocked ? 'locked' : level.passed ? 'done' : stars > 0 || progress.seen > 0 ? 'started' : 'open';
      const label = `Level ${i + 1}, ${deck.title}${!level.unlocked ? ', locked' : level.passed ? ', passed' : stars ? `, ${stars} stars` : ''}`;
      const node = h('button', { class: `level ${state}${level.current ? ' current' : ''}`, type: 'button', 'aria-label': label,
        style: { left: `${p.x}px`, top: `${p.y}px` } },
      h('span', { class: 'level-num' }, String(i + 1)),
      h('span', { class: 'level-emoji' }, level.unlocked ? (deck.emoji || sub.emoji) : '🔒'),
      level.current ? h('span', { class: 'level-buddy', 'aria-hidden': 'true' }, store.state.profile.avatar) : null);
      node.addEventListener('click', tap(() => {
        if (!level.unlocked) {
          if (prefs.testOut && deck.quiz !== false) return offerTestOut(level, i);
          node.classList.remove('shake');
          void node.offsetWidth;
          node.classList.add('shake');
          sfx.play('oops');
          speech.speak(`Get three stars on level ${i} first!`);
          return;
        }
        go(`/deck/${deck.id}`);
      }, level.unlocked ? 'tap' : null));
      nodes.push(node);
      nodes.push(h('div', { class: 'level-label', style: { left: `${p.x}px`, top: `${p.y + 62}px` } },
        h('span', { class: 'level-title' }, deck.title),
        level.unlocked ? starRow(stars) : null));
    });
    nodes.push(h('div', { class: 'finish-flag', style: { left: `${width / 2}px`, top: `${last.y + 118}px` } },
      done === levels.length ? '🏆' : '🏁'));

    while (map.firstChild) map.removeChild(map.firstChild);
    map.append(road, ...nodes);
  };

  draw();
  // Scroll so the child's level is in view, a little above centre.
  const current = levels.find((l) => l.current);
  if (current) {
    const y = TOP + current.index * STEP;
    requestAnimationFrame(() => {
      scroller.scrollTop = Math.max(0, y - scroller.clientHeight * 0.45);
    });
  }
  const onResize = () => draw();
  window.addEventListener('resize', onResize);
  scope.add(() => window.removeEventListener('resize', onResize));

  wake();
  speech.speakExtra(current ? `${sub.title}. You are on level ${current.index + 1}.` : sub.title);
}
