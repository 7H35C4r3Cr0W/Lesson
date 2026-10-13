// Talking to the Pi.
//
// Answers are never lost to a flaky Wi-Fi moment: each one goes into a queue in
// the tablet's storage first and is sent from there. The server ignores an
// answer it has already seen (matched by uid), so re-sending is always safe.

const QUEUE_KEY = 'starcards.queue.v1';
const QUEUE_MAX = 3000;
const TIMEOUT_MS = 8000;
// The copy published as a plain static site (see tools/build_static.py) has no server: a stand-in
// in the browser answers every call from local storage instead.
const STATIC = typeof window !== 'undefined' && window.STARCARDS_STATIC === true;
let staticApi = null;

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;       // 0 means "could not reach the Pi"
  }
}

// localStorage can throw (private browsing, storage full); fall back to memory.
const memory = new Map();
export const storage = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? (memory.has(key) ? memory.get(key) : fallback) : JSON.parse(raw);
    } catch {
      return memory.has(key) ? memory.get(key) : fallback;
    }
  },
  set(key, value) {
    memory.set(key, value);
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* kept in memory only */
    }
  },
};

let parentToken = null;
try {
  parentToken = sessionStorage.getItem('starcards.parent') || null;
} catch {
  /* no session storage */
}

export function setParentToken(token) {
  parentToken = token || null;
  try {
    if (parentToken) sessionStorage.setItem('starcards.parent', parentToken);
    else sessionStorage.removeItem('starcards.parent');
  } catch {
    /* ignore */
  }
}

export function hasParentToken() {
  return !!parentToken;
}

export async function request(method, path, body, opts = {}) {
  if (STATIC) {
    if (!staticApi) staticApi = import('./static-api.js');
    try {
      return await (await staticApi).handle(method, path, body);
    } catch (err) {
      throw new ApiError(err.status === undefined ? 500 : err.status, err.message || 'Something went wrong');
    }
  }
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (parentToken) headers['X-Parent-Token'] = parentToken;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || TIMEOUT_MS);
  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the Pi');
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* not JSON */
  }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status})`);
  return data;
}

export const get = (path, opts) => request('GET', path, undefined, opts);
export const post = (path, body = {}, opts) => request('POST', path, body, opts);
export const put = (path, body = {}, opts) => request('PUT', path, body, opts);
export const del = (path, opts) => request('DELETE', path, undefined, opts);

// crypto.randomUUID needs https, which a home Pi does not have; getRandomValues works everywhere.
export function newUid() {
  const bytes = new Uint8Array(12);
  if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- the answer queue ------------------------------------------------------

let queue = storage.get(QUEUE_KEY, []);
if (!Array.isArray(queue)) queue = [];
let sending = false;
let retryTimer = null;
let onSynced = () => {};
let onStatus = () => {};

export function onQueueSynced(fn) {
  onSynced = fn;
}

export function onConnection(fn) {
  onStatus = fn;
}

export function queuedCards() {
  return new Set(queue.map((item) => item.attempt.card));
}

export function queueLength() {
  return queue.length;
}

export function enqueue(profile, attempt) {
  queue.push({ profile, attempt });
  if (queue.length > QUEUE_MAX) queue = queue.slice(-QUEUE_MAX);
  storage.set(QUEUE_KEY, queue);
  flush();
}

export async function flush() {
  if (sending || !queue.length) return;
  sending = true;
  clearTimeout(retryTimer);
  try {
    while (queue.length) {
      const profile = queue[0].profile;
      const batch = queue.filter((item) => item.profile === profile).slice(0, 200);
      const sent = new Set(batch.map((item) => item.attempt.uid));
      let reply = null;
      try {
        reply = await post('/api/attempts', { profile, attempts: batch.map((item) => item.attempt) });
      } catch (err) {
        if (err.status === 0 || err.status >= 500) {
          onStatus(false);
          retryTimer = setTimeout(flush, 15000);
          return;
        }
        // The server understood and refused (bad data, or the profile is gone). Retrying
        // forever would block every later answer, so let this batch go.
        console.warn('Dropping answers the server refused:', err.message);
      }
      queue = queue.filter((item) => !sent.has(item.attempt.uid));
      storage.set(QUEUE_KEY, queue);
      onStatus(true);
      if (reply) onSynced(profile, reply);
    }
  } finally {
    sending = false;
  }
}

window.addEventListener('online', flush);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) flush();
});
