#!/usr/bin/env python3
"""Build the no-server copy of Star Cards for GitHub Pages (or any static host).

    python tools/build_static.py            # writes ./docs
    python tools/build_static.py out-dir

The static copy is the same app, but with no Python server behind it: web/js/static-api.js
answers every API call from the browser's own storage, so each visitor has private progress and
the 🙋 Help button is off. The content bundle is written as content.json, and the few absolute
URLs in the pages are made relative so the site works under a sub-path such as /Lesson/.
"""
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import server  # noqa: E402


def rewrite(path: Path, pairs) -> None:
    text = path.read_text(encoding="utf-8")
    for old, new in pairs:
        if old not in text:
            raise SystemExit(f"{path.name}: expected to find {old!r}; the page changed, update build_static.py")
        text = text.replace(old, new)
    path.write_text(text, encoding="utf-8")


def main(out_name: str = "docs") -> int:
    out = ROOT / out_name
    content = server.Content(ROOT / "content", log=lambda m: None)
    if not content.decks:
        raise SystemExit("no content loaded; run tools/validate_content.py first")
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(ROOT / "web", out, ignore=shutil.ignore_patterns("__pycache__"))
    (out / "content.json").write_bytes(content.body)
    (out / ".nojekyll").write_text("", encoding="utf-8")

    rewrite(out / "index.html", [
        ('href="/', 'href="./'),
        ('src="/', 'src="./'),
        ('<script type="module"', '<script>window.STARCARDS_STATIC = true;</script>\n  <script type="module"'),
    ])
    manifest = out / "manifest.webmanifest"
    data = json.loads(manifest.read_text(encoding="utf-8"))
    data["start_url"] = "./"
    data["scope"] = "./"
    for icon in data.get("icons", []):
        icon["src"] = "." + icon["src"]
    manifest.write_text(json.dumps(data, indent=2), encoding="utf-8")
    rewrite(out / "css" / "app.css", [('url("/fonts/', 'url("../fonts/')])
    rewrite(out / "tests" / "index.html", [
        ('"/css/', '"../css/'),
        ('"/tests/', '"./'),
        ('<script type="module"', '<script>window.STARCARDS_STATIC = true;</script>\n  <script type="module"'),
    ])
    rewrite(out / "tests" / "tests.js", [
        ("'/js/", "'../js/"),
        ("'/tests/stat_vectors.json'", "'./stat_vectors.json'"),
        ("'/content.json'", "'../content.json'"),
    ])
    rewrite(out / "js" / "views" / "grownups" / "settings.js", [("'/tests/'", "'tests/'")])

    decks = len(content.decks)
    cards = len(content.cards)
    print(f"static copy written to {out} ({decks} decks, {cards} cards, content {content.etag.strip(chr(34))})")
    return 0


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:2]))
