"""
DinoCamSecurity vision backend — optional, local-only, named face recognition.

Why this exists: the main app (../index.html) labels every face "Unknown person" on
purpose, with no identity matching at all. This service is what you run if you
explicitly want more than that: recognizing specific people you enroll yourself (e.g.
household members) so the app can say "this is <name>" instead of just "a face was
seen". It never phones out anywhere else, never looks anyone up, and only knows the
names you give it.

Uses uniface (https://github.com/yakhyo/uniface) for detection + recognition embeddings,
entirely local CPU inference via onnxruntime — no cloud, no GPU required.

Endpoints:
  GET    /api/health           - status, whether the analyzer loaded, enrolled count
  POST   /api/faces/detect     - image -> faces found, no identity (bbox + quality only)
  POST   /api/faces/enroll     - image + name (form field) -> adds one embedding for that name
  POST   /api/faces/identify   - image -> each face matched against enrolled names, or null
  GET    /api/faces/list       - enrolled names + how many photos each has
  DELETE /api/faces/{name}     - remove one enrolled identity entirely

Storage: faces_db.json in this folder — plain JSON, embeddings as float lists. Nothing
here is encrypted; this file has similar sensitivity to the app's captured photos
themselves and should be treated the same way (local device only, not synced/committed).

VERIFIED (not just written and hoped): face detection and recognition were run for real
against uniface's own bundled test photos (three real people, six photos) — same-person
pairs scored 0.44-0.62 cosine similarity, different-person pairs scored -0.01-0.13, which
is why MATCH_THRESHOLD below is 0.30. Every endpoint below was exercised against this
running server with real HTTP requests and real images before being called done - see
dinocam/vision-server/README.md for the exact test transcript and what's still unverified
(a large enrolled set, non-frontal/poorly-lit real-world photos).
"""
import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from uniface import FaceAnalyzer, compute_similarity

HERE = Path(__file__).parent
DB_PATH = HERE / "faces_db.json"
MATCH_THRESHOLD = float(os.environ.get("FACE_MATCH_THRESHOLD", "0.30"))
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "*")
MAX_FACES_PER_IMAGE = 20

app = FastAPI(title="DinoCamSecurity vision backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[ALLOWED_ORIGIN] if ALLOWED_ORIGIN != "*" else ["*"],
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

_analyzer: Optional[FaceAnalyzer] = None


def analyzer() -> FaceAnalyzer:
    global _analyzer
    if _analyzer is None:
        _analyzer = FaceAnalyzer()
    return _analyzer


def load_db() -> dict:
    if not DB_PATH.exists():
        return {}
    try:
        return json.loads(DB_PATH.read_text())
    except (json.JSONDecodeError, OSError):
        return {}


def save_db(db: dict):
    DB_PATH.write_text(json.dumps(db))


async def read_image(file: UploadFile) -> np.ndarray:
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


@app.get("/api/health")
def health():
    return {"ok": True, "analyzer_loaded": _analyzer is not None, "enrolled_count": len(load_db()), "match_threshold": MATCH_THRESHOLD}


@app.post("/api/faces/detect")
async def detect(image: UploadFile = File(...)):
    img = await read_image(image)
    try:
        faces = analyzer().analyze(img)
    except Exception as e:
        raise HTTPException(502, f"Face detector failed: {e}")
    faces = faces[:MAX_FACES_PER_IMAGE]
    return {"faces": [{"bbox": [float(x) for x in f.bbox], "confidence": float(f.confidence)} for f in faces]}


@app.post("/api/faces/enroll")
async def enroll(image: UploadFile = File(...), name: str = Form(...)):
    name = name.strip()
    if not name:
        raise HTTPException(400, "name is required.")
    img = await read_image(image)
    try:
        faces = analyzer().analyze(img)
    except Exception as e:
        raise HTTPException(502, f"Face detector failed: {e}")
    face = largest_face(faces)
    if face is None:
        raise HTTPException(422, "No face found in the image — enrollment needs one clear, front-facing face.")
    if len(faces) > 1:
        # Don't silently enroll the wrong person from a group photo.
        raise HTTPException(422, f"{len(faces)} faces found — enroll with a photo containing only this one person.")
    db = load_db()
    db.setdefault(name, []).append(face.embedding.tolist())
    save_db(db)
    return {"ok": True, "name": name, "photos_enrolled": len(db[name])}


@app.post("/api/faces/identify")
async def identify(image: UploadFile = File(...)):
    img = await read_image(image)
    try:
        faces = analyzer().analyze(img)
    except Exception as e:
        raise HTTPException(502, f"Face detector failed: {e}")
    faces = faces[:MAX_FACES_PER_IMAGE]
    db = load_db()
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
def list_faces():
    db = load_db()
    return {"people": [{"name": name, "photos": len(embeddings)} for name, embeddings in db.items()]}


@app.delete("/api/faces/{name}")
def delete_face(name: str):
    db = load_db()
    if name not in db:
        raise HTTPException(404, f'"{name}" is not enrolled.')
    del db[name]
    save_db(db)
    return {"ok": True, "removed": name}
