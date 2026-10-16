import type { Caption } from "@remotion/captions";
import { useMemo } from "react";
import { AbsoluteFill, Sequence, useVideoConfig } from "remotion";

// Subtitle-style captions: a short phrase at a time, numbers picked out, no word-by-word karaoke.
const MAX_WORDS = 7;

function phrases(captions: Caption[]) {
  const out: Caption[][] = [];
  let cur: Caption[] = [];
  for (const c of captions) {
    cur.push(c);
    if (/[.,?!;:]$/.test(c.text) || cur.length >= MAX_WORDS) out.push(cur), (cur = []);
  }
  if (cur.length) out.push(cur);
  return out;
}

export const Captions: React.FC<{ captions: Caption[]; top: number; font: string; ink: string; number: string }> = ({ captions, top, font, ink, number }) => {
  const { fps } = useVideoConfig();
  const groups = useMemo(() => phrases(captions), [captions]);
  return (
    <AbsoluteFill>
      {groups.map((g, i) => {
        const from = Math.round((g[0].startMs / 1000) * fps);
        const until = Math.round(((groups[i + 1]?.[0].startMs ?? g.at(-1)!.endMs + 400) / 1000) * fps);
        if (until <= from) return null;
        return (
          <Sequence key={i} from={from} durationInFrames={until - from} layout="none">
            <div style={{ position: "absolute", top, left: 72, right: 150, textAlign: "center", fontFamily: font, fontWeight: 700, fontSize: 52, lineHeight: 1.22, letterSpacing: "-0.01em", color: ink }}>
              {g.map((c, j) => (
                <span key={j} style={{ color: /\d/.test(c.text) ? number : ink }}>
                  {(j ? " " : "") + c.text.trim()}
                </span>
              ))}
            </div>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
