#!/usr/bin/env python3
"""Star Cards: a tiny flashcard server for one family, on one home network.

Standard library only (Python 3.9+), so it runs on a stock Raspberry Pi with
nothing to install. It does three jobs:

  * serves the web app from ./web
  * serves the flashcard content from ./content as one JSON bundle
  * keeps progress, tests and flags in a SQLite database

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
import os
import re
import secrets
import signal
import socket
import sqlite3
import sys
import threading
import time
import traceback
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


# ------------------------------------------------------------------------ app

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
    def __init__(self, data_dir: Path, web_dir: Path, content_dir: Path, allow_hosts=(), log=print, tutor=None):
        self.log = log
        self.web_dir = web_dir.resolve()
        self.data_dir = data_dir
        data_dir.mkdir(parents=True, exist_ok=True)
        self.db = DB(data_dir / "starcards.db")
        self.content = Content(content_dir, log=log)
        self.parent = ParentLock(self.db)
        self.tutor = tutor or Tutor(None, None)
        self.allow_hosts = {h.lower() for h in allow_hosts}
        try:
            self.allow_hosts.add(socket.gethostname().lower())
        except OSError:
            pass
        self._gz_cache: dict[tuple, bytes] = {}
        #        method  pattern                                  handler               grown-up only
        self.routes = [
            ("GET", r"/api/ping", self.h_ping, False),
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
                "help": self.tutor.enabled}

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
        if "speechRate" in raw:
            rate = raw["speechRate"]
            if isinstance(rate, bool) or not isinstance(rate, (int, float)) or not 0.5 <= rate <= 1.5:
                raise ApiError(400, "Bad speechRate")
            out["speechRate"] = round(float(rate), 2)
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
        """Wipe practice history. scope 'all' also clears tests; scope 'deck' clears one deck's cards."""
        pid = int(req.args[0])
        self.profile_row(pid)
        scope = req.body.get("scope")
        with self.db.tx() as c:
            if scope == "all":
                for table in ("card_stats", "attempts", "tests", "rounds", "reads"):
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
            else:
                raise ApiError(400, "Bad scope")
        return {"ok": True}

    def h_export(self, req: Request):
        out = {"app": APP_NAME, "version": VERSION, "exported": now_ms()}
        for table in ("profiles", "card_stats", "attempts", "flags", "tests", "rounds", "reads"):
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
            raise ApiError(405, "Method not allowed")
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
        self._send_json(handler(req), 200)

    def _send_json(self, obj, status: int) -> None:
        raw = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self._send(status, "application/json; charset=utf-8", raw, {"Cache-Control": "no-store"},
                   compress=len(raw) > 1024)

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

    def _not_modified(self, etag: str) -> bool:
        if self.headers.get("If-None-Match") != etag:
            return False
        self.send_response(304)
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", "no-cache")
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
                content_dir: Path | None = None, allow_hosts=(), verbose=False, log=print, tutor=None) -> Server:
    app = App(data_dir, web_dir or ROOT / "web", content_dir or ROOT / "content", allow_hosts, log=log, tutor=tutor)
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
    server = make_server(args.host, args.port, args.data_dir, content_dir=args.content_dir,
                         allow_hosts=args.allow_host, verbose=args.verbose, log=log, tutor=tutor)
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
