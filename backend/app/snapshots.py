"""On-disk store for saved session snapshots (the results archive).

Isolates all snapshot disk I/O behind a small function API, mirroring the
recordings/backgrounds file-store conventions (path-safe ids, lazy mkdir,
atomic writes, a named docker volume). A snapshot record is a JSON dict:

    version, id, slot, created_at, expires_at|None, keep, published, trigger,
    name, track, tags[], private_notes, public_notes,
    snapshot: {<EventSnapshot>}, lap_history, pit_stops, messages,
    penalty_seq, original_penalties

The `snapshot` block is exactly the frontend `Snapshot`; the sibling blocks let
the backend rehydrate an EventState for PDF export and keep penalty ids stable.
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
import uuid
from pathlib import Path

from .config import get_settings

log = logging.getLogger(__name__)

SNAPSHOT_VERSION = 1
_ID_RE = re.compile(r"[A-Za-z0-9_-]+")

# The public-download PDF layout an operator can persist per snapshot. Keys
# mirror the export endpoint params (and the TimesheetPanel toggles). Applied by
# the public `timesheet.pdf` route as the default; explicit query params still
# override it.
PDF_CONFIG_DEFAULTS = {
    "charts": False, "grid": True, "pits": False, "stints": False,
    "pitest": False, "penalties": True,
    "event": "", "session": "", "accent": "#e10600",
}
_PDF_BOOL_KEYS = ("charts", "grid", "pits", "stints", "pitest", "penalties")
_PDF_STR_KEYS = ("event", "session", "accent")


def sanitize_pdf_config(config: dict | None) -> dict:
    """Keep only the recognised PDF-config keys, coerced to safe types."""
    config = config or {}
    out: dict = {}
    for key in _PDF_BOOL_KEYS:
        if key in config:
            out[key] = bool(config[key])
    for key in _PDF_STR_KEYS:
        if config.get(key) is not None:
            out[key] = str(config[key])[:120]
    return out


def effective_pdf_config(record: dict) -> dict:
    """A snapshot's saved PDF layout merged over the defaults (all keys present)."""
    return {**PDF_CONFIG_DEFAULTS, **sanitize_pdf_config(record.get("pdf_config"))}


def _dir() -> Path:
    # Read the setting fresh each call so tests can monkeypatch it cleanly.
    return get_settings().snapshots_dir


def _slug(text: str) -> str:
    cleaned = re.sub(r"[^\w\- ]+", "", text or "").strip().lower()
    return re.sub(r"\s+", "-", cleaned)[:48].strip("-")


def make_id(name: str) -> str:
    """A human-readable, unique, path-safe snapshot id (slug + short hash)."""
    return f"{_slug(name) or 'session'}-{uuid.uuid4().hex[:6]}"


def resolve_path(snapshot_id: str) -> Path:
    """Path of `{id}.json`, rejecting any traversal / unexpected characters."""
    directory = _dir().resolve()
    safe = Path(snapshot_id).name
    if safe != snapshot_id or not _ID_RE.fullmatch(safe):
        raise ValueError("invalid snapshot id")
    return directory / f"{safe}.json"


def write_record(record: dict) -> None:
    """Atomically write (create or overwrite) a record to `{id}.json`."""
    path = resolve_path(record["id"])
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(record), encoding="utf-8")
    os.replace(tmp, path)  # atomic on the same filesystem


def load_record(snapshot_id: str) -> dict | None:
    try:
        path = resolve_path(snapshot_id)
    except ValueError:
        return None
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        log.warning("snapshot %s is unreadable/corrupt", snapshot_id)
        return None


def list_records() -> list[dict]:
    """All records, newest first. Parses each file — fine at club scale; a
    lightweight index could be added later if the archive grows large."""
    directory = _dir()
    if not directory.is_dir():
        return []
    out: list[dict] = []
    for path in directory.glob("*.json"):
        try:
            out.append(json.loads(path.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, OSError):
            continue
    out.sort(key=lambda r: r.get("created_at", 0), reverse=True)
    return out


def delete_record(snapshot_id: str) -> bool:
    path = resolve_path(snapshot_id)
    if not path.is_file():
        return False
    path.unlink()
    return True


def gc_expired(now: float | None = None) -> int:
    """Delete snapshots past their expiry that aren't flagged to keep. Returns
    the number removed."""
    now = time.time() if now is None else now
    removed = 0
    for record in list_records():
        if record.get("keep"):
            continue
        exp = record.get("expires_at")
        if exp is not None and exp < now:
            try:
                if delete_record(record["id"]):
                    removed += 1
            except (ValueError, OSError):
                continue
    if removed:
        log.info("snapshot GC removed %d expired record(s)", removed)
    return removed


# --------------------------------------------------------------- projections

def _podium(drivers: list[dict]) -> list[dict]:
    return [
        {"position": d.get("position"), "kart_no": d.get("kart_no"), "name": d.get("name")}
        for d in drivers[:3]
    ]


def meta_of(record: dict) -> dict:
    """Lightweight list/card projection (no heavy lap data or private notes)."""
    snap = record.get("snapshot", {})
    drivers = snap.get("drivers", [])
    race = snap.get("race", {})
    return {
        "id": record.get("id", ""),
        "name": record.get("name", ""),
        "track": record.get("track", ""),
        "tags": record.get("tags", []),
        "created_at": record.get("created_at"),
        "expires_at": record.get("expires_at"),
        "keep": record.get("keep", False),
        "published": record.get("published", False),
        "trigger": record.get("trigger", ""),
        "slot": record.get("slot"),
        "group_id": record.get("group_id"),
        "group_name": record.get("group_name", ""),
        "event_name": race.get("event_name", ""),
        "run_type": race.get("run_type", ""),
        "driver_count": len(drivers),
        "podium": _podium(drivers),
    }


def og_meta(record: dict) -> dict:
    """Open Graph / link-preview fields for a published result: a title, a
    podium+track description, and the paths for the preview image + page."""
    meta = meta_of(record)
    podium = " · ".join(
        f"P{p['position']} #{p['kart_no']} {p['name']}".strip() for p in meta["podium"]
    )
    description = " — ".join(b for b in (podium, meta["track"]) if b) or "Race results"
    return {
        "title": meta["name"] or "Results",
        "description": description,
        "image_path": f"/api/results/{meta['id']}/card.png",
        "url_path": f"/results/{meta['id']}",
    }


def list_groups(published_only: bool = False) -> list[dict]:
    """Derive events (snapshot groups) from the store. An event bundles the
    snapshots sharing a `group_id`; sessions are ordered oldest-first (so
    Practice → Qualifying → Race read in order) and events newest-first."""
    records = list_records()
    if published_only:
        records = [r for r in records if r.get("published")]
    groups: dict[str, dict] = {}
    for rec in records:
        gid = rec.get("group_id")
        if not gid:
            continue
        group = groups.get(gid)
        if group is None:
            group = groups[gid] = {
                "id": gid, "name": rec.get("group_name") or "",
                "track": rec.get("track") or "", "sessions": [],
            }
        group["sessions"].append(meta_of(rec))
    events = list(groups.values())
    for group in events:
        group["sessions"].sort(key=lambda m: m.get("created_at") or 0)
        if not group["name"]:
            group["name"] = group["sessions"][0]["name"] if group["sessions"] else group["id"]
    events.sort(
        key=lambda g: max((s.get("created_at") or 0 for s in g["sessions"]), default=0),
        reverse=True,
    )
    return events


def public_view(record: dict) -> dict:
    """Public detail payload: the renderable snapshot + public notes, with
    private notes and internal-only blocks stripped."""
    view = meta_of(record)
    view["snapshot"] = record.get("snapshot", {})
    view["public_notes"] = record.get("public_notes", "")
    return view
