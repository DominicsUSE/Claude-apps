"""HUD rendering and an end-to-end run of the simulated glasses."""

import json
import threading
import time
import urllib.request

import numpy as np
import pytest

from glasses import MODES, config
from glasses.__main__ import App
from glasses.hud.render import HudRenderer
from glasses.sensors.thermal import thermal_stats

SNAP = {
    "distance": 0.45, "battery": {"soc": 72.0},
    "thermal": np.random.uniform(20, 40, (24, 32)).astype(np.float32),
    "radar": {"presence": True, "moving": True, "distance_m": 1.8},
    "environment": {"temp_c": 22.1, "humidity": 40, "pressure_hpa": 1012},
    "system": {"cpu_c": 55.0, "load": 1.1}, "rf": {"wifi_count": 7, "ble_count": 3},
    "wall": {"calibrating": False, "levels": {"stud": 1.4, "metal": 0.2, "live_ac": 0.1},
             "stud": True, "metal": False, "live_ac": False},
    "ai_answer": "A person is about two metres ahead on your left, next to a door. " * 3,
    "alerts": [("obstacle", "OBSTACLE 0.5m", 2)],
}
SNAP["thermal_stats"] = thermal_stats(SNAP["thermal"])


@pytest.mark.parametrize("size,color", [((128, 64), False), ((128, 128), True), ((240, 240), True)])
def test_hud_renders_every_mode(size, color):
    r = HudRenderer(*size, color=color, mirror=False)
    for mode in MODES:
        img = r.render({**SNAP, "mode": mode}, now=1.0)
        assert img.size == size
        assert img.mode == ("RGB" if color else "1")
        assert img.getbbox() is not None, f"{mode} rendered blank"


def test_hud_mirror_flips_left_right():
    snap = {**SNAP, "mode": "normal"}
    plain = np.array(HudRenderer(128, 64).render(snap, now=1.0))
    mirrored = np.array(HudRenderer(128, 64, mirror=True).render(snap, now=1.0))
    assert (mirrored == plain[:, ::-1]).all()


def test_sim_app_end_to_end(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    cfg = config.load(sim=True)
    cfg["web"].update(port=0, token="test")
    cfg["assistant"]["enabled"] = False  # offline answers only
    app = App(cfg)
    runner = threading.Thread(target=app.run, kwargs={"duration": 8}, daemon=True)
    runner.start()
    time.sleep(1.5)
    base = f"http://127.0.0.1:{app.web.port}"

    def post(body):
        req = urllib.request.Request(f"{base}/cmd?t=test", data=json.dumps(body).encode(), method="POST")
        return urllib.request.urlopen(req).status

    with pytest.raises(urllib.error.HTTPError):
        urllib.request.urlopen(f"{base}/state.json")  # no token -> 403
    assert post({"mode": "thermal"}) == 204
    assert post({"text": "describe"}) == 204
    time.sleep(3.0)
    state = json.loads(urllib.request.urlopen(f"{base}/state.json?t=test").read())
    assert state["mode"] == "thermal"
    for key in ("distance", "thermal_stats", "radar", "battery", "system", "environment", "wall"):
        assert key in state, key
    assert all(s.startswith("ok") for s in state["status"].values()), state["status"]
    assert state["ai_answer"].startswith("I see")
    assert urllib.request.urlopen(f"{base}/hud.png?t=test").read()[:4] == b"\x89PNG"
    stream = urllib.request.urlopen(f"{base}/stream.mjpg?t=test", timeout=5)
    assert b"--frame" in stream.read(2048)
    stream.close()
    app.hub.stop.set()
    runner.join(timeout=10)
    assert not runner.is_alive()
