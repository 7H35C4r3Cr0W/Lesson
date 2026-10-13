// Lesson plans: a teacher's view of everything in the app, built straight from the decks.
//
//   #/lessons              every subject
//   #/lessons/<subjectId>  one subject
//
// No lock: there is nothing about any child here. Each level becomes a one-card lesson plan:
// what it teaches, the NC standard, how to teach it (the deck's own tip plus the steps the app
// is built around), and a few example cards. Prints cleanly for a binder.

import { h, appendAll } from '../dom.js';
import { PASS_MARK, needToPass } from '../logic.js';
import * as store from '../store.js';
import { go } from '../ui.js';

const PASS_PCT = Math.round(PASS_MARK * 100);

const KIND = {
  read: { label: 'Reading cards', blurb: 'words or sentences the child reads; the quiz says one and the child finds it' },
  qa: { label: 'Question cards', blurb: 'a question with one right answer among three choices' },
};

// The teaching routine the app is built around, in the order a lesson runs.
function steps(deck) {
  const need = needToPass(Math.min(store.prefs().sessionSize, deck.cards.length));
  if (deck.kind === 'read') {
    return [
      'Look: flip through the cards together. Point to the coloured sound-spellings, say each sound, then blend the word. Flip to hear it and sort it: Got it or Not yet (Not yet cards come back a few cards later).',
      `Play: the tablet says a word and the child taps it among look-alikes from this level. ${need} right out of ${Math.min(store.prefs().sessionSize, deck.cards.length)} (${PASS_PCT}%) passes the level and opens the next one; a miss shows the right word and asks it again at the end of the round.`,
      'Reteach: cards missed two of the last three times go first in the next round and sit in Grown-ups → Needs practice. Each card is "mastered" after three right answers in a row across days.',
      'Extend: Word Builder (build the word from letter tiles), Slingshot and Bubble Pop pull words from this level once it is open.',
    ];
  }
  return [
    'Look: read the question aloud, let the child answer in their own words, then flip the card. The note on the back is the teaching point to say out loud.',
    `Play: tap-the-answer round with three choices. ${need} right out of ${Math.min(store.prefs().sessionSize, deck.cards.length)} (${PASS_PCT}%) passes the level and opens the next one; after two misses the right answer is shown and said.`,
    'Reteach: missed cards return first next round and appear in Grown-ups → Needs practice. A card is "mastered" after three right answers in a row across days.',
    'Extend: Feed the Monster, Mystery Picture, Rocket Launch and Memory Match reuse this level\'s cards; Frog Hop uses the math ones.',
  ];
}

function example(card, deck) {
  if (deck.kind === 'read') return h('li', null, h('strong', null, card.text), card.note ? ` — ${card.note}` : '');
  return h('li', null, card.q, ' ', h('strong', null, `→ ${card.a}`));
}

function levelCard(deck, index, total) {
  const kind = KIND[deck.kind] || KIND.qa;
  return h('article', { class: 'lesson-card', id: `lesson-${deck.id}` },
    h('header', { class: 'lesson-head' },
      h('span', { class: 'lesson-emoji', 'aria-hidden': 'true' }, deck.emoji || ''),
      h('div', null,
        h('h4', null, `Level ${index + 1} of ${total}: ${deck.title}`),
        h('div', { class: 'muted small' }, `${kind.label} · ${deck.cards.length} cards`,
          (deck.standards || []).length ? ' · NC ' + deck.standards.join(', ') : ''))),
    h('p', null, h('strong', null, 'Teaches: '), deck.about || ''),
    deck.tip ? h('p', null, h('strong', null, 'Say this while teaching: '), deck.tip) : null,
    h('p', null, h('strong', null, 'How the lesson runs:')),
    h('ol', { class: 'lesson-steps' }, steps(deck).map((s) => h('li', null, s))),
    h('p', null, h('strong', null, 'Example cards:')),
    h('ul', { class: 'lesson-examples' }, deck.cards.slice(0, 3).map((c) => example(c, deck))),
    h('p', { class: 'lesson-links' },
      h('a', { href: `#/cards/${deck.id}` }, 'Open the flashcards'), ' · ',
      deck.quiz === false ? null : h('a', { href: `#/practice/deck/${deck.id}` }, 'Play a round')));
}

function subjectSection(sub, decks) {
  const groups = sub.groups || [];
  const groupTitle = (id) => (groups.find((g) => g.id === id) || {}).title || 'More';
  const sequence = [];
  let last = null;
  decks.forEach((d, i) => {
    if (d.group !== last) {
      sequence.push({ title: groupTitle(d.group), from: i + 1, to: i + 1, decks: [d] });
      last = d.group;
    } else {
      const s = sequence[sequence.length - 1];
      s.to = i + 1;
      s.decks.push(d);
    }
  });
  return h('section', { class: 'panel lesson-subject', id: `subject-${sub.id}` },
    h('h2', null, `${sub.emoji} ${sub.title}`),
    h('p', null, sub.about || ''),
    h('p', null, h('strong', null, 'Scope and sequence: '),
      sequence.map((s, i) => `${i ? ' → ' : ''}${s.title} (levels ${s.from === s.to ? s.from : `${s.from}–${s.to}`})`).join('')),
    sequence.map((s) => h('div', { class: 'lesson-group' },
      h('h3', null, s.title),
      s.decks.map((d) => levelCard(d, decks.indexOf(d), decks.length)))));
}

export function mount(root, scope, subjectId = '') {
  const { state } = store;
  const subjects = state.subjects.filter((s) => store.decksOf(s.id, { includeHidden: true }).length);
  const chosen = subjects.find((s) => s.id === subjectId) || null;
  const shown = chosen ? [chosen] : subjects;
  const decksAll = store.state.decks.length;
  const cardsAll = store.state.decks.reduce((n, d) => n + d.cards.length, 0);

  const picker = h('select', { class: 'input', 'aria-label': 'Subject',
    onchange: (e) => go(`/lessons${e.target.value ? `/${e.target.value}` : ''}`) },
  h('option', { value: '', selected: !chosen }, 'All subjects'),
  subjects.map((s) => h('option', { value: s.id, selected: chosen && chosen.id === s.id }, `${s.emoji} ${s.title}`)));

  const body = h('div', { class: 'scroll grown-body lessons' });
  appendAll(body,
    h('div', { class: 'page-head' },
      h('h1', null, 'Lesson plans'), picker, h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', type: 'button', onclick: () => window.print() }, 'Print'),
      h('a', { class: 'btn small', href: '#/grownups' }, 'Grown-ups'),
      h('a', { class: 'btn small primary', href: '#/' }, 'Back to the cards')),
    h('div', { class: 'panel' },
      h('h2', null, 'How Star Cards teaches'),
      h('p', null, `${decksAll} levels and ${cardsAll} cards across ${state.subjects.length} subjects, written to the North Carolina `,
        'Standard Course of Study for Grade 1 (reading follows the CKLA Grade 1 Skills order). Each subject is a path of levels, ',
        'easy to hard, that runs through the school year; the grown-up "about" text of each level says when it fits and whether it steps past the Grade 1 code.'),
      h('ul', { class: 'lesson-steps' },
        h('li', null, h('strong', null, 'Look, then Play. '), 'Every level has flashcards that talk (Look) and a short tap-the-answer round (Play). The child hears the word or question, so a beginning reader can work alone.'),
        h('li', null, h('strong', null, `Pass mark ${PASS_PCT}%. `), `A level is passed, and the next one opens, when a round scores ${PASS_PCT}% or better (9 of 10). Under that the child sees exactly what to aim for and tries again; the best round is kept, so a bad day never closes a level.`),
        h('li', null, h('strong', null, 'Testing out. '), `A child who already knows a subject taps a locked level: one round drawn from every level up to it, and ${PASS_PCT}% opens them all at once (a grown-up switch can turn this off).`),
        h('li', null, h('strong', null, 'Spaced practice. '), 'Each card keeps its own record: three right answers in a row across days make it mastered, a miss brings it back sooner, and cards missed two of the last three times are collected in Needs practice and come first in every round.'),
        h('li', null, h('strong', null, 'Games reuse the lessons. '), 'Eight mini-games draw their questions from the levels already reached, earn stars but never change a card\'s record, and have no timers, lives or game-over.'),
        h('li', null, h('strong', null, 'Grown-ups see everything. '), 'The locked area shows every level\'s score and what was answered wrongly, lets you build a test from any decks, flag a card that needs practice, hide decks the class has not reached, and set the round length.'),
        h('li', null, h('strong', null, 'Private by design. '), 'No accounts and no internet needed: the home version keeps everything on a small computer at home; the demo copy keeps progress only in the browser it is opened in.'))),
    ...shown.map((sub) => subjectSection(sub, store.decksOf(sub.id, { includeHidden: true }))));

  root.append(h('section', { class: 'screen grown' },
    h('header', { class: 'grown-bar' },
      h('strong', { class: 'grown-brand' }, '⭐ Star Cards'),
      h('nav', { class: 'tabs', 'aria-label': 'Lesson plan subjects' },
        h('a', { class: `tab${chosen ? '' : ' active'}`, href: '#/lessons' }, 'All'),
        subjects.map((s) => h('a', { class: `tab${chosen && chosen.id === s.id ? ' active' : ''}`, href: `#/lessons/${s.id}` }, `${s.emoji} ${s.title}`))),
      h('button', { class: 'btn small primary', type: 'button', onclick: () => go('/') }, 'Done')),
    body));
}
