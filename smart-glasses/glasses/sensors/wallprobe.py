"""Handheld wall probe (ESP32 firmware in firmware/wall_probe) over Wi-Fi UDP.

The probe must touch the wall. It reports three raw signals:
- ``cap``: ESP32 touch reading of a copper pad; it DROPS over denser material
  (a stud behind drywall, a water-filled pipe).
- ``mag``: magnetometer field strength; changes near ferrous metal (screws and
  nails in studs, steel pipes, rebar). Copper and aluminium are invisible to it.
- ``ac``: 50 Hz field picked up by an antenna wire; rises near live, unshielded
  mains conductors close to the surface.

Baselines come from a calibration on a bare wall section. This is a hint
tool, NOT a safety device: always isolate circuits and use a certified
detector before drilling. Publishes ``wall``.
"""

from __future__ import annotations

import json
import math
import socket
import time

from glasses.hub import Worker


def classify(reading: dict, base: dict, cfg: dict) -> dict:
    """Compare a probe reading against the calibration baseline."""
    cap_delta = base["cap"] - reading["cap"]
    mag_delta = abs(reading["mag"] - base["mag"])
    levels = {  # 1.0 = exactly at the threshold
        "stud": cap_delta / cfg["cap_threshold"],
        "metal": mag_delta / cfg["mag_threshold"],
        "live_ac": reading["ac"] / cfg["ac_threshold"],
    }
    return {
        "cap_delta": round(cap_delta, 1),
        "mag_delta": round(mag_delta, 1),
        "ac": round(reading["ac"], 1),
        "levels": {k: round(v, 2) for k, v in levels.items()},
        **{k: v > 1.0 for k, v in levels.items()},
    }


class WallProbeWorker(Worker):
    CAL_SAMPLES = 10

    def setup(self) -> None:
        if self.driver == "udp":
            self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            self.sock.bind(("0.0.0.0", int(self.cfg["port"])))
            self.sock.settimeout(1.0)
            self.interval = 0
        elif self.driver == "sim":
            self.t0 = time.monotonic()
            self.interval = 0.1
        else:
            raise ValueError(f"unknown wallprobe driver {self.driver!r}")
        self.base: dict | None = None
        self.cal: list[dict] = []

    def _receive(self) -> dict | None:
        if self.driver == "sim":
            # Probe slides along a wall: bare wall first (calibration), then a stud
            # every 4 s with a screw in it, and a live cable every 12 s.
            t = time.monotonic() - self.t0
            over_stud = 2.0 < (t % 4) < 3.0
            return {"cap": 60 - (15 if over_stud else 0) + math.sin(t * 7),
                    "mag": 300 + (60 if over_stud and (t % 4) < 2.4 else 0),
                    "ac": 85 if 9 < (t % 12) < 10 else 8}
        try:
            data, _addr = self.sock.recvfrom(512)
        except TimeoutError:
            return None
        try:
            msg = json.loads(data)
            return {"cap": float(msg["cap"]), "mag": float(msg["mag"]), "ac": float(msg["ac"])}
        except (ValueError, KeyError, TypeError):
            return None  # not one of ours

    def step(self) -> None:
        reading = self._receive()
        if reading is None:
            return
        if self.hub.pop("wall_calibrate"):
            self.base, self.cal = None, []
        if self.base is None:  # average the first readings as the bare-wall baseline
            self.cal.append(reading)
            if len(self.cal) >= self.CAL_SAMPLES:
                self.base = {k: sum(r[k] for r in self.cal) / len(self.cal) for k in ("cap", "mag")}
            self.hub.put("wall", {"calibrating": True, "ac": reading["ac"]})
            return
        self.hub.put("wall", {"calibrating": False, **classify(reading, self.base, self.cfg)})

    def close(self) -> None:
        if hasattr(self, "sock"):
            self.sock.close()
