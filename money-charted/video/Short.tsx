import { loadFont } from "@remotion/fonts";
import { Audio } from "@remotion/media";
import { AbsoluteFill, Easing, interpolate, staticFile, useCurrentFrame } from "remotion";
import { Captions } from "./Captions";
import { short, type Chart as ChartSpec, type ShortProps, type XKind } from "./spec";

// House style: newsroom data graphics. One typeface (Libre Franklin, SIL OFL), one accent,
// black and two greys for everything else, hairline grids, direct labels, no effects.
const FONT = "Libre Franklin";
loadFont({ family: FONT, url: staticFile("fonts/LibreFranklin.woff2"), weight: "100 900" });

const C = {
  paper: "#FBFBF9",
  ink: "#121212",
  body: "#4A4A47",
  quiet: "#8C8C86",
  rule: "#E2E2DC",
  bar: "#C9C9C2",
  accent: "#0A7C4A",
};
const SERIES_INK = [C.accent, C.ink, C.quiet];
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const NUM = { fontVariantNumeric: "tabular-nums" } as const;

/** Headline with the parts in *asterisks* set in the accent color. */
const Headline: React.FC<{ text: string; size: number }> = ({ text, size }) => (
  <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: size, lineHeight: 1.04, letterSpacing: "-0.02em", color: C.ink, ...NUM }}>
    {text.split("*").map((part, i) => (
      <span key={i} style={{ color: i % 2 ? C.accent : C.ink }}>{part}</span>
    ))}
  </div>
);

/** The masthead: a short accent bar, the channel name, then the series. */
const Masthead: React.FC<{ series: string; size: number }> = ({ series, size }) => (
  <div style={{ display: "flex", alignItems: "center", gap: size * 0.6, fontFamily: FONT, fontSize: size, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>
    <div style={{ width: size * 2.4, height: size * 0.42, background: C.accent }} />
    <span style={{ color: C.ink }}>Money, Charted</span>
    <span style={{ color: C.quiet, fontWeight: 500 }}>{series}</span>
  </div>
);

const niceStep = (raw: number) => {
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * pow;
};
const xText = (x: number, kind: XKind) => (kind === "age" ? `Age ${x}` : kind === "years" ? `Year ${Math.round(x)}` : `${x}`);

type ChartProps = { chart: ChartSpec; width: number; height: number; progress: number; note?: string; noteIn: number; font: number };

export const Chart: React.FC<ChartProps> = ({ chart, width, height, progress, note: rawNote, noteIn, font }) => {
  const text = { fontFamily: FONT, ...NUM };
  const note = rawNote ? rawNote[0].toUpperCase() + rawNote.slice(1) : undefined;

  if (chart.kind === "bars") {
    const anyHighlight = chart.bars.some((b) => b.highlight);
    const top = note ? font * 1.6 : 0;
    const row = (height - top) / chart.bars.length;
    const f = Math.min(font, row / 2.2);
    const max = Math.max(...chart.bars.map((b) => b.value));
    const barH = Math.min(row * 0.38, f * 1.1);
    return (
      <svg width={width} height={height} style={text}>
        {note ? (
          <text x={0} y={f * 0.9} fill={C.accent} fontWeight={700} fontSize={f * 0.82} opacity={noteIn}>{note}</text>
        ) : null}
        {chart.bars.map((b, i) => {
          const p = interpolate(progress, [(i / chart.bars.length) * 0.5, (i / chart.bars.length) * 0.5 + 0.5], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
          const y = top + i * row;
          const w = Math.max((b.value / max) * width * 0.72, 4);
          const strong = !anyHighlight || b.highlight;
          return (
            <g key={b.label}>
              <text x={0} y={y + f * 0.9} fill={strong ? C.ink : C.body} fontWeight={strong ? 600 : 500} fontSize={f * 0.82}>{b.label}</text>
              <rect x={0} y={y + f * 1.25} width={w} height={barH} fill={C.rule} />
              <rect x={0} y={y + f * 1.25} width={w * p} height={barH} fill={strong ? C.accent : C.bar} />
              <text x={w * p + f * 0.4} y={y + f * 1.25 + barH / 2 + f * 0.34} fill={strong ? C.ink : C.body} fontWeight={700} fontSize={f * 0.92} opacity={p}>
                {short(b.value, chart.format)}
              </text>
            </g>
          );
        })}
      </svg>
    );
  }

  const all = chart.lines.flatMap((l) => l.points);
  const [xMin, xMax] = [Math.min(...all.map((p) => p[0])), Math.max(...all.map((p) => p[0]))];
  const yMaxRaw = Math.max(...all.map((p) => p[1]));
  const step = niceStep(yMaxRaw / 4);
  const yMax = Math.ceil(yMaxRaw / step) * step;
  const multi = chart.lines.length > 1;
  const pad = { right: font * (multi ? 5.4 : 4.2), top: font * 1.7, bottom: font * 1.5 };
  const plotW = width - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const sx = (x: number) => ((x - xMin) / (xMax - xMin || 1)) * plotW;
  const sy = (y: number) => pad.top + plotH - (y / yMax) * plotH;
  const cut = xMin + progress * (xMax - xMin);
  const valueAt = (pts: [number, number][], x: number) => {
    const j = pts.findIndex((p) => p[0] >= x);
    if (j <= 0) return pts[Math.max(j, 0)][1];
    const [a, b] = [pts[j - 1], pts[j]];
    return a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]);
  };
  const pathOf = (pts: [number, number][]) => pts.map((p, i) => `${i ? "L" : "M"}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(" ");
  const ticks = Array.from({ length: Math.round(yMax / step) + 1 }, (_, i) => i * step);
  const started = (pts: [number, number][]) => progress > 0 && cut >= pts[0][0];
  const lines = chart.lines.map((l, i) => {
    const endX = Math.min(cut, l.points.at(-1)![0]);
    const drawn: [number, number][] = [...l.points.filter((p) => p[0] <= cut), [endX, valueAt(l.points, endX)]];
    return { ...l, i, endX, drawn, value: drawn.at(-1)![1], on: started(l.points) };
  });
  // Direct labels at the line ends, nudged apart so they never overlap.
  const gap = font * (multi ? 2.0 : 1.2);
  let last = -Infinity;
  const labelY = new Map(
    lines.filter((l) => l.on).sort((a, b) => sy(a.value) - sy(b.value)).map((l) => [l.i, (last = Math.max(sy(l.value), last + gap))]),
  );
  const lead = lines[0];
  const nx = sx(lead.points.at(-1)![0]);
  const ny = sy(lead.points.at(-1)![1]);
  const noteAbove = ny - font * 2.6 > font;

  return (
    <svg width={width} height={height} style={text}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={0} x2={plotW} y1={sy(t)} y2={sy(t)} stroke={t === 0 ? C.ink : C.rule} strokeWidth={t === 0 ? 3 : 2} />
          {t > 0 ? <text x={0} y={sy(t) - font * 0.28} fill={C.quiet} fontWeight={500} fontSize={font * 0.68}>{short(t, chart.format)}</text> : null}
        </g>
      ))}
      {[xMin, xMax].map((x, i) => (
        <text key={x} x={sx(x)} y={height - font * 0.2} textAnchor={i ? "end" : "start"} fill={C.quiet} fontWeight={500} fontSize={font * 0.68}>{xText(x, chart.x)}</text>
      ))}
      {lines.map((l) => (
        <path key={`ghost-${l.label}`} d={pathOf(l.points)} fill="none" stroke={C.rule} strokeWidth={font * 0.16} strokeLinejoin="round" />
      ))}
      {[...lines].reverse().map((l) =>
        l.on ? (
          <g key={l.label}>
            <path d={pathOf(l.drawn)} fill="none" stroke={SERIES_INK[l.i % 3]} strokeWidth={font * (l.i ? 0.14 : 0.2)} strokeLinejoin="round" strokeLinecap="round" />
            <circle cx={sx(l.endX)} cy={sy(l.value)} r={font * 0.26} fill={SERIES_INK[l.i % 3]} stroke={C.paper} strokeWidth={font * 0.1} />
            <g transform={`translate(${sx(l.endX) + font * 0.55}, ${labelY.get(l.i)!})`}>
              {multi ? <text y={-font * 0.55} fill={C.body} fontWeight={500} fontSize={font * 0.62}>{l.label}</text> : null}
              <text y={font * 0.38} fill={SERIES_INK[l.i % 3]} fontWeight={800} fontSize={font * 0.95}>{short(l.value, chart.format)}</text>
            </g>
          </g>
        ) : null,
      )}
      {note && noteIn > 0 ? (
        <g opacity={noteIn}>
          <line x1={nx - font * 0.45} y1={noteAbove ? ny - font * 0.45 : ny + font * 0.45} x2={nx - font * 1.4} y2={noteAbove ? ny - font * 1.9 : ny + font * 1.9} stroke={C.ink} strokeWidth={2} />
          <text x={nx - font * 1.6} y={noteAbove ? ny - font * 2.0 : ny + font * 2.5} textAnchor="end" fill={C.ink} fontWeight={600} fontSize={font * 0.72}>{note}</text>
        </g>
      ) : null}
    </svg>
  );
};

export const Short: React.FC<ShortProps> = ({ spec, captions, audio, music, durationInFrames }) => {
  const frame = useCurrentFrame();
  const revealEnd = Math.max(60, Math.round(durationInFrames * 0.7));
  const progress = interpolate(frame, [10, revealEnd], [0, 1], { ...clamp, easing: Easing.bezier(0.45, 0, 0.25, 1) });
  const noteIn = interpolate(frame, [revealEnd + 6, revealEnd + 18], [0, 1], clamp);
  // 72px margins; text stays clear of the Shorts overlays (top 200px, bottom 480px, right 140px).
  return (
    <AbsoluteFill style={{ background: C.paper, fontFamily: FONT }}>
      <div style={{ position: "absolute", top: 204, left: 72, right: 140 }}>
        <Masthead series={spec.series} size={26} />
      </div>
      <div style={{ position: "absolute", top: 268, left: 72, right: 140 }}>
        <Headline text={spec.headline} size={92} />
        <div style={{ marginTop: 22, fontSize: 38, lineHeight: 1.25, color: C.body }}>{spec.sub}</div>
      </div>
      <div style={{ position: "absolute", top: 580, left: 72 }}>
        <Chart chart={spec.chart} width={868} height={610} progress={progress} note={spec.annotation} noteIn={noteIn} font={34} />
      </div>
      <Captions captions={captions} top={1222} font={FONT} ink={C.ink} number={C.accent} />
      <div style={{ position: "absolute", top: 1348, left: 72, right: 140, borderTop: `2px solid ${C.rule}`, paddingTop: 14, fontSize: 22, lineHeight: 1.4, color: C.quiet }}>
        {spec.disclaimer ? <div>{spec.disclaimer}</div> : null}
        <div>{spec.source}</div>
      </div>
      {audio ? <Audio src={staticFile(`voice/${audio}`)} /> : null}
      {music ? <Audio src={staticFile(`music/${music}`)} volume={0.12} loop /> : null}
    </AbsoluteFill>
  );
};

export const Thumb: React.FC<ShortProps> = ({ spec }) => (
  <AbsoluteFill style={{ background: C.paper, fontFamily: FONT, flexDirection: "row", alignItems: "center", padding: "0 56px", gap: 48 }}>
    <div style={{ width: 540, display: "flex", flexDirection: "column", gap: 22 }}>
      <Masthead series={spec.series} size={20} />
      <Headline text={spec.headline} size={74} />
      <div style={{ fontSize: 28, lineHeight: 1.25, color: C.body }}>{spec.sub}</div>
    </div>
    <Chart chart={spec.chart} width={580} height={520} progress={1} note={spec.annotation} noteIn={1} font={26} />
  </AbsoluteFill>
);
