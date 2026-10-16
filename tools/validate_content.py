#!/usr/bin/env python3
"""Check every deck in content/ against the card format in CONTENT.md.

    python tools/validate_content.py            # whole content folder
    python tools/validate_content.py path.json  # one or more deck files (subjects.json still loaded)

Exit code 0 = no errors. Warnings do not fail the run. Standard library only.
"""
from __future__ import annotations

import json
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONTENT = ROOT / "content"

ID_RE = re.compile(r"^[a-z0-9][a-z0-9.-]*$")
STANDARD_RE = re.compile(r"^(NC\.)?[A-Z0-9][A-Z0-9.-]*(\.[a-z0-9]+)*$")   # also NC CS codes like K2-CS-01
DECK_KEYS = {"id", "subject", "group", "order", "title", "emoji", "kind", "standards", "about", "tip", "quiz",
             "readChoices", "speakFront", "sayTitle", "readAloud", "cards", "notes"}
READ_CARD_KEYS = {"id", "text", "parts", "tricky", "emoji", "note", "say", "quiz", "tags"}
QA_CARD_KEYS = {"id", "q", "a", "wrong", "emoji", "visual", "note", "sayQ", "sayA", "quiz", "tags"}

# Must match renderVisual() in web/js/visuals.js.
VISUALS = {
    "clock": {"h": int, "m": int},
    "digital": {"h": int, "m": int},
    "coins": {"coins": list},
    "blocks": {},
    "tenframe": {"n": int},
    "count": {"n": int},
    "shape": {"shape": str},
    "fraction": {"parts": int, "shaded": int},
    "tally": {"n": int},
    "numberline": {},
    "measure": {"len": int},
    "graph": {"rows": list},
}
SHAPES = {"circle", "square", "rectangle", "triangle", "hexagon", "trapezoid", "rhombus", "half-circle",
          "quarter-circle", "cube", "rectangular-prism", "cone", "cylinder", "sphere"}
COINS = {"penny", "nickel", "dime", "quarter"}
COLORS = {"blue", "gold", "green", "coral", "purple"}


class Report:
    def __init__(self):
        self.errors: list[str] = []
        self.warnings: list[str] = []

    def err(self, where: str, msg: str) -> None:
        self.errors.append(f"{where}: {msg}")

    def warn(self, where: str, msg: str) -> None:
        self.warnings.append(f"{where}: {msg}")


def load_json(path: Path, rep: Report):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        rep.err(path.name, f"cannot read: {e}")
        return None


def check_visual(spec, where: str, rep: Report) -> None:
    if not isinstance(spec, dict) or not isinstance(spec.get("type"), str):
        return rep.err(where, "visual must be an object with a 'type'")
    kind = spec["type"]
    if kind not in VISUALS:
        return rep.err(where, f"unknown visual type {kind!r}; known: {', '.join(sorted(VISUALS))}")
    typed = True
    for key, typ in VISUALS[kind].items():
        if not isinstance(spec.get(key), typ) or isinstance(spec.get(key), bool):
            rep.err(where, f"visual {kind} needs {key!r} ({typ.__name__})")
            typed = False
    if not typed:
        return        # the range checks below assume the right types
    if kind in ("clock", "digital"):
        if not (1 <= spec.get("h", 0) <= 12) or not (0 <= spec.get("m", 0) <= 59):
            rep.err(where, "clock h must be 1-12 and m 0-59")
        if kind == "clock" and spec.get("m", 0) not in (0, 30):
            rep.warn(where, "first grade tells time to the hour and half hour only")
    elif kind == "coins":
        bad = [c for c in spec.get("coins", []) if c not in COINS]
        if bad or not spec.get("coins"):
            rep.err(where, f"coins must be a non-empty list from {sorted(COINS)}; got {bad or 'nothing'}")
        if len(spec.get("coins", [])) > 10:
            rep.warn(where, "more than 10 coins is hard to count on a card")
        if spec.get("label") not in (None, "none", "name", "value"):
            rep.err(where, "coins label must be none, name or value")
    elif kind == "blocks":
        if not (0 <= spec.get("tens", 0) <= 9) or not (0 <= spec.get("ones", 0) <= 19):
            rep.err(where, "blocks tens must be 0-9 and ones 0-19")
    elif kind == "tenframe":
        if not (0 <= spec["n"] <= 20):
            rep.err(where, "tenframe n must be 0-20")
    elif kind == "count":
        if not (1 <= spec["n"] <= 30):
            rep.err(where, "count n must be 1-30")
    elif kind == "shape":
        if spec["shape"] not in SHAPES:
            rep.err(where, f"unknown shape {spec['shape']!r}; known: {', '.join(sorted(SHAPES))}")
        if spec.get("color") not in (None, *COLORS):
            rep.err(where, f"shape color must be one of {sorted(COLORS)}")
    elif kind == "fraction":
        if spec["parts"] not in (2, 4) or not (0 <= spec["shaded"] <= spec["parts"]):
            rep.err(where, "fraction parts must be 2 or 4 (halves/fourths) and shaded within parts")
        if spec.get("shape") not in (None, "circle", "rectangle", "square"):
            rep.err(where, "fraction shape must be circle, rectangle or square")
    elif kind == "tally":
        if not (1 <= spec["n"] <= 30):
            rep.err(where, "tally n must be 1-30")
    elif kind == "numberline":
        lo, hi = spec.get("from", 0), spec.get("to", 10)
        if not isinstance(lo, int) or not isinstance(hi, int) or not (1 <= hi - lo <= 20):
            rep.err(where, "numberline needs integer from/to with 1-20 steps")
        if spec.get("mark") is not None and not (lo <= spec["mark"] <= hi):
            rep.err(where, "numberline mark must be between from and to")
    elif kind == "measure":
        if not (1 <= spec["len"] <= 12):
            rep.err(where, "measure len must be 1-12")
    elif kind == "graph":
        rows = spec["rows"]
        if not (2 <= len(rows) <= 4) or any(not isinstance(r, dict) or not isinstance(r.get("n"), int)
                                            or not (0 <= r["n"] <= 10) or not r.get("label") for r in rows):
            rep.err(where, "graph rows must be 2-4 objects with a label and n 0-10")


def check_read_card(card: dict, where: str, rep: Report) -> None:
    text = card.get("text")
    if not isinstance(text, str) or not text.strip():
        return rep.err(where, "read card needs non-empty 'text'")
    if text != text.strip():
        rep.err(where, "text has leading/trailing spaces")
    parts = card.get("parts")
    if parts is not None:
        if not isinstance(parts, list) or not all(isinstance(p, str) and p for p in parts):
            rep.err(where, "'parts' must be a list of non-empty strings")
        elif "".join(parts) != text:
            rep.err(where, f"parts {parts} do not join to text {text!r}")
        tricky = card.get("tricky")
        if tricky is not None:
            if not isinstance(tricky, list) or any(not isinstance(i, int) or isinstance(i, bool) or not (0 <= i < len(parts or [])) for i in tricky):
                rep.err(where, "'tricky' must list valid indexes into 'parts'")
    elif card.get("tricky") is not None:
        rep.err(where, "'tricky' needs 'parts'")
    if len(text.split()) == 1 and text != text.lower() and text not in ("I",) and not text[0].isupper():
        rep.warn(where, "single words should be lowercase unless they are names or 'I'")
    if len(text.split()) == 1 and text[0].isupper() and text != "I":
        rep.warn(where, f"capitalised single word {text!r}: is it meant to be a name?")
    if len(text) > 90:
        rep.warn(where, "text longer than 90 characters is hard to fit on a card")


def check_qa_card(card: dict, where: str, rep: Report) -> None:
    q, a = card.get("q"), card.get("a")
    if not isinstance(q, str) or not q.strip():
        rep.err(where, "qa card needs non-empty 'q'")
    if not isinstance(a, str) or not a.strip():
        return rep.err(where, "qa card needs non-empty 'a'")
    wrong = card.get("wrong")
    if wrong is None:
        rep.err(where, "qa card needs a 'wrong' list of 2 distractors (3 at most)")
    elif not isinstance(wrong, list) or not all(isinstance(w, str) and w.strip() for w in wrong):
        rep.err(where, "'wrong' must be a list of non-empty strings")
    else:
        if not (1 <= len(wrong) <= 3):
            rep.err(where, f"'wrong' should have 2 entries (1-3 allowed), has {len(wrong)}")
        if len(wrong) == 1:
            rep.warn(where, "only one distractor; the child sees a 2-choice question")
        # The app matches answers case-sensitively (chosen === answer), so a capitals
        # deck may legitimately offer "Tuesday" against "tuesday". Compare exactly, and
        # only warn when two choices differ by case alone.
        exact = [w.strip() for w in wrong]
        if a.strip() in exact:
            rep.err(where, "a 'wrong' answer equals the right answer")
        if len(set(exact)) != len(exact):
            rep.err(where, "duplicate 'wrong' answers")
        lowered = [w.lower() for w in exact]
        if len(set(lowered)) != len(lowered) or (a.strip().lower() in lowered and a.strip() not in exact):
            rep.warn(where, "two choices differ only by capital letters (fine for a capitals deck, a typo otherwise)")
        if any(len(w) > 60 for w in wrong) or len(a) > 60:
            rep.warn(where, "answers over 60 characters will be tiny on the buttons")
    if isinstance(q, str) and len(q) > 110:
        rep.warn(where, "question longer than 110 characters; a six-year-old will not follow it")
    if "visual" in card:
        check_visual(card["visual"], where, rep)


def check_deck(deck, path: Path, subjects: dict, seen_cards: Counter, seen_decks: set, rep: Report) -> None:
    where = path.name
    if not isinstance(deck, dict):
        return rep.err(where, "deck must be a JSON object")
    for key in deck:
        if key not in DECK_KEYS:
            rep.warn(where, f"unknown deck key {key!r}")
    deck_id = deck.get("id")
    if not isinstance(deck_id, str) or not ID_RE.match(deck_id):
        return rep.err(where, "deck 'id' must be lowercase letters, digits, dots and dashes")
    if deck_id in seen_decks:
        rep.err(where, f"duplicate deck id {deck_id}")
    seen_decks.add(deck_id)
    expected_name = deck_id.replace(".", "-") + ".json"
    if path.name != expected_name:
        rep.warn(where, f"file name should be {expected_name}")
    subject = deck.get("subject")
    if subject not in subjects:
        rep.err(where, f"unknown subject {subject!r}; known: {', '.join(subjects)}")
    else:
        groups = {g["id"] for g in subjects[subject].get("groups", [])}
        if groups and deck.get("group") not in groups:
            rep.err(where, f"unknown group {deck.get('group')!r} for subject {subject}; known: {', '.join(sorted(groups))}")
    if not isinstance(deck.get("order"), int) or isinstance(deck.get("order"), bool):
        rep.err(where, "'order' must be a whole number (decks run easy to hard)")
    for key in ("title", "emoji", "about"):
        if not isinstance(deck.get(key), str) or not deck[key].strip():
            rep.err(where, f"'{key}' is required")
    if isinstance(deck.get("title"), str) and len(deck["title"]) > 28:
        rep.warn(where, "title longer than 28 characters will wrap on a level tile")
    kind = deck.get("kind")
    if kind not in ("read", "qa"):
        return rep.err(where, "'kind' must be 'read' or 'qa'")
    standards = deck.get("standards")
    if not isinstance(standards, list) or not standards:
        rep.err(where, "'standards' must list at least one NC standard code")
    elif any(not isinstance(s, str) or not STANDARD_RE.match(s) for s in standards):
        rep.err(where, f"standards must look like RF.1.4.b or NC.1.OA.6, got {standards}")
    for key in ("quiz", "readChoices", "speakFront", "readAloud"):
        if key in deck and not isinstance(deck[key], bool):
            rep.err(where, f"'{key}' must be true or false")
    cards = deck.get("cards")
    if not isinstance(cards, list) or not cards:
        return rep.err(where, "'cards' must be a non-empty list")
    if len(cards) < 6:
        rep.warn(where, f"only {len(cards)} cards; a level feels thin under 8")
    if len(cards) > 40:
        rep.warn(where, f"{len(cards)} cards; split decks over 40 so a level stays finishable")
    allowed = READ_CARD_KEYS if kind == "read" else QA_CARD_KEYS
    answers = Counter()
    for n, card in enumerate(cards):
        cw = f"{where} card {n + 1}"
        if not isinstance(card, dict):
            rep.err(cw, "card must be an object")
            continue
        cid = card.get("id")
        if not isinstance(cid, str) or not ID_RE.match(cid):
            rep.err(cw, "card 'id' must be lowercase letters, digits, dots and dashes")
        else:
            cw = f"{where} {cid}"
            if not cid.startswith(deck_id + "."):
                rep.err(cw, f"card id should start with '{deck_id}.'")
            seen_cards[cid] += 1
            if seen_cards[cid] > 1:
                rep.err(cw, "duplicate card id")
        for key in card:
            if key not in allowed:
                rep.warn(cw, f"unknown card key {key!r} for a {kind} card")
        if "quiz" in card and not isinstance(card["quiz"], bool):
            rep.err(cw, "'quiz' must be true or false")
        if kind == "read":
            check_read_card(card, cw, rep)
            answers[str(card.get("text", "")).lower()] += 1
        else:
            check_qa_card(card, cw, rep)
            answers[str(card.get("q", "")).lower()] += 1
    for text, n in answers.items():
        if n > 1 and text:
            rep.warn(where, f"{text!r} appears {n} times")
    if kind == "read" and deck.get("quiz", True):
        distinct = {str(c.get("text", "")) for c in cards if isinstance(c, dict)}
        if len(distinct) < 3:
            rep.err(where, "a quizzable read deck needs at least 3 different words to make choices")


def main(argv: list[str]) -> int:
    rep = Report()
    subjects_raw = load_json(CONTENT / "subjects.json", rep)
    subjects = {}
    if isinstance(subjects_raw, list):
        for s in subjects_raw:
            if not isinstance(s, dict) or not isinstance(s.get("id"), str):
                rep.err("subjects.json", "each subject needs a string id")
                continue
            for key in ("title", "emoji", "color", "tint"):
                if not isinstance(s.get(key), str):
                    rep.err("subjects.json", f"subject {s['id']} needs '{key}'")
            subjects[s["id"]] = s
    else:
        rep.err("subjects.json", "must be a list")
    files = [Path(a) for a in argv] if argv else sorted((CONTENT / "decks").glob("*.json"))
    seen_cards: Counter = Counter()
    seen_decks: set = set()
    decks_ok = 0
    cards_total = 0
    per_subject: Counter = Counter()
    for path in files:
        deck = load_json(path, rep)
        if deck is None:
            continue
        before = len(rep.errors)
        check_deck(deck, path, subjects, seen_cards, seen_decks, rep)
        if len(rep.errors) == before:
            decks_ok += 1
            cards_total += len(deck.get("cards", []))
            per_subject[deck.get("subject")] += 1
    for line in rep.warnings:
        print("WARN ", line)
    for line in rep.errors:
        print("ERROR", line)
    print(f"\n{decks_ok}/{len(files)} decks valid, {cards_total} cards, {len(rep.errors)} errors, {len(rep.warnings)} warnings")
    if per_subject:
        print("decks per subject:", ", ".join(f"{k}={v}" for k, v in sorted(per_subject.items())))
    return 1 if rep.errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
