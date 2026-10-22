#!/usr/bin/env python3
"""Fill the natural-voice cache ahead of the child: every story line, word and sound, then every question.

    python3 tools/prerender_tts.py --data-dir /var/lib/starcards                 # on the Pi, as user starcards
    python3 tools/prerender_tts.py --data-dir /var/lib/starcards --what stories --voice en_US-ryan-medium

The server does the same by itself in the background after every start (--tts-prerender in server.py);
deploy/install-voices.sh runs this once right after installing the voices, so the stories are ready
before the first bedtime. It uses server.py's own Tts and corpus (the sounds as web/js/phonics.js spells
them, cut without a pause), so a clip made here is exactly the clip the tablet gets, and one run at a
time holds the cache's prerender.lock: when the service is already at it, this says so and leaves it
to the service.

Exit 0 when every clip is there (or another run is making them), 1 when some could not be made,
2 when no voice is set up.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import server  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Render the Star Cards stories and questions with the natural voice")
    ap.add_argument("--data-dir", type=Path, default=ROOT / "data",
                    help="the server's data folder: piper/ and the clip cache tts/ live under it "
                         "(on the Pi: /var/lib/starcards)")
    ap.add_argument("--content-dir", type=Path, default=ROOT / "content",
                    help="folder with subjects.json and decks/ (default: ./content)")
    ap.add_argument("--piper", default=os.environ.get("STARCARDS_TTS_CMD"), metavar="CMD",
                    help="piper command (default: <data-dir>/piper/piper/piper)")
    ap.add_argument("--voices", type=Path, default=os.environ.get("STARCARDS_TTS_VOICES"), metavar="DIR",
                    help="folder of voices (default: <data-dir>/piper/voices)")
    ap.add_argument("--cache", type=Path, metavar="DIR", help="clip cache (default: <data-dir>/tts)")
    ap.add_argument("--voice", default=os.environ.get("STARCARDS_TTS_DEFAULT_VOICE", "en_US-amy-medium"), metavar="ID",
                    help="which voice to render with (default: en_US-amy-medium, else the first voice found)")
    ap.add_argument("--rate", type=float, default=server.READ_RATE,
                    help=f"the story pace to render at (default: {server.READ_RATE}, the Read screen's default)")
    ap.add_argument("--quiz-rate", type=float, default=server.QUIZ_RATE,
                    help=f"the question pace to render at (default: {server.QUIZ_RATE}, the quiz's default)")
    ap.add_argument("--what", choices=("stories", "all"), default="all",
                    help="stories: lines, words and sounds only; all: the questions too (default)")
    ap.add_argument("--pause", type=float, default=0.25, help="seconds to rest after each clip (default: 0.25)")
    args = ap.parse_args(argv)

    def log(msg: str) -> None:
        print(msg, flush=True)

    sounds = server.SoundStrings(ROOT / "web", log=log)      # what 🔤 Sound it out says, from web/js/phonics.js
    tts = server.find_tts(args.data_dir, args.piper, args.voices, args.cache, args.voice, log=log, sounds=sounds)
    if not tts.enabled:
        log("No voice is set up: run deploy/install-voices.sh on the Pi first "
            f"(looked for piper at {args.piper or args.data_dir / 'piper' / 'piper' / 'piper'} "
            f"and voices in {tts.voices_dir}).")
        return 2
    voice = args.voice if args.voice in {v["id"] for v in tts.voices()} else tts.default_voice
    if voice != args.voice:
        log(f"Voice {args.voice} is not installed; using {voice}.")
    content = server.Content(args.content_dir, log=log)
    items = server.tts_corpus(content, args.what, read_rate=server.clamp_rate(args.rate),
                              quiz_rate=server.clamp_rate(args.quiz_rate), sounds=sounds.strings)
    counts = tts.prerender(items, voice_id=voice, pause=args.pause)
    if counts["stopped"] == "busy":
        return 0
    return 1 if counts["failed"] or counts["stopped"] else 0


if __name__ == "__main__":
    sys.exit(main())
