"""Public results API — read-only access to PUBLISHED saved snapshots.

This is also the machine-readable seam for a future cross-app integration:
`GET /api/results` returns structured metadata (incl. track/tags/podium) for
every published session. Private notes and internal blocks are never exposed.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Response

from .. import snapshots
from .export import snapshot_pdf_response

router = APIRouter()


def _published_or_404(snapshot_id: str) -> dict:
    record = snapshots.load_record(snapshot_id)
    if record is None or not record.get("published"):
        raise HTTPException(status_code=404, detail="result not found")
    return record


@router.get("/api/results")
def list_results() -> dict:
    """Published sessions (newest first) as lightweight cards."""
    return {
        "results": [
            snapshots.meta_of(r) for r in snapshots.list_records() if r.get("published")
        ]
    }


@router.get("/api/results/{snapshot_id}")
def get_result(snapshot_id: str) -> dict:
    """A published session's public view: renderable snapshot + public notes,
    with private notes stripped."""
    return snapshots.public_view(_published_or_404(snapshot_id))


@router.get("/api/results/{snapshot_id}/timesheet.pdf")
def result_pdf(
    snapshot_id: str, charts: bool = False, grid: bool = True,
    pits: bool = False, stints: bool = False, pitest: bool = False,
    penalties: bool = False,
    event: str = "", session: str = "", accent: str = "#e10600",
) -> Response:
    record = _published_or_404(snapshot_id)
    return snapshot_pdf_response(
        record, charts=charts, grid=grid, pits=pits, stints=stints, pitest=pitest,
        penalties=penalties, event=event, session=session, accent=accent,
    )
