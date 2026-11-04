"""Voice: offline speech-to-text (Vosk), command parsing, text-to-speech.

Push-to-talk (default) only runs the recogniser while the button is held:
far less CPU and battery than always-on listening, and no accidental
triggers. Recognised text goes to the app as a ("text", ...) command.
"""

from __future__ import annotations

import json
import logging
import queue
import re
import shutil
import subprocess
import threading

import numpy as np

from glasses.config import resolve
from glasses.hub import Hub, Worker, require

log = logging.getLogger(__name__)

RATE = 16000
CHUNK = 3200  # 100 ms of 16-bit mono audio

# (regex, command, argument) - first match wins; anything else is a question.
COMMANDS = [
    (r"\b(fusion|overlay|blend)\b", "mode", "fusion"),
    (r"\b(thermal|heat|infrared)\b", "mode", "thermal"),
    (r"\bnight\b", "mode", "night"),
    (r"\b(low light|dark mode|enhance)\b", "mode", "lowlight"),
    (r"\b(normal|camera) (mode|view)\b|\bnormal\b", "mode", "normal"),
    (r"\b(sensors?|environment) (mode|page|view)\b", "mode", "sensors"),
    (r"\bcalibrate\b", "wall_calibrate", None),
    (r"\b(wall|stud) (mode|scan|probe)\b", "mode", "wall"),
    (r"\bzoom in\b", "zoom", 1),
    (r"\bzoom out\b", "zoom", -1),
    (r"\breset zoom\b|\bno zoom\b", "zoom", 0),
    (r"\b(lights?|illuminator|i r) on\b", "ir", True),
    (r"\b(lights?|illuminator|i r) off\b", "ir", False),
    (r"\bbattery (is )?full\b", "battery_full", None),
    (r"\b(take a )?(photo|picture|snapshot)\b", "snapshot", None),
    (r"\b(how far|distance)\b", "say", "distance"),
    (r"\bbattery\b", "say", "battery"),
    (r"\b(temperature|how hot|how warm)\b", "say", "temperature"),
    (r"\bstatus\b", "say", "status"),
    (r"\b(describe|what do you see|what's in front|what is in front|look)\b", "describe", None),
]


def parse_command(text: str) -> tuple[str, object]:
    """Map recognised speech to (command, argument); default: ask the AI."""
    t = text.lower().strip()
    for pattern, cmd, arg in COMMANDS:
        if re.search(pattern, t):
            return cmd, arg
    return "ask", text.strip()


def apply_gain(pcm: bytes, gain: float) -> bytes:
    samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) * gain
    return np.clip(samples, -32768, 32767).astype(np.int16).tobytes()


class Speaker:
    """Serialised text-to-speech in a background thread (never blocks callers)."""

    def __init__(self, hub: Hub, cfg: dict):
        self.hub, self.cfg = hub, cfg
        self.engine = cfg["tts"]
        if self.engine == "espeak" and not shutil.which("espeak-ng"):
            log.warning("espeak-ng not installed: speech goes to the log")
            self.engine = "print"
        if self.engine == "piper" and not shutil.which("piper"):
            log.warning("piper not installed: falling back to espeak-ng")
            self.engine = "espeak" if shutil.which("espeak-ng") else "print"
        self.q: queue.Queue[str] = queue.Queue(maxsize=5)
        threading.Thread(target=self._run, name="speaker", daemon=True).start()

    def say(self, text: str) -> None:
        try:
            self.q.put_nowait(text)
        except queue.Full:
            log.warning("speech queue full, dropped: %s", text)

    def _run(self) -> None:
        while True:
            text = self.q.get()
            self.hub.put("speaking", True)  # mutes the recogniser: don't hear ourselves
            try:
                self._speak(text)
            except Exception:  # noqa: BLE001 - audio problems must not kill the app
                log.exception("speech failed")
            finally:
                self.hub.put("speaking", False)

    def _speak(self, text: str) -> None:
        log.info("[say] %s", text)
        if self.engine == "espeak":
            subprocess.run(["espeak-ng", "-s", "165", text], check=False, timeout=60)
        elif self.engine == "piper":
            model = resolve(self.cfg["piper_model"])
            rate = json.loads(model.with_suffix(".onnx.json").read_text())["audio"]["sample_rate"]
            piper = subprocess.Popen(["piper", "--model", str(model), "--output-raw"],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE)
            aplay = subprocess.Popen(["aplay", "-q", "-r", str(rate), "-f", "S16_LE", "-t", "raw", "-"],
                                     stdin=piper.stdout)
            piper.stdout.close()
            piper.communicate(text.encode(), timeout=60)
            aplay.wait(timeout=60)


class VoiceWorker(Worker):
    def setup(self) -> None:
        if self.driver == "sim":
            self.interval = 1.0  # use the dashboard's command box instead
            return
        if self.driver != "vosk":
            raise ValueError(f"unknown voice driver {self.driver!r}")
        vosk = require("vosk", "pip install vosk")
        model_dir = resolve(self.cfg["model"])
        if not model_dir.exists():
            raise RuntimeError(f"Vosk model missing: {model_dir} - run scripts/download_models.sh")
        vosk.SetLogLevel(-1)
        self.rec = vosk.KaldiRecognizer(vosk.Model(str(model_dir)), RATE)
        self.button = None
        if self.cfg["trigger"] == "button":
            gpiozero = require("gpiozero", "sudo apt install python3-gpiozero")
            self.button = gpiozero.Button(int(self.cfg["button_pin"]), pull_up=True, bounce_time=0.05)
        self.proc = subprocess.Popen(
            ["arecord", "-q", "-D", self.cfg["audio_device"], "-f", "S16_LE",
             "-r", str(RATE), "-c", "1", "-t", "raw"], stdout=subprocess.PIPE)
        self.listening = False
        self.wake = self.cfg["wake_word"].lower()
        self.interval = 0  # reading audio paces the loop

    def _dispatch(self, text: str) -> None:
        text = text.strip()
        if text:
            log.info("heard: %s", text)
            self.hub.command("text", text)

    def step(self) -> None:
        if self.driver == "sim":
            return
        pcm = self.proc.stdout.read(CHUNK)  # always drain the pipe
        if not pcm:
            raise RuntimeError("arecord stopped - check audio_device / `arecord -l`")
        if self.hub.get("speaking"):
            return
        pcm = apply_gain(pcm, float(self.cfg["mic_gain"]))
        if self.button is not None:
            if self.button.is_pressed:
                self.rec.AcceptWaveform(pcm)
                if not self.listening:
                    self.listening = True
                    self.hub.put("listening", True)
            elif self.listening:
                self.listening = False
                self.hub.put("listening", False)
                self._dispatch(json.loads(self.rec.FinalResult()).get("text", ""))
        elif self.rec.AcceptWaveform(pcm):
            text = json.loads(self.rec.Result()).get("text", "")
            if text.startswith(self.wake):
                self._dispatch(text[len(self.wake):])

    def close(self) -> None:
        if getattr(self, "proc", None):
            self.proc.kill()
        if getattr(self, "button", None):
            self.button.close()
