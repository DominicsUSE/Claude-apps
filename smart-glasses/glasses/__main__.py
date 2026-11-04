"""Entry point: `python -m glasses [--sim] [--config FILE] [--selftest]`."""

from __future__ import annotations

import argparse
import logging
import queue
import signal
import sys
import threading
import time
from pathlib import Path

import cv2

from glasses import MODES, alerts, config
from glasses.ai.assistant import Assistant
from glasses.ai.voice import Speaker, VoiceWorker, parse_command
from glasses.hub import Hub, Worker
from glasses.hud.display import DisplayWorker
from glasses.sensors.battery import BatteryWorker
from glasses.sensors.distance import DistanceWorker
from glasses.sensors.environment import EnvironmentWorker
from glasses.sensors.radar import RadarWorker
from glasses.sensors.rf import RFWorker
from glasses.sensors.thermal import ThermalWorker
from glasses.sensors.wallprobe import WallProbeWorker
from glasses.text import status_sentence
from glasses.vision.camera import CameraWorker
from glasses.vision.detect import DetectorWorker
from glasses.vision.view import ViewWorker
from glasses.web import WebServer

log = logging.getLogger("glasses")

WORKERS = {  # config section -> worker class
    "camera": CameraWorker, "thermal": ThermalWorker, "distance": DistanceWorker,
    "environment": EnvironmentWorker, "radar": RadarWorker, "rf": RFWorker,
    "battery": BatteryWorker, "wallprobe": WallProbeWorker, "detector": DetectorWorker,
    "hud": DisplayWorker, "voice": VoiceWorker,
}
DESCRIBE = "Describe what is in front of me and anything I should watch out for."


def build_workers(hub: Hub, cfg: dict) -> dict[str, Worker]:
    workers: dict[str, Worker] = {}
    for section, cls in WORKERS.items():
        driver = cfg[section]["driver"]
        if driver == "none" or (section == "detector" and driver == "imx500"):
            continue  # disabled, or the AI camera produces detections itself
        workers[section] = cls(hub, cfg[section], section)
    if "camera" in workers:
        workers["view"] = ViewWorker(hub, {"driver": "cpu"}, "view")
    return workers


class App:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.hub = Hub(cfg)
        self.hub.put("mode", cfg["general"]["start_mode"])
        self.hub.put("zoom", 1.0)
        self.workers = build_workers(self.hub, cfg)
        self.speaker = Speaker(self.hub, cfg["voice"])
        self.assistant = Assistant(cfg["assistant"])
        self.web: WebServer | None = None
        self.ai_lock = threading.Lock()
        self.last_spoken: dict[str, float] = {}
        self.mode_button = None

    # -- lifecycle --------------------------------------------------------
    def start(self) -> None:
        for w in self.workers.values():
            w.start()
        if self.cfg["web"]["enabled"]:
            self.web = WebServer(self.hub, self.cfg["web"])
            self.web.start()
        self._setup_button()
        log.info("started %d modules: %s", len(self.workers), ", ".join(self.workers))

    def stop(self) -> None:
        self.hub.stop.set()
        if self.web:
            self.web.stop()
        for w in self.workers.values():
            w.join(timeout=3)

    def run(self, duration: float = 0) -> None:
        self.start()
        end = time.monotonic() + duration if duration else None
        next_check = 0.0
        try:
            while not self.hub.stop.is_set():
                if end and time.monotonic() > end:
                    break
                try:
                    name, arg = self.hub.commands.get(timeout=0.25)
                except queue.Empty:
                    name = None
                if name:
                    try:
                        self.handle(name, arg)
                    except Exception:  # noqa: BLE001 - a bad command must not stop the glasses
                        log.exception("command %r failed", name)
                if time.monotonic() >= next_check:
                    next_check = time.monotonic() + 0.5
                    self.check_health()
        finally:
            self.stop()

    def _setup_button(self) -> None:
        pin = int(self.cfg["general"]["mode_button_pin"])
        if pin < 0 or self.cfg["camera"]["driver"] == "sim":
            return
        try:
            from gpiozero import Button
            self.mode_button = Button(pin, pull_up=True, bounce_time=0.05)
            self.mode_button.when_pressed = lambda: self.hub.command("next_mode")
        except Exception as e:  # noqa: BLE001
            log.warning("mode button unavailable: %s", e)

    # -- periodic: alerts + thermal governor --------------------------------
    def check_health(self) -> None:
        snap = self.hub.snapshot()
        limit = float(self.cfg["general"]["cpu_throttle_c"])
        cpu = (snap.get("system") or {}).get("cpu_c")
        self.hub.put("throttle", cpu is not None and cpu >= limit)
        found = alerts.evaluate(snap, self.cfg["alerts"], limit)
        self.hub.put("alerts", found)
        if not self.cfg["voice"]["speak_alerts"]:
            return
        now = time.monotonic()
        for key, _text, level in found:
            if level < 2 or key not in alerts.SPOKEN:
                continue
            if now - self.last_spoken.get(key, -1e9) > float(self.cfg["alerts"]["cooldown_s"]):
                self.last_spoken[key] = now
                self.speaker.say(alerts.SPOKEN[key])
                break  # one spoken alert per check

    # -- commands from voice, web and buttons -------------------------------
    def handle(self, name: str, arg=None) -> None:
        hub = self.hub
        if name == "text":
            name, arg = parse_command(arg)
        if name == "mode" and arg in MODES:
            hub.put("mode", arg)
            self.speaker.say(f"{arg} mode")
        elif name == "next_mode":
            modes = list(MODES)
            self.handle("mode", modes[(modes.index(hub.get("mode", "normal")) + 1) % len(modes)])
        elif name == "zoom":
            z = 1.0 if arg == 0 else float(hub.get("zoom", 1.0)) * (1.5 if arg > 0 else 1 / 1.5)
            hub.put("zoom", round(min(max(z, 1.0), float(self.cfg["camera"]["max_zoom"])), 2))
        elif name == "ir":
            hub.put("ir_override", bool(arg))
        elif name == "say":
            self.speaker.say(status_sentence(arg, hub.snapshot()))
        elif name == "wall_calibrate":
            hub.put("wall_calibrate", True)
            self.speaker.say("Hold the probe on a bare wall section.")
        elif name == "battery_full":
            hub.put("battery_reset", True)
            self.speaker.say("Battery counter reset.")
        elif name == "snapshot":
            self.snapshot()
        elif name in ("describe", "ask"):
            question = DESCRIBE if name == "describe" else arg
            threading.Thread(target=self._ask, args=(question,), name="ask", daemon=True).start()
        else:
            log.warning("unknown command %r", name)

    def _ask(self, question: str) -> None:
        if not self.ai_lock.acquire(blocking=False):
            self.speaker.say("Still working on the last question.")
            return
        try:
            self.hub.put("ai_busy", True)
            if "detector" in self.workers:  # fresh on-device detections give the AI hints
                self.hub.put("detect_request", True)
                time.sleep(1.5 if self.cfg["detector"]["driver"] == "sim" else 3.0)
            frame = self.hub.get("frame", max_age=2.0)
            answer = self.assistant.ask(question, frame, self.hub.snapshot())
            self.hub.put("ai_answer", answer)
            self.speaker.say(answer)
        finally:
            self.hub.put("ai_busy", False)
            self.ai_lock.release()

    def snapshot(self) -> Path | None:
        frame = self.hub.get("frame", max_age=2.0)
        if frame is None:
            self.speaker.say("No camera image.")
            return None
        folder = Path(self.cfg["general"]["capture_dir"]).expanduser()
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / time.strftime("%Y%m%d-%H%M%S.jpg")
        cv2.imwrite(str(path), frame)
        self.speaker.say("Photo saved.")
        return path

    def selftest(self) -> int:
        """Probe every enabled module once; exit code = number of failures."""
        failures = 0
        for name, worker in self.workers.items():
            verdict = worker.selftest()
            failures += verdict != "OK"
            print(f"{name:12s} {worker.driver:10s} {verdict}")
        return failures


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="glasses", description=__doc__)
    ap.add_argument("--config", help="TOML file with overrides (default: ./config.toml if present)")
    ap.add_argument("--sim", action="store_true", help="simulate all hardware")
    ap.add_argument("--selftest", action="store_true", help="probe each module once and exit")
    ap.add_argument("--duration", type=float, default=0, help="exit after N seconds")
    args = ap.parse_args(argv)

    path = args.config or ("config.toml" if Path("config.toml").exists() else None)
    cfg = config.load(path, sim=args.sim)
    logging.basicConfig(level=cfg["general"]["log_level"],
                        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    if args.sim:
        cfg["general"]["capture_dir"] = cfg["general"]["capture_dir"] + "-sim"
    app = App(cfg)
    if args.selftest:
        return app.selftest()
    signal.signal(signal.SIGTERM, lambda *_: app.hub.stop.set())
    try:
        app.run(args.duration)
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
