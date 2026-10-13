"""Draw the app icons (a gold star on cream) with Pillow. Run once; the PNGs are committed.

    python tools/make_icons.py
"""
import math
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:
    sys.exit("Pillow is needed: pip install pillow")

OUT = Path(__file__).resolve().parent.parent / "web" / "icons"
CREAM = (255, 248, 238)
GOLD = (245, 185, 66)
GOLD_EDGE = (214, 148, 30)
INK = (43, 45, 66)


def star_points(cx, cy, outer, inner, points=5):
    pts = []
    for i in range(points * 2):
        r = outer if i % 2 == 0 else inner
        a = -math.pi / 2 + i * math.pi / points
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def draw(size: int, rounded: bool) -> Image.Image:
    scale = 4
    big = size * scale
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    radius = int(big * 0.22) if rounded else 0
    d.rounded_rectangle((0, 0, big - 1, big - 1), radius=radius, fill=CREAM)
    # soft card behind the star
    pad = int(big * 0.17)
    d.rounded_rectangle((pad, pad, big - pad, big - pad), radius=int(big * 0.14), fill=(255, 255, 255),
                        outline=(231, 223, 208), width=max(2, big // 90))
    cx = cy = big / 2
    d.polygon(star_points(cx, cy + big * 0.02, big * 0.30, big * 0.125), fill=GOLD, outline=GOLD_EDGE,
              width=max(2, big // 60))
    # a cheeky face so it reads as "for kids" at icon size
    eye = big * 0.022
    for ex in (cx - big * 0.055, cx + big * 0.055):
        d.ellipse((ex - eye, cy - eye, ex + eye, cy + eye), fill=INK)
    d.arc((cx - big * 0.07, cy - big * 0.02, cx + big * 0.07, cy + big * 0.08), start=20, end=160, fill=INK,
          width=max(2, big // 70))
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    # iOS draws its own rounded mask over apple-touch-icon, so that one is square.
    draw(180, rounded=False).convert("RGB").save(OUT / "apple-touch-icon.png", optimize=True)
    draw(192, rounded=True).save(OUT / "icon-192.png", optimize=True)
    draw(512, rounded=True).save(OUT / "icon-512.png", optimize=True)
    draw(64, rounded=True).save(OUT / "favicon.png", optimize=True)
    print("icons written to", OUT)


if __name__ == "__main__":
    main()
