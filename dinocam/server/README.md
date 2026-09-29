# DinoCamSecurity — optional online ANPR backend

This is **optional**. DinoCamSecurity's main app (`../index.html`) works fully without
it — camera, vehicle/face detection, and plate OCR all run locally in the browser with
no server and no API key. Only set this up if you turn on **Online AI** in the app's
Recognition Controls and want a second opinion for hard cases local OCR struggles with
(heavy blur, steep angle, unusual fonts, partial occlusion).

Two engines to pick from, set by `RECOGNITION_PROVIDER`:

- **`claude-vision`** (default) — sends the image to Claude and asks it to read the
  plate directly. Not a purpose-built ANPR model, but a vision LLM reasons about
  partially-obscured or stylized text rather than doing raw character-shape matching,
  which is often exactly what trips up traditional OCR. Needs your own
  `ANTHROPIC_API_KEY` (console.anthropic.com).
- **`plate-recognizer`** — a dedicated ANPR product (platerecognizer.com). Needs your
  own `PLATE_RECOGNIZER_API_KEY`.

Both return the same `{status, value, confidence, country, source}` shape, so the app
treats either one exactly like a local read.

## What was and wasn't verified before this shipped

- The server boots under both providers, and `/api/health`, `/api/recognize-plate`
  (missing-file, missing-key) error paths were tested directly for both.
- A request was sent from this server to each provider's real live API
  (`api.anthropic.com` and `api.platerecognizer.com`) with a deliberately invalid key,
  to confirm the request shape is accepted by that provider and the 401 it sends back
  is mapped correctly — for Claude vision specifically, this confirms the image is
  correctly base64-encoded, the structured-output schema is accepted, and the SDK's
  `AuthenticationError` is caught.
- **Not verified: an actual successful recognition, on either engine.** That needs a
  real API key for whichever provider you pick, which this environment doesn't have.
  Before you trust this in real use, send it one real image with your real key and
  check the `value`/`confidence` you get back make sense — this matters more for
  `claude-vision` than for a purpose-built ANPR product, since general vision-model
  accuracy on plates specifically hasn't been benchmarked here.

## Setup

1. Get an API key:
   - Claude vision (default): [console.anthropic.com](https://console.anthropic.com/)
     → Settings → API Keys.
   - Plate Recognizer: [platerecognizer.com](https://platerecognizer.com/) (free tier
     available) → Dashboard → API Key.
2. In this folder:
   ```
   npm install
   cp .env.example .env
   ```
   then edit `.env` — set `RECOGNITION_PROVIDER` (or leave it at the default
   `claude-vision`) and the matching API key.
3. Run it locally to test: `npm start` (defaults to port 8787). Check
   `http://localhost:8787/api/health` shows `"configured": true`.
4. Deploy it somewhere it'll stay running (Render, Railway, Fly.io, a small VPS, etc.).
   Any host that runs a Node 18+ process and lets you set environment variables works.
   Set the same variables from `.env` as real environment variables on that host.
5. In DinoCamSecurity's settings, set **AI Recognition** to "Online AI" or "Ask before
   sending", and enter your deployed backend's URL (e.g.
   `https://your-app.onrender.com`) in the field that appears.

## Why a backend at all, instead of calling the recognition API straight from the browser

An API key sent from client-side JavaScript is visible to anyone who opens the
browser's DevTools. This backend exists solely to keep that key server-side.

## Endpoint

`POST /api/recognize-plate` — multipart/form-data, field `image` (a JPEG/PNG). Returns:

```json
{ "status": "confirmed", "value": "A022 NTC", "confidence": 94, "country": "gb", "source": "claude-vision" }
```

`status` is one of `confirmed` / `candidate` / `unreadable`, using the same vocabulary
as the local recognition pipeline, so the app's UI treats an online read exactly like a
local one — including surfacing an error clearly (`config`, `auth`, `rate_limit`,
`timeout`, `network`, `upstream`) rather than silently doing nothing.
