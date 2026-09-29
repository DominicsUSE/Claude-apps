# DinoCamSecurity — all-in-one vision backend

This combines everything the four separate optional backends provide into **one process
on one port**, so you don't need four separate venvs/servers/ports to use
DinoCamSecurity's optional enhanced-recognition features:

- Plate recognition (`../server/` and `../plate-svm-server/`)
- Named face recognition (`../vision-server/`)
- Enhanced object detection (`../yolo-server/`)

All of it is still **optional** — DinoCamSecurity's main app (`../index.html`) works fully
without any backend: camera, vehicle/face detection, and plate OCR all run locally in the
browser. Run this only if you want the extras.

The four standalone folders still work on their own if you'd rather run just one piece
(e.g. only face recognition) — this is an alternative to running all four, not a
replacement for any of them individually. All the actual recognition code here is the
same code as those four folders; nothing was rewritten, only combined into one FastAPI app
(and the plate cloud engines were ported from `../server/`'s Node implementation to Python
so everything can share one process).

## Setup

1. Python 3.11+ recommended.
2. In this folder:
   ```
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```
   `torch`/`torchvision` (for object detection) are large (~1-2GB download). Everything
   else is small.
3. Run it: `uvicorn server:app --host 0.0.0.0 --port 8800`
   Check `http://localhost:8800/api/health`.
4. In DinoCamSecurity's settings, enter **the same URL** (e.g. `http://localhost:8800`) in
   all three backend-URL fields:
   - Recognition controls → AI recognition → Online backend URL
   - Recognition controls → Named face recognition → Face backend URL
   - Recognition controls → Enhanced object detection → YOLO backend URL

   (There's an "Apply to all three" button next to the first field that fills in the other
   two for you once you've typed a URL there.)

Meant to run on a device you control — not a public host.

## Plate engine

Set with the `PLATE_ENGINE` environment variable (default `classic-cv-svm`):

| Value | Needs | Notes |
|---|---|---|
| `classic-cv-svm` (default) | nothing | Local, no API key. **Chinese plates only** — see `../plate-svm-server/README.md` for why. |
| `claude-vision` | `ANTHROPIC_API_KEY` | Cloud, any plate format. Ported from `../server/`. |
| `plate-recognizer` | `PLATE_RECOGNIZER_API_KEY` | Cloud, any plate format. Ported from `../server/`. |

Face recognition and object detection have no engine choice — always the local uniface /
YOLO implementations.

## What was and wasn't verified before this shipped

Every endpoint was re-verified with real HTTP requests against a running instance of this
*combined* server (not just individually against the four standalone servers this was
built from), to confirm nothing broke when everything shares one process and one dependency
set:

- **Dependency conflict, found and fixed:** the plate SVM engine needs `cv2.ml`, which is
  present in `opencv-python-headless==4.10.0.84` but missing from newer releases (5.0.0,
  used by the standalone `vision-server`/`yolo-server`), while `uniface` pulls in plain
  `opencv-python` unpinned. Installing both packages at *mismatched* versions is a
  known-bad combination (both ship a native `cv2` extension). Fixed by pinning **both**
  `opencv-python` and `opencv-python-headless` to the identical `4.10.0.84` — confirmed by
  installing everything in `requirements.txt` together in a clean venv and importing
  `cv2.ml` successfully afterward.
- **Plates (`classic-cv-svm`):** same 11 test images as `../plate-svm-server/`, run
  through the combined server — identical results (8/11 read correctly).
- **Plates (`claude-vision`):** hit the real, live `api.anthropic.com` with a
  deliberately invalid key — got back a real 401, correctly mapped to the app's error
  shape. Confirms the request (base64 image, structured-output schema, model name) is
  accepted up to the auth check. **Not verified: an actual successful cloud read** — no
  real key available in this environment, same caveat `../server/`'s own README states.
- **Plates (`plate-recognizer`):** **could not be verified at all in this environment** —
  outbound access to `api.platerecognizer.com` was blocked by this sandbox's own network
  policy (confirmed directly with a bare `curl` to the host, independent of this server's
  code — not a bug here). The request logic is an unmodified port of `../server/`'s
  Node implementation, which *was* verified against the live API in an earlier session
  that had network access to it — but that verification was not repeated here. If you use
  this engine, verify it yourself with a real key before relying on it.
- **Faces:** enroll/identify/list/delete against real photos (uniface's own bundled
  verification set), plus error paths (group photo → 422, no face → 422, unknown name
  delete → 404) — all against the combined server.
- **Objects:** real YOLO detection against a real photo with multiple people/objects.
- **Client compatibility:** the app's own real, unmodified `onlineRecognizePlate()`,
  `yoloDetect()`, and `identifyFaceRequest()` functions (from `../index.html`) were run
  directly against this combined server and produced correct results — confirming this is
  a genuine drop-in for all three backend-URL settings, not just a contract match on paper.

**Not verified:** accuracy at scale (many enrolled faces, many detection classes, sustained
load) or on real driveway/gate camera footage rather than clean sample photos — see each
underlying folder's own README for what it already covers.

## Endpoints

Same contracts as the four standalone servers — see their READMEs for full request/response
shapes: `../server/README.md` (plates), `../vision-server/README.md` (faces),
`../yolo-server/README.md` (objects), `../plate-svm-server/README.md` (the local plate
engine specifically, including per-image accuracy results).

```
GET    /api/health
POST   /api/recognize-plate     (multipart: image)
POST   /api/faces/detect        (multipart: image)
POST   /api/faces/enroll        (multipart: image, name)
POST   /api/faces/identify      (multipart: image)
GET    /api/faces/list
DELETE /api/faces/{name}
POST   /api/detect              (multipart: image, optional min_confidence)
```
