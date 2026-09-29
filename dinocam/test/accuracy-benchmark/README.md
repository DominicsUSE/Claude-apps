# Plate-reading accuracy benchmark

Real end-to-end test of `../../index.html`'s plate-reading pipeline (`scanPlateImage`,
unmodified) against synthetic European plates at three distances, using a genuine local
Tesseract.js@5.1.1 engine (the exact version the app pins) — not a mock. In a sandbox
whose network policy blocks `cdn.jsdelivr.net` (the app's normal OCR source), this fetches
the same library + trained data from npm instead and serves it from disk over a routed
request, so the app's real OCR code runs against something that actually tries to read the
pixels, not canned output.

## Setup and running it

```
npm install
npm run generate   # writes generated/*.jpg + generated/manifest.json
npm run test       # runs the real pipeline against them, writes generated/results.json
```

Needs network access to registry.npmjs.org (for `npm install`) but not jsdelivr.

## What this does and doesn't prove

- **Does**: exercise the real, unmodified `scanPlateImage()` → preprocessing →
  multi-pass-OCR → `aggregateVotes()` pipeline against images with known ground truth, at
  controlled distance/resolution/blur, and report exactly what it got right, wrong, and how
  confident it was.
- **Doesn't**: prove real-world accuracy on actual camera footage. The test plates are
  rendered text on a synthetic "car" shape (solid-color background/body, no real photo
  texture, glare, dirt, rain, or angle distortion), and vehicle detection is bypassed
  entirely (`scanPlateImage(canvas, bounds, exact=true)` is called with the known plate
  rectangle directly) — this isolates plate-reading accuracy from vehicle-detection
  accuracy, which is a separate, already-tested concern.

## Distance presets

Calibrated to real ANPR engineering guidance rather than arbitrary sizes: commercial plate
readers generally want ≥15–20px character height for a workable read, 25–40px+ for a
comfortable one.

| Preset | Plate height | Character height | Blur | Represents |
|---|---|---|---|---|
| close | 70px | ~42px | slight | a few meters away |
| mid | 34px | ~20px | mild | typical driveway/gate range |
| far | 17px | ~10px | more | at/beyond the practical limit for any OCR |

Three plate formats: UK (`AB12 CDE`), German (`M AB 1234`), French (`AB-123-CD`).

## Results (last run, `claude-sonnet-5`, this repo's `index.html` as of this benchmark's addition)

```
close : 3/3 read correctly, 3/3 confirmed (88-95% confidence)
mid   : 3/3 read correctly, 3/3 confirmed (90-94% confidence)
far   : 2/3 read correctly, 0/3 confirmed (0-45% confidence)
```

Close and mid range — which covers the large majority of real driveway/gate security
camera setups — read perfectly, every time, at high confidence across two separate runs.
At the far tier (~10px character height, deliberately near the physical limit of what any
OCR technology can recover), results varied run to run (1-2 of 3 exactly right depending on
the random jitter `gen-plates.js` applies to plate position) — but every far-tier result,
right or wrong, was correctly labeled low-confidence **candidate**, never falsely
**confirmed**. That instability itself is an honest, realistic finding: at this extreme,
small differences in exact pixel alignment tip individual characters between readable and
not, the same way real far-away footage is inherently borderline. The tri-state status
design (Confirmed / Candidate / Unreadable) is doing its job here — never silently wrong,
never overconfident, regardless of which characters it happens to get right on a given
frame.

### Two tuning attempts that did NOT make the cut

In pursuit of "read it perfectly in every situation," two changes to the far-tier
preprocessing were tried and measured, not just guessed at:

1. **Adaptive upscaling** (scale small crops up to a fixed minimum pixel height instead of
   a flat 2×/3× multiplier) — no measurable improvement. The bottleneck at this size isn't
   the multiplier; the fine detail was already lost to blur before the crop was ever taken,
   and upscaling a blurry small image just produces a bigger blurry image.
2. **More aggressive contrast** (`contrast(4)` vs. the shipped `contrast(1.4)`–`contrast(2.1)`)
   — this was actively **worse**: it turned the UK far-tier read from a correct 6%-confidence
   candidate into a *confidently wrong* 83%-confidence "confirmed" `AB12 CODE` (should be
   `AB12 CDE`). Over-sharpening blurry pixels invents plausible-looking character shapes
   from noise, and does so with **high** confidence — objectively more dangerous for a
   security app than the honest low-confidence miss it replaced, since a user is far less
   likely to double-check a "Confirmed" result.

Neither change shipped. The current settings in `../../index.html` are unchanged by this
benchmark — they already handle the tested range well, and both tuning attempts either did
nothing or made real-world reliability worse.

### What actually helps at the hard end

There's a real, physical floor here: a handful of real pixels of a blurry, distant plate
don't contain enough information for any local, general-purpose OCR to reliably recover,
however the preprocessing is tuned. For that end of the range, the app's existing "Online
AI" escalation path (`dinocam/server/`'s `claude-vision` engine — a full vision model
reasoning about a degraded image, rather than character-shape template matching) is the
better tool, by design: it's opt-in per-image, never runs in the continuous live loop, and
exists specifically for cases the local engine can't handle well. That's not tested here
(needs a real API key and reachable `api.anthropic.com`) — see `dinocam/server/README.md`
for what has and hasn't been verified there.
