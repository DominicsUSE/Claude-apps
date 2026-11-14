// Voice options in the browser: which microphone, speaker and camera; how the
// microphone opens (voice activity with a sensitivity, or push to talk); the
// browser's noise suppression, echo cancellation and automatic gain; each
// person's volume and a mute only you hear; the soundboard; the little sounds
// for joining, leaving and muting; and screen share quality.
//
// Everything here is a preference on this device (S.prefs.voice), except the
// soundboard, whose rules live on the server (server/voiceopts.js).
//
// What the others hear goes through one WebAudio graph:
//
//   microphone -> gate (gain 0 or 1) -> mix -> the track every connection sends
//   soundboard -> its volume --------^
//
// The track sent never changes during a call, so switching microphones, or
// turning noise suppression off and on (which needs a new capture), never
// renegotiates anything. The gate closes while push to talk is up or while
// you are quieter than the sensitivity; the track itself is disabled whenever
// nothing should be heard (muted, or the gate shut with no sound playing), so
// nothing at all is sent. If WebAudio can't run here, the raw microphone is
// sent and the gate is the track's own on/off switch.
import { S, emit, toast } from './store.js';

export const VOICE_DEFAULTS = {
  input: '', output: '', camera: '',   // device ids; '' is the system default
  mode: 'vad',                         // 'vad' (voice activity) | 'ptt' (push to talk)
  autoSense: true, threshold: -50,     // manual sensitivity, in dBFS (-100 to 0)
  pttKey: 'Backquote', pttLabel: '`',  // KeyboardEvent.code, and how to show it
  pttDelay: 200,                       // ms the microphone stays open after letting go
  pttGlobal: true,                     // desktop app: the key works when Snug isn't in front
  noise: true, echo: true, agc: true,  // the browser's processing
  volumes: {}, muted: {},              // per person: 0..2, and a mute only I hear
  cues: true,                          // sounds when people join and leave
  muteCues: true,                      // sounds when I mute, unmute, deafen
  deafMutes: true,                     // deafening mutes me too
  afk: 0,                              // minutes alone in a voice room before leaving; 0 never
  screenRes: '1080', screenFps: 30, screenAudio: true,
  mini: null,                          // { x, y } where the floating call was left
  // --- voice and calls track ---
  camRes: '720', camFps: 24,           // camera quality: 360/720/1080, 15/24/30 frames a second
  mirror: true,                        // my own camera shown as in a mirror (only to me)
  inputGain: 1,                        // my microphone's volume, 0..2, before the gate
  outputVolume: 1,                     // everything I hear, 0..2
  ringtone: 'chime', ringVolume: 0.8,  // the ringtone (js/calls.js RINGTONES) and its volume 0..1
  ringOutput: '',                      // the device the ringtone plays on; '' is the system default
};
export const CAM_RES = { 360: { width: 640, height: 360 }, 720: { width: 1280, height: 720 }, 1080: { width: 1920, height: 1080 } };
export const CAM_FPS = [15, 24, 30];
// The camera's constraints from the quality settings, never above what was asked for.
export function cameraBase(base) {
  const v = vp();
  const res = CAM_RES[v.camRes] || CAM_RES[720];
  const fps = CAM_FPS.includes(v.camFps) ? v.camFps : 24;
  return {
    ...base,
    width: { min: Math.min(640, res.width), ideal: res.width, max: res.width },
    height: { min: Math.min(360, res.height), ideal: res.height, max: res.height },
    frameRate: { ideal: fps, max: fps },
  };
}
const clamp2 = (n, d = 1) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(2, n)) : d);
export const RESOLUTIONS = { 720: { width: 1280, height: 720 }, 1080: { width: 1920, height: 1080 }, source: null };
export const FRAME_RATES = [15, 30, 60];

export const vp = () => ({ ...VOICE_DEFAULTS, ...(S.prefs.voice || {}) });
export function setVoice(patch) {
  const before = vp();
  S.prefs.voice = { ...before, ...patch };
  // Saved now: during a call the screen changes often enough to keep delaying the usual save.
  try { localStorage.setItem('snug.prefs', JSON.stringify(S.prefs)); } catch { /* full or blocked */ }
  emit();
  const v = vp();
  if ('mode' in patch || 'threshold' in patch || 'autoSense' in patch) gate();
  if ('output' in patch && patch.output !== before.output) applyOutput();
  if ('volumes' in patch || 'muted' in patch || 'output' in patch || 'outputVolume' in patch) retune();
  if ('inputGain' in patch) applyInputGain();
  return v;
}

export const volumeOf = (user) => {
  const n = vp().volumes[user];
  return typeof n === 'number' && n >= 0 && n <= 2 ? n : 1;
};
// What I really play someone at: their volume times the master output volume (up to 400%, capped at 200%).
const playedAt = (user) => Math.min(2, volumeOf(user) * clamp2(vp().outputVolume));
export const mutedForMe = (user) => !!vp().muted[user];
export function setPersonVolume(user, n) {
  const volumes = { ...vp().volumes };
  const v = Math.max(0, Math.min(2, Math.round(n * 100) / 100));
  if (v === 1) delete volumes[user]; else volumes[user] = v;
  setVoice({ volumes });
}
export function setPersonMuted(user, on) {
  const muted = { ...vp().muted };
  if (on) muted[user] = true; else delete muted[user];
  setVoice({ muted });
}

// ---------- Capture ----------

export function micConstraints({ device = vp().input } = {}) {
  const v = vp();
  return { audio: { ...(device ? { deviceId: { exact: device } } : {}), echoCancellation: v.echo, noiseSuppression: v.noise, autoGainControl: v.agc } };
}
// The chosen microphone, or the default one if it has gone.
export async function getMic() {
  const v = vp();
  try {
    return await navigator.mediaDevices.getUserMedia(micConstraints());
  } catch (e) {
    if (!v.input || !['OverconstrainedError', 'NotFoundError'].includes(e?.name)) throw e;
    const s = await navigator.mediaDevices.getUserMedia(micConstraints({ device: '' }));
    toast('Your chosen microphone isn’t connected, so Snug is using the default one.');
    return s;
  }
}
export function cameraConstraints(base) {
  const id = vp().camera;
  return id ? { ...base, deviceId: { exact: id } } : base;
}
export function screenConstraints() {
  const v = vp();
  const res = RESOLUTIONS[v.screenRes] || null;
  const fps = FRAME_RATES.includes(v.screenFps) ? v.screenFps : 30;
  return {
    video: { frameRate: { ideal: fps, max: fps }, ...(res ? { width: { max: res.width }, height: { max: res.height } } : {}) },
    audio: !!v.screenAudio, // the system or tab sound, where the browser offers it
    systemAudio: v.screenAudio ? 'include' : 'exclude',
    surfaceSwitching: 'include',
  };
}
// A screen share's bitrate ceiling, from its quality: more pixels and frames need more.
export function screenBitrate(many) {
  const v = vp();
  const px = v.screenRes === '720' ? 1 : v.screenRes === '1080' ? 2 : 3;
  const fps = v.screenFps >= 60 ? 2 : v.screenFps >= 30 ? 1.3 : 1;
  return Math.round((many ? 600_000 : 1_200_000) * px * fps);
}

// The room's audio ceiling, in bits per second (server/voiceopts.js).
export const roomBitrate = () => {
  const r = S.call && S.rooms[S.call.room];
  return (r?.bitrate || 64) * 1000;
};

// ---------- The graph ----------

let ctx = null;
let g = null; // { src, gate, mix, out, track, analyser, raw, timer }
let playing = 0;
let pttDown = false;
let pttHeldBy = new Set(); // what is holding push to talk: 'key', 'button', 'global'
let releaseTimer = null;
let vadOpen = false;
let vadHold = 0;
let floor = -70;
export const meter = { level: -100, threshold: -50, open: false }; // for the settings page and the tests

export function audioCtx() {
  if (!ctx) {
    try { ctx = new AudioContext({ latencyHint: 'interactive' }); } catch { return null; }
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

async function running(c) {
  if (c.state === 'running') return true;
  await Promise.race([c.resume().catch(() => {}), new Promise((r) => setTimeout(r, 400))]);
  return c.state === 'running';
}

// The stream to send for this microphone. Resolves to the raw microphone if
// WebAudio can't run.
export async function outgoing(mic) {
  stopOutgoing();
  const c = audioCtx();
  let ok = false;
  try { ok = !!c && await running(c); } catch { ok = false; }
  if (!ok) {
    g = { raw: true, out: mic, track: mic.getAudioTracks()[0], timer: null, analyser: null, src: null };
  } else {
    const mix = c.createMediaStreamDestination();
    const gateNode = c.createGain();
    gateNode.gain.value = 0;
    gateNode.connect(mix);
    // My microphone's volume, before the gate (voice and calls track).
    const inGain = c.createGain();
    inGain.gain.value = clamp2(vp().inputGain);
    inGain.connect(gateNode);
    g = { raw: false, mix, gate: gateNode, inGain, out: mix.stream, track: mix.stream.getAudioTracks()[0], src: null, analyser: null, timer: null };
    attach(mic);
  }
  if (g.raw) { attachAnalyser(mic); vadOpen = true; }
  g.timer = setInterval(tick, 50);
  gate();
  return g.out;
}

function attachAnalyser(mic) {
  const c = audioCtx();
  if (!c || !g) return;
  try {
    g.levelSrc?.disconnect();
    g.levelSrc = c.createMediaStreamSource(mic);
    g.analyser = c.createAnalyser();
    g.analyser.fftSize = 1024;
    g.levelSrc.connect(g.analyser);
    g.buf = new Float32Array(g.analyser.fftSize);
  } catch { g.analyser = null; }
}

function attach(mic) {
  if (!g || g.raw) return;
  try { g.src?.disconnect(); } catch { /* already */ }
  g.src = ctx.createMediaStreamSource(mic);
  g.src.connect(g.inGain || g.gate);
  attachAnalyser(mic);
}

// A new microphone (another device, or new processing): swap it in under the
// same outgoing track. Returns the stream to send now (unchanged unless raw).
export function swapMic(mic) {
  if (!g) return null;
  if (g.raw) {
    g.out = mic;
    g.track = mic.getAudioTracks()[0];
    attachAnalyser(mic);
    gate();
    return mic;
  }
  attach(mic);
  gate();
  return g.out;
}

function applyInputGain() {
  if (g?.inGain) g.inGain.gain.value = clamp2(vp().inputGain);
}

export function stopOutgoing() {
  if (!g) return;
  clearInterval(g.timer);
  try { g.src?.disconnect(); g.levelSrc?.disconnect(); g.gate?.disconnect(); g.inGain?.disconnect(); } catch { /* gone */ }
  if (!g.raw) g.track?.stop();
  g = null;
  playing = 0;
  vadOpen = false;
  pttHeldBy = new Set();
  pttDown = false;
  clearTimeout(releaseTimer);
}

const dbOf = (buf) => {
  let sum = 0;
  for (const v of buf) sum += v * v;
  const rms = Math.sqrt(sum / buf.length);
  return rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
};

// Every 50 ms: how loud the microphone is, and whether voice activity opens the gate.
function tick() {
  if (!g) return;
  // Nothing to measure with (WebAudio isn't running here): voice activity stays open rather than silencing you.
  if (!g.analyser || ctx?.state !== 'running') { if (!vadOpen) { vadOpen = true; gate(); } return; }
  g.analyser.getFloatTimeDomainData(g.buf);
  const level = dbOf(g.buf);
  const v = vp();
  // Auto: follow the quietest level quickly and the louder ones slowly; speech sits well above.
  if (level < floor) floor = floor * 0.7 + level * 0.3; else floor += 0.08;
  const threshold = v.autoSense ? Math.min(-30, Math.max(-75, floor + 14)) : v.threshold;
  const loud = level > threshold;
  if (loud) vadHold = 8; else if (vadHold > 0) vadHold--; // 400 ms of hold between words
  const open = loud || vadHold > 0;
  meter.level = level; meter.threshold = threshold;
  if (open !== vadOpen) { vadOpen = open; gate(); }
}

// Is my microphone open to the others right now (ignoring mute)?
export function micOpen() {
  return vp().mode === 'ptt' ? pttDown : vadOpen;
}

// Apply the gate: mic gain and whether the sent track carries anything.
export function gate() {
  if (!g) return;
  const muted = !!S.call?.muted;
  const open = micOpen() && !muted;
  meter.open = open;
  if (!g.raw) {
    const t = ctx.currentTime;
    g.gate.gain.cancelScheduledValues(t);
    g.gate.gain.setTargetAtTime(open ? 1 : 0, t, 0.015);
    g.track.enabled = !muted && (open || playing > 0);
  } else if (g.track) {
    g.track.enabled = open;
  }
}

// ---------- Push to talk ----------

export function pttPress(by = 'key') {
  pttHeldBy.add(by);
  clearTimeout(releaseTimer);
  if (!pttDown) { pttDown = true; gate(); emit(); }
}
export function pttRelease(by = 'key', delay = vp().pttDelay) {
  pttHeldBy.delete(by);
  if (pttHeldBy.size) return;
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => { if (!pttHeldBy.size && pttDown) { pttDown = false; gate(); emit(); } }, Math.max(0, delay));
}
export const pttHeld = () => pttDown;

// ---------- What I hear ----------

// Each remote audio element: volume up to 100% on the element itself; above
// that, the element is silenced and WebAudio plays it louder. A mute only I
// hear, deafening and a moderator's mute all silence it.
const boosts = new Map(); // element -> { src, gain }
export function tuneAudio(user, el, heard) {
  if (!el) return;
  const vol = playedAt(user);
  const on = heard && !mutedForMe(user);
  el.volume = Math.min(1, vol);
  const boost = on && vol > 1 && el.srcObject;
  el.muted = !on || !!boost;
  const b = boosts.get(el);
  if (boost) {
    const c = audioCtx();
    if (c) {
      try {
        if (!b || b.stream !== el.srcObject) {
          b?.src.disconnect();
          const src = c.createMediaStreamSource(el.srcObject);
          const gain = c.createGain();
          src.connect(gain); gain.connect(c.destination);
          boosts.set(el, { src, gain, stream: el.srcObject });
        }
        boosts.get(el).gain.gain.value = vol;
      } catch { el.muted = !on; }
    } else el.muted = !on;
  } else if (b) {
    try { b.src.disconnect(); b.gain.disconnect(); } catch { /* gone */ }
    boosts.delete(el);
  }
  const out = vp().output;
  if (out && typeof el.setSinkId === 'function' && el.sinkId !== out) el.setSinkId(out).catch(() => {});
}
export const boostOf = (el) => boosts.get(el)?.gain.gain.value || 0;
export function forgetAudio(el) {
  const b = boosts.get(el);
  if (b) { try { b.src.disconnect(); b.gain.disconnect(); } catch { /* gone */ } boosts.delete(el); }
}

// voice.js registers how to re-apply every remote element (after a volume or device change).
let retuner = () => {};
export function onRetune(fn) { retuner = fn; }
export function retune() { retuner(); }

export const canPickSpeaker = () => typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
function applyOutput() {
  const out = vp().output;
  if (ctx && typeof ctx.setSinkId === 'function') ctx.setSinkId(out || '').catch(() => {});
}

// ---------- Little sounds, made with WebAudio ----------

const CUES = {
  join: [[523, 0], [784, 0.09]],
  leave: [[784, 0], [523, 0.09]],
  mute: [[440, 0], [330, 0.07]],
  unmute: [[330, 0], [440, 0.07]],
  deafen: [[392, 0], [294, 0.08], [220, 0.16]],
  undeafen: [[220, 0], [294, 0.08], [392, 0.16]],
};
export function cue(kind) {
  const v = vp();
  const isMute = ['mute', 'unmute', 'deafen', 'undeafen'].includes(kind);
  if (isMute ? !v.muteCues : !v.cues) return;
  if (S.call?.deaf && kind !== 'undeafen' && kind !== 'deafen') return;
  const c = audioCtx();
  if (!c || c.state !== 'running') return;
  const t0 = c.currentTime + 0.01;
  for (const [f, at] of CUES[kind] || []) {
    const o = c.createOscillator();
    const env = c.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    env.gain.setValueAtTime(0, t0 + at);
    env.gain.linearRampToValueAtTime(0.08, t0 + at + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.16);
    o.connect(env); env.connect(c.destination);
    o.start(t0 + at); o.stop(t0 + at + 0.18);
  }
  lastCue = { kind, at: Date.now() };
}
export let lastCue = null;

// ---------- Soundboard ----------

const decoded = new Map(); // file -> Promise<AudioBuffer>
export function loadSound(file) {
  if (!decoded.has(file)) {
    const p = (async () => {
      const res = await fetch(`/api/sounds/${file}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Couldn’t load that sound.');
      const c = audioCtx();
      if (!c) throw new Error('This browser can’t play sounds here.');
      return c.decodeAudioData(await res.arrayBuffer());
    })();
    p.catch(() => decoded.delete(file));
    decoded.set(file, p);
  }
  return decoded.get(file);
}
// Hear a sound myself (in settings, before adding it, or a preview).
export async function preview(fileOrBuffer, volume = 1) {
  const c = audioCtx();
  if (!c) return;
  const buf = typeof fileOrBuffer === 'string' ? await loadSound(fileOrBuffer) : fileOrBuffer;
  const src = c.createBufferSource();
  const gain = c.createGain();
  src.buffer = buf; gain.gain.value = volume;
  src.connect(gain); gain.connect(c.destination);
  src.start();
}
// Mix a sound into what everyone hears (and play it for me too, unless deafened).
export async function playIntoCall(file, volume = 1) {
  if (!g || g.raw) throw new Error('The soundboard needs a browser that can mix audio.');
  const buf = await loadSound(file);
  if (!g) return;
  const src = ctx.createBufferSource();
  const gain = ctx.createGain();
  src.buffer = buf;
  gain.gain.value = volume;
  src.connect(gain);
  gain.connect(g.mix);
  if (!S.call?.deaf) gain.connect(ctx.destination);
  playing++;
  gate();
  src.onended = () => { playing = Math.max(0, playing - 1); try { gain.disconnect(); } catch { /* gone */ } gate(); };
  src.start();
}

// For the end-to-end checks.
export function voiceDebug() {
  return {
    mode: vp().mode, graph: g ? (g.raw ? 'raw' : 'mixed') : null, trackEnabled: g?.track ? g.track.enabled : null,
    gate: g && !g.raw ? g.gate.gain.value : null, open: micOpen(), ptt: pttDown, playing, meter: { ...meter }, ctx: ctx?.state || null,
    // The captured microphone's processing as the browser applied it, and the track that is sent (it never changes in a call).
    mic: (() => { const t = (g?.raw ? g.out : g?.src?.mediaStream)?.getAudioTracks()[0]; const st = t?.getSettings?.() || {}; return t ? { id: t.id, noise: st.noiseSuppression, echo: st.echoCancellation, agc: st.autoGainControl } : null; })(),
    sent: g?.track?.id || null, cue: lastCue,
    // Voice and calls track: the chosen input and the device really captured, and my microphone's volume.
    input: vp().input || '', device: (() => { const t = (g?.raw ? g.out : g?.src?.mediaStream)?.getAudioTracks()[0]; return t?.getSettings?.().deviceId || null; })(),
    inputGain: g?.inGain ? g.inGain.gain.value : null, outputVolume: clamp2(vp().outputVolume),
  };
}
