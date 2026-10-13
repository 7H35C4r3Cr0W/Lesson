// Pictures for maths cards, drawn as SVG from a small description on the card:
//
//   { "type": "clock", "h": 3, "m": 30 }          analog clock
//   { "type": "digital", "h": 3, "m": 30 }        digital clock
//   { "type": "coins", "coins": ["dime", "penny"], "label": "none" | "name" | "value" }
//   { "type": "blocks", "tens": 3, "ones": 4 }    base-ten rods and cubes
//   { "type": "tenframe", "n": 7 }                one ten-frame (two when n > 10)
//   { "type": "count", "emoji": "🍎", "n": 7 }     things to count, in rows of five
//   { "type": "shape", "shape": "hexagon" }       flat or solid shape
//   { "type": "fraction", "shape": "circle", "parts": 4, "shaded": 1 }
//   { "type": "tally", "n": 7 }
//   { "type": "numberline", "from": 0, "to": 10, "mark": 7 }
//   { "type": "measure", "len": 6, "emoji": "✏️" } an object over a row of unit blocks
//   { "type": "graph", "rows": [{ "label": "🍎", "n": 3 }, { "label": "🍌", "n": 5 }] }
//
// tools/validate_content.py checks every card's visual against the same list.

import { h, s } from './dom.js';

const INK = '#2b2d42';
const BLUE = '#4d8df7';
const GOLD = '#f5b942';
const GREEN = '#3fb27f';
const CORAL = '#f2726b';

function svg(width, height, label, ...children) {
  return s('svg', { viewBox: `0 0 ${width} ${height}`, class: 'visual', role: 'img', 'aria-label': label }, ...children);
}

function text(x, y, value, size, extra = {}) {
  return s('text', { x, y, 'font-size': size, 'text-anchor': 'middle', 'dominant-baseline': 'central', fill: INK,
    'font-weight': 700, ...extra }, value);
}

function clock({ h: hour, m: minute = 0 }) {
  const c = 100;
  const parts = [s('circle', { cx: c, cy: c, r: 94, fill: '#fff', stroke: INK, 'stroke-width': 6 })];
  for (let i = 0; i < 60; i++) {
    const a = (i * 6 * Math.PI) / 180;
    const big = i % 5 === 0;
    const r1 = big ? 80 : 86;
    parts.push(s('line', {
      x1: c + r1 * Math.sin(a), y1: c - r1 * Math.cos(a), x2: c + 90 * Math.sin(a), y2: c - 90 * Math.cos(a),
      stroke: INK, 'stroke-width': big ? 3 : 1,
    }));
  }
  for (let n = 1; n <= 12; n++) {
    const a = (n * 30 * Math.PI) / 180;
    parts.push(text(c + 66 * Math.sin(a), c - 66 * Math.cos(a), n, 20));
  }
  const hourAngle = (((hour % 12) + minute / 60) * 30 * Math.PI) / 180;
  const minAngle = (minute * 6 * Math.PI) / 180;
  parts.push(
    s('line', { x1: c, y1: c, x2: c + 44 * Math.sin(hourAngle), y2: c - 44 * Math.cos(hourAngle), stroke: CORAL,
      'stroke-width': 9, 'stroke-linecap': 'round' }),
    s('line', { x1: c, y1: c, x2: c + 72 * Math.sin(minAngle), y2: c - 72 * Math.cos(minAngle), stroke: BLUE,
      'stroke-width': 6, 'stroke-linecap': 'round' }),
    s('circle', { cx: c, cy: c, r: 7, fill: INK })
  );
  return svg(200, 200, `clock showing ${hour}:${String(minute).padStart(2, '0')}`, ...parts);
}

function digital({ h: hour, m: minute = 0 }) {
  const label = `${hour}:${String(minute).padStart(2, '0')}`;
  return svg(240, 110, `digital clock showing ${label}`,
    s('rect', { x: 4, y: 4, width: 232, height: 102, rx: 18, fill: INK }),
    text(120, 57, label, 64, { fill: '#9af7c0', 'font-family': 'ui-monospace, Menlo, monospace' }));
}

const COINS = {
  penny: { r: 30, fill: '#c9783e', edge: '#8f4f22', value: '1¢', ridged: false },
  nickel: { r: 34, fill: '#c3c7cf', edge: '#8a8f99', value: '5¢', ridged: false },
  dime: { r: 27, fill: '#d3d6dc', edge: '#8a8f99', value: '10¢', ridged: true },
  quarter: { r: 39, fill: '#c9ccd3', edge: '#8a8f99', value: '25¢', ridged: true },
};

function coins({ coins: list, label = 'value' }) {
  const gap = 10;
  const perRow = 5;
  const rows = [];
  for (let i = 0; i < list.length; i += perRow) rows.push(list.slice(i, i + perRow));
  const rowWidth = (row) => row.reduce((w, name) => w + COINS[name].r * 2 + gap, -gap);
  const width = Math.max(...rows.map(rowWidth), 80) + 12;
  const parts = [];
  rows.forEach((row, r) => {
    let x = (width - rowWidth(row)) / 2;
    const cy = 46 + r * 88;
    for (const name of row) {
      const coin = COINS[name];
      const cx = x + coin.r;
      parts.push(s('circle', { cx, cy, r: coin.r, fill: coin.fill, stroke: coin.edge, 'stroke-width': 3,
        'stroke-dasharray': coin.ridged ? '2 2' : null }));
      parts.push(s('circle', { cx, cy, r: coin.r - 6, fill: 'none', stroke: coin.edge, 'stroke-width': 1, opacity: 0.6 }));
      if (label === 'value') parts.push(text(cx, cy, coin.value, coin.r * 0.62));
      else if (label === 'name') parts.push(text(cx, cy, name, coin.r * 0.4));
      x += coin.r * 2 + gap;
    }
  });
  return svg(width, rows.length * 88 + 4, `coins: ${list.join(', ')}`, ...parts);
}

function blocks({ tens = 0, ones = 0 }) {
  const unit = 16;
  const parts = [];
  let x = 6;
  for (let t = 0; t < tens; t++) {
    for (let i = 0; i < 10; i++) {
      parts.push(s('rect', { x, y: 6 + i * unit, width: unit, height: unit, fill: BLUE, stroke: '#fff', 'stroke-width': 1.5 }));
    }
    x += unit + 8;
  }
  x += tens ? 10 : 0;
  for (let i = 0; i < ones; i++) {
    const col = Math.floor(i / 5);
    const row = i % 5;
    parts.push(s('rect', { x: x + col * (unit + 4), y: 6 + (9 - row) * unit - row * 4, width: unit, height: unit,
      fill: GOLD, stroke: '#fff', 'stroke-width': 1.5, rx: 2 }));
  }
  const onesWidth = ones ? Math.ceil(ones / 5) * (unit + 4) : 0;
  return svg(Math.max(x + onesWidth + 6, 60), 6 + 10 * unit + 6, `${tens} tens and ${ones} ones`, ...parts);
}

function tenframe({ n }) {
  const cell = 34;
  const frames = n > 10 ? 2 : 1;
  const parts = [];
  for (let f = 0; f < frames; f++) {
    const ox = 6 + f * (cell * 5 + 22);
    const filled = Math.max(0, Math.min(10, n - f * 10));
    for (let i = 0; i < 10; i++) {
      const x = ox + (i % 5) * cell;
      const y = 6 + Math.floor(i / 5) * cell;
      parts.push(s('rect', { x, y, width: cell, height: cell, fill: '#fff', stroke: INK, 'stroke-width': 2.5 }));
      if (i < filled) parts.push(s('circle', { cx: x + cell / 2, cy: y + cell / 2, r: cell * 0.33, fill: CORAL }));
    }
  }
  return svg(frames * (cell * 5 + 22) - 10, cell * 2 + 12, `ten frame showing ${n}`, ...parts);
}

// Emoji are real text here, so the tablet draws them with its own colour font.
function count({ emoji = '⭐', n }) {
  const rows = [];
  for (let i = 0; i < n; i += 5) rows.push(h('div', { class: 'count-row' }, emoji.repeat(Math.min(5, n - i))));
  return h('div', { class: 'visual count', role: 'img', 'aria-label': `${n} to count` }, rows);
}

function polygon(points, fill) {
  return s('polygon', { points: points.map((p) => p.join(',')).join(' '), fill, stroke: INK, 'stroke-width': 4,
    'stroke-linejoin': 'round' });
}

const SHAPES = {
  circle: (f) => [s('circle', { cx: 100, cy: 80, r: 68, fill: f, stroke: INK, 'stroke-width': 4 })],
  square: (f) => [s('rect', { x: 36, y: 16, width: 128, height: 128, fill: f, stroke: INK, 'stroke-width': 4 })],
  rectangle: (f) => [s('rect', { x: 14, y: 36, width: 172, height: 88, fill: f, stroke: INK, 'stroke-width': 4 })],
  triangle: (f) => [polygon([[100, 14], [178, 146], [22, 146]], f)],
  hexagon: (f) => [polygon([[60, 14], [140, 14], [180, 80], [140, 146], [60, 146], [20, 80]], f)],
  trapezoid: (f) => [polygon([[62, 30], [138, 30], [184, 134], [16, 134]], f)],
  rhombus: (f) => [polygon([[100, 10], [176, 80], [100, 150], [24, 80]], f)],
  'half-circle': (f) => [s('path', { d: 'M 22 118 A 78 78 0 0 1 178 118 Z', fill: f, stroke: INK, 'stroke-width': 4,
    'stroke-linejoin': 'round' })],
  'quarter-circle': (f) => [s('path', { d: 'M 40 140 L 40 20 A 120 120 0 0 1 160 140 Z', fill: f, stroke: INK,
    'stroke-width': 4, 'stroke-linejoin': 'round' })],
  cube: (f) => [
    polygon([[40, 52], [128, 52], [128, 140], [40, 140]], f),
    polygon([[40, 52], [72, 20], [160, 20], [128, 52]], f),
    polygon([[128, 52], [160, 20], [160, 108], [128, 140]], f),
  ],
  'rectangular-prism': (f) => [
    polygon([[16, 64], [144, 64], [144, 136], [16, 136]], f),
    polygon([[16, 64], [48, 32], [176, 32], [144, 64]], f),
    polygon([[144, 64], [176, 32], [176, 104], [144, 136]], f),
  ],
  cone: (f) => [
    s('path', { d: 'M 100 12 L 164 126 A 64 18 0 0 1 36 126 Z', fill: f, stroke: INK, 'stroke-width': 4,
      'stroke-linejoin': 'round' }),
    s('path', { d: 'M 36 126 A 64 18 0 0 1 164 126', fill: 'none', stroke: INK, 'stroke-width': 2,
      'stroke-dasharray': '5 5' }),
  ],
  cylinder: (f) => [
    s('path', { d: 'M 44 36 L 44 124 A 56 18 0 0 0 156 124 L 156 36 Z', fill: f, stroke: INK, 'stroke-width': 4,
      'stroke-linejoin': 'round' }),
    s('ellipse', { cx: 100, cy: 36, rx: 56, ry: 18, fill: f, stroke: INK, 'stroke-width': 4 }),
  ],
  sphere: (f) => [
    s('circle', { cx: 100, cy: 80, r: 68, fill: f, stroke: INK, 'stroke-width': 4 }),
    s('ellipse', { cx: 100, cy: 80, rx: 68, ry: 20, fill: 'none', stroke: INK, 'stroke-width': 2, 'stroke-dasharray': '5 5' }),
    s('ellipse', { cx: 76, cy: 52, rx: 16, ry: 10, fill: '#fff', opacity: 0.55 }),
  ],
};

const FILLS = { blue: '#9cc2ff', gold: '#ffd97a', green: '#9fe0bf', coral: '#ffb1ab', purple: '#c9b6ff' };

function shape({ shape: name, color = 'blue' }) {
  return svg(200, 160, name.replace(/-/g, ' '), ...SHAPES[name](FILLS[color] || FILLS.blue));
}

function fraction({ shape: name = 'circle', parts = 2, shaded = 1 }) {
  const out = [];
  if (name === 'circle') {
    for (let i = 0; i < parts; i++) {
      const a0 = (i / parts) * 2 * Math.PI - Math.PI / 2;
      const a1 = ((i + 1) / parts) * 2 * Math.PI - Math.PI / 2;
      const p = (a) => `${100 + 72 * Math.cos(a)} ${80 + 72 * Math.sin(a)}`;
      out.push(s('path', { d: `M 100 80 L ${p(a0)} A 72 72 0 0 1 ${p(a1)} Z`, fill: i < shaded ? GOLD : '#fff',
        stroke: INK, 'stroke-width': 4, 'stroke-linejoin': 'round' }));
    }
  } else {
    // Halves split left/right; fourths split into a 2 x 2 grid.
    const cols = parts === 4 ? 2 : parts;
    const rows = parts === 4 ? 2 : 1;
    const w = 168 / cols;
    const hgt = 120 / rows;
    for (let i = 0; i < parts; i++) {
      out.push(s('rect', { x: 16 + (i % cols) * w, y: 20 + Math.floor(i / cols) * hgt, width: w, height: hgt,
        fill: i < shaded ? GOLD : '#fff', stroke: INK, 'stroke-width': 4 }));
    }
  }
  return svg(200, 160, `${name} cut into ${parts} equal parts with ${shaded} shaded`, ...out);
}

function tally({ n }) {
  const parts = [];
  let x = 10;
  for (let i = 0; i < n; i++) {
    if (i % 5 === 4) {
      parts.push(s('line', { x1: x - 62, y1: 62, x2: x - 6, y2: 14, stroke: CORAL, 'stroke-width': 5,
        'stroke-linecap': 'round' }));
      x += 16;
    } else {
      parts.push(s('line', { x1: x, y1: 10, x2: x, y2: 66, stroke: INK, 'stroke-width': 5, 'stroke-linecap': 'round' }));
      x += 14;
    }
  }
  return svg(Math.max(x + 4, 40), 76, `${n} tally marks`, ...parts);
}

function numberline({ from = 0, to = 10, mark = null }) {
  const steps = to - from;
  const gap = Math.max(22, Math.min(40, 440 / steps));
  const width = steps * gap + 40;
  const parts = [s('line', { x1: 12, y1: 40, x2: width - 12, y2: 40, stroke: INK, 'stroke-width': 4,
    'stroke-linecap': 'round' })];
  for (let i = 0; i <= steps; i++) {
    const x = 20 + i * gap;
    const value = from + i;
    parts.push(s('line', { x1: x, y1: 30, x2: x, y2: 50, stroke: INK, 'stroke-width': 3 }));
    if (value === mark) parts.push(s('circle', { cx: x, cy: 40, r: 11, fill: CORAL, stroke: INK, 'stroke-width': 3 }));
    else parts.push(text(x, 68, value, steps > 12 ? 13 : 17));
  }
  return svg(width, 84, `number line from ${from} to ${to}`, ...parts);
}

function measure({ len, emoji = '✏️' }) {
  const unit = 34;
  const width = len * unit + 12;
  const units = [];
  for (let i = 0; i < len; i++) {
    units.push(s('rect', { x: 6 + i * unit, y: 52, width: unit, height: unit, fill: i % 2 ? '#9cc2ff' : BLUE,
      stroke: '#fff', 'stroke-width': 2, rx: 5 }));
  }
  return svg(width, 92, `an object ${len} blocks long`,
    s('rect', { x: 6, y: 12, width: len * unit, height: 28, rx: 14, fill: GREEN, stroke: INK, 'stroke-width': 3 }),
    text(6 + (len * unit) / 2, 27, emoji, 20),
    ...units);
}

function graph({ rows }) {
  const cell = 34;
  const most = Math.max(...rows.map((r) => r.n), 1);
  return h('div', { class: 'visual graph', role: 'img', 'aria-label': 'picture graph' },
    rows.map((row) => h('div', { class: 'graph-row' },
      h('span', { class: 'graph-label' }, row.label),
      h('span', { class: 'graph-bar', style: { width: `${cell * most}px` } },
        Array.from({ length: row.n }, () => h('span', { class: 'graph-cell' })))
    )));
}

const RENDERERS = { clock, digital, coins, blocks, tenframe, count, shape, fraction, tally, numberline, measure, graph };

export const SHAPE_NAMES = Object.keys(SHAPES);

// Returns an element for the card's picture, or null if the card has none (or one we do not know).
export function renderVisual(spec) {
  if (!spec || !RENDERERS[spec.type]) return null;
  try {
    return RENDERERS[spec.type](spec);
  } catch (err) {
    console.warn('Could not draw visual', spec, err);
    return null;
  }
}
