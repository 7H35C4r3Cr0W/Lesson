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

## Rules for writing cards

- **One idea per card.** First-grade words, short sentences, no clauses.
- **Correct.** Every fact must be true as stated and match North Carolina's Grade 1 standards. Mark the standard code on the deck.
- **Wrong answers must be clearly wrong** to a child who knows the fact, and never a second right answer. Same kind as the answer (a number for a number, an animal for an animal).
- **No tricks.** No "all of the above", no "none", no negatives ("which is NOT").
- **Lowercase words**, except names, "I", and the start of sentences.
- **Kind and neutral.** No scary, violent, religious or political content; no brands; no real people other than those in the NC standards (e.g. historical figures named there).
- **No personal data.** Never a real child's name, address, school or teacher.
- Emoji only from the common set (animals, food, objects, weather, nature). Avoid flags, skin-tone variants and anything newer than 2020.
