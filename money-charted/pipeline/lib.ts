import type { Caption } from "@remotion/captions";

// Pure helpers with no file or network access, so they can be tested and bundled into the video.

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') (field += '"'), i++;
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ",") row.push(field), (field = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field), rows.push(row), (row = []), (field = "");
    } else field += c;
  }
  if (field || row.length) row.push(field), rows.push(row);
  return rows;
}

export const toCsv = (rows: string[][]) =>
  rows.map((r) => r.map((f) => (/[",\r\n]/.test(f) ? `"${f.replace(/"/g, '""')}"` : f)).join(",")).join("\r\n") + "\r\n";

/** "from=1970; series=A,B" -> { from: "1970", series: "A,B" } */
export function parseParams(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export const round = (v: number, decimals = 0) => Math.round(v * 10 ** decimals) / 10 ** decimals;

/** Balance after each month of saving `monthly` at a yearly rate, compounded monthly. Index 0 is the start. */
export function savingsPath(monthly: number, months: number, ratePct: number): number[] {
  const r = ratePct / 100 / 12;
  const out = [0];
  for (let i = 1; i <= months; i++) out.push(out[i - 1] * (1 + r) + monthly);
  return out;
}

export function monthsToGoal(monthly: number, goal: number, ratePct: number): number {
  const r = ratePct / 100 / 12;
  let bal = 0;
  for (let m = 1; m <= 1200; m++) if ((bal = bal * (1 + r) + monthly) >= goal) return m;
  throw new Error(`Saving ${monthly.toFixed(2)} a month never reaches ${goal} within 100 years`);
}

/** Pays down a balance month by month. `payment` gets the balance and this month's interest. */
export function payoff(balance: number, aprPct: number, payment: (balance: number, interest: number) => number) {
  const r = aprPct / 100 / 12;
  const path = [balance];
  let interest = 0;
  while (balance > 0.005) {
    const due = balance * r;
    const pay = Math.min(payment(balance, due), balance + due);
    if (pay <= due || path.length > 1200) throw new Error("This payment never pays the debt off");
    interest += due;
    balance = balance + due - pay;
    path.push(Math.max(balance, 0));
  }
  return { months: path.length - 1, interest, path };
}

const MULTIPLIERS: Record<string, number> = {
  k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, billion: 1e9, trillion: 1e12,
};
const NUMBER = /(?<![A-Za-z0-9.])(\$)?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(\s?(?:%|percent\b|[kKmMbB]\b|thousand\b|million\b|billion\b|trillion\b))?/g;

/**
 * Returns every number in `text` that is not one of `facts` (allowing the rounding the writer used)
 * and every year that is not in `years`. Small bare counts (0-12) are allowed.
 */
export function unverifiedNumbers(text: string, facts: number[], years: Set<number>): string[] {
  const bad: string[] = [];
  for (const [raw, dollar, digits, suffixRaw] of text.matchAll(NUMBER)) {
    const suffix = (suffixRaw ?? "").trim().toLowerCase();
    const plain = digits.replace(/,/g, "");
    const decimals = plain.includes(".") ? plain.split(".")[1].length : 0;
    const mult = MULTIPLIERS[suffix] ?? 1;
    const value = Number(plain) * mult;
    if (!dollar && !suffix && !decimals) {
      if (value >= 1900 && value <= 2100 && !digits.includes(",")) {
        if (!years.has(value)) bad.push(raw.trim());
        continue;
      }
      if (value <= 12) continue;
    }
    // "421,000" was rounded to thousands; "787K" to thousands; "19.2" to tenths.
    let unit = decimals ? 10 ** -decimals : 10 ** (mult === 1 ? plain.match(/0*$/)![0].length : 0);
    unit *= mult;
    const tolerance = Math.min(unit / 2, Math.abs(value) * 0.05) + 1e-9;
    if (!facts.some((f) => Math.abs(f - value) <= tolerance)) bad.push(raw.trim());
  }
  return bad;
}

/** Spreads words across [start, end] seconds in proportion to their length (for recordings without timestamps). */
export function spreadWords(text: string, start: number, end: number): Caption[] {
  const words = text.split(/\s+/).filter(Boolean);
  const weights = words.map((w) => w.length + 2);
  const total = weights.reduce((a, b) => a + b, 0);
  let t = start;
  return words.map((w, i) => {
    const d = ((end - start) * weights[i]) / total;
    const c = { text: (i ? " " : "") + w, startMs: t * 1000, endMs: (t + d) * 1000, timestampMs: (t + d / 2) * 1000, confidence: null };
    t += d;
    return c;
  });
}

/** Turns character timestamps (ElevenLabs alignment) into one caption per word. */
export function charsToCaptions(chars: string[], starts: number[], ends: number[]): Caption[] {
  const out: Caption[] = [];
  let word = "";
  let s = 0;
  let e = 0;
  const flush = () => {
    if (word) out.push({ text: (out.length ? " " : "") + word, startMs: s * 1000, endMs: e * 1000, timestampMs: (s + e) * 500, confidence: null });
    word = "";
  };
  chars.forEach((c, i) => {
    if (/\s/.test(c)) return flush();
    if (!word) s = starts[i];
    word += c;
    e = ends[i];
  });
  flush();
  return out;
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
