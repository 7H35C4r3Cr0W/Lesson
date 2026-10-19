// Grown-up card pages: the "needs practice" pile, and the browser for every deck
// and card (show or hide decks, flag a card, report a card that is wrong).

import { h, appendAll } from '../../dom.js';
import { deckProgress, isTrouble, levelOf } from '../../logic.js';
import * as store from '../../store.js';
import { confirmDialog, dateTime, dialog, meter, toast } from '../../ui.js';

function fail(err) {
  toast(err.status === 401 ? 'Your PIN timed out. Tap Done and come back in.' : err.message);
}

function cardFront(card, deck) {
  return deck.kind === 'read' ? card.text : card.q;
}

// The last six answers as dots: green right, orange miss.
function recentDots(stat) {
  if (!stat || !stat.recent) return h('span', { class: 'muted' }, '–');
  return h('span', { class: 'dots', 'aria-label': `last answers: ${stat.recent.replace(/1/g, 'right ').replace(/0/g, 'miss ')}` },
    Array.from(stat.recent, (r) => h('span', { class: r === '1' ? 'dot ok' : 'dot miss' })));
}

function reportProblem(card, deck, redraw) {
  const existing = store.flagFor(card.id, 'issue');
  const note = h('textarea', { class: 'input wide', maxLength: 300, placeholder: 'What is wrong with it? (optional)',
    value: existing ? existing.note : '' });
  dialog({
    title: 'Report a problem with this card',
    body: h('div', null,
      h('p', null, h('strong', null, cardFront(card, deck))),
      h('p', { class: 'muted' }, 'The card is hidden from every child until you un-report it. Your note is kept here so you can fix the deck file later.'),
      note),
    actions: [
      { label: 'Cancel' },
      existing ? { label: 'Un-report (show it again)', run: () => { store.removeFlag(existing.id).then(redraw).catch(fail); } } : null,
      { label: existing ? 'Save note' : 'Hide this card', kind: 'primary',
        run: () => { store.addFlag(card.id, 'issue', note.value.trim()).then(redraw).catch(fail); } },
    ].filter(Boolean),
  });
}

// ---- needs practice --------------------------------------------------------

export function needsPractice(body, scope, arg, redraw) {
  const list = store.troubleList();
  body.append(
    h('div', { class: 'page-head' }, h('h1', null, 'Needs practice'), h('span', { class: 'spacer' }),
      list.length ? h('a', { class: 'btn', href: '#/practice/again' }, 'Practice these now') : null,
      list.length ? h('a', { class: 'btn primary', href: '#/grownups/newtest/trouble' }, 'Make a test from these') : null),
    h('p', { class: 'muted' }, 'A card lands here by itself when it is missed two of the last three times, and leaves after two right answers in a row. ',
      'You can also add any card yourself from the Cards page. These cards come up first in practice and fill the “Try again” button on the home screen.'));
  if (!list.length) {
    body.append(h('div', { class: 'panel' }, h('p', null, '🎉 Nothing needs extra practice right now.')));
    return;
  }
  body.append(h('div', { class: 'panel' }, h('table', { class: 'table' },
    h('thead', null, h('tr', null, ['Card', 'Answer', 'Deck', 'Right / tries', 'Last six', 'Last tried', 'Why', '']
      .map((t) => h('th', null, t)))),
    h('tbody', null, list.map(({ card, deck, stat, auto, flagged }) => {
      const flag = store.flagFor(card.id, 'practice');
      return h('tr', null,
        h('td', null, h('strong', null, cardFront(card, deck))),
        h('td', null, deck.kind === 'read' ? (card.note || '') : card.a),
        h('td', null, h('a', { href: `#/grownups/cards/${deck.id}` }, deck.title)),
        h('td', null, stat ? `${stat.correct} / ${stat.seen}` : '–'),
        h('td', null, recentDots(stat)),
        h('td', null, stat && stat.at ? dateTime(stat.at) : '–'),
        h('td', null, [auto ? 'missed lately' : null, flagged ? `you flagged it${flag && flag.note ? `: ${flag.note}` : ''}` : null]
          .filter(Boolean).join(' · ')),
        h('td', { class: 'actions' },
          h('button', { class: 'btn small', type: 'button', title: 'Take it off this list', onclick: async () => {
            try {
              if (flag) await store.removeFlag(flag.id);
              if (auto) await store.clearTrouble(card.id);
              redraw();
            } catch (err) {
              fail(err);
            }
          } }, 'Knows it now'),
          h('button', { class: 'btn small', type: 'button', onclick: () => reportProblem(card, deck, redraw) }, 'Card is wrong')));
    })))));
}

// ---- card browser ----------------------------------------------------------

// #/grownups/cards              every subject and deck
// #/grownups/cards/<subjectId>  one subject opened
// #/grownups/cards/<deckId>     one deck's cards
export function browser(body, scope, arg, redraw) {
  const { state } = store;
  const deck = state.deckById.get(arg);
  if (deck) return deckPage(body, deck, redraw);

  const hiddenDecks = store.hiddenDecks();
  const hiddenCards = store.hiddenCards();
  const setHidden = (ids, hide) => {
    const next = new Set(hiddenDecks);
    ids.forEach((id) => (hide ? next.add(id) : next.delete(id)));
    store.savePrefs({ hiddenDecks: Array.from(next) }).then(redraw).catch(fail);
  };

  const issues = state.flags.filter((f) => f.kind === 'issue');
  appendAll(body,
    h('div', { class: 'page-head' }, h('h1', null, 'Cards'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', type: 'button', onclick: () => setHidden(state.decks.map((d) => d.id), false) }, 'Show every deck')),
    h('p', { class: 'muted' }, 'Untick a deck to hide it from the child, for example sounds the class has not reached yet. Hidden decks keep their progress. Tap a deck name to see its cards.'),
    issues.length ? h('div', { class: 'panel' }, h('h2', null, `Cards reported as wrong (${issues.length})`),
      h('table', { class: 'table' }, h('tbody', null, issues.map((flag) => {
        const entry = state.cardById.get(flag.card);
        if (!entry) return null;
        return h('tr', null,
          h('td', null, h('strong', null, cardFront(entry.card, entry.deck))),
          h('td', null, h('a', { href: `#/grownups/cards/${entry.deck.id}` }, entry.deck.title)),
          h('td', null, flag.note || h('span', { class: 'muted' }, 'no note')),
          h('td', { class: 'muted' }, flag.card),
          h('td', { class: 'actions' }, h('button', { class: 'btn small', type: 'button',
            onclick: () => store.removeFlag(flag.id).then(redraw).catch(fail) }, 'Show it again')));
      })))) : null);

  for (const sub of state.subjects) {
    const decks = store.decksOf(sub.id, { includeHidden: true });
    if (!decks.length) continue;
    const shown = decks.filter((d) => !hiddenDecks.has(d.id)).length;
    body.append(h('details', { class: 'panel subject-panel', open: arg === sub.id || !arg },
      h('summary', null, h('h2', null, `${sub.emoji} ${sub.title}`),
        h('span', { class: 'muted' }, ` ${shown} of ${decks.length} decks shown`)),
      h('div', { class: 'form-actions' },
        h('button', { class: 'btn small', type: 'button', onclick: () => setHidden(decks.map((d) => d.id), false) }, 'Show all'),
        h('button', { class: 'btn small', type: 'button', onclick: () => setHidden(decks.map((d) => d.id), true) }, 'Hide all')),
      h('table', { class: 'table' },
        h('thead', null, h('tr', null, ['Show', 'Deck', 'Cards mastered', '', 'Needs practice', 'NC standard'].map((t) => h('th', null, t)))),
        h('tbody', null, decks.map((d) => {
          const p = deckProgress(d, state.stats, hiddenCards);
          const group = (sub.groups || []).find((g) => g.id === d.group);
          return h('tr', { class: hiddenDecks.has(d.id) ? 'row-off' : '' },
            h('td', null, h('input', { type: 'checkbox', 'aria-label': `Show ${d.title}`, checked: !hiddenDecks.has(d.id),
              onchange: (e) => setHidden([d.id], !e.target.checked) })),
            h('td', null, h('a', { href: `#/grownups/cards/${d.id}` }, `${d.emoji || ''} ${d.title}`),
              group ? h('div', { class: 'muted small' }, group.title) : null),
            h('td', null, `${p.mastered} / ${p.total}`),
            h('td', { class: 'meter-cell' }, meter(p.mastered, p.total)),
            h('td', null, p.trouble ? String(p.trouble) : ''),
            h('td', { class: 'muted small' }, (d.standards || []).join(', ')));
        })))));
  }
}

function deckPage(body, deck, redraw) {
  const { state } = store;
  const sub = store.subjectById(deck.subject) || {};
  const hiddenCards = store.hiddenCards();
  const p = deckProgress(deck, state.stats, hiddenCards);
  const isHidden = store.hiddenDecks().has(deck.id);

  body.append(
    h('div', { class: 'page-head' },
      h('h1', null, `${deck.emoji || ''} ${deck.title}`), h('span', { class: 'spacer' }),
      h('a', { class: 'btn', href: `#/grownups/cards/${deck.subject}` }, `All ${sub.title || ''} decks`)),
    h('div', { class: 'panel' },
      h('p', null, deck.about || ''),
      deck.tip ? h('p', null, h('strong', null, 'Tip: '), deck.tip) : null,
      h('p', { class: 'muted' }, `${p.total} cards · ${p.mastered} mastered · ${p.trouble} need practice`,
        (deck.standards || []).length ? ` · NC standard ${deck.standards.join(', ')}` : '',
        isHidden ? ' · hidden from the child' : ''),
      h('div', { class: 'form-actions' },
        h('a', { class: 'btn small', href: `#/cards/${deck.id}` }, 'Open as flashcards'),
        deck.quiz === false ? null : h('a', { class: 'btn small', href: `#/practice/deck/${deck.id}` }, 'Open practice round'),
        h('button', { class: 'btn small', type: 'button', onclick: () =>
          confirmDialog('Start this deck over?', deck.passage ? 'Every card in this deck goes back to “new” and its story reads are forgotten. Stars from answering are kept; the stars from reading this story go with its reads.' : 'Stars are kept, but every card in this deck goes back to “new”.', 'Start over', () => {
            store.resetProgress('deck', deck.id).then(redraw).catch(fail);
          }, true) }, 'Start this deck over'))),
    h('div', { class: 'panel' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, ['Card', deck.kind === 'read' ? 'Note' : 'Answer', 'Level', 'Right / tries', 'Last six', '']
        .map((t) => h('th', null, t)))),
      h('tbody', null, deck.cards.map((card) => {
        const stat = state.stats[card.id];
        const practiceFlag = store.flagFor(card.id, 'practice');
        const issue = store.flagFor(card.id, 'issue');
        const level = issue ? 'hidden' : isTrouble(stat) ? 'needs practice' : levelOf(stat);
        return h('tr', { class: issue ? 'row-off' : '' },
          h('td', null, h('strong', null, cardFront(card, deck)), card.emoji ? ` ${card.emoji}` : ''),
          h('td', null, deck.kind === 'read' ? (card.note || '') : card.a),
          h('td', null, h('span', { class: `lvl lvl-${level.replace(/\s/g, '-')}` }, level)),
          h('td', null, stat ? `${stat.correct} / ${stat.seen}` : '–'),
          h('td', null, recentDots(stat)),
          h('td', { class: 'actions' },
            h('button', { class: `btn small${practiceFlag ? ' on' : ''}`, type: 'button', 'aria-pressed': practiceFlag ? 'true' : 'false',
              onclick: () => (practiceFlag ? store.removeFlag(practiceFlag.id) : store.addFlag(card.id, 'practice'))
                .then(redraw).catch(fail) }, practiceFlag ? '★ Needs practice' : '☆ Needs practice'),
            h('button', { class: `btn small${issue ? ' on' : ''}`, type: 'button',
              onclick: () => reportProblem(card, deck, redraw) }, issue ? 'Reported' : 'Card is wrong')));
      })))));
}
