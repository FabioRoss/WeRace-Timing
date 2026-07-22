from __future__ import annotations

import io
import statistics
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Response

# reportlab is an optional/heavy dependency. Import it defensively (mirroring the
# lazy `import qrcode` in public.py) so that if it is ever missing from an image
# the app still boots and only the timesheet endpoint 503s — a missing export
# dependency must never take the whole server down.
try:
    from reportlab.graphics.charts.barcharts import VerticalBarChart
    from reportlab.graphics.charts.lineplots import LinePlot
    from reportlab.graphics.shapes import Drawing, String
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.pdfgen import canvas as pdfcanvas
    from reportlab.platypus import (
        Flowable,
        KeepTogether,
        PageBreak,
        Paragraph,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
    )

    _REPORTLAB_OK = True

    # Light, print-friendly palette with red/black accents (mirrors the dashboard
    # brand: --color-race-red, --color-pit-950, --color-ink-100).
    RACE_RED = colors.HexColor("#e10600")
    RED_TINT = colors.HexColor("#fde7e6")     # leader row / accents
    INK_BLACK = colors.HexColor("#14161f")
    BADGE_INK = colors.HexColor("#20242f")    # position badge
    ROW_ALT = colors.HexColor("#f6f7fa")      # zebra
    LINE_GREY = colors.HexColor("#e3e6ee")
    SOFT_GREY = colors.HexColor("#8b93a7")
    CHECK_DARK = colors.HexColor("#14161f")
    CHECK_LIGHT = colors.HexColor("#f4f6fb")

    # Single content width shared by every block (header band, classification,
    # charts, lap grid) so they all align to the same left and right edges.
    # A4 portrait (210mm) minus the 12mm document margins on each side.
    CONTENT_W = 186 * mm

    def _accent_kit(hexstr: str) -> dict:
        """Derive the accent colours used across the sheet from one hex value, so
        any accent (incl. light ones like yellow/neon-green) stays legible:
        - accent : the colour itself (fills — header, spine, chart bars)
        - text   : white or ink, whichever contrasts with the accent (text ON it)
        - tint   : a near-white wash of the accent (leader-row background)
        - dark   : a darkened accent that reads on white (coloured text — fastest lap)
        """
        try:
            c = colors.HexColor(hexstr)
        except Exception:
            c = colors.HexColor("#e10600")
        lum = 0.299 * c.red + 0.587 * c.green + 0.114 * c.blue
        return {
            "accent": c,
            "text": colors.white if lum < 0.6 else colors.HexColor("#14161f"),
            "tint": colors.Color(1 - (1 - c.red) * 0.16, 1 - (1 - c.green) * 0.16,
                                 1 - (1 - c.blue) * 0.16),
            "dark": colors.Color(c.red * 0.55, c.green * 0.55, c.blue * 0.55),
        }

    class NumberedCanvas(pdfcanvas.Canvas):
        """Buffers pages so a 'Page N of M' footer can be stamped once the total
        is known (the standard reportlab two-pass recipe)."""

        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._saved_page_states = []

        def showPage(self):
            self._saved_page_states.append(dict(self.__dict__))
            self._startPage()

        def save(self):
            total = len(self._saved_page_states)
            for state in self._saved_page_states:
                self.__dict__.update(state)
                # Brand link bottom-left on every page.
                self.setFont("Helvetica", 8)
                self.setFillColor(SOFT_GREY)
                self.drawString(12 * mm, 8 * mm, "timing.we-race.it")
                if total > 1:  # no "Page 1 of 1" on a single-page sheet
                    self.drawRightString(
                        self._pagesize[0] - 12 * mm, 8 * mm,
                        f"Page {self._pageNumber} of {total}",
                    )
                super().showPage()
            super().save()

    class HeaderBand(Flowable):
        """A modern hero band: dark rounded panel with a checker strip, the event
        title and a meta line. Replaces the old plain paragraph header."""

        def __init__(self, title: str, meta: str, accent=RACE_RED, height: float = 26 * mm,
                     status: str = "", status_color=None):
            super().__init__()
            self.title = title
            self.meta = meta
            self.accent = accent
            self.height = height
            self.status = status
            self.status_color = status_color or accent
            self.width = 0.0

        def wrap(self, avail_w: float, avail_h: float):
            self.width = avail_w
            return (avail_w, self.height)

        def draw(self):
            c = self.canv
            w, h = self.width, self.height
            c.setFillColor(INK_BLACK)
            c.roundRect(0, 0, w, h, 4 * mm, stroke=0, fill=1)
            # Accent spine on the left.
            c.setFillColor(self.accent)
            c.roundRect(0, 0, 4 * mm, h, 2 * mm, stroke=0, fill=1)
            c.rect(2 * mm, 0, 2 * mm, h, stroke=0, fill=1)
            # Checker strip near the top.
            cell = 3.2 * mm
            cols = 6
            x0, y0 = 9 * mm, h - 7 * mm
            for i in range(cols):
                for j in range(2):
                    c.setFillColor(CHECK_LIGHT if (i + j) % 2 == 0 else CHECK_DARK)
                    c.rect(x0 + i * cell, y0 + j * cell, cell, cell, stroke=0, fill=1)
            # Title + meta.
            c.setFillColor(colors.white)
            c.setFont("Helvetica-Bold", 20)
            title = self.title if len(self.title) <= 46 else self.title[:45] + "…"
            c.drawString(9 * mm, h - 15 * mm, title)
            c.setFillColor(colors.HexColor("#c7ccda"))
            c.setFont("Helvetica", 9.5)
            c.drawString(9 * mm, h - 21 * mm, self.meta)
            # Status pill (PROVISIONAL / DEFINITIVE) on the right.
            if self.status:
                c.setFont("Helvetica-Bold", 9)
                tw = c.stringWidth(self.status, "Helvetica-Bold", 9)
                pill_w = tw + 8 * mm
                px = w - pill_w - 7 * mm
                py = h - 16 * mm
                c.setFillColor(self.status_color)
                c.roundRect(px, py, pill_w, 7 * mm, 3.5 * mm, stroke=0, fill=1)
                c.setFillColor(colors.white)
                c.drawCentredString(px + pill_w / 2, py + 2.2 * mm, self.status)

except ImportError:  # pragma: no cover - only when the dep is absent
    _REPORTLAB_OK = False

from .. import snapshots
from ..models import DriverRow
from ..security import check_safeword
from ..state import EventState, _classify_gap
from .public import get_event

router = APIRouter()

# One column per kart in the lap grid; portrait A4 fits ~10 comfortably before a
# block wraps onto the next page.
MAX_GRID_KARTS = 10


def fmt_lap_ms(ms: int | None) -> str:
    """Milliseconds -> "M:SS.mmm" (matches the frontend fmtLap)."""
    if not ms or ms <= 0:
        return "—"
    total = ms // 1000
    return f"{total // 60}:{total % 60:02d}.{ms % 1000:03d}"


def fmt_total_ms(ms: int | None) -> str:
    """Milliseconds -> "H:MM:SS.mmm" cumulative time."""
    if not ms or ms <= 0:
        return "—"
    total = ms // 1000
    h, m, s = total // 3600, (total % 3600) // 60, total % 60
    return f"{h}:{m:02d}:{s:02d}.{ms % 1000:03d}"


def fmt_clock(ms: int | None) -> str:
    """Milliseconds -> "M:SS" / "H:MM:SS" (stint durations, no sub-second)."""
    if not ms or ms <= 0:
        return "—"
    total = round(ms / 1000)
    h, m, s = total // 3600, (total % 3600) // 60, total % 60
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def fmt_stop(ms: int | None) -> str:
    """Milliseconds -> "NN.N s" (pit-stop durations)."""
    if not ms or ms <= 0:
        return "—"
    return f"{ms / 1000:.1f} s"


def _classification_table(state: EventState, styles, drivers: list | None = None) -> Table:
    """Modern card-style classification. Position is a dark badge, the leader row
    is accent-tinted, the overall fastest lap is accent-bold. The Interval column
    shows the time to the car directly ahead (derived from cumulative times), so
    two karts on the same lap — including both lapped — see their real gap, not
    just '+N L'.

    `drivers` overrides the ordered field (e.g. the penalty-adjusted order); it
    defaults to the live standings."""
    drivers = drivers if drivers is not None else state.drivers
    accent, a_text = styles["accent"], styles["accent_text"]
    a_tint, a_dark = styles["accent_tint"], styles["accent_dark"]
    header = ["Pos", "Kart", "Driver", "Laps", "Best lap", "Total time", "Gap", "Interval"]
    rows = [header]
    best_row_idx: int | None = None
    prev = None
    for i, d in enumerate(drivers):
        if state.session_best_kart and d.kart_no == state.session_best_kart:
            best_row_idx = i + 1  # +1 for the header row
        interval = "—"
        if prev is not None:
            laps_down = prev.laps - d.laps
            if laps_down > 0:
                interval = f"+{laps_down} L"
            elif d.total_time_ms is not None and prev.total_time_ms is not None:
                delta = (d.total_time_ms - prev.total_time_ms) / 1000
                interval = f"{delta:.3f}" if delta >= 0 else "—"
        rows.append([
            str(d.position or i + 1),
            d.kart_no,
            Paragraph(d.name or "", styles["Cell"]),
            str(d.laps),
            fmt_lap_ms(d.best_lap_ms),
            fmt_total_ms(d.total_time_ms),
            d.gap_leader or "—",
            interval,
        ])
        prev = d
    table = Table(
        rows,
        colWidths=[11 * mm, 14 * mm, 52 * mm, 12 * mm, 25 * mm, 30 * mm, 20 * mm, 22 * mm],
        repeatRows=1,
    )
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), accent),
        ("TEXTCOLOR", (0, 0), (-1, 0), a_text),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("FONTSIZE", (0, 0), (-1, 0), 8),
        # Position badge column: dark chip, white bold.
        ("BACKGROUND", (0, 1), (0, -1), BADGE_INK),
        ("TEXTCOLOR", (0, 1), (0, -1), colors.white),
        ("FONTNAME", (0, 1), (0, -1), "Helvetica-Bold"),
        # Times/deltas in mono (best, total, gap, interval).
        ("FONTNAME", (4, 1), (7, -1), "Courier"),
        ("FONTSIZE", (4, 1), (7, -1), 8),
        ("ALIGN", (0, 0), (1, -1), "CENTER"),
        ("ALIGN", (3, 0), (-1, -1), "CENTER"),
        ("ALIGN", (2, 0), (2, -1), "LEFT"),
        ("ROWBACKGROUNDS", (1, 1), (-1, -1), [colors.white, ROW_ALT]),
        ("LINEBELOW", (0, 1), (-1, -1), 0.4, LINE_GREY),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("ROUNDEDCORNERS", [5, 5, 5, 5]),
    ]
    # Leader row accent-tinted (skip the badge cell so it stays a dark chip).
    if len(drivers) >= 1:
        style.append(("BACKGROUND", (1, 1), (-1, 1), a_tint))
        style.append(("FONTNAME", (2, 1), (2, 1), "Helvetica-Bold"))
    if best_row_idx is not None:
        style.append(("TEXTCOLOR", (4, best_row_idx), (4, best_row_idx), a_dark))
        style.append(("FONTNAME", (4, best_row_idx), (4, best_row_idx), "Courier-Bold"))
    table.setStyle(TableStyle(style))
    return table


def _outstanding_penalties(state: EventState) -> dict[str, dict]:
    """Per-kart outstanding totals folded into the classification: seconds added
    (unserved time penalties + signed time adjustments), laps subtracted, and the
    individual items. Served time penalties and warnings are excluded — the result
    only reflects what's still standing. Adjustments are always applied (they have
    no served state)."""
    out: dict[str, dict] = {}
    for p in state.penalties:
        if p.kind == "warning" or p.served:
            continue
        agg = out.setdefault(p.kart_no, {"seconds": 0, "laps": 0, "items": []})
        agg["seconds"] += p.seconds if p.kind in ("time", "adjust") else 0
        agg["laps"] += p.laps if p.kind == "lap" else 0
        agg["items"].append(p)
    return out


def _penalty_adjusted_drivers(state: EventState) -> list[DriverRow]:
    """The classification recomputed with outstanding penalties applied: time
    penalties add to total time, lap penalties subtract laps. Re-sorted by
    (-laps, total time) — mirroring EventState._recompute_order — with fresh
    positions and gap-to-leader."""
    pens = _outstanding_penalties(state)
    adjusted: list[DriverRow] = []
    for d in state.drivers:
        nd = d.model_copy()
        agg = pens.get(d.kart_no)
        if agg:
            nd.laps = max(0, d.laps - agg["laps"])
            if d.total_time_ms is not None:
                nd.total_time_ms = d.total_time_ms + agg["seconds"] * 1000
        adjusted.append(nd)
    adjusted.sort(key=lambda d: (
        -d.laps,
        d.total_time_ms if d.total_time_ms is not None else float("inf"),
    ))
    leader = adjusted[0] if adjusted else None
    for i, d in enumerate(adjusted):
        d.position = i + 1
        d.gap_leader = _classify_gap(d, leader)
    return adjusted


def _kart_key(k: str) -> tuple:
    try:
        return (0, int(k))
    except ValueError:
        return (1, 0)


def _penalties_summary_table(state: EventState, styles) -> list:
    """A per-driver summary of the outstanding **disciplinary** penalties
    (time/lap) folded into the classification, so the reader can see exactly what
    was applied. Ordered by kart number; only karts with an outstanding penalty
    appear. Neutral time adjustments are listed separately (see
    `_adjustments_summary_table`), not here.

    Each driver gets a tinted summary row (kart, name, combined totals) followed
    by one white detail row per penalty (amount + reason), matching the
    classification card's accent header + rounded corners. Amounts use an ASCII
    '-' — the base-14 PDF fonts only render Latin-1."""
    # Disciplinary aggregation only: unserved time/lap penalties (adjustments and
    # warnings are excluded — adjustments have their own neutral block).
    pens: dict[str, dict] = {}
    for p in state.penalties:
        if p.kind not in ("time", "lap") or p.served:
            continue
        agg = pens.setdefault(p.kart_no, {"seconds": 0, "laps": 0, "items": []})
        agg["seconds"] += p.seconds if p.kind == "time" else 0
        agg["laps"] += p.laps if p.kind == "lap" else 0
        agg["items"].append(p)
    if not pens:
        return []
    names = {d.kart_no: d.name for d in state.drivers}
    accent, a_text, a_tint = styles["accent"], styles["accent_text"], styles["accent_tint"]

    rows: list = [["Kart", "Driver", "Penalty", "Reason"]]
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), accent),
        ("TEXTCOLOR", (0, 0), (-1, 0), a_text),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 8.5),
        ("ALIGN", (0, 0), (0, -1), "CENTER"),
        ("ALIGN", (2, 0), (2, 0), "CENTER"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("ROUNDEDCORNERS", [5, 5, 5, 5]),
    ]
    r = 1  # current row index (0 is the header)
    for kart in sorted(pens, key=lambda k: (_kart_key(k), k)):
        agg = pens[kart]
        totals = []
        if agg["seconds"]:
            totals.append(f"+{agg['seconds']}s")
        if agg["laps"]:
            totals.append(f"-{agg['laps']} lap" + ("s" if agg["laps"] != 1 else ""))
        # Driver summary row (accent-tinted, bold).
        rows.append([kart, Paragraph(names.get(kart, "") or "", styles["Cell"]),
                     "  ·  ".join(totals), ""])
        style.append(("BACKGROUND", (0, r), (-1, r), a_tint))
        style.append(("FONTNAME", (0, r), (2, r), "Helvetica-Bold"))
        if r > 1:
            style.append(("LINEABOVE", (0, r), (-1, r), 0.6, LINE_GREY))
        r += 1
        # One white detail row per penalty (amount in mono + reason).
        for p in agg["items"]:
            amount = f"+{p.seconds}s" if p.kind == "time" else f"-{p.laps} lap"
            rows.append(["", "", amount, Paragraph(p.reason or "—", styles["Cell"])])
            style.append(("FONTNAME", (2, r), (2, r), "Courier"))
            style.append(("TEXTCOLOR", (2, r), (2, r), SOFT_GREY))
            r += 1

    table = Table(rows, colWidths=[14 * mm, 46 * mm, 26 * mm, 100 * mm], repeatRows=1)
    table.setStyle(TableStyle(style))
    return [
        Spacer(1, 5 * mm),
        Paragraph("Penalties applied", styles["SectionHead"]),
        Paragraph(
            "These outstanding penalties are already included in the classification "
            "above — the result is final.", styles["Legend"]),
        table,
    ]


def _adjustments_summary_table(state: EventState, styles) -> list:
    """A neutral list of the signed time adjustments folded into the result — a
    correction of organizer-side timing errors, not a sanction, so it is styled
    plainly (dark header, no accent) and kept apart from the penalties summary.
    Amounts use ASCII '+'/'-' (base-14 fonts are Latin-1 only)."""
    adjustments = [p for p in state.penalties if p.kind == "adjust" and p.seconds]
    if not adjustments:
        return []
    names = {d.kart_no: d.name for d in state.drivers}
    rows: list = [["Kart", "Driver", "Adjustment", "Reason"]]
    for p in sorted(adjustments, key=lambda p: (_kart_key(p.kart_no), p.kart_no, p.id)):
        amount = f"+{p.seconds}s" if p.seconds >= 0 else f"-{abs(p.seconds)}s"
        rows.append([p.kart_no, Paragraph(names.get(p.kart_no, "") or "", styles["Cell"]),
                     amount, Paragraph(p.reason or "—", styles["Cell"])])
    table = Table(rows, colWidths=[14 * mm, 46 * mm, 26 * mm, 100 * mm], repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), INK_BLACK),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
        ("FONTNAME", (2, 1), (2, -1), "Courier"),
        ("FONTSIZE", (0, 0), (-1, -1), 8.5),
        ("ALIGN", (0, 0), (0, -1), "CENTER"),
        ("ALIGN", (2, 0), (2, -1), "CENTER"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, ROW_ALT]),
        ("LINEBELOW", (0, 1), (-1, -1), 0.4, LINE_GREY),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("ROUNDEDCORNERS", [5, 5, 5, 5]),
    ]))
    return [
        Spacer(1, 5 * mm),
        Paragraph("Time adjustments", styles["SectionHead"]),
        Paragraph(
            "Neutral timing corrections (not penalties) already included in the "
            "classification above.", styles["Legend"]),
        table,
    ]


def _lap_grid_tables(state: EventState, styles) -> list:
    """Chrono-style lap-by-lap grid: one row per lap, one column per kart.
    Fastest lap per kart is filled with the accent colour (contrast text); pit
    laps are filled dark. Wraps karts across blocks so a wide field doesn't
    overflow the page."""
    chart = state.lap_chart(last_n=100000)  # full history
    karts = [d.kart_no for d in state.drivers if chart.get(d.kart_no)]
    if not karts:
        return [Paragraph("No lap data recorded yet.", styles["ReportSmall"])]

    out: list = [Paragraph(
        f"<font color='{styles['accent_dark_hex']}'><b>accent cell</b></font> = fastest lap "
        "&nbsp;·&nbsp; <font color='#14161f'><b>dark cell</b></font> = pit lap",
        styles["Legend"],
    )]
    for block_start in range(0, len(karts), MAX_GRID_KARTS):
        block = karts[block_start:block_start + MAX_GRID_KARTS]
        by_kart = {k: {r["lap"]: r for r in chart.get(k, [])} for k in block}
        best_lap_no = {
            k: min(chart[k], key=lambda r: r["ms"])["lap"] if chart.get(k) else None
            for k in block
        }
        max_lap = max((r["lap"] for k in block for r in chart.get(k, [])), default=0)

        # Always render a fixed number of kart columns; pad with empties when
        # there are fewer karts so every block keeps the same column widths.
        pad = MAX_GRID_KARTS - len(block)
        header = ["Lap"] + [f"#{k}" for k in block] + [""] * pad
        rows = [header]
        pit_cells: list[tuple[int, int]] = []
        best_cells: list[tuple[int, int]] = []
        for lap in range(1, max_lap + 1):
            row = [str(lap)]
            for ci, k in enumerate(block, start=1):
                rec = by_kart[k].get(lap)
                if rec is None:
                    row.append("")
                    continue
                if rec["pit"]:
                    pit_cells.append((ci, lap))
                row.append(fmt_lap_ms(rec["ms"]))
                if best_lap_no[k] == lap:
                    best_cells.append((ci, lap))
            row += [""] * pad
            rows.append(row)

        col_w = [11 * mm] + [(CONTENT_W - 11 * mm) / MAX_GRID_KARTS] * MAX_GRID_KARTS
        table = Table(rows, colWidths=col_w, repeatRows=1)
        style = [
            ("BACKGROUND", (0, 0), (-1, 0), INK_BLACK),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTNAME", (0, 1), (-1, -1), "Courier"),
            ("FONTSIZE", (0, 0), (-1, -1), 7),
            ("ALIGN", (0, 0), (-1, -1), "CENTER"),
            ("LINEBELOW", (0, 1), (-1, -1), 0.25, LINE_GREY),
            ("LINEAFTER", (0, 0), (0, -1), 0.4, LINE_GREY),
            ("BACKGROUND", (0, 1), (0, -1), ROW_ALT),
            ("TEXTCOLOR", (0, 1), (0, -1), SOFT_GREY),
            ("TOPPADDING", (0, 0), (-1, -1), 1.6),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 1.6),
            ("ROUNDEDCORNERS", [4, 4, 0, 0]),
        ]
        for ci, lap in pit_cells:
            # Pit laps: dark header colour + white text, in palette.
            style.append(("BACKGROUND", (ci, lap), (ci, lap), INK_BLACK))
            style.append(("TEXTCOLOR", (ci, lap), (ci, lap), colors.white))
            style.append(("FONTNAME", (ci, lap), (ci, lap), "Courier-Bold"))
        for ci, lap in best_cells:
            # Fastest lap per kart: accent-filled cell (like pit laps are filled),
            # with contrast text (white/ink) chosen for legibility on the accent.
            style.append(("BACKGROUND", (ci, lap), (ci, lap), styles["accent"]))
            style.append(("TEXTCOLOR", (ci, lap), (ci, lap), styles["accent_text"]))
            style.append(("FONTNAME", (ci, lap), (ci, lap), "Courier-Bold"))
        table.setStyle(TableStyle(style))
        out.append(Paragraph(
            f"Karts {', '.join('#' + k for k in block)}", styles["SectionHead"]
        ))
        out.append(table)
        out.append(Spacer(1, 5 * mm))
    return out


def _mini_style() -> TableStyle:
    """Compact look for the per-kart pit / stint mini-tables: dark header,
    zebra rows, rounded top."""
    return TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), INK_BLACK),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, ROW_ALT]),
        ("LINEBELOW", (0, 1), (-1, -1), 0.3, LINE_GREY),
        ("TOPPADDING", (0, 0), (-1, -1), 2.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
        ("ROUNDEDCORNERS", [4, 4, 0, 0]),
    ])


def _stints_of(recs: list) -> list[tuple[int, int, int, int, int]]:
    """(stint_no, from_lap, to_lap, n_laps, duration_ms) — a stint is a run of
    consecutive non-pit laps; duration = sum of those laps' times."""
    out: list[tuple[int, int, int, int, int]] = []
    cur: list[tuple[int, int]] = []
    n = 0
    for r in list(recs) + [{"pit": True, "lap": 0, "ms": 0}]:  # sentinel flushes last
        if r["pit"]:
            if cur:
                n += 1
                out.append((n, cur[0][0], cur[-1][0], len(cur), sum(m for _, m in cur if m)))
                cur = []
        else:
            cur.append((r["lap"], r["ms"]))
    return out


def _pit_and_stint_sections(
    state: EventState, styles, include_pits: bool, include_stints: bool, pit_estimate: bool,
) -> list:
    """One block per kart (heading + its pit-stops and stint tables side by side),
    which is far clearer than cramming every kart into two shared tables."""
    chart = state.lap_chart(last_n=100000)
    # Feed-measured pit history on gate venues; otherwise inferred pit laps.
    use_feed = state.auto_pitlane and any(state.pit_stops.values())
    show_stop = include_pits and (use_feed or pit_estimate)
    stop_label = "Stop" if use_feed else "Est. stop"

    title = ("Pit stops & stints" if include_pits and include_stints
             else "Pit stops" if include_pits else "Stint times")
    out: list = [Paragraph(title, styles["SectionHead"])]
    if include_pits and not use_feed and pit_estimate:
        out.append(Paragraph(
            "Est. stop = the pit lap's time minus the kart's median lap — inferred from "
            "lap times, not measured (this venue has no pit-lane timing).", styles["Legend"]))
    if include_stints:
        caveat = ("" if state.auto_pitlane else
                  " On tracks without pit-lane timing this is an approximation — the "
                  "partial lap around a stop isn't counted.")
        out.append(Paragraph(
            "Stint duration = the sum of that stint's racing-lap times (a stint is a run of "
            "consecutive non-pit laps; pit laps are excluded)." + caveat,
            styles["Legend"]))
    out.append(Spacer(1, 2 * mm))

    def pit_rows(k, recs):
        if use_feed:
            return [(i, lap, ms) for i, (lap, ms) in enumerate(state.pit_stops.get(k, []), 1)]
        times = [r["ms"] for r in recs if r["ms"]]
        base = statistics.median(times) if len(times) >= 3 else None
        res = []
        for i, r in enumerate((x for x in recs if x["pit"]), 1):
            est = int(r["ms"] - base) if (pit_estimate and base) else None
            res.append((i, r["lap"], est))
        return res

    def pit_cell(k, recs):
        cell: list = [Paragraph("Pit stops", styles["MiniCap"])]
        rows = pit_rows(k, recs)
        if not rows:
            cell.append(Paragraph("No pit stops.", styles["ReportSmall"]))
            return cell
        header = ["Pit", "Lap"] + ([stop_label] if show_stop else [])
        trows = [header]
        for pit_no, lap, ms in rows:
            r = [str(pit_no), str(lap)]
            if show_stop:
                r.append(fmt_stop(ms) if ms is not None else "—")
            trows.append(r)
        widths = [14 * mm, 16 * mm] + ([26 * mm] if show_stop else [])
        t = Table(trows, colWidths=widths)
        t.hAlign = "LEFT"
        t.setStyle(_mini_style())
        cell.append(t)
        return cell

    def stint_cell(recs):
        cell: list = [Paragraph("Stints", styles["MiniCap"])]
        rows = _stints_of(recs)
        if not rows:
            cell.append(Paragraph("No stints.", styles["ReportSmall"]))
            return cell
        trows = [["Stint", "Laps", "N", "Duration"]]
        for sn, lo, hi, n, dur in rows:
            trows.append([str(sn), f"{lo}–{hi}", str(n), fmt_clock(dur)])
        t = Table(trows, colWidths=[14 * mm, 22 * mm, 12 * mm, 26 * mm])
        t.hAlign = "LEFT"
        t.setStyle(_mini_style())
        cell.append(t)
        return cell

    any_kart = False
    for d in state.drivers:
        recs = chart.get(d.kart_no, [])
        if not recs:
            continue
        any_kart = True
        label = f"Kart #{d.kart_no}" + (f" — {d.name}" if d.name else "")
        block: list = [Paragraph(label, styles["KartHead"])]
        cells = []
        if include_pits:
            cells.append(pit_cell(d.kart_no, recs))
        if include_stints:
            cells.append(stint_cell(recs))
        if len(cells) == 2:
            row = Table([cells], colWidths=[CONTENT_W / 2, CONTENT_W / 2])
            row.setStyle(TableStyle([
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (0, 0), 0),
                ("RIGHTPADDING", (0, 0), (0, 0), 6 * mm),
                ("LEFTPADDING", (1, 0), (1, 0), 0),
            ]))
            block.append(row)
        else:
            block.extend(cells[0])
        out.append(KeepTogether(block))

    if not any_kart:
        out.append(Paragraph("No lap data recorded yet.", styles["ReportSmall"]))
    return out


def _best_lap_bar(state: EventState, accent=RACE_RED) -> Drawing:
    rows = [(d.kart_no, d.best_lap_ms) for d in state.drivers if d.best_lap_ms]
    d = Drawing(CONTENT_W, 180)
    d.add(String(0, 165, "Best lap by kart (s)", fontSize=11, fontName="Helvetica-Bold",
                 fillColor=INK_BLACK))
    if not rows:
        d.add(String(0, 80, "No lap data.", fontSize=9))
        return d
    chart = VerticalBarChart()
    chart.x, chart.y, chart.width, chart.height = 25, 20, CONTENT_W - 50, 130
    chart.data = [[ms / 1000 for _, ms in rows]]
    chart.categoryAxis.categoryNames = [f"#{k}" for k, _ in rows]
    chart.categoryAxis.labels.fontSize = 7
    chart.bars[0].fillColor = accent
    chart.bars[0].strokeColor = None
    lo = min(ms for _, ms in rows) / 1000
    hi = max(ms for _, ms in rows) / 1000
    chart.valueAxis.valueMin = max(0, lo - 1)
    chart.valueAxis.valueMax = hi + 1
    chart.valueAxis.labels.fontSize = 7
    chart.valueAxis.gridStrokeColor = LINE_GREY
    d.add(chart)
    return d


def _pace_trend(state: EventState, accent=RACE_RED) -> Drawing:
    """Lap-time trend for the top few karts (leaders)."""
    chart_data = state.lap_chart(last_n=100000)
    leaders = [d.kart_no for d in state.drivers[:4] if chart_data.get(d.kart_no)]
    d = Drawing(CONTENT_W, 200)
    d.add(String(0, 185, "Lap-time trend — leaders (s)", fontSize=11,
                 fontName="Helvetica-Bold", fillColor=INK_BLACK))
    series = []
    palette = [accent, INK_BLACK, colors.HexColor("#3987e5"), colors.HexColor("#2fb457")]
    for k in leaders:
        pts = [(r["lap"], r["ms"] / 1000) for r in chart_data[k] if not r["pit"]]
        if pts:
            series.append(pts)
    if not series:
        d.add(String(0, 90, "No lap data.", fontSize=9))
        return d
    plot = LinePlot()
    plot.x, plot.y, plot.width, plot.height = 35, 25, CONTENT_W - 60, 145
    plot.data = series
    for i in range(len(series)):
        plot.lines[i].strokeColor = palette[i % len(palette)]
        plot.lines[i].strokeWidth = 1.2
    flat = [v for s in series for _, v in s]
    plot.yValueAxis.valueMin = max(0, min(flat) - 1)
    plot.yValueAxis.valueMax = max(flat) + 1
    plot.xValueAxis.labels.fontSize = 7
    plot.yValueAxis.labels.fontSize = 7
    d.add(plot)
    # Legend
    for i, k in enumerate(leaders[:len(series)]):
        d.add(String(30 + i * 90, 6, f"#{k}", fontSize=8,
                     fillColor=palette[i % len(palette)]))
    return d


def build_timesheet_pdf(
    state: EventState, include_charts: bool = False, include_grid: bool = True,
    include_pits: bool = False, include_stints: bool = False, pit_estimate: bool = False,
    include_penalties: bool = False,
    event_name: str = "", session_name: str = "", accent: str = "#e10600",
    status: str = "", notes: str = "",
) -> bytes:
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=12 * mm, rightMargin=12 * mm,
        # A little extra headroom on later pages for the running header.
        topMargin=16 * mm, bottomMargin=14 * mm,
        title="Race timesheet",
    )
    base = getSampleStyleSheet()
    styles = {
        "ReportSmall": ParagraphStyle(
            "ReportSmall", parent=base["Normal"], fontSize=8, textColor=SOFT_GREY),
        "SectionHead": ParagraphStyle(
            "SectionHead", parent=base["Heading2"], fontSize=12, textColor=INK_BLACK,
            spaceBefore=6, spaceAfter=4),
        "Legend": ParagraphStyle(
            "Legend", parent=base["Normal"], fontSize=8, textColor=SOFT_GREY, spaceAfter=3),
        "Cell": ParagraphStyle("Cell", parent=base["Normal"], fontSize=9),
        "KartHead": ParagraphStyle(
            "KartHead", parent=base["Heading3"], fontSize=11, textColor=INK_BLACK,
            spaceBefore=8, spaceAfter=2),
        "MiniCap": ParagraphStyle(
            "MiniCap", parent=base["Normal"], fontSize=7.5, textColor=SOFT_GREY,
            fontName="Helvetica-Bold", spaceBefore=1, spaceAfter=1),
    }
    kit = _accent_kit(accent)
    dark = kit["dark"]
    styles["accent"] = kit["accent"]
    styles["accent_text"] = kit["text"]
    styles["accent_tint"] = kit["tint"]
    styles["accent_dark"] = dark
    styles["accent_dark_hex"] = "#%02x%02x%02x" % (
        int(dark.red * 255), int(dark.green * 255), int(dark.blue * 255))

    race = state.race
    event = event_name.strip() or race.event_name or "Race"
    session = session_name.strip() or race.run_type or ""
    # A typed session name shows as-is; a bare feed run code (e.g. "E") reads
    # better as "Run E".
    session_meta = session_name.strip() or (f"Run {race.run_type}" if race.run_type else "")
    # Result status: an explicit choice (provisional/definitive) overrides the
    # auto guess from race.ended, and shows as a pill in the header.
    _AMBER = colors.HexColor("#e0912a")
    _GREEN = colors.HexColor("#2aa14e")
    chosen = status.strip().lower()
    if chosen == "definitive":
        status_label, status_color = "DEFINITIVE", _GREEN
    elif chosen == "provisional":
        status_label, status_color = "PROVISIONAL", _AMBER
    else:
        status_label = "FINISHED" if race.ended else "PROVISIONAL"
        status_color = _GREEN if race.ended else _AMBER
    meta_bits = [
        race.track_name,
        session_meta,
        datetime.now().strftime("%d %b %Y %H:%M"),
    ]
    meta = "   ·   ".join(b for b in meta_bits if b)

    # Slim running header on pages 2+ so the middle pages still say what event
    # this is (page 1 already carries the big HeaderBand).
    running_left = "  ·  ".join(b for b in (event, session) if b)

    def _later_pages(cnv, _doc):
        cnv.saveState()
        y = A4[1] - 11 * mm
        cnv.setFont("Helvetica-Bold", 8.5)
        cnv.setFillColor(INK_BLACK)
        cnv.drawString(12 * mm, y, running_left)
        if race.track_name:
            cnv.setFont("Helvetica", 8)
            cnv.setFillColor(SOFT_GREY)
            cnv.drawRightString(A4[0] - 12 * mm, y, race.track_name)
        cnv.setStrokeColor(LINE_GREY)
        cnv.setLineWidth(0.5)
        cnv.line(12 * mm, y - 2.5 * mm, A4[0] - 12 * mm, y - 2.5 * mm)
        cnv.restoreState()

    # With penalties on, the classification is recomputed with outstanding
    # penalties applied, so page 1 shows the final result; a summary of what
    # was applied follows it.
    adjusted = _penalty_adjusted_drivers(state) if include_penalties else None
    summary = _penalties_summary_table(state, styles) if include_penalties else []
    adjustments = _adjustments_summary_table(state, styles) if include_penalties else []
    applied = " & ".join(
        w for w, on in (("penalties", summary), ("adjustments", adjustments)) if on
    )
    class_title = f"Classification ({applied} applied)" if applied else "Classification"
    story: list = [
        HeaderBand(event, meta, accent=kit["accent"],
                   status=status_label, status_color=status_color),
        Spacer(1, 6 * mm),
        Paragraph(class_title, styles["SectionHead"]),
        _classification_table(state, styles, drivers=adjusted),
    ]
    story += summary
    story += adjustments

    # Operator notes printed on the sheet (line breaks preserved).
    note_text = notes.strip()
    if note_text:
        from xml.sax.saxutils import escape
        story.append(Spacer(1, 5 * mm))
        story.append(Paragraph("Notes", styles["SectionHead"]))
        story.append(Paragraph(escape(note_text).replace("\n", "<br/>"), styles["Cell"]))

    # Keep page 1 for the classification alone; charts + pit/stint start on the
    # next page. (The grid already begins on its own page, so don't add a break
    # for it here — that would leave a blank page.)
    if include_charts or include_pits or include_stints:
        story.append(PageBreak())

    if include_charts:
        story.append(_best_lap_bar(state, kit["accent"]))
        story.append(Spacer(1, 4 * mm))
        story.append(_pace_trend(state, kit["accent"]))

    if include_pits or include_stints:
        if include_charts:
            story.append(Spacer(1, 6 * mm))
        story += _pit_and_stint_sections(
            state, styles, include_pits, include_stints, pit_estimate)

    if include_grid:
        story.append(PageBreak())
        story.append(Paragraph("Lap by lap", styles["SectionHead"]))
        story += _lap_grid_tables(state, styles)

    doc.build(story, onLaterPages=_later_pages, canvasmaker=NumberedCanvas)
    return buf.getvalue()


def _slug(text: str) -> str:
    """Filesystem-safe filename part: keep word chars/dashes/spaces, spaces to
    dashes, trimmed."""
    import re

    cleaned = re.sub(r"[^\w\- ]+", "", text).strip()
    return re.sub(r"\s+", "-", cleaned)[:60].strip("-")


def _clean_accent(value: str) -> str:
    """Accept a #rrggbb / rrggbb / #rgb hex accent; fall back to the brand red."""
    import re

    v = value.strip().lstrip("#")
    if re.fullmatch(r"[0-9a-fA-F]{3}", v) or re.fullmatch(r"[0-9a-fA-F]{6}", v):
        return f"#{v}"
    return "#e10600"


def _timesheet_response(
    state: EventState, *, charts: bool, grid: bool, pits: bool, stints: bool,
    pitest: bool, penalties: bool, event: str, session: str, accent: str,
    fallback_stem: str, status: str = "", notes: str = "",
) -> Response:
    """Build a chrono-timesheet PDF Response from any EventState (live or a
    rehydrated saved snapshot)."""
    if not _REPORTLAB_OK:
        raise HTTPException(status_code=503, detail="PDF export unavailable: reportlab is not installed")
    pdf = build_timesheet_pdf(
        state, include_charts=charts, include_grid=grid,
        include_pits=pits, include_stints=stints, pit_estimate=pitest,
        include_penalties=penalties,
        accent=_clean_accent(accent),
        event_name=event, session_name=session, status=status, notes=notes,
    )
    date = datetime.now().strftime("%Y%m%d")
    parts = [_slug(event or state.race.event_name), _slug(session or state.race.run_type)]
    stem = "-".join(p for p in parts if p) or fallback_stem
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{stem}-{date}.pdf"',
            # Rebuilt per request (live state or an amended snapshot); never cache.
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
        },
    )


def snapshot_pdf_response(
    record: dict, *, charts: bool, grid: bool, pits: bool, stints: bool,
    pitest: bool, penalties: bool, event: str, session: str, accent: str,
    status: str = "", notes: str = "",
) -> Response:
    """PDF from a saved-snapshot record — reused by the admin + public routes."""
    state = EventState.hydrate(record)
    return _timesheet_response(
        state, charts=charts, grid=grid, pits=pits, stints=stints, pitest=pitest,
        penalties=penalties, event=event, session=session, accent=accent, status=status,
        notes=notes, fallback_stem=_slug(record.get("name", "")) or "snapshot",
    )


@router.get("/e/{slot}/api/export/timesheet.pdf")
def timesheet_pdf(
    slot: int, charts: bool = False, grid: bool = True,
    pits: bool = False, stints: bool = False, pitest: bool = False,
    penalties: bool = False,
    event: str = "", session: str = "", accent: str = "#e10600", status: str = "",
    notes: str = "",
) -> Response:
    """Downloadable chrono timesheet from live state, so generate it before
    disconnecting. `event`/`session` override names; `accent` recolours it;
    `status` stamps PROVISIONAL / DEFINITIVE in the header; `notes` prints a
    free-text notes block."""
    evt = get_event(slot)
    return _timesheet_response(
        evt.state, charts=charts, grid=grid, pits=pits, stints=stints, pitest=pitest,
        penalties=penalties, event=event, session=session, accent=accent, status=status,
        notes=notes, fallback_stem=f"timesheet-event{slot}",
    )


@router.get(
    "/api/admin/snapshots/{snapshot_id}/timesheet.pdf",
    dependencies=[Depends(check_safeword)],
)
def admin_snapshot_pdf(
    snapshot_id: str, charts: bool = False, grid: bool = True,
    pits: bool = False, stints: bool = False, pitest: bool = False,
    penalties: bool = False,
    event: str = "", session: str = "", accent: str = "#e10600", status: str = "",
    notes: str = "",
) -> Response:
    """PDF from any saved snapshot (safeword-gated)."""
    record = snapshots.load_record(snapshot_id)
    if record is None:
        raise HTTPException(status_code=404, detail="snapshot not found")
    return snapshot_pdf_response(
        record, charts=charts, grid=grid, pits=pits, stints=stints, pitest=pitest,
        penalties=penalties, event=event, session=session, accent=accent, status=status,
        notes=notes,
    )
