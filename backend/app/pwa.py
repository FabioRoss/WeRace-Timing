"""Installable driver app ("WR Timing").

The driver dashboard is meant to be added to a phone's home screen. One app
identity (`id` /drive) covers every race, so installing once is enough: the app
always opens the launcher (/drive), which forwards to the last driver link used
on that phone, or offers to scan the next race's QR code.

`start_url` carries the link the app was installed from (`/drive?to=...`)
because iOS gives a home-screen app its own storage, empty at first launch —
without it, the first launch wouldn't know where to go.
"""
from __future__ import annotations

import re
from html import escape
from urllib.parse import quote

APP_NAME = "WR Timing"
THEME = "#07080c"

# /e/<slot>/driver/<token> — the only links the launcher will forward to.
DRIVER_PATH = re.compile(r"^/e/\d{1,3}/driver/[0-9a-f]{16}$")
_PWA_PAGE = re.compile(r"^(?:drive|e/\d{1,3}/driver/[0-9a-f]{16})$")


def is_driver_path(path: str) -> bool:
    return bool(DRIVER_PATH.match(path))


def manifest(to: str | None = None) -> dict:
    start = "/drive"
    if to and is_driver_path(to):
        start += "?to=" + quote(to, safe="")
    return {
        "id": "/drive",
        "name": APP_NAME,
        "short_name": APP_NAME,
        "description": "Live in-kart timing for WeRace drivers.",
        "start_url": start,
        "scope": "/",
        "display": "fullscreen",
        "display_override": ["fullscreen", "standalone"],
        "orientation": "landscape",
        "background_color": THEME,
        "theme_color": THEME,
        "categories": ["sports"],
        "icons": [
            {"src": "/icons/wr-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
            {"src": "/icons/wr-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
            {"src": "/icons/wr-maskable-192.png", "sizes": "192x192", "type": "image/png",
             "purpose": "maskable"},
            {"src": "/icons/wr-maskable-512.png", "sizes": "512x512", "type": "image/png",
             "purpose": "maskable"},
        ],
    }


def head_tags(path: str) -> str | None:
    """Install tags for the driver pages and the launcher (path without the
    leading slash, as the SPA route receives it); None elsewhere."""
    if not _PWA_PAGE.match(path):
        return None
    href = "/api/pwa/manifest.webmanifest"
    if path != "drive":
        href += "?to=" + quote("/" + path, safe="")
    tags = [
        f'<link rel="manifest" href="{escape(href, quote=True)}" />',
        '<meta name="mobile-web-app-capable" content="yes" />',
        '<meta name="apple-mobile-web-app-capable" content="yes" />',
        f'<meta name="apple-mobile-web-app-title" content="{APP_NAME}" />',
        '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />',
        f'<meta name="application-name" content="{APP_NAME}" />',
    ]
    return "".join(tags)
