#!/usr/bin/env python3
"""
make_cover_v3.py — Gallo Vault Sessions podcast episode cover generator.

Generates a 3000x3000 JPG cover per episode. EPISODE_NUM (below, or first
CLI argument) controls BOTH the episode label on the artwork and the output
filename, so every episode gets its own file:

    covers/gallo_vault_sessions_ep01.jpg
    covers/gallo_vault_sessions_ep02.jpg
    ...

The script refuses to overwrite an existing cover unless run with --force,
so no two episodes can ever clobber each other.

Usage:
    python3 make_cover_v3.py            # uses EPISODE_NUM below
    python3 make_cover_v3.py 7          # episode 7
    python3 make_cover_v3.py 7 --force  # regenerate, allow overwrite

Requires: Pillow  (pip install Pillow)
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# ── Config ───────────────────────────────────────────────────────────────────
EPISODE_NUM    = 1                              # ← change per episode (or pass on CLI)
SHOW_TITLE     = "GALLO VAULT"
SHOW_SUBTITLE  = "SESSIONS"
TAGLINE        = "STORIES FROM AFRICA'S OLDEST RECORD LABEL"
SIZE           = 3000                           # Apple Podcasts standard: 3000x3000
OUTPUT_DIR     = Path(__file__).parent / "covers"

# Colours
BG_TOP    = (12, 10, 8)        # near-black warm
BG_BOTTOM = (38, 24, 8)        # deep brown
GOLD      = (212, 168, 84)     # gallo gold
CREAM     = (242, 234, 218)
DIM       = (148, 128, 96)


def font(size, bold=True):
    """Best-available font: try common bold sans paths, fall back to default."""
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",          # macOS
        "/System/Library/Fonts/Helvetica.ttc",                        # macOS
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",       # Linux
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    if not bold:
        candidates = [c.replace("-Bold", "").replace(" Bold", "") for c in candidates]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def centered_text(draw, y, text, fnt, fill, tracking=0):
    """Draw horizontally centered text with optional letter-spacing."""
    if tracking:
        widths = [draw.textlength(ch, font=fnt) + tracking for ch in text]
        total = sum(widths) - tracking
        x = (SIZE - total) / 2
        for ch, w in zip(text, widths):
            draw.text((x, y), ch, font=fnt, fill=fill)
            x += w
    else:
        w = draw.textlength(text, font=fnt)
        draw.text(((SIZE - w) / 2, y), text, font=fnt, fill=fill)


def make_cover(episode_num: int) -> Path:
    img = Image.new("RGB", (SIZE, SIZE))
    draw = ImageDraw.Draw(img)

    # Vertical gradient background
    for y in range(SIZE):
        t = y / SIZE
        draw.line([(0, y), (SIZE, y)], fill=tuple(
            round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM)))

    # Vinyl record motif — concentric grooves, lower half
    cx, cy, r_max = SIZE // 2, int(SIZE * 1.18), int(SIZE * 0.78)
    for r in range(int(SIZE * 0.28), r_max, 28):
        alpha = max(18, 70 - (r * 40 // r_max))
        groove = tuple(min(255, c + alpha) for c in BG_BOTTOM)
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline=groove, width=4)
    # Gold label at record centre
    r_label = int(SIZE * 0.262)
    draw.ellipse([cx - r_label, cy - r_label, cx + r_label, cy + r_label],
                 outline=GOLD, width=10)

    # Gold frame
    m = 70
    draw.rectangle([m, m, SIZE - m, SIZE - m], outline=GOLD, width=8)
    m2 = m + 26
    draw.rectangle([m2, m2, SIZE - m2, SIZE - m2], outline=DIM, width=3)

    # Text block
    centered_text(draw, SIZE * 0.135, TAGLINE, font(72), DIM, tracking=18)
    centered_text(draw, SIZE * 0.205, SHOW_TITLE, font(360), CREAM, tracking=8)
    centered_text(draw, SIZE * 0.345, SHOW_SUBTITLE, font(300), GOLD, tracking=60)

    # Divider
    draw.line([(SIZE * 0.30, SIZE * 0.50), (SIZE * 0.70, SIZE * 0.50)], fill=GOLD, width=6)

    # Episode label — driven by EPISODE_NUM
    centered_text(draw, SIZE * 0.535, f"EPISODE {episode_num:02d}", font(150), CREAM, tracking=30)

    # ── Output — filename driven by the same episode number ────────────────
    OUTPUT_DIR.mkdir(exist_ok=True)
    output_file = OUTPUT_DIR / f"gallo_vault_sessions_ep{episode_num:02d}.jpg"

    if output_file.exists() and "--force" not in sys.argv:
        sys.exit(f"✗ {output_file.name} already exists — refusing to overwrite. "
                 f"Use --force to regenerate it.")

    img.save(output_file, "JPEG", quality=92)
    return output_file


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    ep = int(args[0]) if args else EPISODE_NUM
    out = make_cover(ep)
    print(f"✓ Saved {out}")
