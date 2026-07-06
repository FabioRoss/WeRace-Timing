from __future__ import annotations

import json
import time
from pathlib import Path


class FrameRecorder:
    """Appends raw upstream frames to an ndjson file for later replay/analysis."""

    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self._file = None
        self.path: Path | None = None

    @property
    def active(self) -> bool:
        return self._file is not None

    def start(self, slot: int, label: str = "") -> Path:
        self.stop()
        self.directory.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        safe_label = "".join(c if c.isalnum() or c in "-_" else "_" for c in label)[:40]
        name = f"slot{slot}-{stamp}{'-' + safe_label if safe_label else ''}.ndjson"
        self.path = self.directory / name
        self._file = self.path.open("a", encoding="utf-8")
        return self.path

    def write(self, payload: str, meta: dict | None = None) -> None:
        if not self._file:
            return
        record = {"ts": time.time(), "payload": payload}
        if meta:
            record.update(meta)
        self._file.write(json.dumps(record, ensure_ascii=False) + "\n")
        self._file.flush()

    def stop(self) -> None:
        if self._file:
            self._file.close()
            self._file = None
