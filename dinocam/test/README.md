# Tests

Node unit tests (no browser needed) — each extracts and runs the real code straight out
of `../index.html`, so they always test the shipped app, not a copy:

```
node plate-pipeline.test.js      # core OCR merge/aggregation logic (15 cases)
node plate-locator.test.js       # plate-region edge-density locator (7 cases)
node plate-formats.test.js       # international plate format matrix (32 cases)
node vehicle-attributes.test.js  # color classifier (12 cases)
node face-match.test.js          # in-browser face-matching math (10 cases)
node watchlist-match.test.js     # fuzzy watchlist matching math (14 cases)
node posture-classify.test.js    # fall/posture geometry heuristic (9 cases)
node fuzz-1000.test.js           # randomized property-based fuzzing, ~19,000 checks across 4000+ generated cases
```

`face-match.test.js` covers the matching logic (faceDistance/matchKnownFace) with synthetic
descriptor vectors, not the face-api.js model itself — that needs a browser and a CDN this
sandbox's network policy blocks, so it's exercised by hand in a real browser instead.

Browser end-to-end tests (Playwright, mocked Tesseract/face-api.js/pose-detection since
this environment's network policy blocks those CDNs) live in the session's scratchpad
rather than here, since they need a Chromium binary path specific to the sandbox they were
written in — ask for them to be re-created if you need to re-run: A022/NTC merge through
the real UI, error paths (unreadable/corrupt file), settings/zone persistence, online-AI
wiring with a stubbed backend, multi-camera add/capture/remove, cross-camera track-ID
collision, lock-region scoping (a primary-camera-only setting must never leak into an extra
camera's scan, a rescanned extra-camera capture, or an uploaded test image), extra-camera
face detection/recognition parity with the primary camera, facial expression detection
propagating onto an already-saved capture, and fall/posture detection (no false alert while
standing, one alert per sustained lying-down episode, no repeat spam while still down).

`accuracy-benchmark/` is a real (not mocked) plate-reading accuracy test against synthetic
European plates at three distances, using a genuine local Tesseract engine fetched via npm
instead of the blocked CDN. See `accuracy-benchmark/README.md` for setup and results.

`fuzz-1000.test.js` is a randomized/property-based stress test, not a fixed-case one: it
generates hundreds of randomized inputs per function (strings, descriptor vectors, pose
keypoints — including deliberately malformed ones) with a seeded PRNG for reproducibility,
and checks invariants that must hold for any input (symmetry, non-negativity, "an exact
copy of an enrolled descriptor always matches its own owner, never a neighbor," "malformed
input degrades to 'unknown', never throws") rather than a list of expected outputs. It found
a real bug on first run: `classifyPosture(42)` threw, because `keypoints||[]` only substitutes
the fallback for falsy input — a truthy non-array slipped through and crashed the `for...of`.
Fixed with `Array.isArray(keypoints)?keypoints:[]`. Note what this test does and doesn't
cover: it exercises the app's own matching/personalization logic (enrolled faces, watchlist
plates) at volume, including a separate scale check (in the browser, not Node) that pushes
500 synthetic enrolled faces into `A.knownFaces` and confirms every one is still recognized
correctly with zero collisions — but it does not retrain or fuzz the underlying pretrained
models (face-api.js/coco-ssd/Tesseract/pose-detection) themselves, which this app never
trains and which are unrelated to what "training" means for DinoCam (enrolling known
people/vehicles, not model weights).
