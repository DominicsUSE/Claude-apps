import { Composition } from "remotion";
import { spreadWords } from "../pipeline/lib";
import { RECIPES } from "../pipeline/recipes";
import { Short, Thumb } from "./Short";
import type { ShortProps, Spec } from "./spec";

// Studio preview uses a math recipe so it works offline. Real renders pass their own props.
const spec = { id: "preview", series: "Math of Money", ...(RECIPES["start-age"]({}) as Omit<Spec, "id" | "series">) };
const text = "Two people invest $300 a month. One starts at 25, the other at 35. At 65, the gap is $421,453.";
const preview: ShortProps = { spec, captions: spreadWords(text, 0.4, 8), audio: null, music: null, durationInFrames: 300 };

export const Root: React.FC = () => (
  <>
    <Composition
      id="Short"
      component={Short}
      width={1080}
      height={1920}
      fps={30}
      durationInFrames={300}
      defaultProps={preview}
      calculateMetadata={({ props }) => ({ durationInFrames: props.durationInFrames })}
    />
    <Composition id="Thumb" component={Thumb} width={1280} height={720} fps={30} durationInFrames={1} defaultProps={preview} />
  </>
);
