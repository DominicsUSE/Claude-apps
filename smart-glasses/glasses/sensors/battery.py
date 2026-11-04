"""Battery and system health.

Two INA219 wiring options (see docs/WIRING.md):
- ``powerbank``: INA219 in the 5 V line from a USB power bank. A power bank
  hides its cell voltage, so state of charge is estimated by counting the
  energy drawn since the last full charge (say "battery full" to reset).
- ``lipo``: INA219 between the 1S LiPo and the boost board. State of charge
  comes from the cell's voltage curve, corrected for sag under load.

Always also publishes ``system``: CPU temperature, throttling, load, memory.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path

import numpy as np

from glasses.hub import Worker, require
from glasses.sensors import i2c_bus

# Resting 1S LiPo voltage -> state of charge (%). Typical curve; cells vary.
LIPO_CURVE = [(3.00, 0), (3.45, 5), (3.68, 10), (3.74, 20), (3.77, 30), (3.79, 40),
              (3.82, 50), (3.87, 60), (3.92, 70), (4.00, 80), (4.10, 90), (4.20, 100)]
STATE_FILE = Path("~/.local/state/smart-glasses/battery.json").expanduser()


def lipo_soc(volts: float, current_ma: float = 0.0, r_int: float = 0.12) -> float:
    """State of charge from cell voltage, compensating I*R sag under load."""
    ocv = volts + current_ma / 1000 * r_int
    xs, ys = zip(*LIPO_CURVE)
    return float(np.interp(ocv, xs, ys))


def system_stats() -> dict:
    stats: dict = {"load": round(os.getloadavg()[0], 2), "cpu_c": None,
                   "undervolt": False, "throttled": False, "mem_free_mb": None}
    try:
        stats["cpu_c"] = int(Path("/sys/class/thermal/thermal_zone0/temp").read_text()) / 1000
    except (OSError, ValueError):
        pass
    try:
        out = subprocess.run(["vcgencmd", "get_throttled"], capture_output=True,
                             text=True, timeout=2).stdout
        flags = int(out.strip().split("=")[1], 16)
        stats["undervolt"] = bool(flags & 0x1)   # under-voltage right now
        stats["throttled"] = bool(flags & 0x4)   # CPU throttled right now
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        pass  # not a Raspberry Pi
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemAvailable"):
                stats["mem_free_mb"] = int(line.split()[1]) // 1024
    except OSError:
        pass
    return stats


class BatteryWorker(Worker):
    def setup(self) -> None:
        d = self.driver
        if d == "ina219":
            ina = require("adafruit_ina219", "pip install adafruit-circuitpython-ina219")
            self.dev = ina.INA219(i2c_bus(), addr=int(self.cfg["address"]))
        elif d != "sim":
            raise ValueError(f"unknown battery driver {d!r}")
        self.used_wh = self._load_used()
        self.last = time.monotonic()
        self.last_save = self.last
        self.soc_ema: float | None = None

    @property
    def usable_wh(self) -> float:
        wh = self.cfg["capacity_mah"] / 1000 * 3.7
        return wh * self.cfg["efficiency"] if self.cfg["mode"] == "powerbank" else wh

    def _load_used(self) -> float:
        if self.driver == "sim":
            return 0.0
        try:
            return float(json.loads(STATE_FILE.read_text())["used_wh"])
        except (OSError, ValueError, KeyError):
            return 0.0

    def _save_used(self) -> None:
        if self.driver == "sim":
            return
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps({"used_wh": round(self.used_wh, 4)}))

    def step(self) -> None:
        self.hub.put("system", system_stats())
        if self.hub.pop("battery_reset"):
            self.used_wh, self.soc_ema = 0.0, None
        now = time.monotonic()
        dt_h, self.last = (now - self.last) / 3600, now

        if self.driver == "sim":
            volts, current_ma = 5.05, 520.0
        else:
            volts = self.dev.bus_voltage + self.dev.shunt_voltage
            # The Adafruit driver assumes a 0.1 ohm shunt ("R100"); rescale for others.
            current_ma = max(self.dev.current, 0.0) * 0.1 / float(self.cfg["shunt_ohms"])
        power_w = volts * current_ma / 1000
        self.used_wh += power_w * dt_h

        if self.cfg["mode"] == "lipo" and self.driver != "sim":
            soc = lipo_soc(volts, current_ma, self.cfg["internal_resistance"])
        else:
            soc = 100 * (1 - self.used_wh / self.usable_wh)
        soc = min(max(soc, 0.0), 100.0)
        # Smooth voltage jitter; energy counting is already smooth.
        self.soc_ema = soc if self.soc_ema is None else 0.9 * self.soc_ema + 0.1 * soc
        remaining_wh = self.usable_wh * self.soc_ema / 100
        self.hub.put("battery", {
            "soc": round(self.soc_ema, 1),
            "volts": round(volts, 3),
            "current_ma": round(current_ma, 1),
            "power_w": round(power_w, 2),
            "runtime_h": round(remaining_wh / power_w, 1) if power_w > 0.05 else None,
        })
        if now - self.last_save > 60:
            self._save_used()
            self.last_save = now

    def close(self) -> None:
        if hasattr(self, "used_wh"):
            self._save_used()
