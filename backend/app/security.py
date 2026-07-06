import hashlib
import hmac
import secrets
from typing import Literal

from fastapi import Header, HTTPException, Query

from .config import get_settings

Role = Literal["driver", "team"]


def make_token(slot: int, role: Role, kart_no: str) -> str:
    """Obscurity token embedded in driver/team-manager dashboard URLs.

    Includes the slot and role so a driver QR can't open the team manager
    dashboard, and the same kart number in two simultaneous events gets
    different links.
    """
    settings = get_settings()
    msg = f"{slot}:{role}:{kart_no.strip().upper()}".encode()
    digest = hmac.new(settings.secret_salt.encode(), msg, hashlib.sha256).hexdigest()
    return digest[:16]


def resolve_token(slot: int, role: Role, token: str, kart_numbers: list[str]) -> str | None:
    """Return the kart number a token belongs to, or None if it matches nothing."""
    for kart_no in kart_numbers:
        if hmac.compare_digest(make_token(slot, role, kart_no), token):
            return kart_no
    return None


def check_safeword(
    x_safeword: str = Header(default=""),
    safeword: str = Query(default=""),
) -> None:
    """FastAPI dependency guarding Race Control / Staff endpoints."""
    provided = x_safeword or safeword
    expected = get_settings().safeword
    if not provided or not secrets.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="Invalid safeword")
