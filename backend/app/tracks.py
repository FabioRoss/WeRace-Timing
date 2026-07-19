"""Known timing endpoints, ported from the ESP32 project's TRACKS map."""

from .models import SourceConfig

APEX_ORIGIN = "https://www.apex-timing.com"
APEX_ORIGIN_ALT = "https://apex-timing.com"
MYWER_ORIGIN = "https://stg.mk.time2race.it"


# Per-entry defaults you can pre-set here so a track is ready the moment you
# connect (all still overridable live in the RC config tab):
#   track_name          OPTIONAL clean display name. "" = use the feed's name;
#                       set it to override that name everywhere the session is
#                       shown/exported.
#   auto_pitlane        False for venues WITHOUT pit-lane timing gates → pits and
#                       stint times are inferred from lap times. True (or unset)
#                       for gate venues → everything comes from the feed.
#   recompute_positions True when the timing software keeps the start grid and
#                       never reorders (christel/some MyWeR by-laps) → rebuild the
#                       order from laps + total time.
#   hide_team_penalties True to keep the team dashboard's penalty panels hidden
#                       (e.g. until penalties are official).
# Leave a field as None/"" to not touch it. Example:
#   _mywer("Christel (MyWeR)", "/live/42/ranking/", track_name="Circuito Christel Village",
#          auto_pitlane=False, recompute_positions=True)
def _apex(label: str, port: int, origin: str = APEX_ORIGIN, page: str = "",
          track_name: str = "", auto_pitlane: bool | None = None,
          recompute_positions: bool | None = None,
          hide_team_penalties: bool | None = None) -> SourceConfig:
    # The live feed is served from live-data.apex-timing.com (wss works there);
    # www.apex-timing.com resets the TLS handshake on these ports.
    return SourceConfig(
        kind="apex",
        label=label,
        track_name=track_name,
        url=f"wss://live-data.apex-timing.com:{port}/",
        origin=origin,
        page=page,
        auto_pitlane=auto_pitlane,
        recompute_positions=recompute_positions,
        hide_team_penalties=hide_team_penalties,
    )


def _mywer(label: str, path: str, track_name: str = "", auto_pitlane: bool | None = None,
           recompute_positions: bool | None = None,
           hide_team_penalties: bool | None = None) -> SourceConfig:
    return SourceConfig(
        kind="mywer",
        label=label,
        track_name=track_name,
        url=f"wss://api-stg.mk.time2race.it{path}",
        origin=MYWER_ORIGIN,
        auto_pitlane=auto_pitlane,
        recompute_positions=recompute_positions,
        hide_team_penalties=hide_team_penalties,
    )


TRACK_CATALOG: list[SourceConfig] = [
    _mywer("Rozzano (MyWeR)", "/live/37/ranking/", track_name="Big Kart Rozzano", auto_pitlane=True, recompute_positions=False, hide_team_penalties=True),
    # Christel runs by-laps races the software expresses as timed and never
    # reorders, and has no pit-lane timing → recompute the order, infer pits.
    _mywer("Christel (MyWeR)", "/live/42/ranking/", track_name="Circuito Christel Village",
           auto_pitlane=False, recompute_positions=True),
    _mywer("Extremakart (MyWeR)", "/live/47/ranking/", track_name="Extrema Kart", auto_pitlane=True, recompute_positions=False),
    _apex(
        "Cremona (Apex)", 7203,
        page="https://www.apex-timing.com/live-timing/cremona-circuit/index.html",
    ),
    #_apex("Pomposa (Apex)", 8293),
    #_apex("South Garda (Apex)", 7443),
    #_apex("LS Timing (Apex)", 9583, origin=APEX_ORIGIN_ALT),
    #_apex("RGMMC (Apex)", 7683),
    #_apex("RGMMC 2 (Apex)", 7063),
    #_apex("Ultratiming (Apex)", 7343),
    #_apex("Ultratiming 2 (Apex)", 7273),
    #_mywer("La Quercia 58 (MyWeR)", "/live/26/ranking/"),
    #_mywer("Gulli Barcellona (MyWeR)", "/live/38/ranking/?user_id=3"),
    #_mywer("GH Moto (MyWeR)", "/live/41/ranking/"),
    #_mywer("Misano (MyWeR)", "/live/34/ranking/"),
    #_mywer("Alpe Adria (MyWeR)", "/live/25/ranking/"),
    #SourceConfig(kind="simulator", label="Simulator (demo race)"),
]
