#!/usr/bin/env python3
"""Star Cards: a tiny flashcard server for one family, on one home network.

Standard library only (Python 3.9+), so it runs on a stock Raspberry Pi with
nothing to install. It does three jobs:

  * serves the web app from ./web
  * serves the flashcard content from ./content as one JSON bundle
  * keeps progress, tests and flags in a SQLite database

and, when Piper is installed next to the data (deploy/install-voices.sh), says the cards
and stories in a natural voice as audio clips the tablet plays (/api/tts).

Run it:      python3 server.py --port 8080
Then open:   http://<the-pi>.local:8080  on the tablet.

The grown-up PIN is a child lock, not real security. Keep this on your home
network and never forward a port to it from the internet.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import hmac
import http.client
import ipaddress
import json
import math
import os
import re
import secrets
import shlex
import signal
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import traceback
import unicodedata
import urllib.error
import urllib.request
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

APP_NAME = "Star Cards"
VERSION = "1.1.0"
ROOT = Path(__file__).resolve().parent

MAX_BODY = 1_000_000          # bytes accepted in one request body
MAX_ATTEMPTS_PER_POST = 500
MAX_TEST_CARDS = 100
MAX_PROFILES = 8
DAY_MS = 86_400_000

MODES = ("learn", "practice", "test", "game")
FLAG_KINDS = ("practice", "issue")
READ_MODES = ("self", "scored")   # a story read by the child alone, or timed and marked by a grown-up
MAX_PASSAGE_WORDS = 600           # a multi-page book can be long
MAX_READ_SECONDS = 1800
MAX_MISSED_WORDS = 60             # words kept per read for the "words to practise" list
MAX_MISSED_CHARS = 40
MAX_REPORT_READS = 50             # per story in the reading report
UID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
PIN_RE = re.compile(r"^\d{4,8}$")

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
    ".crt": "application/x-x509-ca-cert",      # the home CA for the optional https setup
}
COMPRESSIBLE = (".html", ".css", ".js", ".json", ".webmanifest", ".svg", ".txt")

SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'self'; img-src 'self' data:; media-src 'self' data: blob:; "
        "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    ),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
    # microphone=(self): the app's own origin may ask for the mic (the 🙋 "ask out loud"
    # feature over https); every other origin, and the camera and location, stay denied.
    "Permissions-Policy": "camera=(), microphone=(self), geolocation=()",
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS profiles(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '🦊',
  prefs TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS card_stats(
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0,
  correct INTEGER NOT NULL DEFAULT 0,
  wrong INTEGER NOT NULL DEFAULT 0,
  streak INTEGER NOT NULL DEFAULT 0,
  box INTEGER NOT NULL DEFAULT 0,
  recent TEXT NOT NULL DEFAULT '',
  last_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(profile_id, card_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS attempts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL,
  deck_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  correct INTEGER NOT NULL,
  chosen TEXT,
  ms INTEGER,
  test_id INTEGER,
  day TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attempts_profile_day ON attempts(profile_id, day);
CREATE INDEX IF NOT EXISTS attempts_profile_card ON attempts(profile_id, card_id);
CREATE TABLE IF NOT EXISTS flags(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  card_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE(profile_id, card_id, kind)
);
CREATE TABLE IF NOT EXISTS tests(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  config TEXT NOT NULL,
  card_ids TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  total INTEGER,
  correct INTEGER,
  results TEXT
);
CREATE INDEX IF NOT EXISTS tests_profile ON tests(profile_id, status);
CREATE TABLE IF NOT EXISTS rounds(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  deck_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  total INTEGER NOT NULL,
  correct INTEGER NOT NULL,
  day TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rounds_profile_deck ON rounds(profile_id, deck_id);
CREATE TABLE IF NOT EXISTS reads(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  deck_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  words INTEGER NOT NULL,
  errors INTEGER NOT NULL,
  seconds INTEGER,
  wcpm INTEGER,
  missed TEXT NOT NULL DEFAULT '[]',
  day TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reads_profile_deck ON reads(profile_id, deck_id);
CREATE TABLE IF NOT EXISTS books(
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  deck_id TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 1,
  at INTEGER NOT NULL,
  PRIMARY KEY(profile_id, deck_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
"""


def now_ms() -> int:
    return int(time.time() * 1000)


def local_day(ms: int | None = None) -> str:
    t = time.localtime((ms or now_ms()) / 1000)
    return time.strftime("%Y-%m-%d", t)


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


# ---------------------------------------------------------------- validation

def want_str(obj: dict, key: str, max_len: int, default=None, allow_empty=True) -> str:
    val = obj.get(key, default)
    if val is None:
        raise ApiError(400, f"Missing '{key}'")
    if not isinstance(val, str):
        raise ApiError(400, f"'{key}' must be text")
    val = val.strip()
    if len(val) > max_len:
        raise ApiError(400, f"'{key}' is too long")
    if not val and not allow_empty:
        raise ApiError(400, f"'{key}' cannot be empty")
    return val


def want_int(obj: dict, key: str, lo: int, hi: int, default=None) -> int:
    val = obj.get(key, default)
    if val is None:
        raise ApiError(400, f"Missing '{key}'")
    # bool is a subclass of int in Python; a JSON true is not a number here.
    if isinstance(val, bool) or not isinstance(val, int):
        raise ApiError(400, f"'{key}' must be a whole number")
    if val < lo or val > hi:
        raise ApiError(400, f"'{key}' must be between {lo} and {hi}")
    return val


def want_bool(obj: dict, key: str, default=None) -> bool:
    val = obj.get(key, default)
    if not isinstance(val, bool):
        raise ApiError(400, f"'{key}' must be true or false")
    return val


def clip(val, max_len: int) -> str:
    return val[:max_len] if isinstance(val, str) else ""


def clean_missed(raw) -> list[str]:
    """The words a read went wrong on, as lower-case text: non-words dropped, at most 60 of 40 characters."""
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ApiError(400, "'missed' must be a list of words")
    out: list[str] = []
    for word in raw:
        if not isinstance(word, str):
            continue
        word = word.strip().lower()[:MAX_MISSED_CHARS]
        if word and word not in out:
            out.append(word)
        if len(out) >= MAX_MISSED_WORDS:
            break
    return out


# -------------------------------------------------------------- learning math

def apply_result(stat: dict, correct: bool, at: int) -> dict:
    """Fold one answer into a card's running stats.

    Mirrors applyResult() in web/js/logic.js. Both are checked against the same
    vectors in tests/stat_vectors.json, so change them together.

    box is a Leitner box: 0 = never seen, 1 = missed last time, 5 = solid.
    recent is the last six results, oldest first, as a string of 1s and 0s.
    """
    seen = stat["seen"] + 1
    if correct:
        box = 2 if stat["box"] <= 0 else min(5, stat["box"] + 1)
        streak = stat["streak"] + 1
    else:
        box = 1
        streak = 0
    return {
        "seen": seen,
        "correct": stat["correct"] + (1 if correct else 0),
        "wrong": stat["wrong"] + (0 if correct else 1),
        "streak": streak,
        "box": box,
        "recent": (stat["recent"] + ("1" if correct else "0"))[-6:],
        "at": at,
    }


EMPTY_STAT = {"seen": 0, "correct": 0, "wrong": 0, "streak": 0, "box": 0, "recent": "", "at": 0}


def card_answer(card: dict, kind: str) -> str:
    """The one right answer for a card: the text itself for read decks, 'a' for question decks."""
    return card.get("text", "") if kind == "read" else card.get("a", "")


def wcpm_of(words: int, errors: int, seconds) -> int | None:
    """Words correct per minute, the fluency number schools use (mCLASS/DIBELS); None without a time.

    Mirrors wcpmOf() in web/js/logic.js, so it rounds half up like Math.round (Python's round()
    goes to the even number and would disagree with the tablet on a .5).
    """
    if not isinstance(seconds, int) or isinstance(seconds, bool) or seconds <= 0:
        return None
    return max(0, int((words - errors) / seconds * 60 + 0.5))


# -------------------------------------------------------------------- content

class Content:
    """Loads content/subjects.json and content/decks/*.json into one bundle.

    Re-checks file timestamps on each request, so editing a deck on the Pi
    shows up on the next page load without restarting the service.
    """

    def __init__(self, directory: Path, log=print):
        self.dir = directory
        self.log = log
        self._lock = threading.Lock()
        self._sig = None
        self.cards: dict[str, tuple[str, str, dict]] = {}   # card id -> (deck id, deck kind, card)
        self.decks: dict[str, dict] = {}
        self.order: list[str] = []                          # deck ids as the bundle lists them (the child's order)
        self.body = b"{}"
        self.gz = gzip.compress(self.body)
        self.etag = '"empty"'
        self.refresh()

    def _files(self) -> list[Path]:
        decks_dir = self.dir / "decks"
        decks = sorted(decks_dir.glob("*.json")) if decks_dir.is_dir() else []
        return [self.dir / "subjects.json", *decks]

    def _signature(self):
        sig = []
        for p in self._files():
            try:
                st = p.stat()
                sig.append((p.name, st.st_mtime_ns, st.st_size))
            except OSError:
                sig.append((p.name, 0, 0))
        return tuple(sig)

    def refresh(self) -> None:
        sig = self._signature()
        with self._lock:
            if sig == self._sig:
                return
            subjects, decks, cards, deck_map = [], [], {}, {}
            files = self._files()
            try:
                subjects = json.loads(files[0].read_text(encoding="utf-8"))
                if not isinstance(subjects, list):
                    raise ValueError("subjects.json must be a list")
            except (OSError, ValueError) as e:
                self.log(f"content: cannot read subjects.json: {e}")
                subjects = []
            subject_order = {s.get("id"): i for i, s in enumerate(subjects) if isinstance(s, dict)}
            for path in files[1:]:
                try:
                    deck = json.loads(path.read_text(encoding="utf-8"))
                    self._check_deck(deck, subject_order, deck_map, cards)
                except (OSError, ValueError, KeyError, TypeError) as e:
                    # One bad file must not take the whole app down.
                    self.log(f"content: skipping {path.name}: {e}")
                    continue
                decks.append(deck)
                deck_map[deck["id"]] = deck
                for card in deck["cards"]:
                    cards[card["id"]] = (deck["id"], deck["kind"], card)
            decks.sort(key=lambda d: (subject_order.get(d["subject"], 999), d.get("order", 999), d["id"]))
            payload = {"subjects": subjects, "decks": decks}
            raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            version = hashlib.sha256(raw).hexdigest()[:16]
            payload = {"version": version, **payload}
            self.body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            self.gz = gzip.compress(self.body, 6)
            self.etag = f'"{version}"'
            self.cards = cards
            self.decks = deck_map
            self.order = [d["id"] for d in decks]
            self._sig = sig
            self.log(f"content: {len(decks)} decks, {len(cards)} cards (version {version})")

    @staticmethod
    def _check_deck(deck, subject_order, deck_map, cards) -> None:
        if not isinstance(deck, dict):
            raise ValueError("deck must be an object")
        deck_id = deck["id"]
        if not isinstance(deck_id, str) or not deck_id:
            raise ValueError("deck id must be text")
        if deck_id in deck_map:
            raise ValueError(f"duplicate deck id {deck_id}")
        if deck["subject"] not in subject_order:
            raise ValueError(f"unknown subject {deck['subject']!r}")
        if deck["kind"] not in ("read", "qa"):
            raise ValueError(f"unknown kind {deck['kind']!r}")
        order = deck.get("order")
        if order is not None and (isinstance(order, bool) or not isinstance(order, int)):
            # A string order would later blow up the int-vs-str sort and take the whole app down.
            raise ValueError("order must be a whole number")
        if not isinstance(deck["cards"], list) or not deck["cards"]:
            raise ValueError("deck has no cards")
        if "passage" in deck:
            # A story the child reads before the cards (any kind). The reader and the reading routes
            # trust passage.text to be there, so a deck with a broken one is left out of the bundle.
            passage = deck["passage"]
            if not isinstance(passage, dict) or not isinstance(passage.get("text"), str) or not passage["text"].strip():
                raise ValueError("passage must be an object with a 'text'")
        seen = set()
        for card in deck["cards"]:
            cid = card["id"]
            if not isinstance(cid, str) or not cid:
                raise ValueError("card id must be text")
            if cid in cards or cid in seen:
                raise ValueError(f"duplicate card id {cid}")
            seen.add(cid)
            if not card_answer(card, deck["kind"]):
                raise ValueError(f"card {cid} has no answer")


# ------------------------------------------------------------------- database

class DB:
    """One SQLite connection shared by all request threads behind a lock."""

    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.RLock()
        self.conn = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        # WAL + NORMAL is crash-safe and far gentler on an SD card than the default.
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.execute("PRAGMA busy_timeout=5000")
        with self.tx() as c:
            # executescript() would commit behind our back, so run the statements one by one.
            for statement in SCHEMA.split(";"):
                if statement.strip():
                    c.execute(statement)
            if c.execute("SELECT COUNT(*) FROM profiles").fetchone()[0] == 0:
                c.execute("INSERT INTO profiles(name, avatar, created_at) VALUES('', '🦊', ?)", (now_ms(),))

    @contextmanager
    def tx(self):
        with self.lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                yield self.conn
            except BaseException:
                self.conn.execute("ROLLBACK")
                raise
            else:
                self.conn.execute("COMMIT")

    def read(self, sql: str, args=()) -> list[sqlite3.Row]:
        with self.lock:
            return self.conn.execute(sql, args).fetchall()

    def get_setting(self, key: str, default=None):
        rows = self.read("SELECT value FROM settings WHERE key=?", (key,))
        return json.loads(rows[0][0]) if rows else default

    def set_setting(self, key: str, value) -> None:
        with self.tx() as c:
            if value is None:
                c.execute("DELETE FROM settings WHERE key=?", (key,))
            else:
                c.execute(
                    "INSERT INTO settings(key, value) VALUES(?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (key, json.dumps(value)),
                )

    def backup_to(self, target: Path) -> None:
        with self.lock:
            dest = sqlite3.connect(str(target))
            try:
                self.conn.backup(dest)
            finally:
                dest.close()

    def close(self) -> None:
        with self.lock:
            try:
                self.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            except sqlite3.Error:
                pass
            self.conn.close()


# ---------------------------------------------------------------- parent lock

class ParentLock:
    """Optional PIN for the grown-up area.

    With no PIN set, grown-up actions are open and the web app shows a simple
    question a six-year-old cannot answer. With a PIN set, the server itself
    refuses grown-up actions without a token from /api/parent/unlock.
    """

    IDLE_MS = 30 * 60 * 1000
    MAX_AGE_MS = 12 * 60 * 60 * 1000
    PBKDF2_ROUNDS = 120_000

    def __init__(self, db: DB):
        self.db = db
        self._lock = threading.Lock()
        self._tokens: dict[str, tuple[int, int]] = {}   # token -> (issued, last used)
        self._fails = 0
        self._locked_until = 0

    def pin_is_set(self) -> bool:
        return self.db.get_setting("pin") is not None

    def set_pin(self, pin: str | None) -> None:
        if pin is None:
            self.db.set_setting("pin", None)
        else:
            salt = secrets.token_bytes(16)
            digest = hashlib.pbkdf2_hmac("sha256", pin.encode(), salt, self.PBKDF2_ROUNDS)
            self.db.set_setting("pin", {"salt": salt.hex(), "hash": digest.hex(), "rounds": self.PBKDF2_ROUNDS})
        with self._lock:
            self._tokens.clear()
            self._fails = 0
            self._locked_until = 0

    def unlock(self, pin: str) -> str:
        """Return a fresh token, or raise ApiError. Wrong guesses back off: 5 free, then a growing wait."""
        with self._lock:
            wait = self._locked_until - now_ms()
            if wait > 0:
                raise ApiError(429, f"Too many tries. Wait {wait // 1000 + 1} seconds.")
        stored = self.db.get_setting("pin")
        if stored is None:
            raise ApiError(400, "No PIN is set")
        digest = hashlib.pbkdf2_hmac("sha256", pin.encode(), bytes.fromhex(stored["salt"]), int(stored["rounds"]))
        good = hmac.compare_digest(digest, bytes.fromhex(stored["hash"]))
        with self._lock:
            if not good:
                self._fails += 1
                if self._fails >= 5:
                    self._locked_until = now_ms() + min(15 * 60, 30 * 2 ** (self._fails - 5)) * 1000
                raise ApiError(403, "That PIN is not right")
            self._fails = 0
            return self._issue()

    def _issue(self) -> str:
        t = now_ms()
        for tok in [k for k, (issued, used) in self._tokens.items()
                    if t - used > self.IDLE_MS or t - issued > self.MAX_AGE_MS]:
            del self._tokens[tok]
        token = secrets.token_urlsafe(32)
        self._tokens[token] = (t, t)
        return token

    def issue(self) -> str:
        with self._lock:
            return self._issue()

    def allows(self, token: str | None) -> bool:
        if not self.pin_is_set():
            return True
        if not token:
            return False
        t = now_ms()
        with self._lock:
            entry = self._tokens.get(token)
            if not entry:
                return False
            issued, used = entry
            if t - used > self.IDLE_MS or t - issued > self.MAX_AGE_MS:
                del self._tokens[token]
                return False
            self._tokens[token] = (issued, t)
            return True


# ----------------------------------------------------------------- tutor (LLM)

TUTOR_SYSTEM = (
    "You are a kind, patient helper for a six-year-old in first grade who is practising with flashcards. "
    "Reply in one or two short, simple sentences, under 35 words, using words a six-year-old knows. "
    "Give a hint or a strategy, not the answer, unless the card says the answer was already shown; then you may say it. "
    "For reading a word, help sound it out: say the sounds in order, then blend them. "
    "For math, suggest fingers, counting on from the bigger number, or making ten. "
    "Praise effort. Stay on the card. Never mention being an AI or a computer, never ask for personal details, "
    "never talk about anything else, and never use scary or unkind words."
)


class Tutor:
    """Optional 'help' button backed by a local OpenAI-compatible server (Ollama, LM Studio, llama.cpp).

    Nothing leaves the house: the Pi talks to the model over the LAN, the tablet only talks to the Pi.
    Disabled unless --llm-url is given.
    """

    MIN_GAP_S = 2.0
    TIMEOUT_S = 25

    def __init__(self, url: str | None, model: str | None, key: str | None = None):
        self.url = url.rstrip("/") if url else None
        self.model = model or ""
        self.key = key or ""
        self._lock = threading.Lock()
        self._last = 0.0

    @property
    def enabled(self) -> bool:
        return bool(self.url)

    def ask(self, context: dict) -> str:
        if not self.enabled:
            raise ApiError(503, "The helper is not set up")
        with self._lock:
            gap = time.monotonic() - self._last
            if gap < self.MIN_GAP_S:
                raise ApiError(429, "One moment")
            self._last = time.monotonic()
        lines = [f"Subject: {context['subject']}", f"Deck: {context['deck']}"]
        if context["kind"] == "read":
            lines.append(f"The child is reading the word or sentence: \"{context['prompt']}\"")
        else:
            lines.append(f"Question: {context['prompt']}")
            lines.append(f"Right answer (do not reveal unless shown): {context['answer']}")
        if context.get("choices"):
            lines.append("Answer choices: " + ", ".join(context["choices"]))
        if context.get("chosen"):
            lines.append(f"The child picked: {context['chosen']} (wrong)")
        lines.append("The answer was already shown to the child." if context.get("revealed")
                     else "The answer has not been shown yet.")
        if context.get("said"):
            lines.append(f"The child asked: \"{context['said']}\"")
        payload = {
            "model": self.model,
            "messages": [{"role": "system", "content": TUTOR_SYSTEM}, {"role": "user", "content": "\n".join(lines)}],
            "max_tokens": 90,
            "temperature": 0.4,
            "stream": False,
        }
        headers = {"Content-Type": "application/json"}
        if self.key:
            headers["Authorization"] = f"Bearer {self.key}"
        req = urllib.request.Request(f"{self.url}/chat/completions", data=json.dumps(payload).encode("utf-8"),
                                     headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=self.TIMEOUT_S) as resp:
                data = json.loads(resp.read(200_000).decode("utf-8"))
        except urllib.error.HTTPError as e:
            raise ApiError(502, f"The helper's model said no ({e.code})") from None
        except (urllib.error.URLError, http.client.HTTPException, socket.timeout, TimeoutError, ValueError, OSError):
            raise ApiError(502, "The helper is not answering") from None
        try:
            text = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            raise ApiError(502, "The helper gave a strange reply") from None
        return self.clean(text)

    @staticmethod
    def clean(text: str) -> str:
        """Keep replies short and plain: no markdown, no links, at most two sentences-ish."""
        text = re.sub(r"<think>.*?</think>", "", str(text), flags=re.S | re.I)   # reasoning models
        text = re.sub(r"<think>.*$", "", text, flags=re.S | re.I)                # a reply cut off mid-think
        text = re.sub(r"https?://\S+", "", text)
        text = re.sub(r"[*_`#>\[\]]", "", text)
        text = re.sub(r"\s+", " ", text).strip()
        if len(text) > 320:
            cut = text[:320]
            text = cut[: max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "), 200) + 1].strip() or cut
        return text or "Let's try it together. Look at the card again."


# ---------------------------------------------------------- voices (Piper TTS)

MAX_TTS_CHARS = 300
TTS_RATES = (0.5, 1.5)             # what /api/tts accepts: the span of the two speed sliders in Settings
READ_RATE = 0.7                    # the story voice's default pace (readRate in web/js/store.js)
QUIZ_RATE = 0.85                   # the quiz voice's default pace (speechRate)
VOICE_ID_RE = re.compile(r"^[A-Za-z0-9_.-]+$")
VOICE_NAMES = {"en_US-amy-medium": "Amy", "en_US-ryan-medium": "Ryan", "en_US-lessac-medium": "Lessac"}
# What 🔤 Sound it out said for each sound when this was written (the values of SOUNDS in
# web/js/phonics.js). Only the fallback: the live list is parsed out of that file by tts_sound_strings(),
# since those spellings get tuned, and the pre-render must have the sounds the tablet asks for.
SOUND_STRINGS = ("buh kuh duh fff guh huh juh lll mmm nnn puh kwuh rrr sss tuh vvv wuh ks yuh zzz "
                 "shh chuh thh ng aa eh ih ah uh ay ee eye oh you ow oy aw oo ar or er air ear").split()
MAX_SOUND_CHARS = 4                # a text no longer than this (and without a space) is cut as a sound
# Pictographs outside the symbol blocks that EMOJI in web/js/logic.js also strips: ©, ®, ™, ‼, ⁉, ℹ, 〰,
# the arrows ↔…↙ ↩ ↪ ⤴ ⤵, the emoji variation selector and the keycap mark, and the few emoji that
# Unicode files as maths or punctuation rather than symbols (◻ ◼ ◽ ◾ ♯ 〽).
_PICTO_EXTRA = frozenset({0x00A9, 0x00AE, 0x2122, 0x203C, 0x2049, 0x2139, 0x3030, 0xFE0F, 0x20E3,
                          0x21A9, 0x21AA, 0x2934, 0x2935, *range(0x2194, 0x219A),
                          *range(0x25FB, 0x25FF), 0x266F, 0x303D})


def _spoken(ch: str) -> bool:
    """May this character reach the voice? Emoji, pictographs and control characters may not.

    The tablet strips emoji before it asks (EMOJI in logic.js, a \\p{Extended_Pictographic} class that
    re cannot spell). This errs on the side of stripping more, which is the safe side: a clip the
    pre-render made from the raw card text must land on the same cache key as the tablet's request.
    """
    cp = ord(ch)
    if cp in _PICTO_EXTRA or 0x1F000 <= cp <= 0x1FAFF or 0x1FC00 <= cp <= 0x1FFFD:
        return False
    cat = unicodedata.category(ch)
    if cat[0] == "C":                          # control, format (the zero-width joiner), surrogates, unassigned
        return False
    return not (cat == "So" and cp >= 0x2190)  # the symbol blocks (☀ ✅ ⭐ ...); ° and ¢ below them stay


def normalize_speech(text) -> str:
    """What the voice is asked to say: no emoji or control characters, one space between words, trimmed.

    The tablet does the same before it asks (ttsUrl in web/js/speech.js), so both sides agree on the
    cache key of a clip.
    """
    kept = [" " if ch.isspace() else ch for ch in str(text or "") if ch.isspace() or _spoken(ch)]
    return re.sub(r" {2,}", " ", "".join(kept)).strip()


def speakable(text) -> str:
    """Card text as the tablet's voice says it: no emoji, maths symbols as words.

    Mirrors speakable() in web/js/logic.js; change them together, since the pre-render relies on
    saying exactly what the tablet will ask for.
    """
    s = normalize_speech(text)
    s = re.sub(r"_{2,}", " blank ", s)
    s = re.sub(r"\s*\+\s*", " plus ", s)
    s = re.sub(r"\s*−\s*", " minus ", s)
    s = re.sub(r"([0-9])\s*-\s*(?=[0-9])", r"\1 minus ", s)
    s = re.sub(r"\s*=\s*\?", " equals what", s)
    s = re.sub(r"\s*=\s*", " equals ", s)
    s = re.sub(r"\s*>\s*", " is greater than ", s)
    s = re.sub(r"\s*<\s*", " is less than ", s)
    s = re.sub(r"\s*¢", " cents", s)
    return re.sub(r"\s{2,}", " ", s).strip()


def clamp_rate(rate) -> float:
    """The pace the tablet asked for, held to 0.5-1.5 and rounded to the 0.05 steps of its sliders, so
    1.0 and 1.01 share one cache folder."""
    try:
        rate = float(rate)
    except (TypeError, ValueError):
        raise ApiError(400, "Bad rate") from None
    if not math.isfinite(rate):
        raise ApiError(400, "Bad rate")
    rate = min(TTS_RATES[1], max(TTS_RATES[0], rate))
    # Half-way values round up, as Math.round does in ttsUrl on the tablet (0.725 -> 0.75), so both
    # sides name the same cache folder; Python's own round() would send them to the even step.
    return round(math.floor(rate * 20 + 0.5) / 20, 2)


# Just enough JavaScript to read the sound tables out of web/js/phonics.js: string literals (kept whole,
# so a // or a } inside one cannot mislead), comments (blanked), and `key: 'value'` pairs with the key
# bare or quoted.
_JS_QUOTED = r"'(?:[^'\\\n]|\\.)*'|\"(?:[^\"\\\n]|\\.)*\""
_JS_STRING = re.compile(_JS_QUOTED + r"|`(?:[^`\\]|\\.)*`", re.S)
_JS_COMMENT_OR_STRING = re.compile(r"//[^\n]*|/\*.*?\*/|" + _JS_STRING.pattern, re.S)
_JS_PAIR = re.compile(r"(?<![\w$'\"`])(?:[A-Za-z_$][\w$]*|" + _JS_QUOTED + r")\s*:\s*(" + _JS_QUOTED + r")")
_JS_TABLE = re.compile(r"\b(?:export\s+)?(?:const|let|var)\s+(SOUNDS|SOUNDS_PI)\s*=\s*\{")
_JS_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "0": "\0"}


def _js_string(token: str) -> str:
    """The text of a quoted JavaScript literal: 'it\\'s' -> it's (the common escapes only)."""
    return re.sub(r"\\(.)", lambda m: _JS_ESCAPES.get(m.group(1), m.group(1)), token[1:-1], flags=re.S)


def _js_object_body(src: str, start: int) -> str:
    """src[start] is a '{': the text up to its matching '}' (braces inside strings do not count)."""
    depth, i = 0, start
    while i < len(src):
        ch = src[i]
        if ch in "'\"`":
            m = _JS_STRING.match(src, i)
            i = m.end() if m else i + 1
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return src[start + 1:i]
        i += 1
    return src[start + 1:]                              # never closed: take what is there


def parse_sound_strings(source: str) -> list[str]:
    """The values of the SOUNDS and SOUNDS_PI tables in the source of web/js/phonics.js, in order and
    each once, as the voice gets them: every quoted string on the right of a key inside
    `export const SOUNDS = { ... };` (keys bare or quoted; comments, nesting and trailing commas do not
    matter; either table may be missing). An empty list when neither table is there."""
    src = _JS_COMMENT_OR_STRING.sub(lambda m: " " if m.group(0)[0] == "/" else m.group(0), source)
    out: list[str] = []
    for table in _JS_TABLE.finditer(src):
        for pair in _JS_PAIR.finditer(_js_object_body(src, table.end() - 1)):
            text = normalize_speech(_js_string(pair.group(1)))
            if text and text not in out:
                out.append(text)
    return out


def tts_sound_strings(web_dir, log=print) -> list[str]:
    """What 🔤 Sound it out can ask the voice for: the SOUNDS (and SOUNDS_PI) values parsed out of
    <web_dir>/js/phonics.js. The built-in SOUND_STRINGS when the file cannot be read or holds no table,
    so the pre-render still has sounds ready; either way the count is logged."""
    path = Path(web_dir) / "js" / "phonics.js"
    try:
        found = parse_sound_strings(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        log(f"tts: cannot read {path} ({e}): using the built-in {len(SOUND_STRINGS)} sounds")
        return list(SOUND_STRINGS)
    if not found:
        log(f"tts: no SOUNDS table in {path}: using the built-in {len(SOUND_STRINGS)} sounds")
        return list(SOUND_STRINGS)
    log(f"tts: {len(found)} sounds from {path.name}")
    return found


class SoundStrings:
    """The sounds 🔤 Sound it out says, from web/js/phonics.js, re-read when that file changes (as Content
    re-reads the decks): a sound's clip is cut differently from a word's, and the pre-render wants every
    sound ready, so the server must know the tablet's current spellings, not a copy of its own.

    strings is the list in the file's order; `text in sounds` asks whether a (normalized) text is one of
    them; etag changes when the list does.
    """

    def __init__(self, web_dir, log=print):
        self.web_dir = Path(web_dir)
        self.path = self.web_dir / "js" / "phonics.js"
        self.log = log
        self._lock = threading.Lock()
        self._sig = None
        self._loaded = False
        self.strings: tuple[str, ...] = ()
        self._set: frozenset[str] = frozenset()
        self.etag = ""
        self.refresh()

    def _signature(self):
        try:
            st = self.path.stat()
            return (st.st_mtime_ns, st.st_size)
        except OSError:
            return None

    def refresh(self) -> None:
        sig = self._signature()
        with self._lock:
            if self._loaded and sig == self._sig:
                return
            strings = tuple(tts_sound_strings(self.web_dir, log=self.log))
            self.strings = strings
            self._set = frozenset(strings)
            self.etag = hashlib.sha1("\n".join(strings).encode("utf-8")).hexdigest()[:12]
            self._sig = sig
            self._loaded = True

    def __contains__(self, text) -> bool:
        self.refresh()
        return text in self._set


def tts_corpus(content: Content, what: str = "all", read_rate: float = READ_RATE,
               quiz_rate: float = QUIZ_RATE, sounds=None) -> list[tuple[str, float]]:
    """Everything the tablet will ask the voice for, in the order worth having ready: the stories first
    (each line of each page as Read to me says it, every word as a tap says it, the sounds 🔤 Sound it
    out uses), then every question (what == "all"). Distinct (text, rate) pairs, text as the voice gets it.

    sounds is what 🔤 Sound it out says (SoundStrings.strings, parsed from web/js/phonics.js); None means
    the built-in SOUND_STRINGS. The Tts that renders the list must hold the same SoundStrings, so it cuts
    those as sounds (Tts.is_sound) and the tablet's request lands on the clip.
    """
    from tools.decodability import pages as passage_pages, word_tokens   # the word rule shared with logic.js
    if what not in ("stories", "all"):
        raise ValueError("what must be 'stories' or 'all'")
    seen: set[tuple[str, float]] = set()
    out: list[tuple[str, float]] = []

    def add(text, rate: float) -> None:
        text = normalize_speech(text)
        if text and len(text) <= MAX_TTS_CHARS and (text, rate) not in seen:
            seen.add((text, rate))
            out.append((text, rate))

    decks = [content.decks[d] for d in content.order if d in content.decks]
    sound_strings = SOUND_STRINGS if sounds is None else tuple(sounds)
    sounds_added = False
    for deck in decks:
        passage = deck.get("passage")
        if not isinstance(passage, dict) or not isinstance(passage.get("text"), str):
            continue
        for page in passage_pages(passage["text"]):
            for line in page.split("\n"):
                if line.strip():
                    add(re.sub(r'["“”]', "", line), read_rate)     # Read to me drops the quote marks (reader.js)
        for token in word_tokens(passage["text"]):
            add(token, read_rate)                                   # a tapped word, as written (Max's, Hi)
        if not sounds_added:                                        # right after the first story, before more
            for sound in sound_strings:
                add(sound, read_rate)
            sounds_added = True
    if what == "all":
        for deck in decks:
            if deck.get("kind") != "qa":
                continue
            for card in deck["cards"]:
                add(card.get("sayQ") or speakable(card.get("q", "")), quiz_rate)   # sayPrompt() in logic.js
    return out


class Tts:
    """Optional natural voice: Piper (rhasspy/piper) on the Pi turns text into WAV clips the tablet plays.

    Like the Tutor, nothing leaves the house and the app works without it. Every clip is kept under
    cache_dir, so a line is rendered once; the pre-render fills the cache ahead of the child. Off unless
    a piper command is given (or found at <data_dir>/piper/piper/piper) and a voice sits in voices_dir.
    """

    TIMEOUT_S = 30
    MAX_RENDERS = 2             # piper processes at once: a Pi has few cores and the service little memory
    LOG_EVERY = 200             # pre-render progress lines
    CHECK_EVERY = 50            # pre-render items between looks at whether the content changed
    LOCK_STALE_S = 600          # a pre-render lock nobody has touched for this long belongs to a dead run

    def __init__(self, cmd, voices_dir, cache_dir, log=print, default_voice: str = "en_US-amy-medium",
                 sounds=None):
        self.cmd = [str(c) for c in cmd] if cmd else None
        self.voices_dir = Path(voices_dir) if voices_dir else None
        self.cache_dir = Path(cache_dir)
        self.log = log
        self.wanted = default_voice
        self.sounds = sounds                    # a SoundStrings: what 🔤 Sound it out says (App wires its own)
        # piper finds espeak-ng-data next to its binary; running from there keeps a relative --model happy too.
        self.cwd = None
        if self.cmd and os.path.isabs(self.cmd[0]) and Path(self.cmd[0]).parent.is_dir():
            self.cwd = str(Path(self.cmd[0]).parent)
        self._voices: dict[str, Path] = {}      # voice id -> its .onnx
        self._scanned = False
        self._stamp = None                      # the voices folder's mtime at the last scan
        self._lock = threading.Lock()
        self._cond = threading.Condition(self._lock)
        self._busy: set[str] = set()            # clips being rendered right now
        self._slots = threading.Semaphore(self.MAX_RENDERS)
        self._lockfile: Path | None = None
        self._scan()

    # -- the voices

    def _scan(self) -> None:
        """(Re)read the voices folder when it changed, so a voice dropped in later needs no restart."""
        if not self.cmd or not self.voices_dir:
            return
        try:
            stamp = self.voices_dir.stat().st_mtime_ns
        except OSError:
            stamp = None
        with self._lock:
            if self._scanned and stamp == self._stamp:
                return
            found: dict[str, Path] = {}
            if stamp is not None:
                for onnx in sorted(self.voices_dir.glob("*.onnx")):
                    voice_id = onnx.name[:-5]
                    if not VOICE_ID_RE.match(voice_id):
                        continue
                    if not onnx.with_name(onnx.name + ".json").is_file():
                        self.log(f"tts: {onnx.name} has no .onnx.json next to it, skipped")
                        continue
                    found[voice_id] = onnx
            if found != self._voices or not self._scanned:
                self.log(f"tts: {len(found)} voices in {self.voices_dir}: {', '.join(found) or 'none'}")
            self._voices = found
            self._stamp = stamp
            self._scanned = True

    @property
    def enabled(self) -> bool:
        self._scan()
        return bool(self.cmd and self._voices)

    @property
    def default_voice(self) -> str | None:
        """The voice the tablet gets unless it asks for another: the one asked for, else the first found."""
        if not self.enabled:
            return None
        return self.wanted if self.wanted in self._voices else next(iter(self._voices))

    def voices(self) -> list[dict]:
        if not self.enabled:
            return []
        return [self.describe(voice_id) for voice_id in self._voices]

    @staticmethod
    def describe(voice_id: str) -> dict:
        """en_US-amy-medium -> Amy, en-US. Unknown voices are named after the middle of their id."""
        parts = voice_id.split("-")
        name = VOICE_NAMES.get(voice_id) or (parts[1] if len(parts) >= 2 else voice_id).replace("_", " ").title()
        lang = parts[0].replace("_", "-") if len(parts) >= 2 else "en"
        return {"id": voice_id, "name": name, "lang": lang, "quality": "natural"}

    # -- making clips

    def is_sound(self, text: str) -> bool:
        """Is this (normalized) text a sound from 🔤 Sound it out rather than a word or a line? Yes for one
        of the tablet's sound strings, and for anything as short as one (at most MAX_SOUND_CHARS, no
        space): a sound is cut without the pause piper leaves after a sentence, so it does not drag."""
        if len(text) <= MAX_SOUND_CHARS and " " not in text:
            return True
        return self.sounds is not None and text in self.sounds

    def clip_path(self, text, voice_id, rate, sound=None) -> tuple[Path, str, float, bool]:
        """Where the clip for this text lives (made or not), with the text and pace as the voice gets them
        and whether it is cut as a sound (sound=True says so; None leaves it to is_sound()). A sound's clip
        has its own folder, <pace>-snd, so it is never served for the same text asked for as a word, nor
        the other way round. Raises ApiError for what the voice cannot do: no voice at all, nothing to say,
        too much, no such voice."""
        if not self.enabled:
            raise ApiError(503, "No voice on the Pi")
        text = normalize_speech(text)
        if not text:
            raise ApiError(400, "Nothing to say")
        if len(text) > MAX_TTS_CHARS:
            raise ApiError(400, f"At most {MAX_TTS_CHARS} characters at a time")
        if not isinstance(voice_id, str) or not VOICE_ID_RE.match(voice_id) or voice_id not in self._voices:
            raise ApiError(404, "No such voice")
        rate = clamp_rate(rate)
        sound = self.is_sound(text) if sound is None else bool(sound)
        digest = hashlib.sha1(text.encode("utf-8")).hexdigest()
        folder = f"{rate:.2f}-snd" if sound else f"{rate:.2f}"
        return self.cache_dir / voice_id / folder / f"{digest}.wav", text, rate, sound

    def render(self, text, voice_id, rate, sound=None) -> Path:
        """The WAV clip for this text: from the cache, or made now by piper. At most MAX_RENDERS run at
        once, and two requests for the same clip share one render. sound as in clip_path()."""
        path, text, rate, sound = self.clip_path(text, voice_id, rate, sound)
        if path.is_file():
            return path
        key = str(path)
        with self._cond:
            while key in self._busy:
                self._cond.wait()
            if path.is_file():
                return path
            self._busy.add(key)
        try:
            with self._slots:
                onnx = self._voices.get(voice_id)
                if onnx is None:                    # removed from the folder while we waited for a slot
                    raise ApiError(404, "No such voice")
                if not path.is_file():
                    self._run(text, onnx, rate, path, sound)
        finally:
            with self._cond:
                self._busy.discard(key)
                self._cond.notify_all()
        return path

    def _run(self, text: str, onnx: Path, rate: float, path: Path, sound: bool = False) -> None:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
        except OSError as e:                    # a read-only or missing cache folder: a plain 500, not a traceback
            self.log(f"tts: cannot write {path.parent}: {e}")
            raise ApiError(500, "The voice could not start") from None
        # Written next to its final name and renamed when whole, so a reader never sees half a clip.
        tmp = path.with_name(f".{path.stem}.{os.getpid()}-{threading.get_ident()}.tmp")
        # A sound gets no pause after it (0.2 s makes "buh ... kuh ... duh" drag); a line keeps one.
        args = [*self.cmd, "--model", str(onnx), "--output_file", str(tmp),
                "--length_scale", f"{1 / rate:.3f}", "--sentence_silence", "0" if sound else "0.2"]
        try:
            proc = subprocess.run(args, input=(text + "\n").encode("utf-8"), capture_output=True,
                                  timeout=self.TIMEOUT_S, cwd=self.cwd)
        except subprocess.TimeoutExpired:
            self._discard(tmp)
            self.log(f"tts: piper took more than {self.TIMEOUT_S}s on {text[:40]!r}")
            raise ApiError(504, "The voice took too long") from None
        except OSError as e:
            self._discard(tmp)
            self.log(f"tts: cannot run {self.cmd[0]}: {e}")
            raise ApiError(500, "The voice could not start") from None
        if proc.returncode != 0 or not tmp.is_file() or tmp.stat().st_size <= 44:
            err = proc.stderr.decode("utf-8", "replace").strip().splitlines()
            self.log(f"tts: piper failed (exit {proc.returncode}) on {text[:40]!r}: {err[-1] if err else 'no output'}")
            self._discard(tmp)
            raise ApiError(500, "The voice failed")
        tmp.replace(path)

    @staticmethod
    def _discard(tmp: Path) -> None:
        try:
            tmp.unlink()
        except OSError:
            pass

    # -- filling the cache ahead of time

    def prerender(self, items, voice_id: str | None = None, pause: float = 0.25, stop=None, changed=None) -> dict:
        """Make every (text, rate) in items that is not cached yet, one at a time and unhurried: a pause
        after each render, a progress line every LOG_EVERY items. Ends early when stop (an Event) is set
        or changed() says the content moved on. Returns the counts; "stopped" says why it ended early."""
        items = list(items)
        voice_id = voice_id or self.default_voice
        counts = {"items": len(items), "made": 0, "cached": 0, "failed": 0, "stopped": None}
        if not self.enabled or not voice_id:
            counts["stopped"] = "off"
            return counts
        if not self._claim():
            self.log("tts: pre-render: another run is at it (prerender.lock), leaving it to that one")
            counts["stopped"] = "busy"
            return counts
        self.log(f"tts: pre-render: {len(items)} clips to check for {voice_id}")
        touched = time.monotonic()
        try:
            for n, (text, rate) in enumerate(items, 1):
                if stop is not None and stop.is_set():
                    counts["stopped"] = "stop"
                    break
                if changed is not None and n % self.CHECK_EVERY == 0 and changed():
                    counts["stopped"] = "changed"
                    break
                try:
                    path, _, _, _ = self.clip_path(text, voice_id, rate)
                    if path.is_file():
                        counts["cached"] += 1
                    else:
                        self.render(text, voice_id, rate)
                        counts["made"] += 1
                        if pause:
                            if stop is not None:
                                stop.wait(pause)
                            else:
                                time.sleep(pause)
                except ApiError as e:
                    counts["failed"] += 1
                    if counts["failed"] <= 5:
                        self.log(f"tts: pre-render: {text[:40]!r}: {e.message}")
                    if e.status == 503:                 # the voices went away: nothing more can be made
                        counts["stopped"] = "off"
                        break
                if n % self.LOG_EVERY == 0:
                    self.log(f"tts: pre-render: {n}/{len(items)}, {counts['made']} made, "
                             f"{counts['cached']} were there, {counts['failed']} failed")
                if time.monotonic() - touched > 30:
                    self._touch()
                    touched = time.monotonic()
        finally:
            self._release()
        why = f"stopped ({counts['stopped']})" if counts["stopped"] else "done"
        self.log(f"tts: pre-render {why}: {counts['made']} made, {counts['cached']} were there, "
                 f"{counts['failed']} failed")
        return counts

    def _claim(self) -> bool:
        """Take the pre-render lock file: one renderer at a time across processes (the service's thread
        and tools/prerender_tts.py may both start after an install). A lock whose run is gone, or that
        nobody has touched for LOCK_STALE_S, belongs to a dead run and is taken over."""
        lock = self.cache_dir / "prerender.lock"
        for _ in (1, 2):
            try:
                self.cache_dir.mkdir(parents=True, exist_ok=True)
                fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
            except FileExistsError:
                if self._lock_is_live(lock):
                    return False
                try:
                    lock.unlink()
                except OSError:
                    return False
                continue
            except OSError as e:
                self.log(f"tts: pre-render: cannot write {lock}: {e}")
                return False
            with os.fdopen(fd, "w") as f:
                f.write(f"{os.getpid()}\n")
            self._lockfile = lock
            return True
        return False

    def _lock_is_live(self, lock: Path) -> bool:
        """Is the run that wrote this lock still going? Its pid is asked (not on Windows); a run that is
        alive but stuck is given up on once the lock goes untouched for LOCK_STALE_S (a working run
        touches it every half minute)."""
        try:
            age = time.time() - lock.stat().st_mtime
        except OSError:
            return False                                    # it vanished: the run is over
        try:
            pid = int(lock.read_text(encoding="utf-8").strip())
        except (OSError, ValueError):
            pid = 0
        if pid and os.name != "nt":
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return False                                # that run is gone (a restart mid-render)
            except OSError:
                pass                                        # there, but not ours to signal: alive
        return age < self.LOCK_STALE_S

    def _touch(self) -> None:
        if self._lockfile:
            try:
                os.utime(self._lockfile)
            except OSError:
                pass

    def _release(self) -> None:
        if self._lockfile:
            self._discard(self._lockfile)
            self._lockfile = None


def find_tts(data_dir: Path, cmd: str | None = None, voices=None, cache=None,
             default_voice: str = "en_US-amy-medium", log=print, sounds=None) -> Tts:
    """A Tts from the flags or environment, else from what deploy/install-voices.sh puts under data_dir:
    piper/piper/piper, piper/voices/, and the clip cache in tts/. sounds is its SoundStrings (the App
    gives it one when None)."""
    command = shlex.split(cmd, posix=os.name != "nt") if cmd else None
    if command and os.name == "nt":
        command = [c[1:-1] if len(c) > 1 and c[0] == c[-1] == '"' else c for c in command]   # "C:\Program Files\..."
    if command is None:
        found = Path(data_dir) / "piper" / "piper" / "piper"
        if found.is_file():
            command = [str(found)]
    return Tts(command, Path(voices) if voices else Path(data_dir) / "piper" / "voices",
               Path(cache) if cache else Path(data_dir) / "tts", log=log, default_voice=default_voice,
               sounds=sounds)


# ------------------------------------------------------------------------ app

class FileReply:
    """What a handler returns to send a file instead of JSON (a voice clip): Handler._api streams it
    with the ETag and cache rule given, and answers HEAD and If-None-Match for it."""

    def __init__(self, path: Path, ctype: str, etag: str, cache: str):
        self.path = path
        self.ctype = ctype
        self.etag = etag
        self.cache = cache


class Request:
    def __init__(self, method: str, path: str, query: dict, body: dict, token: str | None):
        self.method = method
        self.path = path
        self.query = query
        self.body = body
        self.token = token
        self.args: tuple = ()

    def q_int(self, key: str, lo: int, hi: int, default=None) -> int:
        vals = self.query.get(key)
        if not vals:
            if default is None:
                raise ApiError(400, f"Missing '{key}'")
            return default
        try:
            val = int(vals[0])
        except ValueError:
            raise ApiError(400, f"'{key}' must be a whole number") from None
        if val < lo or val > hi:
            raise ApiError(400, f"'{key}' must be between {lo} and {hi}")
        return val


class App:
    def __init__(self, data_dir: Path, web_dir: Path, content_dir: Path, allow_hosts=(), log=print, tutor=None,
                 tts=None):
        self.log = log
        self.web_dir = web_dir.resolve()
        self.data_dir = data_dir
        data_dir.mkdir(parents=True, exist_ok=True)
        self.db = DB(data_dir / "starcards.db")
        self.content = Content(content_dir, log=log)
        self.parent = ParentLock(self.db)
        self.tutor = tutor or Tutor(None, None)
        self.sounds = SoundStrings(self.web_dir, log=log)      # what 🔤 Sound it out says (web/js/phonics.js)
        self.tts = tts or Tts(None, None, data_dir / "tts", log=log)
        if self.tts.sounds is None:
            self.tts.sounds = self.sounds
        self.allow_hosts = {h.lower() for h in allow_hosts}
        try:
            self.allow_hosts.add(socket.gethostname().lower())
        except OSError:
            pass
        self._gz_cache: dict[tuple, bytes] = {}
        #        method  pattern                                  handler               grown-up only
        self.routes = [
            ("GET", r"/api/ping", self.h_ping, False),
            ("GET", r"/api/voices", self.h_voices, False),
            ("GET", r"/api/tts", self.h_tts, False),
            ("GET", r"/api/profiles", self.h_profiles, False),
            ("GET", r"/api/state", self.h_state, False),
            ("GET", r"/api/report", self.h_report, False),
            ("GET", r"/api/decks/([\w.-]+)/report", self.h_deck_report, False),
            ("GET", r"/api/reading/report", self.h_reading_report, False),
            ("GET", r"/api/tests", self.h_tests, False),
            ("GET", r"/api/tests/(\d+)", self.h_test_get, False),
            ("POST", r"/api/attempts", self.h_attempts, False),
            ("POST", r"/api/rounds", self.h_rounds, False),
            ("POST", r"/api/reads", self.h_reads, False),
            ("PUT", r"/api/books/([\w.-]+)", self.h_book_set, False),
            ("POST", r"/api/tests/(\d+)/finish", self.h_test_finish, False),
            ("POST", r"/api/profiles/(\d+)/avatar", self.h_avatar, False),
            ("POST", r"/api/parent/unlock", self.h_unlock, False),
            ("POST", r"/api/help", self.h_help, False),
            ("POST", r"/api/parent/pin", self.h_pin, True),
            ("POST", r"/api/tests", self.h_test_create, True),
            ("DELETE", r"/api/tests/(\d+)", self.h_test_delete, True),
            ("POST", r"/api/flags", self.h_flag_add, True),
            ("DELETE", r"/api/flags/(\d+)", self.h_flag_delete, True),
            ("POST", r"/api/cards/clear-trouble", self.h_clear_trouble, True),
            ("POST", r"/api/profiles", self.h_profile_create, True),
            ("PUT", r"/api/profiles/(\d+)", self.h_profile_update, True),
            ("DELETE", r"/api/profiles/(\d+)", self.h_profile_delete, True),
            ("POST", r"/api/profiles/(\d+)/reset", self.h_profile_reset, True),
            ("GET", r"/api/export", self.h_export, True),
        ]
        self.routes = [(m, re.compile(p + r"/?$"), h, g) for m, p, h, g in self.routes]
        self.seed_rounds_from_history()

    # -- plumbing

    def host_ok(self, host_header: str) -> bool:
        """Refuse requests aimed at us through a foreign domain name (DNS rebinding).

        Allowed: IP addresses, localhost, single-label names (http://raspberrypi/),
        names under .local / .lan / .home.arpa / .internal, and --allow-host extras.
        """
        host = host_header.strip().lower()
        if not host:
            return False
        if host.startswith("["):                       # [::1]:8080
            host = host[1:].split("]")[0]
        elif host.count(":") == 1:
            host = host.rsplit(":", 1)[0]
        try:
            ipaddress.ip_address(host)
            return True
        except ValueError:
            pass
        if not re.fullmatch(r"[a-z0-9]([a-z0-9.-]*[a-z0-9])?", host):
            return False
        if host == "localhost" or "." not in host or host in self.allow_hosts:
            return True
        return host.endswith((".local", ".lan", ".home", ".home.arpa", ".internal", ".localhost"))

    def route(self, method: str, path: str):
        allowed = False
        for m, pattern, handler, grownup in self.routes:
            match = pattern.match(path)
            if match:
                if m == method:
                    return handler, grownup, match.groups()
                allowed = True
        raise ApiError(405 if allowed else 404, "Method not allowed" if allowed else "Not found")

    def profile_row(self, profile_id: int) -> sqlite3.Row:
        rows = self.db.read("SELECT * FROM profiles WHERE id=?", (profile_id,))
        if not rows:
            raise ApiError(404, "No such profile")
        return rows[0]

    @staticmethod
    def profile_json(row: sqlite3.Row) -> dict:
        try:
            prefs = json.loads(row["prefs"])
        except ValueError:
            prefs = {}
        return {"id": row["id"], "name": row["name"], "avatar": row["avatar"], "prefs": prefs}

    def stars(self, profile_id: int) -> int:
        """Right answers plus stories read: every finished read earns a star, however it went."""
        return self.db.read(
            "SELECT (SELECT COUNT(*) FROM attempts WHERE profile_id=? AND correct=1) + "
            "(SELECT COUNT(*) FROM reads WHERE profile_id=?)", (profile_id, profile_id))[0][0]

    PASS_MARK = 0.85     # a level is passed with 85% or better on a practice round (mirrored in logic.js)
    ROUND_MODES = ("practice", "testout", "learn")   # testout = one round that covers several levels

    def round_summary(self, profile_id: int, deck_id: str | None = None) -> dict:
        """Per deck: the best and latest practice-round scores, so the app can tell a passed level."""
        sql = "SELECT deck_id, total, correct, at FROM rounds WHERE profile_id=? AND mode IN ('practice', 'testout')"
        args: list = [profile_id]
        if deck_id is not None:
            sql += " AND deck_id=?"
            args.append(deck_id)
        out: dict = {}
        for r in self.db.read(sql + " ORDER BY at, id", args):
            score = round(r["correct"] / r["total"], 4) if r["total"] else 0.0
            s = out.setdefault(r["deck_id"], {"best": 0.0, "last": 0.0, "count": 0, "lastAt": 0,
                                               "lastCorrect": 0, "lastTotal": 0})
            s["count"] += 1
            s["best"] = max(s["best"], score)
            s.update(last=score, lastAt=r["at"], lastCorrect=r["correct"], lastTotal=r["total"])
        for s in out.values():
            s["passed"] = s["best"] >= self.PASS_MARK
        return out

    def read_summary(self, profile_id: int, deck_id: str | None = None) -> dict:
        """Per story: how often it was read, the best words-per-minute of the scored reads, the latest read.

        Mirrors readSummary() in web/js/static-api.js and addRead() in web/js/logic.js.
        """
        sql = "SELECT deck_id, mode, words, errors, seconds, wcpm, at FROM reads WHERE profile_id=?"
        args: list = [profile_id]
        if deck_id is not None:
            sql += " AND deck_id=?"
            args.append(deck_id)
        out: dict = {}
        for r in self.db.read(sql + " ORDER BY at, id", args):
            s = out.setdefault(r["deck_id"], {"count": 0, "scored": 0, "best": None, "lastAt": 0, "last": None})
            s["count"] += 1
            if r["mode"] == "scored":
                s["scored"] += 1
                if r["wcpm"] is not None:
                    s["best"] = r["wcpm"] if s["best"] is None else max(s["best"], r["wcpm"])
            s["lastAt"] = r["at"]
            s["last"] = {"mode": r["mode"], "words": r["words"], "errors": r["errors"], "seconds": r["seconds"],
                         "wcpm": r["wcpm"], "at": r["at"]}
        return out

    def books_of(self, profile_id: int) -> dict:
        """Per book a grown-up ticked as read for this child: that it was, and when (the first tick's time).

        Mirrors booksOf() in web/js/static-api.js.
        """
        return {
            r["deck_id"]: {"read": bool(r["read"]), "at": r["at"]}
            for r in self.db.read("SELECT deck_id, read, at FROM books WHERE profile_id=? ORDER BY at, deck_id",
                                  (profile_id,))
        }

    LEGACY_GAP_MS = 20 * 60 * 1000     # answers further apart than this were different sittings

    def seed_rounds_from_history(self) -> None:
        """One-time, on the first start after the pass mark arrived: score the practice the child
        had already done. A sitting on a level that scored 85%+ counts as a passed round; a level
        that never did goes back to square one (its cards return to "new"; answers and stars stay)."""
        if self.db.get_setting("rounds_seeded"):
            return
        if not self.content.decks:
            # No content loaded (missing folder, broken subjects.json): scoring now would credit
            # nothing and could never be redone, so wait for a start that has the decks.
            self.log("rounds: no content loaded, scoring of past practice waits for the next start")
            return
        with self.db.tx() as c:
            if c.execute("SELECT COUNT(*) FROM rounds").fetchone()[0] == 0:
                for row in c.execute("SELECT id FROM profiles").fetchall():
                    self._seed_profile(c, row["id"])
            c.execute("INSERT INTO settings(key, value) VALUES('rounds_seeded', '1') "
                      "ON CONFLICT(key) DO UPDATE SET value=excluded.value")

    def _seed_profile(self, c, pid: int) -> None:
        started = [r["deck_id"] for r in c.execute(
            "SELECT DISTINCT deck_id FROM attempts WHERE profile_id=? AND mode!='game'", (pid,)).fetchall()]
        # A sitting must be at least a round's worth of answers for this child (the parent may have
        # chosen short rounds), capped at 8: a real round on the level, not two stray answers in a mix.
        try:
            prefs = json.loads(c.execute("SELECT prefs FROM profiles WHERE id=?", (pid,)).fetchone()["prefs"])
        except (TypeError, ValueError):
            prefs = {}
        size = prefs.get("sessionSize") if isinstance(prefs, dict) else None
        if isinstance(size, bool) or not isinstance(size, int) or not 3 <= size <= 30:
            size = 10
        credited, reset, unknown = [], [], []
        for deck_id in started:
            deck = self.content.decks.get(deck_id)
            if not deck:
                unknown.append(deck_id)
                continue
            if deck.get("quiz") is False:
                continue
            quizzable = sum(1 for card in deck["cards"] if card.get("quiz") is not False)
            need = max(1, min(8, quizzable, size))
            rows = c.execute(
                "SELECT correct, at FROM attempts WHERE profile_id=? AND deck_id=? AND mode='practice' "
                "ORDER BY at, id", (pid, deck_id)).fetchall()
            sittings: list[list] = []
            for r in rows:
                if not sittings or r["at"] - sittings[-1][-1]["at"] > self.LEGACY_GAP_MS:
                    sittings.append([])
                sittings[-1].append(r)
            passed = 0
            for sitting in sittings:
                total, right = len(sitting), sum(1 for r in sitting if r["correct"])
                if total < need or right / total < self.PASS_MARK:
                    continue
                passed += 1
                uid = re.sub(r"[^A-Za-z0-9_-]", "_", f"legacy-{pid}-{deck_id}-{passed}")[:64]
                at = sitting[-1]["at"]
                c.execute(
                    "INSERT OR IGNORE INTO rounds(uid, profile_id, deck_id, mode, total, correct, day, at) "
                    "VALUES(?,?,?,'practice',?,?,?,?)", (uid, pid, deck_id, total, right, local_day(at), at))
            if passed:
                credited.append(deck_id)
            else:                               # never passed: back to square one on this level
                reset.append(deck_id)
                c.executemany("DELETE FROM card_stats WHERE profile_id=? AND card_id=?",
                              [(pid, card["id"]) for card in deck["cards"]])
        if started:
            self.log(f"rounds: profile {pid}: {len(credited)} levels credited as passed {credited}, "
                     f"{len(reset)} put back to square one {reset}, "
                     f"{len(unknown)} decks no longer in the content {unknown}")

    def known_cards(self, ids, limit: int) -> list[str]:
        if not isinstance(ids, list) or not ids:
            raise ApiError(400, "Pick at least one card")
        if len(ids) > limit:
            raise ApiError(400, f"At most {limit} cards")
        out = []
        for cid in ids:
            if not isinstance(cid, str) or cid not in self.content.cards:
                raise ApiError(400, "Unknown card in list")
            if cid not in out:
                out.append(cid)
        return out

    def clean_day(self, day, at: int) -> str:
        """Trust the tablet's local date (the Pi may be on UTC) unless it is far from ours."""
        if isinstance(day, str) and DAY_RE.match(day):
            try:
                theirs = time.mktime(time.strptime(day, "%Y-%m-%d")) * 1000
                if abs(theirs - at) <= 2 * DAY_MS:
                    return day
            except (ValueError, OverflowError):
                pass
        return local_day(at)

    @staticmethod
    def clean_at(at) -> int:
        """Use the tablet's timestamp only if its clock roughly agrees with ours."""
        t = now_ms()
        if isinstance(at, int) and not isinstance(at, bool) and abs(at - t) <= DAY_MS:
            return at
        return t

    def record(self, c: sqlite3.Connection, profile_id: int, item: dict, touched: dict,
               test_id: int | None = None) -> bool:
        """Insert one attempt and fold it into card_stats. Returns False for a replayed uid."""
        cur = c.execute(
            "INSERT OR IGNORE INTO attempts(uid, profile_id, card_id, deck_id, mode, correct, chosen, ms, "
            "test_id, day, at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (item["uid"], profile_id, item["card"], item["deck"], item["mode"], int(item["correct"]),
             item["chosen"], item["ms"], test_id, item["day"], item["at"]),
        )
        if cur.rowcount != 1:
            return False
        if item["mode"] == "game":
            return True     # games earn stars but never move a card's mastery
        row = c.execute(
            "SELECT seen, correct, wrong, streak, box, recent, last_at AS at FROM card_stats "
            "WHERE profile_id=? AND card_id=?", (profile_id, item["card"])).fetchone()
        stat = apply_result(dict(row) if row else EMPTY_STAT, item["correct"], item["at"])
        c.execute(
            "INSERT INTO card_stats(profile_id, card_id, seen, correct, wrong, streak, box, recent, last_at) "
            "VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(profile_id, card_id) DO UPDATE SET "
            "seen=excluded.seen, correct=excluded.correct, wrong=excluded.wrong, streak=excluded.streak, "
            "box=excluded.box, recent=excluded.recent, last_at=excluded.last_at",
            (profile_id, item["card"], stat["seen"], stat["correct"], stat["wrong"], stat["streak"],
             stat["box"], stat["recent"], stat["at"]),
        )
        touched[item["card"]] = stat
        return True

    # -- kid-side handlers

    def h_ping(self, req: Request):
        return {"ok": True, "app": APP_NAME, "version": VERSION, "content": self.content.etag.strip('"'),
                "help": self.tutor.enabled, "tts": self.tts.enabled}

    def h_voices(self, req: Request):
        """The natural voices the Pi can speak with, and the one it uses unless asked for another."""
        return {"voices": self.tts.voices(), "default": self.tts.default_voice}

    def h_tts(self, req: Request):
        """One spoken clip for the tablet (?text=…&voice=…&rate=…) as WAV. The same text, voice and pace
        always give the same clip, so it is cached for a year; the ETag is the clip's place in the cache.

        &kind=sound asks for a 🔤 Sound it out clip: cut without the pause piper leaves after a sentence
        (--sentence_silence 0, so "buh kuh duh" does not drag) and kept apart from a word's clip (the
        <pace>-snd cache folder). Without it the server decides (Tts.is_sound): a text that is one of the
        tablet's sound strings (SOUNDS / SOUNDS_PI in web/js/phonics.js), or as short as one (at most 4
        characters, no space), is a sound; anything else is a word or a line. Any other kind is ignored."""
        text = req.query.get("text", [""])[0]
        voice = req.query.get("voice", [None])[0] or self.tts.default_voice
        rate = req.query.get("rate", ["1"])[0]
        sound = True if req.query.get("kind", [None])[0] == "sound" else None
        path = self.tts.render(text, voice, rate, sound=sound)
        where = path.relative_to(self.tts.cache_dir).as_posix()
        etag = f'"{hashlib.sha1(where.encode("utf-8")).hexdigest()}"'
        return FileReply(path, "audio/wav", etag, "public, max-age=31536000, immutable")
    h_tts.sends_file = True       # so Handler._api answers HEAD for it, like a static file

    def h_help(self, req: Request):
        """The 🙋 button: a hint about the card the child is on, from the local model."""
        pid = want_int(req.body, "profile", 1, 10**9)
        self.profile_row(pid)
        card_id = want_str(req.body, "card", 120, allow_empty=False)
        entry = self.content.cards.get(card_id)
        if not entry:
            raise ApiError(400, "Unknown card")
        deck_id, kind, card = entry
        deck = self.content.decks[deck_id]
        choices = req.body.get("choices")
        context = {
            "subject": deck["subject"], "deck": deck["title"], "kind": kind,
            "prompt": card.get("text") if kind == "read" else card.get("q", ""),
            "answer": card_answer(card, kind),
            "choices": [clip(c, 80) for c in choices[:6]] if isinstance(choices, list) else [],
            "chosen": clip(req.body.get("chosen"), 80) or None,
            "revealed": bool(req.body.get("revealed", False)),
            "said": clip(req.body.get("said"), 300) or None,
        }
        return {"text": self.tutor.ask(context)}

    def h_profiles(self, req: Request):
        rows = self.db.read("SELECT * FROM profiles ORDER BY id")
        return {"profiles": [self.profile_json(r) for r in rows], "pinSet": self.parent.pin_is_set()}

    def h_state(self, req: Request):
        pid = req.q_int("profile", 1, 10**9)
        profile = self.profile_row(pid)
        stats = {
            r["card_id"]: {"seen": r["seen"], "correct": r["correct"], "wrong": r["wrong"],
                           "streak": r["streak"], "box": r["box"], "recent": r["recent"], "at": r["last_at"]}
            for r in self.db.read("SELECT * FROM card_stats WHERE profile_id=?", (pid,))
        }
        flags = [
            {"id": r["id"], "card": r["card_id"], "kind": r["kind"], "note": r["note"], "at": r["created_at"]}
            for r in self.db.read(
                "SELECT * FROM flags WHERE profile_id IN (0, ?) ORDER BY created_at DESC", (pid,))
        ]
        tests = [
            {"id": r["id"], "title": r["title"], "config": json.loads(r["config"]),
             "cards": json.loads(r["card_ids"]), "created": r["created_at"]}
            for r in self.db.read(
                "SELECT * FROM tests WHERE profile_id=? AND status='assigned' ORDER BY id", (pid,))
        ]
        since = local_day(now_ms() - 60 * DAY_MS)
        days = {
            r["day"]: {"total": r["n"], "correct": r["ok"]}
            for r in self.db.read(
                "SELECT day, COUNT(*) AS n, SUM(correct) AS ok FROM attempts "
                "WHERE profile_id=? AND day>=? GROUP BY day", (pid, since))
        }
        return {
            "profile": self.profile_json(profile), "stats": stats, "flags": flags, "tests": tests,
            "days": days, "stars": self.stars(pid), "pinSet": self.parent.pin_is_set(),
            "today": local_day(), "rounds": self.round_summary(pid), "reads": self.read_summary(pid),
            "books": self.books_of(pid),
        }

    def h_report(self, req: Request):
        pid = req.q_int("profile", 1, 10**9)
        days = req.q_int("days", 1, 366, 30)
        self.profile_row(pid)
        since = local_day(now_ms() - days * DAY_MS)
        by_day = [dict(r) for r in self.db.read(
            "SELECT day, mode, COUNT(*) AS total, SUM(correct) AS correct, COALESCE(SUM(ms), 0) AS ms "
            "FROM attempts WHERE profile_id=? AND day>=? GROUP BY day, mode ORDER BY day", (pid, since))]
        by_deck = [dict(r) for r in self.db.read(
            "SELECT deck_id AS deck, COUNT(*) AS total, SUM(correct) AS correct, COALESCE(SUM(ms), 0) AS ms, "
            "MAX(at) AS last FROM attempts WHERE profile_id=? AND day>=? AND mode!='game' "
            "GROUP BY deck_id", (pid, since))]
        misses = [dict(r) for r in self.db.read(
            "SELECT card_id AS card, deck_id AS deck, mode, chosen, at FROM attempts "
            "WHERE profile_id=? AND correct=0 AND mode!='game' ORDER BY at DESC LIMIT 400", (pid,))]
        rounds = [dict(r) for r in self.db.read(
            "SELECT deck_id AS deck, mode, total, correct, day, at FROM rounds "
            "WHERE profile_id=? ORDER BY at DESC LIMIT 500", (pid,))]
        return {"since": since, "byDay": by_day, "byDeck": by_deck, "misses": misses, "rounds": rounds,
                "passMark": self.PASS_MARK}

    def h_rounds(self, req: Request):
        """One finished practice round on a level: how many right out of how many asked."""
        pid = want_int(req.body, "profile", 1, 10**9)
        self.profile_row(pid)
        uid = req.body.get("uid")
        if not isinstance(uid, str) or not UID_RE.match(uid):
            raise ApiError(400, "Bad round id")
        deck = req.body.get("deck")
        if not isinstance(deck, str) or deck not in self.content.decks:
            raise ApiError(400, "Unknown deck")
        total = want_int(req.body, "total", 1, 100)
        correct = want_int(req.body, "correct", 0, 100)
        if correct > total:
            raise ApiError(400, "correct cannot be more than total")
        mode = req.body.get("mode", "practice")
        if mode not in self.ROUND_MODES:                # a game round must never count toward passing a level
            raise ApiError(400, "Bad round mode")
        at = self.clean_at(req.body.get("at"))
        day = self.clean_day(req.body.get("day"), at)
        with self.db.tx() as c:
            c.execute(
                "INSERT OR IGNORE INTO rounds(uid, profile_id, deck_id, mode, total, correct, day, at) "
                "VALUES(?,?,?,?,?,?,?,?)", (uid, pid, deck, mode, total, correct, day, at))
        return {"rounds": self.round_summary(pid, deck)}

    def h_deck_report(self, req: Request):
        """One level for the grown-up pages: every round played on it and every wrong answer."""
        deck_id = req.args[0]
        if deck_id not in self.content.decks:
            raise ApiError(404, "Unknown deck")
        pid = req.q_int("profile", 1, 10**9)
        self.profile_row(pid)
        rounds = [dict(r) for r in self.db.read(
            "SELECT mode, total, correct, day, at FROM rounds WHERE profile_id=? AND deck_id=? "
            "ORDER BY at DESC, id DESC LIMIT 200", (pid, deck_id))]
        misses = [dict(r) for r in self.db.read(
            "SELECT card_id AS card, mode, chosen, at FROM attempts "
            "WHERE profile_id=? AND deck_id=? AND correct=0 AND mode!='game' ORDER BY at DESC LIMIT 500", (pid, deck_id))]
        return {"deck": deck_id, "rounds": rounds, "misses": misses,
                "summary": self.round_summary(pid, deck_id).get(deck_id), "passMark": self.PASS_MARK}

    def h_reads(self, req: Request):
        """One finished read of a story: by the child alone ('self': words tapped for help count as errors)
        or marked and timed by a grown-up ('scored': words correct per minute is worked out here)."""
        pid = want_int(req.body, "profile", 1, 10**9)
        self.profile_row(pid)
        uid = req.body.get("uid")
        if not isinstance(uid, str) or not UID_RE.match(uid):
            raise ApiError(400, "Bad read id")
        deck_id = req.body.get("deck")
        deck = self.content.decks.get(deck_id) if isinstance(deck_id, str) else None
        if not deck:
            raise ApiError(400, "Unknown deck")
        if not deck.get("passage"):
            raise ApiError(400, "This level has no story")
        mode = req.body.get("mode")
        if mode not in READ_MODES:
            raise ApiError(400, "Bad read mode")
        words = want_int(req.body, "words", 1, MAX_PASSAGE_WORDS)
        errors = want_int(req.body, "errors", 0, MAX_PASSAGE_WORDS)
        if errors > words:
            raise ApiError(400, "errors cannot be more than words")
        seconds = want_int(req.body, "seconds", 1, MAX_READ_SECONDS) if mode == "scored" else None
        wcpm = wcpm_of(words, errors, seconds) if mode == "scored" else None
        missed = clean_missed(req.body.get("missed"))
        at = self.clean_at(req.body.get("at"))
        day = self.clean_day(req.body.get("day"), at)
        with self.db.tx() as c:
            c.execute(
                "INSERT OR IGNORE INTO reads(uid, profile_id, deck_id, mode, words, errors, seconds, wcpm, missed, "
                "day, at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (uid, pid, deck_id, mode, words, errors, seconds, wcpm, json.dumps(missed, ensure_ascii=False),
                 day, at))
        return {"reads": self.read_summary(pid, deck_id), "stars": self.stars(pid)}

    def h_reading_report(self, req: Request):
        """Every story read, for the grown-up Reading page: the reads per story (newest first, stories in
        order of their latest read) and the words to practise, counted across every read."""
        pid = req.q_int("profile", 1, 10**9)
        self.profile_row(pid)
        summaries = self.read_summary(pid)
        per_deck: dict[str, list] = {}
        times: dict[str, int] = {}
        last_at: dict[str, int] = {}
        for r in self.db.read(
                "SELECT deck_id, mode, words, errors, seconds, wcpm, missed, day, at FROM reads "
                "WHERE profile_id=? ORDER BY at DESC, id DESC", (pid,)):
            try:
                missed = [w for w in json.loads(r["missed"]) if isinstance(w, str)]
            except ValueError:
                missed = []
            for w in missed:
                times[w] = times.get(w, 0) + 1
                last_at[w] = max(last_at.get(w, 0), r["at"])
            reads = per_deck.setdefault(r["deck_id"], [])
            if len(reads) < MAX_REPORT_READS:
                reads.append({"mode": r["mode"], "words": r["words"], "errors": r["errors"], "seconds": r["seconds"],
                              "wcpm": r["wcpm"], "missed": missed, "day": r["day"], "at": r["at"]})
        words = sorted(times, key=lambda w: (-times[w], -last_at[w], w))[:MAX_MISSED_WORDS]
        return {
            "decks": [{"deck": d, "summary": summaries.get(d), "reads": reads} for d, reads in per_deck.items()],
            "missed": [{"word": w, "times": times[w], "lastAt": last_at[w]} for w in words],
            "stars": self.stars(pid),
        }

    def h_book_set(self, req: Request):
        """A grown-up ticks "we read this book" for one child, or unticks it. Any level that is a book
        (a `book` object) or carries a story (a `passage`) can be ticked; ticking again keeps the first
        date, unticking forgets it. Replies with every book this child has read."""
        deck_id = req.args[0]
        pid = want_int(req.body, "profile", 1, 10**9)
        self.profile_row(pid)
        deck = self.content.decks.get(deck_id)
        if not deck or not (isinstance(deck.get("book"), dict) or deck.get("passage")):
            raise ApiError(400, "Not a book")
        read = want_bool(req.body, "read")
        with self.db.tx() as c:
            if read:
                c.execute("INSERT OR IGNORE INTO books(profile_id, deck_id, read, at) VALUES(?,?,1,?)",
                          (pid, deck_id, now_ms()))
            else:
                c.execute("DELETE FROM books WHERE profile_id=? AND deck_id=?", (pid, deck_id))
        return {"books": self.books_of(pid)}

    def h_attempts(self, req: Request):
        pid = want_int(req.body, "profile", 1, 10**9)
        self.profile_row(pid)
        items = req.body.get("attempts")
        if not isinstance(items, list) or len(items) > MAX_ATTEMPTS_PER_POST:
            raise ApiError(400, "Bad attempts list")
        clean, skipped = [], 0
        for raw in items:
            if not isinstance(raw, dict):
                raise ApiError(400, "Bad attempt")
            uid = raw.get("uid")
            if not isinstance(uid, str) or not UID_RE.match(uid):
                raise ApiError(400, "Bad attempt id")
            if raw.get("mode") not in MODES:
                raise ApiError(400, "Bad attempt mode")
            if not isinstance(raw.get("correct"), bool):
                raise ApiError(400, "Bad attempt result")
            entry = self.content.cards.get(raw.get("card")) if isinstance(raw.get("card"), str) else None
            if entry is None:
                skipped += 1          # the card was removed from the content; drop it quietly
                continue
            ms = raw.get("ms")
            ms = max(0, min(ms, 3_600_000)) if isinstance(ms, int) and not isinstance(ms, bool) else None
            at = self.clean_at(raw.get("at"))
            clean.append({
                "uid": uid, "card": raw["card"], "deck": entry[0], "mode": raw["mode"],
                "correct": raw["correct"], "chosen": clip(raw.get("chosen"), 200) or None, "ms": ms,
                "at": at, "day": self.clean_day(raw.get("day"), at),
            })
        touched: dict[str, dict] = {}
        added = 0
        with self.db.tx() as c:
            for item in clean:
                added += self.record(c, pid, item, touched)
        return {"added": added, "skipped": skipped, "stats": touched, "stars": self.stars(pid)}

    def h_avatar(self, req: Request):
        pid = int(req.args[0])
        self.profile_row(pid)
        avatar = want_str(req.body, "avatar", 16, allow_empty=False)
        with self.db.tx() as c:
            c.execute("UPDATE profiles SET avatar=? WHERE id=?", (avatar, pid))
        return {"ok": True}

    def h_tests(self, req: Request):
        pid = req.q_int("profile", 1, 10**9)
        self.profile_row(pid)
        rows = self.db.read(
            "SELECT id, title, config, card_ids, status, created_at, started_at, finished_at, total, correct "
            "FROM tests WHERE profile_id=? ORDER BY COALESCE(finished_at, created_at) DESC LIMIT 500", (pid,))
        return {"tests": [self.test_json(r, full=False) for r in rows]}

    @staticmethod
    def test_json(r: sqlite3.Row, full: bool) -> dict:
        cards = json.loads(r["card_ids"])
        out = {
            "id": r["id"], "title": r["title"], "config": json.loads(r["config"]), "status": r["status"],
            "created": r["created_at"], "started": r["started_at"], "finished": r["finished_at"],
            "total": r["total"] if r["total"] is not None else len(cards), "correct": r["correct"],
        }
        if full:
            out["profile"] = r["profile_id"]
            out["cards"] = cards
            out["results"] = json.loads(r["results"]) if r["results"] else []
        return out

    def h_test_get(self, req: Request):
        rows = self.db.read("SELECT * FROM tests WHERE id=?", (int(req.args[0]),))
        if not rows:
            raise ApiError(404, "No such test")
        return {"test": self.test_json(rows[0], full=True)}

    def h_test_finish(self, req: Request):
        test_id = int(req.args[0])
        pid = want_int(req.body, "profile", 1, 10**9)
        results = req.body.get("results")
        if not isinstance(results, list) or len(results) > MAX_TEST_CARDS:
            raise ApiError(400, "Bad results list")
        finished = now_ms()
        started = req.body.get("started")
        if not isinstance(started, int) or isinstance(started, bool) or not (0 < finished - started < DAY_MS):
            started = None
        day = self.clean_day(req.body.get("day"), finished)
        touched: dict[str, dict] = {}
        with self.db.tx() as c:
            row = c.execute("SELECT * FROM tests WHERE id=? AND profile_id=?", (test_id, pid)).fetchone()
            if not row:
                raise ApiError(404, "No such test")
            if row["status"] != "assigned":
                raise ApiError(409, "This test is already finished")
            card_ids = json.loads(row["card_ids"])
            by_card = {}
            for raw in results:
                cid = raw.get("card") if isinstance(raw, dict) else None
                if isinstance(cid, str) and cid in card_ids and cid not in by_card:
                    by_card[cid] = raw
            saved, right = [], 0
            for n, cid in enumerate(card_ids):
                raw = by_card.get(cid, {})
                entry = self.content.cards.get(cid)
                chosen = clip(raw.get("chosen"), 300) or None
                # The server marks the test, so a history row can always be trusted.
                answer = card_answer(entry[2], entry[1]) if entry else clip(raw.get("answer"), 300)
                correct = chosen is not None and chosen == answer
                ms = raw.get("ms")
                ms = max(0, min(ms, 3_600_000)) if isinstance(ms, int) and not isinstance(ms, bool) else None
                choices = raw.get("choices") if isinstance(raw.get("choices"), list) else []
                saved.append({
                    "card": cid, "deck": entry[0] if entry else clip(raw.get("deck"), 80),
                    "prompt": clip(raw.get("prompt"), 300), "answer": answer, "chosen": chosen,
                    "choices": [clip(x, 300) for x in choices[:6]], "correct": correct, "ms": ms,
                })
                right += correct
                if entry:
                    self.record(c, pid, {
                        "uid": f"t{test_id}-{n}", "card": cid, "deck": entry[0], "mode": "test",
                        "correct": correct, "chosen": chosen, "ms": ms, "at": finished, "day": day,
                    }, touched, test_id=test_id)
            c.execute(
                "UPDATE tests SET status='done', started_at=?, finished_at=?, total=?, correct=?, results=? "
                "WHERE id=?",
                (started, finished, len(saved), right, json.dumps(saved, ensure_ascii=False), test_id))
            row = c.execute("SELECT * FROM tests WHERE id=?", (test_id,)).fetchone()
        return {"test": self.test_json(row, full=True), "stats": touched, "stars": self.stars(pid)}

    # -- grown-up handlers

    def h_unlock(self, req: Request):
        if not self.parent.pin_is_set():
            return {"token": None, "pinSet": False}
        pin = want_str(req.body, "pin", 8, allow_empty=False)
        return {"token": self.parent.unlock(pin), "pinSet": True}

    def h_pin(self, req: Request):
        pin = req.body.get("pin")
        if pin is None:
            self.parent.set_pin(None)
            return {"pinSet": False, "token": None}
        if not isinstance(pin, str) or not PIN_RE.match(pin):
            raise ApiError(400, "A PIN is 4 to 8 digits")
        self.parent.set_pin(pin)
        return {"pinSet": True, "token": self.parent.issue()}

    def h_test_create(self, req: Request):
        pid = want_int(req.body, "profile", 1, 10**9)
        self.profile_row(pid)
        title = want_str(req.body, "title", 80, default="Test") or "Test"
        cards = self.known_cards(req.body.get("cards"), MAX_TEST_CARDS)
        raw = req.body.get("config") if isinstance(req.body.get("config"), dict) else {}
        decks = raw.get("decks") if isinstance(raw.get("decks"), list) else []
        config = {
            "decks": [d for d in decks if isinstance(d, str) and d in self.content.decks][:400],
            "source": raw.get("source") if raw.get("source") in ("all", "trouble", "learning", "new", "seen",
                                                                 "missed", "custom") else "all",
            "feedback": bool(raw.get("feedback", False)),
            "readAloud": bool(raw.get("readAloud", True)),
        }
        with self.db.tx() as c:
            cur = c.execute(
                "INSERT INTO tests(profile_id, title, config, card_ids, status, created_at) "
                "VALUES(?,?,?,?, 'assigned', ?)",
                (pid, title, json.dumps(config), json.dumps(cards), now_ms()))
            row = c.execute("SELECT * FROM tests WHERE id=?", (cur.lastrowid,)).fetchone()
        return {"test": self.test_json(row, full=True)}

    def h_test_delete(self, req: Request):
        with self.db.tx() as c:
            cur = c.execute("DELETE FROM tests WHERE id=?", (int(req.args[0]),))
        if cur.rowcount != 1:
            raise ApiError(404, "No such test")
        return {"ok": True}

    def h_flag_add(self, req: Request):
        kind = req.body.get("kind")
        if kind not in FLAG_KINDS:
            raise ApiError(400, "Bad flag kind")
        card = req.body.get("card")
        if not isinstance(card, str) or card not in self.content.cards:
            raise ApiError(400, "Unknown card")
        note = want_str(req.body, "note", 300, default="")
        # "issue" means the card itself is wrong, which is true for every child, so it is stored once.
        pid = 0 if kind == "issue" else want_int(req.body, "profile", 1, 10**9)
        if pid:
            self.profile_row(pid)
        t = now_ms()
        with self.db.tx() as c:
            c.execute(
                "INSERT INTO flags(profile_id, card_id, kind, note, created_at) VALUES(?,?,?,?,?) "
                "ON CONFLICT(profile_id, card_id, kind) DO UPDATE SET note=excluded.note",
                (pid, card, kind, note, t))
            row = c.execute(
                "SELECT * FROM flags WHERE profile_id=? AND card_id=? AND kind=?", (pid, card, kind)).fetchone()
        return {"flag": {"id": row["id"], "card": card, "kind": kind, "note": row["note"], "at": row["created_at"]}}

    def h_flag_delete(self, req: Request):
        with self.db.tx() as c:
            cur = c.execute("DELETE FROM flags WHERE id=?", (int(req.args[0]),))
        if cur.rowcount != 1:
            raise ApiError(404, "No such flag")
        return {"ok": True}

    def h_clear_trouble(self, req: Request):
        """Grown-up says 'he knows this one now': wipe the recent misses that marked it as trouble."""
        pid = want_int(req.body, "profile", 1, 10**9)
        card = want_str(req.body, "card", 120, allow_empty=False)
        with self.db.tx() as c:
            c.execute("UPDATE card_stats SET recent='', box=MAX(box, 2) WHERE profile_id=? AND card_id=?",
                      (pid, card))
            row = c.execute(
                "SELECT seen, correct, wrong, streak, box, recent, last_at AS at FROM card_stats "
                "WHERE profile_id=? AND card_id=?", (pid, card)).fetchone()
        return {"stats": {card: dict(row)} if row else {}}

    @staticmethod
    def clean_prefs(raw) -> dict:
        """Keep only the preference keys we know, with sane types and sizes."""
        if not isinstance(raw, dict):
            raise ApiError(400, "Bad prefs")
        out = {}
        if "sessionSize" in raw:
            out["sessionSize"] = want_int(raw, "sessionSize", 3, 30)
        if "newPerSession" in raw:
            out["newPerSession"] = want_int(raw, "newPerSession", 1, 15)
        for key in ("sound", "speech", "readChoices", "gamesNeedPractice", "freeRoam", "helper", "testOut"):
            if key in raw:
                out[key] = want_bool(raw, key)
        if "theme" in raw:
            if raw["theme"] not in ("night", "day"):
                raise ApiError(400, "Bad theme")
            out["theme"] = raw["theme"]
        if "voiceMode" in raw:
            if raw["voiceMode"] not in ("help", "full", "off"):
                raise ApiError(400, "Bad voiceMode")
            out["voiceMode"] = raw["voiceMode"]
        # The quiz voice and the story voice (Read to me, word taps, sounding out) have their own speeds.
        for key, lo, hi in (("speechRate", 0.5, 1.5), ("readRate", 0.5, 1.2)):
            if key in raw:
                rate = raw[key]
                if isinstance(rate, bool) or not isinstance(rate, (int, float)) or not lo <= rate <= hi:
                    raise ApiError(400, f"Bad {key}")
                out[key] = round(float(rate), 2)
        if "hiddenDecks" in raw:
            decks = raw["hiddenDecks"]
            if not isinstance(decks, list) or len(decks) > 1000:
                raise ApiError(400, "Bad hiddenDecks")
            out["hiddenDecks"] = sorted({d for d in decks if isinstance(d, str) and len(d) <= 80})
        return out

    def h_profile_create(self, req: Request):
        name = want_str(req.body, "name", 24, default="")
        avatar = want_str(req.body, "avatar", 16, default="🦊") or "🦊"
        with self.db.tx() as c:
            if c.execute("SELECT COUNT(*) FROM profiles").fetchone()[0] >= MAX_PROFILES:
                raise ApiError(400, f"At most {MAX_PROFILES} children")
            cur = c.execute("INSERT INTO profiles(name, avatar, created_at) VALUES(?,?,?)",
                            (name, avatar, now_ms()))
        return {"profile": self.profile_json(self.profile_row(cur.lastrowid))}

    def h_profile_update(self, req: Request):
        pid = int(req.args[0])
        row = self.profile_row(pid)
        name = want_str(req.body, "name", 24, default=row["name"])
        avatar = want_str(req.body, "avatar", 16, default=row["avatar"]) or row["avatar"]
        prefs = row["prefs"]
        if "prefs" in req.body:
            merged = self.profile_json(row)["prefs"]
            merged.update(self.clean_prefs(req.body["prefs"]))
            prefs = json.dumps(merged)
        with self.db.tx() as c:
            c.execute("UPDATE profiles SET name=?, avatar=?, prefs=? WHERE id=?", (name, avatar, prefs, pid))
        return {"profile": self.profile_json(self.profile_row(pid))}

    def h_profile_delete(self, req: Request):
        pid = int(req.args[0])
        with self.db.tx() as c:
            if c.execute("SELECT COUNT(*) FROM profiles").fetchone()[0] <= 1:
                raise ApiError(400, "Keep at least one child")
            cur = c.execute("DELETE FROM profiles WHERE id=?", (pid,))
            c.execute("DELETE FROM flags WHERE profile_id=?", (pid,))
        if cur.rowcount != 1:
            raise ApiError(404, "No such profile")
        return {"ok": True}

    def h_profile_reset(self, req: Request):
        """Wipe practice history. scope 'all' also clears tests and the book ticks; scope 'deck' clears one
        deck's cards, rounds, reads and book tick."""
        pid = int(req.args[0])
        self.profile_row(pid)
        scope = req.body.get("scope")
        with self.db.tx() as c:
            if scope == "all":
                for table in ("card_stats", "attempts", "tests", "rounds", "reads", "books"):
                    c.execute(f"DELETE FROM {table} WHERE profile_id=?", (pid,))
                c.execute("DELETE FROM flags WHERE profile_id=? AND kind='practice'", (pid,))
            elif scope == "deck":
                deck_id = req.body.get("deck")
                deck = self.content.decks.get(deck_id) if isinstance(deck_id, str) else None
                if deck:
                    for card in deck["cards"]:
                        c.execute("DELETE FROM card_stats WHERE profile_id=? AND card_id=?", (pid, card["id"]))
                elif isinstance(deck_id, str) and deck_id and c.execute(
                        "SELECT 1 FROM attempts WHERE profile_id=? AND deck_id=? "
                        "UNION ALL SELECT 1 FROM reads WHERE profile_id=? AND deck_id=? LIMIT 1",
                        (pid, deck_id, pid, deck_id)).fetchone():
                    # A deck since removed from the content: its cards are known only from the history.
                    c.execute("DELETE FROM card_stats WHERE profile_id=? AND card_id IN "
                              "(SELECT card_id FROM attempts WHERE profile_id=? AND deck_id=?)", (pid, pid, deck_id))
                else:
                    raise ApiError(400, "Unknown deck")
                c.execute("DELETE FROM rounds WHERE profile_id=? AND deck_id=?", (pid, deck_id))
                c.execute("DELETE FROM reads WHERE profile_id=? AND deck_id=?", (pid, deck_id))
                c.execute("DELETE FROM books WHERE profile_id=? AND deck_id=?", (pid, deck_id))
            else:
                raise ApiError(400, "Bad scope")
        return {"ok": True}

    def h_export(self, req: Request):
        out = {"app": APP_NAME, "version": VERSION, "exported": now_ms()}
        for table in ("profiles", "card_stats", "attempts", "flags", "tests", "rounds", "reads", "books"):
            out[table] = [dict(r) for r in self.db.read(f"SELECT * FROM {table}")]
        return out

    # -- backups

    def backup(self, keep: int = 7) -> Path | None:
        """Write today's snapshot to data/backups if it is not there yet; keep the newest few."""
        folder = self.data_dir / "backups"
        folder.mkdir(exist_ok=True)
        target = folder / f"starcards-{local_day()}.db"
        if target.exists():
            return None
        tmp = target.with_suffix(".tmp")
        self.db.backup_to(tmp)
        tmp.replace(target)
        for old in sorted(folder.glob("starcards-*.db"))[:-keep]:
            old.unlink()
        return target

    def close(self) -> None:
        self.db.close()


# ----------------------------------------------------------------------- http

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    timeout = 20                   # seconds of socket silence before we hang up
    app: App = None                # set by make_server()
    verbose = False

    def version_string(self) -> str:
        return "StarCards"

    def log_message(self, fmt, *args) -> None:
        if self.verbose:
            sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def log_error(self, fmt, *args) -> None:
        # A tablet going to sleep leaves keep-alive connections idle until they time out;
        # that is normal and not worth a log line.
        if args and isinstance(args[0], (socket.timeout, TimeoutError)):
            return
        self.log_message(fmt, *args)

    def do_GET(self):
        self._dispatch("GET")

    def do_HEAD(self):
        self._dispatch("HEAD")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def _dispatch(self, method: str) -> None:
        try:
            if not self.app.host_ok(self.headers.get("Host", "")):
                raise ApiError(403, "Open this app with the Pi's IP address or its .local name.")
            parts = urlsplit(self.path)
            if parts.path.startswith("/api/"):
                self._api(method, parts.path, parse_qs(parts.query))
            elif method in ("GET", "HEAD"):
                self._static(parts.path, head=method == "HEAD")
            else:
                raise ApiError(405, "Method not allowed")
        except ApiError as e:
            if method not in ("GET", "HEAD"):
                self.close_connection = True      # an unread body would poison keep-alive
            self._send_json({"error": e.message}, e.status)
        except (BrokenPipeError, ConnectionResetError, socket.timeout):
            self.close_connection = True
        except Exception:
            sys.stderr.write(f"error handling {method} {self.path}\n{traceback.format_exc()}")
            self.close_connection = True
            try:
                self._send_json({"error": "Something went wrong on the server"}, 500)
            except OSError:
                pass

    def _read_body(self) -> dict:
        length = self.headers.get("Content-Length")
        if length is None or not length.isdigit():
            raise ApiError(411, "Content-Length required")
        if int(length) > MAX_BODY:
            raise ApiError(413, "Request too large")
        ctype = self.headers.get("Content-Type", "").split(";")[0].strip().lower()
        if ctype != "application/json":
            # Also what stops a web page on another site from posting here with a plain form.
            raise ApiError(415, "Send JSON")
        raw = self.rfile.read(int(length))
        if len(raw) != int(length):
            raise ApiError(400, "Request cut short")
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except (ValueError, UnicodeDecodeError, RecursionError):
            raise ApiError(400, "That is not valid JSON") from None
        if not isinstance(body, dict):
            raise ApiError(400, "Send a JSON object")
        return body

    def _api(self, method: str, path: str, query: dict) -> None:
        if method == "HEAD":
            # Only a handler that sends a file answers HEAD (the tablet sizes a clip that way); the JSON
            # routes keep refusing it, as they always have.
            handler, grownup, args = self.app.route("GET", path)
            if not getattr(handler, "sends_file", False):
                raise ApiError(405, "Method not allowed")
        else:
            if method != "GET":
                origin = self.headers.get("Origin")
                if origin and urlsplit(origin).netloc.lower() != self.headers.get("Host", "").lower():
                    raise ApiError(403, "Cross-site request refused")
            handler, grownup, args = self.app.route(method, path)
        body = self._read_body() if method in ("POST", "PUT") else {}
        token = self.headers.get("X-Parent-Token")
        if grownup and not self.app.parent.allows(token):
            raise ApiError(401, "Grown-up PIN needed")
        req = Request(method, path, query, body, token)
        req.args = args
        reply = handler(req)
        if isinstance(reply, FileReply):
            if not self._not_modified(reply.etag, reply.cache):
                self._send(200, reply.ctype, reply.path.read_bytes(),
                           {"ETag": reply.etag, "Cache-Control": reply.cache}, head=method == "HEAD")
        else:
            self._send_json(reply, 200)

    def _send_json(self, obj, status: int) -> None:
        raw = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        # An error to a HEAD request keeps its headers and drops the body, or the next reply on a
        # kept-alive connection would be read out of step.
        self._send(status, "application/json; charset=utf-8", raw, {"Cache-Control": "no-store"},
                   compress=len(raw) > 1024, head=self.command == "HEAD")

    def _accepts_gzip(self) -> bool:
        return "gzip" in self.headers.get("Accept-Encoding", "").lower()

    def _send(self, status: int, ctype: str, body: bytes, extra: dict, compress=False, gz: bytes | None = None,
              head=False) -> None:
        if (compress or gz is not None) and self._accepts_gzip():
            body = gz if gz is not None else gzip.compress(body, 5)
            extra = {**extra, "Content-Encoding": "gzip"}
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Vary", "Accept-Encoding")
        for key, val in {**SECURITY_HEADERS, **extra}.items():
            self.send_header(key, val)
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        if not head and status != 304:
            self.wfile.write(body)

    def _not_modified(self, etag: str, cache: str = "no-cache") -> bool:
        if self.headers.get("If-None-Match") != etag:
            return False
        self.send_response(304)
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", cache)
        self.send_header("Content-Length", "0")
        self.end_headers()
        return True

    def _static(self, url_path: str, head: bool) -> None:
        app = self.app
        if url_path == "/content.json":
            app.content.refresh()
            content = app.content
            if self._not_modified(content.etag):
                return
            self._send(200, MIME[".json"], content.body, {"ETag": content.etag, "Cache-Control": "no-cache"},
                       gz=content.gz, head=head)
            return
        rel = unquote(url_path)
        if rel.endswith("/"):
            rel += "index.html"
        pieces = [p for p in rel.split("/") if p]
        if "\x00" in rel or "\\" in rel or any(p.startswith(".") for p in pieces):
            raise ApiError(404, "Not found")
        target = app.web_dir.joinpath(*pieces).resolve()
        ext = target.suffix.lower()
        # resolve() has followed any symlink, so this also stops links that point outside web/.
        if ext not in MIME or app.web_dir not in target.parents or not target.is_file():
            raise ApiError(404, "Not found")
        st = target.stat()
        etag = f'"{st.st_mtime_ns:x}-{st.st_size:x}"'
        if self._not_modified(etag):
            return
        body = target.read_bytes()
        gz = None
        if ext in COMPRESSIBLE and len(body) > 1024:
            key = (str(target), st.st_mtime_ns, st.st_size)
            gz = app._gz_cache.get(key)
            if gz is None:
                gz = gzip.compress(body, 6)
                if len(app._gz_cache) > 256:
                    app._gz_cache.clear()
                app._gz_cache[key] = gz
        self._send(200, MIME[ext], body, {"ETag": etag, "Cache-Control": "no-cache"}, gz=gz, head=head)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 32
    ssl_context = None

    def get_request(self):
        sock, addr = self.socket.accept()
        if self.ssl_context is not None:
            # Wrap per connection with a handshake timeout, so one stalled client cannot
            # wedge the accept loop (a plain wrap of the listening socket can hang forever).
            sock.settimeout(10)
            sock = self.ssl_context.wrap_socket(sock, server_side=True)
            sock.settimeout(None)
        return sock, addr

    def handle_error(self, request, client_address):
        # Dropped connections from a sleeping tablet are normal; keep the journal quiet.
        if isinstance(sys.exc_info()[1], (ConnectionError, socket.timeout, TimeoutError)):
            return
        super().handle_error(request, client_address)


def make_server(host: str, port: int, data_dir: Path, web_dir: Path | None = None,
                content_dir: Path | None = None, allow_hosts=(), verbose=False, log=print, tutor=None,
                tts=None) -> Server:
    app = App(data_dir, web_dir or ROOT / "web", content_dir or ROOT / "content", allow_hosts, log=log, tutor=tutor,
              tts=tts)
    handler = type("BoundHandler", (Handler,), {"app": app, "verbose": verbose})
    server = Server((host, port), handler)
    server.app = app
    return server


def lan_addresses() -> list[str]:
    found = []
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))     # no packet is sent; this just picks the outbound interface
            found.append(s.getsockname()[0])
    except OSError:
        pass
    return found


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=f"{APP_NAME} flashcard server")
    ap.add_argument("--host", default="0.0.0.0", help="address to listen on (default: all interfaces)")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--data-dir", type=Path, default=ROOT / "data", help="where the database lives")
    ap.add_argument("--content-dir", type=Path, default=ROOT / "content",
                    help="folder with subjects.json and decks/ (default: ./content)")
    ap.add_argument("--cert", type=Path, help="TLS certificate (PEM) to serve https instead of http")
    ap.add_argument("--key", type=Path, help="private key for --cert")
    ap.add_argument("--allow-host", action="append", default=[], metavar="NAME",
                    help="extra host name the tablet may use to reach this server (repeatable)")
    ap.add_argument("--verbose", action="store_true", help="log every request")
    ap.add_argument("--reset-pin", action="store_true", help="remove the grown-up PIN and exit")
    ap.add_argument("--backup-now", action="store_true", help="write a database backup and exit")
    ap.add_argument("--llm-url", default=os.environ.get("STARCARDS_LLM_URL"), metavar="URL",
                    help="OpenAI-compatible base URL of a local model for the Help button, "
                         "e.g. http://192.168.1.20:11434/v1 (Ollama). Off when not set.")
    ap.add_argument("--llm-model", default=os.environ.get("STARCARDS_LLM_MODEL", "llama3.1:8b"), metavar="NAME",
                    help="model name to request from the local server (default: llama3.1:8b)")
    ap.add_argument("--llm-key", default=os.environ.get("STARCARDS_LLM_KEY"), metavar="KEY",
                    help="bearer token if the local server wants one")
    ap.add_argument("--tts-cmd", default=os.environ.get("STARCARDS_TTS_CMD"), metavar="CMD",
                    help="piper command for the natural voice (default: <data-dir>/piper/piper/piper when "
                         "deploy/install-voices.sh has put it there). Off when neither is there.")
    ap.add_argument("--tts-voices", type=Path, default=os.environ.get("STARCARDS_TTS_VOICES"), metavar="DIR",
                    help="folder of piper voices, each an .onnx with its .onnx.json (default: <data-dir>/piper/voices)")
    ap.add_argument("--tts-cache", type=Path, metavar="DIR",
                    help="where the rendered clips are kept (default: <data-dir>/tts)")
    ap.add_argument("--tts-default-voice", default=os.environ.get("STARCARDS_TTS_DEFAULT_VOICE", "en_US-amy-medium"),
                    metavar="ID", help="the voice used unless the tablet asks for another (default: en_US-amy-medium, "
                                       "else the first voice found)")
    ap.add_argument("--tts-prerender", action=argparse.BooleanOptionalAction, default=True,
                    help="after a start, render every story line, word and question in the background so "
                         "playback is instant (default: on when a voice is there)")
    args = ap.parse_args(argv)

    def log(msg: str) -> None:
        print(msg, flush=True)

    if args.reset_pin or args.backup_now:
        app = App(args.data_dir, ROOT / "web", args.content_dir, log=lambda m: None)
        if args.reset_pin:
            app.parent.set_pin(None)
            log("Grown-up PIN removed.")
        else:
            log(f"Backup: {app.backup() or 'today already has one'}")
        app.close()
        return 0

    tutor = Tutor(args.llm_url, args.llm_model, args.llm_key)
    tts = find_tts(args.data_dir, args.tts_cmd, args.tts_voices, args.tts_cache, args.tts_default_voice, log=log)
    server = make_server(args.host, args.port, args.data_dir, content_dir=args.content_dir,
                         allow_hosts=args.allow_host, verbose=args.verbose, log=log, tutor=tutor, tts=tts)
    app: App = server.app
    scheme = "http"
    if args.cert:
        # https from the standard library: this is what lets Safari use the microphone and
        # "Add to Home Screen" offline features. The iPad must trust the certificate (see README).
        import ssl
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_cert_chain(str(args.cert), str(args.key) if args.key else None)
        server.ssl_context = ctx           # wrapped per connection in Server.get_request
        scheme = "https"
    if tutor.enabled:
        log(f"Help button: on, using {tutor.model} at {tutor.url}")
    if tts.enabled:
        log(f"Natural voice: on, {', '.join(v['id'] for v in tts.voices())} (default {tts.default_voice}), "
            f"clips in {tts.cache_dir}")
    elif tts.cmd:
        log(f"Natural voice: piper is there but no voice is in {tts.voices_dir} (see deploy/install-voices.sh)")
    stop = threading.Event()

    def backup_loop() -> None:
        while not stop.is_set():
            try:
                made = app.backup()
                if made:
                    log(f"backup: wrote {made.name}")
            except (OSError, sqlite3.Error) as e:
                log(f"backup failed: {e}")
            stop.wait(6 * 3600)

    threading.Thread(target=backup_loop, name="backup", daemon=True).start()

    def prerender_loop() -> None:
        """Fill the voice cache once per content version, from the bottom of the priority list: on Linux
        nice() is per thread, and piper inherits it, so a background clip never slows a tapped word."""
        try:
            os.nice(10)
        except (AttributeError, OSError):
            pass
        done = None
        while not stop.is_set():
            app.content.refresh()
            app.sounds.refresh()
            version = (app.content.etag, app.sounds.etag)      # the decks, and the sound spellings

            def changed(v=version) -> bool:
                app.content.refresh()
                app.sounds.refresh()
                return (app.content.etag, app.sounds.etag) != v

            if version != done:
                try:
                    result = app.tts.prerender(tts_corpus(app.content, sounds=app.sounds.strings),
                                               stop=stop, changed=changed)
                except Exception:
                    log(f"tts: pre-render crashed\n{traceback.format_exc()}")
                    result = {"stopped": "off"}
                if result["stopped"] in (None, "off"):
                    done = version              # all there, or nothing can be made: wait for new content
                elif result["stopped"] == "busy":
                    stop.wait(600)              # another run has it; see where things stand later
                    continue
                elif result["stopped"] == "changed":
                    continue                    # the content moved on: start over at the top, right away
            stop.wait(60)

    if tts.enabled and args.tts_prerender:
        threading.Thread(target=prerender_loop, name="tts-prerender", daemon=True).start()

    def shutdown(signum, frame) -> None:
        stop.set()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, shutdown)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, shutdown)

    host = socket.gethostname()
    port = "" if args.port in (80, 443) else f":{args.port}"
    log(f"{APP_NAME} {VERSION} is running.")
    log(f"  On the tablet, open:  {scheme}://{host}.local{port}")
    for ip in lan_addresses():
        log(f"                   or:  {scheme}://{ip}{port}")
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
        app.close()
        log("Stopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
