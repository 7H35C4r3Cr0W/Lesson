"""Server tests. Run from the project folder:  python -m unittest discover -s tests -v

Each test class starts a real server on a spare port with its own throwaway
database and a tiny hand-made content folder, then talks to it over HTTP.
"""
import gzip
import http.client
import json
import shutil
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import server  # noqa: E402

SUBJECTS = [{"id": "words", "title": "Words", "emoji": "📖"}, {"id": "math", "title": "Math", "emoji": "🔢"}]
DECK_WORDS = {
    "id": "w1", "subject": "words", "title": "Short a", "kind": "read", "order": 1,
    "cards": [{"id": "w1.cat", "text": "cat"}, {"id": "w1.hat", "text": "hat"}, {"id": "w1.map", "text": "map"}],
}
DECK_MATH = {
    "id": "m1", "subject": "math", "title": "Add", "kind": "qa", "order": 1,
    "cards": [{"id": "m1.1p1", "q": "1 + 1", "a": "2", "wrong": ["1", "3"]},
              {"id": "m1.2p2", "q": "2 + 2", "a": "4", "wrong": ["3", "5"]}],
}


def write_content(folder: Path, decks=(DECK_WORDS, DECK_MATH)) -> None:
    (folder / "decks").mkdir(parents=True, exist_ok=True)
    (folder / "subjects.json").write_text(json.dumps(SUBJECTS), encoding="utf-8")
    for deck in decks:
        (folder / "decks" / f"{deck['id']}.json").write_text(json.dumps(deck), encoding="utf-8")


class ServerCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="starcards-test-"))
        write_content(cls.tmp / "content")
        web = cls.tmp / "web"
        (web / "js").mkdir(parents=True)
        (web / "index.html").write_text("<!doctype html><title>t</title>" + "x" * 2000, encoding="utf-8")
        (web / "js" / "a.js").write_text("export const a = 1;\n", encoding="utf-8")
        (web / ".secret").write_text("no", encoding="utf-8")
        (web / "notes.md").write_text("no", encoding="utf-8")
        (cls.tmp / "outside.js").write_text("no", encoding="utf-8")
        cls.server = server.make_server("127.0.0.1", 0, cls.tmp / "data", web, cls.tmp / "content",
                                        log=lambda m: None)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.server.app.close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def call(self, method, path, body=None, headers=None, raw_body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        hdrs = dict(headers or {})
        data = raw_body
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            hdrs.setdefault("Content-Type", "application/json")
        conn.request(method, path, body=data, headers=hdrs)
        resp = conn.getresponse()
        payload = resp.read()
        conn.close()
        if resp.getheader("Content-Encoding") == "gzip":
            payload = gzip.decompress(payload)
        parsed = None
        if "json" in (resp.getheader("Content-Type") or "") and payload:
            parsed = json.loads(payload.decode("utf-8"))
        return resp, parsed if parsed is not None else payload

    def attempt(self, uid, card, correct, mode="practice", **extra):
        return {"uid": uid, "card": card, "mode": mode, "correct": correct, "at": server.now_ms(), **extra}


class StatMath(unittest.TestCase):
    def test_vectors(self):
        vectors = json.loads((ROOT / "web" / "tests" / "stat_vectors.json").read_text(encoding="utf-8"))["vectors"]
        self.assertGreaterEqual(len(vectors), 8)
        for vec in vectors:
            stat = dict(server.EMPTY_STAT)
            for result in vec["results"]:
                stat = server.apply_result(stat, result, 1000)
            got = {k: stat[k] for k in vec["expect"]}
            self.assertEqual(got, vec["expect"], vec["name"])

    def test_empty_stat_is_not_mutated(self):
        before = dict(server.EMPTY_STAT)
        server.apply_result(server.EMPTY_STAT, True, 5)
        self.assertEqual(server.EMPTY_STAT, before)


class StaticFiles(ServerCase):
    def test_index_and_headers(self):
        resp, body = self.call("GET", "/")
        self.assertEqual(resp.status, 200)
        self.assertIn(b"<!doctype html>", body)
        self.assertIn("text/html", resp.getheader("Content-Type"))
        self.assertEqual(resp.getheader("X-Content-Type-Options"), "nosniff")
        self.assertIn("default-src 'self'", resp.getheader("Content-Security-Policy"))
        self.assertEqual(resp.getheader("X-Frame-Options"), "DENY")

    def test_gzip_when_asked(self):
        resp, body = self.call("GET", "/", headers={"Accept-Encoding": "gzip"})
        self.assertEqual(resp.getheader("Content-Encoding"), "gzip")
        self.assertIn(b"<!doctype html>", body)

    def test_js_mime_and_etag_304(self):
        resp, _ = self.call("GET", "/js/a.js")
        self.assertEqual(resp.status, 200)
        self.assertTrue(resp.getheader("Content-Type").startswith("text/javascript"))
        etag = resp.getheader("ETag")
        resp2, body2 = self.call("GET", "/js/a.js", headers={"If-None-Match": etag})
        self.assertEqual(resp2.status, 304)
        self.assertEqual(body2, b"")

    def test_head_has_no_body(self):
        resp, body = self.call("HEAD", "/js/a.js")
        self.assertEqual(resp.status, 200)
        self.assertEqual(body, b"")
        self.assertGreater(int(resp.getheader("Content-Length")), 0)

    def test_traversal_and_hidden_files_are_refused(self):
        for path in ("/../outside.js", "/js/../../outside.js", "/%2e%2e/outside.js", "/js/%2e%2e%2f%2e%2e%2foutside.js",
                     "/..%5coutside.js", "/.secret", "/notes.md", "/js/", "/nope.js", "/js/a.js%00.html",
                     "//etc/passwd", "/C:/Windows/win.ini"):
            resp, _ = self.call("GET", path)
            self.assertEqual(resp.status, 404, path)

    def test_database_is_not_served(self):
        resp, _ = self.call("GET", "/data/starcards.db")
        self.assertEqual(resp.status, 404)

    def test_post_to_static_is_refused(self):
        resp, _ = self.call("POST", "/index.html", body={})
        self.assertEqual(resp.status, 405)

    def test_content_bundle(self):
        resp, body = self.call("GET", "/content.json")
        self.assertEqual(resp.status, 200)
        self.assertEqual([s["id"] for s in body["subjects"]], ["words", "math"])
        self.assertEqual([d["id"] for d in body["decks"]], ["w1", "m1"])
        self.assertTrue(body["version"])
        resp2, _ = self.call("GET", "/content.json", headers={"If-None-Match": resp.getheader("ETag")})
        self.assertEqual(resp2.status, 304)


class HostAndOrigin(ServerCase):
    def test_foreign_host_is_refused(self):
        resp, body = self.call("GET", "/api/ping", headers={"Host": "evil.example.com"})
        self.assertEqual(resp.status, 403)
        resp, _ = self.call("GET", "/", headers={"Host": "evil.example.com:8080"})
        self.assertEqual(resp.status, 403)

    def test_home_names_are_allowed(self):
        for host in ("raspberrypi.local:8080", "raspberrypi", "192.168.1.50:8080", "localhost", "[::1]:8080",
                     "pi.lan", "starcards.home.arpa", "kid.home"):
            resp, _ = self.call("GET", "/api/ping", headers={"Host": host})
            self.assertEqual(resp.status, 200, host)

    def test_bad_host_shapes(self):
        app = self.server.app
        for host in ("", "a b.local", "evil.com.", "local", "x.local.evil.com", "evil.com:80:80"):
            if host == "local":
                self.assertTrue(app.host_ok(host))      # single label: cannot be a public name
            else:
                self.assertFalse(app.host_ok(host), host)

    def test_cross_site_post_is_refused(self):
        resp, _ = self.call("POST", "/api/attempts", body={"profile": 1, "attempts": []},
                            headers={"Origin": "http://evil.example.com"})
        self.assertEqual(resp.status, 403)

    def test_same_site_post_is_fine(self):
        resp, _ = self.call("POST", "/api/attempts", body={"profile": 1, "attempts": []},
                            headers={"Origin": f"http://127.0.0.1:{self.port}"})
        self.assertEqual(resp.status, 200)

    def test_form_post_is_refused(self):
        resp, _ = self.call("POST", "/api/attempts", raw_body=b'{"profile":1,"attempts":[]}',
                            headers={"Content-Type": "text/plain"})
        self.assertEqual(resp.status, 415)


class BadRequests(ServerCase):
    def test_bad_json(self):
        resp, _ = self.call("POST", "/api/attempts", raw_body=b"{nope", headers={"Content-Type": "application/json"})
        self.assertEqual(resp.status, 400)

    def test_json_must_be_object(self):
        resp, _ = self.call("POST", "/api/attempts", raw_body=b"[1,2]", headers={"Content-Type": "application/json"})
        self.assertEqual(resp.status, 400)

    def test_deeply_nested_json_does_not_crash(self):
        raw = b"[" * 100_000 + b"]" * 100_000
        resp, _ = self.call("POST", "/api/attempts", raw_body=raw, headers={"Content-Type": "application/json"})
        self.assertEqual(resp.status, 400)
        resp, _ = self.call("GET", "/api/ping")
        self.assertEqual(resp.status, 200)

    def test_too_large(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.putrequest("POST", "/api/attempts")
        conn.putheader("Content-Type", "application/json")
        conn.putheader("Content-Length", str(server.MAX_BODY + 1))
        conn.endheaders()
        resp = conn.getresponse()
        self.assertEqual(resp.status, 413)
        resp.read()
        conn.close()

    def test_unknown_route_and_method(self):
        self.assertEqual(self.call("GET", "/api/nope")[0].status, 404)
        self.assertEqual(self.call("DELETE", "/api/ping")[0].status, 405)
        self.assertEqual(self.call("GET", "/api/state")[0].status, 400)
        self.assertEqual(self.call("GET", "/api/state?profile=abc")[0].status, 400)
        self.assertEqual(self.call("GET", "/api/state?profile=999")[0].status, 404)

    def test_attempt_validation(self):
        good = self.attempt("uid-00000001", "w1.cat", True)
        for bad in (
            {**good, "uid": "short"},
            {**good, "uid": "has space 1234"},
            {**good, "mode": "cheat"},
            {**good, "correct": 1},
            {**good, "correct": "true"},
        ):
            resp, _ = self.call("POST", "/api/attempts", body={"profile": 1, "attempts": [bad]})
            self.assertEqual(resp.status, 400, bad)
        resp, _ = self.call("POST", "/api/attempts", body={"profile": True, "attempts": []})
        self.assertEqual(resp.status, 400)
        resp, _ = self.call("POST", "/api/attempts", body={"profile": 1, "attempts": "x"})
        self.assertEqual(resp.status, 400)
        resp, _ = self.call("POST", "/api/attempts", body={
            "profile": 1, "attempts": [good] * (server.MAX_ATTEMPTS_PER_POST + 1)})
        self.assertEqual(resp.status, 400)


class Attempts(ServerCase):
    def test_record_and_replay(self):
        resp, state = self.call("GET", "/api/state?profile=1")
        self.assertEqual(resp.status, 200)
        base_stars = state["stars"]
        batch = [self.attempt("replay-0001", "w1.cat", True), self.attempt("replay-0002", "w1.cat", True),
                 self.attempt("replay-0003", "w1.hat", False, chosen="cat", ms=1500)]
        resp, out = self.call("POST", "/api/attempts", body={"profile": 1, "attempts": batch})
        self.assertEqual(resp.status, 200)
        self.assertEqual(out["added"], 3)
        self.assertEqual(out["stats"]["w1.cat"]["box"], 3)
        self.assertEqual(out["stats"]["w1.cat"]["recent"], "11")
        self.assertEqual(out["stats"]["w1.hat"]["box"], 1)
        self.assertEqual(out["stars"], base_stars + 2)
        # The tablet retries after a dropped connection: nothing may be counted twice.
        resp, again = self.call("POST", "/api/attempts", body={"profile": 1, "attempts": batch})
        self.assertEqual(again["added"], 0)
        self.assertEqual(again["stars"], base_stars + 2)
        _, state = self.call("GET", "/api/state?profile=1")
        self.assertEqual(state["stats"]["w1.cat"]["seen"], 2)
        self.assertEqual(state["stats"]["w1.hat"]["wrong"], 1)

    def test_unknown_card_is_skipped_not_fatal(self):
        resp, out = self.call("POST", "/api/attempts", body={"profile": 1, "attempts": [
            self.attempt("gone-00001", "deleted.card", True), self.attempt("gone-00002", "w1.map", True)]})
        self.assertEqual(resp.status, 200)
        self.assertEqual((out["added"], out["skipped"]), (1, 1))

    def test_game_answers_earn_stars_but_not_mastery(self):
        _, before = self.call("GET", "/api/state?profile=1")
        resp, out = self.call("POST", "/api/attempts", body={"profile": 1, "attempts": [
            self.attempt("game-00001", "m1.2p2", True, mode="game"),
            self.attempt("game-00002", "m1.2p2", False, mode="game")]})
        self.assertEqual(out["added"], 2)
        self.assertEqual(out["stats"], {})
        self.assertEqual(out["stars"], before["stars"] + 1)
        _, after = self.call("GET", "/api/state?profile=1")
        self.assertNotIn("m1.2p2", after["stats"])

    def test_day_and_clock_are_sanitised(self):
        item = self.attempt("clock-0001", "m1.1p1", True, day="1999-01-01")
        item["at"] = 5          # a tablet with a dead clock
        self.call("POST", "/api/attempts", body={"profile": 1, "attempts": [item]})
        row = self.server.app.db.read("SELECT day, at FROM attempts WHERE uid='clock-0001'")[0]
        self.assertEqual(row["day"], server.local_day())
        self.assertLess(abs(row["at"] - server.now_ms()), 60_000)

    def test_report(self):
        self.call("POST", "/api/attempts", body={"profile": 1, "attempts": [
            self.attempt("report-001", "m1.1p1", False, chosen="3", ms=900)]})
        resp, rep = self.call("GET", "/api/report?profile=1&days=7")
        self.assertEqual(resp.status, 200)
        self.assertTrue(any(d["deck"] == "m1" for d in rep["byDeck"]))
        self.assertTrue(any(m["card"] == "m1.1p1" and m["chosen"] == "3" for m in rep["misses"]))
        self.assertTrue(rep["byDay"])


class Rounds(ServerCase):
    def post_round(self, uid, deck, correct, total, profile=1):
        return self.call("POST", "/api/rounds", body={"profile": profile, "uid": uid, "deck": deck,
                                                      "total": total, "correct": correct, "at": server.now_ms()})

    def test_rounds_summary_best_last_and_pass_mark(self):
        resp, out = self.post_round("round-000001", "w1", 5, 10)       # 50%: finished, not passed
        self.assertEqual(resp.status, 200, out)
        self.assertEqual(out["rounds"]["w1"]["count"], 1)
        self.assertFalse(out["rounds"]["w1"]["passed"])
        resp, out = self.post_round("round-000002", "w1", 9, 10)       # 90%: passed
        s = out["rounds"]["w1"]
        self.assertEqual((s["count"], s["best"], s["last"], s["lastCorrect"], s["lastTotal"]), (2, 0.9, 0.9, 9, 10))
        self.assertTrue(s["passed"])
        resp, out = self.post_round("round-000003", "w1", 6, 8)        # 75%: best stays 90%
        s = out["rounds"]["w1"]
        self.assertEqual((s["count"], s["best"], s["last"]), (3, 0.9, 0.75))
        self.assertTrue(s["passed"])
        # A retried post (same uid) is not counted twice.
        resp, out = self.post_round("round-000003", "w1", 6, 8)
        self.assertEqual(out["rounds"]["w1"]["count"], 3)
        _, state = self.call("GET", "/api/state?profile=1")
        self.assertEqual(state["rounds"]["w1"]["count"], 3)
        self.assertNotIn("m1", state["rounds"])
        _, rep = self.call("GET", "/api/report?profile=1")
        self.assertEqual(rep["passMark"], 0.85)
        self.assertEqual(len([r for r in rep["rounds"] if r["deck"] == "w1"]), 3)

    def test_test_out_rounds_count_toward_passing(self):
        _, out = self.call("POST", "/api/profiles", body={"name": "Skipper"})
        pid = out["profile"]["id"]
        resp, out = self.call("POST", "/api/rounds", body={"profile": pid, "uid": "round-to-00001", "deck": "m1",
                                                           "total": 10, "correct": 9, "mode": "testout", "at": server.now_ms()})
        self.assertEqual(resp.status, 200, out)
        self.assertTrue(out["rounds"]["m1"]["passed"])
        _, rep = self.call("GET", f"/api/decks/m1/report?profile={pid}")
        self.assertEqual(rep["rounds"][0]["mode"], "testout")
        resp, out = self.call("PUT", f"/api/profiles/{pid}", body={"prefs": {"testOut": False}})
        self.assertEqual((resp.status, out["profile"]["prefs"]["testOut"]), (200, False))
        self.call("DELETE", f"/api/profiles/{pid}")

    def test_round_validation(self):
        for body in ({"profile": 1, "uid": "round-bad-01", "deck": "nope", "total": 10, "correct": 5},
                     {"profile": 1, "uid": "round-bad-02", "deck": "w1", "total": 10, "correct": 11},
                     {"profile": 1, "uid": "round-bad-03", "deck": "w1", "total": 0, "correct": 0},
                     {"profile": 1, "uid": "x", "deck": "w1", "total": 10, "correct": 5},
                     {"profile": 1, "uid": "round-bad-05", "deck": "w1", "total": "10", "correct": 5},
                     {"profile": 1, "uid": "round-bad-07", "deck": "w1", "total": 10, "correct": 9, "mode": "game"}):
            resp, _ = self.call("POST", "/api/rounds", body=body)
            self.assertEqual(resp.status, 400, body)
        resp, _ = self.call("POST", "/api/rounds", body={"profile": 99, "uid": "round-bad-06", "deck": "w1", "total": 1, "correct": 1})
        self.assertEqual(resp.status, 404)

    def test_deck_report_lists_rounds_and_misses(self):
        _, out = self.call("POST", "/api/profiles", body={"name": "Report kid"})
        pid = out["profile"]["id"]
        self.post_round("round-rep00001", "m1", 1, 2, profile=pid)
        self.call("POST", "/api/attempts", body={"profile": pid, "attempts": [
            {"uid": "att-rep-000001", "card": "m1.1p1", "mode": "practice", "correct": False, "chosen": "3", "at": server.now_ms()},
            {"uid": "att-rep-000002", "card": "m1.1p1", "mode": "game", "correct": False, "chosen": "1", "at": server.now_ms()},
            {"uid": "att-rep-000003", "card": "w1.cat", "mode": "practice", "correct": False, "chosen": "hat", "at": server.now_ms()}]})
        resp, rep = self.call("GET", f"/api/decks/m1/report?profile={pid}")
        self.assertEqual(resp.status, 200, rep)
        self.assertEqual([(r["correct"], r["total"]) for r in rep["rounds"]], [(1, 2)])
        self.assertEqual([(m["card"], m["chosen"]) for m in rep["misses"]], [("m1.1p1", "3")])   # no games, no other decks
        self.assertEqual((rep["summary"]["best"], rep["summary"]["passed"], rep["passMark"]), (0.5, False, 0.85))
        self.assertEqual(self.call("GET", f"/api/decks/nope/report?profile={pid}")[0].status, 404)
        self.assertEqual(self.call("GET", "/api/decks/m1/report?profile=99")[0].status, 404)
        self.call("DELETE", f"/api/profiles/{pid}")

    def test_export_and_profile_delete_cover_rounds(self):
        _, out = self.call("POST", "/api/profiles", body={"name": "Export kid"})
        pid = out["profile"]["id"]
        self.post_round("round-exp00001", "w1", 9, 10, profile=pid)
        _, dump = self.call("GET", "/api/export")
        self.assertTrue(any(r["uid"] == "round-exp00001" and r["profile_id"] == pid for r in dump["rounds"]))
        self.call("DELETE", f"/api/profiles/{pid}")
        _, dump = self.call("GET", "/api/export")
        self.assertFalse(any(r["profile_id"] == pid for r in dump["rounds"]), "deleting a child removes their rounds")

    def test_reset_clears_rounds(self):
        _, out = self.call("POST", "/api/profiles", body={"name": "Rounds kid"})
        pid = out["profile"]["id"]
        self.post_round("round-r00001", "w1", 9, 10, profile=pid)
        self.post_round("round-r00002", "m1", 2, 2, profile=pid)
        self.call("POST", f"/api/profiles/{pid}/reset", body={"scope": "deck", "deck": "w1"})
        _, state = self.call("GET", f"/api/state?profile={pid}")
        self.assertEqual(set(state["rounds"]), {"m1"})
        self.call("POST", f"/api/profiles/{pid}/reset", body={"scope": "all"})
        _, state = self.call("GET", f"/api/state?profile={pid}")
        self.assertEqual(state["rounds"], {})
        self.call("DELETE", f"/api/profiles/{pid}")


class LegacyRounds(ServerCase):
    """Upgrading a Pi that already holds practice history: it is scored against the pass mark once."""

    def seed(self, pid, deck, card, correct, at):
        app = self.server.app
        with app.db.tx() as c:
            app.record(c, pid, {"uid": f"seed-{at}-{card}"[:64], "card": card, "deck": deck, "mode": "practice",
                                "correct": correct, "chosen": None, "ms": 1000, "at": at, "day": server.local_day(at)}, {})

    def test_history_is_scored_once_against_the_pass_mark(self):
        app = self.server.app
        self.assertTrue(app.db.get_setting("rounds_seeded"), "a fresh database is marked seeded at start-up")
        t0 = server.now_ms() - 3 * 3600 * 1000
        # Words: a sitting of 3 all right -> passed; a worse sitting half an hour later does not undo it.
        for i, card in enumerate(["w1.cat", "w1.hat", "w1.map"]):
            self.seed(1, "w1", card, True, t0 + i * 10_000)
        for i, card in enumerate(["w1.cat", "w1.hat", "w1.map"]):
            self.seed(1, "w1", card, i == 0, t0 + 30 * 60_000 + i * 10_000)
        # Math: 2 of 4 right -> never passed -> square one: card stats cleared, answers and stars kept.
        for i, (card, ok) in enumerate([("m1.1p1", True), ("m1.2p2", False), ("m1.1p1", False), ("m1.2p2", True)]):
            self.seed(1, "m1", card, ok, t0 + 60 * 60_000 + i * 10_000)
        _, before = self.call("GET", "/api/state?profile=1")
        self.assertIn("m1.1p1", before["stats"])
        self.assertEqual(before["rounds"], {})

        app.db.set_setting("rounds_seeded", None)
        app.seed_rounds_from_history()
        _, state = self.call("GET", "/api/state?profile=1")
        self.assertEqual(set(state["rounds"]), {"w1"})
        w1 = state["rounds"]["w1"]
        self.assertEqual((w1["count"], w1["best"], w1["passed"], w1["lastCorrect"], w1["lastTotal"]), (1, 1.0, True, 3, 3))
        self.assertIn("w1.cat", state["stats"])
        self.assertNotIn("m1.1p1", state["stats"])
        self.assertNotIn("m1.2p2", state["stats"])
        self.assertEqual(state["stars"], before["stars"])
        self.assertEqual(sum(d["total"] for d in state["days"].values()), 10)
        _, rep = self.call("GET", "/api/decks/m1/report?profile=1")
        self.assertEqual(len(rep["misses"]), 2, "the wrong answers stay on the grown-up page")

        # One-time: running again (even with the marker cleared) changes nothing once rounds exist.
        app.seed_rounds_from_history()
        app.db.set_setting("rounds_seeded", None)
        app.seed_rounds_from_history()
        _, again = self.call("GET", "/api/state?profile=1")
        self.assertEqual(again["rounds"], state["rounds"])
        self.assertTrue(app.db.get_setting("rounds_seeded"))

    def test_short_rounds_still_count(self):
        """A parent who chose 5-question rounds: a 5-answer sitting is a whole round, not a stray."""
        big = {"id": "m9", "subject": "math", "title": "Big", "kind": "qa", "order": 9,
               "cards": [{"id": f"m9.c{i}", "q": f"{i} + 0", "a": str(i), "wrong": ["x", "y"]} for i in range(20)]}
        write_content(self.tmp / "content-big", decks=(DECK_WORDS, DECK_MATH, big))
        app = server.App(self.tmp / "data-short", self.tmp / "web", self.tmp / "content-big", log=lambda m: None)
        try:
            t0 = server.now_ms() - 3600 * 1000
            with app.db.tx() as c:
                c.execute("UPDATE profiles SET prefs=? WHERE id=1", (json.dumps({"sessionSize": 5}),))
                for i in range(5):
                    app.record(c, 1, {"uid": f"short-{i:06d}", "card": f"m9.c{i}", "deck": "m9", "mode": "practice",
                                      "correct": True, "chosen": None, "ms": 1000, "at": t0 + i * 10_000,
                                      "day": server.local_day(t0)}, {})
            app.db.set_setting("rounds_seeded", None)
            app.seed_rounds_from_history()
            summary = app.round_summary(1)
            self.assertTrue(summary.get("m9", {}).get("passed"), summary)
            self.assertEqual((summary["m9"]["lastCorrect"], summary["m9"]["lastTotal"]), (5, 5))
        finally:
            app.close()

    def test_migration_waits_for_content(self):
        """Content missing or broken at start-up must not burn the one-time scoring of past practice."""
        empty = self.tmp / "empty-content"
        empty.mkdir(exist_ok=True)
        app = server.App(self.tmp / "data-nocontent", self.tmp / "web", empty, allow_hosts=("pi.example",),
                         log=lambda m: None)
        try:
            self.assertIsNone(app.db.get_setting("rounds_seeded"))
            self.assertTrue(app.host_ok("pi.example"), "--allow-host names are accepted")
            self.assertFalse(app.host_ok("pi.example.com"))
        finally:
            app.close()


class Tests(ServerCase):
    def make(self, cards, **extra):
        resp, out = self.call("POST", "/api/tests", body={"profile": 1, "title": "Friday test", "cards": cards,
                                                           "config": {"decks": ["w1", "nope"], "source": "all"},
                                                           **extra})
        self.assertEqual(resp.status, 200, out)
        return out["test"]

    def test_create_validation(self):
        for body in ({"profile": 1, "cards": []}, {"profile": 1, "cards": ["nope"]},
                     {"profile": 1, "cards": "w1.cat"}, {"profile": 99, "cards": ["w1.cat"]},
                     {"profile": 1, "cards": ["w1.cat"] * 0}, {"profile": 1, "cards": [5]}):
            resp, _ = self.call("POST", "/api/tests", body=body)
            self.assertIn(resp.status, (400, 404), body)

    def test_full_cycle(self):
        test = self.make(["w1.cat", "w1.hat", "m1.1p1", "w1.cat"])
        self.assertEqual(test["cards"], ["w1.cat", "w1.hat", "m1.1p1"])     # duplicate dropped
        self.assertEqual(test["config"]["decks"], ["w1"])                    # unknown deck dropped
        self.assertEqual(test["status"], "assigned")
        _, state = self.call("GET", "/api/state?profile=1")
        self.assertIn(test["id"], [t["id"] for t in state["tests"]])

        results = [
            {"card": "w1.cat", "chosen": "cat", "choices": ["cat", "hat", "map"], "prompt": "cat", "ms": 2000,
             "correct": False},                                   # client says wrong; the server marks it right
            {"card": "w1.hat", "chosen": "map", "choices": ["cat", "hat", "map"], "prompt": "hat", "ms": 3000,
             "correct": True},                                    # client says right; the server marks it wrong
            {"card": "not.in.test", "chosen": "x"},
            # m1.1p1 never answered
        ]
        resp, out = self.call("POST", f"/api/tests/{test['id']}/finish",
                              body={"profile": 1, "started": server.now_ms() - 60_000, "results": results})
        self.assertEqual(resp.status, 200, out)
        done = out["test"]
        self.assertEqual((done["status"], done["total"], done["correct"]), ("done", 3, 1))
        by_card = {r["card"]: r for r in done["results"]}
        self.assertTrue(by_card["w1.cat"]["correct"])
        self.assertFalse(by_card["w1.hat"]["correct"])
        self.assertEqual(by_card["w1.hat"]["answer"], "hat")
        self.assertIsNone(by_card["m1.1p1"]["chosen"])
        self.assertFalse(by_card["m1.1p1"]["correct"])
        self.assertEqual(out["stats"]["w1.hat"]["recent"][-1], "0")

        resp, _ = self.call("POST", f"/api/tests/{test['id']}/finish", body={"profile": 1, "results": results})
        self.assertEqual(resp.status, 409)                                   # cannot be finished twice

        _, state = self.call("GET", "/api/state?profile=1")
        self.assertNotIn(test["id"], [t["id"] for t in state["tests"]])
        _, hist = self.call("GET", "/api/tests?profile=1")
        row = next(t for t in hist["tests"] if t["id"] == test["id"])
        self.assertEqual((row["correct"], row["total"]), (1, 3))
        self.assertNotIn("results", row)
        _, full = self.call("GET", f"/api/tests/{test['id']}")
        self.assertEqual(len(full["test"]["results"]), 3)

    def test_wrong_profile_cannot_finish(self):
        test = self.make(["w1.map"])
        resp, _ = self.call("POST", f"/api/tests/{test['id']}/finish", body={"profile": 2, "results": []})
        self.assertEqual(resp.status, 404)

    def test_delete(self):
        test = self.make(["w1.map"])
        self.assertEqual(self.call("DELETE", f"/api/tests/{test['id']}")[0].status, 200)
        self.assertEqual(self.call("DELETE", f"/api/tests/{test['id']}")[0].status, 404)
        self.assertEqual(self.call("GET", f"/api/tests/{test['id']}")[0].status, 404)


class FlagsAndProfiles(ServerCase):
    def test_flags(self):
        resp, out = self.call("POST", "/api/flags", body={"profile": 1, "card": "w1.cat", "kind": "practice",
                                                           "note": "mixes up with cut"})
        self.assertEqual(resp.status, 200)
        flag_id = out["flag"]["id"]
        resp, out2 = self.call("POST", "/api/flags", body={"profile": 1, "card": "w1.cat", "kind": "practice",
                                                            "note": "new note"})
        self.assertEqual(out2["flag"]["id"], flag_id)                         # same flag, note updated
        self.assertEqual(out2["flag"]["note"], "new note")
        resp, issue = self.call("POST", "/api/flags", body={"card": "m1.1p1", "kind": "issue", "note": "typo"})
        self.assertEqual(resp.status, 200)
        _, state = self.call("GET", "/api/state?profile=1")
        kinds = {(f["card"], f["kind"]) for f in state["flags"]}
        self.assertEqual(kinds, {("w1.cat", "practice"), ("m1.1p1", "issue")})
        for body in ({"profile": 1, "card": "nope", "kind": "practice"},
                     {"profile": 1, "card": "w1.cat", "kind": "other"},
                     {"profile": 1, "card": "w1.cat", "kind": "practice", "note": "x" * 301}):
            self.assertEqual(self.call("POST", "/api/flags", body=body)[0].status, 400, body)
        self.assertEqual(self.call("DELETE", f"/api/flags/{flag_id}")[0].status, 200)
        self.assertEqual(self.call("DELETE", f"/api/flags/{flag_id}")[0].status, 404)
        self.call("DELETE", f"/api/flags/{issue['flag']['id']}")

    def test_profiles_and_prefs(self):
        resp, out = self.call("POST", "/api/profiles", body={"name": "  Sam  ", "avatar": "🐯"})
        self.assertEqual(resp.status, 200)
        pid = out["profile"]["id"]
        self.assertEqual(out["profile"]["name"], "Sam")
        resp, out = self.call("PUT", f"/api/profiles/{pid}", body={
            "prefs": {"sessionSize": 8, "sound": False, "hiddenDecks": ["m1", "m1", 7], "evil": "x",
                      "speechRate": 0.9}})
        self.assertEqual(resp.status, 200, out)
        self.assertEqual(out["profile"]["prefs"],
                         {"sessionSize": 8, "sound": False, "hiddenDecks": ["m1"], "speechRate": 0.9})
        resp, out = self.call("PUT", f"/api/profiles/{pid}", body={"prefs": {"sessionSize": 12}})
        self.assertEqual(out["profile"]["prefs"]["sessionSize"], 12)
        self.assertEqual(out["profile"]["prefs"]["sound"], False)             # merged, not replaced
        for prefs in ({"sessionSize": 999}, {"sound": "yes"}, {"speechRate": 9}, {"hiddenDecks": "m1"}, "x",
                      {"theme": "neon"}, {"voiceMode": "loud"}, {"freeRoam": 1}):
            self.assertEqual(self.call("PUT", f"/api/profiles/{pid}", body={"prefs": prefs})[0].status, 400, prefs)
        resp, out = self.call("PUT", f"/api/profiles/{pid}", body={"prefs": {"theme": "day", "voiceMode": "full",
                                                                              "freeRoam": True, "helper": False}})
        self.assertEqual(resp.status, 200, out)
        self.assertEqual(out["profile"]["prefs"]["theme"], "day")
        self.assertEqual(out["profile"]["prefs"]["voiceMode"], "full")
        self.assertTrue(out["profile"]["prefs"]["freeRoam"])
        self.assertFalse(out["profile"]["prefs"]["helper"])
        self.assertEqual(self.call("POST", f"/api/profiles/{pid}/avatar", body={"avatar": "🦄"})[0].status, 200)
        self.assertEqual(self.call("POST", f"/api/profiles/{pid}/avatar", body={"avatar": ""})[0].status, 400)

        self.call("POST", "/api/attempts", body={"profile": pid, "attempts": [
            self.attempt("reset-0001", "w1.cat", False), self.attempt("reset-0002", "m1.1p1", True)]})
        self.assertEqual(self.call("POST", f"/api/profiles/{pid}/reset", body={"scope": "deck", "deck": "w1"})[0].status, 200)
        _, state = self.call("GET", f"/api/state?profile={pid}")
        self.assertEqual(set(state["stats"]), {"m1.1p1"})
        self.assertEqual(self.call("POST", f"/api/profiles/{pid}/reset", body={"scope": "all"})[0].status, 200)
        _, state = self.call("GET", f"/api/state?profile={pid}")
        self.assertEqual((state["stats"], state["stars"]), ({}, 0))
        self.assertEqual(self.call("POST", f"/api/profiles/{pid}/reset", body={"scope": "moon"})[0].status, 400)

        self.assertEqual(self.call("DELETE", f"/api/profiles/{pid}")[0].status, 200)
        self.assertEqual(self.call("GET", f"/api/state?profile={pid}")[0].status, 404)

    def test_last_profile_cannot_be_deleted(self):
        _, out = self.call("GET", "/api/profiles")
        if len(out["profiles"]) == 1:
            resp, _ = self.call("DELETE", f"/api/profiles/{out['profiles'][0]['id']}")
            self.assertEqual(resp.status, 400)

    def test_clear_trouble(self):
        self.call("POST", "/api/attempts", body={"profile": 1, "attempts": [
            self.attempt("trouble-01", "w1.map", False), self.attempt("trouble-02", "w1.map", False)]})
        resp, out = self.call("POST", "/api/cards/clear-trouble", body={"profile": 1, "card": "w1.map"})
        self.assertEqual(resp.status, 200)
        self.assertEqual(out["stats"]["w1.map"]["recent"], "")
        self.assertGreaterEqual(out["stats"]["w1.map"]["box"], 2)

    def test_export_has_no_pin(self):
        resp, out = self.call("GET", "/api/export")
        self.assertEqual(resp.status, 200)
        self.assertIn("profiles", out)
        self.assertNotIn("settings", out)


class ParentPin(ServerCase):
    def test_pin_lifecycle(self):
        _, out = self.call("GET", "/api/profiles")
        self.assertFalse(out["pinSet"])
        # No PIN yet: grown-up actions are open.
        self.assertEqual(self.call("GET", "/api/export")[0].status, 200)
        for bad in ("12", "abcd", "123456789", 1234):
            self.assertEqual(self.call("POST", "/api/parent/pin", body={"pin": bad})[0].status, 400, bad)

        resp, out = self.call("POST", "/api/parent/pin", body={"pin": "2468"})
        self.assertEqual(resp.status, 200)
        token = out["token"]
        self.assertTrue(token)
        # Now the server itself refuses grown-up actions without a token.
        self.assertEqual(self.call("GET", "/api/export")[0].status, 401)
        self.assertEqual(self.call("POST", "/api/tests", body={"profile": 1, "cards": ["w1.cat"]})[0].status, 401)
        self.assertEqual(self.call("GET", "/api/export", headers={"X-Parent-Token": "wrong"})[0].status, 401)
        self.assertEqual(self.call("GET", "/api/export", headers={"X-Parent-Token": token})[0].status, 200)
        # Kid-side actions stay open.
        self.assertEqual(self.call("GET", "/api/state?profile=1")[0].status, 200)
        self.assertEqual(self.call("POST", "/api/attempts", body={"profile": 1, "attempts": []})[0].status, 200)

        self.assertEqual(self.call("POST", "/api/parent/unlock", body={"pin": "0000"})[0].status, 403)
        resp, out = self.call("POST", "/api/parent/unlock", body={"pin": "2468"})
        self.assertEqual(resp.status, 200)
        token2 = out["token"]
        self.assertEqual(self.call("GET", "/api/export", headers={"X-Parent-Token": token2})[0].status, 200)

        # Changing the PIN signs every device out.
        resp, out = self.call("POST", "/api/parent/pin", body={"pin": "13579"}, headers={"X-Parent-Token": token2})
        self.assertEqual(resp.status, 200)
        self.assertEqual(self.call("GET", "/api/export", headers={"X-Parent-Token": token2})[0].status, 401)
        token3 = out["token"]

        # Guessing is slowed down after five misses.
        for _ in range(5):
            self.assertEqual(self.call("POST", "/api/parent/unlock", body={"pin": "0000"})[0].status, 403)
        self.assertEqual(self.call("POST", "/api/parent/unlock", body={"pin": "13579"})[0].status, 429)

        # Idle tokens expire.
        lock = self.server.app.parent
        issued, used = lock._tokens[token3]
        lock._tokens[token3] = (issued, used - lock.IDLE_MS - 1)
        self.assertEqual(self.call("GET", "/api/export", headers={"X-Parent-Token": token3})[0].status, 401)

        # Removing the PIN needs a token, then opens things up again.
        self.assertEqual(self.call("POST", "/api/parent/pin", body={"pin": None})[0].status, 401)
        fresh = lock.issue()
        self.assertEqual(self.call("POST", "/api/parent/pin", body={"pin": None},
                                   headers={"X-Parent-Token": fresh})[0].status, 200)
        self.assertEqual(self.call("GET", "/api/export")[0].status, 200)


class StubModel(BaseHTTPRequestHandler):
    """Pretends to be Ollama's OpenAI-compatible endpoint."""
    reply = "**Try** sounding it out: c... a... t. <think>secret</think> See https://example.com"
    calls = []

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        StubModel.calls.append((self.path, body))
        out = json.dumps({"choices": [{"message": {"role": "assistant", "content": StubModel.reply}}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):
        pass


class HelpButton(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="starcards-help-"))
        write_content(cls.tmp / "content")
        (cls.tmp / "web").mkdir()
        cls.model = ThreadingHTTPServer(("127.0.0.1", 0), StubModel)
        threading.Thread(target=cls.model.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
        tutor = server.Tutor(f"http://127.0.0.1:{cls.model.server_address[1]}/v1", "test-model")
        tutor.MIN_GAP_S = 0.3
        cls.server = server.make_server("127.0.0.1", 0, cls.tmp / "data", cls.tmp / "web", cls.tmp / "content",
                                        log=lambda m: None, tutor=tutor)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.server.app.close()
        cls.model.shutdown()
        cls.model.server_close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    call = ServerCase.call

    def test_ping_advertises_help(self):
        resp, body = self.call("GET", "/api/ping")
        self.assertTrue(body["help"])

    def test_hint_is_cleaned_and_contextual(self):
        time.sleep(0.35)
        resp, out = self.call("POST", "/api/help", body={"profile": 1, "card": "w1.cat", "choices": ["cat", "hat"],
                                                          "chosen": "hat", "said": "what is it?"})
        self.assertEqual(resp.status, 200, out)
        self.assertEqual(out["text"], "Try sounding it out: c... a... t. See")
        path, sent = StubModel.calls[-1]
        self.assertEqual(path, "/v1/chat/completions")
        self.assertEqual(sent["model"], "test-model")
        self.assertEqual(sent["messages"][0]["role"], "system")
        user = sent["messages"][1]["content"]
        self.assertIn('reading the word or sentence: "cat"', user)
        self.assertIn("The child picked: hat", user)
        self.assertIn('The child asked: "what is it?"', user)
        self.assertIn("not been shown", user)
        # Straight away again: rate limited, so a mashed button cannot flood the model.
        resp, _ = self.call("POST", "/api/help", body={"profile": 1, "card": "w1.cat"})
        self.assertEqual(resp.status, 429)

    def test_bad_requests(self):
        time.sleep(0.35)
        self.assertEqual(self.call("POST", "/api/help", body={"profile": 1, "card": "nope"})[0].status, 400)
        self.assertEqual(self.call("POST", "/api/help", body={"profile": 9, "card": "w1.cat"})[0].status, 404)
        self.assertEqual(self.call("POST", "/api/help", body={"card": "w1.cat"})[0].status, 400)

    def test_clean(self):
        self.assertEqual(server.Tutor.clean("  Hello   *there*  "), "Hello there")
        self.assertEqual(server.Tutor.clean(""), "Let's try it together. Look at the card again.")
        long = "Word. " * 100
        self.assertLessEqual(len(server.Tutor.clean(long)), 321)


class HelpDisabled(ServerCase):
    def test_help_off_by_default(self):
        _, ping = self.call("GET", "/api/ping")
        self.assertFalse(ping["help"])
        resp, _ = self.call("POST", "/api/help", body={"profile": 1, "card": "w1.cat"})
        self.assertEqual(resp.status, 503)


class ContentLoading(unittest.TestCase):
    def test_bad_files_are_skipped_and_edits_are_picked_up(self):
        tmp = Path(tempfile.mkdtemp(prefix="starcards-content-"))
        try:
            write_content(tmp)
            (tmp / "decks" / "broken.json").write_text("{not json", encoding="utf-8")
            (tmp / "decks" / "zz-dupe.json").write_text(json.dumps({**DECK_MATH, "id": "m2"}), encoding="utf-8")
            (tmp / "decks" / "nosubject.json").write_text(json.dumps({**DECK_WORDS, "id": "w9", "subject": "x",
                                                                       "cards": [{"id": "w9.a", "text": "a"}]}),
                                                          encoding="utf-8")
            logs = []
            content = server.Content(tmp, log=logs.append)
            self.assertEqual(sorted(content.decks), ["m1", "w1"])      # dupe card ids, bad json, bad subject: skipped
            self.assertEqual(len(content.cards), 5)
            self.assertEqual(sum("skipping" in line for line in logs), 3)
            first = content.etag

            time.sleep(0.02)
            extra = {"id": "w2", "subject": "words", "title": "More", "kind": "read",
                     "cards": [{"id": "w2.sun", "text": "sun"}]}
            (tmp / "decks" / "w2.json").write_text(json.dumps(extra), encoding="utf-8")
            content.refresh()
            self.assertIn("w2.sun", content.cards)
            self.assertNotEqual(content.etag, first)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class Backups(unittest.TestCase):
    def test_backup_once_per_day_and_pruned(self):
        tmp = Path(tempfile.mkdtemp(prefix="starcards-backup-"))
        try:
            write_content(tmp / "content")
            (tmp / "web").mkdir()
            app = server.App(tmp / "data", tmp / "web", tmp / "content", log=lambda m: None)
            folder = tmp / "data" / "backups"
            folder.mkdir()
            for n in range(1, 10):
                (folder / f"starcards-2020-01-0{n}.db").write_bytes(b"old")
            made = app.backup(keep=7)
            self.assertTrue(made and made.exists())
            self.assertIsNone(app.backup(keep=7))
            names = sorted(p.name for p in folder.glob("*.db"))
            self.assertEqual(len(names), 7)
            self.assertEqual(names[-1], made.name)
            import sqlite3
            con = sqlite3.connect(str(made))
            self.assertEqual(con.execute("SELECT COUNT(*) FROM profiles").fetchone()[0], 1)
            con.close()
            app.close()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
