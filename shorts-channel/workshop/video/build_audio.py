"""Short 01 audio: Kokoro voices (line by line, directed), procedural SFX, room tone, mix.

Outputs (in OUT): voice_<char>.wav stems, sfx.wav, mix.wav, timeline.json
Usage: python build_audio.py <models_dir> <out_dir>
"""
import json, subprocess, sys, os
import numpy as np, soundfile as sf
from scipy.signal import butter, sosfilt
from kokoro_onnx import Kokoro

MODELS, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
SR = 24000
FPS = 12  # animation runs on twos at 24fps -> 12 drawings per second
rng = np.random.default_rng(7)
k = Kokoro(f"{MODELS}/kokoro-v1.0.onnx", f"{MODELS}/voices-v1.0.bin")

def blend(*parts):
    return sum(w * k.get_voice_style(v) for v, w in parts)

# Voice casting: blends so no character is a stock preset. Pitch in semitones via rubberband (formant-preserving).
CAST = {
    "DEB":    dict(style=blend(("af_sarah", .6), ("af_bella", .4)),   pitch=+0.5, gain_db=0),
    "MARCUS": dict(style=blend(("am_puck", .65), ("am_liam", .35)),   pitch=0.0,  gain_db=-0.5),
    "PRIYA":  dict(style=blend(("af_nicole", .6), ("af_river", .4)),  pitch=-1.0, gain_db=+1.0),
    "GORD":   dict(style=blend(("bm_george", .75), ("bm_lewis", .25)), pitch=-1.5, gain_db=0),
    "WENDY":  dict(style=blend(("af_kore", .6), ("af_heart", .4)),    pitch=+0.3, gain_db=-0.5),
}

# Directed cues. Each chunk: (text, speed, gap_after_s). Chunks are generated separately so
# pauses are set by the edit, not by the model. 'trim' cuts the tail (for interruptions).
CUES = [
    dict(id="L01", char="DEB", at=0.30, intent="reverent, holding back tears; slows on 'eleven years'",
         chunks=[("Barry's been with us,", .92, .38), ("eleven years.", .86, 0)],
         caption="Barry's been with us eleven years."),
    dict(id="L02", char="DEB", at=None, after=1.8, intent="dictating a post out loud, clipped and officious; drop on 'Just saying'",
         chunks=[("Okay, so.", 1.18, .16), ("Road crew is coming Thursday.", 1.18, .06), ("Comma.", 1.2, .05),
                 ("To fill Barry.", 1.15, .10), ("Caps.", 1.2, .34), ("Just saying.", 1.05, 0)],
         caption="Okay so. Road crew is coming THURSDAY, comma, to FILL Barry. Caps. Just saying."),
    dict(id="L03", char="MARCUS", at=None, after=0.55, intent="pitching, too confident; speeds up through the list",
         chunks=[("Respectfully,", 1.04, .12), ("Barry is a brand.", 1.06, .16),
                 ("We're doing hoodies, a candle line, a podcast,", 1.16, 0)], trim=0.22,
         caption="Respectfully, Barry is a brand. We're doing hoodies, a candle line, a podcast--"),
    dict(id="L04", char="PRIYA", at=None, after=-0.30, intent="flat, not looking up; cuts Marcus off",
         chunks=[("It's a hole.", .9, 0)], caption="it's a hole."),
    dict(id="L05", char="WENDY", at=None, after=0.70, intent="press-conference bright, smiling through it",
         chunks=[("Pleased to announce,", 1.0, .12), ("Barry is now a protected heritage site.", 1.0, 0)],
         caption="Pleased to announce: Barry is now a protected heritage site."),
    dict(id="L06", char="GORD", at=None, after=1.0, intent="slow, stubborn, a little wistful; dead stop before the last line",
         chunks=[("In nineteen eighty-seven, they filled the quarry.", .92, .62), ("Never the same.", .86, .42),
                 ("Gord's not moving.", .9, 0)],
         caption="In 1987 they filled the quarry. ... Never the same. Gord's not moving."),
    dict(id="L07", char="DEB", at=None, after=5.4, intent="pure grief, shouted once", chunks=[("Barry!", 1.0, 0)],
         caption="BARRY!", gain_db=+2),
    dict(id="L08", char="PRIYA", at=None, after=0.95, intent="genuinely puzzled, quiet; the pause is the joke",
         chunks=[("You can just...", .90, .40), ("drive on it now.", .90, 0)], caption="you can just... drive on it now."),
]

CAPFIX = {"Road crew is coming Thursday.": "Road crew is coming THURSDAY.", "To fill Barry.": "to FILL Barry.",
          "In nineteen eighty-seven, they filled the quarry.": "In 1987 they filled the quarry.",
          "Barry!": "BARRY!", "It's a hole.": "it's a hole.", "You can just...": "you can just...",
          "We're doing hoodies, a candle line, a podcast,": "We're doing hoodies, a candle line, a podcast--"}

def shift(x, semis):
    if abs(semis) < 0.01:
        return x
    sf.write(f"{OUT}/_in.wav", x, SR)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", f"{OUT}/_in.wav", "-af",
                    f"rubberband=pitch={2 ** (semis / 12):.5f}:formant=preserved", f"{OUT}/_out.wav"], check=True)
    y, _ = sf.read(f"{OUT}/_out.wav")
    return y

def trim_silence(x, thr=0.01):
    idx = np.where(np.abs(x) > thr)[0]
    if len(idx) == 0:
        return x
    a, b = max(idx[0] - int(.02 * SR), 0), min(idx[-1] + int(.06 * SR), len(x))
    return x[a:b]

def fade(x, fin=0.005, fout=0.02):
    n1, n2 = int(fin * SR), int(fout * SR)
    x = x.copy(); x[:n1] *= np.linspace(0, 1, n1); x[-n2:] *= np.linspace(1, 0, n2)
    return x

def render_cue(c):
    cast = CAST[c["char"]]
    parts, marks, pos = [], [], 0
    for text, speed, gap in c["chunks"]:
        s, _ = k.create(text, voice=cast["style"], speed=speed, lang="en-us")
        s = fade(trim_silence(s))
        marks.append((pos / SR, (pos + len(s)) / SR, text))
        parts += [s, np.zeros(int(gap * SR))]
        pos += len(s) + int(gap * SR)
    x = np.concatenate(parts)
    c["_marks"] = marks
    if c.get("trim"):
        x = fade(x[: len(x) - int(c["trim"] * SR)], fout=0.04)
    x = shift(x, cast["pitch"])
    return x * 10 ** ((cast["gain_db"] + c.get("gain_db", 0)) / 20)

rendered, timeline, t_end = [], [], 0.0
for c in CUES:
    x = render_cue(c)
    start = c["at"] if c["at"] is not None else t_end + c["after"]
    t_end = start + len(x) / SR
    rendered.append((c, x, start))
    timeline.append(dict(id=c["id"], char=c["char"], start=round(start, 3), end=round(t_end, 3),
                         caption=c["caption"], intent=c["intent"],
                         chunks=[dict(start=round(start + a, 3), end=round(start + b, 3), text=CAPFIX.get(t, t))
                                 for a, b, t in c["_marks"]]))
    print(c["id"], c["char"], round(start, 2), "->", round(t_end, 2))
DUR = round(t_end + 1.9 + 3.3, 2)  # silence after Priya, then Lenny's tag
N = int(DUR * SR)
stems = {ch: np.zeros(N) for ch in CAST}
for c, x, start in rendered:
    i = int(start * SR)
    stems[c["char"]][i:i + len(x)] += x

# Interruption: duck Marcus 5 dB under Priya's line.
pri = next(t for t in timeline if t["id"] == "L04")
a, b = int(pri["start"] * SR), int(pri["end"] * SR)
stems["MARCUS"][a:b] *= 10 ** (-5 / 20)

# ---------- procedural SFX ----------
def bp(x, lo, hi, order=4):
    return sosfilt(butter(order, [lo, hi], btype="band", fs=SR, output="sos"), x)
def lp(x, f, order=4):
    return sosfilt(butter(order, f, btype="low", fs=SR, output="sos"), x)
def env(n, a=0.002, d=0.1):
    t = np.arange(n) / SR
    return np.minimum(t / a, 1) * np.exp(-t / d)
def noise(sec):
    return rng.standard_normal(int(sec * SR))
def tone(f, sec, amp=1.0):
    t = np.arange(int(sec * SR)) / SR
    return amp * np.sin(2 * np.pi * (f(t) if callable(f) else f) * t)

def stamp():
    n = int(.25 * SR); t = np.arange(n) / SR
    return (np.sin(2 * np.pi * 75 * t) * env(n, .001, .05) * .9 + lp(noise(.25), 900) * env(n, .001, .02) * .5)
def flick():
    c = bp(noise(.02), 2500, 8000) * env(int(.02 * SR), .0005, .004)
    w = bp(noise(.25), 200, 1200) * env(int(.25 * SR), .03, .08) * .35
    return np.concatenate([c, np.zeros(int(.12 * SR)), c, w])
def squeak():
    n = int(.14 * SR); t = np.arange(n) / SR
    f = 1900 + 900 * t / t[-1] + 60 * np.sin(2 * np.pi * 30 * t)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.sin(np.pi * t / t[-1]) * .25
def clap():
    return bp(noise(.06), 900, 3200) * env(int(.06 * SR), .001, .012) * .8
def organ(freqs, sec):
    n = int(sec * SR); t = np.arange(n) / SR
    x = sum(np.sin(2 * np.pi * f * t) + .4 * np.sin(4 * np.pi * f * t) + .2 * np.sin(6 * np.pi * f * t) for f in freqs)
    return x / len(freqs) * np.minimum(t / .02, 1) * np.minimum((sec - t) / .08, 1) * .22
def typing(sec):
    out = np.zeros(int(sec * SR)); i = 0
    while i < len(out) - 600:
        out[i:i + 400] += bp(noise(400 / SR), 2000, 6000) * env(400, .0003, .003) * .25
        i += int(rng.uniform(.06, .16) * SR)
    return out
def rumble(sec, f=110):
    n = int(sec * SR); t = np.arange(n) / SR
    return lp(noise(sec), f) * (0.6 + .4 * np.sin(2 * np.pi * 22 * t)) * .5
def beeps(k_, on=.35, off=.35, f=1000):
    return np.concatenate([np.concatenate([tone(f, on, .18) * np.minimum(np.arange(int(on * SR)) / 200, 1), np.zeros(int(off * SR))]) for _ in range(k_)])
def crickets(sec):
    out = np.zeros(int(sec * SR)); i = 0
    while i < len(out) - SR // 4:
        for j in range(3):
            s = i + j * int(.045 * SR)
            out[s:s + int(.03 * SR)] += tone(4600, .03, .05) * np.hanning(int(.03 * SR))
        i += int(rng.uniform(.35, .7) * SR)
    return out
def clang():
    n = int(.9 * SR)
    return sum(tone(f, .9, a) for f, a in ((2117, .5), (3371, .35), (5233, .2), (6810, .1))) * env(n, .001, .18) * .35
def chirp():
    n = int(.12 * SR); t = np.arange(n) / SR
    f = 3800 + 1500 * np.sin(np.pi * t / t[-1])
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.hanning(n) * .08
def jackhammer(sec):
    out = np.zeros(int(sec * SR)); step = int(SR / 24)
    for i in range(0, len(out) - step, step):
        out[i:i + step] += bp(noise(step / SR), 300, 2500) * env(step, .001, .012) * .7
    return out
def match():
    s = bp(noise(.18), 1500, 7000) * np.linspace(1, .2, int(.18 * SR)) * .35
    return np.concatenate([s, bp(noise(.35), 300, 1500) * env(int(.35 * SR), .02, .15) * .25])
def whoosh():
    n = int(.35 * SR)
    return bp(noise(.35), 500, 3000) * np.sin(np.pi * np.arange(n) / n) ** 2 * .07

sfx = np.zeros(N)
def put(x, t, db=0):
    i = int(t * SR); x = x[: N - i]
    sfx[i:i + len(x)] += x * 10 ** (db / 20)

T = {t["id"]: t for t in timeline}
SHOTS = {}  # shot start times, exported for the animation
SHOTS["s1_close"] = 0.0
put(flick(), 0.05, -6)
SHOTS["s2_wide"] = T["L01"]["end"] + 0.25
put(stamp(), SHOTS["s2_wide"] + 0.15, -1); put(squeak(), SHOTS["s2_wide"] + 0.6, -8)
SHOTS["s3_post"] = T["L02"]["start"] - 0.35
put(whoosh(), SHOTS["s3_post"] - 0.1); put(typing(T["L02"]["end"] - T["L02"]["start"]), T["L02"]["start"] + 0.1, -10)
SHOTS["s4_marcus"] = T["L03"]["start"] - 0.25
put(tone(2400, .08, .15), T["L03"]["start"] + 1.6, -6)  # card reader beep
SHOTS["s5_wendy"] = T["L05"]["start"] - 0.3
put(bp(noise(.05), 3000, 9000) * env(int(.05 * SR), .001, .01), T["L05"]["end"] + 0.05, -6)  # snip
for i, dt in enumerate((0.25, 0.33, 0.41, 0.95)):
    put(clap(), T["L05"]["end"] + dt, -4 if i < 3 else -2)
put(organ([262, 330, 392], .32), T["L05"]["end"] + 0.15, -4); put(organ([294, 370, 440], .45), T["L05"]["end"] + 0.5, -4)
SHOTS["s6_gord"] = T["L06"]["start"] - 0.5
put(rumble(T["L06"]["end"] - SHOTS["s6_gord"] + 2.6), SHOTS["s6_gord"], -12)
put(tone(410, .14, .2) + tone(520, .14, .2), T["L06"]["start"] + 3.1, -6)  # impatient horn tap
put(beeps(2), T["L06"]["end"] + 0.3, -10)
for dt in (0.6, 0.66, 0.74, 0.8, 0.9, 1.0):
    put(clap(), T["L06"]["end"] + 1.0 + dt * .5, -8)
SHOTS["s7_night"] = T["L06"]["end"] + 2.3
put(crickets(2.4), SHOTS["s7_night"], -2); put(rumble(1.8, 70), SHOTS["s7_night"] + 0.6, -10)
SHOTS["s8_morning"] = T["L07"]["start"] - 0.8
put(chirp(), SHOTS["s8_morning"] + 0.2); put(chirp(), SHOTS["s8_morning"] + 0.35)
put(clang(), T["L07"]["end"] + 0.15, -3); put(squeak(), T["L07"]["end"] + 0.9, -9)
SHOTS["s9_priya"] = T["L08"]["start"] - 0.45
put(chirp(), T["L08"]["end"] + 0.9, -2)
SHOTS["s10_lenny"] = T["L08"]["end"] + 1.9
put(jackhammer(1.3), SHOTS["s10_lenny"] + 0.4, -6); put(match(), SHOTS["s10_lenny"] + 2.4, -4)
SHOTS["end"] = DUR

# Room tone: quiet low-passed noise, a little louder outdoors in the day scenes, never digital silence.
room = lp(noise(DUR + .01)[:N], 400) * 10 ** (-46 / 20)
blower = bp(noise(DUR + .01)[:N], 350, 900) * (0.5 + .5 * np.sin(2 * np.pi * .3 * np.arange(N) / SR)) * 10 ** (-52 / 20)
day = np.ones(N); a, b = int(SHOTS["s7_night"] * SR), int(SHOTS["s8_morning"] * SR); day[a:b] = 0
c = int(SHOTS["s10_lenny"] * SR); day[c:] = 0

voices = sum(stems.values())
mix = voices + sfx + room + blower * day
for ch, x in stems.items():
    sf.write(f"{OUT}/voice_{ch}.wav", x, SR)
sf.write(f"{OUT}/sfx.wav", sfx, SR)
sf.write(f"{OUT}/premix.wav", mix / max(1, np.abs(mix).max() / .9), SR)

# Mouth states per animation frame from each character's stem: 0 shut, 1 half, 2 open.
mouths = {}
hop = SR // FPS
for ch, x in stems.items():
    rms = np.array([np.sqrt(np.mean(x[i:i + hop] ** 2)) for i in range(0, N, hop)])
    st = np.where(rms > .06, 2, np.where(rms > .015, 1, 0))
    st[1:][(st[1:] == 2) & (st[:-1] == 2)] = 1  # alternate wide/half so held vowels still flap
    mouths[ch] = st.tolist()

json.dump(dict(fps=FPS, duration=DUR, lines=timeline, shots=SHOTS, mouths=mouths), open(f"{OUT}/timeline.json", "w"), indent=1)

# Master: gentle EQ + light compression + de-ess, then loudness to about -14 LUFS, -1 dBTP.
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", f"{OUT}/premix.wav", "-af",
                "highpass=f=70,equalizer=f=250:t=q:w=1.2:g=-2,equalizer=f=3200:t=q:w=1.0:g=1.5,"
                "deesser=i=0.3,acompressor=threshold=-20dB:ratio=2.5:attack=8:release=120:makeup=2,"
                "loudnorm=I=-14:TP=-1.0:LRA=9", "-ar", "48000", f"{OUT}/mix.wav"], check=True)
print(json.dumps(SHOTS, indent=0))
