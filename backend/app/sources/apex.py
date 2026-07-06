"""Apex Timing live decoder.

Apex pushes newline-separated pipe commands over the websocket, maintaining an
HTML timing grid client-side:

    grid|<html table>            full grid; cells carry data-id="rXcY" (+ data-type)
    update|rXcY|<value>|<class>  update one cell (value may contain HTML)
    update|rX||<class>           row style update
    css|rXcY|<class>             cell style only
    clear|grid / clear|          reset the grid
    dyn1|<text>                  session clock / countdown
    title|<text> or title1/2     event + session names
    light|<value>                track light (green/yellow/red/finish)
    msg|<text> / com|<html>      race control messages / commentary
    best|...                     session best info

Row r0 is the header row; column meaning is resolved from header cell
data-type attributes and/or label text (multilingual). This decoder was built
from the documented protocol without live captures — use the built-in
recorder to capture real sessions and refine (see README).
"""

from __future__ import annotations

import logging
import re
from html.parser import HTMLParser

from ..models import DriverRow, Flag, RaceInfo
from ..timeparse import parse_duration_ms
from .base import WebSocketSource

log = logging.getLogger(__name__)

CELL_ID = re.compile(r"^r(\d+)c(\d+)$")
ROW_ID = re.compile(r"^r(\d+)$")
TAGS = re.compile(r"<[^>]+>")

# Column semantics by data-type attribute (observed values across deployments)
TYPE_MAP = {
    "sta": "status", "rk": "position", "no": "kart", "dr": "name",
    "nat": "nation", "llp": "last", "blp": "best", "gap": "gap",
    "int": "interval", "lap": "laps", "tlp": "laps", "pit": "pits",
    "otr": "ontrack", "s1": "s1", "s2": "s2", "s3": "s3",
}

# Fallback: header label text (fr/en/it/de) -> semantic
LABEL_MAP = [
    (re.compile(r"^(clt|pos|rk|rank|clas)", re.I), "position"),
    (re.compile(r"^(no|n°|num|kart)", re.I), "kart"),
    (re.compile(r"(pilote|driver|team|equipe|squadra|pilota|name|nom)", re.I), "name"),
    (re.compile(r"(dernier|last|ultimo|letzte|tour$|tps|lap time)", re.I), "last"),
    (re.compile(r"(meilleur|best|migliore|beste)", re.I), "best"),
    (re.compile(r"(ecart|écart|gap|distacco)", re.I), "gap"),
    (re.compile(r"(interv|int\.)", re.I), "interval"),
    (re.compile(r"(tours|laps|giri|runden)", re.I), "laps"),
    (re.compile(r"(stands|pits|pit stop|box)", re.I), "pits"),
]

LIGHT_MAP = [
    ("green", Flag.GREEN), ("yellow", Flag.YELLOW), ("warn", Flag.YELLOW),
    ("red", Flag.RED), ("stop", Flag.STOPPED),
    ("chk", Flag.FINISH), ("check", Flag.FINISH), ("finish", Flag.FINISH),
    ("end", Flag.FINISH), ("off", Flag.NONE),
]


def strip_html(value: str) -> str:
    return TAGS.sub("", value).replace("&nbsp;", " ").replace("&amp;", "&").strip()


class _GridHTMLParser(HTMLParser):
    """Extracts cells (data-id/id -> {text, type}) from an Apex grid table."""

    def __init__(self) -> None:
        super().__init__()
        self.cells: dict[str, dict] = {}
        self.row_order: list[int] = []
        self._current: str | None = None
        self._buf: list[str] = []

    def handle_starttag(self, tag: str, attrs) -> None:
        a = dict(attrs)
        if tag == "tr":
            rid = a.get("data-id") or a.get("id") or ""
            m = ROW_ID.match(rid)
            if m:
                self.row_order.append(int(m.group(1)))
        elif tag in ("td", "th"):
            cid = a.get("data-id") or a.get("id") or ""
            if CELL_ID.match(cid):
                self._flush()
                self._current = cid
                self.cells[cid] = {
                    "text": "",
                    "type": a.get("data-type", ""),
                    "class": a.get("class", ""),
                }

    def handle_endtag(self, tag: str) -> None:
        if tag in ("td", "th"):
            self._flush()

    def handle_data(self, data: str) -> None:
        if self._current:
            self._buf.append(data)

    def _flush(self) -> None:
        if self._current:
            self.cells[self._current]["text"] = " ".join(
                "".join(self._buf).split()
            )
            self._current = None
            self._buf = []


class ApexGrid:
    """Stateful mirror of the Apex timing grid."""

    def __init__(self) -> None:
        self.cells: dict[tuple[int, int], dict] = {}   # (row, col) -> {text, type, class}
        self.row_order: list[int] = []
        self.columns: dict[int, str] = {}              # col index -> semantic
        self.race = RaceInfo()
        self.dirty = False

    # -------------------------------------------------------------- commands

    def apply(self, line: str) -> None:
        if not line:
            return
        parts = line.split("|")
        cmd = parts[0].strip().lower()

        if cmd == "grid" and len(parts) >= 2:
            self._load_grid("|".join(parts[1:]))
        elif cmd == "update" and len(parts) >= 3:
            self._update_cell(parts[1].strip(), "|".join(parts[2:-1]) if len(parts) > 3 else parts[2])
        elif cmd == "css":
            pass  # style-only, no data value
        elif cmd == "clear":
            self.cells.clear()
            self.row_order.clear()
            self.columns.clear()
            self.dirty = True
        elif cmd in ("dyn1", "dyn2"):
            text = strip_html("|".join(parts[1:]))
            if text:
                self.race.time_to_go = text
                self.dirty = True
        elif cmd in ("title", "title1"):
            text = strip_html("|".join(parts[1:]))
            if text:
                self.race.event_name = text
                self.dirty = True
        elif cmd == "title2":
            text = strip_html("|".join(parts[1:]))
            if text:
                self.race.run_type = text
                self.dirty = True
        elif cmd == "light":
            value = "|".join(parts[1:]).lower()
            for needle, flag in LIGHT_MAP:
                if needle in value:
                    self.race.flag = flag
                    break
            self.race.ended = self.race.flag == Flag.FINISH
            self.dirty = True

    def _load_grid(self, html: str) -> None:
        parser = _GridHTMLParser()
        parser.feed(html)
        parser.close()
        self.cells.clear()
        self.row_order = parser.row_order
        for cid, cell in parser.cells.items():
            m = CELL_ID.match(cid)
            if m:
                row, col = int(m.group(1)), int(m.group(2))
                self.cells[(row, col)] = cell
                if row not in self.row_order:
                    self.row_order.append(row)
        self._resolve_columns()
        self.dirty = True

    def _update_cell(self, target: str, value: str) -> None:
        m = CELL_ID.match(target)
        if not m:
            return  # row-level style update
        row, col = int(m.group(1)), int(m.group(2))
        cell = self.cells.setdefault((row, col), {"text": "", "type": "", "class": ""})
        cell["text"] = strip_html(value)
        if row not in self.row_order:
            self.row_order.append(row)
        if row == self._header_row():
            self._resolve_columns()
        self.dirty = True

    # -------------------------------------------------------------- decoding

    def _header_row(self) -> int:
        return min(self.row_order) if self.row_order else 0

    def _resolve_columns(self) -> None:
        self.columns.clear()
        header = self._header_row()
        for (row, col), cell in self.cells.items():
            if row != header:
                continue
            semantic = TYPE_MAP.get(cell.get("type", "").lower(), "")
            if not semantic:
                text = cell.get("text", "")
                for pattern, name in LABEL_MAP:
                    if text and pattern.search(text):
                        semantic = name
                        break
            if semantic:
                self.columns[col] = semantic

    def standings(self) -> list[DriverRow]:
        header = self._header_row()
        rows: list[DriverRow] = []
        order = [r for r in self.row_order if r != header]
        for fallback_pos, row in enumerate(order, start=1):
            values: dict[str, str] = {}
            for col, semantic in self.columns.items():
                cell = self.cells.get((row, col))
                if cell:
                    values[semantic] = cell["text"]
            kart_no = values.get("kart", "").strip()
            if not kart_no:
                continue
            try:
                position = int(re.sub(r"\D", "", values.get("position", "")) or 0)
            except ValueError:
                position = 0
            status = values.get("status", "").lower()
            row_class = (self.cells.get((row, 0), {}) or {}).get("class", "").lower()
            rows.append(
                DriverRow(
                    kart_no=kart_no,
                    name=values.get("name", ""),
                    position=position or fallback_pos,
                    last_lap_ms=parse_duration_ms(values.get("last")),
                    best_lap_ms=parse_duration_ms(values.get("best")),
                    gap_ahead=values.get("interval", ""),
                    gap_leader=values.get("gap", ""),
                    laps=int(re.sub(r"\D", "", values.get("laps", "")) or 0),
                    pits=int(re.sub(r"\D", "", values.get("pits", "")) or 0),
                    in_pit="pit" in status or "pit" in row_class,
                )
            )
        rows.sort(key=lambda d: d.position if d.position > 0 else 999)
        return rows


class ApexSource(WebSocketSource):
    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.grid = ApexGrid()

    async def handle_frame(self, text: str) -> None:
        for line in text.replace("\r", "").split("\n"):
            line = line.strip()
            if line:
                try:
                    self.grid.apply(line)
                except Exception:
                    log.exception("apex: failed command: %.200s", line)
        if self.grid.dirty:
            self.grid.dirty = False
            await self.on_data(self.grid.race.model_copy(), self.grid.standings())
