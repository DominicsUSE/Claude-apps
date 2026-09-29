// Optional backend for DinoCamSecurity's "Online AI" plate recognition mode.
//
// Why this exists at all: DinoCamSecurity's default and only fully-tested mode is 100%
// local (see ../index.html) — no server, no upload, nothing leaves the device. This
// server is ONLY needed if you deliberately turn on "Online AI" in the app's settings,
// for cases where local OCR isn't accurate enough (heavy motion blur, extreme angles,
// unusual fonts) and you're willing to send that one cropped plate image to a
// third-party recognition service to get a better read.
//
// What it does: holds your Plate Recognizer API key server-side (it is never sent to,
// or stored in, the browser) and forwards one cropped plate image at a time to
// https://api.platerecognizer.com/v1/plate-reader/, then normalizes the response into
// the same {status, value, confidence} shape the local pipeline uses, so the rest of
// the app treats an online read exactly like a local one.
//
// IMPORTANT — this file has NOT been run against a real Plate Recognizer account: I (the
// assistant that wrote this) have no API key and no hosting account in this environment,
// so I could not deploy it or send it a real image. The request shape below matches
// Plate Recognizer's published API as of this writing, but you should verify it against
// your own account before relying on it. See dinocam/server/README.md for setup steps
// and exactly what to check.
"use strict";

const express = require("express");
const multer = require("multer");

const PORT = process.env.PORT || 8787;
const API_KEY = process.env.PLATE_RECOGNIZER_API_KEY || "";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const PLATE_RECOGNIZER_URL = "https://api.platerecognizer.com/v1/plate-reader/";
const UPSTREAM_TIMEOUT_MS = 20000;

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, configured: Boolean(API_KEY) });
});

app.post("/api/recognize-plate", upload.single("image"), async (req, res) => {
  if (!API_KEY) {
    // Config error, not a user error — distinguish this from "no plate found" so the
    // app can show "AI service unavailable" / "API authentication failure" rather than
    // silently treating a misconfigured server as "unreadable".
    return res.status(500).json({ error: "config", message: "PLATE_RECOGNIZER_API_KEY is not set on this server." });
  }
  if (!req.file) {
    return res.status(400).json({ error: "bad_request", message: "No image was uploaded (expected multipart field 'image')." });
  }

  const form = new FormData();
  form.append("upload", new Blob([req.file.buffer], { type: req.file.mimetype || "image/jpeg" }), "plate.jpg");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let upstream;
  try {
    upstream = await fetch(PLATE_RECOGNIZER_URL, {
      method: "POST",
      headers: { Authorization: `Token ${API_KEY}` },
      body: form,
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      return res.status(504).json({ error: "timeout", message: "Plate Recognizer did not respond in time." });
    }
    return res.status(502).json({ error: "network", message: "Could not reach Plate Recognizer: " + err.message });
  } finally {
    clearTimeout(timeout);
  }

  if (upstream.status === 401 || upstream.status === 403) {
    return res.status(401).json({ error: "auth", message: "Plate Recognizer rejected the API key (check PLATE_RECOGNIZER_API_KEY)." });
  }
  if (upstream.status === 429) {
    return res.status(429).json({ error: "rate_limit", message: "Plate Recognizer rate limit reached — try again shortly." });
  }
  if (!upstream.ok) {
    let detail = "";
    try { detail = await upstream.text(); } catch (_) {}
    return res.status(502).json({ error: "upstream", message: `Plate Recognizer returned ${upstream.status}.`, detail: detail.slice(0, 500) });
  }

  let data;
  try { data = await upstream.json(); }
  catch (err) { return res.status(502).json({ error: "upstream", message: "Plate Recognizer returned an unreadable response." }); }

  res.json(normalize(data));
});

// Maps Plate Recognizer's response shape onto DinoCamSecurity's Confirmed / Candidate /
// Unreadable vocabulary. Plate Recognizer already does its own multi-character merging
// (unlike the bug this app's local pipeline had), so `plate` here is normally already
// the complete registered plate string, e.g. "a022ntc" — just needs uppercasing/spacing
// to match how the app displays plates.
function normalize(data) {
  const results = Array.isArray(data && data.results) ? data.results : [];
  if (!results.length) {
    return { status: "unreadable", value: null, confidence: 0, country: null, source: "plate-recognizer", raw: data };
  }
  const best = results.slice().sort((a, b) => (b.score || 0) - (a.score || 0))[0];
  const value = String(best.plate || "").toUpperCase();
  const confidence = Math.round((best.score || 0) * 100);
  const status = confidence >= 90 ? "confirmed" : confidence >= 50 ? "candidate" : "unreadable";
  const country = best.region && best.region.code ? String(best.region.code).toUpperCase() : null;
  return { status, value: value || null, confidence, country, source: "plate-recognizer", raw: data };
}

app.listen(PORT, () => {
  console.log(`DinoCamSecurity ANPR backend listening on :${PORT}`);
  console.log(API_KEY ? "PLATE_RECOGNIZER_API_KEY is set." : "WARNING: PLATE_RECOGNIZER_API_KEY is NOT set — /api/recognize-plate will return a config error until you set it.");
});
