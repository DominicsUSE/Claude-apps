"""Builds the processed "view" image for the current mode (web dashboard).

JPEG encoding costs CPU, so frames are only produced while someone is
watching the dashboard (``viewer_seen`` updated by the web server).
"""

from __future__ import annotations

import time

import cv2
import numpy as np

from glasses.hub import Worker
from glasses.vision import enhance


def render_view(mode: str, frame: np.ndarray | None, thermal: np.ndarray | None,
                stats: dict | None, dets: list | None, zoom: float, hw_zoom: bool,
                tcfg: dict, temporal: enhance.TemporalFilter) -> np.ndarray | None:
    """Pure function: inputs from the hub -> one BGR image for the mode."""
    if mode in ("thermal", "fusion") and thermal is not None:
        if mode == "thermal" or frame is None:
            size = (frame.shape[1], frame.shape[0]) if frame is not None else (640, 480)
            img = enhance.colorize_thermal(thermal, size, tcfg["min_span_c"])
        else:
            img = enhance.fuse(frame, thermal, tcfg)
        return enhance.annotate_thermal(img, stats) if stats else img
    if frame is None:
        return None
    if not hw_zoom:
        frame = enhance.software_zoom(frame, zoom)
    if mode == "lowlight":
        img = enhance.low_light(frame, temporal)
    elif mode == "night":
        img = enhance.night(frame, temporal)
    else:
        img = frame.copy()
    if dets:
        enhance.draw_detections(img, dets)
    return img


class ViewWorker(Worker):
    def setup(self) -> None:
        self.temporal = enhance.TemporalFilter()
        self.fps = float(self.hub.cfg["camera"]["fps"])

    def step(self) -> None:
        throttle = 2 if self.hub.get("throttle") else 1
        self.interval = throttle / min(self.fps, 12.0)
        seen = self.hub.get("viewer_seen", 0.0)
        if time.monotonic() - seen > 5.0:
            self.interval = 0.5
            return
        h = self.hub
        img = render_view(
            h.get("mode", "normal"), h.get("frame", max_age=2.0), h.get("thermal", max_age=3.0),
            h.get("thermal_stats", max_age=3.0), h.get("detections", max_age=5.0),
            float(h.get("zoom", 1.0)), bool(h.get("hw_zoom")), h.cfg["thermal"], self.temporal)
        if img is None:
            return
        ok, jpg = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 75])
        if ok:
            h.put("view_jpeg", jpg.tobytes())
