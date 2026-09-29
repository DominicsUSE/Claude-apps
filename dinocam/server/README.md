# DinoCamSecurity — optional online ANPR backend

This is **optional**. DinoCamSecurity's main app (`../index.html`) works fully without
it — camera, vehicle/face detection, and plate OCR all run locally in the browser with
no server and no API key. Only set this up if you turn on **Online AI** in the app's
Recognition Controls and want a second opinion from a dedicated plate-recognition
service for hard cases local OCR struggles with (heavy blur, steep angle, unusual
fonts).

## What was and wasn't verified before this shipped

- The server boots, and its `/api/health`, `/api/recognize-plate` (missing-file,
  missing-key) error paths were tested directly.
- A request was sent from this server to the real
  `https://api.platerecognizer.com/v1/plate-reader/` with an invalid key, to confirm
  the request shape is accepted and the 401 response is mapped correctly.
- **Not verified: an actual successful recognition.** That needs a real Plate
  Recognizer account and API key, which this environment doesn't have. Before you
  trust this in real use, send it one real image with your real key and check the
  `value`/`confidence` you get back make sense.

## Setup

1. Get an API key from [platerecognizer.com](https://platerecognizer.com/) (they have
   a free tier with a monthly request quota).
2. In this folder:
   ```
   npm install
   cp .env.example .env
   ```
   then edit `.env` and set `PLATE_RECOGNIZER_API_KEY`.
3. Run it locally to test: `npm start` (defaults to port 8787). Check
   `http://localhost:8787/api/health` shows `"configured": true`.
4. Deploy it somewhere it'll stay running (Render, Railway, Fly.io, a small VPS, etc.).
   Any host that runs a Node 18+ process and lets you set environment variables works —
   there's nothing Vercel/Netlify-specific here. Set `PLATE_RECOGNIZER_API_KEY` (and
   optionally `ALLOWED_ORIGIN`) as environment variables on that host, the same way you
   set them in `.env` locally.
5. In DinoCamSecurity's settings, set **AI Recognition** to "Online AI" or "Ask before
   sending", and enter your deployed backend's URL (e.g.
   `https://your-app.onrender.com`) in the field that appears.

## Why a backend at all, instead of calling Plate Recognizer straight from the browser

Plate Recognizer's API key would be visible to anyone who opens the browser's DevTools
if the app called it directly client-side. This backend exists solely to keep that key
server-side, per the requirement that vehicle images and API credentials aren't handled
insecurely.

## Endpoint

`POST /api/recognize-plate` — multipart/form-data, field `image` (a JPEG/PNG of the
cropped plate region). Returns:

```json
{ "status": "confirmed", "value": "A022 NTC", "confidence": 94, "country": "gb", "source": "plate-recognizer" }
```

`status` is one of `confirmed` / `candidate` / `unreadable`, using the same vocabulary
as the local recognition pipeline, so the app's UI treats an online read exactly like a
local one — including surfacing an error clearly (`config`, `auth`, `rate_limit`,
`timeout`, `network`, `upstream`) rather than silently doing nothing.
