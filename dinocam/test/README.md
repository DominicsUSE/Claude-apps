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
```

`face-match.test.js` covers the matching logic (faceDistance/matchKnownFace) with synthetic
descriptor vectors, not the face-api.js model itself — that needs a browser and a CDN this
sandbox's network policy blocks, so it's exercised by hand in a real browser instead.

Browser end-to-end tests (Playwright, mocked Tesseract/backend since this environment's
network policy blocks the real OCR CDN) live in the session's scratchpad rather than here,
since they need a Chromium binary path specific to the sandbox they were written in —
ask for them to be re-created if you need to re-run: A022/NTC merge through the real UI,
error paths (unreadable/corrupt file), settings/zone persistence, online-AI wiring with a
stubbed backend, multi-camera add/capture/remove, cross-camera track-ID collision, and
lock-region scoping (a primary-camera-only setting must never leak into an extra camera's
scan, a rescanned extra-camera capture, or an uploaded test image).

`accuracy-benchmark/` is a real (not mocked) plate-reading accuracy test against synthetic
European plates at three distances, using a genuine local Tesseract engine fetched via npm
instead of the blocked CDN. See `accuracy-benchmark/README.md` for setup and results.
