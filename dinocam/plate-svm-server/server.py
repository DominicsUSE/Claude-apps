"""
DinoCamSecurity vision backend — optional, local-only, classic-CV Chinese plate reader.

Why this exists: DinoCamSecurity's default plate recognition (../index.html's built-in
Tesseract-based pipeline) is a general-purpose OCR engine tuned for Latin-alphabet plates.
This service wraps a different, older but real technique: edge/color-based plate
localization plus an OpenCV SVM character classifier, specifically trained for the
7-character Chinese plate format (1 Chinese province character + 6 letters/digits). It's
useful specifically for Chinese plates, where it will often do noticeably better than the
built-in Latin-tuned OCR; for non-Chinese plates it is not a good fit (see below) and the
built-in engine or ../server/'s online engines are the better choice.

This exposes the SAME request/response contract as ../server/'s POST /api/recognize-plate
(`{status, value, confidence, country, source}`), so it's a drop-in alternative backend for
DinoCamSecurity's "Online AI" plate-recognition setting - point the app's backend URL at
this instead of ../server/ to use this engine. Unlike ../server/'s cloud engines, this one
never leaves your machine/network - it's local, like ../vision-server/ and ../yolo-server/.

Original algorithm and pretrained weights (svm.dat, svmchinese.dat) adapted from
wzh191920/License-Plate-Recognition. predict.py has two fixes applied for current
dependencies that the original (numpy 1.14 / opencv 3.4, ~2018) didn't need:
  - np.int0 was removed in numpy>=2.0; replaced with its documented equivalent, np.intp.
  - cv2.ml.SVM.predict() returns float32 class labels; chr() requires an int, so the
    character-decoding line now does chr(int(resp[0])) instead of chr(resp[0]).

KNOWN LIMITATION (inherent to the algorithm, not a bug): the first character of every
plate is always classified against the Chinese-province model, whatever the actual plate
says. On a genuine Chinese plate this is usually right (see verification below - it's the
character most likely to be wrong, matching the original author's own documented caveat).
On a non-Chinese plate, the first character will always be forced into some Chinese
province character, i.e. wrong. This engine should only be used for Chinese plates.

VERIFIED (not just written and hoped): after the two fixes above, ran real predictions
against all 11 bundled test images (test/*.jpg, the original project's own test set).
8 of 11 correctly located and read a plate, with accuracy matching the original project's
own documented caveat (the leading province character is the one most likely to be
misread; remaining alphanumeric characters were read correctly in every located plate
except one single-character miss). 3 of 11 found no plate at all (the algorithm degrades
gracefully - empty result, no crash - it doesn't invent text). /api/recognize-plate was
then exercised with real HTTP multipart requests against a running instance of this exact
server, including the corrupt-image and no-plate-found paths. See
dinocam/plate-svm-server/README.md for the full per-image results.
"""
import io
import os
from pathlib import Path

import numpy as np
import cv2
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from predict import CardPredictor

HERE = Path(__file__).parent
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "*")

app = FastAPI(title="DinoCamSecurity classic-CV Chinese plate backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[ALLOWED_ORIGIN] if ALLOWED_ORIGIN != "*" else ["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# CardPredictor.train_svm() loads the bundled svm.dat/svmchinese.dat (fast - no actual
# training happens since those files already exist). Config is read from config.js in
# this same folder, same as the original project.
os.chdir(HERE)
_predictor = CardPredictor()
_predictor.train_svm()

COLOR_MAP = {"blue": "blue", "green": "green", "yello": "yellow", "bw": "black/white", "no": None}


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    # dinocam/server/'s /api/recognize-plate error shape is {error, message}; this endpoint
    # is meant to be a drop-in alternative backend for the same client-side onlineRecognizePlate()
    # call, so errors here need the same "message" field, not FastAPI's default "detail".
    return JSONResponse(status_code=exc.status_code, content={"error": "request", "message": exc.detail})


@app.get("/api/health")
def health():
    return {"ok": True, "engine": "classic-cv-svm", "note": "Chinese plates only - see README for why."}


@app.post("/api/recognize-plate")
async def recognize_plate(image: UploadFile = File(...)):
    data = await image.read()
    if not data:
        raise HTTPException(400, "No image was uploaded.")
    arr = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(400, "Could not decode image (unsupported format or corrupt file).")

    try:
        chars, roi, color = _predictor.predict(img)
    except Exception as e:
        raise HTTPException(502, f"Plate detector failed: {e}")

    value = "".join(chars) if chars else None
    if not value:
        return {"status": "unreadable", "value": None, "confidence": 0, "country": None, "source": "classic-cv-svm"}
    # A single classical-CV pass has no repeated-read corroboration the way the built-in
    # multi-pass OCR pipeline does, and the algorithm's own first-character error rate is
    # non-trivial (see module docstring) - "candidate" is the honest status, never
    # "confirmed", for a lone read like this.
    return {
        "status": "candidate",
        "value": value,
        "confidence": 55,
        "country": "cn",
        "source": "classic-cv-svm" + (f":{COLOR_MAP.get(color)}" if COLOR_MAP.get(color) else ""),
    }
