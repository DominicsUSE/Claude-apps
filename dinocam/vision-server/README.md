# DinoCamSecurity — optional named face recognition backend

This is **optional**. DinoCamSecurity's main app (`../index.html`) already detects
faces on its own and labels every one "Unknown person" — no identity matching, no
server, no API key. Only set this up if you want more than that: recognizing
specific people you enroll yourself (e.g. household members) so the app can say
"this is `<name>`" instead of just "a face was seen."

This is a **separate service from `../server/`** (which is for license plate
recognition). Run either, both, or neither depending on which features you want.

Everything here runs entirely on your own machine using
[uniface](https://github.com/yakhyo/uniface) — local CPU inference via
`onnxruntime`, no GPU needed, nothing ever sent anywhere else. It never looks
anyone up externally and only knows the names you give it.

## What was and wasn't verified before this shipped

- Detection, recognition, and matching were run for real against `uniface`'s own
  bundled verification photos (three real people, six photos total). Same-person
  pairs scored 0.44–0.62 cosine similarity; different-person pairs scored -0.01–0.13.
  `MATCH_THRESHOLD` (default 0.30) sits in the gap between those two ranges.
- Every endpoint (`/api/health`, `/api/faces/detect`, `/api/faces/enroll`,
  `/api/faces/identify`, `/api/faces/list`, `DELETE /api/faces/{name}`) was
  exercised against a real running instance of this server with real HTTP
  requests and real images, including error paths: enrolling a group photo
  (rejected, 422), enrolling a photo with no face (rejected, 422), and an
  unreadable/corrupt upload (rejected, 400).
- `requirements.txt` was installed clean into a brand-new virtual environment
  (not just the dev one) and the server was booted and hit with a real request
  from that fresh install, to confirm the pinned versions actually work together.
- **Not verified:** accuracy against a large enrolled set (many people, many
  photos each), or against difficult real-world conditions — poor lighting,
  side angles, partial occlusion, low-resolution security-camera crops rather
  than clear photos. `MATCH_THRESHOLD` may need adjusting for your own
  camera/lighting before you rely on it. If you see false matches, lower it
  (e.g. `0.35`+); if it's missing people it should recognize, raise it slightly
  or enroll a couple more photos per person.

## Setup

1. Python 3.11+ recommended.
2. In this folder:
   ```
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```
3. Run it: `uvicorn server:app --host 0.0.0.0 --port 8788`
   Check `http://localhost:8788/api/health` returns `"ok": true`.
4. In DinoCamSecurity's settings, point the face-recognition backend URL at
   wherever this is running (e.g. `http://localhost:8788` if running on the
   same machine as your browser, or your LAN/deployed address otherwise).

Like `../server/`, this is meant to run on a device you control (your own
computer, home server, or NAS) — not a public host, since `faces_db.json`
holds facial embeddings for people you've named.

## Storage and privacy

- `faces_db.json` (created in this folder on first enrollment) holds each
  enrolled name and its embedding vectors — not photos, but data derived from
  faces, tied to names you chose. Treat it with the same care as the app's own
  captured photos: local device only, never sync or commit it. It's excluded
  by `.gitignore` here for that reason.
- Nothing this service does reaches outside your own network. There is no
  external lookup, no cloud call, no telemetry.
- Delete a person entirely with `DELETE /api/faces/{name}`, or just delete
  `faces_db.json` to wipe everything.

## Endpoints

- `GET /api/health` — `{ok, analyzer_loaded, enrolled_count, match_threshold}`
- `POST /api/faces/detect` — multipart field `image`. Returns faces found
  (bbox + confidence), no identity matching.
- `POST /api/faces/enroll` — multipart field `image` + form field `name`.
  Image must contain exactly one clear, front-facing face. Adds one embedding
  for that name (you can enroll several photos per name for better accuracy).
- `POST /api/faces/identify` — multipart field `image`. Returns each face
  found with its best name match (or `null`), a confidence score, and a
  status of `confirmed` / `candidate` / `unknown`.
- `GET /api/faces/list` — enrolled names and how many photos each has.
- `DELETE /api/faces/{name}` — removes that person entirely.

```json
{ "faces": [{ "bbox": [34, 12, 210, 240], "name": "Alex", "confidence": 52.3, "status": "confirmed" }] }
```
