"""Radar motion/presence: RCWL-0516, HLK-LD2410(C), HLK-LD2450.

What these can do: detect that something is moving (RCWL-0516), report the
distance of a moving or breathing person (LD2410), or track up to three
people in x/y (LD2450). Microwaves pass through thin plastic, wood and
drywall, so they may react to motion behind them - but they produce no
image and cannot "see through walls". Publishes ``radar`` as a dict.
"""

from __future__ import annotations

import math
import time

from glasses.hub import Worker, require

LD2410_HEAD = b"\xF4\xF3\xF2\xF1"
LD2410_TAIL = b"\xF8\xF7\xF6\xF5"
LD2450_HEAD = b"\xAA\xFF\x03\x00"
LD2450_TAIL = b"\x55\xCC"
LD2450_LEN = 30


def _u16(b, i: int) -> int:
    return b[i] | b[i + 1] << 8


def parse_ld2410(buf: bytearray) -> tuple[dict | None, bytearray]:
    """Parse LD2410 report frames; return (latest report or None, leftover bytes).

    Frame: F4F3F2F1 | len(2, LE) | type, 0xAA, state, move_cm(2), move_energy,
    still_cm(2), still_energy, detect_cm(2), 0x55, 0x00 | F8F7F6F5.
    Works for basic (type 0x02) and engineering (0x01) frames.
    """
    report = None
    while True:
        i = buf.find(LD2410_HEAD)
        if i < 0:
            return report, buf[-3:]
        if len(buf) < i + 6:
            return report, buf[i:]
        n = _u16(buf, i + 4)
        if n > 64:  # garbage length: skip this header
            buf = buf[i + 4:]
            continue
        end = i + 6 + n + 4
        if len(buf) < end:
            return report, buf[i:]
        body, tail = buf[i + 6:i + 6 + n], buf[i + 6 + n:end]
        buf = buf[end:]
        if tail != LD2410_TAIL or n < 13 or body[1] != 0xAA:
            continue
        state = body[2]
        moving, still = bool(state & 1), bool(state & 2)
        report = {
            "presence": state != 0,
            "moving": moving,
            "still": still,
            "move_m": _u16(body, 3) / 100,
            "still_m": _u16(body, 6) / 100,
            "distance_m": _u16(body, 9) / 100 if state else None,
            "targets": [],
        }


def _signed(v: int) -> int:
    """LD2450 sign-magnitude: MSB set means positive."""
    return v & 0x7FFF if v & 0x8000 else -(v & 0x7FFF)


def parse_ld2450(buf: bytearray) -> tuple[dict | None, bytearray]:
    """Parse LD2450 frames (3 targets x 8 bytes); return (latest report, leftover)."""
    report = None
    while True:
        i = buf.find(LD2450_HEAD)
        if i < 0:
            return report, buf[-3:]
        if len(buf) < i + LD2450_LEN:
            return report, buf[i:]
        frame, buf = buf[i:i + LD2450_LEN], buf[i + LD2450_LEN:]
        if frame[28:30] != LD2450_TAIL:
            continue
        targets = []
        for k in range(3):
            o = 4 + 8 * k
            x, y, speed, res = (_u16(frame, o + j) for j in (0, 2, 4, 6))
            if x == y == speed == res == 0:
                continue  # empty slot
            targets.append({"x_m": _signed(x) / 1000, "y_m": _signed(y) / 1000,
                            "speed_mps": _signed(speed) / 100})
        dists = [math.hypot(t["x_m"], t["y_m"]) for t in targets]
        report = {
            "presence": bool(targets),
            "moving": any(abs(t["speed_mps"]) > 0.05 for t in targets),
            "still": False,
            "distance_m": round(min(dists), 2) if dists else None,
            "targets": targets,
        }


class RadarWorker(Worker):
    def setup(self) -> None:
        d = self.driver
        if d == "rcwl0516":
            gpiozero = require("gpiozero", "sudo apt install python3-gpiozero")
            self.dev = gpiozero.DigitalInputDevice(int(self.cfg["gpio_pin"]), pull_up=False)
        elif d in ("ld2410", "ld2450"):
            serial = require("serial", "pip install pyserial")
            self.dev = serial.Serial(self.cfg["port"], int(self.cfg["baud"]), timeout=0)
            self.buf = bytearray()
            self.parse = parse_ld2410 if d == "ld2410" else parse_ld2450
        elif d == "sim":
            self.t0 = time.monotonic()
        else:
            raise ValueError(f"unknown radar driver {d!r}")

    def step(self) -> None:
        d = self.driver
        if d == "rcwl0516":
            motion = bool(self.dev.value)
            report = {"presence": motion, "moving": motion, "still": False,
                      "distance_m": None, "targets": []}
        elif d in ("ld2410", "ld2450"):
            self.buf += self.dev.read(self.dev.in_waiting or 1)
            report, self.buf = self.parse(self.buf)
            if report is None:
                return
        else:
            t = time.monotonic() - self.t0
            moving = int(t / 6) % 2 == 0
            dist = round(2.5 + 1.5 * math.sin(t * 0.3), 2)
            report = {"presence": True, "moving": moving, "still": not moving,
                      "distance_m": dist, "targets": [{"x_m": 0.4, "y_m": dist, "speed_mps": 0.3}]}
        self.hub.put("radar", report)

    def close(self) -> None:
        if hasattr(self, "dev"):
            self.dev.close()
