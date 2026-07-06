from __future__ import annotations

import io

from fastapi import APIRouter, HTTPException, Query, Response

from ..events import get_manager

router = APIRouter()


def get_event(slot: int):
    try:
        return get_manager().get(slot)
    except KeyError:
        raise HTTPException(status_code=404, detail="No such event slot")


@router.get("/api/slots")
def slots() -> dict:
    mgr = get_manager()
    return {
        "slots": [
            {
                "slot": event.slot,
                "connected": event.source_status().connected,
                "label": event.source_status().label,
                "event_name": event.state.race.event_name,
                "track_name": event.state.race.track_name,
            }
            for event in mgr.events.values()
        ]
    }


@router.get("/e/{slot}/api/state")
def state(slot: int) -> dict:
    event = get_event(slot)
    return event.state.snapshot(event.source_status()).model_dump()


@router.get("/e/{slot}/api/laps")
def laps(slot: int, karts: str = Query(default="")) -> dict:
    event = get_event(slot)
    selected = [k.strip() for k in karts.split(",") if k.strip()] or None
    return {"slot": slot, "laps": event.state.lap_chart(selected)}


@router.get("/api/qr.png")
def qr_png(data: str = Query(min_length=1, max_length=1000)) -> Response:
    import qrcode
    from qrcode.image.pil import PilImage

    img: PilImage = qrcode.make(data, box_size=8, border=2)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return Response(content=buf.getvalue(), media_type="image/png")
