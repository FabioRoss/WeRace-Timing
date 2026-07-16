"""Open Graph preview cards — dark, racey 1200×630 PNGs for link previews.

One shared racey base (a red chevron band on the right, a checkered accent strip,
and the WeRace Timing wordmark) drives four subjects: a saved result, an event, a
live dashboard, and the brand default. Pure Pillow drawing on plain data — the
callers (routers/results.py) assemble the data and 503 if Pillow is unavailable.
"""
from __future__ import annotations

import io
import os

_CARD_W, _CARD_H = 1200, 630          # standard OG / Twitter summary_large_image
_PAD = 70
_TEXT_MAX_X = 800                     # keep text clear of the right chevron band

_BG = (7, 8, 12)                      # brand near-black (#07080c)
_ACCENT = (225, 6, 0)                 # brand red (#e10600)
_ACCENT_DARK = (120, 12, 8)
_INK = (240, 242, 245)
_MUTED = (150, 156, 168)
_FONT_DIR = "/usr/share/fonts/truetype/dejavu"

# Flag pill colours: (background, text). `finish` is drawn as a checker pill.
_FLAG_PILL = {
    "green": ("GREEN FLAG", (40, 200, 90), (7, 8, 12)),
    "yellow": ("YELLOW", (240, 200, 40), (7, 8, 12)),
    "red": ("RED FLAG", (225, 6, 0), (255, 255, 255)),
    "warmup": ("WARM UP", (40, 120, 230), (255, 255, 255)),
    "stopped": ("STOPPED", (225, 6, 0), (255, 255, 255)),
    "none": ("STANDBY", (40, 44, 58), (200, 206, 216)),
}


def _font(size: int, bold: bool = True):
    from PIL import ImageFont
    path = os.path.join(_FONT_DIR, "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf")
    if os.path.exists(path):
        return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def _wrap(draw, text: str, font, max_w: int, max_lines: int = 2) -> list[str]:
    words, lines, cur = (text or "").split(), [], ""
    for w in words:
        trial = f"{cur} {w}".strip()
        if draw.textlength(trial, font=font) <= max_w:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines[:max_lines] or [""]


def _checker(draw, x, y, w, h, cell, c1=(232, 234, 242), c2=(18, 20, 29)) -> None:
    cols = (w + cell - 1) // cell
    rows = (h + cell - 1) // cell
    for r in range(rows):
        for c in range(cols):
            col = c1 if (r + c) % 2 == 0 else c2
            draw.rectangle(
                (x + c * cell, y + r * cell,
                 min(x + (c + 1) * cell, x + w) - 1, min(y + (r + 1) * cell, y + h) - 1),
                fill=col,
            )


def _chevrons(draw) -> None:
    """Slanted racing bands down the right third — dark / red / dark / deep-red."""
    palette = [(26, 28, 38), _ACCENT, (26, 28, 38), _ACCENT_DARK]
    x0, width, skew = 900, 46, 150
    for i, col in enumerate(palette):
        left = x0 + i * 66
        draw.polygon(
            [(left, 0), (left + width, 0),
             (left + width - skew, _CARD_H), (left - skew, _CARD_H)],
            fill=col,
        )


def _flag_pill(draw, x, y, flag: str) -> None:
    if flag == "finish":
        _checker(draw, x, y, 132, 42, 10)
        draw.text((x + 148, y + 7), "CHEQUERED", font=_font(24), fill=_INK)
        return
    entry = _FLAG_PILL.get(flag)
    if not entry:
        return
    label, bg, fg = entry
    font = _font(24)
    w = int(draw.textlength(label, font=font)) + 34
    draw.rounded_rectangle((x, y, x + w, y + 42), radius=8, fill=bg)
    draw.text((x + 17, y + 8), label, font=font, fill=fg)


def render_card(
    kicker: str,
    title: str,
    sub_parts: list[str] | None = None,
    rows: list[dict] | None = None,
    flag: str | None = None,
) -> bytes:
    """The one racey card. `rows` are {position, kart_no, name} podium/leader lines."""
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (_CARD_W, _CARD_H), _BG)
    draw = ImageDraw.Draw(img)

    _chevrons(draw)
    draw.rectangle((0, 0, _CARD_W, 8), fill=_ACCENT)         # top accent bar
    _checker(draw, 0, 8, _CARD_W, 12, 12)                    # checker strip under it

    draw.text((_PAD, 52), (kicker or "").upper(), font=_font(30), fill=_ACCENT)

    y = 104
    title_font = _font(62)
    for line in _wrap(draw, title, title_font, _TEXT_MAX_X - _PAD, max_lines=2):
        draw.text((_PAD, y), line, font=title_font, fill=_INK)
        y += 76

    sub = " · ".join(p for p in (sub_parts or []) if p)
    if sub:
        draw.text((_PAD, y + 2), sub, font=_font(30, bold=False), fill=_MUTED)
        y += 52

    if flag:
        _flag_pill(draw, _PAD, y + 8, flag)
        y += 62

    if rows:
        y += 10
        for r in rows[:3]:
            draw.text((_PAD, y), f"P{r.get('position') or '–'}", font=_font(40), fill=_ACCENT)
            name = f"#{r.get('kart_no', '')} {r.get('name', '')}".strip()
            draw.text((_PAD + 96, y + 5), name, font=_font(36, bold=False), fill=_INK)
            y += 58

    _checker(draw, _PAD, _CARD_H - 42, 54, 18, 9)
    draw.text((_PAD + 66, _CARD_H - 44), "WERACE TIMING", font=_font(26), fill=_MUTED)

    out = io.BytesIO()
    img.save(out, format="PNG")
    return out.getvalue()


def render_brand() -> bytes:
    """Generic site card for the landing page / results index / any other route."""
    return render_card(
        "Live kart timing",
        "WeRace Timing",
        ["Real-time race dashboards, results & sharing"],
    )
