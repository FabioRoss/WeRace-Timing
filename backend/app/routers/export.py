from __future__ import annotations

import io
import statistics
from datetime import datetime

from fastapi import APIRouter, HTTPException, Response

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
                if total > 1:  # no "Page 1 of 1" on a single-page sheet
                    self.setFont("Helvetica", 8)
                    self.setFillColor(SOFT_GREY)
                    self.drawRightString(
                        self._pagesize[0] - 12 * mm, 8 * mm,
                        f"Page {self._pageNumber} of {total}",
                    )
                super().showPage()
            super().save()

    class HeaderBand(Flowable):
        """A modern hero band: dark rounded panel with a checker strip, the event
        title and a meta line. Replaces the old plain paragraph header."""

        def __init__(self, title: str, meta: str, height: float = 26 * mm):
            super().__init__()
            self.title = title
            self.meta = meta
            self.height = height
            self.width = 0.0

        def wrap(self, avail_w: float, avail_h: float):
            self.width = avail_w
            return (avail_w, self.height)

        def draw(self):
            c = self.canv
            w, h = self.width, self.height
            c.setFillColor(INK_BLACK)
            c.roundRect(0, 0, w, h, 4 * mm, stroke=0, fill=1)
            # Red accent spine on the left.
            c.setFillColor(RACE_RED)
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

except ImportError:  # pragma: no cover - only when the dep is absent
    _REPORTLAB_OK = False

from ..state import EventState
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


def _classification_table(state: EventState, styles) -> Table:
    """Modern card-style classification. Position is a dark badge, the leader row
    is tinted red, the overall fastest lap is red-bold. No On/Pits columns."""
    header = ["Pos", "Kart", "Driver", "Laps", "Best lap", "Total time", "Gap"]
    rows = [header]
    best_row_idx: int | None = None
    for i, d in enumerate(state.drivers):
        if state.session_best_kart and d.kart_no == state.session_best_kart:
            best_row_idx = i + 1  # +1 for the header row
        rows.append([
            str(d.position or i + 1),
            d.kart_no,
            Paragraph(d.name or "", styles["Cell"]),
            str(d.laps),
            fmt_lap_ms(d.best_lap_ms),
            fmt_total_ms(d.total_time_ms),
            d.gap_leader or "—",
        ])
    table = Table(
        rows,
        colWidths=[13 * mm, 16 * mm, 63 * mm, 15 * mm, 27 * mm, 33 * mm, 19 * mm],
        repeatRows=1,
    )
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), RACE_RED),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("FONTSIZE", (0, 0), (-1, 0), 8.5),
        # Position badge column: dark chip, white bold.
        ("BACKGROUND", (0, 1), (0, -1), BADGE_INK),
        ("TEXTCOLOR", (0, 1), (0, -1), colors.white),
        ("FONTNAME", (0, 1), (0, -1), "Helvetica-Bold"),
        ("FONTNAME", (4, 1), (4, -1), "Courier"),
        ("FONTNAME", (5, 1), (5, -1), "Courier"),
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
    # Leader row tinted red (skip the badge cell so it stays a dark chip).
    if len(state.drivers) >= 1:
        style.append(("BACKGROUND", (1, 1), (-1, 1), RED_TINT))
        style.append(("FONTNAME", (2, 1), (2, 1), "Helvetica-Bold"))
    if best_row_idx is not None:
        style.append(("TEXTCOLOR", (4, best_row_idx), (4, best_row_idx), RACE_RED))
        style.append(("FONTNAME", (4, best_row_idx), (4, best_row_idx), "Courier-Bold"))
    table.setStyle(TableStyle(style))
    return table


def _lap_grid_tables(state: EventState, styles) -> list:
    """Chrono-style lap-by-lap grid: one row per lap, one column per kart.
    Fastest lap per kart is red-bold; pit laps are tinted and marked with a small
    ᴾ. Wraps karts across blocks so a wide field doesn't overflow the page."""
    chart = state.lap_chart(last_n=100000)  # full history
    karts = [d.kart_no for d in state.drivers if chart.get(d.kart_no)]
    if not karts:
        return [Paragraph("No lap data recorded yet.", styles["ReportSmall"])]

    out: list = [Paragraph(
        "<font color='#e10600'><b>red</b></font> = fastest lap &nbsp;·&nbsp; "
        "<font color='#14161f'><b>dark cell</b></font> = pit lap",
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
            style.append(("FONTNAME", (ci, lap), (ci, lap), "Courier-Bold"))
            style.append(("TEXTCOLOR", (ci, lap), (ci, lap), RACE_RED))
        table.setStyle(TableStyle(style))
        out.append(Paragraph(
            f"Karts {', '.join('#' + k for k in block)}", styles["SectionHead"]
        ))
        out.append(table)
        out.append(Spacer(1, 5 * mm))
    return out


def _summary_style() -> TableStyle:
    """Shared modern look for the small pit / stint tables: red header, dark
    kart-badge first column, zebra rows, rounded corners."""
    return TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), RACE_RED),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 8.5),
        ("BACKGROUND", (0, 1), (0, -1), BADGE_INK),
        ("TEXTCOLOR", (0, 1), (0, -1), colors.white),
        ("FONTNAME", (0, 1), (0, -1), "Helvetica-Bold"),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("ROWBACKGROUNDS", (1, 1), (-1, -1), [colors.white, ROW_ALT]),
        ("LINEBELOW", (0, 1), (-1, -1), 0.4, LINE_GREY),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("ROUNDEDCORNERS", [5, 5, 5, 5]),
    ])


def _pit_stops_table(state: EventState, styles, estimate: bool) -> list:
    """Pit stops per kart: pit # + lap. On gate venues (auto_pitlane) a measured
    Stop column shows by default; without gates it's optionally an inferred
    estimate (pit-lap time − the kart's median lap)."""
    chart = state.lap_chart(last_n=100000)
    # Use the feed-measured pit history when a gate venue actually reported pits;
    # otherwise fall back to the inferred pit laps (with an optional estimate).
    use_feed = state.auto_pitlane and any(state.pit_stops.values())
    show_stop = use_feed or estimate
    stop_label = "Stop" if use_feed else "Est. stop"

    data: list[tuple[str, int, int, int | None]] = []
    for d in state.drivers:
        k = d.kart_no
        if use_feed:
            for i, (lap, ms) in enumerate(state.pit_stops.get(k, []), 1):
                data.append((k, i, lap, ms))
        else:
            recs = chart.get(k, [])
            times = [r["ms"] for r in recs if r["ms"]]
            base = statistics.median(times) if len(times) >= 3 else None
            for i, r in enumerate((r for r in recs if r["pit"]), 1):
                est = int(r["ms"] - base) if (estimate and base) else None
                data.append((k, i, r["lap"], est))

    out: list = [Paragraph("Pit stops", styles["SectionHead"])]
    if not data:
        out.append(Paragraph("No pit stops recorded.", styles["ReportSmall"]))
        return out

    header = ["Kart", "Pit", "Lap"] + ([stop_label] if show_stop else [])
    rows = [header]
    for k, pit_no, lap, ms in data:
        row = [f"#{k}", str(pit_no), str(lap)]
        if show_stop:
            row.append(fmt_stop(ms) if ms is not None else "—")
        rows.append(row)

    widths = [26 * mm, 20 * mm, 20 * mm] + ([32 * mm] if show_stop else [])
    table = Table(rows, colWidths=widths, repeatRows=1)
    table.hAlign = "LEFT"
    table.setStyle(_summary_style())
    out.append(table)
    if not use_feed and estimate:
        out.append(Paragraph(
            "Est. stop = the pit lap's time minus the kart's median lap — inferred from "
            "lap times, not measured (this venue has no pit-lane timing).",
            styles["Legend"]))
    return out


def _stint_table(state: EventState, styles) -> list:
    """Stint durations per kart: a stint is a run of consecutive non-pit laps;
    the duration is the sum of those laps' times (pit laps excluded)."""
    chart = state.lap_chart(last_n=100000)
    data: list[tuple[str, int, int, int, int, int]] = []
    for d in state.drivers:
        recs = chart.get(d.kart_no, [])
        stint_no = 0
        cur: list[tuple[int, int]] = []
        # Sentinel pit lap flushes the final stint.
        for r in list(recs) + [{"pit": True, "lap": 0, "ms": 0}]:
            if r["pit"]:
                if cur:
                    stint_no += 1
                    dur = sum(m for _, m in cur if m)
                    data.append((d.kart_no, stint_no, cur[0][0], cur[-1][0], len(cur), dur))
                    cur = []
            else:
                cur.append((r["lap"], r["ms"]))

    out: list = [Paragraph("Stint times", styles["SectionHead"])]
    if not data:
        out.append(Paragraph("No stints recorded.", styles["ReportSmall"]))
        return out

    rows = [["Kart", "Stint", "Laps", "N", "Duration"]]
    for k, sn, lo, hi, n, dur in data:
        rows.append([f"#{k}", str(sn), f"{lo}–{hi}", str(n), fmt_clock(dur)])
    table = Table(rows, colWidths=[26 * mm, 20 * mm, 28 * mm, 16 * mm, 30 * mm], repeatRows=1)
    table.hAlign = "LEFT"
    table.setStyle(_summary_style())
    out.append(table)
    out.append(Paragraph(
        "Stint duration = the sum of that stint's racing-lap times (a stint is a run of "
        "consecutive non-pit laps; pit laps are excluded). On tracks without pit-lane "
        "timing this is an approximation — the partial lap around a stop isn't counted.",
        styles["Legend"]))
    return out


def _best_lap_bar(state: EventState) -> Drawing:
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
    chart.bars[0].fillColor = RACE_RED
    chart.bars[0].strokeColor = None
    lo = min(ms for _, ms in rows) / 1000
    hi = max(ms for _, ms in rows) / 1000
    chart.valueAxis.valueMin = max(0, lo - 1)
    chart.valueAxis.valueMax = hi + 1
    chart.valueAxis.labels.fontSize = 7
    chart.valueAxis.gridStrokeColor = LINE_GREY
    d.add(chart)
    return d


def _pace_trend(state: EventState) -> Drawing:
    """Lap-time trend for the top few karts (leaders)."""
    chart_data = state.lap_chart(last_n=100000)
    leaders = [d.kart_no for d in state.drivers[:4] if chart_data.get(d.kart_no)]
    d = Drawing(CONTENT_W, 200)
    d.add(String(0, 185, "Lap-time trend — leaders (s)", fontSize=11,
                 fontName="Helvetica-Bold", fillColor=INK_BLACK))
    series = []
    palette = [RACE_RED, INK_BLACK, colors.HexColor("#3987e5"), colors.HexColor("#2fb457")]
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
    event_name: str = "", session_name: str = "",
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
    }

    race = state.race
    event = event_name.strip() or race.event_name or "Race"
    session = session_name.strip() or race.run_type or ""
    # A typed session name shows as-is; a bare feed run code (e.g. "E") reads
    # better as "Run E".
    session_meta = session_name.strip() or (f"Run {race.run_type}" if race.run_type else "")
    meta_bits = [
        race.track_name,
        session_meta,
        datetime.now().strftime("%d %b %Y %H:%M"),
        "FINISHED" if race.ended else "PROVISIONAL",
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

    story: list = [
        HeaderBand(event, meta),
        Spacer(1, 6 * mm),
        Paragraph("Classification", styles["SectionHead"]),
        _classification_table(state, styles),
    ]

    if include_charts:
        story.append(Spacer(1, 7 * mm))
        story.append(_best_lap_bar(state))
        story.append(Spacer(1, 4 * mm))
        story.append(_pace_trend(state))

    if include_pits:
        story.append(Spacer(1, 6 * mm))
        story += _pit_stops_table(state, styles, pit_estimate)

    if include_stints:
        story.append(Spacer(1, 6 * mm))
        story += _stint_table(state, styles)

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


@router.get("/e/{slot}/api/export/timesheet.pdf")
def timesheet_pdf(
    slot: int, charts: bool = False, grid: bool = True,
    pits: bool = False, stints: bool = False, pitest: bool = False,
    event: str = "", session: str = "",
) -> Response:
    """Downloadable chrono timesheet: modern classification + optional charts,
    pit-stops table, stint-times table and lap-by-lap grid. Built from live
    state, so generate it before disconnecting the source. `event`/`session`
    override the names on the sheet + filename."""
    if not _REPORTLAB_OK:
        raise HTTPException(status_code=503, detail="PDF export unavailable: reportlab is not installed")
    evt = get_event(slot)
    pdf = build_timesheet_pdf(
        evt.state, include_charts=charts, include_grid=grid,
        include_pits=pits, include_stints=stints, pit_estimate=pitest,
        event_name=event, session_name=session,
    )
    # Filename: chosen event + session + date (falls back to the feed's names).
    date = datetime.now().strftime("%Y%m%d")
    parts = [
        _slug(event or evt.state.race.event_name),
        _slug(session or evt.state.race.run_type),
    ]
    stem = "-".join(p for p in parts if p) or f"timesheet-event{slot}"
    name = f"{stem}-{date}.pdf"
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{name}"',
            # The PDF is regenerated from live state on every request; the URL is
            # otherwise identical, so browsers would serve a stale cached copy
            # (very visible when re-downloading across replays). Never cache it.
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
        },
    )
