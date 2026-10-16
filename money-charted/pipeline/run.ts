import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Caption } from "@remotion/captions";
import { bundle } from "@remotion/bundler";
import { parseMedia } from "@remotion/media-parser";
import { nodeReader } from "@remotion/media-parser/node";
import { RenderInternals, renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ShortProps, Spec } from "../video/spec";
import { charsToCaptions, parseCsv, spreadWords, toCsv, unverifiedNumbers } from "./lib";
import { buildSpec } from "./recipes";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const at = (...parts: string[]) => path.join(ROOT, ...parts);
try {
  process.loadEnvFile(at(".env"));
} catch {
  // .env is optional until the script step needs a key
}

const FPS = 30;
const COLUMNS = ["id", "series", "topic", "recipe", "params", "status", "publish_at", "hook", "script", "caption", "title", "title_options", "description", "hashtags", "video_url", "notes"];
type Row = Record<string, string>;

// ---------- queue.csv ----------

function readQueue(): Row[] {
  const [head, ...rows] = parseCsv(fs.readFileSync(at("queue.csv"), "utf8"));
  return rows.filter((r) => r.some((f) => f.trim())).map((r) => Object.fromEntries(COLUMNS.map((c) => [c, r[head.indexOf(c)] ?? ""])));
}

function writeQueue(rows: Row[]) {
  const tmp = at("queue.csv.tmp");
  fs.writeFileSync(tmp, "﻿" + toCsv([COLUMNS, ...rows.map((r) => COLUMNS.map((c) => r[c] ?? ""))]));
  try {
    fs.renameSync(tmp, at("queue.csv"));
  } catch (e) {
    throw new Error(`Could not save queue.csv (${(e as Error).message}). Close it in Excel or Sheets and run again.`);
  }
}

// ---------- step 1: data + script ----------

const ScriptOut = z.object({
  hook: z.string(),
  script: z.string(),
  caption: z.string(),
  titles: z.array(z.string()),
  description: z.string(),
  hashtags: z.array(z.string()),
});
type ScriptOut = z.infer<typeof ScriptOut>;

const loadSpec = (id: string): Spec => JSON.parse(fs.readFileSync(at("data", `${id}.json`), "utf8"));

function numberProblems(spec: Spec, texts: string[]): string[] {
  const years = new Set(Object.entries(spec.facts).filter(([k]) => k.includes("year")).map(([, v]) => v));
  if (spec.chart.kind === "line" && spec.chart.x === "year") {
    const xs = spec.chart.lines.flatMap((l) => l.points.map((p) => p[0]));
    for (let y = Math.min(...xs); y <= Math.max(...xs); y++) years.add(y);
  }
  return [...new Set(texts.flatMap((t) => unverifiedNumbers(t, Object.values(spec.facts), years)))];
}

let client: Anthropic | undefined;

async function writeScript(row: Row, spec: Spec): Promise<ScriptOut> {
  client ??= new Anthropic();
  const system = fs.readFileSync(at("prompts", "script.md"), "utf8");
  const input = { series: row.series, topic: row.topic, FACTS: spec.facts, NOTES: spec.notes, source: spec.source, disclaimer: spec.disclaimer ?? null };
  let feedback = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await client.beta.messages.parse({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: zodOutputFormat(ScriptOut) },
      system,
      messages: [{ role: "user", content: JSON.stringify(input, null, 2) + feedback }],
    });
    if (res.stop_reason === "refusal") throw new Error("Claude declined to write this script. Rephrase the topic.");
    const out = res.parsed_output;
    if (!out) throw new Error(`Claude returned no usable script (stop reason: ${res.stop_reason})`);
    const bad = numberProblems(spec, [out.hook, out.script, out.caption, out.description, ...out.titles]);
    if (!bad.length) return out;
    feedback = `\n\nA previous draft used numbers that are not in FACTS: ${bad.join(", ")}. Use only FACTS.`;
    if (attempt === 2) throw new Error(`Script still uses numbers not in the data: ${bad.join(", ")}`);
  }
  throw new Error("unreachable");
}

function description(spec: Spec, out: ScriptOut, hashtags: string) {
  return [
    out.description.trim(),
    "",
    spec.source.startsWith("Source") ? spec.source : `Source: ${spec.source}`,
    "Chart, script and analysis: Money, Charted.",
    "",
    `Educational content, not financial advice.${spec.disclaimer ? " " + spec.disclaimer : ""}`,
    "",
    hashtags,
  ].join("\n");
}

async function scriptStep(row: Row) {
  console.log(`  ${row.id}: fetching data (${row.recipe})`);
  const spec = await buildSpec(row);
  fs.mkdirSync(at("data"), { recursive: true });
  fs.writeFileSync(at("data", `${row.id}.json`), JSON.stringify(spec, null, 2));
  console.log(`  ${row.id}: writing script`);
  const out = await writeScript(row, spec);
  const tags = [...new Set([...out.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`).replace(/\s+/g, "")), "#moneycharted"])].slice(0, 5).join(" ");
  Object.assign(row, {
    hook: out.hook, script: out.script, caption: out.caption, title: out.titles[0] ?? "", title_options: out.titles.join(" | "),
    description: description(spec, out, tags), hashtags: tags, status: "Scripted", notes: "",
  });
}

// ---------- step 2: voice + render ----------

/** Evens out loudness to -14 LUFS, the level YouTube plays at, using the ffmpeg that ships with Remotion. */
async function polish(src: string, out: string) {
  await RenderInternals.callFf({
    bin: "ffmpeg",
    args: ["-y", "-i", src, "-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-ar", "48000", out],
    indent: false,
    logLevel: "error",
    binariesDirectory: null,
    cancelSignal: undefined,
  });
}

// Warm, unhurried narrator settings. Lower stability = more natural variation between takes.
const ELEVENLABS_DEFAULT_VOICE = "nPczCjzI2devNBz1zQrb"; // "Brian": deep, smooth American narrator
const VOICE_SETTINGS = { stability: 0.45, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true, speed: 0.97 };

async function voiceStep(row: Row): Promise<{ audio: string | null; captions: Caption[]; seconds: number }> {
  fs.mkdirSync(at("public", "voice"), { recursive: true });
  const recording = ["wav", "mp3", "m4a"].map((ext) => at("voice", `${row.id}.${ext}`)).find((f) => fs.existsSync(f));
  if (recording) {
    const audio = `${row.id}.wav`;
    await polish(recording, at("public", "voice", audio));
    const { durationInSeconds } = await parseMedia({ src: recording, reader: nodeReader, fields: { durationInSeconds: true } });
    const seconds = durationInSeconds ?? 40;
    console.log(`  ${row.id}: using your recording (${seconds.toFixed(1)}s)`);
    return { audio, captions: spreadWords(row.script, 0.15, seconds - 0.2), seconds };
  }
  if (process.env.ELEVENLABS_API_KEY) {
    console.log(`  ${row.id}: generating voice with ElevenLabs`);
    const voice = process.env.ELEVENLABS_VOICE_ID || ELEVENLABS_DEFAULT_VOICE;
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}/with-timestamps?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ text: row.script, model_id: "eleven_multilingual_v2", voice_settings: VOICE_SETTINGS }),
    });
    if (!res.ok) throw new Error(`ElevenLabs: HTTP ${res.status} ${await res.text()}`);
    const j = (await res.json()) as {
      audio_base64: string;
      alignment: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };
    };
    const raw = at("public", "voice", `${row.id}.raw.mp3`);
    fs.writeFileSync(raw, Buffer.from(j.audio_base64, "base64"));
    const audio = `${row.id}.wav`;
    await polish(raw, at("public", "voice", audio));
    fs.rmSync(raw);
    const a = j.alignment;
    return { audio, captions: charsToCaptions(a.characters, a.character_start_times_seconds, a.character_end_times_seconds), seconds: a.character_end_times_seconds.at(-1) ?? 40 };
  }
  const seconds = row.script.split(/\s+/).length / 2.6 + 0.6;
  console.log(`  ${row.id}: no recording or ElevenLabs key, rendering a silent preview with captions`);
  return { audio: null, captions: spreadWords(row.script, 0.4, seconds), seconds };
}

function uploadText(row: Row) {
  return [
    `TITLE\n${row.title}`,
    `OTHER TITLE IDEAS\n${row.title_options}`,
    `DESCRIPTION\n${row.description}`,
    `PINNED COMMENT\nData: ${loadSpec(row.id).source.replace(/^Source: /, "")}. What should I chart next?`,
    `SCHEDULE\n${row.publish_at || "not set"}`,
    "CHECK BEFORE PUBLISHING\n- Watched once at normal speed\n- Audience: not made for kids\n- Related video set (once you have long-form videos)",
  ].join("\n\n") + "\n";
}

async function renderStep(jobs: { row: Row; props: ShortProps }[]) {
  console.log("  bundling the video template");
  const serveUrl = await bundle({ entryPoint: at("video", "index.ts"), publicDir: at("public") });
  const browserExecutable = process.env.REMOTION_BROWSER || null;
  fs.mkdirSync(at("out"), { recursive: true });
  for (const { row, props } of jobs) {
    try {
      const inputProps = props as unknown as Record<string, unknown>;
      const short = await selectComposition({ serveUrl, id: "Short", inputProps, browserExecutable });
      console.log(`  ${row.id}: rendering ${(short.durationInFrames / FPS).toFixed(1)}s video`);
      await renderMedia({ composition: short, serveUrl, codec: "h264", outputLocation: at("out", `${row.id}.mp4`), inputProps, browserExecutable });
      await renderStill({ composition: short, serveUrl, output: at("out", `${row.id}-cover.png`), inputProps, frame: 0, browserExecutable });
      const thumb = await selectComposition({ serveUrl, id: "Thumb", inputProps, browserExecutable });
      await renderStill({ composition: thumb, serveUrl, output: at("out", `${row.id}-thumb.png`), inputProps, browserExecutable });
      fs.writeFileSync(at("out", `${row.id}-upload.txt`), uploadText(row));
      Object.assign(row, { status: "Rendered", notes: "" });
    } catch (e) {
      row.notes = `Render failed: ${(e as Error).message}`;
    }
  }
}

// ---------- main ----------

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const batch = Number(flag("batch") ?? 7);
  const only = flag("id");
  const rows = readQueue();
  const pick = (status: string) =>
    rows.filter((r) => r.status.trim().toLowerCase() === status.toLowerCase() && (!only || r.id === only)).slice(0, batch);

  const toScript = pick("Approved");
  if (toScript.length) console.log(`Step 1: data and scripts for ${toScript.length} approved row(s)`);
  for (const row of toScript) {
    try {
      await scriptStep(row);
    } catch (e) {
      row.notes = (e as Error).message;
    }
    writeQueue(rows);
  }

  const toRender = pick("Checked");
  if (toRender.length) console.log(`Step 2: voice and video for ${toRender.length} checked row(s)`);
  const jobs: { row: Row; props: ShortProps }[] = [];
  for (const row of toRender) {
    try {
      const spec = loadSpec(row.id);
      // The source line and disclaimer in the description come from the data, not from the writer.
      const written = row.description.replace(spec.source, "").replace(spec.disclaimer ?? "", "");
      const bad = numberProblems(spec, [row.hook, row.script, row.caption, row.title, written]);
      if (bad.length) throw new Error(`Numbers not in the data: ${bad.join(", ")}. Fix the text or the data, then run again.`);
      const { audio, captions, seconds } = await voiceStep(row);
      const music = fs.existsSync(at("public", "music", "bed.mp3")) ? "bed.mp3" : null;
      jobs.push({ row, props: { spec, captions, audio, music, durationInFrames: Math.max(Math.ceil((seconds + 1.5) * FPS), 10 * FPS) } });
    } catch (e) {
      row.notes = (e as Error).message;
    }
  }
  if (jobs.length) await renderStep(jobs);
  if (toRender.length) writeQueue(rows);

  if (!toScript.length && !toRender.length) console.log('Nothing to do. Set a row\'s status to "Approved" (to write it) or "Checked" (to render it).');
  for (const r of [...toScript, ...toRender]) console.log(`${r.id.padStart(3)}  ${r.status.padEnd(9)} ${r.notes ? "PROBLEM: " + r.notes : r.title || r.topic}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
