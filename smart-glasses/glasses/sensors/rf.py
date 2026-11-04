"""Passive radio-frequency awareness.

- Wi-Fi: number of networks and best signal, using the Pi's own radio (nmcli).
- BLE: number of advertising devices and strongest RSSI (bleak).
- Optional RTL-SDR: peak power across a frequency range (rtl_power).

Receive-only and aggregate-only: no MAC addresses or identifiers are stored
(MACs are personal data under GDPR) and nothing is decoded. Publishes ``rf``.
"""

from __future__ import annotations

import logging
import random
import subprocess

from glasses.hub import Worker, require

log = logging.getLogger(__name__)


def parse_nmcli(text: str) -> dict:
    """Parse `nmcli -t -f SIGNAL dev wifi list` output (signal in %)."""
    sig = [int(line) for line in text.split() if line.isdigit()]
    return {"wifi_count": len(sig), "wifi_best_pct": max(sig, default=None)}


def parse_rtl_power(text: str) -> dict | None:
    """Peak bin of `rtl_power ... -1` CSV: date, time, f_lo, f_hi, step, n, dB..."""
    peak_db, peak_hz, levels = None, None, []
    for line in text.splitlines():
        f = [x.strip() for x in line.split(",")]
        if len(f) < 7:
            continue
        lo, step = float(f[2]), float(f[4])
        for k, db in enumerate(float(x) for x in f[6:] if x not in ("", "nan", "-nan")):
            levels.append(db)
            if peak_db is None or db > peak_db:
                peak_db, peak_hz = db, lo + k * step
    if peak_db is None:
        return None
    levels.sort()
    return {"sdr_peak_mhz": round(peak_hz / 1e6, 3), "sdr_peak_db": round(peak_db, 1),
            "sdr_floor_db": round(levels[len(levels) // 2], 1)}


class RFWorker(Worker):
    def setup(self) -> None:
        if self.driver not in ("linux", "sim"):
            raise ValueError(f"unknown rf driver {self.driver!r}")
        if self.driver == "linux" and self.cfg["ble"]:
            self.bleak = require("bleak", "pip install bleak")

    def _wifi(self) -> dict:
        out = subprocess.run(
            ["nmcli", "-t", "-f", "SIGNAL", "dev", "wifi", "list", "--rescan", "auto"],
            capture_output=True, text=True, timeout=20, check=True).stdout
        return parse_nmcli(out)

    def _ble(self) -> dict:
        import asyncio
        found = asyncio.run(self.bleak.BleakScanner.discover(
            timeout=float(self.cfg["ble_scan_s"]), return_adv=True))
        rssi = [adv.rssi for _dev, adv in found.values()]
        return {"ble_count": len(rssi), "ble_best_dbm": max(rssi, default=None)}

    def _sdr(self) -> dict:
        secs = int(self.cfg["sdr_seconds"])
        out = subprocess.run(
            ["rtl_power", "-f", self.cfg["sdr_range"], "-i", str(secs), "-1"],
            capture_output=True, text=True, timeout=secs + 30, check=True).stdout
        return parse_rtl_power(out) or {}

    def step(self) -> None:
        if self.driver == "sim":
            self.hub.put("rf", {"wifi_count": random.randint(4, 14), "wifi_best_pct": 72,
                                "ble_count": random.randint(2, 20), "ble_best_dbm": -58})
            return
        report, problems = {}, []
        parts = [("wifi", self._wifi), ("ble", self._ble), ("sdr", self._sdr)]
        for name, fn in parts:
            if not self.cfg[name]:
                continue
            try:  # one failing radio must not hide the others
                report.update(fn())
            except Exception as e:  # noqa: BLE001
                problems.append(f"{name}: {e}")
        self.hub.put("rf", report)
        self.hub.set_status(self.name, "ok" if not problems else "partial: " + "; ".join(problems))
