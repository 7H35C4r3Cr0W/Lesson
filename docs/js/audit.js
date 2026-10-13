// Ergonomics audit for the kid screens. Loaded only when the page URL has ?audit
// (for example http://starcards.local/?audit#/ ). After every screen change it
// measures each tappable element and lists anything that breaks the rules we
// design to for a six-year-old:
//
//   * touch targets at least 64 x 64 CSS px (100 px for answer choices)
//   * nothing tappable in the bottom 10% of a landscape screen (wrist zone)
//   * no text for the child smaller than 17 px
//   * every icon-only button has an aria-label
//
// Results go to a floating panel and to the console (console.table). Grown-up
// pages are skipped: they are built for adults.

import { h } from './dom.js';

const MIN_TARGET = 64;
const MIN_CHOICE = 100;
const MIN_TEXT = 17;

const panel = h('div', { class: 'audit-panel', role: 'status' });
document.body.append(panel);

function visible(el) {
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
}

export function audit() {
  if (document.body.classList.contains('grownup-mode')) {
    panel.textContent = 'audit: grown-up page, skipped';
    panel.className = 'audit-panel ok';
    return [];
  }
  const problems = [];
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const landscape = vw > vh;
  const tappable = document.querySelectorAll('button, a[href], [role="button"], input, select');
  for (const el of tappable) {
    if (!visible(el) || el.closest('.audit-panel, .overlay, .toast')) continue;
    const r = el.getBoundingClientRect();
    const label = (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30) || el.className;
    // Answer choices get the bigger minimum; a game's secondary tap-row under the play area does not.
    const primary = (el.classList.contains('choice') || el.classList.contains('plate')) && !el.closest('.game-fallback');
    const min = primary ? MIN_CHOICE : MIN_TARGET;
    if (r.width < min || r.height < min) {
      problems.push({ rule: `target ≥ ${min}px`, element: label, value: `${Math.round(r.width)}×${Math.round(r.height)}` });
    }
    // Things inside a scrolling list pass the bottom edge by design; fixed controls must not sit there.
    const scrolls = !!el.closest('.scroll');
    if (landscape && !scrolls && r.bottom > vh * 0.9 && r.top < vh && !el.classList.contains('grownups-link')) {
      problems.push({ rule: 'bottom 10% kept clear', element: label, value: `bottom at ${Math.round((r.bottom / vh) * 100)}%` });
    }
    const hasText = (el.textContent || '').trim().length > 0;
    if (!hasText && !el.getAttribute('aria-label') && !el.getAttribute('title')) {
      problems.push({ rule: 'icon button needs aria-label', element: el.className, value: '' });
    }
  }
  const textNodes = document.createTreeWalker(document.getElementById('app'), NodeFilter.SHOW_TEXT);
  const seen = new Set();
  let node;
  while ((node = textNodes.nextNode())) {
    const el = node.parentElement;
    if (!el || !node.textContent.trim() || seen.has(el) || !visible(el)) continue;
    seen.add(el);
    if (el.closest('.grownup-note, .fine, .audit-panel')) continue;      // small print meant for the parent
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (size < MIN_TEXT) {
      problems.push({ rule: `text ≥ ${MIN_TEXT}px`, element: node.textContent.trim().slice(0, 30), value: `${Math.round(size)}px` });
    }
  }
  const where = location.hash || '#/';
  panel.className = `audit-panel ${problems.length ? 'bad' : 'ok'}`;
  panel.textContent = '';
  panel.append(h('strong', null, `audit ${where}: ${problems.length ? `${problems.length} problem(s)` : 'all good'} (${vw}×${vh})`));
  for (const p of problems.slice(0, 12)) panel.append(h('div', null, `${p.rule}: ${p.element} ${p.value}`));
  if (problems.length) console.table(problems);
  window.__audit = { route: where, problems };
  return problems;
}

let timer = null;
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(audit, 700);
}
window.addEventListener('hashchange', schedule);
window.addEventListener('resize', schedule);
new MutationObserver(schedule).observe(document.getElementById('app'), { childList: true, subtree: true });
schedule();
