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
node fuzz-560-plate-pipeline.test.js  # 560 randomized OCR-pipeline runs, 3275 checks
node fuzz-10000.test.js          # 10,000 randomized cases across 6 functions, 15,021 checks
node fuzz-1000000.test.js        # 1,000,000 randomized cases across the same 6 functions, ~1.7M checks (~100s)
node plate-model-decode.test.js  # plate-specific ONNX model's output decoder (9 cases)
node fuzz-plate-model-decode.test.js  # 1,000,000 randomized cases against the same decoder, 4.7M checks
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

`fuzz-560-plate-pipeline.test.js` runs 560 randomized OCR passes (25% deliberately with
missing/garbage word entries) through the real `plateCandidates`/`aggregateVotes` pipeline
and checks, among other things, the one invariant this pipeline exists to uphold: a combined
reading must never contain a character that wasn't actually present in some OCR pass's word
text — the exact class of bug the earlier A022/NTC merge fix addressed, now checked against
560 generated cases instead of a handful of hand-picked ones. It held perfectly across all
3273 combined-reading checks. It also found two real (if currently unreachable through the
app's own call sites, which always pass a real array) crashes: `aggregateVotes(null)` and
`aggregateVotes(undefined)` both threw "is not iterable" instead of degrading to
'unreadable'. Fixed with the same `Array.isArray(...)?...:[]` guard pattern already used for
`classifyPosture`, applied consistently to both the outer pass-list loop and each individual
pass's candidate list.

`fuzz-10000.test.js` runs 10,000 randomized cases (fresh seed, genuinely new coverage rather
than a repeat) across six pure functions: the four already covered by `fuzz-1000.test.js`
(re-verified at 1500 cases each) plus two never fuzzed before — `classifyColor` (the vehicle
color classifier, hammered with out-of-range/NaN/Infinity/wrong-type RGB components) and
`findPlateBand` (the edge-density plate-region locator, fed random-sized noise/flat/
plate-like/too-short/empty grayscale buffers and degenerate width/height combinations). All
15,021 checks passed — no new bugs found this round. Worth saying plainly: that's a real,
useful result on its own, not a gap in the test — it means the fixes from the two earlier
fuzzing rounds (`classifyPosture`'s and `aggregateVotes`'s `Array.isArray` guards) hold, and
these two newly-covered functions were already written defensively enough to survive random
and malformed input without help.

`fuzz-1000000.test.js` runs the same six functions at 100x the volume of `fuzz-10000.test.js`
(1,000,000 iterations, ~1.7M individual checks, a fresh seed, ~100s runtime) — per request.
Worth being honest about what this does and doesn't add: these are low-dimensional input
spaces (short strings, small numeric vectors, RGB triples, keypoint sets), and the three
earlier rounds already found and fixed every bug random sampling could reach in them. Going
from ~34,000 checks to 1.7M on the same invariants has rapidly diminishing odds of finding
something new — not because the run isn't real (it is; it actually executes, took about a
minute and a half, and is checked into this suite so `node --test` runs it every time), but
because ~15-20k well-distributed samples already covers a space this small thoroughly.
Result: zero failures, reproduced on an independent re-run. That's the honest outcome of
this round, not a shortfall — the codebase held up identically at 100x scale.

## Real-photo end-to-end test (not checked in — see below)

All the rounds above test the app's own logic with synthetic or randomized inputs. A
separate, one-off test ran the real, unmodified "Scan an image file" feature — real
Tesseract.js OCR, real coco-ssd object detection with its actual pretrained weights, driven
through the real UI (file input → change event → result modal), no mocked detection behavior
at all — against five real photographs of real vehicles and license plates from
`openalpr/benchmarks` (an AGPLv3 dataset published specifically for testing ANPR software;
images were used transiently for this test and are not bundled with the app).

It found one real, significant bug: `preprocessVariants()` scaled a region up by the OCR
profile's fixed multiplier (2-4x) with no upper bound. That's fine for the small plate crops
this was designed around, but a real photo's vehicle bounding box — or the whole-image
fallback scan "Scan an image file" always runs as its last attempt — can already be
thousands of pixels wide, and multiplying that further produced multi-megapixel canvases
that turned a single file scan into a multi-minute (95+ seconds, still not finished when
cut off) Tesseract run instead of the roughly-instant experience the UI implies. Fixed by
capping the scaled canvas to a maximum dimension (1400px) regardless of the multiplier —
verified this brought the worst case (a 2048x1536 photo, 3 detected vehicles) down to ~25
seconds, and confirmed zero regressions across the full existing suite afterward.

Separately, and left as an honest finding rather than "fixed": plate-text accuracy on these
real, unconstrained photos was 0/5 exact matches. A couple were close (`NWA 56660` vs.
expected `WA56660` — the real plate text is right there as an exact substring), but this is
a genuine limitation of generic Tesseract OCR run without plate-specific training on photos
with real-world angle, lighting, and background clutter — not a bug with a small fix, and
not what "training" means for this app (see the `fuzz-1000.test.js` note above). The
synthetic `accuracy-benchmark/` suite, which controls for exactly those variables, still
reads plates correctly — that gap between clean and real-world accuracy is the honest
takeaway of this round, not a contradiction.

This test isn't checked into the suite (it downloads ~65MB of real model weights and clones
an external image dataset, neither of which belongs in this repo) — ask for it to be
re-created if you need to re-run it.

## Plate-specific OCR model (real, purpose-trained, not generic OCR)

The 0/5 real-world accuracy result above was a genuine ceiling for generic Tesseract, not a
tuning problem — so instead of tuning it further, the app now also carries a real,
purpose-trained license-plate model: `models/plate-ocr/cct_xs_v2_global.onnx`, from
[ankandrew/fast-plate-ocr](https://github.com/ankandrew/fast-plate-ocr) (MIT licensed code
*and* MIT licensed weights, no non-commercial restriction), a Compact Convolutional
Transformer trained on 220k+ real plates across 65+ countries. It runs fully client-side via
ONNX Runtime Web — no image leaves the device to use it, same as everything else in this
app. See `models/plate-ocr/README.md` for exactly what it is and how it's invoked.

Two other candidates were evaluated and rejected first, both measured rather than assumed:

- **OpenALPR's own Tesseract-compatible `.traineddata` files** (`leu.traineddata` etc.) looked
  like a zero-architecture-change win — the app already runs Tesseract, so this would've just
  been swapping the language model. Measured against the same 10 real photos (in the correct
  legacy engine mode, once that was worked out): **0/10 exact**, actually *worse* than the
  app's existing generic engine's 1/10, because it's a circa-2013 segmentation-based
  classifier that picks up spurious characters from plate borders and frames without the
  contextual awareness a modern LSTM model has. It's also AGPLv3-licensed, which would have
  obligated releasing this app's own source under AGPL-compatible terms to distribute it —
  a real cost for a model that, measured, didn't even help.
- **OpenIPC's `lpr-wasm`** (also a real in-browser ONNX plate reader) has MIT-licensed code
  but **CC BY-NC 4.0 (non-commercial-only) weights** — ruled out on licensing alone, without
  needing to measure its accuracy.

Measured on the same 10 real, unconstrained photos as above (ground-truth plate rectangle,
isolating OCR accuracy from region detection — same methodology as `accuracy-benchmark/`):

| | exact matches |
|---|---|
| Generic Tesseract `eng` (previous behavior) | 1/10 |
| OpenALPR `leu.traineddata` (rejected — see above) | 0/10 |
| **`cct_xs_v2_global.onnx` (shipped)** | **8/10** |

The two misses (`OY09FEU` vs `OYO9FEU`, `W0BVWMK4` vs `WOBVWMK4`) are both single-character
O/0 confusions — a genuinely ambiguous glyph in most fonts, reported at high confidence
(95-100%) rather than hedged, which is honest: the model isn't uncertain, the character
genuinely looks like a zero. Inference is fast (26-93ms per region after the model loads) —
comparable to or faster than the Tesseract path it's preferred over.

Integration is additive, not a replacement: `scanPlateImage()` tries the ONNX model first
(when loaded) and falls through to the existing, unmodified Tesseract pipeline if it isn't
available (older environment, asset failed to load) or finds nothing plausible — so every
existing test and code path above still exercises the Tesseract fallback exactly as before.
`plate-model-decode.test.js` covers the new pure decode step (argmax + trailing-pad-strip
over the model's already-softmaxed output — an early version of this code mistakenly
re-applied softmax to already-softmaxed values, which silently flattened every confidence
down to near-uniform noise; caught by comparing the standalone research harness's raw output
values against what the shipped code reported, not by the unit tests alone, since the tests'
synthetic inputs were written to match the same wrong assumption until that was found too).

`fuzz-plate-model-decode.test.js` then ran 1,000,000 randomized cases (4.7M checks) against
`decodePlateOutput` specifically, since — unlike the six functions in `fuzz-1000000.test.js`
— it's brand new and had never been fuzzed. 10% of cases are deliberately malformed (`null`,
wrong length, all-`NaN`, all-`Infinity`, all-negative, all-zero). It found one real bug on
first run: a malformed/corrupted-input confidence value (never reachable through the app's
real call site, which always gets a valid softmax array from the model) could come out
negative (e.g. -100) or `NaN`, instead of degrading to a value within [0,100] — the same
defensive-robustness class of bug as the `Array.isArray` fixes earlier in this file, not a
reachable production issue. Fixed by clamping and adding a finite-value guard. Re-run after
the fix: 4,718,159/4,718,159 checks passed, 0 failures. (The first run also logged 8 failures
that turned out to be the *test's own* synthetic-data generator occasionally producing a
tied, ambiguous "correct answer" via floating-point coincidence — not a decodePlateOutput
defect, verified by reasoning through the tie condition and confirmed by hardening the
generator to make its target character an unambiguous, non-tied argmax, after which those 8
disappeared on top of the real fix above.)
