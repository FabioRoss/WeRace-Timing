from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="WRB_", extra="ignore")

    # Secret used to derive driver/team-manager dashboard tokens.
    secret_salt: str = "change-me-please"
    # Shared password protecting Race Control and Staff dashboards.
    safeword: str = "boxbox"
    # Number of independent event slots (simultaneous races).
    num_events: int = 3
    # Public base URL used when generating shareable links / QR codes.
    # Leave empty to derive from the incoming request.
    public_base_url: str = ""
    # Directory where raw-frame recordings (.ndjson) are written / replayed from.
    recordings_dir: Path = Path("recordings")
    # Directory where optionally-saved story backgrounds are kept (max 5).
    backgrounds_dir: Path = Path("backgrounds")
    # Grace window (seconds) before a newly-assigned penalty/warning notifies the
    # team, so Race Control can delete a mistake first. Deleting before it fires
    # cancels the notification.
    penalty_notify_delay_s: float = 12.0

    host: str = "0.0.0.0"
    port: int = 8000


@lru_cache
def get_settings() -> Settings:
    return Settings()
