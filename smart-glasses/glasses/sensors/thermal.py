"""Thermal imaging: AMG8833 (8x8), MLX90640 (32x24), InfiRay P2 Pro (256x192 USB).

All drivers publish a float32 array of degrees Celsius as ``thermal`` and a
summary dict as ``thermal_stats``. These are real long-wave IR (8-14 um)
sensors: they measure emitted heat, work in total darkness, and cannot see
through glass - mount them with a clear opening, never behind a lens.
"""

from __future__ import annotations

import time

import numpy as np

from glasses.hub import Worker, require
from glasses.sensors import i2c_bus


def thermal_stats(t: np.ndarray) -> dict:
    """Min/max/mean, centre-spot temperature and hotspot position (0..1)."""
    h, w = t.shape
    row, col = divmod(int(np.argmax(t)), w)
    cy, cx = h // 2, w // 2
    return {
        "min": float(t.min()),
        "max": float(t.max()),
        "mean": float(t.mean()),
        "center": float(t[cy - 1:cy + 1, cx - 1:cx + 1].mean()),
        "hot_x": (col + 0.5) / w,
        "hot_y": (row + 0.5) / h,
    }


def p2pro_to_celsius(raw: np.ndarray) -> np.ndarray:
    """Decode an InfiRay P2 Pro UVC frame (256x384 YUYV) into a 192x256 °C array.

    The camera stacks a preview image (top half) over raw 16-bit data
    (bottom half) in units of 1/64 kelvin. Verify against a known temperature
    on your unit: firmware revisions have differed.
    """
    frame = raw.reshape(384, 256, 2)
    data = np.ascontiguousarray(frame[192:]).view("<u2").reshape(192, 256)
    return data.astype(np.float32) / 64.0 - 273.15


def sim_thermal(t: float, shape=(24, 32)) -> np.ndarray:
    """Synthetic scene: warm floor gradient, a walking person, a hot mug."""
    h, w = shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    scene = 21.0 + 1.5 * yy / h
    px = w * (0.5 + 0.3 * np.sin(t * 0.4))
    scene += 13.0 * np.exp(-(((xx - px) / (w * 0.09)) ** 2 + ((yy - h * 0.45) / (h * 0.3)) ** 2))
    if int(t / 15) % 2 == 0:  # the mug comes and goes every 15 s
        scene += 45.0 * np.exp(-(((xx - w * 0.2) / (w * 0.04)) ** 2 + ((yy - h * 0.75) / (h * 0.05)) ** 2))
    return scene + np.random.normal(0, 0.15, shape).astype(np.float32)


class ThermalWorker(Worker):
    def setup(self) -> None:
        d = self.driver
        if d == "mlx90640":
            mlx = require("adafruit_mlx90640", "pip install adafruit-circuitpython-mlx90640")
            self.dev = mlx.MLX90640(i2c_bus())
            rates = {1: "REFRESH_1_HZ", 2: "REFRESH_2_HZ", 4: "REFRESH_4_HZ",
                     8: "REFRESH_8_HZ", 16: "REFRESH_16_HZ"}
            self.dev.refresh_rate = getattr(mlx.RefreshRate, rates[int(self.cfg["mlx_refresh_hz"])])
            self.buf = [0.0] * 768
        elif d == "amg8833":
            amg = require("adafruit_amg88xx", "pip install adafruit-circuitpython-amg88xx")
            self.dev = amg.AMG88XX(i2c_bus())
        elif d == "p2pro":
            import cv2
            dev = self.cfg["device"]
            self.dev = cv2.VideoCapture(dev if isinstance(dev, str) else int(dev), cv2.CAP_V4L2)
            self.dev.set(cv2.CAP_PROP_CONVERT_RGB, 0)
            self.dev.set(cv2.CAP_PROP_FRAME_WIDTH, 256)
            self.dev.set(cv2.CAP_PROP_FRAME_HEIGHT, 384)
            if not self.dev.isOpened():
                raise RuntimeError(f"no UVC thermal camera at {dev} (see `v4l2-ctl --list-devices`)")
            self.interval = 0  # read() blocks until the next frame
        elif d == "sim":
            self.t0 = time.monotonic()
        else:
            raise ValueError(f"unknown thermal driver {d!r}")

    def read(self) -> np.ndarray | None:
        d = self.driver
        if d == "mlx90640":
            try:
                self.dev.getFrame(self.buf)
            except ValueError:  # occasional "too many retries" on a busy bus: skip frame
                return None
            return np.array(self.buf, dtype=np.float32).reshape(24, 32)
        if d == "amg8833":
            self.hub.put("ambient_c", float(self.dev.temperature))  # on-board thermistor
            return np.array(self.dev.pixels, dtype=np.float32)
        if d == "p2pro":
            ok, raw = self.dev.read()
            if not ok:
                raise RuntimeError("thermal camera stopped sending frames")
            return p2pro_to_celsius(raw)
        return sim_thermal(time.monotonic() - self.t0)

    def step(self) -> None:
        t = self.read()
        if t is None:
            return
        if self.cfg["flip_h"]:
            t = t[:, ::-1]
        if self.cfg["flip_v"]:
            t = t[::-1, :]
        t = np.ascontiguousarray(t)
        self.hub.put("thermal", t)
        self.hub.put("thermal_stats", thermal_stats(t))

    def close(self) -> None:
        if self.driver == "p2pro" and hasattr(self, "dev"):
            self.dev.release()
