import { loadFont } from "@remotion/fonts";
import { Audio } from "@remotion/media";
import { useMemo } from "react";
import { AbsoluteFill, Easing, interpolate, staticFile, useCurrentFrame } from "remotion";
import { Captions } from "./Captions";
import { short, type Chart as ChartSpec, type ShortProps, type XKind } from "./spec";

// Fonts ship in public/fonts (SIL Open Font License) so renders never depend on a font server.
const display = "Bricolage Grotesque";
const body = "Public Sans";
const mono = "IBM Plex Mono";
const hand = "Caveat";
loadFont({ family: display, url: staticFile("fonts/BricolageGrotesque-ExtraBold.woff2"), weight: "800" });
loadFont({ family: body, url: staticFile("fonts/PublicSans.woff2"), weight: "100 900" });
loadFont({ family: mono, url: staticFile("fonts/IBMPlexMono-Medium.woff2"), weight: "500" });
loadFont({ family: hand, url: staticFile("fonts/Caveat-SemiBold.woff2"), weight: "600" });

// Graph-paper ink with a highlighter. Each series has its own color, like segments of a show.
const C = { bg: "#0B0F0E", ink: "#E4ECE8", muted: "#98A9A2", grid: "rgba(228,236,232,0.08)", hl: "#F7D34A", paperInk: "#14211C", third: "#C8D3CE" };
const SERIES: Record<string, string> = {
  "Then vs Now": "#79B4F0",
  "Math of Money": "#45C890",
  "Paycheck vs": "#F0A66A",
  "World Rankings": "#C99BEA",
  "Myth vs Data": "#F28AA6",
};
const PAPER = { backgroundColor: C.bg, color: C.ink, fontFamily: body };

/** Layered backdrop: colored light behind the chart, fading graph paper, vignette and moving film grain. */
const Backdrop: React.FC<{ accent: string; frame: number }> = ({ accent, frame }) => (
  <>
    <AbsoluteFill style={{ background: `radial-gradient(ellipse 70% 45% at 50% 50%, ${accent}30 0%, transparent 70%)` }} />
    <AbsoluteFill
      style={{
        backgroundImage: `linear-gradient(${C.grid} 2px, transparent 2px), linear-gradient(90deg, ${C.grid} 2px, transparent 2px)`,
        backgroundSize: "60px 60px",
        maskImage: "radial-gradient(ellipse 75% 60% at 50% 45%, black 35%, transparent 85%)",
      }}
    />
    <AbsoluteFill style={{ background: "radial-gradient(ellipse at 50% 50%, transparent 55%, rgba(0,0,0,0.6) 100%)" }} />
    <AbsoluteFill
      style={{
        backgroundImage: `url(${staticFile("textures/grain.png")})`,
        backgroundPosition: `${(frame * 137) % 512}px ${(frame * 271) % 512}px`,
        opacity: 0.07,
        mixBlendMode: "overlay",
      }}
    />
  </>
);

/** Small seeded random source, so every video gets its own slightly different hand-drawn marks. */
function seeded(seed: string) {
  let a = [...seed].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Hand = { tilt: number; start: number; ph1: number; ph2: number; noteTilt: number; reveal: number };
const useHand = (id: string): Hand =>
  useMemo(() => {
    const r = seeded(id);
    return { tilt: -2.2 + r() * 2.6, start: r() * Math.PI * 2, ph1: r() * 6.28, ph2: r() * 6.28, noteTilt: -6 + r() * 5, reveal: 0.66 + r() * 0.08 };
  }, [id]);

/** A pen loop: a wobbly ellipse that runs past its start, like a circle drawn by hand. */
function penLoop(cx: number, cy: number, rx: number, ry: number, h: Hand) {
  const pts: string[] = [];
  for (let i = 0; i <= 48; i++) {
    const t = h.start + (i / 48) * Math.PI * 2 * 1.1;
    const wob = 1 + 0.05 * Math.sin(2 * t + h.ph1) + 0.03 * Math.sin(3 * t + h.ph2) + i * 0.0012;
    pts.push(`${i ? "L" : "M"}${(cx + Math.cos(t) * rx * wob).toFixed(1)},${(cy + Math.sin(t) * ry * wob).toFixed(1)}`);
  }
  return pts.join(" ");
}

const Mark: React.FC<{ cx: number; cy: number; rx: number; ry: number; note?: string; above?: boolean; font: number; width: number; height: number; progress: number; h: Hand }> = ({ cx, cy, rx, ry, note, above, font, width, height, progress, h }) => {
  if (progress <= 0) return null;
  const size = font * 1.3;
  const noteW = (note?.length ?? 0) * size * 0.42;
  const below = !above && cy + ry + size * 1.1 < height;
  const nx = Math.min(Math.max(cx, noteW / 2 + 4), width - noteW / 2 - 4);
  const ny = Math.max(below ? cy + ry + size * 0.95 : cy - ry - size * 0.35, size);
  return (
    <g>
      <path d={penLoop(cx, cy, rx, ry, h)} fill="none" stroke={C.hl} strokeWidth={font * 0.13} strokeLinecap="round" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - progress} />
      {note ? (
        <text x={nx} y={ny} textAnchor="middle" fill={C.hl} fontFamily={hand} fontWeight={600} fontSize={size} opacity={interpolate(progress, [0.6, 1], [0, 1], { extrapolateLeft: "clamp" })} transform={`rotate(${h.noteTilt} ${nx} ${ny})`}>
          {note}
        </text>
      ) : null}
    </g>
  );
};

const Headline: React.FC<{ text: string; size: number; tilt: number }> = ({ text, size, tilt }) => (
  <div style={{ fontFamily: display, fontWeight: 800, fontSize: size, lineHeight: 1.08, letterSpacing: -1 }}>
    {text.split("*").map((part, i) =>
      i % 2 ? (
        <span key={i} style={{ position: "relative", display: "inline-block", color: C.paperInk, padding: "0 0.1em" }}>
          <span style={{ position: "absolute", inset: "0.14em -0.03em 0.04em", background: C.hl, borderRadius: "0.2em 0.35em 0.25em 0.45em / 0.45em 0.25em 0.35em 0.2em", rotate: `${tilt}deg` }} />
          <span style={{ position: "relative" }}>{part}</span>
        </span>
      ) : (
        <span key={i}>{part}</span>
      ),
    )}
  </div>
);

const Defs: React.FC<{ accent: string; font: number }> = ({ accent, font }) => (
  <defs>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation={font * 0.3} result="blur" />
      <feMerge>
        <feMergeNode in="blur" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
    <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor={accent} stopOpacity={0.3} />
      <stop offset="1" stopColor={accent} stopOpacity={0} />
    </linearGradient>
  </defs>
);

const niceStep = (raw: number) => {
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * pow;
};
const xText = (x: number, kind: XKind) => (kind === "age" ? `Age ${x}` : kind === "years" ? `Year ${Math.round(x)}` : `${x}`);
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const textWidth = (s: string, size: number) => s.length * size * 0.6;

type ChartProps = { chart: ChartSpec; width: number; height: number; progress: number; mark: number; note?: string; accent: string; font: number; h: Hand };

export const Chart: React.FC<ChartProps> = ({ chart, width, height, progress, mark, note, accent, font, h }) => {
  const colors = [accent, C.hl, C.third];
  if (chart.kind === "bars") {
    const max = Math.max(...chart.bars.map((b) => b.value));
    // Room at the top for the handwritten note, which sits above the circled value.
    const head = font * 1.6;
    const row = (height - head) / chart.bars.length;
    const f = Math.min(font, row / 2.3);
    const barW = (v: number) => Math.max((v / max) * width * 0.74, 6);
    const target = Math.max(chart.bars.findIndex((b) => b.highlight), 0);
    const tb = chart.bars[target];
    const tLabel = short(tb.value, chart.format);
    const tTop = head + target * row + f * 1.15;
    const tH = row - f * 1.15 - row * 0.2;
    return (
      <svg width={width} height={height}>
        <Defs accent={accent} font={f} />
        {chart.bars.map((b, i) => {
          const p = interpolate(progress, [(i / chart.bars.length) * 0.5, (i / chart.bars.length) * 0.5 + 0.5], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
          const w = barW(b.value);
          const barTop = head + i * row + f * 1.15;
          const barH = row - f * 1.15 - row * 0.2;
          const color = b.highlight ? C.hl : accent;
          return (
            <g key={b.label}>
              <text x={0} y={head + i * row + f * 0.85} fill={b.highlight ? C.hl : C.muted} fontFamily={mono} fontSize={f * 0.8}>{b.label}</text>
              <rect x={0} y={barTop} width={w} height={barH} rx={6} fill={color} opacity={0.14} />
              <rect x={0} y={barTop} width={w * p} height={barH} rx={6} fill={color} filter="url(#glow)" />
              <text x={w * p + 14} y={barTop + barH / 2 + f * 0.35} fill={C.ink} fontFamily={display} fontWeight={800} fontSize={f} opacity={p}>
                {short(b.value, chart.format)}
              </text>
            </g>
          );
        })}
        <Mark
          cx={barW(tb.value) + 14 + textWidth(tLabel, f) / 2}
          cy={tTop + tH / 2}
          rx={textWidth(tLabel, f) / 2 + f * 0.7}
          ry={Math.max(tH, f) * 0.95}
          note={note}
          above
          font={f}
          width={width}
          height={height}
          progress={mark}
          h={h}
        />
      </svg>
    );
  }

  const all = chart.lines.flatMap((l) => l.points);
  const [xMin, xMax] = [Math.min(...all.map((p) => p[0])), Math.max(...all.map((p) => p[0]))];
  const yMaxRaw = Math.max(...all.map((p) => p[1]));
  const step = niceStep(yMaxRaw / 4);
  const yMax = Math.ceil(yMaxRaw / step) * step;
  const pad = { left: font * 3.1, right: font * 4.6, top: chart.lines.length > 1 ? font * 2.2 : font * 0.8, bottom: font * 1.8 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const sx = (x: number) => pad.left + ((x - xMin) / (xMax - xMin || 1)) * plotW;
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
  // A line shows its dot and value once the reveal reaches its first point (none on the cover frame).
  const started = (pts: [number, number][]) => progress > 0 && cut >= pts[0][0];
  const ends = chart.lines
    .map((l, i) => ({ i, l, y: valueAt(l.points, Math.min(cut, l.points.at(-1)![0])) }))
    .filter((e) => started(e.l.points))
    .sort((a, b) => sy(a.y) - sy(b.y));
  // End labels stay at least one line-height apart so two close lines remain readable.
  let lastY = -Infinity;
  const labelY = new Map(ends.map((e) => [e.i, (lastY = Math.max(sy(e.y), lastY + font * 1.15))]));
  const first = chart.lines[0];
  const firstLabel = short(first.points.at(-1)![1], chart.format);
  const firstEndX = sx(first.points.at(-1)![0]);

  return (
    <svg width={width} height={height}>
      <Defs accent={accent} font={font} />
      {ticks.map((t) => (
        <g key={t}>
          <line x1={pad.left} x2={pad.left + plotW} y1={sy(t)} y2={sy(t)} stroke={C.grid} strokeWidth={2} />
          <text x={pad.left - 14} y={sy(t) + font * 0.3} textAnchor="end" fill={C.muted} fontFamily={mono} fontSize={font * 0.72}>{short(t, chart.format)}</text>
        </g>
      ))}
      {[xMin, xMax].map((x, i) => (
        <text key={x} x={sx(x)} y={height - font * 0.3} textAnchor={i ? "end" : "start"} fill={C.muted} fontFamily={mono} fontSize={font * 0.72}>{xText(x, chart.x)}</text>
      ))}
      {chart.lines.length > 1 &&
        chart.lines.map((l, i) => (
          <g key={l.label} transform={`translate(${pad.left + i * (plotW / chart.lines.length)}, ${font * 0.9})`}>
            <rect width={font * 0.6} height={font * 0.6} y={-font * 0.5} rx={3} fill={colors[i % 3]} />
            <text x={font * 0.85} fill={C.ink} fontFamily={body} fontWeight={700} fontSize={font * 0.72}>{l.label}</text>
          </g>
        ))}
      {chart.lines.map((l, i) => {
        const color = colors[i % 3];
        const endX = Math.min(cut, l.points.at(-1)![0]);
        const drawn: [number, number][] = [...l.points.filter((p) => p[0] <= cut), [endX, valueAt(l.points, endX)]];
        return (
          <g key={l.label}>
            <path d={pathOf(l.points)} fill="none" stroke={color} strokeOpacity={0.18} strokeWidth={font * 0.2} strokeLinejoin="round" />
            {started(l.points) ? (
              <>
                {i === 0 ? <path d={`${pathOf(drawn)} L${sx(endX).toFixed(1)},${sy(0)} L${sx(drawn[0][0]).toFixed(1)},${sy(0)} Z`} fill="url(#fill)" /> : null}
                <path d={pathOf(drawn)} fill="none" stroke={color} strokeWidth={font * 0.22} strokeLinejoin="round" strokeLinecap="round" filter="url(#glow)" />
                <circle cx={sx(endX)} cy={sy(drawn.at(-1)![1])} r={font * 0.32} fill={color} />
                <text x={sx(endX) + font * 0.6} y={labelY.get(i)! + font * 0.35} fill={color} fontFamily={display} fontWeight={800} fontSize={font * 0.95}>
                  {short(drawn.at(-1)![1], chart.format)}
                </text>
              </>
            ) : null}
          </g>
        );
      })}
      <Mark
        cx={firstEndX + (font * 0.6 + textWidth(firstLabel, font * 0.95)) / 2}
        cy={(labelY.get(0) ?? sy(first.points.at(-1)![1])) + font * 0.05}
        rx={(font * 0.6 + textWidth(firstLabel, font * 0.95)) / 2 + font * 0.75}
        ry={font * 1.05}
        note={note}
        font={font}
        width={width}
        height={height}
        progress={mark}
        h={h}
      />
    </svg>
  );
};

export const Short: React.FC<ShortProps> = ({ spec, captions, audio, music, durationInFrames }) => {
  const frame = useCurrentFrame();
  const h = useHand(spec.id);
  const accent = SERIES[spec.series] ?? SERIES["Math of Money"];
  const revealEnd = Math.max(60, Math.round(durationInFrames * h.reveal));
  const progress = interpolate(frame, [12, revealEnd], [0, 1], { ...clamp, easing: Easing.bezier(0.33, 0, 0.2, 1) });
  const mark = interpolate(frame, [revealEnd + 8, revealEnd + 26], [0, 1], { ...clamp, easing: Easing.inOut(Easing.quad) });
  // Layout keeps text out of the Shorts overlays: top 200px, bottom 480px, right 150px.
  return (
    <AbsoluteFill style={PAPER}>
      <Backdrop accent={accent} frame={frame} />
      <div style={{ position: "absolute", top: 205, left: 72, right: 150, fontFamily: mono, fontSize: 30, letterSpacing: 3, textTransform: "uppercase", color: C.muted }}>
        Money, Charted · <span style={{ color: accent }}>{spec.series}</span>
      </div>
      <div style={{ position: "absolute", top: 262, left: 72, right: 150 }}>
        <Headline text={spec.headline} size={108} tilt={h.tilt} />
        <div style={{ marginTop: 18, fontSize: 40, color: C.muted }}>{spec.sub}</div>
      </div>
      <div style={{ position: "absolute", top: 640, left: 48, transformOrigin: "50% 50%", scale: interpolate(frame, [0, durationInFrames], [1, 1.04]) }}>
        <Chart chart={spec.chart} width={900} height={560} progress={progress} mark={mark} note={spec.annotation} accent={accent} font={34} h={h} />
      </div>
      <Captions captions={captions} top={1228} font={body} ink={C.ink} number={C.hl} />
      <div style={{ position: "absolute", top: 1370, left: 72, right: 150, fontFamily: mono, fontSize: 23, lineHeight: 1.35, color: C.muted }}>
        {spec.disclaimer ? <div>{spec.disclaimer}</div> : null}
        <div>{spec.source}</div>
      </div>
      {audio ? <Audio src={staticFile(`voice/${audio}`)} /> : null}
      {music ? <Audio src={staticFile(`music/${music}`)} volume={0.12} loop /> : null}
    </AbsoluteFill>
  );
};

export const Thumb: React.FC<ShortProps> = ({ spec }) => {
  const h = useHand(spec.id);
  const accent = SERIES[spec.series] ?? SERIES["Math of Money"];
  return (
    <AbsoluteFill style={{ ...PAPER, flexDirection: "row", alignItems: "center", padding: "0 48px", gap: 32 }}>
      <Backdrop accent={accent} frame={0} />
      <div style={{ position: "relative", width: 560, display: "flex", flexDirection: "column", gap: 20 }}>
        <div style={{ fontFamily: mono, fontSize: 24, letterSpacing: 3, textTransform: "uppercase", color: accent }}>{spec.series}</div>
        <Headline text={spec.headline} size={80} tilt={h.tilt} />
        <div style={{ fontSize: 30, color: C.muted }}>{spec.sub}</div>
        <div style={{ fontFamily: mono, fontSize: 22, color: C.muted, marginTop: 12 }}>MONEY, CHARTED</div>
      </div>
      <div style={{ position: "relative" }}>
        <Chart chart={spec.chart} width={600} height={560} progress={1} mark={1} note={spec.annotation} accent={accent} font={26} h={h} />
      </div>
    </AbsoluteFill>
  );
};
