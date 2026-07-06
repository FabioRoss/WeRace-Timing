"""Apex Timing live decoder.

Apex pushes newline-separated pipe commands over the websocket, maintaining an
HTML timing grid client-side. Verified against a live capture from Cremona
(tests/fixtures/cremona.ndjson). Line format is

    <target>|<class>|<value>[|<value2>...]

with the target first, then a CSS style class, then the text value:

    grid|<html table>        full grid; cells carry data-id="rXcY" (+ data-type)
    rXcY|class|text          set cell text + style. Time styles: tn=normal,
                             ti=personal best, tb=session best, ib=info.
                             Status column: sr=crossed line, si=pit in,
                             so=pit out, su=position up, in=idle. Indicator
                             column classes gm/gf/gl/gs are position-change
                             arrows (ignored); c12 carries an avg-speed-like
                             number at lap completion (ignored).
    rXcY||text               set text, keep style (e.g. position updates)
    rXcY|class|              set style, clear text (e.g. last lap at pit-in)
    rX|#|26                  move row X to standing position 26
    rX|*in|0 / rX|*out|0     kart entered / left the pit lane
    rX|*|<ms>|<ms>, *i1, *i2 lap-complete + sector reference times (ignored)
    dyn1|count|<ms>          session clock in milliseconds
    brNcM|class|text         "best" banner rows (best sectors/lap) (ignored)
    title1/title2|…|<text>   event + session names
    light|<class>|<value>    track light (green/yellow/red/finish)
    clear|grid / clear|      reset the grid
    init/css/js/msg/com/...  presentation-only, ignored

Row r0 is the header row when a grid frame was received; column meaning is
resolved from header cell data-type attributes and/or label text
(multilingual). When the stream starts mid-session (no grid frame),
DEFAULT_COLUMNS — the layout observed at Cremona — is used as a fallback.
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
BEST_ID = re.compile(r"^br\d+(c\d+)?$")
TAGS = re.compile(r"<[^>]+>")

# Column layout observed live at Cremona; used when no grid header was seen
# (stream joined mid-session). c1/c2 are status/indicator columns, c12 unclear.
DEFAULT_COLUMNS = {
    2: "status", 3: "position", 4: "kart", 5: "name",
    6: "s1", 7: "s2", 8: "s3",
    9: "last", 10: "best", 11: "gap", 13: "laps",
}

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

# Short CSS light classes (exact-token match only)
SHORT_LIGHT = {"lg": Flag.GREEN, "ly": Flag.YELLOW, "lr": Flag.RED, "lf": Flag.FINISH}


def strip_html(value: str) -> str:
    return TAGS.sub("", value).replace("&nbsp;", " ").replace("&amp;", "&").strip()


def _format_clock(ms: int) -> str:
    """Milliseconds -> "H:MM:SS" (or "MM:SS" under an hour)."""
    seconds = ms // 1000
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


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
        self.header_row: int | None = None             # only set by a grid frame
        self.row_pos: dict[int, int] = {}              # row -> standing position (rX|#|n)
        self.pit_rows: set[int] = set()                # rows currently in the pit lane
        self.race = RaceInfo()
        self.dirty = False
        self._last_count: int | None = None            # last dyn count sample (ms)
        self._count_down = False                       # dyn count direction

    # -------------------------------------------------------------- commands

    def apply(self, line: str) -> None:
        if not line:
            return
        parts = line.split("|")
        if len(parts) < 2:
            return
        target = parts[0].strip().lower()
        klass = parts[1].strip()
        value = "|".join(parts[2:]) if len(parts) > 2 else ""

        cell = CELL_ID.match(target)
        if cell:
            self._update_cell(int(cell.group(1)), int(cell.group(2)), klass, value)
            return
        row = ROW_ID.match(target)
        if row:
            self._row_command(int(row.group(1)), klass, value)
            return
        if BEST_ID.match(target):
            return  # best sector/lap banner — not needed for standings

        if target == "grid":
            self._load_grid("|".join(parts[1:]).lstrip("|"))
        elif target == "clear":
            self.cells.clear()
            self.row_order.clear()
            self.columns.clear()
            self.header_row = None
            self.row_pos.clear()
            self.pit_rows.clear()
            self.dirty = True
        elif target in ("dyn1", "dyn2"):
            self._dyn(klass, strip_html(value) if len(parts) > 2 else strip_html(klass))
        elif target in ("title", "title1"):
            text = strip_html(value) if len(parts) > 2 else strip_html(klass)
            if text:
                self.race.event_name = text
                self.dirty = True
        elif target == "title2":
            text = strip_html(value) if len(parts) > 2 else strip_html(klass)
            if text:
                self.race.run_type = text
                self.dirty = True
        elif target == "light":
            blob = f"{klass} {value}".lower()
            tokens = blob.split()
            flag = next((f for t, f in SHORT_LIGHT.items() if t in tokens), None)
            if flag is None:
                flag = next((f for needle, f in LIGHT_MAP if needle in blob), None)
            if flag is not None:
                self.race.flag = flag
            self.race.ended = self.race.flag == Flag.FINISH
            self.dirty = True
        else:
            # init/css/js/msg/com/track/weather/... — presentation only
            log.debug("apex: ignored command: %.80s", line)

    def _dyn(self, klass: str, text: str) -> None:
        """Session clock. `count` carries milliseconds; other dyns are text."""
        if klass == "count" and text.isdigit():
            ms = int(text)
            if self._last_count is not None and ms != self._last_count:
                self._count_down = ms < self._last_count
            self._last_count = ms
            clock = _format_clock(ms)
            if self._count_down:
                self.race.time_to_go = clock
                self.race.race_time = ""
            else:
                self.race.race_time = clock
            self.dirty = True
        elif text:
            self.race.time_to_go = text
            self.dirty = True

    def _row_command(self, row: int, klass: str, value: str) -> None:
        if klass == "#":
            try:
                self.row_pos[row] = int(strip_html(value))
            except ValueError:
                return
            self.dirty = True
        elif klass == "*in":
            self.pit_rows.add(row)
            self.dirty = True
        elif klass == "*out":
            self.pit_rows.discard(row)
            self.dirty = True
        # other rX|*... commands carry sector reference times for client-side
        # coloring — nothing to decode

    def _load_grid(self, html: str) -> None:
        parser = _GridHTMLParser()
        parser.feed(html)
        parser.close()
        self.cells.clear()
        self.row_pos.clear()
        self.pit_rows.clear()
        self.row_order = parser.row_order
        for cid, cell in parser.cells.items():
            m = CELL_ID.match(cid)
            if m:
                row, col = int(m.group(1)), int(m.group(2))
                self.cells[(row, col)] = cell
                if row not in self.row_order:
                    self.row_order.append(row)
        self.header_row = min(self.row_order) if self.row_order else None
        self._resolve_columns()
        self.dirty = True

    def _update_cell(self, row: int, col: int, klass: str, value: str) -> None:
        cell = self.cells.setdefault((row, col), {"text": "", "type": "", "class": ""})
        cell["text"] = strip_html(value)
        if klass:
            cell["class"] = klass
        if row not in self.row_order:
            self.row_order.append(row)
        if self.header_row is not None and row == self.header_row:
            self._resolve_columns()
        self.dirty = True

    # -------------------------------------------------------------- decoding

    def _resolve_columns(self) -> None:
        self.columns.clear()
        if self.header_row is None:
            return
        for (row, col), cell in self.cells.items():
            if row != self.header_row:
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
        columns = self.columns or DEFAULT_COLUMNS
        status_col = next((c for c, s in columns.items() if s == "status"), None)
        order = [r for r in self.row_order if r != self.header_row]
        positioned: list[tuple[int, DriverRow]] = []
        # sort key: best lap (unknown last), laps desc, stream appearance
        unpositioned: list[tuple[float, int, int, DriverRow]] = []
        for appearance, row in enumerate(order):
            values: dict[str, str] = {}
            for col, semantic in columns.items():
                cell = self.cells.get((row, col))
                if cell:
                    values[semantic] = cell["text"]
            kart_no = values.get("kart", "").strip()
            if not kart_no:
                # Header-less streams never populate the kart column; keep the
                # row under its grid id unless it carries no data at all.
                if not any(values.get(k) for k in ("name", "last", "best", "laps", "position")):
                    continue
                kart_no = str(row)
            # rX|#|n and the position-column text are absolute standings
            # positions maintained by the server (verified: no duplicates, no
            # best-lap inversions across a full practice capture).
            position = self.row_pos.get(row, 0)
            if not position:
                try:
                    position = int(re.sub(r"\D", "", values.get("position", "")) or 0)
                except ValueError:
                    position = 0
            status = values.get("status", "").lower()
            status_class = ""
            if status_col is not None:
                status_class = (self.cells.get((row, status_col)) or {}).get("class", "").lower()
            driver = DriverRow(
                kart_no=kart_no,
                name=values.get("name", ""),
                position=position,
                last_lap_ms=parse_duration_ms(values.get("last")),
                best_lap_ms=parse_duration_ms(values.get("best")),
                gap_ahead=values.get("interval", ""),
                gap_leader=values.get("gap", ""),
                laps=int(re.sub(r"\D", "", values.get("laps", "")) or 0),
                pits=int(re.sub(r"\D", "", values.get("pits", "")) or 0),
                in_pit=(
                    row in self.pit_rows
                    or status_class == "si"
                    or "pit" in status
                    or "pit" in status_class
                ),
            )
            if position:
                positioned.append((position, driver))
            else:
                best = driver.best_lap_ms if driver.best_lap_ms else float("inf")
                unpositioned.append((best, -driver.laps, appearance, driver))

        # Karts the server never (re)positioned while we were connected go
        # after the known block, ranked by best lap — in a mid-session join of
        # a practice session (no known positions at all) this yields exactly
        # "ordered by fastest time".
        positioned.sort(key=lambda t: t[0])
        unpositioned.sort(key=lambda t: t[:3])
        rows = [driver for _, driver in positioned]
        next_pos = positioned[-1][0] if positioned else 0
        for offset, (_, _, _, driver) in enumerate(unpositioned, start=1):
            driver.position = next_pos + offset
            rows.append(driver)
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
