# DinoCamSecurity — optional classic-CV Chinese plate reader

This is **optional**. DinoCamSecurity's main app (`../index.html`) already reads plates
locally via Tesseract OCR, tuned for Latin-alphabet plates. This is a different, older but
real technique — edge/color-based plate localization plus an OpenCV SVM character
classifier — specifically for the 7-character **Chinese** plate format (1 Chinese
province character + 6 letters/digits). Use it if the built-in Latin-tuned OCR isn't doing
well on Chinese plates; for anything else, the built-in engine or `../server/`'s online
engines are the better fit (see **Limitation** below).

Adapted from [wzh191920/License-Plate-Recognition](https://github.com/wzh191920/License-Plate-Recognition)
(MIT license, see `LICENSE-upstream.txt`) — `predict.py`, `config.js`, and the pretrained
`svm.dat`/`svmchinese.dat` weights are that project's, with two small fixes applied so it
runs on current dependencies (see the top of `predict.py`/`server.py` for exactly what and
why: numpy removed `np.int0` in 2.0, and `cv2.ml.SVM.predict()`'s float32 output needs an
explicit `int()` cast before `chr()`).

**This is a drop-in alternative backend** for DinoCamSecurity's existing "Online AI" plate
setting — it exposes the exact same `POST /api/recognize-plate` contract as `../server/`
(`{status, value, confidence, country, source}`), so point the app's backend URL field at
this instead of `../server/` to use this engine, with no other app changes needed. Unlike
`../server/`'s cloud engines (Claude vision / Plate Recognizer), this one is local-only,
like `../vision-server/` and `../yolo-server/` — nothing leaves your machine/network.

## Limitation — Chinese plates only

The first character of every read is always classified against the Chinese-province
model, whatever the plate actually says. On a genuine Chinese plate this is usually right.
On any other plate format, the first character will always come back as some Chinese
province character — i.e. wrong. Don't point this at non-Chinese-plate traffic.

## What was and wasn't verified before this shipped

After the two compatibility fixes, real predictions were run against all 11 bundled test
images (`test/*.jpg`, the original project's own test set):

| Image | Result | Notes |
|---|---|---|
| 1.jpg | 京E51619 | correct |
| 2.jpg | 京AD7Z972 | correct |
| cAA662F.jpg | 川AA662E | last character misread (F→E); province correct |
| car3.jpg | 鲁Q521MZ | correct |
| car4.jpg | 吉AA266G | correct |
| car5.jpg | *(no plate found)* | degrades gracefully, no crash |
| car7.jpg | 川C66666 | correct |
| lLD9016.jpg | *(no plate found)* | degrades gracefully, no crash |
| wA87271.jpg | *(no plate found)* | degrades gracefully, no crash |
| wATH859.jpg | 豫ATH859 | province character misread; rest correct |
| wAUB816.jpg | 皖AUB816 | correct |

8 of 11 located and read a plate; the two misreads were both the province character, which
matches the original project's own documented caveat that it's the character most likely
to be wrong. 3 of 11 found no plate (the algorithm returns nothing rather than guessing).
`/api/recognize-plate` was then hit with real HTTP multipart requests against a running
instance of this exact server (all 11 images, plus the corrupt-image error path), and the
app's own real, unmodified `onlineRecognizePlate()` client function was run against that
same running server to confirm the drop-in contract actually works end to end, not just on
paper.

**Not verified:** accuracy on real driveway/gate camera captures (all testing here used
the original project's own clean, close-up sample photos) or on plates significantly
different in resolution/angle/distance from those samples — the original README notes the
algorithm's parameters are sensitive to this; `config.js` has two presets and its own
comments on adjusting them.

## Setup

1. Python 3.11+ recommended.
2. In this folder:
   ```
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```
3. Run it: `uvicorn server:app --host 0.0.0.0 --port 8790`
   Check `http://localhost:8790/api/health` returns `"ok": true`.
4. In DinoCamSecurity's settings, set **AI recognition** to "Online AI" or "Ask before
   sending" and enter this server's URL (e.g. `http://localhost:8790`) in the backend URL
   field — exactly the same field used for `../server/`.

Meant to run on a device you control — not a public host.

## Endpoint

`POST /api/recognize-plate` — multipart field `image`. Returns:

```json
{ "status": "candidate", "value": "豫ATH859", "confidence": 55, "country": "cn", "source": "classic-cv-svm:blue" }
```

Status is always `candidate` (found) or `unreadable` (nothing found) — never `confirmed`,
since a single classical-CV pass has no repeated-read corroboration the way the app's
built-in multi-pass OCR does.
