# DinoCamSecurity — optional enhanced object detection backend (YOLO)

This is **optional**. DinoCamSecurity's main app (`../index.html`) already detects
vehicles and objects on its own, fully client-side via TensorFlow.js + coco-ssd — no
server, no setup, no model download. That stays the default and needs nothing here.

Only set this up if coco-ssd is missing or mis-boxing vehicles you care about (partial
occlusion, unusual angles, small/distant subjects) and you want a second opinion from a
stronger detector. This is a **separate service from `../server/`** (plate OCR) and
`../vision-server/` (named face recognition) — run any combination of the three depending
on which features you want.

Like `../vision-server/`, this runs entirely on your own machine — local PyTorch
inference (CPU by default, GPU if you have one and set it up), nothing ever sent
anywhere else.

## What's in here

`models/yolo26s.pt` — Ultralytics YOLO weights, bundled. Standard 80-class COCO detector
— the same class vocabulary coco-ssd already uses (car, truck, bus, motorcycle, person,
etc.), not a specialized vehicle model. The value here isn't new categories, it's usually
better boxes and better recall than coco-ssd's older mobilenet-based model, especially on
hard frames.

## What was and wasn't verified before this shipped

- The bundled weights were loaded for real and run against a real video frame (extracted
  from the sample clip that shipped alongside these weights) — got back real bounding
  boxes, real class names, and real confidence scores matching that frame's actual
  content (people, a bicycle, a bench — no vehicles, since none were in that frame).
- `/api/detect` was hit with a real HTTP multipart request against a running instance of
  this exact server, including the corrupt-image error path (400) and the default
  `min_confidence` behavior.
- **Not verified: accuracy specifically on this app's use case** — vehicles at driveway/
  gate distance and angle, and whether YOLO's boxes measurably improve downstream plate
  localization versus coco-ssd's. Also not verified: GPU inference (this environment has
  no GPU; CPU inference was what was actually tested, and is what runs unless you set up
  CUDA yourself).

## Setup

1. Python 3.11+ recommended.
2. In this folder:
   ```
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```
   `torch`/`torchvision` are large (~1-2GB). CPU inference works fine with no extra setup.
   If you have an NVIDIA GPU, see the comment at the top of `requirements.txt`.
3. Run it: `uvicorn server:app --host 0.0.0.0 --port 8789`
   Check `http://localhost:8789/api/health` returns `"ok": true`.
4. In DinoCamSecurity's settings, turn on **Enhanced object detection** and point the
   backend URL field at wherever this is running.

Meant to run on a device you control (your own computer, home server, or NAS) — not a
public host.

## Endpoint

`POST /api/detect` — multipart field `image`, optional form field `min_confidence`
(0-1, default 0.35). Returns:

```json
{ "detections": [{ "bbox": [611.5, 352.2, 1237.3, 1248.9], "confidence": 88.3, "class_id": 2, "class_name": "car" }] }
```

`bbox` is `[x1, y1, x2, y2]` in the input image's own pixel coordinates.
