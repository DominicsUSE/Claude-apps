"""Image processing for each view mode. Pure functions on BGR uint8 frames.

Honest labels:
- ``low_light``: software amplification of visible light (temporal denoise,
  gamma, local contrast). It cannot invent detail where no photons arrived.
- ``night``: active near-infrared (850 nm LEDs + NoIR camera) shown as a
  monochrome, optionally green, image. Range is limited by LED power.
- ``colorize_thermal`` / ``fuse``: real thermal data from the LWIR sensor.
"""

from __future__ import annotations

import cv2
import numpy as np

_clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))


class TemporalFilter:
    """Exponential moving average across frames: cuts sensor noise in the dark.

    Moving objects smear a little; ``alpha`` trades noise for motion blur.
    """

    def __init__(self, alpha: float = 0.35):
        self.alpha = alpha
        self.acc: np.ndarray | None = None

    def __call__(self, frame: np.ndarray) -> np.ndarray:
        f = frame.astype(np.float32)
        if self.acc is None or self.acc.shape != f.shape:
            self.acc = f
        else:
            cv2.accumulateWeighted(f, self.acc, self.alpha)
        return self.acc.astype(np.uint8)


def gamma_lut(gamma: float) -> np.ndarray:
    return np.array([((i / 255.0) ** (1.0 / gamma)) * 255 for i in range(256)], dtype=np.uint8)


_GAMMA = gamma_lut(1.8)


def low_light(frame: np.ndarray, temporal: TemporalFilter) -> np.ndarray:
    smooth = temporal(frame)
    bright = cv2.LUT(smooth, _GAMMA)
    lab = cv2.cvtColor(bright, cv2.COLOR_BGR2LAB)
    lab[:, :, 0] = _clahe.apply(lab[:, :, 0])
    return cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)


def night(frame: np.ndarray, temporal: TemporalFilter, green: bool = True) -> np.ndarray:
    gray = cv2.cvtColor(temporal(frame), cv2.COLOR_BGR2GRAY)
    gray = _clahe.apply(cv2.LUT(gray, _GAMMA))
    if not green:
        return cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    out = np.zeros((*gray.shape, 3), np.uint8)
    out[:, :, 1] = gray                  # phosphor green
    out[:, :, 0] = (gray * 0.25).astype(np.uint8)
    out[:, :, 2] = (gray * 0.25).astype(np.uint8)
    return out


def normalize_thermal(t: np.ndarray, min_span: float = 6.0) -> tuple[np.ndarray, float, float]:
    """Scale °C to 0..255; never narrower than ``min_span``.

    The range uses the 1st-99th percentile, so one small very hot object
    (a mug, a lamp) saturates instead of turning everything else black.
    Displayed numbers always come from the raw data, not this scale.
    """
    lo, hi = (float(v) for v in np.percentile(t, (1, 99)))
    if hi - lo < min_span:
        mid = (hi + lo) / 2
        lo, hi = mid - min_span / 2, mid + min_span / 2
    norm = np.clip((t - lo) / (hi - lo) * 255, 0, 255).astype(np.uint8)
    return norm, lo, hi


def colorize_thermal(t: np.ndarray, size: tuple[int, int], min_span: float = 6.0) -> np.ndarray:
    """°C array -> BGR heat map of ``size`` (w, h), bicubic-upscaled, inferno palette."""
    norm, _, _ = normalize_thermal(t, min_span)
    big = cv2.resize(norm, size, interpolation=cv2.INTER_CUBIC)
    return cv2.applyColorMap(big, cv2.COLORMAP_INFERNO)


def annotate_thermal(img: np.ndarray, stats: dict) -> np.ndarray:
    """Crosshair on the hotspot + min/max/centre labels."""
    h, w = img.shape[:2]
    x, y = int(stats["hot_x"] * w), int(stats["hot_y"] * h)
    cv2.drawMarker(img, (x, y), (255, 255, 255), cv2.MARKER_CROSS, 18, 2)
    cv2.putText(img, f"{stats['max']:.1f}C", (min(x + 8, w - 70), max(y - 8, 16)),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
    cv2.drawMarker(img, (w // 2, h // 2), (200, 200, 200), cv2.MARKER_TILTED_CROSS, 10, 1)
    label = f"min {stats['min']:.1f}  ctr {stats['center']:.1f}  max {stats['max']:.1f} C"
    cv2.putText(img, label, (6, h - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1, cv2.LINE_AA)
    return img


def fuse(frame: np.ndarray, t: np.ndarray, cfg: dict) -> np.ndarray:
    """Overlay the thermal image on the camera view.

    The two sensors sit apart and have different fields of view, so the
    overlay is placed by ``fusion_scale`` / ``fusion_offset_*`` (calibrate by
    looking at a hot object at ~2 m and nudging until they line up). Camera
    edges are kept on top so the scene stays readable.
    """
    h, w = frame.shape[:2]
    tw, th = int(w * cfg["fusion_scale"]), int(h * cfg["fusion_scale"])
    norm, _, _ = normalize_thermal(t, cfg["min_span_c"])
    norm = cv2.resize(norm, (tw, th), interpolation=cv2.INTER_CUBIC)
    heat = cv2.applyColorMap(norm, cv2.COLORMAP_INFERNO)
    # Per-pixel opacity grows with temperature: cold areas show the camera,
    # warm areas glow. Bottom ~20 % of the range stays fully transparent.
    alpha = np.clip(norm.astype(np.float32) / 255 * 1.25 - 0.25, 0, 1) * cfg["fusion_alpha"]
    x0 = int((w - tw) / 2 + cfg["fusion_offset_x"] * w)
    y0 = int((h - th) / 2 + cfg["fusion_offset_y"] * h)
    # Clip the overlay rectangle to the frame.
    fx0, fy0, fx1, fy1 = max(x0, 0), max(y0, 0), min(x0 + tw, w), min(y0 + th, h)
    gray = cv2.cvtColor(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), cv2.COLOR_GRAY2BGR)
    out = gray.copy()
    if fx1 > fx0 and fy1 > fy0:
        sl = (slice(fy0 - y0, fy1 - y0), slice(fx0 - x0, fx1 - x0))
        a = alpha[sl][..., None]
        base = gray[fy0:fy1, fx0:fx1].astype(np.float32)
        out[fy0:fy1, fx0:fx1] = (base * (1 - a) + heat[sl].astype(np.float32) * a).astype(np.uint8)
    edges = cv2.Canny(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), 60, 140)
    out[edges > 0] = (255, 255, 255)
    return out


def software_zoom(frame: np.ndarray, zoom: float) -> np.ndarray:
    """Centre crop + resize, with light sharpening to offset upscaling blur."""
    if zoom <= 1.01:
        return frame
    h, w = frame.shape[:2]
    cw, ch = int(w / zoom), int(h / zoom)
    x0, y0 = (w - cw) // 2, (h - ch) // 2
    crop = cv2.resize(frame[y0:y0 + ch, x0:x0 + cw], (w, h), interpolation=cv2.INTER_LINEAR)
    blur = cv2.GaussianBlur(crop, (0, 0), 1.5)
    return cv2.addWeighted(crop, 1.5, blur, -0.5, 0)


def draw_detections(frame: np.ndarray, dets: list[dict]) -> np.ndarray:
    h, w = frame.shape[:2]
    for d in dets:
        x, y, bw, bh = d["box"]
        p1 = (int(x * w), int(y * h))
        p2 = (int((x + bw) * w), int((y + bh) * h))
        cv2.rectangle(frame, p1, p2, (0, 255, 255), 2)
        cv2.putText(frame, f"{d['label']} {d['score']:.0%}", (p1[0] + 3, max(p1[1] - 6, 14)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1, cv2.LINE_AA)
    return frame
