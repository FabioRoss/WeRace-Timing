"""Parsing helpers for the time formats used by the timing providers.

MyWeR sends lap/pit times as "HH:MM:SS.ffffff" (all zeros meaning "no time").
Apex sends "M:SS.mmm", "SS.mmm" or plain seconds. Everything is normalized to
integer milliseconds; formatting back to text happens client-side.
"""

from __future__ import annotations

import re

_ZERO = re.compile(r"^[0:.,]*$")


def parse_duration_ms(value: str | None) -> int | None:
    """Parse a duration string into milliseconds. Returns None when absent/zero."""
    if not value:
        return None
    text = value.strip().replace(",", ".")
    if not text or _ZERO.match(text):
        return None

    fraction_ms = 0
    if "." in text:
        text, frac = text.split(".", 1)
        frac = re.sub(r"\D", "", frac)
        if frac:
            # Interpret as a decimal fraction of a second (handles .m, .mmm, .ffffff)
            fraction_ms = round(float("0." + frac) * 1000)

    parts = text.split(":")
    try:
        nums = [int(p or 0) for p in parts]
    except ValueError:
        return None

    if len(nums) == 3:
        h, m, s = nums
    elif len(nums) == 2:
        h, (m, s) = 0, nums
    elif len(nums) == 1:
        h, m, s = 0, 0, nums[0]
    else:
        return None

    total = ((h * 60 + m) * 60 + s) * 1000 + fraction_ms
    return total if total > 0 else None


def format_hms(value: str | None) -> str:
    """Normalize a clock string, dropping leading zero hours ("00:12:34" -> "12:34")."""
    if not value:
        return ""
    text = value.strip()
    if re.match(r"^00:\d{2}:\d{2}", text):
        return text[3:]
    return text
