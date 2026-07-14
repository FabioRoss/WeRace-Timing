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
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import (
        PageBreak,
        Paragraph,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
    )

    _REPORTLAB_OK = True

    # Brand palette (mirrors frontend src/index.css) — red / black / white sheet.
    RACE_RED = colors.HexColor("#e10600")
    INK_BLACK = colors.HexColor("#0b0d14")
    GRID_GREY = colors.HexColor("#c9ced9")
    BAND_GREY = colors.HexColor("#f1f2f6")
    BEST_YELLOW = colors.HexColor("#ffe27a")
    PIT_BLUE = colors.HexColor("#dbe6f7")
except ImportError:  # pragma: no cover - only when the dep is absent
    _REPORTLAB_OK = False

from ..state import EventState
from .public import get_event

router = APIRouter()

# One column per kart in the lap grid gets tight; cap columns per grid block so
# a big field wraps onto additional pages instead of overflowing the width.
MAX_GRID_KARTS = 12


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


def _header_story(state: EventState, styles) -> list:
    race = state.race
    title = race.event_name or "Race"
    sub_bits = [
        race.track_name,
        race.run_type and f"Run: {race.run_type}",
        race.race_time and f"Time: {race.race_time}",
        "FINISHED" if race.ended else None,
    ]
    subtitle = "  ·  ".join(b for b in sub_bits if b)
    printed = datetime.now().strftime("%Y-%m-%d %H:%M")
    return [
        Paragraph(title, styles["ReportTitle"]),
        Paragraph(subtitle, styles["ReportSub"]),
        Paragraph(f"Generated {printed}", styles["ReportSmall"]),
        Spacer(1, 6 * mm),
    ]


def _classification_table(state: EventState, styles) -> Table:
    header = ["Pos", "Kart", "Driver", "Laps", "Best lap", "On", "Pits", "Total time", "Gap"]
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
            str(d.best_lap_no) if d.best_lap_no else "—",
            str(d.pits),
            fmt_total_ms(d.total_time_ms),
            d.gap_leader or "—",
        ])
    table = Table(
        rows,
        colWidths=[10 * mm, 12 * mm, 52 * mm, 12 * mm, 24 * mm, 10 * mm, 10 * mm, 30 * mm, 20 * mm],
        repeatRows=1,
    )
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), RACE_RED),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("ALIGN", (0, 0), (1, -1), "CENTER"),
        ("ALIGN", (3, 0), (-1, -1), "CENTER"),
        ("ALIGN", (2, 0), (2, -1), "LEFT"),
        ("GRID", (0, 0), (-1, -1), 0.4, GRID_GREY),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, BAND_GREY]),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]
    if best_row_idx is not None:
        # Highlight the overall fastest lap.
        style.append(("BACKGROUND", (4, best_row_idx), (5, best_row_idx), BEST_YELLOW))
        style.append(("FONTNAME", (4, best_row_idx), (5, best_row_idx), "Helvetica-Bold"))
    table.setStyle(TableStyle(style))
    return table


def _lap_grid_tables(state: EventState, styles) -> list:
    """Chrono-style lap-by-lap grid: one row per lap, one column per kart.
    Fastest lap per kart is bolded; pit laps shaded. Wraps karts across blocks
    so a wide field doesn't overflow the page."""
    chart = state.lap_chart(last_n=100000)  # full history
    karts = [d.kart_no for d in state.drivers if chart.get(d.kart_no)]
    if not karts:
        return [Paragraph("No lap data recorded yet.", styles["ReportSmall"])]

    out: list = []
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
                row.append(fmt_lap_ms(rec["ms"]))
                if rec["pit"]:
                    pit_cells.append((ci, lap))
                if best_lap_no[k] == lap:
                    best_cells.append((ci, lap))
            rows.append(row)

        col_w = [12 * mm] + [(263 * mm - 12 * mm) / len(block)] * len(block)
        table = Table(rows, colWidths=col_w, repeatRows=1)
        style = [
            ("BACKGROUND", (0, 0), (-1, 0), INK_BLACK),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTNAME", (0, 1), (-1, -1), "Courier"),
            ("FONTSIZE", (0, 0), (-1, -1), 7),
            ("ALIGN", (0, 0), (-1, -1), "CENTER"),
            ("GRID", (0, 0), (-1, -1), 0.3, GRID_GREY),
            ("BACKGROUND", (0, 1), (0, -1), BAND_GREY),
            ("TOPPADDING", (0, 0), (-1, -1), 1.5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 1.5),
        ]
        for ci, lap in pit_cells:
            style.append(("BACKGROUND", (ci, lap), (ci, lap), PIT_BLUE))
        for ci, lap in best_cells:
            style.append(("FONTNAME", (ci, lap), (ci, lap), "Courier-Bold"))
            style.append(("TEXTCOLOR", (ci, lap), (ci, lap), RACE_RED))
        table.setStyle(TableStyle(style))
        out.append(Paragraph(
            f"Lap times — karts {', '.join('#' + k for k in block)}", styles["SectionHead"]
        ))
        out.append(table)
        out.append(Spacer(1, 5 * mm))
    return out


def _best_lap_bar(state: EventState) -> Drawing:
    rows = [(d.kart_no, d.best_lap_ms) for d in state.drivers if d.best_lap_ms]
    d = Drawing(500, 200)
    d.add(String(0, 188, "Best lap by kart (s)", fontSize=11, fontName="Helvetica-Bold"))
    if not rows:
        d.add(String(0, 90, "No lap data.", fontSize=9))
        return d
    chart = VerticalBarChart()
    chart.x, chart.y, chart.width, chart.height = 20, 20, 460, 150
    chart.data = [[ms / 1000 for _, ms in rows]]
    chart.categoryAxis.categoryNames = [f"#{k}" for k, _ in rows]
    chart.categoryAxis.labels.fontSize = 7
    chart.bars[0].fillColor = RACE_RED
    lo = min(ms for _, ms in rows) / 1000
    hi = max(ms for _, ms in rows) / 1000
    chart.valueAxis.valueMin = max(0, lo - 1)
    chart.valueAxis.valueMax = hi + 1
    chart.valueAxis.labels.fontSize = 7
    d.add(chart)
    return d


def _pace_trend(state: EventState) -> Drawing:
    """Lap-time trend for the top few karts (leaders)."""
    chart_data = state.lap_chart(last_n=100000)
    leaders = [d.kart_no for d in state.drivers[:4] if chart_data.get(d.kart_no)]
    d = Drawing(500, 220)
    d.add(String(0, 205, "Lap-time trend — leaders (s)", fontSize=11, fontName="Helvetica-Bold"))
    series = []
    palette = [RACE_RED, INK_BLACK, colors.HexColor("#3987e5"), colors.HexColor("#2fd058")]
    for k in leaders:
        pts = [(r["lap"], r["ms"] / 1000) for r in chart_data[k] if not r["pit"]]
        if pts:
            series.append(pts)
    if not series:
        d.add(String(0, 100, "No lap data.", fontSize=9))
        return d
    plot = LinePlot()
    plot.x, plot.y, plot.width, plot.height = 30, 25, 450, 160
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
        d.add(String(30 + i * 90, 8, f"#{k}", fontSize=8,
                     fillColor=palette[i % len(palette)]))
    return d


def build_timesheet_pdf(state: EventState) -> bytes:
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=landscape(A4),
        leftMargin=12 * mm, rightMargin=12 * mm,
        topMargin=12 * mm, bottomMargin=12 * mm,
        title="Race timesheet",
    )
    base = getSampleStyleSheet()
    styles = {
        "ReportTitle": ParagraphStyle(
            "ReportTitle", parent=base["Title"], fontSize=20, textColor=INK_BLACK, spaceAfter=2),
        "ReportSub": ParagraphStyle(
            "ReportSub", parent=base["Normal"], fontSize=11, textColor=RACE_RED),
        "ReportSmall": ParagraphStyle(
            "ReportSmall", parent=base["Normal"], fontSize=8, textColor=colors.grey),
        "SectionHead": ParagraphStyle(
            "SectionHead", parent=base["Heading2"], fontSize=12, textColor=INK_BLACK,
            spaceBefore=4, spaceAfter=4),
        "Cell": ParagraphStyle("Cell", parent=base["Normal"], fontSize=8),
    }

    story: list = []
    story += _header_story(state, styles)
    story.append(Paragraph("Classification", styles["SectionHead"]))
    story.append(_classification_table(state, styles))
    story.append(Spacer(1, 6 * mm))
    story.append(_best_lap_bar(state))
    story.append(Spacer(1, 4 * mm))
    story.append(_pace_trend(state))
    story.append(PageBreak())
    story.append(Paragraph("Lap-by-lap", styles["SectionHead"]))
    story += _lap_grid_tables(state, styles)

    doc.build(story)
    return buf.getvalue()


@router.get("/e/{slot}/api/export/timesheet.pdf")
def timesheet_pdf(slot: int) -> Response:
    """Downloadable chrono timesheet: classification + lap-by-lap grid + charts.
    Built from live state, so generate it before disconnecting the source."""
    if not _REPORTLAB_OK:
        raise HTTPException(status_code=503, detail="PDF export unavailable: reportlab is not installed")
    event = get_event(slot)
    pdf = build_timesheet_pdf(event.state)
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    name = f"timesheet-event{slot}-{stamp}.pdf"
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )
