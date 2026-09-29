"""
DinoCamSecurity vision backend — all-in-one.

Combines everything the other optional backends (../server/, ../vision-server/,
../yolo-server/, ../plate-svm-server/) provide into ONE process on ONE port, so you don't
have to run four separate servers with four separate venvs and four separate ports to use
DinoCamSecurity's optional enhanced-recognition features. Run this instead of any of them
(or alongside them — the other four still work standalone if you'd rather run just one
piece). Everything except the two optional cloud plate engines is local-only.

Endpoints (same request/response contracts as the standalone servers — the app's existing
client code talks to this with zero changes):
  GET    /api/health              - combined status of every subsystem below
  POST   /api/recognize-plate     - plate OCR (see PLATE_ENGINE below)
  POST   /api/faces/detect        - face detection, no identity        (from vision-server)
  POST   /api/faces/enroll        - enroll a named face                (from vision-server)
  POST   /api/faces/identify      - match faces against enrolled names (from vision-server)
  GET    /api/faces/list          - enrolled names                     (from vision-server)
  DELETE /api/faces/{name}        - remove an enrolled identity        (from vision-server)
  POST   /api/detect              - general object detection (YOLO)    (from yolo-server)

Point DinoCamSecurity's three separate backend-URL settings (Online backend URL, Face
backend URL, YOLO backend URL) at the SAME url/port for this server — e.g.
http://localhost:8800 in all three fields. The paths above don't collide, so one URL
correctly serves all of them.

PLATE_ENGINE selects the plate-recognition engine (env var, default "classic-cv-svm"):
  - "classic-cv-svm" (default): local, no API key, Chinese plates only. Ported unchanged
    from ../plate-svm-server/ — see that folder's README for what "Chinese plates only"
    means and why.
  - "claude-vision": cloud, needs your own ANTHROPIC_API_KEY. General-purpose vision model
    reading the plate directly — ported from ../server/'s Node implementation.
  - "plate-recognizer": cloud, needs your own PLATE_RECOGNIZER_API_KEY. Dedicated ANPR
    product (platerecognizer.com) — ported from ../server/'s Node implementation.
Face and object detection have no engine choice; they're always the local uniface / YOLO
implementations from ../vision-server/ and ../yolo-server/.

VERIFIED (not just written and hoped): every endpoint above was exercised with real HTTP
multipart requests against a running instance of this exact combined server — the same
concrete checks already run individually against each standalone server (real face
enroll/identify against real photos, real YOLO detection against a real video frame, real
SVM plate reads against the original project's own test images), re-run here to confirm
nothing broke when everything shares one process and one dependency set. See
dinocam/all-in-one-server/README.md for the exact results and what's still unverified
(the two cloud plate engines still only have their auth-rejection path verified against
the real APIs — no key was available to verify an actual successful cloud read, same
caveat ../server/'s own README already states).
"""
import io
import os
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from PIL import Image
from pydantic import BaseModel
from ultralytics import YOLO
from uniface import FaceAnalyzer, compute_similarity

HERE = Path(__file__).parent
os.chdir(HERE)  # predict.py's CardPredictor opens config.js by relative path

from predict import CardPredictor  # noqa: E402 (must follow the chdir above)

ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "*")

app = FastAPI(title="DinoCamSecurity all-in-one vision backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[ALLOWED_ORIGIN] if ALLOWED_ORIGIN != "*" else ["*"],
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    # {error, message} matches ../server/'s and ../plate-svm-server/'s shape, so the app's
    # existing onlineRecognizePlate() client code (which reads data.message) works unchanged.
    return JSONResponse(status_code=exc.status_code, content={"error": "request", "message": exc.detail})


# ============================================================================
# Face recognition (ported unchanged from ../vision-server/server.py)
# ============================================================================
DB_PATH = HERE / "faces_db.json"
MATCH_THRESHOLD = float(os.environ.get("FACE_MATCH_THRESHOLD", "0.30"))
MAX_FACES_PER_IMAGE = 20

_analyzer: Optional[FaceAnalyzer] = None


def analyzer() -> FaceAnalyzer:
    global _analyzer
    if _analyzer is None:
        _analyzer = FaceAnalyzer()
    return _analyzer


def load_face_db() -> dict:
    import json
    if not DB_PATH.exists():
        return {}
    try:
        return json.loads(DB_PATH.read_text())
    except (json.JSONDecodeError, OSError):
        return {}


def save_face_db(db: dict):
    import json
    DB_PATH.write_text(json.dumps(db))


async def read_image_cv(file: UploadFile) -> np.ndarray:
    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty image upload.")
    arr = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(400, "Could not decode image (unsupported format or corrupt file).")
    return img


def largest_face(faces):
    if not faces:
        return None
    return max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))


@app.post("/api/faces/detect")
async def faces_detect(image: UploadFile = File(...)):
    img = await read_image_cv(image)
    try:
        faces = analyzer().analyze(img)
    except Exception as e:
        raise HTTPException(502, f"Face detector failed: {e}")
    faces = faces[:MAX_FACES_PER_IMAGE]
    return {"faces": [{"bbox": [float(x) for x in f.bbox], "confidence": float(f.confidence)} for f in faces]}


@app.post("/api/faces/enroll")
async def faces_enroll(image: UploadFile = File(...), name: str = Form(...)):
    name = name.strip()
    if not name:
        raise HTTPException(400, "name is required.")
    img = await read_image_cv(image)
    try:
        faces = analyzer().analyze(img)
    except Exception as e:
        raise HTTPException(502, f"Face detector failed: {e}")
    face = largest_face(faces)
    if face is None:
        raise HTTPException(422, "No face found in the image — enrollment needs one clear, front-facing face.")
    if len(faces) > 1:
        raise HTTPException(422, f"{len(faces)} faces found — enroll with a photo containing only this one person.")
    db = load_face_db()
    db.setdefault(name, []).append(face.embedding.tolist())
    save_face_db(db)
    return {"ok": True, "name": name, "photos_enrolled": len(db[name])}


@app.post("/api/faces/identify")
async def faces_identify(image: UploadFile = File(...)):
    img = await read_image_cv(image)
    try:
        faces = analyzer().analyze(img)
    except Exception as e:
        raise HTTPException(502, f"Face detector failed: {e}")
    faces = faces[:MAX_FACES_PER_IMAGE]
    db = load_face_db()
    results = []
    for f in faces:
        best_name, best_score = None, -1.0
        for name, embeddings in db.items():
            for emb in embeddings:
                score = float(compute_similarity(f.embedding, np.array(emb, dtype=np.float32)))
                if score > best_score:
                    best_name, best_score = name, score
        matched = best_score >= MATCH_THRESHOLD
        results.append({
            "bbox": [float(x) for x in f.bbox],
            "name": best_name if matched else None,
            "confidence": round(max(0.0, best_score) * 100, 1),
            "status": "confirmed" if matched and best_score >= MATCH_THRESHOLD + 0.15 else ("candidate" if matched else "unknown"),
        })
    return {"faces": results}


@app.get("/api/faces/list")
def faces_list():
    db = load_face_db()
    return {"people": [{"name": name, "photos": len(embeddings)} for name, embeddings in db.items()]}


@app.delete("/api/faces/{name}")
def faces_delete(name: str):
    db = load_face_db()
    if name not in db:
        raise HTTPException(404, f'"{name}" is not enrolled.')
    del db[name]
    save_face_db(db)
    return {"ok": True, "removed": name}


# ============================================================================
# Object detection (ported unchanged from ../yolo-server/server.py)
# ============================================================================
YOLO_MODEL_PATH = os.environ.get("YOLO_MODEL_PATH", str(HERE / "models" / "yolo26s.pt"))
YOLO_MIN_CONFIDENCE = float(os.environ.get("YOLO_MIN_CONFIDENCE", "0.35"))
MAX_DETECTIONS = 30

_yolo: Optional[YOLO] = None


def yolo_model() -> YOLO:
    global _yolo
    if _yolo is None:
        if not Path(YOLO_MODEL_PATH).exists():
            raise HTTPException(500, f"YOLO model weights not found at {YOLO_MODEL_PATH}.")
        _yolo = YOLO(YOLO_MODEL_PATH)
    return _yolo


@app.post("/api/detect")
async def detect(image: UploadFile = File(...), min_confidence: float = Form(YOLO_MIN_CONFIDENCE)):
    data = await image.read()
    if not data:
        raise HTTPException(400, "Empty image upload.")
    try:
        img = Image.open(io.BytesIO(data)).convert("RGB")
    except Exception as e:
        raise HTTPException(400, f"Could not decode image (unsupported format or corrupt file): {e}")
    try:
        result = yolo_model().predict(img, conf=min_confidence, verbose=False)[0]
    except Exception as e:
        raise HTTPException(502, f"Detector failed: {e}")
    names = yolo_model().names
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


# ============================================================================
# Plate recognition — local classic-CV/SVM (default) or optional cloud engines
# ============================================================================
PLATE_ENGINE = os.environ.get("PLATE_ENGINE", "classic-cv-svm").strip()
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
CLAUDE_MODEL = os.environ.get("CLAUDE_VISION_MODEL", "claude-opus-5-5")
PLATE_RECOGNIZER_API_KEY = os.environ.get("PLATE_RECOGNIZER_API_KEY", "")
PLATE_RECOGNIZER_URL = "https://api.platerecognizer.com/v1/plate-reader/"

_svm_predictor: Optional[CardPredictor] = None
COLOR_MAP = {"blue": "blue", "green": "green", "yello": "yellow", "bw": "black/white", "no": None}


def svm_predictor() -> CardPredictor:
    global _svm_predictor
    if _svm_predictor is None:
        _svm_predictor = CardPredictor()
        _svm_predictor.train_svm()
    return _svm_predictor


def plate_engine_configured() -> bool:
    if PLATE_ENGINE == "classic-cv-svm":
        return True
    if PLATE_ENGINE == "claude-vision":
        return bool(ANTHROPIC_API_KEY)
    if PLATE_ENGINE == "plate-recognizer":
        return bool(PLATE_RECOGNIZER_API_KEY)
    return False


async def recognize_plate_classic_cv_svm(data: bytes) -> dict:
    arr = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(400, "Could not decode image (unsupported format or corrupt file).")
    try:
        chars, roi, color = svm_predictor().predict(img)
    except Exception as e:
        raise HTTPException(502, f"Plate detector failed: {e}")
    value = "".join(chars) if chars else None
    if not value:
        return {"status": "unreadable", "value": None, "confidence": 0, "country": None, "source": "classic-cv-svm"}
    return {
        "status": "candidate",
        "value": value,
        "confidence": 55,
        "country": "cn",
        "source": "classic-cv-svm" + (f":{COLOR_MAP.get(color)}" if COLOR_MAP.get(color) else ""),
    }


class PlateRead(BaseModel):
    plate_visible: bool
    full_plate_text: Optional[str] = None
    confidence: float
    country_or_region_guess: Optional[str] = None


async def recognize_plate_claude_vision(data: bytes, mimetype: str) -> dict:
    import base64
    import anthropic

    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    media_type = mimetype if mimetype in ("image/jpeg", "image/png", "image/webp", "image/gif") else "image/jpeg"

    try:
        response = client.messages.parse(
            model=CLAUDE_MODEL,
            max_tokens=1024,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": base64.standard_b64encode(data).decode("utf-8")}},
                    {"type": "text", "text": (
                        "Read the vehicle license/number plate in this image. This may be any country's format: "
                        "one line or two, any number of character groups, any length, letters-only or digits-only "
                        "groups included. Report the COMPLETE plate as printed — every group, in order, separated "
                        "by single spaces — never just the first group or the group that happens to contain a "
                        "digit. If the plate is genuinely not legible (too blurry, too small, out of frame, or no "
                        "plate visible at all), set plate_visible/full_plate_text accordingly rather than "
                        "guessing. Do not invent characters you cannot actually see."
                    )},
                ],
            }],
            output_format=PlateRead,
        )
    except anthropic.AuthenticationError:
        raise HTTPException(401, "Anthropic rejected the API key (check ANTHROPIC_API_KEY).")
    except anthropic.RateLimitError:
        raise HTTPException(429, "Anthropic rate limit reached — try again shortly.")
    except anthropic.APIConnectionError as e:
        raise HTTPException(502, f"Could not reach the Anthropic API: {e}")
    except anthropic.APIStatusError as e:
        raise HTTPException(502, f"Anthropic API error ({e.status_code}): {e.message}")

    parsed = response.parsed_output
    if not parsed or not parsed.plate_visible or not parsed.full_plate_text:
        return {"status": "unreadable", "value": None, "confidence": 0, "country": None, "source": "claude-vision"}
    import re
    value = re.sub(r"\s+", " ", re.sub(r"[^A-Z0-9 ]", "", parsed.full_plate_text.upper())).strip()
    confidence = round(parsed.confidence)
    status = "confirmed" if confidence >= 85 else "candidate" if confidence >= 40 else "unreadable"
    return {
        "status": status if value else "unreadable",
        "value": value or None,
        "confidence": confidence,
        "country": parsed.country_or_region_guess,
        "source": "claude-vision",
    }


async def recognize_plate_plate_recognizer(data: bytes) -> dict:
    import requests
    try:
        upstream = requests.post(
            PLATE_RECOGNIZER_URL,
            headers={"Authorization": f"Token {PLATE_RECOGNIZER_API_KEY}"},
            files={"upload": ("plate.jpg", data)},
            timeout=25,
        )
    except requests.Timeout:
        raise HTTPException(504, "Plate Recognizer did not respond in time.")
    except requests.RequestException as e:
        raise HTTPException(502, f"Could not reach Plate Recognizer: {e}")

    if upstream.status_code in (401, 403):
        raise HTTPException(401, "Plate Recognizer rejected the API key (check PLATE_RECOGNIZER_API_KEY).")
    if upstream.status_code == 429:
        raise HTTPException(429, "Plate Recognizer rate limit reached — try again shortly.")
    if not upstream.ok:
        raise HTTPException(502, f"Plate Recognizer returned {upstream.status_code}. {upstream.text[:300]}")

    try:
        data = upstream.json()
    except ValueError:
        raise HTTPException(502, "Plate Recognizer returned an unreadable response.")

    results = data.get("results") or []
    if not results:
        return {"status": "unreadable", "value": None, "confidence": 0, "country": None, "source": "plate-recognizer"}
    best = sorted(results, key=lambda r: r.get("score", 0), reverse=True)[0]
    value = str(best.get("plate", "")).upper()
    confidence = round((best.get("score") or 0) * 100)
    status = "confirmed" if confidence >= 90 else "candidate" if confidence >= 50 else "unreadable"
    country = str(best["region"]["code"]).upper() if best.get("region", {}).get("code") else None
    return {"status": status if value else "unreadable", "value": value or None, "confidence": confidence, "country": country, "source": "plate-recognizer"}


@app.post("/api/recognize-plate")
async def recognize_plate(image: UploadFile = File(...)):
    if PLATE_ENGINE not in ("classic-cv-svm", "claude-vision", "plate-recognizer"):
        raise HTTPException(500, f'Unknown PLATE_ENGINE "{PLATE_ENGINE}" — set it to "classic-cv-svm", "claude-vision", or "plate-recognizer".')
    if not plate_engine_configured():
        missing = "ANTHROPIC_API_KEY" if PLATE_ENGINE == "claude-vision" else "PLATE_RECOGNIZER_API_KEY"
        raise HTTPException(500, f"{missing} is not set on this server (PLATE_ENGINE={PLATE_ENGINE}).")
    data = await image.read()
    if not data:
        raise HTTPException(400, "No image was uploaded.")
    if PLATE_ENGINE == "classic-cv-svm":
        return await recognize_plate_classic_cv_svm(data)
    if PLATE_ENGINE == "claude-vision":
        return await recognize_plate_claude_vision(data, image.content_type or "image/jpeg")
    return await recognize_plate_plate_recognizer(data)


# ============================================================================
# Combined health check
# ============================================================================
@app.get("/api/health")
def health():
    return {
        "ok": True,
        "plate_engine": PLATE_ENGINE,
        "plate_engine_configured": plate_engine_configured(),
        "face_analyzer_loaded": _analyzer is not None,
        "face_enrolled_count": len(load_face_db()),
        "face_match_threshold": MATCH_THRESHOLD,
        "yolo_loaded": _yolo is not None,
    }
