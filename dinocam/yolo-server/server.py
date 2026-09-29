"""
DinoCamSecurity vision backend — optional, local-only, enhanced object detection.

Why this exists: the main app (../index.html) already detects vehicles/objects fully
client-side via TensorFlow.js + coco-ssd, with zero server and zero setup — that stays the
default. This service is only useful if you want a second opinion from a stronger detector
(YOLO) for cases coco-ssd's older mobilenet-based model misses or boxes poorly: partially
occluded vehicles, unusual angles, small/distant subjects. Like ../vision-server/, it never
leaves your own machine/network — this is not a cloud service.

Uses Ultralytics YOLO (models/yolo26s.pt, bundled — standard 80-class COCO detector, the
same class vocabulary coco-ssd already uses) for local CPU or GPU inference via PyTorch.

Endpoint:
  GET  /api/health   - status, whether the model loaded, class count
  POST /api/detect   - image (+ optional form field min_confidence, default 0.35) ->
                        detections: [{bbox:[x1,y1,x2,y2], confidence, class_id, class_name}]

VERIFIED (not just written and hoped): loaded the bundled yolo26s.pt weights for real and
ran inference against a real frame extracted from the sample video that shipped alongside
these weights (plugin-detection.zip's data/videos/trackdm1.mp4) — got back real bounding
boxes, real class names, and real confidence scores (person/bicycle/bench, the actual
content of that frame). /api/detect was exercised with a real HTTP multipart request
against a running instance of this exact server before being called done. See
dinocam/yolo-server/README.md for what that test showed and what's still unverified
(accuracy specifically on vehicles/plates in this app's own use case, GPU inference).
"""
import io
import os
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image

from ultralytics import YOLO

HERE = Path(__file__).parent
MODEL_PATH = os.environ.get("YOLO_MODEL_PATH", str(HERE / "models" / "yolo26s.pt"))
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "*")
DEFAULT_MIN_CONFIDENCE = float(os.environ.get("YOLO_MIN_CONFIDENCE", "0.35"))
MAX_DETECTIONS = 30

app = FastAPI(title="DinoCamSecurity YOLO detection backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[ALLOWED_ORIGIN] if ALLOWED_ORIGIN != "*" else ["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

_model: Optional[YOLO] = None


def model() -> YOLO:
    global _model
    if _model is None:
        if not Path(MODEL_PATH).exists():
            raise HTTPException(500, f"Model weights not found at {MODEL_PATH}.")
        _model = YOLO(MODEL_PATH)
    return _model


@app.get("/api/health")
def health():
    return {"ok": True, "model_loaded": _model is not None, "model_path": MODEL_PATH, "class_count": len(model().names)}


@app.post("/api/detect")
async def detect(image: UploadFile = File(...), min_confidence: float = Form(DEFAULT_MIN_CONFIDENCE)):
    data = await image.read()
    if not data:
        raise HTTPException(400, "Empty image upload.")
    try:
        img = Image.open(io.BytesIO(data)).convert("RGB")
    except Exception as e:
        raise HTTPException(400, f"Could not decode image (unsupported format or corrupt file): {e}")

    try:
        result = model().predict(img, conf=min_confidence, verbose=False)[0]
    except Exception as e:
        raise HTTPException(502, f"Detector failed: {e}")

    names = model().names
    detections = []
    for box in result.boxes[:MAX_DETECTIONS]:
        cls_id = int(box.cls[0])
        detections.append({
            "bbox": [round(float(x), 1) for x in box.xyxy[0].tolist()],
            "confidence": round(float(box.conf[0]) * 100, 1),
            "class_id": cls_id,
            "class_name": names.get(cls_id, str(cls_id)),
        })
    return {"detections": detections}
