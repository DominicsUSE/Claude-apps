"""Distance: VL53L0X (~2 m), VL53L1X (~4 m), TF-Luna LiDAR (~8 m).

Publishes ``distance`` in metres, or None when nothing is in range.
ToF sensors lose range in direct sunlight and on black or glossy surfaces.
"""

from __future__ import annotations

import math
import time

from glasses.hub import Worker, require
from glasses.sensors import i2c_bus

TFLUNA_ADDR = 0x10


class DistanceWorker(Worker):
    def setup(self) -> None:
        d = self.driver
        if d == "vl53l0x":
            vl = require("adafruit_vl53l0x", "pip install adafruit-circuitpython-vl53l0x")
            self.dev = vl.VL53L0X(i2c_bus())
            self.dev.measurement_timing_budget = 33000  # us; ~30 Hz
        elif d == "vl53l1x":
            vl = require("adafruit_vl53l1x", "pip install adafruit-circuitpython-vl53l1x")
            self.dev = vl.VL53L1X(i2c_bus())
            self.dev.distance_mode = 2   # long range
            self.dev.timing_budget = 100
            self.dev.start_ranging()
        elif d == "tfluna":
            self.dev = i2c_bus()
            self.buf = bytearray(6)
        elif d == "sim":
            self.t0 = time.monotonic()
        else:
            raise ValueError(f"unknown distance driver {d!r}")

    def read(self) -> float | None:
        d = self.driver
        if d == "vl53l0x":
            mm = self.dev.range
            return mm / 1000 if 0 < mm < 2000 else None
        if d == "vl53l1x":
            if not self.dev.data_ready:
                return self.hub.get("distance")
            cm = self.dev.distance  # None when out of range
            self.dev.clear_interrupt()
            return cm / 100 if cm else None
        if d == "tfluna":
            while not self.dev.try_lock():
                pass
            try:
                self.dev.writeto_then_readfrom(TFLUNA_ADDR, bytes([0x00]), self.buf)
            finally:
                self.dev.unlock()
            cm = self.buf[0] | self.buf[1] << 8
            strength = self.buf[2] | self.buf[3] << 8
            return cm / 100 if strength >= 100 and 0 < cm < 800 else None
        t = time.monotonic() - self.t0
        return round(1.6 + 1.3 * math.sin(t * 0.35), 2)

    def step(self) -> None:
        self.hub.put("distance", self.read())

    def close(self) -> None:
        if self.driver == "vl53l1x" and hasattr(self, "dev"):
            self.dev.stop_ranging()
        elif self.driver == "tfluna" and hasattr(self, "dev"):
            self.dev.deinit()
