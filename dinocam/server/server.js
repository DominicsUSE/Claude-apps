// Optional backend for DinoCamSecurity's "Online AI" plate recognition mode.
//
// Why this exists at all: DinoCamSecurity's default and only fully-tested mode is 100%
// local (see ../index.html) — no server, no upload, nothing leaves the device. This
// server is ONLY needed if you deliberately turn on "Online AI" in the app's settings,
// for cases where local OCR isn't accurate enough (heavy motion blur, extreme angles,
// unusual fonts, partial occlusion) and you're willing to send that one image to a
// third-party recognition service to get a better read.
//
// Two engines, chosen by RECOGNITION_PROVIDER:
//   - "claude-vision" (default): asks Claude to read the plate directly from the image.
//     A general vision model isn't purpose-built for plates the way Plate Recognizer is,
//     but it reasons about partially-obscured, angled, or stylized text rather than doing
//     raw character-shape matching, which is often exactly what a traditional OCR/ANPR
//     engine struggles with. Needs your own ANTHROPIC_API_KEY.
//   - "plate-recognizer": a dedicated ANPR product (api.platerecognizer.com). Needs your
//     own PLATE_RECOGNIZER_API_KEY.
// Both return the same {status, value, confidence, country, source} shape, so the app
// treats either one exactly like a local read, and the client (../index.html) never
// needs to know which engine answered.
//
// IMPORTANT — what has and hasn't been verified: this file was written and its request
// shapes checked against each provider's documented API, but I (the assistant that wrote
// this) have no API key for either service in this environment, so no real recognition
// has been confirmed end-to-end. The auth-error path for each provider WAS verified
// against that provider's real, live endpoint (a deliberately invalid key correctly
// produced that provider's real 401). See dinocam/server/README.md for the exact,
// current list of what's confirmed vs. still unverified — check it before relying on
// this in real use, and re-verify the primary "plate read correctly" path yourself with
// a real key and a real photo before trusting either engine.
"use strict";

const express = require("express");
const multer = require("multer");
const Anthropic = require("@anthropic-ai/sdk");
const { z } = require("zod");
const { zodOutputFormat } = require("@anthropic-ai/sdk/helpers/zod");

const PORT = process.env.PORT || 8787;
const PROVIDER = (process.env.RECOGNITION_PROVIDER || "claude-vision").trim();
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const CLAUDE_MODEL = process.env.CLAUDE_VISION_MODEL || "claude-opus-5-5";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const PLATE_RECOGNIZER_API_KEY = process.env.PLATE_RECOGNIZER_API_KEY || "";
const PLATE_RECOGNIZER_URL = "https://api.platerecognizer.com/v1/plate-reader/";
const UPSTREAM_TIMEOUT_MS = 25000;

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function configured() {
  if (PROVIDER === "claude-vision") return Boolean(ANTHROPIC_API_KEY);
  if (PROVIDER === "plate-recognizer") return Boolean(PLATE_RECOGNIZER_API_KEY);
  return false;
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, provider: PROVIDER, configured: configured() });
});

app.post("/api/recognize-plate", upload.single("image"), async (req, res) => {
  if (PROVIDER !== "claude-vision" && PROVIDER !== "plate-recognizer") {
    return res.status(500).json({ error: "config", message: `Unknown RECOGNITION_PROVIDER "${PROVIDER}" — set it to "claude-vision" or "plate-recognizer".` });
  }
  if (!configured()) {
    // Config error, not a user error — distinguish this from "no plate found" so the
    // app can show "AI service unavailable" / "API authentication failure" rather than
    // silently treating a misconfigured server as "unreadable".
    const missing = PROVIDER === "claude-vision" ? "ANTHROPIC_API_KEY" : "PLATE_RECOGNIZER_API_KEY";
    return res.status(500).json({ error: "config", message: `${missing} is not set on this server (provider: ${PROVIDER}).` });
  }
  if (!req.file) {
    return res.status(400).json({ error: "bad_request", message: "No image was uploaded (expected multipart field 'image')." });
  }

  try {
    const result = PROVIDER === "claude-vision"
      ? await recognizeWithClaudeVision(req.file.buffer, req.file.mimetype || "image/jpeg")
      : await recognizeWithPlateRecognizer(req.file.buffer, req.file.mimetype || "image/jpeg");
    res.json(result);
  } catch (err) {
    if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.code, message: err.message });
    console.error("Recognition error:", err);
    res.status(502).json({ error: "upstream", message: "Recognition failed: " + err.message });
  }
});

function engineError(httpStatus, code, message) {
  const err = new Error(message);
  err.httpStatus = httpStatus;
  err.code = code;
  return err;
}

/* ---------- Claude vision engine ---------- */
const PlateReadSchema = z.object({
  plate_visible: z.boolean().describe("True only if a vehicle license/number plate is actually visible in the image."),
  full_plate_text: z.string().nullable().describe(
    "The COMPLETE plate exactly as printed, preserving every character group and the spaces between them (e.g. 'A022 NTC', not 'A022' or 'NTC' alone). " +
    "Include letter-only and digit-only groups — do not omit a group just because it lacks a digit or a letter. " +
    "Uppercase letters and digits only, spaces between groups as they appear on the plate. Null if plate_visible is false or the text truly cannot be read."
  ),
  confidence: z.number().min(0).max(100).describe("0-100: how confident you are the full_plate_text is completely and correctly read."),
  country_or_region_guess: z.string().nullable().describe("Best guess at the issuing country/state/region from plate style, or null if unclear."),
});

async function recognizeWithClaudeVision(buffer, mimetype) {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const mediaType = ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mimetype) ? mimetype : "image/jpeg";

  let response;
  try {
    response = await client.messages.parse({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: buffer.toString("base64") } },
          { type: "text", text:
            "Read the vehicle license/number plate in this image. This may be any country's format: " +
            "one line or two, any number of character groups, any length, letters-only or digits-only groups " +
            "included. Report the COMPLETE plate as printed — every group, in order, separated by single spaces " +
            "— never just the first group or the group that happens to contain a digit. If the plate is genuinely " +
            "not legible (too blurry, too small, out of frame, or no plate visible at all), set plate_visible/" +
            "full_plate_text accordingly rather than guessing. Do not invent characters you cannot actually see." },
        ],
      }],
      output_config: { effort: "low", format: zodOutputFormat(PlateReadSchema) },
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw engineError(401, "auth", "Anthropic rejected the API key (check ANTHROPIC_API_KEY).");
    if (err instanceof Anthropic.RateLimitError) throw engineError(429, "rate_limit", "Anthropic rate limit reached — try again shortly.");
    if (err instanceof Anthropic.APIConnectionError) throw engineError(502, "network", "Could not reach the Anthropic API: " + err.message);
    if (err instanceof Anthropic.APIError) throw engineError(502, "upstream", `Anthropic API error (${err.status}): ${err.message}`);
    throw err;
  }

  const parsed = response.parsed_output;
  if (!parsed || !parsed.plate_visible || !parsed.full_plate_text) {
    return { status: "unreadable", value: null, confidence: 0, country: null, source: "claude-vision" };
  }
  const value = String(parsed.full_plate_text).toUpperCase().replace(/[^A-Z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  const confidence = Math.round(parsed.confidence);
  const status = confidence >= 85 ? "confirmed" : confidence >= 40 ? "candidate" : "unreadable";
  return { status: value ? status : "unreadable", value: value || null, confidence, country: parsed.country_or_region_guess || null, source: "claude-vision" };
}

/* ---------- Plate Recognizer engine ---------- */
async function recognizeWithPlateRecognizer(buffer, mimetype) {
  const form = new FormData();
  form.append("upload", new Blob([buffer], { type: mimetype }), "plate.jpg");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let upstream;
  try {
    upstream = await fetch(PLATE_RECOGNIZER_URL, {
      method: "POST",
      headers: { Authorization: `Token ${PLATE_RECOGNIZER_API_KEY}` },
      body: form,
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") throw engineError(504, "timeout", "Plate Recognizer did not respond in time.");
    throw engineError(502, "network", "Could not reach Plate Recognizer: " + err.message);
  } finally {
    clearTimeout(timeout);
  }

  if (upstream.status === 401 || upstream.status === 403) throw engineError(401, "auth", "Plate Recognizer rejected the API key (check PLATE_RECOGNIZER_API_KEY).");
  if (upstream.status === 429) throw engineError(429, "rate_limit", "Plate Recognizer rate limit reached — try again shortly.");
  if (!upstream.ok) {
    let detail = "";
    try { detail = await upstream.text(); } catch (_) {}
    throw engineError(502, "upstream", `Plate Recognizer returned ${upstream.status}. ${detail.slice(0, 300)}`);
  }

  let data;
  try { data = await upstream.json(); }
  catch (err) { throw engineError(502, "upstream", "Plate Recognizer returned an unreadable response."); }

  // Plate Recognizer already does its own multi-character merging (unlike the bug the
  // local pipeline had), so `plate` here is normally already the complete registered
  // plate string, e.g. "a022ntc" — just needs uppercasing to match how the app displays it.
  const results = Array.isArray(data && data.results) ? data.results : [];
  if (!results.length) return { status: "unreadable", value: null, confidence: 0, country: null, source: "plate-recognizer" };
  const best = results.slice().sort((a, b) => (b.score || 0) - (a.score || 0))[0];
  const value = String(best.plate || "").toUpperCase();
  const confidence = Math.round((best.score || 0) * 100);
  const status = confidence >= 90 ? "confirmed" : confidence >= 50 ? "candidate" : "unreadable";
  const country = best.region && best.region.code ? String(best.region.code).toUpperCase() : null;
  return { status: value ? status : "unreadable", value: value || null, confidence, country, source: "plate-recognizer" };
}

app.listen(PORT, () => {
  console.log(`DinoCamSecurity ANPR backend listening on :${PORT} (provider: ${PROVIDER})`);
  console.log(configured() ? "API key is set." : "WARNING: no API key set for the selected provider — /api/recognize-plate will return a config error until you set one.");
});
