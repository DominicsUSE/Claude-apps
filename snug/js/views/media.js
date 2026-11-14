// Voice messages, pinned messages and GIFs, in the browser.
//
// - VoiceButton records in the composer (hold to record, or tap to start and
//   tap send), shows a live timer and level meter, and uploads the recording
//   as an audio attachment with its length and a 48-bar waveform.
// - VoicePlayer is the compact row a voice message shows as.
// - Pins: the menu item, the marker on a message, the line in the stream, the
//   header button and the side pane with the list.
// - GIFs: the composer button and picker (your GIFs, recent in your places,
//   search when the server has a provider), and GIFs in messages, which pause
//   under reduced motion and when scrolled away.
import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import {
  S, emit, toast, person, convMeta, findMsg, jumpToMsg, openPop, closePop, closePane, togglePane, openLightbox,
} from '../store.js';
import { call, on as onEvent, sendMessage, uploadFile, resyncNow } from '../server.js';
import { can } from '../lib/perms.js';
import { fmtWhen, plural } from '../lib/util.js';
import { plain } from '../lib/format.js';
import { Icon } from '../ui/icons.js';
import { Avatar } from '../ui/kit.js';
import { XIcon, openViewer } from './viewer.js'; // the media viewer, and icons it adds

const MAX_SECONDS = 300;
const PEAKS = 48;
const rectOf = (e) => e.currentTarget.getBoundingClientRect();

export function reducedMotion() {
  const m = document.documentElement.getAttribute('data-motion');
  if (m === 'off') return true;
  if (m === 'full') return false;
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}
export function clock(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
const spoken = (sec) => {
  const s = Math.max(0, Math.round(sec || 0));
  const m = Math.floor(s / 60);
  return m ? `${plural(m, 'minute')}${s % 60 ? ` ${plural(s % 60, 'second')}` : ''}` : plural(s, 'second');
};

// What an attachment is called in a one-line preview.
export function fileLabel(f) {
  if (isVoice(f)) return `Voice message${f.duration ? `, ${clock(f.duration)}` : ''}`;
  if (f.spoiler) return f.kind === 'video' ? 'Spoiler video' : f.kind === 'image' ? 'Spoiler image' : `Spoiler: ${f.name}`;
  if (f.gif) return 'GIF';
  return f.name;
}
// A recorded voice message (voice: true; older ones are known by their waveform), not any sound file.
export const isVoice = (f) => f.kind === 'audio' && (f.voice === true || (Array.isArray(f.peaks) && f.peaks.length > 0));
const preview = (m) => plain(m.text) || (m.files || []).map(fileLabel).join(', ') || 'Attachment';

// Live changes from the server.
onEvent('pins', ({ conv, pins, m, users }) => {
  if (users) for (const [id, u] of Object.entries(users)) S.users[id] = { ...S.users[id], ...u };
  if (m && !findMsg(conv, m.id)) S.cache[m.id] = m;
  S.pins ||= {};
  if (pins.length) S.pins[conv] = pins; else delete S.pins[conv];
});
onEvent('gifs', ({ favs }) => { S.gifFavs = favs; });

// ---------------------------------------------------------------- Pins

export const pinsOf = (conv) => (S.pins || {})[conv] || [];
export const pinOf = (conv, id) => pinsOf(conv).find((p) => p.id === id);

// In a house: the 'pin' permission, or 'moderate'. In a direct conversation or group: anyone in it.
export function canPin(conv) {
  const meta = convMeta(conv);
  if (!meta || meta.kind === 'thread') return false;
  if (meta.house) return can(S, meta.house, 'pin') || can(S, meta.house, 'moderate');
  return true;
}

function setPin(conv, id, pinned) {
  S.pins ||= {};
  const list = pinsOf(conv).filter((p) => p.id !== id);
  if (pinned) list.unshift({ id, by: S.me, at: Date.now() });
  if (list.length) S.pins[conv] = list; else delete S.pins[conv];
  emit();
  return call(pinned ? 'msg.pin' : 'msg.unpin', { conv, id }).catch((e) => {
    toast(e.offline ? 'You’re offline, so that wasn’t pinned.' : e.message);
    resyncNow();
  });
}
export function togglePin(conv, id) {
  const pinned = !pinOf(conv, id);
  setPin(conv, id, pinned);
  toast(pinned ? 'Message pinned' : 'Message unpinned', { undo: () => setPin(conv, id, !pinned) });
}

// The menu item, in the message menu after highlights.
export function pinMenuItem(conv, m) {
  if (m.state || !canPin(conv)) return null;
  const pinned = !!pinOf(conv, m.id);
  return { label: pinned ? 'Unpin message' : 'Pin message', icon: 'pin', onSelect: () => togglePin(conv, m.id) };
}

// The small marker on a pinned message.
export function PinnedMark({ conv, id }) {
  const p = pinOf(conv, id);
  if (!p) return null;
  const by = p.by === S.me ? 'you' : person(p.by).name.split(' ')[0];
  return html`<div class="msg-pin"><${Icon} name="pin" size=${12} /><span>Pinned by ${by}</span></div>`;
}

// "Ada pinned a message" lines, placed in the stream at the time of the pin.
// Pins older than the loaded part of the conversation are left out.
export function withPinLines(conv, items) {
  const pins = pinsOf(conv);
  if (!pins.length || !items.length) return items;
  const msgs = items.filter((it) => it.type === 'msg');
  if (!msgs.length) return items;
  const first = msgs[0].m.ts;
  const out = [...items];
  for (const p of [...pins].sort((a, b) => a.at - b.at)) {
    if (p.at < first) continue;
    let i = out.findIndex((it) => it.type === 'msg' && !it.m.state && it.m.ts > p.at);
    const line = { type: 'pin', key: `pin-${p.id}`, pin: p };
    if (i < 0) { i = out.findIndex((it) => it.type === 'msg' && it.m.state); }
    if (i < 0) out.push(line);
    else {
      out.splice(i, 0, line);
      if (out[i + 1]?.type === 'msg' && out[i + 1].grouped) out[i + 1] = { ...out[i + 1], grouped: false };
    }
  }
  return out;
}

export function PinLine({ conv, pin }) {
  const who = pin.by === S.me ? 'You' : person(pin.by).name;
  const open = () => {
    if ((S.msgs[conv] || []).some((m) => m.id === pin.id)) { S.ui.jump = { conv, id: pin.id, n: (S.ui.jump?.n || 0) + 1 }; emit(); } else jumpToMsg(conv, pin.id);
  };
  return html`<div class="pinline" role="note">
    <span class="pinline-ic" aria-hidden="true"><${Icon} name="pin" size=${16} /></span>
    <span><b>${who}</b> pinned <button class="pinline-link" onClick=${open}>a message</button></span>
    <span class="pinline-time">${fmtWhen(pin.at)}</span>
  </div>`;
}

// The header button: a pin with the count, opening the list in the side pane.
export function PinsButton({ conv }) {
  const n = pinsOf(conv).length;
  if (!n) return null;
  const open = S.ui.pane?.type === 'pins';
  return html`<button class=${`ib pins-btn${open ? ' on' : ''}`} aria-pressed=${String(open)} aria-label=${`Pinned messages, ${n}`}
    data-tip="Pinned messages" onClick=${() => togglePane('pins')}><${Icon} name="pin" /><span class="num">${n}</span></button>`;
}

export function PinsPane({ conv }) {
  const meta = convMeta(conv);
  if (!meta) return null;
  const pins = pinsOf(conv);
  const mayPin = canPin(conv);
  return html`<aside class="pane" aria-label="Pinned messages">
    <header class="bar">
      ${S.ui.phone && html`<button class="ib" aria-label="Back" onClick=${closePane}><${Icon} name="back" /></button>`}
      <h1 class="bar-title"><${Icon} name="pin" />Pinned</h1>
      <span class="bar-sub trunc">${meta.title}</span>
      <div class="bar-end">${!S.ui.phone && html`<button class="ib" aria-label="Close pinned messages" data-tip="Close" data-key="Esc" onClick=${closePane}><${Icon} name="x" /></button>`}</div>
    </header>
    <div class="pane-body pad">
      ${pins.length
        ? html`<p class="pins-count">${plural(pins.length, 'pinned message')}${pins.length >= 45 ? ` of 50` : ''}</p>
          <ul class="pins-list" role="list">
          ${pins.map((p) => {
            const m = findMsg(conv, p.id);
            const by = p.by === S.me ? 'you' : person(p.by).name.split(' ')[0];
            return html`<li class="pin-row" key=${p.id}>
              <button class="pin-open" onClick=${() => jumpToMsg(conv, p.id)} aria-label=${`Go to ${m ? `${person(m.author).name}’s message` : 'the message'}`}>
                ${m ? html`<span class="pin-head"><${Avatar} user=${person(m.author)} size=${24} /><b class="trunc">${person(m.author).name}</b><span class="pin-when">${fmtWhen(m.ts)}</span></span>
                    <span class="pin-text">${preview(m)}</span>`
                  : html`<span class="pin-text faint">A message from earlier in the conversation</span>`}
                <span class="pin-by">Pinned by ${by}, ${fmtWhen(p.at)}</span>
              </button>
              ${mayPin && html`<button class="ib sm" aria-label="Unpin" data-tip="Unpin" onClick=${() => togglePin(conv, p.id)}><${Icon} name="x" size=${16} /></button>`}
            </li>`;
          })}
          </ul>`
        : html`<div class="pins-empty"><p><b>Nothing pinned here.</b></p><p class="sub">${mayPin
          ? 'Open a message’s menu and choose Pin message. Everyone here sees what’s pinned.'
          : 'People who look after this room can pin the messages worth keeping.'}</p></div>`}
    </div>
  </aside>`;
}

// ---------------------------------------------------------------- Voice messages

// One voice message plays at a time.
let playing = null;
let speed = 1;
const SPEEDS = [1, 1.5, 2];

export function VoicePlayer({ f }) {
  const audio = useRef();
  const [isOn, setOn] = useState(false);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(f.duration || 0);
  const [rate, setRate] = useState(speed);
  const [failed, setFailed] = useState(false);
  const src = f.src || (f.id ? `/api/files/${f.id}` : null);
  const peaks = Array.isArray(f.peaks) && f.peaks.length ? f.peaks : Array(PEAKS).fill(60);
  const total = dur || f.duration || 0;
  const frac = total ? Math.min(1, t / total) : 0;

  useEffect(() => {
    const a = audio.current;
    if (!a) return undefined;
    let raf = 0;
    const tick = () => { setT(a.currentTime); if (!a.paused) raf = requestAnimationFrame(tick); };
    const onPlay = () => { setOn(true); if (playing && playing !== a) playing.pause(); playing = a; tick(); };
    const onPause = () => { setOn(false); cancelAnimationFrame(raf); setT(a.currentTime); };
    const onEnd = () => { setOn(false); cancelAnimationFrame(raf); setT(0); a.currentTime = 0; };
    const onMeta = () => { if (Number.isFinite(a.duration) && a.duration > 0 && !f.duration) setDur(a.duration); };
    const onErr = () => setFailed(true);
    a.playbackRate = speed;
    a.addEventListener('play', onPlay); a.addEventListener('pause', onPause); a.addEventListener('ended', onEnd);
    a.addEventListener('loadedmetadata', onMeta); a.addEventListener('durationchange', onMeta); a.addEventListener('error', onErr);
    a.addEventListener('timeupdate', () => { if (a.paused) setT(a.currentTime); });
    return () => { cancelAnimationFrame(raf); a.pause(); if (playing === a) playing = null; };
  }, [src]);

  const toggle = () => {
    const a = audio.current;
    if (!a) return;
    if (a.paused) a.play().catch(() => setFailed(true)); else a.pause();
  };
  const seek = (sec) => {
    const a = audio.current;
    if (!a || !total) return;
    a.currentTime = Math.max(0, Math.min(total - 0.05, sec));
    setT(a.currentTime);
  };
  const onWave = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    seek(((e.clientX - r.left) / r.width) * total);
  };
  const onKey = (e) => {
    const step = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5 }[e.key];
    if (step) seek(t + step);
    else if (e.key === 'Home') seek(0);
    else if (e.key === 'End') seek(total);
    else if (e.key === ' ' || e.key === 'Enter') toggle();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const cycle = () => {
    speed = SPEEDS[(SPEEDS.indexOf(rate) + 1) % SPEEDS.length];
    setRate(speed);
    if (audio.current) audio.current.playbackRate = speed;
  };

  return html`<div class=${`voice${isOn ? ' on' : ''}${failed ? ' failed' : ''}`} role="group" aria-label=${`Voice message, ${spoken(total)}`}>
    <button class="voice-play" aria-label=${isOn ? 'Pause voice message' : 'Play voice message'} aria-pressed=${String(isOn)} disabled=${!src} onClick=${toggle}>
      <${Icon} name=${isOn ? 'pause' : 'play'} size=${16} />
    </button>
    <div class="voice-wave" role="slider" tabindex="0" aria-label="Position in voice message"
      aria-valuemin="0" aria-valuemax=${Math.round(total)} aria-valuenow=${Math.round(t)} aria-valuetext=${`${clock(t)} of ${clock(total)}`}
      onClick=${onWave} onKeyDown=${onKey}>
      ${peaks.map((p, i) => html`<i key=${i} class=${(i + 0.5) / peaks.length <= frac ? 'done' : ''} style=${`height:${Math.max(12, Math.round((p / 255) * 100))}%`}></i>`)}
    </div>
    <span class="voice-time">${failed ? 'Can’t play' : isOn || t > 0 ? `${clock(t)} / ${clock(total)}` : clock(total)}</span>
    <button class="voice-speed" aria-label=${`Playback speed ${rate} times. Change speed`} data-tip="Playback speed" onClick=${cycle}>${rate}×</button>
    ${src && html`<audio ref=${audio} src=${src} preload="metadata"></audio>`}
  </div>`;
}

function micError(e) {
  if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') return 'Snug can’t use your microphone. Allow it for this site in your browser, then try again.';
  if (e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError') return 'No microphone was found. Plug one in and try again.';
  if (e?.name === 'NotReadableError') return 'Another app is using your microphone. Close it and try again.';
  return 'Recording didn’t start. Try again.';
}

function recorderType() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) if (MediaRecorder.isTypeSupported(t)) return t;
  return '';
}

// Many level samples down to a fixed number of bars, 0 to 255.
function toPeaks(samples, n = PEAKS) {
  if (!samples.length) return Array(n).fill(0);
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * samples.length) / n), b = Math.max(a + 1, Math.floor(((i + 1) * samples.length) / n));
    let max = 0;
    for (let j = a; j < b && j < samples.length; j++) max = Math.max(max, samples[j]);
    out.push(max);
  }
  const top = Math.max(...out, 0.02);
  return out.map((v) => Math.max(0, Math.min(255, Math.round((v / top) * 255))));
}

// The microphone button, and while recording, the bar that covers the composer row.
export function VoiceButton({ conv }) {
  const [rec, setRec] = useState(null);    // null | { phase: 'starting'|'recording'|'sending'|'failed', ... }
  const [, setTick] = useState(0);
  const r = useRef({});                    // the recording under way
  const ptr = useRef({});                  // the press on the button

  const cleanup = () => {
    const x = r.current;
    clearInterval(x.timer);
    x.stream?.getTracks().forEach((tr) => tr.stop());
    x.ctx?.close().catch(() => {});
    r.current = {};
  };
  useEffect(() => () => { r.current.cancelled = true; try { r.current.rec?.stop(); } catch { /* already stopped */ } cleanup(); }, []);

  const elapsed = () => (r.current.started ? (performance.now() - r.current.started) / 1000 : 0);

  async function start(mode) {
    if (r.current.active) return;
    const type = recorderType();
    if (type === null || !navigator.mediaDevices?.getUserMedia) { toast('This browser can’t record voice messages.'); return; }
    const x = { active: true, mode, samples: [], levels: [] };
    r.current = x;
    setRec({ phase: 'starting' });
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) { if (r.current === x) { cleanup(); setRec(null); toast(micError(e)); } return; }
    if (r.current !== x || x.cancelled) { stream.getTracks().forEach((tr) => tr.stop()); return; }
    x.stream = stream;
    try {
      x.ctx = new AudioContext();
      const src = x.ctx.createMediaStreamSource(stream);
      x.an = x.ctx.createAnalyser();
      x.an.fftSize = 1024;
      src.connect(x.an);
      x.buf = new Float32Array(x.an.fftSize);
    } catch { /* no meter, still records */ }
    const recorder = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined);
    x.rec = recorder;
    x.chunks = [];
    recorder.ondataavailable = (e) => { if (e.data?.size) x.chunks.push(e.data); };
    recorder.start(250);
    x.started = performance.now();
    x.timer = setInterval(() => {
      if (x.an) {
        x.an.getFloatTimeDomainData(x.buf);
        let sum = 0;
        for (const v of x.buf) sum += v * v;
        const level = Math.min(1, Math.sqrt(sum / x.buf.length) * 4);
        x.samples.push(level);
        x.levels = [...x.levels.slice(-23), level];
      }
      if (elapsed() >= MAX_SECONDS) { finish(true); return; }
      setTick((n) => n + 1);
    }, 80);
    setRec({ phase: 'recording' });
    // A press released before the microphone was ready leaves it recording, as a tap would.
    if (x.mode === 'hold' && ptr.current.released) x.mode = 'tap';
  }

  function cancel() {
    const x = r.current;
    x.cancelled = true;
    try { x.rec?.stop(); } catch { /* already stopped */ }
    cleanup();
    setRec(null);
    focusBox(conv);
  }

  async function finish(atLimit = false) {
    const x = r.current;
    if (!x.rec || x.stopping) return;
    x.stopping = true;
    const duration = Math.min(MAX_SECONDS, elapsed());
    const peaks = toPeaks(x.samples);
    const type = (x.rec.mimeType || 'audio/webm').split(';')[0];
    const done = new Promise((res) => { x.rec.onstop = res; });
    try { x.rec.stop(); } catch { /* already stopped */ }
    await done;
    const blob = new Blob(x.chunks, { type });
    cleanup();
    if (duration < 0.6 || !blob.size) {
      setRec(null);
      toast('That was too short to send. Hold the microphone while you talk, or tap it to start and tap Send when you’re done.');
      return;
    }
    if (atLimit) toast('Voice messages can be up to 5 minutes, so it was sent at 5:00.');
    upload({ blob, type, duration, peaks });
  }

  async function upload(take) {
    setRec({ phase: 'sending', take });
    const ext = take.type.includes('mp4') ? 'm4a' : take.type.includes('ogg') ? 'ogg' : 'webm';
    const name = `Voice message.${ext}`;
    try {
      const up = await uploadFile(conv, take.blob, name);
      const duration = Math.round(take.duration * 10) / 10;
      sendMessage(conv, '', { replyTo: S.ui.reply[conv], files: [{ id: up.id, kind: 'audio', voice: true, name, size: up.size, duration, peaks: take.peaks, src: URL.createObjectURL(take.blob) }] });
      setRec(null);
      focusBox(conv);
    } catch (e) {
      setRec({ phase: 'failed', take, error: e.message });
    }
  }

  // Esc cancels while recording, before anything else hears it.
  useEffect(() => {
    if (!rec || rec.phase === 'sending') return undefined;
    const k = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [rec?.phase]);

  // Hold to record: press, talk, let go to send. A quick tap starts recording
  // that stays on until Send. On a phone, sliding left while holding cancels.
  const onDown = (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    const x0 = e.clientX;
    const t0 = performance.now();
    ptr.current = { fromPointer: true, released: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const el = e.currentTarget;
    const move = (ev) => {
      const dx = ev.clientX - x0;
      if (ev.pointerType === 'touch' && dx < -80) { stopListen(); cancel(); }
    };
    const up = () => {
      stopListen();
      const x = r.current;
      ptr.current.released = true;
      if (x.mode === 'hold' && x.rec && performance.now() - t0 > 450) finish();
      else if (x.mode === 'hold') x.mode = 'tap';
    };
    function stopListen() { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); }
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    start('hold');
  };
  const onClick = () => {
    if (ptr.current.fromPointer) { ptr.current.fromPointer = false; return; }
    start('tap');
  };

  const t = elapsed();
  const left = MAX_SECONDS - t;
  const levels = r.current.levels || [];
  const touch = matchMedia('(pointer: coarse)').matches;
  return html`
    <button class=${`ib mic${rec ? ' on' : ''}`} aria-label="Record a voice message" data-tip="Hold to record, or tap to start"
      onPointerDown=${onDown} onClick=${onClick} onContextMenu=${(e) => e.preventDefault()}><${Icon} name="mic" /></button>
    ${rec && html`<div class=${`rec ${rec.phase}`} role="group" aria-label="Voice message">
      ${rec.phase === 'failed'
        ? html`<${Icon} name="alert" size=${16} /><span class="rec-note bad grow" role="alert">Not sent. ${rec.error}</span>
            <button class="btn quiet" onClick=${() => { setRec(null); focusBox(conv); }}>Discard</button>
            <button class="btn primary" onClick=${() => upload(rec.take)}>Try again</button>`
        : html`
          <button class="ib" aria-label="Cancel recording" data-tip="Cancel" data-key="Esc" onClick=${cancel} disabled=${rec.phase === 'sending'}><${Icon} name="x" /></button>
          <span class="rec-dot" aria-hidden="true"></span>
          <span class="rec-time" role="timer" aria-label=${`Recording, ${spoken(t)}`}>${clock(t)}</span>
          <span class="rec-meter" aria-hidden="true">${Array.from({ length: 24 }, (_, i) => {
            const v = levels[levels.length - 24 + i] || 0;
            return html`<i key=${i} style=${`height:${Math.max(8, Math.round(v * 100))}%`}></i>`;
          })}</span>
          <span class="rec-note grow" role="status">${rec.phase === 'starting' ? 'Starting your microphone…'
            : rec.phase === 'sending' ? 'Sending…'
            : left <= 30 ? html`<span class="rec-left">${Math.ceil(left)}s left</span>`
            : touch ? 'Slide left to cancel' : 'Esc to cancel'}</span>
          <button class="ib send" aria-label="Send voice message" data-tip="Send" disabled=${rec.phase !== 'recording'} onClick=${() => finish()}><${Icon} name="send" /></button>`}
    </div>`}`;
}

function focusBox(conv) {
  requestAnimationFrame(() => document.querySelector(`[data-composer="${CSS.escape(conv)}"] textarea`)?.focus());
}

// ---------------------------------------------------------------- GIFs

export const isFavGif = (id) => (S.gifFavs || []).some((g) => g.id === id);
export function toggleGifFav(f) {
  const on = !isFavGif(f.id);
  S.gifFavs = on ? [{ id: f.id, name: f.name, size: f.size, w: f.w, h: f.h, kind: f.kind, at: Date.now() }, ...(S.gifFavs || [])] : (S.gifFavs || []).filter((g) => g.id !== f.id);
  emit();
  call('gif.fav', { file: f.id, on, w: f.w, h: f.h }).then(
    () => toast(on ? 'Saved to your GIFs' : 'Removed from your GIFs'),
    (e) => { toast(e.offline ? 'You’re offline, so that wasn’t saved.' : e.message); resyncNow(); },
  );
}

// A still first frame, for reduced motion and for GIFs scrolled out of view.
export function Still({ src, alt, onError }) {
  const ref = useRef();
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const c = ref.current;
      if (!c) return;
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      try { c.getContext('2d').drawImage(img, 0, 0); } catch { /* nothing to draw */ }
    };
    if (onError) img.onerror = onError;
    img.src = src;
  }, [src]);
  return html`<canvas ref=${ref} role="img" aria-label=${alt}></canvas>`;
}

function useVisible(ref) {
  const [vis, setVis] = useState(true);
  useEffect(() => {
    if (!ref.current || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver(([e]) => setVis(e.isIntersecting), { rootMargin: '160px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, []);
  return vis;
}

// A GIF in a message: plays on its own, unless motion is reduced (then it
// waits for Play) or it is scrolled away. Its star saves it to your GIFs.
export function GifImage({ f, src, ctx = {} }) {
  const box = useRef();
  const vid = useRef();
  const visible = useVisible(box);
  const reduced = reducedMotion();
  const [chosen, setChosen] = useState(null);   // null follows the setting; true/false is the person's choice
  // Settings > Appearance > Chat (gifAutoplay): auto plays unless motion is
  // reduced; always plays even then; hover plays while the pointer is on the
  // message (or it has focus); never stays still until you point at the GIF.
  const [over, setOver] = useState(false);
  const mode = S.prefs.gifAutoplay || 'auto';
  useEffect(() => {
    if (mode !== 'hover' && mode !== 'never') return undefined;
    const el = (mode === 'hover' && box.current?.closest('.msg')) || box.current;
    if (!el) return undefined;
    const on = () => setOver(true), off = () => setOver(false);
    const evs = [['pointerenter', on], ['pointerleave', off], ['focusin', on], ['focusout', off]];
    evs.forEach(([n, fn]) => el.addEventListener(n, fn));
    return () => evs.forEach(([n, fn]) => el.removeEventListener(n, fn));
  }, [mode]);
  const auto = mode === 'always' ? true : mode === 'auto' ? !reduced : over;
  const play = (chosen ?? auto) && visible;
  const fav = f.id && isFavGif(f.id);
  const w = f.w || 240, h = f.h || 180;
  useEffect(() => { const v = vid.current; if (v) { if (play) v.play().catch(() => {}); else v.pause(); } }, [play]);
  return html`<div class=${`gif${play ? ' playing' : ''}`} ref=${box} style=${`aspect-ratio:${w}/${h};width:${Math.min(320, w)}px`}>
    <button class="gif-open" aria-label=${`Open GIF ${f.alt || f.name}`} onClick=${() => (ctx.m ? openViewer(ctx.conv, ctx.m, f) : openLightbox(src, f.name))}>
      ${f.kind === 'video'
        ? html`<video ref=${vid} src=${src} muted loop playsinline preload="metadata" aria-label=${f.alt || f.name}></video>`
        : play ? html`<img src=${src} alt=${f.alt || f.name} />` : html`<${Still} src=${src} alt=${f.alt || f.name} />`}
    </button>
    <span class="gif-tag" aria-hidden="true">GIF</span>
    ${!play && visible && html`<button class="gif-play" aria-label="Play GIF" onClick=${() => setChosen(true)}><${Icon} name="play" size=${20} /></button>`}
    ${play && (reduced || chosen) && html`<button class="gif-pause" aria-label="Pause GIF" data-tip="Pause" onClick=${() => setChosen(false)}><${Icon} name="pause" size=${16} /></button>`}
    ${f.id && !f.spoiler && html`<button class=${`gif-star${fav ? ' on' : ''}`} aria-pressed=${String(!!fav)} aria-label=${fav ? 'Remove from your GIFs' : 'Save to your GIFs'}
      data-tip=${fav ? 'In your GIFs' : 'Save to your GIFs'} onClick=${() => toggleGifFav(f)}><${Icon} name=${fav ? 'starred' : 'star'} size=${16} /></button>`}
  </div>`;
}

// Hook for the stream's attachment list: voice messages and GIFs draw themselves.
// Voice messages, sound files, videos and GIFs each draw themselves.
export function mediaFile(f, src, key, ctx = {}) {
  if (isVoice(f)) return html`<${VoicePlayer} key=${key} f=${f} />`;
  if (f.kind === 'audio') return html`<${AudioFile} key=${key} f=${f} src=${src} />`;
  if (f.gif && src) return html`<${GifImage} key=${key} f=${f} src=${src} ctx=${ctx} />`;
  if (f.kind === 'video' && src) return html`<${VideoPlayer} key=${key} f=${f} src=${src} ctx=${ctx} />`;
  return null;
}

// ---------------------------------------------------------------- Video and sound files
// One player plays at a time, whatever kind.
let current = null;
const claim = (el) => { if (current && current !== el && !current.paused) current.pause(); current = el; };
const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;

// Seek with the keyboard (arrows 5 s, Page keys 10%, Home, End) or by pointer.
function Seek({ t, total, onSeek, label }) {
  const frac = total ? Math.min(1, t / total) : 0;
  const at = (e) => { const r = e.currentTarget.getBoundingClientRect(); onSeek(((e.clientX - r.left) / r.width) * total); };
  const onDown = (e) => {
    if (!total) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    at(e);
  };
  const onMove = (e) => { if (e.buttons && e.currentTarget.hasPointerCapture?.(e.pointerId)) at(e); };
  const onKey = (e) => {
    const step = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5, PageUp: total / 10, PageDown: -total / 10 }[e.key];
    if (step) onSeek(t + step);
    else if (e.key === 'Home') onSeek(0);
    else if (e.key === 'End') onSeek(total);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  return html`<div class="mp-seek" role="slider" tabindex="0" aria-label=${label} aria-valuemin="0" aria-valuemax=${Math.round(total)}
    aria-valuenow=${Math.round(t)} aria-valuetext=${`${clock(t)} of ${clock(total)}`} onPointerDown=${onDown} onPointerMove=${onMove} onKeyDown=${onKey}>
    <span class="mp-track"><span class="mp-fill" style=${`width:${frac * 100}%`}></span><span class="mp-knob" style=${`left:${frac * 100}%`}></span></span>
  </div>`;
}

// Shared state for an <audio> or <video> element.
function useMediaEl(ref, src, known) {
  const [st, setSt] = useState({ on: false, t: 0, dur: known || 0, muted: false, vol: 1, failed: false, ready: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const put = (d) => setSt((s) => ({ ...s, ...d }));
    const h = {
      play: () => { claim(el); put({ on: true }); },
      pause: () => put({ on: false }),
      ended: () => put({ on: false }),
      timeupdate: () => put({ t: el.currentTime }),
      loadedmetadata: () => put({ ready: true, ...(Number.isFinite(el.duration) && el.duration > 0 ? { dur: el.duration } : {}) }),
      durationchange: () => { if (Number.isFinite(el.duration) && el.duration > 0) put({ dur: el.duration }); },
      volumechange: () => put({ muted: el.muted, vol: el.volume }),
      error: () => put({ failed: true }),
    };
    for (const [k, f] of Object.entries(h)) el.addEventListener(k, f);
    return () => { for (const [k, f] of Object.entries(h)) el.removeEventListener(k, f); el.pause(); if (current === el) current = null; };
  }, [src]);
  const toggle = () => { const el = ref.current; if (!el) return; if (el.paused) el.play().catch(() => setSt((s) => ({ ...s, failed: true }))); else el.pause(); };
  const seek = (sec) => { const el = ref.current; const total = st.dur; if (!el || !total) return; el.currentTime = Math.max(0, Math.min(total - 0.05, sec)); setSt((s) => ({ ...s, t: el.currentTime })); };
  return [st, toggle, seek];
}

// A video in a message: its first frame as the poster, then our own controls.
export function VideoPlayer({ f, src, ctx = {} }) {
  const box = useRef();
  const vid = useRef();
  const [st, toggle, seek] = useMediaEl(vid, src, f.duration);
  const [full, setFull] = useState(false);
  const w = f.w || 480, h = f.h || 270;
  const name = f.alt || f.name;
  useEffect(() => {
    const on = () => setFull(fsEl() === box.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  const setVol = (v) => { const el = vid.current; if (!el) return; el.volume = v; el.muted = v === 0; };
  const fullscreen = () => { if (fsEl()) document.exitFullscreen?.(); else box.current?.requestFullscreen?.().catch(() => toast('Full screen isn’t available here.')); };
  const pip = () => {
    const el = vid.current;
    if (!el) return;
    if (document.pictureInPictureElement === el) document.exitPictureInPicture?.();
    else el.requestPictureInPicture?.().catch(() => toast('Picture in picture isn’t available here.'));
  };
  const onKey = (e) => {
    if (e.target.closest('.mp-seek, input, a')) return;
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); e.stopPropagation(); toggle(); }
    else if (e.key === 'm') { e.preventDefault(); e.stopPropagation(); if (vid.current) vid.current.muted = !vid.current.muted; }
    else if (e.key === 'f') { e.preventDefault(); e.stopPropagation(); fullscreen(); }
  };
  const total = st.dur || f.duration || 0;
  const canPip = typeof document !== 'undefined' && document.pictureInPictureEnabled;
  return html`<div class=${`vplayer${st.on ? ' on' : ''}${full ? ' full' : ''}${st.failed ? ' failed' : ''}`} ref=${box} role="group" aria-label=${`Video: ${name}`}
    style=${full ? '' : `aspect-ratio:${w}/${h};width:min(100%, ${Math.min(480, Math.max(360, w))}px)`} onKeyDown=${onKey}>
    <video ref=${vid} src=${`${src}#t=0.1`} preload="metadata" playsinline aria-label=${name} onClick=${toggle}></video>
    ${!st.on && !st.failed && html`<button class="vp-big" aria-label=${`Play video ${name}`} onClick=${toggle}><${Icon} name="play" size=${28} /></button>`}
    ${st.failed && html`<div class="vp-err" role="status"><${Icon} name="alert" size=${16} />This video can’t play here. Download it instead.</div>`}
    <div class="vp-bar">
      <button class="vp-btn" aria-label=${st.on ? 'Pause' : 'Play'} aria-pressed=${String(st.on)} data-tip=${st.on ? 'Pause' : 'Play'} data-key="K" onClick=${toggle}><${Icon} name=${st.on ? 'pause' : 'play'} size=${16} /></button>
      <${Seek} t=${st.t} total=${total} onSeek=${seek} label="Position in video" />
      <span class="vp-time num">${clock(st.t)} / ${clock(total)}</span>
      <button class="vp-btn" aria-label=${st.muted ? 'Unmute' : 'Mute'} aria-pressed=${String(st.muted)} data-tip=${st.muted ? 'Unmute' : 'Mute'} data-key="M"
        onClick=${() => { if (vid.current) vid.current.muted = !vid.current.muted; }}><${XIcon} name=${st.muted || st.vol === 0 ? 'volume-off' : 'volume'} size=${16} /></button>
      <input class="vp-vol" type="range" min="0" max="1" step="0.05" value=${st.muted ? 0 : st.vol} aria-label="Volume" onInput=${(e) => setVol(Number(e.target.value))} />
      ${canPip && html`<button class="vp-btn" aria-label="Picture in picture" data-tip="Picture in picture" onClick=${pip}><${XIcon} name="pip" size=${16} /></button>`}
      <a class="vp-btn" href=${src} download=${f.name} aria-label=${`Download ${f.name}`} data-tip="Download"><${XIcon} name="download" size=${16} /></a>
      <button class="vp-btn" aria-label=${full ? 'Leave full screen' : 'Full screen'} data-tip=${full ? 'Leave full screen' : 'Full screen'} data-key="F" onClick=${fullscreen}><${Icon} name=${full ? 'shrink' : 'expand'} size=${16} /></button>
    </div>
  </div>`;
}

// A sound file that isn't a voice message: its name and length, a seek bar, download.
export function AudioFile({ f, src }) {
  const el = useRef();
  const [st, toggle, seek] = useMediaEl(el, src, f.duration);
  const total = st.dur || f.duration || 0;
  return html`<div class=${`afile${st.on ? ' on' : ''}${st.failed ? ' failed' : ''}`} role="group" aria-label=${`Sound file ${f.name}`}>
    <button class="voice-play" aria-label=${`${st.on ? 'Pause' : 'Play'} ${f.name}`} aria-pressed=${String(st.on)} disabled=${!src} onClick=${toggle}><${Icon} name=${st.on ? 'pause' : 'play'} size=${16} /></button>
    <div class="afile-main">
      <div class="afile-head"><span class="afile-name trunc">${f.name}</span><span class="afile-time num">${st.failed ? 'Can’t play' : `${clock(st.t)} / ${clock(total)}`}</span></div>
      <${Seek} t=${st.t} total=${total} onSeek=${seek} label=${`Position in ${f.name}`} />
    </div>
    ${src && html`<a class="ib sm" href=${src} download=${f.name} aria-label=${`Download ${f.name}`} data-tip="Download"><${XIcon} name="download" size=${16} /></a>`}
    ${src && html`<audio ref=${el} src=${src} preload="metadata"></audio>`}
  </div>`;
}

let gifConfig = null;
const loadGifConfig = () => (gifConfig ||= fetch('/api/gifs/config', { credentials: 'same-origin' })
  .then((r) => (r.ok ? r.json() : { search: false }), () => ({ search: false })));

async function post(path, body) {
  let res;
  try {
    res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch { throw new Error('Can’t reach Snug. Check your connection and try again.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'That GIF couldn’t be sent.');
  return data;
}

function Thumb({ src, alt, w, h, video }) {
  const reduced = reducedMotion();
  const ratio = w && h ? `aspect-ratio:${w}/${h}` : 'aspect-ratio:4/3';
  if (video) return html`<video src=${src} muted loop playsinline autoplay=${!reduced} style=${ratio} aria-label=${alt}></video>`;
  return reduced ? html`<span style=${ratio}><${Still} src=${src} alt=${alt} /></span>` : html`<img src=${src} alt=${alt} style=${ratio} loading="lazy" />`;
}

// query: from /giphy in the composer. It searches when the server has a GIF
// provider, and otherwise narrows your GIFs and recent ones by name.
export function GifPicker({ conv, query = '' }) {
  const favs = S.gifFavs || [];
  const [tab, setTab] = useState(favs.length ? 'mine' : 'recent');
  const [search, setSearch] = useState(false);
  const [recent, setRecent] = useState(null);     // null loading | [] | 'error'
  const [q, setQ] = useState(query);
  const [found, setFound] = useState({ q: '', list: [], state: 'idle' });
  const [busy, setBusy] = useState(null);
  const input = useRef();

  useEffect(() => { loadGifConfig().then((c) => { setSearch(!!c.search); if (c.search && query) setTab('search'); }); }, []);
  useEffect(() => {
    if (tab !== 'recent' || recent) return;
    call('gif.recent').then((r) => setRecent(r.gifs), () => setRecent('error'));
  }, [tab]);
  useLayoutEffect(() => { if (tab === 'search' || query) input.current?.focus(); }, [tab]);
  const term = q.trim().toLowerCase();
  const named = (list) => (term ? list.filter((g) => (g.name || '').toLowerCase().includes(term)) : list);
  useEffect(() => {
    if (tab !== 'search') return undefined;
    const term = q.trim();
    if (!term) { setFound({ q: '', list: [], state: 'idle' }); return undefined; }
    const t = setTimeout(() => {
      setFound((f) => ({ ...f, state: 'loading' }));
      fetch(`/api/gifs?q=${encodeURIComponent(term)}`, { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((d) => setFound({ q: term, list: d.results || [], state: 'done' }), () => setFound({ q: term, list: [], state: 'error' }));
    }, 350);
    return () => clearTimeout(t);
  }, [q, tab]);

  const send = async (key, work) => {
    if (busy) return;
    setBusy(key);
    try {
      const file = await work();
      closePop();
      sendMessage(conv, '', { replyTo: S.ui.reply[conv], files: [{ id: file.id, kind: file.kind, name: file.name, size: file.size, w: file.w, h: file.h, gif: true }] });
    } catch (e) {
      toast(e.message);
      setBusy(null);
    }
  };
  const useLocal = (g) => send(g.id, () => post('/api/gifs/use', { conv, file: g.id, w: g.w, h: g.h }));
  const useFound = (g) => send(g.id, () => post('/api/gifs/import', { conv, url: g.url, w: g.w, h: g.h, title: g.title }));

  const tile = (key, label, body, onPick) => html`<button key=${key} class=${`gif-tile${busy === key ? ' busy' : ''}`} aria-label=${label}
    aria-busy=${String(busy === key)} disabled=${!!busy && busy !== key} onClick=${onPick}>${body}${busy === key && html`<span class="gif-tile-note">Sending…</span>`}</button>`;
  const grid = (list, local) => html`<div class="gif-grid" role="list">
    ${list.map((g) => (local
      ? tile(g.id, `Send ${g.name}`, html`<${Thumb} src=${`/api/files/${g.id}`} alt=${g.name} w=${g.w} h=${g.h} video=${g.kind === 'video'} />`, () => useLocal(g))
      : tile(g.id, `Send ${g.title}`, html`<${Thumb} src=${g.preview} alt=${g.title} w=${g.w} h=${g.h} />`, () => useFound(g))))}
  </div>`;
  const loading = html`<div class="gif-grid" aria-hidden="true">${[1, 2, 3, 4, 5, 6].map((i) => html`<span key=${i} class="skel gif-skel"></span>`)}</div>`;

  const tabs = [['mine', 'Your GIFs'], ['recent', 'Recent in your places'], ...(search ? [['search', 'Search']] : [])];
  return html`<div class="gif-picker">
    <div class="gif-tabs" role="tablist" aria-label="GIFs">
      ${tabs.map(([id, label]) => html`<button key=${id} role="tab" aria-selected=${String(tab === id)} class=${tab === id ? 'on' : ''} onClick=${() => setTab(id)}>${label}</button>`)}
    </div>
    <div class="gif-body" role="tabpanel">
      ${tab !== 'search' && html`<input class="field gif-filter" ref=${input} placeholder="Find a GIF by name" aria-label="Find a GIF by name" value=${q} onInput=${(e) => setQ(e.target.value)} />`}
      ${tab === 'mine' && (favs.length ? (named(favs).length ? grid(named(favs), true) : html`<p class="gif-none">None of your GIFs is called “${q.trim()}”.</p>`) : html`<p class="gif-none">Star a GIF in any conversation to keep it here. Your GIFs follow you to every device.</p>`)}
      ${tab === 'recent' && (recent === null ? loading
        : recent === 'error' ? html`<p class="gif-none">Recent GIFs didn’t load. <button class="btn quiet" onClick=${() => { setRecent(null); call('gif.recent').then((r) => setRecent(r.gifs), () => setRecent('error')); }}>Try again</button></p>`
        : recent.length ? (named(recent).length ? grid(named(recent), true) : html`<p class="gif-none">No recent GIF is called “${q.trim()}”.</p>`) : html`<p class="gif-none">No GIFs in your places yet. When someone posts one, it shows up here.</p>`)}
      ${tab === 'search' && html`
        <input class="field" ref=${input} placeholder="Search GIFs" aria-label="Search GIFs" value=${q} onInput=${(e) => setQ(e.target.value)} />
        ${found.state === 'loading' ? loading
          : found.state === 'error' ? html`<p class="gif-none">GIF search isn’t answering right now. Try again in a moment.</p>`
          : found.state === 'done' && !found.list.length ? html`<p class="gif-none">No GIFs for “${found.q}”.</p>`
          : found.list.length ? grid(found.list, false)
          : html`<p class="gif-none">Type to search. A GIF you send is copied into Snug, so nobody’s browser loads it from elsewhere.</p>`}`}
    </div>
  </div>`;
}

export function GifButton({ conv }) {
  return html`<button class="ib gif-btn" aria-label="Send a GIF" data-tip="GIF"
    onClick=${(e) => openPop({ anchor: rectOf(e), align: 'end', label: 'GIFs', C: GifPicker, props: { conv } })}><${Icon} name="gif" /></button>`;
}
