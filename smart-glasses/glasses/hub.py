"""Shared state store and the worker-thread base class every module uses.

Design: each sensor/output runs in its own thread and only talks to the Hub.
A dead or missing sensor never takes the rest of the system down: setup
failures are retried slowly, runtime failures are retried with backoff.
"""

from __future__ import annotations

import importlib
import logging
import queue
import threading
import time

log = logging.getLogger(__name__)


class Hub:
    """Thread-safe latest-value store plus a command queue."""

    def __init__(self, cfg: dict):
        self.cfg = cfg
        self._lock = threading.Lock()
        self._data: dict = {}
        self._stamps: dict = {}
        self.status: dict[str, str] = {}
        self.commands: queue.Queue = queue.Queue()
        self.stop = threading.Event()

    def put(self, key: str, value) -> None:
        with self._lock:
            self._data[key] = value
            self._stamps[key] = time.monotonic()

    def get(self, key: str, default=None, max_age: float | None = None):
        """Latest value, or ``default`` if missing or older than ``max_age`` s."""
        with self._lock:
            if key not in self._data:
                return default
            if max_age is not None and time.monotonic() - self._stamps[key] > max_age:
                return default
            return self._data[key]

    def pop(self, key: str, default=None):
        with self._lock:
            self._stamps.pop(key, None)
            return self._data.pop(key, default)

    def snapshot(self, max_age: float = 10.0) -> dict:
        """Shallow copy of all values newer than ``max_age`` seconds.

        Stale sensor values are dropped so the HUD shows "--" instead of a
        frozen reading when a sensor dies. Settings (mode, zoom) are exempt.
        """
        now = time.monotonic()
        keep = {"mode", "zoom", "ai_answer", "ir_override"}
        with self._lock:
            return {
                k: v for k, v in self._data.items()
                if k in keep or now - self._stamps[k] <= max_age
            }

    def set_status(self, name: str, status: str) -> None:
        with self._lock:
            self.status[name] = status

    def command(self, name: str, arg=None) -> None:
        self.commands.put((name, arg))


def require(module: str, hint: str):
    """Import an optional hardware library with an actionable error."""
    try:
        return importlib.import_module(module)
    except ImportError as e:
        raise RuntimeError(f"python module '{module}' missing - {hint}") from e


class Worker(threading.Thread):
    """Base class: override ``setup`` (open hardware) and ``step`` (one cycle)."""

    interval = 1.0

    def __init__(self, hub: Hub, cfg: dict, name: str):
        super().__init__(name=name, daemon=True)
        self.hub = hub
        self.cfg = cfg
        self.driver = cfg.get("driver", "sim")
        self.interval = float(cfg.get("interval", self.interval))
        self.heartbeat = 0.0

    def setup(self) -> None:
        """Open the device. Raise on failure; it is retried every 30 s."""

    def step(self) -> None:
        raise NotImplementedError

    def close(self) -> None:
        """Release the device."""

    def _close_quietly(self) -> None:
        try:
            self.close()
        except Exception:  # noqa: BLE001 - closing a broken device may fail too
            log.debug("%s: close failed", self.name, exc_info=True)

    def run(self) -> None:
        ready, backoff = False, 1.0
        while not self.hub.stop.is_set():
            if not ready:
                try:
                    self.setup()
                except Exception as e:  # noqa: BLE001 - any setup failure = unavailable
                    self.hub.set_status(self.name, f"unavailable: {e}")
                    log.warning("%s unavailable: %s (retrying in 30 s)", self.name, e)
                    self._close_quietly()
                    self.hub.stop.wait(30)
                    continue
                ready, backoff = True, 1.0
                self.hub.set_status(self.name, f"ok ({self.driver})")
            try:
                self.step()
                self.heartbeat = time.monotonic()
                if self.interval > 0:
                    self.hub.stop.wait(self.interval)
            except Exception as e:  # noqa: BLE001 - keep the glasses running
                ready = False
                self.hub.set_status(self.name, f"error: {e}")
                log.exception("%s failed; restarting in %.0f s", self.name, backoff)
                self._close_quietly()
                self.hub.stop.wait(backoff)
                backoff = min(backoff * 2, 30.0)
        self._close_quietly()

    def selftest(self) -> str:
        """Run setup + one step synchronously; return a one-line verdict."""
        try:
            self.setup()
            self.step()
            return "OK"
        except Exception as e:  # noqa: BLE001
            return f"FAIL: {e}"
        finally:
            self._close_quietly()
