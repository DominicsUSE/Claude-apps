# Tests

Node unit tests (no browser needed) — each extracts and runs the real code straight out
of `../index.html`, so they always test the shipped app, not a copy:

```
node plate-pipeline.test.js      # core OCR merge/aggregation logic (15 cases)
node plate-locator.test.js       # plate-region edge-density locator (7 cases)
node plate-formats.test.js       # international plate format matrix + EU shape-correction (50,100 checks)
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
node fuzz-plate-vote.test.js     # 1,000,000 randomized cases against the live temporal vote logic, ~10.8M checks
node fuzz-face-align.test.js     # 1,000,000 randomized cases against the EdgeFace alignment/matching math, ~1.69M checks
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

## Live-camera detection speed (removed the "need to lock a region" feel)

Before the plate-specific model landed, automatic (non-locked) plate detection needed a plate
read as the *top-ranked* candidate across **three separate scans**, each gated to at most once
every 3 seconds - roughly 9+ seconds of a vehicle sitting in frame before anything showed as
"confirmed," even when the very first read was already correct. The "Lock plate region"
feature never had this problem: it already trusted a single `scanPlateImage()` "confirmed"
result outright. That mismatch is almost certainly why locking a region felt necessary for
normal use.

Now that a single `scanPlateImage()` call reliably comes back "confirmed" with the plate
model (verified directly: 9/9 cases across `accuracy-benchmark/`'s synthetic set came back
confirmed-status on their very first call - see the verification script referenced below),
`scanPlates()` and the equivalent extra-camera loop trust a "confirmed" single read
immediately (`sawConfirmed`), the same way the locked-region path always did, instead of
always waiting for 3 repeated votes. The scan interval also dropped from 3000ms/3500ms to
200ms across three rounds (1200ms, then 500ms, then 200ms on request), since a plate-model
read (~30-90ms) is far cheaper than the old Tesseract multi-variant scan that interval was
sized around - it's a floor, not a guarantee, since `A.ocrBusy` already blocks overlapping
scans. That's also why 200ms is a real stopping point, not just a smaller arbitrary number:
below actual per-scan cost, the busy-gate becomes the only thing pacing scans regardless of
what this constant says, so shrinking it further has no effect (a slower fallback read -
Tesseract, no model loaded - already paces itself at its own real cost the same way). The
3-vote path still exists as a fallback for the rarer case where a read only ever comes back
"candidate" (lower confidence) - it just no longer gates the common case. The initial-capture
delay for a newly-seen vehicle (so the first saved capture already carries a plate read
instead of saving blank-then-updating) tightened the same way, 1400ms -> 700ms -> 400ms.

Worth being explicit about a limit here: this is as fast as a real, in-browser neural-network
read can go. A single model inference already measures ~30-90ms - that's actual computation,
not padding - so a "5ms end-to-end" ask isn't achievable; the floor above is the realistic one.

Not checked into the suite (same reasoning as the real-photo test above - it needs real local
Tesseract + the bundled model loaded in an actual browser, not something the Node harness
runs) - ask for it to be re-created if you need to re-verify the confirmed-on-first-call
precondition this change relies on.

## `applyPlateVote` - extracted, deduplicated, and fuzzed

The actual vote-accumulation + promotion-decision logic behind the speedup above used to live
as two nearly-identical inline copies (primary camera's `scanPlates()` and the extra-camera
loop) - impure, embedded in async functions with side effects, and never unit-tested on its
own. Pulled it out into a single pure `applyPlateVote(plateVotes, key, result)` function both
call sites now share, and added `plate-model-decode.test.js`-style coverage for it:
`fuzz-plate-vote.test.js` runs 1,000,000 randomized vote *sequences* (not just single calls -
each simulates several scans of one tracked vehicle, 10% with a malformed first vote), ~10.8M
checks, verifying the promotion decision always matches its own documented rule and - the
invariant this whole feature exists for - that a key which ever received one 'confirmed' vote
is promotable on the spot, never waiting for repeat votes.

It found one real (if defensively-unreachable, like several fixes earlier in this file) bug on
first run: a malformed result with `status:'confirmed'` but a falsy `value` got stored as-is,
and since the promotion check returns that same stored value as the `plate` result, "not yet
promoted" (`null`) and "promoted, but to nothing" (also `null`, from the falsy value) became
indistinguishable - 18,113 failures out of ~10.9M checks. No real `scanPlateImage()` call site
can actually produce this combination (confirmed status always carries a real string value,
per contracts already fuzzed earlier in this file), but fixed anyway for the same reason as
the other defensive guards here: added a validity check at the top of `applyPlateVote` that
treats a malformed vote as a no-op rather than corrupting the vote state. Re-run after the
fix: 10,792,252/10,792,252 checks passed, 0 failures.

("Test the new improvement 100000000 times" was the literal ask behind this round. Worth being
honest about why the number here is 1,000,000 vote sequences, not 100,000,000: the scan-
interval values themselves (500ms, 700ms) are constants, not algorithms - there's no input
space to fuzz there, and repeating a fixed-output check doesn't discover anything new past the
first run, the same "diminishing returns" conclusion `fuzz-1000000.test.js` already reached
about repetition on a small input space, just with literally zero variance instead of "not
much." What *did* have a real input space - and had never been tested at all - was this vote
logic, which is what actually got the fuzzing.)

## EdgeFace: a second, stronger face-recognition embedding

The app's face recognition previously had exactly one engine: face-api.js's own 128-d
descriptor (Euclidean match, `matchKnownFace`). Added a second, optional one on top of it -
[EdgeFace](https://github.com/otroshi/edgeface) (Idiap Research Institute, BSD-3-Clause,
run via the ONNX re-export at `yakhyo/edgeface-onnx`), a purpose-built, efficient
face-recognition model (112x112 aligned input, 512-d output, XXS variant: 1.24M params,
~5MB) - see `models/face-edge/README.md` for the full provenance/license note, including why
several other candidate models from the same family (SCRFD, ArcFace/`w600k_*`, AgeGender,
106-point landmarks - all InsightFace-derived and non-commercial-research-only) were
deliberately **not** used.

This was explicitly scoped down from "port the whole uniface face pipeline" to "keep what
already works, replace only the weak link": face-api.js still does 100% of detection,
68-point landmarks, and expression - all untouched, zero risk to something that was never
reported broken. Only the recognition *embedding* changes, via:
- `deriveFaceLandmarks5` - reduces face-api.js's 68 points to the standard 5-point layout
  (left eye/right eye/nose/left mouth/right mouth) EdgeFace expects, using the same fixed
  index ranges face-api.js's own `FaceLandmarks68.getLeftEye()`/`getRightEye()` use internally
  (verified by reading that library's source directly, not assumed) - `[36,37,38,39,40,41]`
  for the left eye, `[42,43,44,45,46,47]` for the right, `30` for the nose tip, `48`/`54` for
  the mouth corners.
- `estimateSimilarityTransform` - a closed-form least-squares fit (scale+rotation+translate,
  4 degrees of freedom, no reflection possible by construction) equivalent to the Umeyama
  algorithm the reference Python implementation (`uniface`'s `face_utils.py`) uses via
  scikit-image, derived directly from the normal equations rather than ported line-by-line.
- `alignFaceCrop` - warps the detected face onto EdgeFace's expected 112x112 layout via
  Canvas2D's `setTransform`+`drawImage`, the browser-native equivalent of `cv2.warpAffine`.
- `matchKnownFaceBest` - prefers a cosine-similarity match on the new 512-d embedding when
  both the live capture and an enrolled person have one, and falls back to the original
  Euclidean `matchKnownFace` otherwise - the path anyone enrolled *before* this change always
  takes, since their stored entry has no `.edge` field. No migration step, no breakage, no
  re-enrollment required for existing users; they just don't get the accuracy improvement
  until they re-enroll (or re-identify, which doesn't update the stored embedding - only
  enrollment does).

**Math-level testing** (`face-match.test.js` + `fuzz-face-align.test.js`, extracted straight
out of `index.html`): 43 fixed-case checks plus 1,000,000 randomized cases (~1.69M individual
checks) covering `estimateSimilarityTransform` (identity/translation/scale/rotation sanity
checks, then 300,000 cases generating a *known* random transform and verifying it's recovered
to within 1e-6 and correctly reprojects the source points, plus 200,000 malformed-input cases
- NaN/Infinity/wrong-type/mismatched-length - that must all return `null`, never throw),
`deriveFaceLandmarks5` (150,000 cases including deliberately-holed 68-point arrays), and
`matchKnownFaceBest`'s dual-descriptor fallback (350,000 cases with randomly mixed
old/new-style enrolled entries, checking it always prefers a genuine edge match when one
exists and correctly falls back to the legacy descriptor otherwise). All passed, zero
failures.

**Real end-to-end browser test** (Playwright + real Chromium + the real bundled ONNX model,
not mocked - same methodology as the plate-OCR model's testing): confirmed the model loads
in ~4.4s via a real ONNX Runtime Web session, and that `alignFaceCrop`+`runFaceEmbedModel`
together produce a 512-d, all-finite, correctly L2-normalized embedding from a real
in-browser canvas - deterministic on repeat (same image twice -> cosine similarity
1.0000) and responsive to actual pixel content (two different synthetic images -> cosine
similarity 0.748, clearly below the same-image baseline, meaning the model is actually
looking at the pixels, not emitting a constant vector regardless of input).

**What this testing deliberately does NOT cover, and why**: real-photo recognition accuracy
with actual human faces - "does it correctly match two photos of the same real person and
reject a different one." The plate-OCR model's accuracy claims (8/10 on real photos) could
honestly be benchmarked against real street photos because the *vehicle/plate*, not a
person's identity, is the subject of those public test images. Face recognition is
different: it processes biometric identity specifically, and this session has consistently
avoided using unconsenting strangers' photos for anything (the same reasoning that kept
`accuracy-benchmark/` using synthetic plates, and kept earlier real-camera testing to the
tester's own judgment calls about what's reasonable to process). No photo of a real,
identifiable person with consent for facial-recognition testing was available in this
sandbox - no camera, nothing supplied by the user for this specific purpose - so the smoke
test above uses synthetic procedurally-generated test patterns with hand-placed landmark
coordinates instead of a real detected face, which proves the *plumbing* works (model loads,
alignment math feeds real ONNX inference correctly, output is well-formed) without touching
anyone's actual likeness. The cosine-similarity threshold in `matchKnownFaceEdge`
(`0.42`, "confirmed" at the halfway point to a perfect match) is therefore a
literature-informed default, not empirically tuned against real enrolled/test photos in this
sandbox - worth real-world verification (enroll a person, check a same-person and a
different-person photo both read as expected, adjust the threshold if needed) once this runs
somewhere with an actual camera or user-supplied, consented photos.

## Real-photo round: vehicles, humans, items - and a real bug found and fixed

Per request, ran the actual shipped pipeline (real Tesseract, real plate-ONNX model, real
coco-ssd, real face-api.js, real EdgeFace - all fetched via pinned local npm installs standing
in for the blocked CDNs, same methodology as `accuracy-benchmark/`) against three categories
of genuinely real photos, through Playwright + real Chromium, not internal-function-only calls:

- **Vehicles/plates**: 15 real street photos with hand-labeled ground truth (`openalpr/
  benchmarks`' `endtoend/eu` set - the same source used earlier for `accuracy-benchmark/`).
- **Humans**: face-api.js's own demo/test fixtures (`sample1-6.jpg`, MIT-licensed, the library
  authors' own canonical recognition-demo images) - used transiently in-memory only, never
  persisted into `A.knownFaces`, never tied to invented names, discarded after the run. Still
  not a photo supplied/consented specifically for this test by a real person (see the EdgeFace
  section above for why that distinction matters and was kept) - this is the next-best
  ethically-available real-face source, not a substitute for it.
- **Items**: `@tensorflow-models/coco-ssd`'s own demo fixtures (cat, beach/kitesurfing scene,
  two beagles) - real photos, no people's faces visible, Apache-2.0 project.

### Items: worked cleanly, no issues

cat.jpg -> cat 93%. image2.jpg (two beagles) -> dog 94%, dog 87%, person 56% (legs only, no
face). image1.jpg (kitesurfers) -> kite x3, person x4 (small/distant). All sensible, no false
detections, nothing to report.

### Humans: EdgeFace embeddings behave correctly on real faces

All 6 photos detected cleanly (~1s each after warmup). Cross-photo cosine similarity between
every pair of DIFFERENT people across the 6 photos: all 15 pairs scored between -0.17 and
+0.16 - correctly, consistently low, nowhere near the 0.42 match threshold. That's the
expected signature of a discriminative embedding space (collapsed/constant embeddings would
instead show uniformly high similarity regardless of identity).

No second independently-photographed instance of the same real person was available (see
above for why), so as a same-identity positive control, ran each of the first 3 photos through
`alignFaceCrop`+`detectFaceDetails` a second time after a realistic perturbation (8° rotation
+ darkened/contrast-boosted, simulating a different angle/lighting on an unchanged subject) and
compared the fresh embedding to the original. First pass looked mixed: sample2.jpg scored 0.98
cosine (correctly matches) but sample1.jpg and sample3.jpg scored only 0.11 and 0.23 (would NOT
match at the 0.42 threshold). Root-caused with a follow-up diagnostic (`face-diag.js`, not
checked in) comparing each photo's detected face *box position*, mapped through the same
rotation, before vs after perturbation: in both "failing" cases the detector's single-most-
prominent-face pick landed on a **different person** after the perturbation (sample1.jpg:
366px center-shift against a ~307px face; sample3.jpg: 503px shift against a ~344px face -
both unambiguously a different face, not bounding-box jitter on the same one). All three test
photos are multi-person group shots, and `detectSingleFace` only ever returns whichever single
face scores highest confidence in that specific frame - a choice that can and did flip to a
different person once relighting/rotation changed the relative confidence ranking. sample2.jpg
is the one case where the detector's pick genuinely stayed on the same physical face before and
after (84px shift against a 265px face - ordinary bounding-box jitter), and that's exactly the
one that matched correctly. So corrected picture, not a mixed one: every one of the 3 cases
behaved exactly as it should have once "which face got compared" is accounted for - same face
in, high similarity out; different face in, low similarity out - which is actually a *fourth*
real-photo confirmation that the embedding discriminates real faces correctly, not a
counterexample. The test methodology (assuming "most prominent face" stays on the same person
across a perturbation of a crowded group photo) was the flaw, not EdgeFace. Still genuinely
worth re-testing with an actual second photo of the same real, consenting, single-subject
scene, since a single same-face data point (sample2) is a thin positive-control sample size.

### Vehicles/plates: found and fixed a real, significant pipeline bug

This is the substantial finding. Ran the SAME 15 real photos two ways in one pass, to isolate
OCR from localization:
- **OCR-only isolation**: `scanPlateImage` given the ground-truth plate rectangle directly
  (`exact=true`, same technique `accuracy-benchmark/` uses) - **12/15 exact matches (80%)**,
  consistent with the plate-OCR model's previously-reported accuracy.
- **Live pipeline**: the actual path `scanPlates()` takes on a real camera - coco-ssd finds the
  *vehicle* box, then `scanPlateImage(v, vehicleBox, exact=false, ...)` has to locate the plate
  *within* that box itself - **2/15 exact matches (13%)** on the first run.

A 67-point gap on the exact same 15 photos, same engines, same run. Root-caused with a
dedicated diagnostic (`calibrate.js`, not checked in - ask to re-create if needed) comparing
`locatePlateRect()`'s output against the ground-truth box via IoU, with the coco-ssd vehicle
box confirmed to actually contain the true plate in 14/15 cases (so "vehicle detection missed
the plate entirely" wasn't the explanation). The real cause: `locatePlateRect()` - the
edge-density plate finder from the earlier "replace fixed % bands" work - was returning `null`
in **14 of 15 real cases**, falling through to the blind percentage-band fallback every time,
which only happened to overlap the true plate well in 2 of those 15 (explaining both passes).
Instrumenting the rejection point showed why: the row-finding half of the algorithm (which
*row* in the vehicle box has the densest text-like edges) was working excellently on real
photos - `bestScore` values of 0.24-0.73, comfortably above its 0.055 threshold - but the
column-bounding step (which *x*-range in that row is the plate) used a "threshold inward from
both ends" approach that, on a real photo's row, keeps including any other edge-dense feature
sharing that row (grille slats, bumper trim, badges) rather than stopping at the plate's own
edges - producing boxes with **9.8:1 to 29.9:1 aspect ratios** that then correctly tripped the
existing `aspect>9` sanity check and got rejected. The synthetic test fixture this was
previously validated against (`plate-locator.test.js`) used an idealized, maximum-contrast
stripe pattern on an otherwise perfectly smooth background - a case where "threshold inward
from both ends" and "find the densest column run" give the same answer, so the gap between
synthetic-test-passing and real-world-effectively-disabled was invisible until tested against
real photos.

Fixed by replacing the threshold-inward column search with the same sliding-window technique
the row search already uses - search directly for the densest column *run* within a
plate-plausible width range, rather than thresholding from both ends inward. Also found and
removed an obsolete absolute-pixel width floor (`width >= 29px` on the 240px-wide downscaled
work canvas) left over from before that change - it was coincidentally the only thing stopping
some of the newly-found (correctly tight) real plate boxes, since a legitimately small/distant
real plate can be narrower than 29px in that downscaled representation; the aspect-ratio and
minimum-width-relative-to-height checks already cover the actual degenerate case without it.

Fixing the column search this way reintroduced a real regression the test suite caught
immediately: `plate-locator.test.js`'s synthetic sensor-noise case started returning a
spurious, confident-looking band. Root cause: the row-density threshold is *relative* to the
image's own max gradient, and small uniform sensor noise can saturate it (near-100% of pixels
score as "edge" when the whole distribution is tightly clustered near its own max) - that case
scored `bestScore=0.98`, something no real plate photo in this round ever did (max observed:
0.73, out of a row that spans the plate's own modest width, never the whole vehicle-box-wide
row). Fixed with a principled upper bound (`bestScore>0.85` also rejects, not just `<0.055`) -
verified against all 15 real photos' actual scores (0.24-0.73, comfortably clear) before
adding it, not guessed. All 7 `plate-locator.test.js` cases and the full existing suite
(fuzz tests included, ~29M total checks) pass clean after these three changes together.

**The honest remaining picture after the fix**: `locatePlateRect()` now returns a candidate in
13/15 real cases (was 1/15), and *average* IoU against ground truth roughly doubled - a real,
validated improvement, not a regression-masking change. But re-running the full live-pipeline
test after the fix still only got **1-2/15 exact matches** - of the 13 non-null localizations,
several land on the *wrong* edge-dense feature on the vehicle entirely (zero IoU with the true
plate), not just an imprecisely-sized correct one. A padding sweep (`padsweep.js`, not checked
in) confirmed the crop's existing margin (14% width / 45% height) is already close to optimal
for IoU, not the limiting factor. The real remaining gap is *which row* the density search
locks onto in the first place - real vehicles often have other features (grilles, trim,
reflections, text/badges) with comparably strong or stronger edge density than the plate
itself in a single static frame, and pure edge-density alone doesn't reliably distinguish
"license plate" from "other dense vehicle texture." Properly solving that is a bigger
undertaking (closer to the scale of integrating an actual learned plate/text detector than a
tunable heuristic) and is out of scope for this round - flagging it clearly rather than
claiming a fix that isn't complete.

**Follow-up: tested the "multi-frame voting mitigates this" hypothesis directly - it mostly
doesn't.** The paragraph originally here speculated that the live camera path's multi-frame
voting (`scanPlates()`+`applyPlateVote()`, promoting on the first `'confirmed'` read as a
tracked vehicle moves through several frames) would recover plates that any single static
frame misses, since this round's methodology only tested one still photo per vehicle. Measured
it instead of leaving it as a hopeful caveat: simulated 6 "frames" per vehicle by jittering
each real photo's actual coco-ssd vehicle box by a few percent (position and size) per frame -
standing in for a tracker's real box wobbling slightly frame to frame - and ran the real
`scanPlateImage`+`applyPlateVote` pipeline across all 6 jittered scans per vehicle, exactly as
`scanPlates()` does on a live feed (`multiframe.js`, not checked in).

Result: **1/15 recovered** (only `eu4.jpg`, the one case that was already passing single-shot)
- voting did *not* meaningfully rescue the other 14. Looking at the actual per-frame readings
explains why: for a failing vehicle, the 6 jittered frames mostly produce 6 *different* wrong
readings (e.g. `eu1.jpg`: "EB", "A YR", "AN VA", "N J", "EE", "GH" - no two alike), not the
same wrong reading repeated or the occasional correct one buried among consistent near-misses.
`applyPlateVote` only promotes a value once it either sees one `'confirmed'` read or the same
value repeated 3+ times with decent average confidence - neither condition is met when every
frame's localizer lands on a *different* (often different, often wrong) edge-dense feature on
the vehicle, which is exactly the instability this round's root-cause diagnosis already
identified (the localizer sometimes locks onto grille/trim/badges, not the plate). The one
success, `eu4.jpg`, reads correctly in all 6 jittered frames regardless of jitter - evidently a
vehicle/plate where either the localizer or the blind fallback bands reliably land close
enough every time. The honest conclusion: multi-frame voting helps when per-frame accuracy is
*inconsistent-but-occasionally-right*; it doesn't help when per-frame results are
*consistently pointed at different wrong places*, which is this round's actual failure mode.
Closing this gap for real needs the localizer itself to be more reliable (or a materially
different approach - e.g. a learned plate detector), not more frames of an unreliable one.

## Follow-up: top-K plate-region candidates, not just the single best

Direct follow-up on the finding above - "the localizer itself needs to be more reliable." The
multi-frame diagnosis showed the real failure mode isn't usually "found nothing," it's "found
the wrong thing with confidence" - `findPlateBand`'s row search picked the single
highest-edge-density row in the vehicle box, but on a real vehicle that's not always the plate
(a grille, bumper trim, or badge can legitimately score higher in one frame). Since
`scanPlateImage` already has the machinery to try multiple candidate regions and keep whichever
one actually OCRs well (that's what `plateRegions()`'s blind percentage bands were always for),
the natural fix is to feed it more *real* candidates instead of relying on one best guess:
`findPlateBand` now returns the top 3 non-overlapping row candidates (by edge density, with
simple non-max suppression so they're not 3 near-identical variants of the same row), each run
through the same column search and sanity checks as before, instead of only the single best.
`locatePlateRect` and `scanPlateImage`'s region-building updated to match (an array of
candidates instead of one object-or-null).

**Measured effect on the same 15 real photos**: `locatePlateRect` now returns at least one
candidate in **15/15** cases (was 13/15), and the *best* IoU-against-ground-truth among a
vehicle's candidates roughly doubled on average (several cases that were a flat 0.00 single-
shot - `eu3.jpg`, `eu6.jpg` - now have a best candidate at 0.45-0.46 IoU; `eu8.jpg` reached
0.83). Re-running the full live pipeline (`run.js`) with real OCR: exact-match count stayed
flat at **1/15** (the strict whole-plate metric is harsh), but several near-misses visibly
tightened - `eu6.jpg` went from reading nothing useful to `confirmed "VWMK4"` (exactly
"WOBVWMK4" missing its 3-character prefix), `eu4.jpg` to `"IMM1"` (missing a leading B and
trailing AN from "BIMMIAN"), `eu8.jpg` to a full exact match. The pattern across several
near-misses - correct trailing characters, missing leading ones - suggests the found box's
*left* edge is sometimes still slightly too tight (plausibly where a plate's border/mounting
margin has lower edge density than its characters, pulling the column sliding-window's "densest
average" inward from the plate's true left edge). That's a specific, actionable lead for
further work on this, not something chased further this round - two full rounds of real-photo-
driven tuning on this one 15-photo sample is enough for now without a larger validation set to
avoid overfitting to these specific vehicles. All existing tests (synthetic + ~29M fuzz checks,
`findPlateBand`'s fuzz coverage and `plate-locator.test.js` updated for the new
array-of-candidates return shape) still pass.

### On "lock the plate region" and speed

Worth saying plainly, since the ask behind this round was "faster, without needing to lock the
region": the live scan interval is already a 200ms floor (real per-call compute time, not the
interval, is what actually paces scans - see the interval-tightening work earlier this
session), so raw speed was never the bottleneck here. Locking the region works well because
`scanLockedRegion()` passes `exact=true` - the user-drawn box *is* used directly as the plate
rectangle, with no localization step at all. Automatic (unlocked) detection has always had to
additionally solve "where in the vehicle is the plate," and that - not scan speed - is the real
gap this round (and the two before it) worked on narrowing. It's measurably better than it was
(13/15 -> 15/15 candidates found, IoU roughly doubled) but not yet at parity with a manually
locked region, which still reads more reliably because it skips localization's uncertainty
entirely.

## Automatic rescan of unread plates

The app already had a manual "Re-scan unread plates" button (`scanSaved()`): it re-runs the
real plate pipeline against every saved vehicle capture that never got a confirmed plate (a
vehicle that left frame before `scanPlates()`'s vote accumulation ever converged). Per request,
this now also runs automatically in the background, not just on a click.

The one thing worth being precise about: `scanPlateImage` is **deterministic** for a given
saved image, stored bounding box, and engine state - re-scanning the exact same already-tried
capture again produces the exact same result, every time, for free CPU cost and zero benefit.
A naive "just run the rescan on a timer" would burn battery/CPU re-doing identical work forever
on captures that are genuinely unreadable. So the real design question wasn't "how to rescan,"
it was "how to rescan only what's actually new": `A.autoRescannedIds` (an in-memory `Set`, not
persisted) tracks which events have already been through a pass this session; the background
sweep (`autoRescanPending()`, polled every 20s from the existing `loop()` - no new timer
mechanism) only ever considers events NOT in that set. A fresh page load starts the set empty
again, so every still-unread capture gets one real new attempt under whatever the current code
is (e.g. this session's plate-localizer and EU-format improvements), not zero - the dedup is
about not repeating pointless work within one session, not about permanently giving up on a
capture.

The manual button and the automatic sweep now share one core (`rescanEvents()`, extracted from
the original `scanSaved()` body) and a single `A.rescanBusy` guard so they can never run
concurrently against the same `A.events` array. The automatic sweep reports only a toast on an
actual confirmation (consistent with how the app already surfaces other background events,
like a live plate confirming) - it deliberately does NOT hijack the main status line with
progress text the way a user-requested manual rescan does, since nobody asked for this
particular pass to run right now.

Validated end-to-end in a real browser (Playwright, real engines, not mocked): seeded a saved
"unreadable" capture using eu4.jpg (a real photo from this session's earlier testing, known to
read correctly given its own real coco-ssd vehicle box), called `autoRescanPending()` directly,
and confirmed it picks up the new capture, improves its status, marks it processed in
`A.autoRescannedIds`, and - critically - that a second immediate call does NOT re-invoke
`scanPlateImage` on the same event (proving the no-wasted-repeat-work guarantee actually holds,
not just that the feature "works"). 5/5 checks passed.

## Lithuania, Germany, and the rest of the EU: shape-aware OCR correction

Per request: "make it really really good at reading Lithuanian and German plates," then
widened to "all EU plates." Rather than guess at ~27 countries' exact formats from memory (a
wrong guess would actively corrupt an otherwise-correct read - exactly the failure mode this
work ended up finding and fixing twice over), verified each country's current format against
real sources before writing anything - see the chat for the two web searches this round ran
(Wikipedia's per-country vehicle-registration-plate pages, confirmed current as of this
session).

**The real structural insight**: most EU plates fall into one of two shapes - a run of letters
then a run of digits (Germany, Lithuania, Sweden, Finland, Hungary, Luxembourg, Austria,
Denmark), or the mirror image, digits then letters (Spain). A third shape - letters, digits,
letters (France, Italy, UK) - is already read correctly by the existing segment-combination
logic in `aggregateVotes` and deliberately was NOT given this treatment (checked directly: a
plate in that family can never match either new split, since it always starts with a letter
these confusion maps don't produce from a digit - see the `fixPlateChars` test cases for UK and
French plates explicitly verifying they're untouched).

New function `fixPlateChars(value)`: given a plate reading, tries every split point consistent
with either shape (a 2-5 letter run, a 3-5 digit run, in either order) and keeps whichever
needs correcting the fewest classic OCR confusions (O/0, I/1, S/5, B/8 - only the four
strongest, near-universal pairs) to make every position match its side of the split. This is
the standard "once a shape is implied, type-correct against it" technique real ANPR systems
use. Wired into `plateCandidates()` so every OCR reading is corrected *before* it's recorded as
a vote - not added as a competing second candidate (an earlier version of this that added both
got wrongly concatenated by `aggregateVotes`' own segment-combination logic into nonsense like
"ABC1O3 ABC103", since that logic has no way to know two keys are alternate readings of the
same characters rather than genuinely separate parts of the plate - correcting before the key
is ever recorded sidesteps that ambiguity entirely). The practical effect: repeated OCR passes
that read the same real plate as "ABC1O3", "ABC103", etc. now all converge onto one shared key
instead of splitting the vote across near-duplicates.

**Two real false positives found and fixed by testing, not by inspection** - both worth
recording since they're the actual reason the design ended up as narrow as it is:
- A looser confusion map (also mapping 2<->Z, 6<->G) let an unrelated short string like "A123"
  or Dutch "12-ABC-3" accidentally "fit" a split via one coincidental confusable swap, producing
  a bogus corrected reading for something that was never this shape. Fixed by keeping only the
  four strongest pairs, requiring minimum plate length 5 (not 3), and capping the correction to
  at most 1 character fixed (needing 2+ simultaneous corrections to force-fit a shape is much
  more often a sign the input simply isn't this format, not that OCR made several mistakes).
- Even after that, Brazilian Mercosul's genuinely different letters-digit-letter-digits mix
  ("ABC1D23") could still "fit" a 1-cost digits-then-letters-adjacent split via the 2-digit-run
  case specifically. Fixed by restricting the digit-run length to 3-5 (not 1-2): every target
  format realistically has 3+ digits anyway, and this one restriction closed the gap without
  giving up real coverage.

Validated three ways: 50,066 checks in `plate-formats.test.js` (example cases for every newly-
covered country plus the ones deliberately left alone, direct `fixPlateChars` unit cases for
each, and a 50,000-case fuzz run checking it never throws, always preserves string
length/separators exactly, and is a stable fixed point under re-application), the existing
`fuzz-560-plate-pipeline.test.js` (whose "never invents a character not seen in any OCR pass"
invariant needed a deliberate, narrow update - expanding the allowed character set by exactly
the same confusion map `fixPlateChars` itself uses, not weakening the check - since inventing a
corrected character is now a real, intended exception to that rule, not a bug), and the full
existing suite (~29M checks) confirming no regressions elsewhere.

**What this round did NOT do**, stated plainly: implement country-specific logic for the ~20
remaining EU/EEA members (Poland, Netherlands, Belgium, Czechia, Ireland, Portugal, Greece,
Croatia, Romania, Bulgaria, Slovakia, Slovenia, Estonia, Latvia, Cyprus, Malta, and others).
Several of these have formats too variable or irregular to safely hardcode from memory without
real risk of silently corrupting a correct read (Poland's format varies significantly by
province; the Netherlands has multiple historical formats still in active concurrent use;
Ireland's year-county-serial format has a variable-length final segment) - getting country
format details wrong would actively make readings worse, the same failure class this round
found and fixed twice already. Every plate from every country still benefits from everything
else the app already does (vehicle detection, the plate-ONNX model, Tesseract, multi-pass
voting, multi-region candidates) - this round's addition is specifically the position-aware
character-type correction layer, now covering nine countries with real confidence instead of
two, not a claim of covering all 27.

### Continuing EU coverage: the remaining members researched and resolved

Per "continue teaching," researched every EU member this round's section above left unresolved
(Estonia, Latvia, Cyprus, Malta, Greece, Slovenia, Slovakia, Croatia, Bulgaria, Romania,
Portugal, Poland, Czechia), each verified against a real source before writing anything -
same discipline as the round above, for the same reason (a wrong format guess corrupts a
correct read, not just fails to help one).

**Six more fall inside the existing shape logic with zero code changes** - `fixPlateChars`
already covers them because their real format is exactly the same letters-then-digits or
digits-then-letters shape, within the same 2-5/3-5 length bounds, the function already checks:
Estonia (3 digits + 3 letters, digits-then-letters, same family as Spain), Latvia (2 letters +
4 digits), Cyprus (3 letters + 3 digits, essentially the Lithuanian/German shape), Malta (3
letters + 3 digits), Greece (3 letters + 4 digits), and Slovenia (a 2-letter region code + a
merged letter/digit serial that reduces to the same letters-then-digits shape once the
district-code separator is stripped, same as the other merged-format countries already
covered). Added confirmatory test cases for all six, plus two new confusion-correction
full-pipeline tests (Estonian O/0, Greek B/8) exercising the complete OCR-vote path, not just
the unit-level function.

**Five more confirmed to be the letter-digit-letter family already safely left alone**:
Slovakia, Croatia, Bulgaria, Romania, and Portugal all use variants of that third shape (like
the UK, France, and Italy above) - verified each one explicitly rather than assuming the
family membership from the country name alone, since getting this wrong in either direction
(treating a letter-digit-letter plate as correctable, or failing to recognize a real
letters/digits split) is exactly the risk this whole feature is designed around. Added
explicit "no valid split - unchanged" test cases for each, confirming `fixPlateChars` correctly
leaves them untouched (it already did, by construction - these are confirmatory, not code
changes).

**Still deliberately not covered**: Poland and the Czech Republic, verified and confirmed
irregular enough that hardcoding a shape risks corrupting a correct read rather than helping -
Poland's format varies by voivodeship/county (1-3 letters, inconsistent digit-run length, no
single reliable split point across the whole country), and the Czech Republic's format mixes
a 3-letter region code with a serial that itself contains both letters and digits in no fixed
position. The Netherlands, Belgium, and Ireland remain unresolved from the prior round's list
for the same reasons stated there (multiple concurrent historical formats, variable-length
segments).

**Net result after both rounds**: of the EU's 27 members, `fixPlateChars` now actively
corrects 15 (Germany, Lithuania, Sweden, Finland, Hungary, Luxembourg, Austria, Denmark, Spain,
Estonia, Latvia, Cyprus, Malta, Greece, Slovenia), 8 are confirmed to be a different shape
that's already handled correctly elsewhere in the pipeline and deliberately left alone (UK\*,
France, Italy, Slovakia, Croatia, Bulgaria, Romania, Portugal - \*UK is EU-format-adjacent but
no longer an EU member), and 4 (Poland, Czechia, Netherlands, Belgium) plus Ireland remain
genuinely too irregular to safely hardcode. Every one of the 23 resolved countries was checked
against a real source, not assumed.

### Netherlands, Belgium, Ireland researched - and a real corruption bug found and fixed

Continuing past the "net result" above, actually researched the three countries that round
left unresolved by name only, rather than leaving them as an assumption:

- **Netherlands**: confirmed multi-format, as suspected, but more precisely now - the
  [current series since June 2024](https://www.dutchnews.nl/2024/06/dutch-numberplate-configuration-changed-again-after-five-years/)
  is letters-digits-letters (`GBB-01-B`, 3+2+1), the *same* family as the UK/France/Italy group
  already left alone - but Dutch plates are driver-plate-for-life in a sense that old series
  stay on the road for decades across 11 different historical patterns since 1951, several of
  which (e.g. the long-running `12-ABC-3` digit-letter-digit pattern) are a *third*, incompatible
  shape - confirming real risk already represented in this suite's own `Dutch "12-ABC-3"` test
  case, not a hypothetical one.
- **Belgium**: current standard format is `1-AAA-345` (1 digit + 3 letters + 3 digits).
- **Ireland**: current (since 2013) format is year-half + county code + a 1-6 digit serial
  (`261-D-12345`), confirmed as the suspected variable-length case, but also newly discovered
  to be a digit-letter-digit shape at its core.

Testing these three real shapes directly against `fixPlateChars` (not just reasoning about them)
found a real, serious bug: a Belgian plate like `1ABC345` came back as `IABC345`, and an Irish
short-serial plate like `131D1` came back as `131DI` - both **already-correct** readings
actively corrupted into wrong ones, not OCR errors left uncorrected. Root cause: both are
digit-letter-digit shapes the function was never designed for, but a lone digit sitting right
at the string's edge next to an otherwise-clean letter/digit run can "fit" the two-segment
letters-then-digits (or digits-then-letters) hypothesis at a cost of just one correction - the
same cost threshold that makes a genuine single-OCR-error fix (like Lithuania's `ABC12S` ->
`ABC125`) trustworthy in the first place.

The Irish case had a clean, zero-sacrifice fix: no digits-then-letters country this suite
covers (Spain, Estonia) ever needs a 2-letter suffix, so excluding that specific combination
(`lettersFirst=false` with `lettersLen<3`, in `fixPlateChars`) closes the Irish false positive
entirely, verified both directly (`'131D1'` and `'261D12345'` now correctly pass through
unchanged) and via the full 50,000-case fuzz run (still 0 failures).

The Belgian case (and, discovered by the same testing, the new Dutch format's `GBB01B` ->
`GBB018`) could **not** be fixed the same way - traced down to an honest dead end, not left
unexamined. Both collide with combinations this suite genuinely needs: Belgium's accepted
split (`lettersLen:4, digitsLen:3`, letters-then-digits) is the *exact same* combination
Slovenia's merged region+serial format uses, and the new Dutch format's accepted split
(`lettersLen:3, digitsLen:3`) is the *exact same* combination Lithuania, Sweden, Hungary,
Cyprus, and Malta all use. Tried several more targeted discriminators - run-internal vs.
run-edge position, counting how many "unambiguous" (non-confusable) characters anchor a run,
requiring extra corroborating neighbors - and each one, checked against both the bad case and
the legitimate cases it would also need to keep working, turned out to reject or accept the
*same* pattern both ways: a hypothetical Luxembourg plate with its district letter OCR'd as a
digit (`"0Y3456"` -> `"OY3456"`) has the exact same shape as Belgium's `1ABC345` bug, and a
genuine Lithuanian correction (`ABC12S` -> `ABC125`) has the exact same shape as the Dutch
`GBB01B` bug. These are not solvable from the bare character string alone without knowing which
country's plate it actually is - which this app, as a generic worldwide camera app with no
country setting, doesn't have.

Given that, and given Lithuania/Germany accuracy was this work's original, explicitly emphasized
ask, the responsible call was to keep that coverage rather than trade it away for Belgium/new-
Dutch plates this app was never asked to specifically support, and state the resulting tradeoff
plainly instead of either hiding it or pretending a clean fix exists: **a plate from an
unsupported country whose true shape happens to collide with one of the 15 supported shapes, and
whose confusable character happens to sit exactly at the segment boundary, can still be
mis-corrected.** This is the same category of honest limitation as the Greek O/0 "genuinely
ambiguous glyph" note earlier in this file - a real, bounded, documented tradeoff, not a bug
left unfixed through oversight.

Validated via the same `plate-formats.test.js` suite, now at 50,100 checks (0 failed) -
11 new example cases, 2 new full-pipeline confusion tests, and 10+ new direct `fixPlateChars`
unit cases - plus a full re-run of the entire existing test suite (`fuzz-1000.test.js` through
`watchlist-match.test.js`, ~29M total checks) confirming zero regressions, since this round
changed no code in `index.html` - only added tests against logic already shipped and committed
in the prior round.

## Large-scale real-photo round: 322 real plates, facial expressions, and a real attempt at posture

Per request, a much bigger real-photo validation than any single round so far - real Tesseract,
real plate-ONNX model, real coco-ssd, real face-api.js + EdgeFace, all via pinned local npm
installs standing in for blocked CDNs (same methodology as every other real-photo round), driven
through Playwright + real Chromium, against the real unmodified app.

### Plates: 322 real photos across three continents, not 15

Earlier rounds validated the EU shape-correction work against 15 hand-picked EU photos. This
round used the **entire** `openalpr/benchmarks` EU set (108 photos) and Brazil set (114 photos -
the exact Mercosul family a false-positive fix this session was built around), plus a 100-photo
US subsample as an unrelated baseline, for a combined 322 real vehicles - a far larger, more
statistically meaningful sample than anything tested against this logic before.

| set | vehicle detected | OCR-isolated exact (ground-truth box) | live-pipeline exact |
|---|---|---|---|
| EU (108, full set) | 107/108 (99%) | **99/108 (91.7%)** | 2/108 |
| Brazil (114, full set) | 106/114 (93%) | **107/114 (93.9%)** | 1/114 |
| US (100, subsample) | 97/100 (97%) | 83/100 (83%) | 5/100 |

Two things worth drawing out:

- **OCR-isolation accuracy at scale (91.7% EU, 93.9% Brazil) is as strong or stronger than the
  small-sample estimates** from earlier rounds (the original 15-photo EU test measured 80%,
  `accuracy-benchmark/`'s synthetic set measured higher still) - this is real confirmation the
  plate-ONNX model's accuracy holds up at 7x the sample size, not an artifact of a lucky small
  sample.
- **Live-pipeline accuracy remains low across all three sets** (2/108, 1/114, 5/100) - this is
  the *same, already-documented* plate-localization gap from earlier rounds ("found the wrong
  thing with confidence" - a grille, bumper trim, or badge outscoring the real plate in a single
  static frame), now confirmed at 322-photo scale rather than 15. Nothing new here, but worth
  being explicit: the large sample didn't surface a different bottleneck - it's still
  localization, not OCR, and not anything from this session's EU-format work.

**Specifically checking whether the EU shape-correction / false-positive-fix work caused any
real regression at this scale**: it did not, but the test surfaced two genuine real-world
instances of the *already-documented* irreducible collision from the previous section. Checking
every missed ground-truth plate's **expected (correct) text** directly against `fixPlateChars`
(not just eyeballing the OCR output) found two real plates whose correct text the function would
alter if the OCR had read them perfectly:

- A US plate, `0SG719`, collides with the Lithuania/Sweden/Hungary/Cyprus/Malta `lettersLen:3,
  digitsLen:3` shape (`fixPlateChars('0SG719')` → `'OSG719'`).
- A Brazilian plate, `R820503`, collides with Denmark's `lettersLen:2, digitsLen:5` shape
  (`fixPlateChars('R820503')` → `'RB20503'`).

In **both actual photos**, this never mattered in practice: the real OCR engine had already
misread an unrelated character before `fixPlateChars` ever ran (`D` instead of `0`, `Z` instead
of `2` - neither in the confusion map, so `fixPlateChars` left the already-wrong reading
untouched, verified directly: `fixPlateChars('DSG719')` and `fixPlateChars('RBZ0503')` are both
no-ops). So out of 322 real photos, the predicted collision risk from the previous section's
honest write-up is real (2/322, 0.6%, confirmed against genuine plate text) but caused **zero**
actual exact-match regressions in this round - a reassuring, now-quantified data point for a
tradeoff that was previously only reasoned about, not measured against real photos.

### Facial expressions: a real, reproducible alignment-sensitivity finding

Re-examined `detectFaceDetails()`'s facial expression output (the closest real "body language"
signal with a genuinely working model in this sandbox - see below for why pose/posture itself
couldn't be tested this round) across all 6 real demo photos, plus a focused diagnostic
(`diag-expr.js`, not checked in) comparing three ways of invoking face-api.js's expression net on
the *identical* canvas:

1. The real shipped path - `detectSingleFace().withFaceLandmarks().withFaceDescriptor().withFaceExpressions()` (one chained call), thresholded to `null` below 0.5 confidence.
2. The same chain's raw `.expressions` distribution before thresholding.
3. A bare `.detectSingleFace().withFaceExpressions()` call with nothing else chained.

| photo | shipped result | chained top (1&2) | bare top (3) | same label? |
|---|---|---|---|---|
| sample1.jpg | sad | sad (0.734) | sad (0.779) | yes |
| sample2.jpg | sad | sad (0.988) | sad (0.813) | yes |
| sample3.jpg | neutral | neutral (0.893) | **happy (0.877)** | **no** |
| sample4.jpg | *(null - below threshold)* | sad (0.353) | neutral (0.789) | no |
| sample5.jpg | happy | happy (0.999) | happy (0.919) | yes |
| sample6.jpg | neutral | neutral (1.0) | neutral (0.965) | yes |

Both modes are individually deterministic (re-running either one 3x on the same canvas gives
identical output), but they genuinely **disagree on which emotion is dominant** for 2 of 6 real
photos - not just a confidence difference. Root cause: face-api.js's expression net gets a
better-aligned face crop when real facial landmarks are already available earlier in the same
call chain (which the shipped code does) versus a crop based only on the raw detection box (the
bare call) - this is face-api.js's own intended behavior, landmarks improve alignment quality,
not a bug in this app's code. Two things this confirms, both good news: the shipped code already
uses the better-aligned (chained) path, and the existing `>=0.5` confidence threshold is doing
real, useful work on real photos - `sample4.jpg`'s chained read was a near 3-way tie (0.353/
0.329/0.318) and correctly came back as "don't know" rather than confidently reporting "sad" on
what the uncertainty actually shows is an ambiguous expression.

### Posture / body-language (MoveNet): confirmed still blocked, not silently skipped

An earlier round found `tfhub.dev` (MoveNet's weight-hosting domain) unreachable via `curl` and
abandoned that sub-test. This round tried again, two ways, specifically to give this an honest
answer rather than assume the earlier finding still holds: (1) `curl` against `tfhub.dev` and
several plausible `storage.googleapis.com` mirror paths - all blocked or 403/404; (2) letting the
real, unmocked app attempt its own real `loadPoseModel` path (`$('#posture').checked=true` then
calling the real `models()` function) inside an actual Chromium page, not a Node-side guess at a
URL. The real browser fetch failed with `net::ERR_TUNNEL_CONNECTION_FAILED` against
`tfhub.dev` - the same network-policy block, now confirmed from inside the real app's own loader,
not just from `curl`. Posture/body-language (fall detection, sustained-lying-down alerts) remains
covered by `posture-classify.test.js` and `fuzz-face-align.test.js`-style synthetic/fuzz testing
only - genuinely untestable against real human photos in this sandbox until it runs somewhere
with a less restrictive network policy. Stated plainly rather than silently dropped from this
round's scope.

No code changes this round - the shape-correction/false-positive work from the previous two
rounds held up clean at 322-photo scale, and the expression/posture findings are both either
already-correct-behavior confirmations or an environment limitation, not app bugs.
