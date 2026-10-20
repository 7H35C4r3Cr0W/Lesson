// Settings: the voice and sound, the child, the practice round, the PIN, and data.

import { h } from '../../dom.js';
import * as store from '../../store.js';
import * as speech from '../../speech.js';
import * as help from '../../help.js';
import { confirmDialog, dialog, go, toast } from '../../ui.js';

const STATIC = window.STARCARDS_STATIC === true;
// What "Try it" says: the voice itself, a story line at the story speed, a question at the quiz speed.
const SAMPLE_VOICE = 'Hi! The cat sat on the mat. Three plus four is seven.';
const SAMPLE_STORY = 'Sam has a big black cat. The cat is Max. Max naps on the mat.';
const SAMPLE_QUIZ = 'Which word rhymes with cat? Hat, dog, or sun?';
const READ_PRESETS = [['🐢 Slow', 0.6], ['Normal', 0.75], ['Quick', 0.9]];
const QUIZ_PRESETS = [['Slow', 0.7], ['Normal', 0.85], ['Quick', 1.0]];

function fail(err) {
  toast(err.status === 401 ? 'Your PIN timed out. Tap Done and come back in.' : err.message);
}

function row(label, control, help) {
  return h('div', { class: 'setting' },
    h('div', { class: 'setting-text' }, h('strong', null, label), help ? h('div', { class: 'muted small' }, help) : null),
    h('div', { class: 'setting-control' }, control));
}

function toggle(key, prefs) {
  return h('input', { type: 'checkbox', class: 'switch', checked: !!prefs[key], 'aria-label': key,
    onchange: (e) => store.savePrefs({ [key]: e.target.checked }).catch(fail) });
}

function numberPick(key, prefs, options) {
  return h('select', { class: 'input', onchange: (e) => store.savePrefs({ [key]: Number(e.target.value) }).catch(fail) },
    options.map((n) => h('option', { value: String(n), selected: prefs[key] === n }, String(n))));
}

function download(name, text) {
  const link = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 5000);
}

function pinDialog(redraw) {
  const first = h('input', { class: 'input', type: 'password', inputMode: 'numeric', maxLength: 8, autocomplete: 'off',
    placeholder: '4 to 8 digits' });
  const second = h('input', { class: 'input', type: 'password', inputMode: 'numeric', maxLength: 8, autocomplete: 'off',
    placeholder: 'Same PIN again' });
  const note = h('p', { class: 'bad' });
  dialog({
    title: store.state.pinSet ? 'Change the PIN' : 'Set a PIN',
    body: h('div', { class: 'form' },
      h('p', { class: 'muted' }, 'Forgot it later? On the Pi run:  python3 server.py --reset-pin'),
      h('label', { class: 'field' }, h('span', null, 'New PIN'), first),
      h('label', { class: 'field' }, h('span', null, 'Again'), second), note),
    actions: [{ label: 'Cancel' }, { label: 'Save PIN', kind: 'primary', run: () => {
      if (!/^\d{4,8}$/.test(first.value)) {
        note.textContent = 'Use 4 to 8 digits.';
        return false;
      }
      if (first.value !== second.value) {
        note.textContent = 'The two do not match.';
        return false;
      }
      store.setPin(first.value).then(() => { toast('PIN saved.'); redraw(); }).catch(fail);
      return true;
    } }],
  });
}

const speedText = (v) => `${Number(v).toFixed(2)}×`;

// Preset buttons and a slider for one of the two speeds. Saves prefs[key], lights the preset
// that matches, and says the sample at the new speed (passed along, so it is right even before
// the save lands). The Try it button goes into tryButtons so the voice-off state can grey it.
function speedPicker(key, value, [min, max], presets, sample, label, tryButtons) {
  const slider = h('input', { type: 'range', min: String(min), max: String(max), step: '0.05', value: String(value), 'aria-label': label });
  const readout = h('span', { class: 'voice-speed-value' }, speedText(value));
  const buttons = presets.map(([text, rate]) => h('button', { class: 'btn small', type: 'button', 'aria-pressed': 'false',
    onclick: () => pick(rate) }, text));
  const show = (v) => {
    readout.textContent = speedText(v);
    buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(Math.abs(presets[i][1] - v) < 0.001)));
  };
  const save = (v) => store.savePrefs({ [key]: v }).then(() => speech.speak(sample, { rate: v })).catch(fail);
  const pick = (v) => {
    slider.value = String(v);
    show(v);
    save(v);
  };
  slider.addEventListener('input', () => show(Number(slider.value)));
  slider.addEventListener('change', () => save(Number(slider.value)));
  show(value);
  const tryIt = h('button', { class: 'btn small', type: 'button', onclick: () => speech.speak(sample, { rate: Number(slider.value) }) }, 'Try it');
  tryButtons.push(tryIt);
  return h('div', null,
    h('div', { class: 'voice-presets' }, buttons),
    h('div', { class: 'voice-speed' }, slider, readout, tryIt));
}

export function draw(body, scope, arg, redraw) {
  const { state } = store;
  const prefs = store.prefs();
  const profile = state.profile;
  const voiceOn = prefs.speech !== false && prefs.voiceMode !== 'off';
  const tryButtons = [];

  const name = h('input', { class: 'input', type: 'text', maxLength: 24, value: profile.name, placeholder: 'First name',
    onchange: (e) => store.saveProfile({ name: e.target.value.trim() }).then(() => toast('Saved.')).catch(fail) });

  // ---- the Voice panel -------------------------------------------------------

  const pickBox = h('div', { class: 'voice-pick' });
  const noticeBox = h('div');
  const tryVoice = h('button', { class: 'btn small', type: 'button', onclick: () => speech.speak(SAMPLE_VOICE) }, 'Try it');
  tryButtons.push(tryVoice);

  // The chosen voice is the basic one: how to get a natural one. With Pi voices on offer, that is
  // a tap away; otherwise the iPad download steps, plus the Pi option when there is a Pi.
  const fillNotice = () => {
    noticeBox.textContent = '';
    if (speech.voiceQuality() !== 'basic') return;
    if (!STATIC && speech.listVoices().some((v) => v.server)) {
      noticeBox.append(h('p', { class: 'notice' }, h('strong', null, 'Tip: '), 'pick a natural voice from the Pi above.'));
      return;
    }
    noticeBox.append(h('p', { class: 'notice' }, h('strong', null, 'This tablet is using its basic voice, which sounds robotic. '),
      'For a natural one, on the iPad open Settings › Accessibility › Spoken Content › Voices › English, download ',
      h('strong', null, 'Ava (Premium)'), ' or ', h('strong', null, 'Samantha (Enhanced)'),
      ' (about 150 MB, Wi-Fi), then come back here: the app picks the best downloaded voice by itself, or choose it above.',
      STATIC ? null : ' Or install the natural voice on the Pi: see README › Natural voice from the Pi.'));
  };

  // The voice list, grouped: the Pi's natural voices (when it has any), then this tablet's.
  let listedPi = '';
  const fillVoices = () => {
    const voices = speech.listVoices();
    listedPi = voices.filter((v) => v.server).map((v) => v.id).join('|');
    const now = speech.currentVoice();
    const group = (label, list, text) => (list.length
      ? h('optgroup', { label }, list.map((v) => h('option', { value: v.id, selected: v.id === now }, text(v)))) : null);
    pickBox.textContent = '';
    if (!voices.length) {
      pickBox.append(h('span', { class: 'muted' }, speech.available() ? 'No English voices found on this device' : 'This browser cannot speak'));
      return;
    }
    pickBox.append(h('select', { class: 'input', 'aria-label': 'Which voice', onchange: (e) => {
      speech.setVoice(e.target.value);
      speech.speak('This is how I sound. The cat sat on the mat.');
      fillNotice();
    } },
    group('Natural voices from the Pi', voices.filter((v) => v.server), (v) => v.name),
    group('Voices on this tablet', voices.filter((v) => !v.server), (v) => `${v.name} (${v.lang}, ${v.quality})`)),
    tryVoice);
  };
  fillVoices();
  fillNotice();
  // Ask the Pi again for its voices (it was asked at start-up, but Piper may have been installed
  // since) and list them when the answer lands.
  speech.loadServerVoices({ refresh: true }).then((piVoices) => {
    if (!scope.alive || !pickBox.isConnected || piVoices.map((v) => v.id).join('|') === listedPi) return;
    fillVoices();
    fillNotice();
  });

  const offNote = h('p', { class: 'notice', hidden: voiceOn }, h('strong', null, 'The voice is off. '),
    'Turn it on under Sound › When the voice speaks to hear the samples; the choices here are saved either way.');
  const setVoiceOn = (on) => {
    offNote.hidden = on;
    tryButtons.forEach((b) => { b.disabled = !on; });
  };

  const voicePanel = h('div', { class: 'panel' }, h('h2', null, 'Voice'),
    offNote,
    row('Which voice', pickBox,
      STATIC ? 'Saved in this browser only. A voice marked Enhanced or Premium is a natural one; the plain ones are the robotic built-ins.'
        : 'Saved on this tablet only. The Pi makes its natural voices itself once Piper is installed on it (README › Natural voice from the Pi). On the tablet, a voice marked Enhanced or Premium is natural; the plain ones are the robotic built-ins.'),
    row('Story reading speed', speedPicker('readRate', Number(prefs.readRate) || 0.7, [0.5, 1.1], READ_PRESETS, SAMPLE_STORY, 'Story reading speed', tryButtons),
      'Used by Read to me, tapping a word, sounding out, the Word Card and My words. Slow is right for a first grader; move it up as reading gets smoother. The 🐢 Slower button on a story slows it a bit more for the moment.'),
    row('Speed everywhere else', speedPicker('speechRate', Number(prefs.speechRate) || 0.85, [0.6, 1.2], QUIZ_PRESETS, SAMPLE_QUIZ, 'Voice speed', tryButtons),
      'Questions, answers and the games. Slower is clearer for new readers.'),
    noticeBox);
  setVoiceOn(voiceOn);

  // ---- the rest ---------------------------------------------------------------

  const children = state.profiles.map((p) => h('div', { class: 'child-row' },
    h('span', null, `${p.avatar} ${p.name || `Child ${p.id}`}`),
    p.id === profile.id ? h('span', { class: 'pill' }, 'using now')
      : h('button', { class: 'btn small', type: 'button', onclick: () => store.loadProfile(p.id).then(redraw).catch(fail) }, 'Switch to'),
    state.profiles.length > 1 ? h('button', { class: 'btn small', type: 'button', onclick: () =>
      confirmDialog(`Remove ${p.name || 'this child'}?`, 'All of their progress, tests and flags are deleted. This cannot be undone.',
        'Remove', () => { store.removeProfile(p.id).then(redraw).catch(fail); }, true) }, 'Remove') : null));

  const addChild = () => {
    const input = h('input', { class: 'input wide', type: 'text', maxLength: 24, placeholder: 'First name' });
    dialog({ title: 'Add a child', body: input, actions: [{ label: 'Cancel' }, { label: 'Add', kind: 'primary', run: () => {
      store.addProfile(input.value.trim(), '🐼').then(redraw).catch(fail);
    } }] });
  };

  body.append(
    h('div', { class: 'page-head' }, h('h1', null, 'Settings')),

    voicePanel,

    h('div', { class: 'panel' }, h('h2', null, 'Sound'),
      row('When the voice speaks',
        h('select', { class: 'input', onchange: (e) => {
          const mode = e.target.value;
          store.savePrefs({ voiceMode: mode, speech: mode !== 'off' }).then(() => setVoiceOn(mode !== 'off')).catch(fail);
        } },
        h('option', { value: 'help', selected: prefs.voiceMode === 'help' }, 'Only when needed'),
        h('option', { value: 'full', selected: prefs.voiceMode === 'full' }, 'Read everything'),
        h('option', { value: 'off', selected: prefs.voiceMode === 'off' }, 'Never')),
        '"Only when needed" = the word in a listen-and-find question, a replay after a miss, the answer after two misses, and the 🔊 and 🙋 buttons. "Read everything" also reads titles, questions and answer choices (useful before your child can read the questions alone).'),
      row('Read the answer choices aloud', toggle('readChoices', prefs),
        'Only in "Read everything": reads the choices for science, social studies and other question decks. Reading decks never read their choices.'),
      row('Sound effects', toggle('sound', prefs))),

    h('div', { class: 'panel' }, h('h2', null, 'Child'),
      row('Name', name, 'Shown on the home screen: “Hi, Sam!”'),
      row('Children', h('div', null, children,
        h('button', { class: 'btn small', type: 'button', onclick: addChild }, 'Add a child')),
      'Each child has their own progress. The tablet remembers who used it last.')),

    h('div', { class: 'panel' }, h('h2', null, 'Look'),
      row('Colours', h('select', { class: 'input', onchange: (e) => store.savePrefs({ theme: e.target.value }).catch(fail) },
        h('option', { value: 'night', selected: prefs.theme !== 'day' }, 'Night: calm dark blue'),
        h('option', { value: 'day', selected: prefs.theme === 'day' }, 'Day: soft cream')),
      'Cards and words always stay dark-on-light for reading.')),

    h('div', { class: 'panel' }, h('h2', null, 'Levels'),
      row('Allow testing out', toggle('testOut', prefs),
        'On: tapping a locked level offers one round drawn from every level up to it; 85% opens them all at once, and the Levels page marks them “tested out”. Off: levels open one at a time only.'),
      row('Open every level', toggle('freeRoam', prefs),
        'Off: a level opens when the one before it is passed: three stars, which is a Play round at 85% or better (9 of 10), like a video game. On: any level can be played, handy to jump to what the class is doing; passing still needs 85%. Hiding decks on the Cards page also skips them on the path.')),

    h('div', { class: 'panel' }, h('h2', null, 'Practice rounds'),
      row('Questions in a round', numberPick('sessionSize', prefs, [5, 6, 8, 10, 12, 15, 20]),
        'Short rounds work best at this age. 8 to 10 takes about three minutes.'),
      row('New cards in a round', numberPick('newPerSession', prefs, [1, 2, 3, 4, 5, 6, 8, 10]),
        'The rest of the round is cards already seen, so most answers feel like wins.')),

    h('div', { class: 'panel' }, h('h2', null, 'Help button (local AI helper)'),
      row('Show the 🙋 button', toggle('helper', prefs),
        help.available()
          ? 'The Pi is connected to your local model. Tapping 🙋 on a card sends that card to it and speaks back a short hint, never the answer. Nothing leaves your network.'
          : 'Not connected right now. Start the server with --llm-url http://<ollama-host>:11434/v1 (see README) and the button appears automatically.'),
      row('Ask out loud', h('span', { class: 'muted' }, help.canListen() ? 'Available on this tablet' : 'Needs https (see README)'),
        'With https set up on the Pi, the 🙋 button also listens for a question before answering.')),

    h('div', { class: 'panel' }, h('h2', null, 'Grown-up lock'),
      row(state.pinSet ? 'A PIN is set' : 'No PIN yet',
        h('div', { class: 'form-actions' },
          h('button', { class: 'btn small primary', type: 'button', onclick: () => pinDialog(redraw) },
            state.pinSet ? 'Change PIN' : 'Set a PIN'),
          state.pinSet ? h('button', { class: 'btn small', type: 'button', onclick: () =>
            confirmDialog('Remove the PIN?', 'The lock goes back to a times-table question.', 'Remove PIN', () => {
              store.setPin(null).then(redraw).catch(fail);
            }) }, 'Remove PIN') : null),
        state.pinSet ? 'This area asks for the PIN, and the Pi refuses changes without it.'
          : 'Right now the lock is a times-table question. A PIN is stronger, and the Pi then enforces it too.')),

    h('div', { class: 'panel' }, h('h2', null, 'Data'),
      row('Save a copy', h('button', { class: 'btn small', type: 'button', onclick: () =>
        store.exportData().then((data) => download(`star-cards-${new Date().toISOString().slice(0, 10)}.json`,
          JSON.stringify(data, null, 1))).catch(fail) }, 'Download everything'),
      'All progress, answers and tests as one file. The Pi also keeps a daily backup of its database for a week.'),
      row('Start over', h('button', { class: 'btn small danger', type: 'button', onclick: () =>
        confirmDialog('Erase all progress?', `Every answer, star, sticker and test for ${profile.name || 'this child'} is deleted. This cannot be undone.`,
          'Erase everything', () => { store.resetProgress('all').then(() => { toast('Progress erased.'); redraw(); }).catch(fail); }, true) },
      'Erase all progress'), 'Use the Cards page to start just one deck over.')),

    h('div', { class: 'panel' }, h('h2', null, 'About'),
      h('p', { class: 'muted' }, `${state.decks.length} decks · ${state.cardById.size} cards · content version ${state.version}`),
      h('p', { class: 'muted' }, 'Cards follow the North Carolina Standard Course of Study for Grade 1. Decks are plain JSON files in the content/decks folder on the Pi; edit them and reload the page.'),
      h('div', { class: 'form-actions' },
        h('a', { class: 'btn small', href: '/tests/' }, 'Run the built-in self-check'),
        h('button', { class: 'btn small', type: 'button', onclick: () => go('/') }, 'Back to the cards'))));
}
