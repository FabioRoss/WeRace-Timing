"""Known timing endpoints, ported from the ESP32 project's TRACKS map."""

from .models import SourceConfig

APEX_ORIGIN = "https://www.apex-timing.com"
APEX_ORIGIN_ALT = "https://apex-timing.com"
MYWER_ORIGIN = "https://stg.mk.time2race.it"


def _apex(label: str, port: int, origin: str = APEX_ORIGIN) -> SourceConfig:
    # The live feed is served from live-data.apex-timing.com (wss works there);
    # www.apex-timing.com resets the TLS handshake on these ports.
    return SourceConfig(
        kind="apex",
        label=label,
        url=f"wss://live-data.apex-timing.com:{port}/",
        origin=origin,
    )


def _mywer(label: str, path: str) -> SourceConfig:
    return SourceConfig(
        kind="mywer",
        label=label,
        url=f"wss://api-stg.mk.time2race.it{path}",
        origin=MYWER_ORIGIN,
    )


TRACK_CATALOG: list[SourceConfig] = [
    _apex("Cremona (Apex)", 7203),
    _apex("Pomposa (Apex)", 8293),
    _apex("South Garda (Apex)", 7443),
    _apex("LS Timing (Apex)", 9583, origin=APEX_ORIGIN_ALT),
    _apex("RGMMC (Apex)", 7683),
    _apex("RGMMC 2 (Apex)", 7063),
    _apex("Ultratiming (Apex)", 7343),
    _apex("Ultratiming 2 (Apex)", 7273),
    _mywer("Rozzano (MyWeR)", "/live/37/ranking/"),
    _mywer("Christel (MyWeR)", "/live/42/ranking/"),
    _mywer("Extremakart (MyWeR)", "/live/47/ranking/"),
    _mywer("La Quercia 58 (MyWeR)", "/live/26/ranking/"),
    _mywer("Gulli Barcellona (MyWeR)", "/live/38/ranking/?user_id=3"),
    _mywer("GH Moto (MyWeR)", "/live/41/ranking/"),
    SourceConfig(kind="simulator", label="Simulator (demo race)"),
]
