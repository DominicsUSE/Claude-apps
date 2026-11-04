"""HUD renderer: hub snapshot -> PIL image, laid out for 128x64 and larger.

Monochrome OLEDs get pure black/white output (black is transparent in a
beam-splitter HUD); colour OLEDs get a colour thermal map. ``mirror`` flips
the image because the beam splitter reflects it.
"""

from __future__ import annotations

import time

from PIL import Image, ImageDraw, ImageFont, ImageOps

from glasses.text import direction
from glasses.vision.enhance import normalize_thermal

WHITE, BLACK = (255, 255, 255), (0, 0, 0)
CYAN, YELLOW, RED, GREEN = (0, 220, 255), (255, 220, 0), (255, 40, 40), (60, 255, 120)
LABELS = {"normal": "CAM", "lowlight": "LOWLT", "night": "NIGHT", "thermal": "THERM",
          "fusion": "FUSE", "sensors": "SENS", "wall": "WALL", "ai": "AI"}


def _font(size: int):
    try:
        return ImageFont.load_default(size=size)  # Pillow >= 10.1 with FreeType
    except (TypeError, AttributeError, OSError):
        return ImageFont.load_default()


class HudRenderer:
    def __init__(self, width: int, height: int, color: bool = False, mirror: bool = False):
        self.w, self.h = width, height
        self.color, self.mirror = color, mirror
        self.k = max(1.0, min(width / 128, height / 64))
        self.small = _font(round(10 * self.k))
        self.big = _font(round(22 * self.k))
        self.bar = round(11 * self.k)
        self.line = round(10 * self.k)

    def c(self, rgb):
        """Colour on colour displays, white on mono (thresholding would drop dark hues)."""
        return rgb if self.color else WHITE

    def render(self, s: dict, now: float | None = None) -> Image.Image:
        now = time.monotonic() if now is None else now
        img = Image.new("RGB", (self.w, self.h))
        d = ImageDraw.Draw(img)
        mode = s.get("mode", "normal")
        box = (0, self.bar + 1, self.w, self.h - self.bar - 1)
        pages = {"thermal": self._thermal, "fusion": self._thermal, "sensors": self._sensors,
                 "wall": self._wall, "ai": self._ai}
        pages.get(mode, self._camera)(img, d, s, box, now)
        self._top(d, s, mode, now)
        self._ticker(d, s, now)
        out = ImageOps.mirror(img) if self.mirror else img
        return out if self.color else out.convert("1", dither=Image.Dither.NONE)

    # -- bars -------------------------------------------------------------
    def _top(self, d, s, mode, now):
        label = LABELS.get(mode, mode.upper())
        tw = d.textlength(label, font=self.small)
        d.rectangle((0, 0, tw + 4, self.bar - 1), fill=self.c(CYAN))
        d.text((2, 0), label, font=self.small, fill=BLACK)
        x = self.w - 1
        soc = (s.get("battery") or {}).get("soc")
        txt = f"{soc:.0f}%" if soc is not None else "--%"
        x -= d.textlength(txt, font=self.small)
        d.text((x, 0), txt, font=self.small, fill=self.c(RED if soc is not None and soc < 15 else WHITE))
        bw, bh = round(12 * self.k), round(6 * self.k)
        bx, by = int(x) - bw - 4, (self.bar - bh) // 2
        d.rectangle((bx, by, bx + bw, by + bh), outline=WHITE)
        d.rectangle((bx + bw + 1, by + 2, bx + bw + 2, by + bh - 2), fill=WHITE)
        if soc is not None:
            d.rectangle((bx + 2, by + 2, bx + 2 + int((bw - 4) * soc / 100), by + bh - 2), fill=WHITE)
        flags = []
        if now - s.get("viewer_seen", -1e9) < 5:
            flags.append("LIVE")  # someone is watching the camera stream
        if s.get("listening"):
            flags.append("MIC")
        if s.get("ai_busy"):
            flags.append("AI")
        if flags:
            ft = " ".join(flags)
            d.text((bx - 3 - d.textlength(ft, font=self.small), 0), ft, font=self.small, fill=self.c(YELLOW))

    def _ticker(self, d, s, now):
        y = self.h - self.bar
        alerts = s.get("alerts") or []
        if alerts:
            _key, text, level = alerts[0]
            hidden = level >= 3 and int(now * 4) % 2  # critical alerts blink
            if level >= 2:
                if not hidden:
                    d.rectangle((0, y, self.w, self.h), fill=self.c(RED))
                    d.text((2, y), text, font=self.small, fill=BLACK)
            else:
                d.text((2, y), text, font=self.small, fill=self.c(YELLOW))
            return
        zoom = float(s.get("zoom", 1.0))
        left = "thinking..." if s.get("ai_busy") else "listening..." if s.get("listening") else (
            f"zoom {zoom:.1f}x" if zoom > 1.01 else "")
        d.text((2, y), left, font=self.small, fill=self.c(GREEN))
        clock = time.strftime("%H:%M")
        d.text((self.w - 1 - d.textlength(clock, font=self.small), y), clock, font=self.small, fill=WHITE)

    # -- pages ------------------------------------------------------------
    def _lines(self, d, x, y, lines, color=WHITE):
        for i, text in enumerate(lines):
            d.text((x, y + i * self.line), text, font=self.small, fill=self.c(color))

    def _camera(self, img, d, s, box, now):
        x0, y0, x1, _ = box
        dist = s.get("distance")
        near = dist is not None and dist < 0.6
        big_txt = f"{dist:.2f}m" if dist is not None else "--.--m"
        d.text((x0 + 2, y0 - 3), big_txt, font=self.big, fill=self.c(RED if near else WHITE))
        y = d.textbbox((x0 + 2, y0 - 3), big_txt, font=self.big)[3] + 1
        if s.get("ir_on"):
            d.text((x1 - d.textlength("IR", font=self.small) - 1, y0), "IR", font=self.small, fill=self.c(RED))
        dets = s.get("detections") or []
        lines = []
        if dets:
            top = dets[0]
            where = direction(top["box"][0] + top["box"][2] / 2).replace("on the ", "")
            lines.append(f"{top['label'].upper()} {top['score']:.0%} {where}")
        if r := s.get("radar"):
            state = "MOVE" if r.get("moving") else "STILL" if r.get("presence") else "CLEAR"
            dist_r = f" {r['distance_m']:.1f}m" if r.get("distance_m") else ""
            lines.append(f"RADAR {state}{dist_r}")
        self._lines(d, x0 + 2, y, lines[:2])

    def _thermal(self, img, d, s, box, now):
        x0, y0, x1, y1 = box
        t, st = s.get("thermal"), s.get("thermal_stats")
        if t is None or st is None:
            self._lines(d, x0 + 2, y0 + 8, ["NO THERMAL DATA"], RED)
            return
        aspect = t.shape[1] / t.shape[0]
        mh = y1 - y0
        mw = int(mh * aspect)
        if mw > self.w * 0.6:  # tall displays: keep room for the numbers
            mw = int(self.w * 0.6)
            mh = int(mw / aspect)
        norm, _, _ = normalize_thermal(t)
        if self.color:
            import cv2
            rgb = cv2.cvtColor(cv2.applyColorMap(
                cv2.resize(norm, (mw, mh), interpolation=cv2.INTER_CUBIC), cv2.COLORMAP_INFERNO),
                cv2.COLOR_BGR2RGB)
            mini = Image.fromarray(rgb)
        else:  # Floyd-Steinberg dithering gives a readable gray map on a 1-bit OLED
            mini = Image.fromarray(norm, "L").resize((mw, mh), Image.Resampling.BICUBIC).convert("1").convert("RGB")
        img.paste(mini, (x0, y0))
        hx, hy = x0 + int(st["hot_x"] * mw), y0 + int(st["hot_y"] * mh)
        for width, col in ((3, BLACK), (1, WHITE)):
            d.line((hx - 3, hy, hx + 3, hy), fill=col, width=width)
            d.line((hx, hy - 3, hx, hy + 3), fill=col, width=width)
        lines = [f"MAX {st['max']:.1f}", f"MIN {st['min']:.1f}", f"CTR {st['center']:.1f}"]
        if s.get("ambient_c") is not None:
            lines.append(f"AMB {s['ambient_c']:.1f}")
        self._lines(d, x0 + mw + 3, y0, lines)

    def _sensors(self, img, d, s, box, now):
        x0, y0, _, _ = box
        env, sysm, rf, r = (s.get(k) or {} for k in ("environment", "system", "rf", "radar"))
        lines = []
        if env:
            lines.append(f"AIR {env['temp_c']:.1f}C {env['humidity']:.0f}% {env['pressure_hpa']:.0f}")
        elif s.get("ambient_c") is not None:
            lines.append(f"AMBIENT {s['ambient_c']:.1f}C")
        cpu = sysm.get("cpu_c")
        lines.append(f"CPU {cpu:.0f}C LOAD {sysm.get('load', 0):.1f}" if cpu is not None
                     else f"LOAD {sysm.get('load', 0):.1f}")
        if rf:
            lines.append(f"WIFI {rf.get('wifi_count', '-')} BLE {rf.get('ble_count', '-')}")
        if r:
            dist = f" {r['distance_m']:.1f}m" if r.get("distance_m") else ""
            lines.append(f"RADAR {'MOVE' if r.get('moving') else 'PRES' if r.get('presence') else 'CLEAR'}{dist}")
        self._lines(d, x0 + 2, y0, lines[:4])

    def _wall(self, img, d, s, box, now):
        x0, y0, x1, _ = box
        w = s.get("wall")
        if not w:
            self._lines(d, x0 + 2, y0 + 4, ["NO WALL PROBE", "start the ESP32"], YELLOW)
            return
        if w.get("calibrating"):
            self._lines(d, x0 + 2, y0 + 4, ["CALIBRATING", "hold on bare wall"], YELLOW)
            return
        names = {"stud": "STUD", "metal": "METAL", "live_ac": "AC"}
        levels = w.get("levels", {})
        label_w = round(36 * self.k)
        for i, flag in enumerate(("stud", "metal", "live_ac")):
            y = y0 + i * (self.line + 3)
            on = bool(w.get(flag))
            if on:
                d.rectangle((x0, y, x0 + label_w - 2, y + self.line), fill=self.c(RED if flag == "live_ac" else GREEN))
            d.text((x0 + 2, y), names[flag], font=self.small, fill=BLACK if on else WHITE)
            frac = min(max(float(levels.get(flag, 0)) / 2, 0.0), 1.0)  # bar end = 2x threshold
            bx0, bx1 = x0 + label_w, x1 - 2
            d.rectangle((bx0, y + 2, bx1, y + self.line - 1), outline=WHITE)
            d.rectangle((bx0, y + 2, bx0 + int((bx1 - bx0) * frac), y + self.line - 1), fill=WHITE)
            mid = bx0 + (bx1 - bx0) // 2  # threshold mark
            d.line((mid, y, mid, y + self.line), fill=self.c(YELLOW))

    def _ai(self, img, d, s, box, now):
        x0, y0, x1, y1 = box
        text = s.get("ai_answer") or "Ask me something: hold the button and speak."
        words, lines, cur = text.split(), [], ""
        for word in words:
            trial = f"{cur} {word}".strip()
            if d.textlength(trial, font=self.small) <= (x1 - x0 - 4):
                cur = trial
            else:
                lines.append(cur)
                cur = word
        if cur:
            lines.append(cur)
        fit = max((y1 - y0) // self.line, 1)
        start = int(now / 2.5) % (len(lines) - fit + 1) if len(lines) > fit else 0
        self._lines(d, x0 + 2, y0, lines[start:start + fit])
