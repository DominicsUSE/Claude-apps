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
