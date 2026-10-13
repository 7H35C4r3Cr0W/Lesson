// Tiny helpers for building the page without a framework.
//
// Everything is built with createElement and textContent, never innerHTML, so
// card text can never be run as markup. The server's Content-Security-Policy
// also forbids inline styles in markup; setting el.style from script is fine.

const DIRECT = new Set([
  'textContent', 'value', 'checked', 'disabled', 'type', 'id', 'hidden', 'min', 'max', 'step', 'placeholder',
  'title', 'htmlFor', 'selected', 'name', 'autocomplete', 'inputMode', 'maxLength', 'tabIndex', 'href',
]);

function setProps(el, props) {
  for (const [key, val] of Object.entries(props)) {
    if (val == null || val === false) continue;
    if (key === 'class') el.setAttribute('class', val);
    else if (key === 'style') {
      for (const [prop, v] of Object.entries(val)) {
        if (v == null) continue;
        if (prop.startsWith('--')) el.style.setProperty(prop, v);
        else el.style[prop] = v;
      }
    } else if (key === 'dataset') Object.assign(el.dataset, val);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), val);
    else if (DIRECT.has(key)) el[key] = val;
    else el.setAttribute(key, val === true ? '' : val);
  }
}

function append(el, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

// h('button', { class: 'big', onclick: go }, 'Play')
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) setProps(el, props);
  append(el, children);
  return el;
}

// Same, for SVG elements.
export function s(tag, props, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  if (props) setProps(el, props);
  append(el, children);
  return el;
}

// Like el.append(...children) but skips null/false/undefined instead of printing "null".
export function appendAll(el, ...children) {
  append(el, children);
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

// A click handler that ignores the second tap of an excited double-tap.
export function once(fn, quietMs = 450) {
  let last = 0;
  return (event) => {
    const now = performance.now();
    if (now - last < quietMs) return;
    last = now;
    fn(event);
  };
}

export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function reducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
