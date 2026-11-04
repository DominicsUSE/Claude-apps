"""Ambient environment: BME280 (temp/humidity/pressure) or BME680 (+ gas/VOC).

Mount the sensor away from the Pi and the battery or it reads their heat.
Cheap "BME280" boards are often BMP280s (no humidity); setup reports that.
"""

from __future__ import annotations

import math
import time

from glasses.hub import Worker, require
from glasses.sensors import i2c_bus


class EnvironmentWorker(Worker):
    def setup(self) -> None:
        d = self.driver
        addr = int(self.cfg["address"])
        if d == "bme280":
            mod = require("adafruit_bme280.basic", "pip install adafruit-circuitpython-bme280")
            try:
                self.dev = mod.Adafruit_BME280_I2C(i2c_bus(), address=addr)
            except RuntimeError as e:
                raise RuntimeError(f"{e} - a fake 'BME280' is often a BMP280 (no humidity)") from e
        elif d == "bme680":
            mod = require("adafruit_bme680", "pip install adafruit-circuitpython-bme680")
            self.dev = mod.Adafruit_BME680_I2C(i2c_bus(), address=addr)
        elif d == "sim":
            self.t0 = time.monotonic()
        else:
            raise ValueError(f"unknown environment driver {d!r}")

    def step(self) -> None:
        if self.driver == "sim":
            t = time.monotonic() - self.t0
            reading = {"temp_c": round(22.0 + math.sin(t / 60), 1), "humidity": 44.0,
                       "pressure_hpa": 1013.2, "gas_kohm": None}
        else:
            reading = {
                "temp_c": round(self.dev.temperature, 1),
                "humidity": round(self.dev.relative_humidity, 1),
                "pressure_hpa": round(self.dev.pressure, 1),
                "gas_kohm": round(self.dev.gas / 1000, 1) if self.driver == "bme680" else None,
            }
        self.hub.put("environment", reading)
