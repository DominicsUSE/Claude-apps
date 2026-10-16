import type { Caption } from "@remotion/captions";

// Shared between the pipeline (which builds a Spec from data) and the video (which draws it).

export type Format = { prefix?: string; suffix?: string; decimals?: number };
export type Line = { label: string; points: [number, number][] };
export type Bar = { label: string; value: number; highlight?: boolean };
export type XKind = "year" | "age" | "years";

export type Chart =
  | { kind: "line"; lines: Line[]; x: XKind; format: Format }
  | { kind: "bars"; bars: Bar[]; format: Format };

export type Spec = {
  id: string;
  series: string;
  /** Big cover text. Parts wrapped in *asterisks* are drawn in the highlight color. */
  headline: string;
  sub: string;
  source: string;
  /** Shown on screen under the chart, e.g. "Hypothetical 7% yearly return, not a prediction." */
  disclaimer?: string;
  /** Handwritten note beside the marker circle drawn on the first line's end (or the highlighted bar). */
  annotation?: string;
  chart: Chart;
  /** The only numbers a script may use. */
  facts: Record<string, number>;
  /** Context for the script writer (what each fact means, data caveats). */
  notes: string[];
};

export type ShortProps = {
  spec: Spec;
  captions: Caption[];
  /** File name inside public/voice, or null for a silent video. */
  audio: string | null;
  /** File name inside public/music, or null. */
  music: string | null;
  durationInFrames: number;
};

export const fmt = (v: number, f: Format = {}) =>
  (v < 0 ? "-" : "") +
  (f.prefix ?? "") +
  Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: f.decimals ?? 0,
    maximumFractionDigits: f.decimals ?? 0,
  }) +
  (f.suffix ?? "");

/** Compact form for axis labels and headlines: 787444 -> 787K, 1250000 -> 1.3M. */
export const short = (v: number, f: Format = {}) => {
  const a = Math.abs(v);
  if (a >= 1e6) {
    const m = Math.round(a / 1e5) / 10;
    return fmt(v / 1e6, { ...f, decimals: m >= 10 || Number.isInteger(m) ? 0 : 1, suffix: "M" + (f.suffix ?? "") });
  }
  if (a >= 1e4) return fmt(v / 1e3, { ...f, decimals: 0, suffix: "K" + (f.suffix ?? "") });
  return fmt(v, f);
};
