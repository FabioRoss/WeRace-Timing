from __future__ import annotations

import io
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
    PIT_TINT = colors.HexColor("#f0f1f5")     # pit-lap cell background
    PIT_MARK = colors.HexColor("#b26a00")     # pit "P" marker
    CHECK_DARK = colors.HexColor("#14161f")
    CHECK_LIGHT = colors.HexColor("#f4f6fb")

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
        "<font color='#b26a00'><b>*</b></font> = pit lap",
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

        header = ["Lap"] + [f"#{k}" for k in block]
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
                text = fmt_lap_ms(rec["ms"])
                if rec["pit"]:
                    text += "*"
                    pit_cells.append((ci, lap))
                row.append(text)
                if best_lap_no[k] == lap:
                    best_cells.append((ci, lap))
            rows.append(row)

        usable = 186 * mm
        col_w = [11 * mm] + [(usable - 11 * mm) / len(block)] * len(block)
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
            style.append(("BACKGROUND", (ci, lap), (ci, lap), PIT_TINT))
            style.append(("TEXTCOLOR", (ci, lap), (ci, lap), PIT_MARK))
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


def _best_lap_bar(state: EventState) -> Drawing:
    rows = [(d.kart_no, d.best_lap_ms) for d in state.drivers if d.best_lap_ms]
    d = Drawing(500, 180)
    d.add(String(0, 165, "Best lap by kart (s)", fontSize=11, fontName="Helvetica-Bold",
                 fillColor=INK_BLACK))
    if not rows:
        d.add(String(0, 80, "No lap data.", fontSize=9))
        return d
    chart = VerticalBarChart()
    chart.x, chart.y, chart.width, chart.height = 20, 20, 460, 130
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
    d = Drawing(500, 200)
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
    plot.x, plot.y, plot.width, plot.height = 30, 25, 450, 145
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
    state: EventState, include_charts: bool = False, include_grid: bool = True
) -> bytes:
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=12 * mm, rightMargin=12 * mm,
        topMargin=12 * mm, bottomMargin=12 * mm,
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
    meta_bits = [
        race.track_name,
        race.run_type and f"Run {race.run_type}",
        datetime.now().strftime("%d %b %Y %H:%M"),
        "FINISHED" if race.ended else "PROVISIONAL",
    ]
    meta = "   ·   ".join(b for b in meta_bits if b)

    story: list = [
        HeaderBand(race.event_name or "Race", meta),
        Spacer(1, 6 * mm),
        Paragraph("Classification", styles["SectionHead"]),
        _classification_table(state, styles),
    ]

    if include_charts:
        story.append(Spacer(1, 7 * mm))
        story.append(_best_lap_bar(state))
        story.append(Spacer(1, 4 * mm))
        story.append(_pace_trend(state))

    if include_grid:
        story.append(PageBreak())
        story.append(Paragraph("Lap by lap", styles["SectionHead"]))
        story += _lap_grid_tables(state, styles)

    doc.build(story)
    return buf.getvalue()


@router.get("/e/{slot}/api/export/timesheet.pdf")
def timesheet_pdf(slot: int, charts: bool = False, grid: bool = True) -> Response:
    """Downloadable chrono timesheet: modern classification + optional charts +
    lap-by-lap grid. Built from live state, so generate it before disconnecting
    the source."""
    if not _REPORTLAB_OK:
        raise HTTPException(status_code=503, detail="PDF export unavailable: reportlab is not installed")
    event = get_event(slot)
    pdf = build_timesheet_pdf(event.state, include_charts=charts, include_grid=grid)
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    name = f"timesheet-event{slot}-{stamp}.pdf"
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )
