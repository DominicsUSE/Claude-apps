"""Signal/image processing and policy logic."""

import numpy as np

from glasses import alerts, config
from glasses.sensors.battery import lipo_soc
from glasses.sensors.thermal import p2pro_to_celsius, thermal_stats
from glasses.sensors.wallprobe import classify
from glasses.text import local_answer, sensor_context, status_sentence
from glasses.vision import enhance
from glasses.vision.detect import COCO, parse_ssd
from glasses.vision.view import render_view

CFG = config.load()


def test_thermal_stats_finds_hotspot():
    t = np.full((24, 32), 20.0, np.float32)
    t[5, 30] = 80.0
    s = thermal_stats(t)
    assert s["max"] == 80.0 and s["min"] == 20.0
    assert s["hot_x"] > 0.9 and s["hot_y"] < 0.3


def test_p2pro_decoding():
    temps = np.full((192, 256), 36.6, np.float32)
    raw16 = np.round((temps + 273.15) * 64).astype("<u2")
    frame = np.zeros((384, 256, 2), np.uint8)
    frame[192:] = raw16.view(np.uint8).reshape(192, 256, 2)
    assert np.allclose(p2pro_to_celsius(frame), 36.6, atol=0.02)


def test_thermal_colour_scale_has_minimum_span():
    flat = np.full((8, 8), 22.0) + np.random.normal(0, 0.05, (8, 8))
    norm, lo, hi = enhance.normalize_thermal(flat, min_span=6.0)
    assert hi - lo >= 6.0
    assert norm.max() - norm.min() < 20  # noise is not stretched to full contrast


def test_fusion_overlay_clips_to_frame():
    frame = np.zeros((480, 640, 3), np.uint8)
    t = np.random.uniform(20, 40, (24, 32)).astype(np.float32)
    cfg = dict(CFG["thermal"], fusion_scale=1.2, fusion_offset_x=0.4)
    assert enhance.fuse(frame, t, cfg).shape == frame.shape


def test_every_mode_renders():
    frame = np.random.randint(0, 60, (480, 640, 3), np.uint8)
    t = np.random.uniform(20, 40, (24, 32)).astype(np.float32)
    temporal = enhance.TemporalFilter()
    for mode in ("normal", "lowlight", "night", "thermal", "fusion", "sensors", "wall", "ai"):
        img = render_view(mode, frame, t, thermal_stats(t), [], 2.0, False, CFG["thermal"], temporal)
        assert img.shape == (480, 640, 3), mode


def test_low_light_brightens():
    dark = np.full((120, 160, 3), 20, np.uint8)
    assert enhance.low_light(dark, enhance.TemporalFilter()).mean() > dark.mean() * 2


def test_lipo_curve_and_sag_compensation():
    assert lipo_soc(4.2) == 100 and lipo_soc(3.0) == 0
    assert 45 < lipo_soc(3.82) < 55
    assert lipo_soc(3.70, current_ma=800) > lipo_soc(3.70)  # same voltage under load = fuller cell


def test_wall_classification():
    cfg = CFG["wallprobe"]
    base = {"cap": 60.0, "mag": 300.0}
    clear = classify({"cap": 59.0, "mag": 302.0, "ac": 5.0}, base, cfg)
    assert not (clear["stud"] or clear["metal"] or clear["live_ac"])
    hit = classify({"cap": 45.0, "mag": 360.0, "ac": 90.0}, base, cfg)
    assert hit["stud"] and hit["metal"] and hit["live_ac"]
    assert hit["levels"]["stud"] > 1.0


def test_alert_priorities():
    snap = {"distance": 0.3, "thermal_stats": {"max": 75.0}, "wall": {"live_ac": True},
            "battery": {"soc": 9.0}, "system": {"cpu_c": 50.0}}
    found = alerts.evaluate(snap, CFG["alerts"], 75.0)
    assert [a[0] for a in found][:1] == ["live_ac"]
    assert {"obstacle", "hot", "battery"} <= {a[0] for a in found}
    assert alerts.evaluate({}, CFG["alerts"], 75.0) == []


def test_ssd_parsing_filters_and_clips():
    out = np.zeros((1, 1, 3, 7), np.float32)
    out[0, 0, 0] = [0, 1, 0.9, -0.1, 0.1, 0.5, 1.2]   # person, box partly outside
    out[0, 0, 1] = [0, 47, 0.3, 0.1, 0.1, 0.2, 0.2]   # cup below threshold
    out[0, 0, 2] = [0, 12, 0.9, 0.1, 0.1, 0.2, 0.2]   # "N/A" id
    dets = parse_ssd(out, 0.5)
    assert len(dets) == 1 and dets[0]["label"] == "person"
    x, y, w, h = dets[0]["box"]
    assert x == 0.0 and abs(y + h - 1.0) < 1e-6
    assert len(COCO) == 91


def test_text_helpers():
    snap = {"distance": 1.24, "thermal_stats": {"min": 20, "max": 64, "center": 30, "hot_x": 0.1, "hot_y": 0.5},
            "detections": [{"label": "cup", "score": 0.7, "box": (0.7, 0.5, 0.1, 0.1)}],
            "battery": {"soc": 80, "runtime_h": 3.5}}
    assert status_sentence("distance", snap) == "1.2 meters."
    assert "3.5 hours" in status_sentence("battery", snap)
    assert "cup" in sensor_context(snap) and "64.0 C" in sensor_context(snap)
    assert local_answer(snap).startswith("I see a cup on the right")
    assert local_answer({}) == "I can't tell right now."


class _Block:
    def __init__(self, type_, text=""):
        self.type, self.text = type_, text


class _Resp:
    def __init__(self, stop, blocks):
        self.stop_reason, self.content = stop, blocks


class _StubClient:
    """Records the request and returns a canned response (no network)."""

    def __init__(self, resp):
        self.resp, self.kwargs = resp, None
        self.beta = self
        self.messages = self

    def create(self, **kwargs):
        self.kwargs = kwargs
        return self.resp


def _assistant(resp):
    import anthropic

    from glasses.ai.assistant import Assistant
    a = Assistant(dict(CFG["assistant"], enabled=False))
    a.anthropic, a.client = anthropic, _StubClient(resp)
    return a


def test_assistant_request_shape_and_memory():
    a = _assistant(_Resp("end_turn", [_Block("thinking"), _Block("text", "A red mug, on your left.")]))
    frame = np.zeros((480, 640, 3), np.uint8)
    assert a.ask("what is that?", frame, {"distance": 1.0}) == "A red mug, on your left."
    kw = a.client.kwargs
    assert kw["fallbacks"] == "default" and kw["betas"] == ["server-side-fallback-2026-07-01"]
    first = kw["messages"][-1]["content"]
    assert first[0]["type"] == "image" and "1.00 m" in first[1]["text"]
    a.ask("and now?", None, {})
    roles = [m["role"] for m in a.client.kwargs["messages"]]
    assert roles == ["user", "assistant", "user"]  # text-only history replayed


def test_assistant_refusal_is_spoken_politely():
    a = _assistant(_Resp("refusal", []))
    assert a.ask("x", None, {}) == "I can't help with that one."
    assert a.history == []
