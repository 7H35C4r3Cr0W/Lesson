// Sound effects made on the spot with the Web Audio API, so there are no audio
// files to load. iPad Safari keeps audio suspended until a tap; unlock() is
// called from the first one.

let ctx = null;
let enabled = true;

export function configure({ on }) {
  enabled = on !== false;
}

export function unlock() {
  try {
    if (!ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      ctx = new Ctor();
    }
    if (ctx.state !== 'running') ctx.resume();
  } catch {
    ctx = null;
  }
}

// One short note. freq may be a single pitch or [from, to] for a slide.
function note(freq, start, length, { type = 'sine', gain = 0.16 } = {}) {
  const t0 = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = type;
  if (Array.isArray(freq)) {
    osc.frequency.setValueAtTime(freq[0], t0);
    osc.frequency.exponentialRampToValueAtTime(freq[1], t0 + length);
  } else {
    osc.frequency.setValueAtTime(freq, t0);
  }
  amp.gain.setValueAtTime(0.0001, t0);
  amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.015);
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + length);
  osc.connect(amp);            // not chained: older Safari's connect() returns nothing
  amp.connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + length + 0.03);
}

const SOUNDS = {
  tap: () => note(520, 0, 0.06, { type: 'triangle', gain: 0.08 }),
  flip: () => note([300, 620], 0, 0.12, { type: 'triangle', gain: 0.09 }),
  right: () => {
    note(660, 0, 0.14, { type: 'triangle' });
    note(990, 0.11, 0.24, { type: 'triangle' });
  },
  // Deliberately soft and low: "not yet", never a buzzer.
  oops: () => note([330, 250], 0, 0.22, { type: 'sine', gain: 0.1 }),
  pop: () => note([900, 180], 0, 0.11, { type: 'square', gain: 0.07 }),
  star: () => {
    note(880, 0, 0.1, { type: 'triangle', gain: 0.12 });
    note(1320, 0.08, 0.2, { type: 'triangle', gain: 0.12 });
  },
  win: () => [523, 659, 784, 1047].forEach((f, i) => note(f, i * 0.12, 0.3, { type: 'triangle' })),
  whoosh: () => note([200, 900], 0, 0.25, { type: 'sawtooth', gain: 0.04 }),
  munch: () => {
    note([420, 200], 0, 0.09, { type: 'square', gain: 0.06 });
    note([380, 180], 0.11, 0.09, { type: 'square', gain: 0.06 });
  },
};

export function play(name) {
  if (!enabled || !ctx || !SOUNDS[name]) return;
  try {
    if (ctx.state !== 'running') ctx.resume();
    SOUNDS[name]();
  } catch {
    /* a sound is never worth an error */
  }
}
