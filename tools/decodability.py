#!/usr/bin/env python3
"""Is a word decodable at a given phonics level? Shared by tools/validate_content.py and its tests.

    python tools/decodability.py unit3 house look saw        # each word with its cuts, or NOT decodable
    python tools/decodability.py --file content/decks/reading-u1-the-cat-nap.json [--level unit2]

A story in the Stories subject should use only the sound-spellings ("graphemes") and tricky words the
class has been taught by that CKLA unit. content/phonics_levels.json lists, per unit, the FULL
cumulative inventory (no inheritance between units; a top-level "_about" note is ignored):

    {"unit1": {"title": "Unit 1: short vowels",
               "graphemes": ["a", "b", "c", ..., "ck", "sh", "th", "a_e", "g_j"],
               "endings": ["s", "es", "ing"],
               "tricky": ["the", "a", "of", "was"]}, ...}

"a_e" (and i_e, o_e, u_e, e_e) is magic e: the vowel, one consonant spelling and a final e. "g_j",
"c_s" and "n_ng" are flags (soft g, soft c, n before k), not spellings.

A word is decodable when it is a tricky word, or when it can be cut, start to end, into graphemes of
the level, with at most one ending taken off first. Every cut is tried, longer spellings first. Since
every letter is a grapheme, cutting alone would pass h-o-u-s-e at unit 1, so the cuts also follow
English spelling (the numbered rules in this file):

  1. two vowel letters in a row are never two single vowels: the team (ee, ou, ai ...) must be listed;
  2. a final e after a consonant is never a short e: it is magic e (cake, also hopes / hoped), a listed
     ending spelling (ce, se, ve, ge), or a silent e after a vowel team (house); the/he/she are tricky;
  3. y is a consonant only at the start of a word or right before a vowel; elsewhere it is a vowel
     spelling Grade 1 does not teach (my, funny: tricky words), so day needs "ay";
  4. a vowel before r (followed by a consonant or the end) needs ar / er / or; ir and ur never pass;
     a vowel before rr is a double consonant (carrot);
  5. a vowel before w at the end of a syllable needs aw / ow / ew (saw, cow, new);
  6. igh, dge, tch, wh, ph, ck, qu and word-initial kn / wr must be the listed spelling or fail;
  7. c before e / i / y needs the c_s flag or a final ce; g before a final e needs ge; a lone q fails;
  8. digits never pass; a one-letter word passes only as a tricky word (a, I);
  9. one ending from the level's list (s always) comes off a word of four or more letters; the base
     may be as written, plus e (hoping: hope), or minus a doubled consonant (hopping: hop), except that
     a one-syllable vowel-consonant stem before -ed / -ing / -er / -es must be the e-word (hoping is hope,
     since hop gives hopping);
 10. longest match with backtracking; any rule above vetoes a cut.

Digits are never decodable, hyphenated words are checked part by part, apostrophes are dropped
(can't -> cant) and a possessive 's is stripped first.

Word rules shared with web/js/logic.js (wordCount / cleanWord): a story is split on whitespace, each
token loses the leading and trailing characters that are not letters, digits or apostrophes, and a
token counts as a word when it contains a letter. clean_word() also lower-cases the token and drops a
trailing 's (Max's -> max). A line that is just *** is a page break (pages()). Change the two files
together. Standard library only.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LEVELS_FILE = ROOT / "content" / "phonics_levels.json"

_EDGE_RE = re.compile(r"^[^A-Za-z0-9'’]+|[^A-Za-z0-9'’]+$")   # ’ = a curly apostrophe
_LETTER_RE = re.compile(r"[A-Za-z]")
_MAGIC_RE = re.compile(r"^[aeiou]_e$")
# One syllable ending in a single vowel and a single consonant (hop, bak, scrap): such a stem doubles
# its last letter before a vowel ending, so hoping / baked / maker must come from an e-word.
# v, w, x and y never double, so river / mixed / snowed / played keep their plain stem.
_CVC_RE = re.compile(r"^[^aeiou]*[aeiou][^aeiouvwxy]$")
VOWELS = set("aeiou")
MAGIC_MIDDLES = set("bdfhjklmnprstvz")       # one consonant letter between the vowel and the e; th/ch/sh too
#                                              (never x: it is two sounds, so axe / fixed / mixed have no magic e)
MAGIC_MIDDLE_TEAMS = ("th", "ch", "sh")
TRAILING = ("ce", "se", "ve", "ge")           # spellings that end a word (ice, house, give, cage)
# Never read letter by letter (longest first, so tch wins over th). sh/ch/th/ng are in every level,
# forcing them just keeps s-h-i-p from ever standing in for sh-i-p.
FORCED = ("igh", "dge", "tch", "sh", "ch", "th", "ng", "wh", "ph", "ck", "qu")
FORCED_INITIAL = ("kn", "wr")
NO_SPLIT = {("g", "h"), ("p", "h")}
PAGE_BREAK = "***"


def pages(text) -> list[str]:
    """The pages of a story: the text cut at lines that are just ***, each page stripped, empty ones dropped.
    A story with no break is one page."""
    out, page = [], []
    for line in str(text or "").split("\n"):
        if line.strip() == PAGE_BREAK:
            out.append("\n".join(page))
            page = []
        else:
            page.append(line)
    out.append("\n".join(page))
    return [p for p in (x.strip() for x in out) if p]


def word_tokens(text) -> list[str]:
    """The words of a story in order, each stripped of surrounding punctuation (case and apostrophes kept)."""
    out = []
    for raw in str(text or "").split():
        tok = _EDGE_RE.sub("", raw)
        if tok and _LETTER_RE.search(tok):
            out.append(tok)
    return out


def clean_word(token) -> str:
    """The lookup form of a token: stripped, lower-case, without a possessive 's (Max's -> max)."""
    w = _EDGE_RE.sub("", str(token or "")).replace("’", "'").lower()
    if w.endswith("'s"):
        w = w[:-2]
    return w


def kind_of(g: str) -> str:
    """'v' = a single vowel letter, 't' = a spelling with a vowel in it (ee, ar, qu, magic e), 'c' = the rest."""
    if len(g) == 1 and g in VOWELS:
        return "v"
    return "t" if any(ch in VOWELS for ch in g) else "c"


class Level:
    """One unit's cumulative inventory, prepared for fast lookups. Build it from the JSON shape above."""

    __slots__ = ("title", "graphemes", "by_first", "magic", "middles", "flags", "endings", "vowel_endings", "tricky")

    def __init__(self, graphemes, endings=(), tricky=(), title=""):
        self.title = str(title or "")
        self.graphemes: set[str] = set()
        self.magic: set[str] = set()           # vowels with a magic-e spelling: {"a", "i", "o", "u"}
        self.flags: set[str] = set()           # g_j, c_s, n_ng
        for g in graphemes:
            g = str(g).strip().lower()
            if _MAGIC_RE.match(g):
                self.magic.add(g[0])
            elif "_" in g:
                self.flags.add(g)
            elif g:
                self.graphemes.add(g)
        # Graphemes by first letter, longest first, so each position only tries the few that can start there.
        self.by_first: dict[str, list[str]] = {}
        for g in sorted(self.graphemes, key=lambda x: (-len(x), x)):
            self.by_first.setdefault(g[0], []).append(g)
        self.middles = [g for g in self.graphemes if g in MAGIC_MIDDLES or g in MAGIC_MIDDLE_TEAMS]
        # A plural s may always come off a decodable base and is tried first (hopes is hope + s, not hop + es);
        # the rest longest first.
        rest = sorted({str(e).strip().lower() for e in endings if str(e).strip()} - {"s"}, key=len, reverse=True)
        self.endings = ["s", *rest]
        self.vowel_endings = [e for e in self.endings if e[0] in VOWELS]
        self.tricky = {clean_word(t) for t in tricky if clean_word(t)}

    # -- the public checks

    def decodable(self, word) -> bool:
        return self.explain(word) is not None

    def explain(self, word) -> str | None:
        """How the word reads at this level ("h-o(p)e +ing", "look (tricky) +s"), or None when it does not."""
        w = clean_word(word).replace("'", "")
        if not w or any(ch.isdigit() for ch in w):
            return None
        parts = [p for p in w.split("-") if p]
        if not parts:
            return None
        hows = []
        for part in parts:
            how = self._one(part)
            if how is None:
                return None
            hows.append(how)
        return " | ".join(hows)

    def _one(self, w: str) -> str | None:
        if w in self.tricky:
            return "tricky word"
        if len(w) == 1:
            return None                                 # 8: only a and I, and those are tricky words
        # 9: hoping / baked / maker: the stem would have doubled (hopping), so the word is not hop + ing
        # and must be read through its e-word base below, never cut straight through.
        peel = len(w) >= 4
        dropped_e = peel and any(w.endswith(e) and len(w) > len(e) and _CVC_RE.match(w[: -len(e)])
                                 for e in self.vowel_endings)
        if not dropped_e:
            path = self._segment(w)
            if path is not None:
                return "-".join(path)
        if peel:
            for ending in self.endings:
                if len(w) > len(ending) and w.endswith(ending):
                    for base in self._bases(w[: -len(ending)], ending):
                        if base in self.tricky:
                            return f"{base} (tricky) +{ending}"
                        path = self._segment(base)
                        if path is not None:
                            return f"{'-'.join(path)} +{ending}"
        return None

    @staticmethod
    def _bases(stem: str, ending: str) -> list[str]:
        """What a word may have looked like before the ending: hopp(ing) -> hop, hop(ing) -> hope, jump(ed) -> jump."""
        if ending[0] in VOWELS and _CVC_RE.match(stem):
            return [stem + "e"]                         # a CVC stem would have doubled: hoping is hope, not hop
        out = [stem]
        if len(stem) >= 2 and stem[-1] == stem[-2] and stem[-1] not in VOWELS:
            out.append(stem[:-1])                       # doubled consonant: hopping, bigger
        if stem and stem[-1] not in VOWELS:
            out.append(stem + "e")                      # dropped e after a longer stem: scraped, lived
        return out

    # -- cutting a word into graphemes

    @staticmethod
    def _forced_at(w: str, i: int) -> str | None:
        """A spelling that must be read whole when it starts here (6, 7): catch is c-a-tch or nothing."""
        for seq in FORCED:
            if w.startswith(seq, i):
                return seq
        if i == 0:
            for seq in FORCED_INITIAL:
                if w.startswith(seq):
                    return seq
        return None

    def _allowed(self, w: str, i: int, g: str, last: str, last2: str) -> bool:
        """May grapheme g start at position i after the graphemes last and last2 (the numbered rules)?"""
        end = i + len(g)
        nxt = w[end: end + 1]                           # the letter after g, "" at the end of the word
        if last and kind_of(last) == "v":
            if g[0] in VOWELS:
                return False                            # 1: rain needs ai, house needs ou
            if g == "r" and nxt not in VOWELS:
                return False                            # 4: car needs ar, her needs er
            if g == "w" and nxt not in VOWELS:
                return False                            # 5: saw needs aw, cow needs ow
        if g == "y" and i > 0 and nxt not in VOWELS:
            return False                                # 3: my, funny, day: a vowel spelling of y
        if g == "c" and nxt in ("e", "i", "y") and "c_s" not in self.flags:
            return False                                # 7: soft c needs the flag (or a final ce)
        if g == "g" and w[i + 1:] == "e":
            return False                                # 7: soft g before a final e needs ge
        if g in TRAILING and w[end:] not in ("", "s", "d"):
            return False                                # ce / se / ve / ge only end a word (faces, loved)
        if (last, g) in NO_SPLIT:
            return False                                # gh / ph are one spelling, never two sounds
        if g == "e" and last and kind_of(last) == "c":
            rest = w[i + 1:]
            if rest == "" and kind_of(last2 or "") != "t":
                return False                            # 2: cake needs a_e, the / she are tricky; house is fine
            if rest in ("s", "d") and last2 and kind_of(last2) == "v":
                return False                            # 2: hopes / hoped need the magic e too
        return True

    def _segment(self, w: str) -> list[str] | None:
        """The graphemes of w in order under the rules above, or None. Tries every cut (memoised on the
        position and the last two graphemes), so a longer spelling that leads nowhere is backed out of."""
        n = len(w)
        memo: dict[tuple, list | None] = {}

        def go(i: int, last: str, last2: str):
            if i == n:
                return []
            key = (i, last, last2)
            if key in memo:
                return memo[key]
            found = None
            forced = self._forced_at(w, i)
            options = ([forced] if forced in self.graphemes else []) if forced else self.by_first.get(w[i], ())
            for g in options:
                if w.startswith(g, i) and self._allowed(w, i, g, last, last2):
                    rest = go(i + len(g), g, last)
                    if rest is not None:
                        found = [g] + rest
                        break
            if found is None and forced is None and w[i] in self.magic and self._allowed(w, i, w[i], last, last2):
                for m in self.middles:                  # 2: magic e = vowel, one consonant, e (then s or d)
                    j = i + 1 + len(m)
                    if w.startswith(m, i + 1) and w.startswith("e", j) and w[j + 1:] in ("", "s", "d"):
                        token = f"{w[i]}({m})e"
                        rest = go(j + 1, token, last)
                        if rest is not None:
                            found = [token] + rest
                            break
            memo[key] = found
            return found

        return go(0, "", "")


def level_from(spec) -> Level:
    """A Level from the JSON shape (a dict with graphemes, endings, tricky, title); a Level passes through."""
    if isinstance(spec, Level):
        return spec
    if not isinstance(spec, dict) or not isinstance(spec.get("graphemes"), list):
        raise ValueError("a level must be an object with a 'graphemes' list")
    for key in ("graphemes", "endings", "tricky"):
        val = spec.get(key, [])
        if not isinstance(val, list) or any(not isinstance(x, str) for x in val):
            raise ValueError(f"'{key}' must be a list of strings")
    return Level(spec["graphemes"], spec.get("endings", []), spec.get("tricky", []), spec.get("title", ""))


def load_levels(path=LEVELS_FILE) -> dict[str, Level]:
    """Read a phonics level file: level id -> Level. Raises OSError when missing, ValueError when malformed.
    Top-level entries that are not objects (the "_about" note) are skipped."""
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("the level file must be an object: level id -> inventory")
    out = {}
    for level_id, spec in raw.items():
        if not isinstance(spec, dict):
            continue
        try:
            out[level_id] = level_from(spec)
        except ValueError as e:
            raise ValueError(f"level {level_id}: {e}") from None
    return out


def is_decodable(word, level) -> bool:
    """True when the word is a tricky word of the level or can be sounded out with its graphemes."""
    return level_from(level).decodable(word)


def undecodable(text, level) -> list[str]:
    """The words of a story that are not decodable at the level: unique, in order of first appearance."""
    lv = level_from(level)
    out: list[str] = []
    for tok in word_tokens(text):
        w = clean_word(tok)
        if w and w not in out and not lv.decodable(w):
            out.append(w)
    return out


# ------------------------------------------------------------------------ CLI

def main(argv: list[str]) -> int:
    """Exit 0 when every word checked is decodable, 1 when some are not, 2 for a usage problem."""
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__.split("\n\n")[1])
        return 2
    try:
        levels = load_levels(LEVELS_FILE)
    except (OSError, ValueError) as e:
        print(f"cannot read {LEVELS_FILE}: {e}")
        return 2
    if argv[0] == "--file":
        if len(argv) < 2:
            print("--file needs a deck file")
            return 2
        try:
            deck = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
            text = deck["passage"]["text"]
            level_id = deck["passage"].get("level")
        except (OSError, ValueError, KeyError, TypeError) as e:
            print(f"{argv[1]}: not a deck with a passage ({e})")
            return 2
        if "--level" in argv[2:]:
            level_id = argv[argv.index("--level") + 1]
        if level_id == "open":
            print(f"{argv[1]}: level is open (not a decodable story), nothing to check")
            return 0
        if level_id not in levels:
            print(f"{argv[1]}: level {level_id!r} is not in {LEVELS_FILE.name}; known: {', '.join(levels)}")
            return 2
        hard = undecodable(text, levels[level_id])
        total = len({clean_word(t) for t in word_tokens(text)})
        if hard:
            print(f"{len(hard)} of {total} different words not decodable at {level_id}: {', '.join(hard)}")
            return 1
        print(f"all {total} different words decodable at {level_id}")
        return 0
    level_id, words = argv[0], argv[1:]
    if level_id not in levels:
        print(f"unknown level {level_id!r}; known: {', '.join(levels)}")
        return 2
    if not words:
        print("give one or more words after the level")
        return 2
    bad = 0
    for word in words:
        how = levels[level_id].explain(word)
        print(f"{word}: {how if how is not None else 'NOT decodable'}")
        bad += how is None
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
