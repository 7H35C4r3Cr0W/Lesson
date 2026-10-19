"""Decodability and story-passage checks. Run from the project folder:  python -m unittest discover -s tests -v

The rule-by-rule tests use the real content/phonics_levels.json (the coordinator's per-unit examples);
the structural tests use a small inline level, so they do not move when the inventory is edited.
"""
import contextlib
import io
import json
import shutil
import sys
import tempfile
import unittest
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(1, str(ROOT))

import decodability as dec  # noqa: E402
import server  # noqa: E402
import validate_content as vc  # noqa: E402

LEVELS = dec.load_levels(ROOT / "content" / "phonics_levels.json")
U = {name: LEVELS[name] for name in ("unit1", "unit2", "unit3", "unit4", "unit5", "unit6", "unit7")}

TINY = {
    "title": "a tiny unit-1-like level",
    "graphemes": list("abcdefghijklmnoprstuvwxyz") + ["qu", "ck", "sh", "th", "ch", "ng", "ll", "ss", "pp", "nn", "g_j"],
    "endings": ["s", "es", "ing"],
    "tricky": ["the", "a", "I", "said", "is", "Look"],
}


def ok(level, *words):
    return [w for w in words if not dec.is_decodable(w, level)]        # the words that unexpectedly fail


def bad(level, *words):
    return [w for w in words if dec.is_decodable(w, level)]            # the words that unexpectedly pass


class WordRules(unittest.TestCase):
    def test_word_tokens_follow_the_shared_rules(self):
        self.assertEqual(dec.word_tokens('"Max\'s cat," said Sam!  Run, run.'), ["Max's", "cat", "said", "Sam", "Run", "run"])
        self.assertEqual(dec.word_tokens("1 2 3 go 2nd ice-cream -- ... ***"), ["go", "2nd", "ice-cream"])
        self.assertEqual(dec.word_tokens(""), [])
        self.assertEqual(dec.word_tokens(None), [])
        self.assertEqual(len(dec.word_tokens("Sam has a cat.\nThe cat is Max.\n\nMax naps on the mat.\nSam pats Max.")), 16)

    def test_clean_word(self):
        # Apostrophes are kept at the edges (the shared rule), so dialogue goes in double quotes, not single.
        for token, clean in (("Max's", "max"), ('"Cat!"', "cat"), ("it's", "it"), ("DOG", "dog"), ("--", ""),
                             ("cats'", "cats'"), ("Max’s", "max"), ("can't", "can't"), (None, "")):
            self.assertEqual(dec.clean_word(token), clean, token)

    def test_pages(self):
        self.assertEqual(dec.pages("Sam sat.\nSam ran."), ["Sam sat.\nSam ran."])
        self.assertEqual(dec.pages("Sam sat.\n***\nSam ran.\n  ***  \n\nThe end.\n"), ["Sam sat.", "Sam ran.", "The end."])
        self.assertEqual(dec.pages("***\n\n***"), [])
        self.assertEqual(dec.pages("A * B\n**\nC"), ["A * B\n**\nC"])       # only a line of exactly *** breaks a page
        self.assertEqual(dec.pages(""), [])


class RuleByRule(unittest.TestCase):
    """The coordinator's examples per CKLA unit, against the real inventory."""

    def test_unit_examples(self):
        self.assertEqual(ok(U["unit1"], "cat", "ship", "thack", "black", "kick", "jumping"), [])
        self.assertEqual(bad(U["unit1"], "house", "cake", "night", "car", "saw", "knot", "catch", "city", "fly"), [])
        self.assertTrue(dec.is_decodable("my", U["unit1"]), "my is on the Kindergarten tricky list")
        self.assertEqual(ok(U["unit2"], "cake", "hoped", "hoping", "hopes", "like", "five", "queen", "cheese"), [])
        self.assertEqual(ok(U["unit3"], "house", "look", "saw", "moon", "coin"), [])
        self.assertEqual(ok(U["unit4"], "car", "farmer", "jumped", "her", "for"), [])
        self.assertEqual(ok(U["unit5"], "catch", "cage", "write", "give"), [])
        self.assertEqual(ok(U["unit6"], "ice", "knot", "when", "whale", "mouse", "faces"), [])
        self.assertEqual(ok(U["unit7"], "rain", "play", "boat", "trains", "paying"), [])

    def test_rule_1_two_vowels_need_a_team(self):
        self.assertEqual(bad(U["unit1"], "rain", "house", "tree", "lion", "boat", "toe"), [])
        self.assertEqual(ok(U["unit2"], "tree", "seeing"), [])
        self.assertEqual(ok(U["unit3"], "house", "boil", "moon"), [])
        self.assertEqual(ok(U["unit7"], "rain", "boat"), [])

    def test_rule_2_final_e(self):
        self.assertEqual(bad(U["unit1"], "cake", "hope", "hopes", "hoped", "these", "apple", "ice", "give"), [])
        self.assertTrue(dec.is_decodable("the", U["unit1"]), "tricky word")
        self.assertTrue(dec.is_decodable("she", U["unit1"]), "tricky word")
        self.assertEqual(ok(U["unit2"], "cake", "hopes", "hoped", "those", "gave"), [])
        self.assertEqual(U["unit2"].explain("cake"), "c-a(k)e")
        self.assertEqual(U["unit2"].explain("hopes"), "h-o(p)e +s")
        self.assertEqual(U["unit2"].explain("hoped"), "h-o(p)e-d")
        self.assertEqual(U["unit3"].explain("house"), "h-ou-s-e")          # a silent e after a team is fine
        self.assertEqual(U["unit5"].explain("give"), "g-i-ve")
        self.assertEqual(U["unit6"].explain("ice"), "i-ce")
        self.assertEqual(U["unit5"].explain("cage"), "c-a-ge")
        self.assertEqual(ok(U["unit1"], "bed", "sled", "wet", "ten", "wanted"), [], "an e before a consonant is a short e")

    def test_rule_3_y(self):
        self.assertEqual(ok(U["unit1"], "yes", "yet", "yoyo"), [])
        self.assertEqual(bad(U["unit1"], "fly", "happy", "day", "very", "gym"), [])
        self.assertEqual(ok(U["unit1"], "my", "by", "funny", "yellow", "why"), [], "tricky words")
        self.assertEqual(ok(U["unit4"], "yesterday", "sunday"), [], "tricky words")
        self.assertFalse(dec.is_decodable("day", U["unit6"]))
        self.assertTrue(dec.is_decodable("day", U["unit7"]))

    def test_rule_4_r_controlled(self):
        self.assertEqual(bad(U["unit1"], "car", "her", "for", "bird", "turn", "farm"), [])
        self.assertEqual(ok(U["unit4"], "car", "her", "for", "farm", "corn"), [])
        self.assertEqual(bad(U["unit7"], "bird", "turn"), [], "ir and ur are never taught in Grade 1")
        self.assertEqual(ok(U["unit1"], "carrot", "run", "rat"), [])      # rr is a double consonant; r before a vowel

    def test_rule_5_w_teams(self):
        self.assertEqual(bad(U["unit1"], "saw", "new", "snow", "owl", "town"), [])
        self.assertEqual(ok(U["unit3"], "saw", "paw", "drawing"), [])
        self.assertEqual(bad(U["unit7"], "snow", "new"), [], "ow and ew are never taught in Grade 1")
        self.assertEqual(ok(U["unit1"], "down", "yellow"), [], "tricky words")
        self.assertTrue(dec.is_decodable("cow", U["unit6"]), "cow joins the tricky list in unit 6")
        self.assertFalse(dec.is_decodable("cow", U["unit5"]))
        self.assertTrue(dec.is_decodable("wet", U["unit1"]), "w before a vowel is a consonant")

    def test_rule_6_forced_spellings(self):
        self.assertEqual(bad(U["unit1"], "night", "bridge", "catch", "knot", "write", "whip", "phone"), [])
        self.assertEqual(bad(U["unit7"], "night", "bridge", "phone"), [], "igh, dge and ph are never taught")
        self.assertEqual(ok(U["unit5"], "catch", "write"), [])
        self.assertEqual(ok(U["unit6"], "knot", "knee", "whip", "white"), [])
        self.assertEqual(U["unit1"].explain("ship"), "sh-i-p")
        self.assertEqual(U["unit1"].explain("wishes"), "w-i-sh +es")
        self.assertEqual(U["unit1"].explain("quick"), "qu-i-ck")

    def test_rule_7_soft_c_and_g_and_q(self):
        self.assertEqual(bad(U["unit1"], "city", "cent", "ice", "cage", "page"), [])
        self.assertEqual(ok(U["unit1"], "cat", "get", "gift", "cup"), [])
        self.assertEqual(ok(U["unit5"], "cage", "page", "huge", "large"), [])
        self.assertFalse(dec.is_decodable("cent", U["unit5"]))
        self.assertEqual(ok(U["unit6"], "cent", "ice", "mice", "dance"), [])
        self.assertFalse(dec.is_decodable("iraq", U["unit7"]), "a lone q never passes")
        self.assertIn("c_s", U["unit6"].flags)
        self.assertIn("g_j", U["unit5"].flags)
        self.assertNotIn("g_j", U["unit5"].graphemes)

    def test_rule_8_digits_and_single_letters(self):
        self.assertEqual(bad(U["unit7"], "2", "b2", "2nd", "x", "b", ""), [])
        self.assertEqual(ok(U["unit1"], "a", "I", "A"), [])

    def test_rule_9_endings(self):
        self.assertEqual(ok(U["unit1"], "cats", "jumping", "running", "hopping", "wishes", "boxes", "looking", "wants"), [])
        self.assertEqual(bad(U["unit1"], "hoping", "hoped", "baked", "cried"), [])
        self.assertEqual(U["unit1"].explain("looking"), "look (tricky) +ing")
        self.assertEqual(U["unit1"].explain("hopping"), "h-o-pp-i-ng")
        self.assertEqual(U["unit2"].explain("hoping"), "h-o(p)e +ing")
        self.assertEqual(U["unit2"].explain("baking"), "b-a(k)e +ing")
        self.assertTrue(dec.is_decodable("hoped", U["unit2"]), "hope + d before -ed is an ending of its own")
        self.assertEqual(ok(U["unit4"], "jumped", "sadness", "helpless", "wanted"), [])
        self.assertEqual(U["unit4"].explain("hoped"), "h-o(p)e +ed")
        self.assertEqual(U["unit1"].explain("its"), "i-t-s")                 # 3 letters: no peeling, read as is
        self.assertEqual(U["unit2"].explain("hoppings"), "h-o-pp-i-ng-s")     # reads as is: no ending to peel

    def test_x_is_never_a_magic_e_middle(self):
        # x is two sounds (/ks/), so fixed is fix + ed (unit 4), never a magic-e word f-i(x)e-d at unit 2.
        self.assertEqual(bad(U["unit2"], "axe", "fixed", "mixed", "boxed", "waxed"), [])
        self.assertEqual(U["unit4"].explain("fixed"), "f-i-x +ed")
        self.assertEqual(U["unit2"].explain("mixes"), "m-i-x +es")
        self.assertEqual(U["unit2"].explain("five"), "f-i(v)e")              # other single consonants still do

    def test_rule_10_backtracking(self):
        contrived = {"graphemes": ["ma", "m", "ast"], "endings": [], "tricky": []}
        self.assertTrue(dec.is_decodable("mast", contrived), "the longer ma leads nowhere (no s), m-ast works")
        self.assertEqual(dec.level_from(contrived).explain("mast"), "m-ast")
        self.assertEqual(U["unit1"].explain("shin"), "sh-i-n")
        self.assertFalse(dec.is_decodable("shin", {**TINY, "graphemes": list("shin")}), "sh is never read as s-h")

    def test_apostrophes_hyphens_and_possessives(self):
        self.assertEqual(U["unit1"].explain("can't"), "c-a-n-t")
        self.assertEqual(U["unit1"].explain("Max's"), "m-a-x")
        self.assertEqual(U["unit1"].explain("cat-nap"), "c-a-t | n-a-p")
        self.assertFalse(dec.is_decodable("cat-cake", U["unit1"]))
        self.assertTrue(dec.is_decodable("cat-cake", U["unit2"]))

    def test_undecodable_lists_each_word_once_in_order(self):
        text = "The cake is on the rain.\nThe cake is big!\nSam's cake."
        self.assertEqual(dec.undecodable(text, U["unit1"]), ["cake", "rain"])
        self.assertEqual(dec.undecodable(text, U["unit7"]), [])
        self.assertEqual(dec.undecodable("", U["unit1"]), [])


class LevelFile(unittest.TestCase):
    def test_load_levels_shape(self):
        self.assertEqual(sorted(LEVELS), ["unit1", "unit2", "unit3", "unit4", "unit5", "unit6", "unit7"])   # _about skipped
        self.assertTrue(U["unit1"].title.startswith("Unit 1"))
        self.assertEqual(U["unit2"].magic, {"a", "i", "o", "u"})
        self.assertIn("ee", U["unit2"].graphemes)
        self.assertNotIn("a_e", U["unit2"].graphemes)
        for n in range(1, 7):                       # cumulative: every unit holds the one before
            self.assertTrue(U[f"unit{n}"].graphemes <= U[f"unit{n + 1}"].graphemes, n)
            self.assertTrue(U[f"unit{n}"].tricky <= U[f"unit{n + 1}"].tricky, n)

    def test_load_errors(self):
        tmp = Path(tempfile.mkdtemp(prefix="starcards-levels-"))
        try:
            with self.assertRaises(OSError):
                dec.load_levels(tmp / "nope.json")
            (tmp / "list.json").write_text("[1]", encoding="utf-8")
            with self.assertRaises(ValueError):
                dec.load_levels(tmp / "list.json")
            (tmp / "bad.json").write_text(json.dumps({"unit1": {"graphemes": "abc"}}), encoding="utf-8")
            with self.assertRaises(ValueError):
                dec.load_levels(tmp / "bad.json")
            (tmp / "good.json").write_text(json.dumps({"_about": "note", "unit1": TINY}), encoding="utf-8")
            levels = dec.load_levels(tmp / "good.json")
            self.assertEqual(list(levels), ["unit1"])
            self.assertTrue(dec.is_decodable("cat", levels["unit1"]))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        with self.assertRaises(ValueError):
            dec.is_decodable("cat", {"tricky": []})
        with self.assertRaises(ValueError):
            dec.is_decodable("cat", {"graphemes": ["a", 1]})

    def test_cli(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = dec.main(["unit1", "cat", "house"])
        self.assertEqual(code, 1)
        self.assertEqual(out.getvalue().splitlines(), ["cat: c-a-t", "house: NOT decodable"])
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(dec.main(["unit7", "rain", "play"]), 0)
            self.assertEqual(dec.main(["unit9", "rain"]), 2)
            self.assertEqual(dec.main([]), 2)
        tmp = Path(tempfile.mkdtemp(prefix="starcards-cli-"))
        try:
            deck = tmp / "story.json"
            deck.write_text(json.dumps({"passage": {"text": "The cake is on the rain.", "level": "unit1"}}), encoding="utf-8")
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(dec.main(["--file", str(deck)]), 1)
                self.assertEqual(dec.main(["--file", str(deck), "--level", "unit7"]), 0)
            lines = out.getvalue().splitlines()
            self.assertIn("2 of 5 different words not decodable at unit1: cake, rain", lines[0])
            self.assertIn("all 5 different words decodable at unit7", lines[1])
            deck.write_text(json.dumps({"passage": {"text": "Beautiful things.", "level": "open"}}), encoding="utf-8")
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(dec.main(["--file", str(deck)]), 0)
                self.assertEqual(dec.main(["--file", str(tmp / "missing.json")]), 2)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------- validator

def lines(n: int, sentence: str = "Sam has a cat.") -> str:
    return "\n".join([sentence] * n)                     # 4 words per line


def qa(i: int) -> dict:
    return {"id": f"reading.u1-test.q{i}", "q": f"Who has a cat {i}?", "a": "Sam", "wrong": ["Max", "Mom"]}


def story_deck(**over) -> dict:
    deck = {"id": "reading.u1-test", "subject": "reading", "group": "unit1", "order": 10, "title": "Test", "emoji": "🐱",
            "kind": "qa", "standards": ["RF.1.4"], "about": "a test story", "readAloud": True, "readChoices": False,
            "passage": {"text": lines(10), "level": "unit1", "focus": ["short a"], "tricky": ["the"]},
            "cards": [qa(i) for i in range(8)]}
    deck.update(over)
    return deck


def passage(**over) -> dict:
    return {**story_deck()["passage"], **over}


def check(deck, levels=None) -> vc.Report:
    rep = vc.Report()
    vc.check_passage(deck, "test.json", rep, levels=levels if levels is not None else {"unit1": U["unit1"]})
    return rep


def has(lines_, needle: str) -> bool:
    return any(needle in line for line in lines_)


class PassageValidator(unittest.TestCase):
    def test_good_story_is_clean(self):
        rep = check(story_deck())
        self.assertEqual((rep.errors, rep.warnings), ([], []))

    def test_shape_errors(self):
        self.assertTrue(has(check(story_deck(passage="oops")).errors, "'passage' must be an object"))
        self.assertTrue(has(check(story_deck(passage=passage(text=""))).errors, "non-empty string"))
        self.assertTrue(has(check(story_deck(passage=passage(level=5))).errors, "'level' must be a string"))
        self.assertTrue(has(check(story_deck(passage=passage(text=lines(10, "Sam has a cat; yes.")))).errors, "';'"))
        self.assertTrue(has(check(story_deck(passage=passage(text=lines(7)))).errors, "passage has 28 words"))
        self.assertTrue(has(check(story_deck(passage=passage(text=lines(31)))).errors, "passage has 124 words"))
        self.assertTrue(has(check(story_deck(cards=[qa(i) for i in range(7)])).errors, "at least 8 cards"))
        self.assertTrue(has(check(story_deck(passage=passage(focus="short a"))).errors, "'focus' must be a list"))
        self.assertTrue(has(check(story_deck(passage=passage(text="***\n***"))).errors, "no text between"))

    def test_warnings(self):
        self.assertTrue(has(check(story_deck(passage=passage(text=lines(9)))).warnings, "passage has 36 words; 40 to 90"))
        self.assertTrue(has(check(story_deck(passage=passage(text=lines(23)))).warnings, "passage has 92 words"))
        long_sentence = "Sam has a cat and the cat has a mat and a hat and a bat."     # 16 words
        rep = check(story_deck(passage=passage(text=lines(9) + "\n" + long_sentence)))
        self.assertTrue(has(rep.warnings, "a sentence of 16 words"), rep.warnings)
        self.assertTrue(has(rep.warnings, "a line of 16 words"), rep.warnings)
        rep = check(story_deck(passage={"text": lines(10), "level": "unit1"}))
        self.assertTrue(has(rep.warnings, "no 'focus' list"))
        self.assertTrue(has(rep.warnings, "no 'tricky' list"))
        self.assertTrue(has(check(story_deck(readAloud=False)).warnings, '"readAloud": true'))
        self.assertTrue(has(check(story_deck(readChoices=True)).warnings, '"readChoices": false'))
        self.assertTrue(has(check(story_deck(cards=[qa(i) for i in range(13)])).warnings, "13 questions"))
        long_answer = {**qa(0), "a": "Sam and his big cat Max"}
        self.assertTrue(has(check(story_deck(cards=[long_answer] + [qa(i) for i in range(1, 8)])).warnings, "over 4 words"))
        self.assertTrue(has(check(story_deck(passage=passage(extra=1))).warnings, "unknown passage key 'extra'"))

    def test_decodability_warnings(self):
        rep = check(story_deck(passage=passage(text=lines(10, "The house is beautiful."))))
        self.assertEqual(rep.errors, [])
        self.assertTrue(has(rep.warnings, "2 words not decodable at unit1: house, beautiful"), rep.warnings)
        rep = check(story_deck(passage=passage(text=lines(10, "The house is big."))))
        self.assertTrue(has(rep.warnings, "1 word not decodable at unit1: house"), rep.warnings)
        self.assertTrue(has(check(story_deck(), levels={}).warnings, "level 'unit1' is not in phonics_levels.json"))
        self.assertTrue(has(check(story_deck(passage=passage(level="unit7"))).warnings, "level 'unit7' is not in"))
        # No level file at all: one warning per story, not an error.
        saved = (vc.LEVELS_FILE, vc._levels, vc._levels_state)
        try:
            vc.LEVELS_FILE, vc._levels, vc._levels_state = ROOT / "content" / "nope-levels.json", None, "unloaded"
            rep = vc.Report()
            vc.check_passage(story_deck(), "test.json", rep)
            self.assertEqual(rep.errors, [])
            self.assertTrue(has(rep.warnings, "nope-levels.json is not there yet"), rep.warnings)
            # The real file, loaded once, gives the real answer.
            vc.LEVELS_FILE, vc._levels, vc._levels_state = ROOT / "content" / "phonics_levels.json", None, "unloaded"
            rep = vc.Report()
            vc.check_passage(story_deck(passage=passage(text=lines(10, "Sam has a cake."))), "test.json", rep)
            self.assertTrue(has(rep.warnings, "1 word not decodable at unit1: cake"), rep.warnings)
            self.assertIsNotNone(vc._levels)
        finally:
            vc.LEVELS_FILE, vc._levels, vc._levels_state = saved

    def test_open_level_skips_decodability(self):
        rep = check(story_deck(passage=passage(text=lines(10, "The house is beautiful."), level="open")))
        self.assertEqual((rep.errors, rep.warnings), ([], []))
        rep = check(story_deck(passage=passage(level="open")), levels={})
        self.assertEqual(rep.warnings, [], "no 'not checked' warning either")

    def test_story_fits_the_servers_word_limit(self):
        # POST /api/reads refuses words > 600 (server.py MAX_PASSAGE_WORDS), so a longer book could never be read.
        long_book = "\n***\n".join([lines(28)] * 6)                       # 6 pages of 112 words: each page is fine
        rep = check(story_deck(passage=passage(text=long_book)))
        self.assertTrue(has(rep.errors, "672 words in all; the Pi keeps reads of stories up to 600 words"), rep.errors)
        rep = check(story_deck(passage=passage(text="\n***\n".join([lines(25)] * 6))))      # exactly 600
        self.assertFalse(has(rep.errors, "words in all"), rep.errors)
        self.assertEqual(vc.MAX_STORY_WORDS, server.MAX_PASSAGE_WORDS)

    def test_pages(self):
        two = lines(10) + "\n***\n" + lines(10)
        rep = check(story_deck(passage=passage(text=two)))
        self.assertEqual((rep.errors, rep.warnings), ([], []))
        twelve = "\n***\n".join([lines(10)] * 12)
        self.assertTrue(has(check(story_deck(passage=passage(text=twelve))).errors, "12 pages; a book is 10 pages at most"))
        short = lines(10) + "\n***\n" + lines(2) + "\nSam sat."           # 10 words on page 2
        rep = check(story_deck(passage=passage(text=short)))
        self.assertTrue(has(rep.errors, "page 2 has 10 words; a page is 20 to 120 words"), rep.errors)
        thin = lines(10) + "\n***\n" + lines(6) + "\nSam sat."            # 26 words on page 2: fine, but thin
        rep = check(story_deck(passage=passage(text=thin)))
        self.assertEqual(rep.errors, [])
        self.assertTrue(has(rep.warnings, "page 2 has 26 words; 30 to 90 reads best"), rep.warnings)
        errs = check(story_deck(passage=passage(text=lines(4) + "\n***\n" + lines(4)))).errors
        self.assertEqual(len(errs), 2, errs)                                   # one error per thin page
        self.assertTrue(all("has 16 words" in e for e in errs), errs)
        rep = check(story_deck(passage=passage(text=lines(5) + "\n***\n" + lines(5))))
        self.assertEqual(rep.errors, [], "20 words is the floor, not an error")
        self.assertTrue(has(check(story_deck(passage=passage(text=lines(10) + "\n* * *\n" + lines(10)))).errors, "'*'"))

    def test_read_deck_passage_is_a_word_list(self):
        words = ["cat", "hat", "map", "sat", "mat", "rat", "bat", "fat"]
        shelf = story_deck(id="storytime.shelf-test", subject="storytime", group="shelf", kind="read", standards=["RF.1.4"],
                           passage={"text": "cat hat map sat\nmat rat bat fat", "level": "open"},
                           cards=[{"id": f"storytime.shelf-test.{w}", "text": w} for w in words])
        del shelf["readAloud"], shelf["readChoices"]
        rep = check(shelf)
        self.assertEqual(rep.errors, [])
        self.assertFalse(has(rep.warnings, "readAloud") or has(rep.warnings, "readChoices") or has(rep.warnings, "sentence"))
        rep = check({**shelf, "passage": {"text": "cat hat map sat mat rat bat", "level": "open"}})
        self.assertTrue(has(rep.errors, "passage has 7 words; a word list is 8 to 120 words"), rep.errors)
        one_line = " ".join(words * 2)                                       # 16 words, no sentences, one line
        rep = check({**shelf, "passage": {"text": one_line, "level": "open"}})
        self.assertEqual((rep.errors, [w for w in rep.warnings if "sentence" in w or "line" in w]), ([], []))
        rep = check({**shelf, "cards": shelf["cards"][:7]})
        self.assertTrue(has(rep.errors, "at least 8 cards"))
        rep = check({**shelf, "passage": {"text": "cat hat map sat\nmat rat bat fat", "level": "unit1"}})
        self.assertEqual(rep.errors, [])
        self.assertFalse(has(rep.warnings, "not decodable"), "all short-a words")
        # Through check_deck, the way the tool runs: a shelf level with a book, 0 errors.
        saved = (vc.LEVELS_FILE, vc._levels, vc._levels_state)
        try:
            vc.LEVELS_FILE, vc._levels, vc._levels_state = ROOT / "content" / "phonics_levels.json", None, "unloaded"
            rep = vc.Report()
            subjects = {"storytime": {"groups": [{"id": "shelf"}]}, "reading": {"groups": [{"id": "unit1"}]}}
            book = {"author": "A. Writer", "source": "a library favorite", "borrow": "https://example.org/book", "blurb": "x"}
            vc.check_deck({**shelf, "book": book}, Path("storytime-shelf-test.json"), subjects, Counter(), set(), rep)
            self.assertEqual(rep.errors, [])
            rep = vc.Report()
            vc.check_deck(story_deck(), Path("reading-u1-test.json"), subjects, Counter(), set(), rep)
            self.assertEqual((rep.errors, rep.warnings), ([], []))
        finally:
            vc.LEVELS_FILE, vc._levels, vc._levels_state = saved

    def test_book_key(self):
        def book_errors(book):
            rep = vc.Report()
            vc.check_book(book, "test.json", rep)
            return rep
        good = {"author": "Doreen Cronin", "source": "library", "borrow": "https://example.org/x", "blurb": "cows type"}
        self.assertEqual((book_errors(good).errors, book_errors(good).warnings), ([], []))
        self.assertEqual(book_errors({"author": "A"}).errors, [])                      # every field optional
        self.assertTrue(has(book_errors("x").errors, "'book' must be an object of strings"))
        self.assertTrue(has(book_errors({"author": 5}).errors, "'book' must be an object of strings"))
        self.assertTrue(has(book_errors({"borrow": "http://example.org/x"}).errors, "must be an https:// link"))
        self.assertTrue(has(book_errors({"isbn": "123"}).warnings, "unknown book key 'isbn'"))
        self.assertIn("book", vc.DECK_KEYS)
        self.assertIn("passage", vc.DECK_KEYS)


if __name__ == "__main__":
    unittest.main()
