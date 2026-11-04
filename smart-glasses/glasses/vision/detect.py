"""Object detection.

- ``opencv``: SSD-MobileNet-v2 (COCO, 90 classes) on the CPU via OpenCV DNN.
  Roughly 1-2 detections/s on a Pi Zero 2 W, so by default it only runs when
  you ask ("describe") instead of continuously - this saves battery and heat.
- ``imx500``: the Raspberry Pi AI Camera runs the network on the sensor at
  camera frame rate; the camera worker publishes those detections itself.

Publishes ``detections``: list of {label, score, box: (x, y, w, h) in 0..1}.
"""

from __future__ import annotations

import math
import time

from glasses.config import resolve
from glasses.hub import Worker

# COCO class names indexed by TensorFlow SSD class id (gaps are "N/A").
COCO = [
    "background", "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train",
    "truck", "boat", "traffic light", "fire hydrant", "N/A", "stop sign", "parking meter",
    "bench", "bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra",
    "giraffe", "N/A", "backpack", "umbrella", "N/A", "N/A", "handbag", "tie", "suitcase",
    "frisbee", "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove",
    "skateboard", "surfboard", "tennis racket", "bottle", "N/A", "wine glass", "cup", "fork",
    "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange", "broccoli", "carrot",
    "hot dog", "pizza", "donut", "cake", "chair", "couch", "potted plant", "bed", "N/A",
    "dining table", "N/A", "N/A", "toilet", "N/A", "tv", "laptop", "mouse", "remote",
    "keyboard", "cell phone", "microwave", "oven", "toaster", "sink", "refrigerator", "N/A",
    "book", "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush",
]


def parse_ssd(out, min_score: float) -> list[dict]:
    """OpenCV DNN SSD output [1, 1, N, 7] -> detection dicts."""
    dets = []
    for _, cls, score, x1, y1, x2, y2 in out[0, 0]:
        cls = int(cls)
        if score < min_score or not 0 < cls < len(COCO) or COCO[cls] == "N/A":
            continue
        x1, y1 = max(float(x1), 0.0), max(float(y1), 0.0)
        x2, y2 = min(float(x2), 1.0), min(float(y2), 1.0)
        dets.append({"label": COCO[cls], "score": round(float(score), 2),
                     "box": (x1, y1, x2 - x1, y2 - y1)})
    return sorted(dets, key=lambda d: -d["score"])


class DetectorWorker(Worker):
    interval = 0.2  # how often to check for a pending request

    def setup(self) -> None:
        if self.driver == "opencv":
            import cv2
            model, config = resolve(self.cfg["model"]), resolve(self.cfg["config"])
            if not model.exists():
                raise RuntimeError(f"model missing: {model} - run scripts/download_models.sh")
            self.net = cv2.dnn.readNetFromTensorflow(str(model), str(config))
            self.cv2 = cv2
        elif self.driver != "sim":
            raise ValueError(f"unknown detector driver {self.driver!r}")
        self.last_run = 0.0

    def step(self) -> None:
        requested = self.hub.pop("detect_request")
        period = float(self.cfg["interval"]) * (2 if self.hub.get("throttle") else 1)
        due = self.cfg["mode"] == "continuous" and time.monotonic() - self.last_run > period
        if not (requested or due):
            return
        frame = self.hub.get("frame", max_age=2.0)
        if frame is None:
            return
        self.last_run = time.monotonic()
        if self.driver == "sim":
            t = self.last_run
            dets = [{"label": "person", "score": 0.87,
                     "box": (0.35 + 0.2 * math.sin(t * 0.4), 0.2, 0.25, 0.7)},
                    {"label": "cup", "score": 0.64, "box": (0.12, 0.65, 0.1, 0.12)}]
        else:
            blob = self.cv2.dnn.blobFromImage(frame, size=(300, 300), swapRB=True)
            self.net.setInput(blob)
            dets = parse_ssd(self.net.forward(), float(self.cfg["min_score"]))
        self.hub.put("detections", dets)
