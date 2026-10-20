#!/usr/bin/env python3
"""A stand-in for the piper binary, for the server tests (class Voices in test_server.py).

Takes piper's flags (--model, --output_file, --length_scale, --sentence_silence; anything else is
kept but ignored), reads the text from stdin and at once writes a tiny valid WAV (10 ms of silence)
to --output_file. When STARCARDS_FAKE_PIPER_LOG names a file, one JSON line per call is appended to
it (the flags, the text, the working directory), so a test can see exactly what the server asked for
and how often.

Two magic words make it misbehave on purpose: a text with SLOW in it sleeps 3 s (so the server's
timeout fires), one with FAIL exits 1 with a complaint on stderr (a broken voice).
"""
import json
import os
import sys
import time
import wave


def main(argv: list[str]) -> int:
    opts: dict = {}
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg.startswith("--") and i + 1 < len(argv) and not argv[i + 1].startswith("--"):
            opts[arg[2:]] = argv[i + 1]
            i += 2
        else:
            opts[arg.lstrip("-")] = True
            i += 1
    text = sys.stdin.read()
    if text.endswith("\n"):
        text = text[:-1]            # the one newline the server adds after the line
    log = os.environ.get("STARCARDS_FAKE_PIPER_LOG")
    if log:
        with open(log, "a", encoding="utf-8") as f:
            f.write(json.dumps({"text": text, "cwd": os.getcwd(), **opts}, ensure_ascii=False) + "\n")
    if "SLOW" in text:
        time.sleep(3)
    if "FAIL" in text:
        sys.stderr.write("fake piper: this voice is broken\n")
        return 1
    out = opts.get("output_file")
    if not isinstance(out, str):
        sys.stderr.write("fake piper: --output_file needed\n")
        return 2
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(22050)
        w.writeframes(b"\x00\x00" * 220)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
