# Star Cards content format

All the learning content lives in `content/`:

- `content/subjects.json` — the subjects on the home screen, in order, each with its groups ("worlds" on the level path).
- `content/decks/*.json` — one file per deck. **A deck is one level** on its subject's path. Levels run in `order`, easy to hard.

Edit a file, save, reload the page on the tablet. No restart. Run `python tools/validate_content.py` after editing: it catches every mistake below.

## Subject

```json
{ "id": "math", "title": "Math", "emoji": "🔢", "color": "#2fae77", "tint": "#dff5ea",
  "about": "one line for grown-ups",
  "groups": [ { "id": "count", "title": "Counting and numbers" }, ... ] }
```

## Deck (one level)

```json
{
  "id": "math.add-to-10",            // lowercase, dots/dashes; unique; file is named math-add-to-10.json
  "subject": "math",                 // a subject id
  "group": "add",                    // a group id of that subject
  "order": 30,                       // position on the path (lower = earlier); leave gaps of 10
  "title": "Adding to 10",           // 28 characters max; the child sees this
  "emoji": "➕",                      // one emoji for the level button
  "kind": "qa",                      // "read" = words/sentences to read; "qa" = question with answer choices
  "standards": ["NC.1.OA.6"],        // NC Standard Course of Study codes this deck practices
  "about": "two sentences for the grown-up: what this is and why it matters",
  "tip": "one sentence a parent can use while sitting with the child (optional)",
  "quiz": true,                      // optional, default true. false = flashcards only, never quizzed/tested
  "readChoices": false,              // optional (qa only). false = do not read answer choices aloud (numbers, words)
  "speakFront": true,                // optional (qa only). false = do not read the question aloud on flashcards
  "readAloud": true,                 // optional (qa only). true = the quiz and games always read the question (and choices,
                                     //   unless readChoices is false), even in "only when needed" voice mode: for read-along
                                     //   subjects a first-grader cannot read alone yet (Computers, My Body)
  "passage": { ... },                // optional: makes this level a story with a Read screen (see Stories below)
  "book": { ... },                   // optional: the library book this level points at (see Stories below)
  "cards": [ ... ]                   // 8 to 30 cards
}
```

## Cards

### `read` cards — the child reads the text

```json
{ "id": "math.add-to-10.cat",       // deck id + "." + short slug, unique everywhere
  "text": "cat",                     // the word or sentence, lowercase unless a name or "I"
  "parts": ["c", "a", "t"],          // optional: the sound-spellings; must join to text exactly. "sh","ee","ck" are one part
  "tricky": [1],                     // optional: indexes into parts that cannot be sounded out (said: "ai" says /e/)
  "emoji": "🐱",                      // optional: shown on the back as a picture clue
  "note": "the ai says /e/",         // optional: one short line a grown-up can read aloud
  "say": "cat" }                     // optional: what the voice says if it differs from text
```

In a quiz the child **sees and hears** the word and taps it among look-alike words from the same deck, so every read deck
needs at least 3 different words. Sentences are read decks too (no `parts`); keep them under 90 characters,
8 words or fewer.

### `qa` cards — a question with one right answer

```json
{ "id": "science.needs.plant-water",
  "q": "What does a plant need to grow?",      // under 110 characters; the voice reads it
  "a": "water and light",                       // the right answer, short (ideally 1 to 4 words)
  "wrong": ["candy", "toys"],                   // exactly 2 wrong answers (3 allowed), same kind/length as the answer, never true
  "emoji": "🌱",                                 // optional picture clue shown with the question
  "visual": { "type": "clock", "h": 3, "m": 30 },   // optional drawing (see below)
  "note": "Plants make food from sunlight.",   // optional fact for the back of the flashcard
  "sayQ": "...", "sayA": "..." }                // optional: what the voice says instead of q / a
```

The voice reads `q` and then each answer choice (unless `readChoices` is false), so a child who cannot read every
word can still answer. Write `q` the way you would say it. Math symbols are spoken for you: `+ − = ? > <` and `¢`.

### Visuals (drawn by the app, no image files)

| type | fields | notes |
|---|---|---|
| `clock` | `h` 1-12, `m` 0 or 30 | analog clock |
| `digital` | `h`, `m` | digital clock |
| `coins` | `coins`: list of `penny` `nickel` `dime` `quarter` (max 10), `label`: `value` (default) / `name` / `none` | |
| `blocks` | `tens` 0-9, `ones` 0-19 | base-ten rods and cubes |
| `tenframe` | `n` 0-20 | two frames when n > 10 |
| `count` | `emoji`, `n` 1-30 | things to count, rows of five |
| `shape` | `shape`: circle square rectangle triangle hexagon trapezoid rhombus half-circle quarter-circle cube rectangular-prism cone cylinder sphere; `color`: blue gold green coral purple | |
| `fraction` | `shape` circle/rectangle/square, `parts` 2 or 4, `shaded` | halves and fourths only |
| `tally` | `n` 1-30 | |
| `numberline` | `from`, `to` (1-20 steps), `mark` | a dot on `mark` |
| `measure` | `len` 1-12, `emoji` | an object over unit blocks |
| `graph` | `rows`: 2-4 of `{ "label": "🍎", "n": 3 }` | picture graph |

## Stories (a deck with a `passage`)

A story level is an ordinary deck with one extra object, `passage`. Everything else (the rules, Look, Play, the
games, tests and grown-up pages) works unchanged. The level gains a **📖 Read** screen the child reads the text
from (tap a word to hear it; 🔤 *Sound it out* says it sound by sound), a grown-up scoring mode that measures words
correct per minute, and its Play round is the comprehension check (the normal 85% rule). Every finished read
earns a star; only the Play round passes the level.

```json
{
  "id": "reading.u1-the-cat-nap", "subject": "reading", "group": "unit1", "order": 10,
  "title": "The Cat Nap", "emoji": "🐱", "kind": "qa",
  "standards": ["RF.1.4", "RL.1.1", "RL.1.3"],
  "about": "...", "tip": "...",
  "readAloud": true, "readChoices": false,
  "passage": {
    "text": "Sam has a cat.\nThe cat is Max.\n\nMax naps on the mat.\nSam pats Max.",
    "level": "unit1",
    "focus": ["short a", "short i", "ck"],
    "tricky": ["the", "a", "is", "has"]
  },
  "cards": [
    { "id": "reading.u1-the-cat-nap.who", "q": "Who has a cat?", "a": "Sam", "wrong": ["Max", "Mom"],
      "note": "The first line says so." }
  ]
}
```

- `passage.text` — the story. `\n` is a line break (one sentence per line is the norm for beginners), `\n\n` starts
  a new paragraph, and a line that is exactly `***` is a page break: the Read screen shows one page at a time.
  Letters, apostrophes, spaces and `. , ! ? " ' -` only. A one-page story (no `***`) is 30–120 words (an error
  outside that), 40–90 preferred (a warning); a book of several pages is checked page by page, 20–120 words each,
  10 pages at most. Sentences of 12 words or fewer and lines of 14 or fewer (warnings).
- `passage.level` (required) — the decodability level the words are checked against: a group id of the Stories
  subject (`unit1` … `unit7`), looked up in `content/phonics_levels.json` (below). `"open"` skips the check, for
  retold classics and anything else meant to be read together rather than decoded alone.
- `passage.focus` / `passage.tricky` — short strings for grown-ups: the sound-spellings the story practises
  (`"short a"`, `"ck"`) and the tricky words it uses. Optional but expected; the level page, the lesson plan and
  Grown-ups → Reading show them.
- `cards` — 8 to 12 `qa` cards that check understanding: who / where / what happened / first and last / why /
  how did X feel / what a word means / which word is in the story. `a` and each `wrong` at most 4 words. The round
  uses the usual round length (10 questions → 9 right passes).
- `readAloud: true` (the tablet reads each question even in "only when needed" voice mode) and
  `readChoices: false` (the choices are story words the child reads himself; read along if he is stuck).
- A `kind: "read"` deck may carry a `passage` too. Story Time's shelf levels are "the words you will meet in this
  book": the passage lays those words out as lines, the cards are the same words, and the deck also carries `book`.

### `book` (optional, any deck)

```json
"book": { "author": "Arnold Lobel", "source": "Frog and Toad Are Friends, 1970",
          "borrow": "https://www.worldcat.org/...", "blurb": "Two friends and five very short stories." }
```

`borrow` must be an `https` link (the library catalogue, WorldCat, Open Library). The app never copies a published
book's text or pictures: a shelf level teaches the words and links to the library. Public-domain classics (Aesop's
fables, fairy tales, Peter Rabbit, nursery rhymes) are retold at first-grade level in the app's own words, with
`passage.level: "open"`.

### How words are counted

One rule, run the same way in Python (`tools/decodability.py`, the validator and the server's words-per-minute)
and in JavaScript (`web/js/logic.js`): split the text on whitespace; strip from each token every leading and
trailing character that is not a letter, digit or apostrophe; drop empty tokens; a token counts as a word if it
contains a letter (so `***`, `-` and `12` do not). `cleanWord(token)` is that stripped token lower-cased with a
trailing `'s` removed (`Max's` → `max`); missed words are stored and listed that way.

### Decodability warnings and `content/phonics_levels.json`

`python tools/validate_content.py` checks every passage (shape, characters, length, card count, `kind`,
`readAloud` / `readChoices`) and then its **decodability**: every word should be readable with the sound-spellings
and tricky words taught by `passage.level`. The inventory lives in `content/phonics_levels.json`:

```json
{ "unit1": { "title": "Unit 1: short vowels",
             "graphemes": ["a", "b", "c", "ck", "..."],
             "endings": ["s", "es", "ed", "ing", "er", "est", "'s", "ly"],
             "tricky": ["the", "a", "of", "..."] },
  "unit2": { "...": "each unit lists its FULL cumulative inventory; nothing is inherited" } }
```

A word is decodable if it is a tricky word of that level, or if it (optionally minus one ending from `endings`,
with the usual doubled-consonant or dropped-e base: `hopping` → `hop`, `hoping` → `hope`) can be spelled entirely
from the level's `graphemes`. Digits are never decodable; a hyphenated word is checked as its parts; an apostrophe
is silent (`can't` is checked as c-a-n-t). The validator
prints one WARN per story listing the words that are not (`3 words not decodable at unit1: beautiful, house, said`).
It is a warning, not an error, so you can judge: swap the word; or, if the class has learned it as a tricky word,
add it to that unit's `tricky` list (and to `passage.tricky` so grown-ups see it); or keep it and plan to read it
together. A missing level file or an unknown level is one warning per story. `tools/decodability.py` is importable
from your own scripts (`load_levels`, `is_decodable`, `undecodable`, `word_tokens`, `clean_word`).

### The sound-it-out voice (`web/js/phonics.js`)

🔤 *Sound it out* on the Read screen says a word one sound at a time. What the voice says for each sound-spelling
is the `SOUNDS` table exported from `web/js/phonics.js`; a grown-up can tune an entry there (say, what short `a`
sounds like) by editing that file. It is plain JavaScript, no build step: save, reload the tablet.

## Rules for writing cards

- **One idea per card.** First-grade words, short sentences, no clauses.
- **Correct.** Every fact must be true as stated and match North Carolina's Grade 1 standards. Mark the standard code on the deck.
- **Wrong answers must be clearly wrong** to a child who knows the fact, and never a second right answer. Same kind as the answer (a number for a number, an animal for an animal).
- **No tricks.** No "all of the above", no "none", no negatives ("which is NOT").
- **Lowercase words**, except names, "I", and the start of sentences.
- **Kind and neutral.** No scary, violent, religious or political content; no brands; no real people other than those in the NC standards (e.g. historical figures named there).
- **No personal data.** Never a real child's name, address, school or teacher.
- Emoji only from the common set (animals, food, objects, weather, nature). Avoid flags, skin-tone variants and anything newer than 2020.
