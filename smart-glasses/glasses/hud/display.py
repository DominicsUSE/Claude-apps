"""Drives the physical HUD display through luma (OLED/LCD) and keeps the latest
HUD image in the hub for the web dashboard preview."""

from __future__ import annotations

from PIL import ImageOps

from glasses.hub import Worker, require
from glasses.hud.render import HudRenderer


class DisplayWorker(Worker):
    def setup(self) -> None:
        c, d = self.cfg, self.driver
        w, h, rot = int(c["width"]), int(c["height"]), int(c["rotate"])
        # Render unmirrored for the dashboard preview; mirror only what the optics reflect.
        self.renderer = HudRenderer(w, h, color=d in ("ssd1351", "st7789"))
        self.mirror = bool(c["mirror"])
        self.interval = 1.0 / float(c["fps"])
        self.device = None
        if d == "sim":
            return
        serial = require("luma.core.interface.serial", "pip install luma.oled")
        if d in ("ssd1306", "sh1106"):
            oled = require("luma.oled.device", "pip install luma.oled")
            bus = serial.i2c(port=1, address=int(c["i2c_address"]))
            self.device = getattr(oled, d)(bus, width=w, height=h, rotate=rot)
        elif d in ("ssd1351", "st7789"):
            bus = serial.spi(port=0, device=0, gpio_DC=int(c["spi_dc_pin"]),
                             gpio_RST=int(c["spi_rst_pin"]), bus_speed_hz=int(c["spi_hz"]))
            if d == "ssd1351":
                oled = require("luma.oled.device", "pip install luma.oled")
                self.device = oled.ssd1351(bus, width=w, height=h, rotate=rot)
            else:
                lcd = require("luma.lcd.device", "pip install luma.lcd")
                self.device = lcd.st7789(bus, width=w, height=h, rotate=rot)
        else:
            raise ValueError(f"unknown hud driver {d!r}")
        try:
            self.device.contrast(int(c["contrast"]))
        except (AttributeError, NotImplementedError):
            pass  # some LCD drivers have no contrast control

    def step(self) -> None:
        img = self.renderer.render(self.hub.snapshot())
        self.hub.put("hud_image", img)
        if self.device is not None:
            out = ImageOps.mirror(img) if self.mirror else img
            self.device.display(out.convert(self.device.mode))

    def close(self) -> None:
        if getattr(self, "device", None) is not None:
            self.device.cleanup()
