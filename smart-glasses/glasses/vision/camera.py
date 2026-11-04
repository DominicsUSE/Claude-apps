"""Camera capture: Pi camera (picamera2), Pi AI Camera (IMX500), USB webcam, sim.

Publishes ``frame`` (BGR uint8). Reads ``mode`` and ``zoom`` from the hub and
applies them: on Pi cameras zoom uses the sensor's ScalerCrop, which crops
the full-resolution sensor before scaling - sharper than enlarging the
640x480 output. Also drives the IR illuminator and the privacy LED.
"""

from __future__ import annotations

import logging
import time

import numpy as np

from glasses.hub import Worker, require
from glasses.vision.detect import COCO

log = logging.getLogger(__name__)


def scaler_crop(full: tuple[int, int, int, int], zoom: float) -> tuple[int, int, int, int]:
    """Centred sensor crop rectangle (x, y, w, h) for a zoom factor."""
    x, y, w, h = full
    cw, ch = int(w / zoom), int(h / zoom)
    return (x + (w - cw) // 2, y + (h - ch) // 2, cw, ch)


def sim_frame(t: float, w: int, h: int) -> np.ndarray:
    """A dim synthetic room: floor, wall, door, a walking figure, a mug."""
    import cv2
    img = np.zeros((h, w, 3), np.uint8)
    img[: h // 2] = (70, 60, 55)
    img[h // 2:] = (40, 45, 50)
    cv2.rectangle(img, (int(w * 0.68), int(h * 0.15)), (int(w * 0.85), int(h * 0.75)), (35, 55, 85), -1)
    px = int(w * (0.5 + 0.3 * np.sin(t * 0.4)))
    cv2.ellipse(img, (px, int(h * 0.45)), (int(w * 0.05), int(h * 0.22)), 0, 0, 360, (90, 100, 140), -1)
    cv2.circle(img, (px, int(h * 0.2)), int(h * 0.05), (120, 140, 180), -1)
    cv2.rectangle(img, (int(w * 0.17), int(h * 0.7)), (int(w * 0.23), int(h * 0.8)), (200, 200, 210), -1)
    noise = np.random.normal(0, 8, img.shape).astype(np.int16)
    return np.clip((img * 0.6).astype(np.int16) + noise, 0, 255).astype(np.uint8)


class CameraWorker(Worker):
    def setup(self) -> None:
        d = self.driver
        w, h, fps = int(self.cfg["width"]), int(self.cfg["height"]), int(self.cfg["fps"])
        self.size = (w, h)
        self.applied = {"zoom": 1.0, "lowlight": False}
        self.full_crop = None
        self.imx500 = None
        if d in ("picamera2", "imx500"):
            picam = require("picamera2", "sudo apt install python3-picamera2")
            if d == "imx500":
                from picamera2.devices import IMX500
                self.imx500 = IMX500(self.cfg["imx500_model"])  # must exist before Picamera2
                self.intr = self.imx500.network_intrinsics
                self.cam = picam.Picamera2(self.imx500.camera_num)
                cfg = self.cam.create_preview_configuration(
                    main={"size": (w, h), "format": "RGB888"},
                    controls={"FrameRate": self.intr.inference_rate if self.intr else fps},
                    buffer_count=12)
            else:
                self.cam = picam.Picamera2()
                # "RGB888" is BGR byte order in memory: exactly what OpenCV wants.
                cfg = self.cam.create_video_configuration(
                    main={"size": (w, h), "format": "RGB888"},
                    controls={"FrameRate": fps})
            self.cam.configure(cfg)
            self.cam.start()
            self.full_crop = self.cam.camera_properties["ScalerCropMaximum"]
            self.interval = 0  # capture blocks until the next frame
        elif d == "opencv":
            import cv2
            dev = self.cfg["device"]
            self.cam = cv2.VideoCapture(dev if isinstance(dev, str) else int(dev))
            self.cam.set(cv2.CAP_PROP_FRAME_WIDTH, w)
            self.cam.set(cv2.CAP_PROP_FRAME_HEIGHT, h)
            if not self.cam.isOpened():
                raise RuntimeError(f"no camera at {dev}")
            self.interval = 0
        elif d == "sim":
            self.t0 = time.monotonic()
            self.interval = 1.0 / fps
        else:
            raise ValueError(f"unknown camera driver {d!r}")
        self.ir_led = self._led(int(self.cfg["ir_led_pin"]))
        self.privacy_led = self._led(int(self.cfg["privacy_led_pin"]))
        if self.privacy_led:
            self.privacy_led.on()
        self.hub.put("hw_zoom", self.full_crop is not None)

    def _led(self, pin: int):
        if pin < 0 or self.driver == "sim":
            return None
        try:
            from gpiozero import OutputDevice
            return OutputDevice(pin)
        except Exception as e:  # noqa: BLE001 - an LED must never stop the camera
            log.warning("GPIO %d unavailable: %s", pin, e)
            return None

    def _apply_controls(self) -> None:
        mode = self.hub.get("mode", "normal")
        zoom = float(self.hub.get("zoom", 1.0))
        ir_on = mode == "night" or bool(self.hub.get("ir_override"))
        if self.ir_led:
            self.ir_led.value = ir_on
        self.hub.put("ir_on", ir_on)
        if self.full_crop is None:
            return  # sim/webcam: the view pipeline zooms in software
        if zoom != self.applied["zoom"]:
            self.cam.set_controls({"ScalerCrop": scaler_crop(self.full_crop, zoom)})
            self.applied["zoom"] = zoom
        lowlight = mode in ("lowlight", "night")
        if lowlight != self.applied["lowlight"]:
            # Allow exposures up to 1/8 s in the dark: lower frame rate, much less noise.
            longest = 125_000 if lowlight else int(1e6 / int(self.cfg["fps"]))
            self.cam.set_controls({"FrameDurationLimits": (int(1e6 / int(self.cfg["fps"])), longest)})
            self.applied["lowlight"] = lowlight

    def _imx500_detections(self, metadata) -> list[dict]:
        """Follows picamera2's examples/imx500/imx500_object_detection_demo.py."""
        outs = self.imx500.get_outputs(metadata, add_batch=True)
        if outs is None:
            return self.hub.get("detections", [])
        boxes, scores, classes = outs[0][0], outs[1][0], outs[2][0]
        if self.intr and self.intr.bbox_normalization:
            boxes = boxes / self.imx500.get_input_size()[1]
        if self.intr and self.intr.bbox_order == "xy":
            boxes = boxes[:, [1, 0, 3, 2]]
        labels = (self.intr.labels if self.intr and self.intr.labels else None)
        dets, (w, h) = [], self.size
        for box, score, cls in zip(boxes, scores, classes):
            if score < 0.5:
                continue
            x, y, bw, bh = self.imx500.convert_inference_coords(box, metadata, self.cam)
            name = labels[int(cls)] if labels else COCO[int(cls) + 1]
            dets.append({"label": name, "score": round(float(score), 2),
                         "box": (x / w, y / h, bw / w, bh / h)})
        return dets

    def step(self) -> None:
        self._apply_controls()
        if self.driver == "sim":
            frame = sim_frame(time.monotonic() - self.t0, *self.size)
        elif self.driver == "opencv":
            ok, frame = self.cam.read()
            if not ok:
                raise RuntimeError("webcam stopped delivering frames")
        elif self.imx500 is not None:
            req = self.cam.capture_request()
            try:
                frame = req.make_array("main")
                self.hub.put("detections", self._imx500_detections(req.get_metadata()))
            finally:
                req.release()
        else:
            frame = self.cam.capture_array("main")
        self.hub.put("frame", frame)

    def close(self) -> None:
        for led in (getattr(self, "ir_led", None), getattr(self, "privacy_led", None)):
            if led:
                led.off()
                led.close()
        cam = getattr(self, "cam", None)
        if cam is None:
            return
        if self.driver == "opencv":
            cam.release()
        elif self.driver in ("picamera2", "imx500"):
            cam.stop()
            cam.close()
