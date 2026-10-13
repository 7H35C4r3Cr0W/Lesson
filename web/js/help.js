// The 🙋 Help button: a hint from a local model running somewhere on the home
// network, spoken by the tablet. Only appears when the Pi says a model is set up
// (server.py --llm-url). The reply is a hint about the card, not the answer.
//
// Voice IN (the child asking out loud) needs the microphone, which Safari only
// allows on https. canListen() turns true automatically once the Pi serves
// https; until then the button sends the card itself and speaks the hint.

import * as api from './api.js';
import { h } from './dom.js';
import * as speech from './speech.js';
import * as sfx from './sfx.js';
import { icon, wake } from './ui.js';

let enabled = false;
let busy = false;

export async function detect() {
  try {
    const ping = await api.get('/api/ping');
    enabled = !!ping.help;
  } catch {
    enabled = false;
  }
  return enabled;
}

export function available() {
  return enabled;
}

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;

export function canListen() {
  return !!Recognition && window.isSecureContext === true;
}

// Listen for one short utterance. Resolves to the text, or '' if nothing was heard.
export function listen() {
  return new Promise((resolve) => {
    if (!canListen()) return resolve('');
    const rec = new Recognition();
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    let done = false;
    const finish = (text) => {
      if (done) return;
      done = true;
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
      resolve(text);
    };
    rec.onresult = (e) => finish((e.results[0] && e.results[0][0] && e.results[0][0].transcript) || '');
    rec.onerror = () => finish('');
    rec.onend = () => finish('');
    setTimeout(() => finish(''), 7000);
    try {
      rec.start();
    } catch {
      finish('');
    }
  });
}

// Ask for a hint and speak it. context: { card, choices, chosen, revealed, said }
export async function ask(profileId, context) {
  if (!enabled || busy) return null;
  busy = true;
  try {
    // A cold local model can take a while to answer; wait longer than the default fetch timeout
    // (and longer than the server's own 25 s model timeout) so a first hint is not aborted early.
    const reply = await api.post('/api/help', { profile: profileId, ...context }, { timeoutMs: 30000 });
    return reply.text;
  } catch (err) {
    return err.status === 429 ? null : 'Hmm, my helper is taking a nap. Ask a grown-up!';
  } finally {
    busy = false;
  }
}

// A ready-made button for the quiz and flashcard screens.
//   getContext() -> { card, choices, chosen, revealed }
//   onText(text) -> optional, show the hint on screen for the grown-up
export function helpButton(profileId, getContext, onText) {
  if (!enabled) return null;
  const btn = h('button', { class: 'round help-btn', type: 'button', 'aria-label': 'Help me' }, '🙋');
  btn.addEventListener('click', async () => {
    wake();
    if (busy) return;
    btn.classList.add('speaking');
    sfx.play('tap');
    let said = '';
    if (canListen()) {
      await speech.speak('What do you want to ask?');
      said = await listen();
    } else {
      speech.speak('Let me think.');
    }
    const text = await ask(profileId, { ...getContext(), said });
    btn.classList.remove('speaking');
    // The child may have moved on while the model was thinking; don't speak into a new screen.
    if (!text || !btn.isConnected) return;
    if (onText) onText(text);
    await speech.speak(text, { rate: 0.85 });
  });
  return btn;
}

export { icon };
