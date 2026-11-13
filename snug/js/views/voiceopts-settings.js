// Settings > Voice and video (this device), and House settings > Voice
// (the soundboard, and each voice room's user limit and bitrate).
import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { S, toast, openModal, person } from '../store.js';
import { call } from '../server.js';
import { can } from '../lib/perms.js';
import { roomIds } from '../lib/attention.js';
import { Icon } from '../ui/icons.js';
import { Seg, Switch } from '../ui/kit.js';
import { Confirm } from './modals.js';
import { restartMic, restartCamera, recapBitrates } from '../voice.js';
import {
  vp, setVoice, micConstraints, cameraConstraints, audioCtx, meter, canPickSpeaker, preview, setPersonVolume, setPersonMuted,
  RESOLUTIONS, FRAME_RATES,
} from '../voiceopts.js';
import { setCapturingKey } from './voiceopts.js';

function Row({ label, hint, children, top }) {
  return html`<div class=${`set-row${top ? ' top' : ''}`}>
    <div class="set-label"><b>${label}</b>${hint && html`<span>${hint}</span>`}</div>
    <div class="set-ctl">${children}</div>
  </div>`;
}

// ---------- Devices ----------

function useDevices() {
  const [list, setList] = useState(null); // null while reading
  const read = async () => {
    try { setList(await navigator.mediaDevices.enumerateDevices()); } catch { setList([]); }
  };
  useEffect(() => {
    read();
    navigator.mediaDevices?.addEventListener?.('devicechange', read);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', read);
  }, []);
  return [list, read];
}

const KIND_NAME = { audioinput: 'Microphone', audiooutput: 'Speaker', videoinput: 'Camera' };
function DeviceSelect({ kind, list, value, onChange, label }) {
  const devs = (list || []).filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
  const missing = value && list && !devs.some((d) => d.deviceId === value);
  return html`<select class="field vo-dev" aria-label=${label} value=${value} disabled=${!list} onChange=${(e) => onChange(e.target.value)}>
    <option value="">System default</option>
    ${devs.map((d, i) => html`<option key=${d.deviceId} value=${d.deviceId}>${d.label || `${KIND_NAME[kind]} ${i + 1}`}</option>`)}
    ${missing && html`<option value=${value}>Not connected</option>`}
  </select>`;
}

// ---------- Microphone test: a level meter, and hearing yourself ----------

function Meter({ level, threshold, open, showThreshold }) {
  const at = (db) => `${Math.max(0, Math.min(100, db + 100))}%`;
  return html`<div class=${`vo-meter${open ? ' open' : ''}`} role="meter" aria-label="Microphone level" aria-valuemin="-100" aria-valuemax="0" aria-valuenow=${Math.round(level)}
    aria-valuetext=${level <= -99 ? 'Silent' : `${Math.round(level)} decibels${showThreshold ? (open ? ', above the sensitivity' : ', below the sensitivity') : ''}`}>
    <span class="vo-meter-fill" style=${`width:${at(level)}`}></span>
    ${showThreshold && html`<span class="vo-meter-mark" style=${`left:${at(threshold)}`}></span>`}
  </div>`;
}

const dbOf = (buf) => {
  let sum = 0;
  for (const v of buf) sum += v * v;
  const rms = Math.sqrt(sum / buf.length);
  return rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
};

function MicTest() {
  const v = vp();
  const [state, setState] = useState('idle'); // idle | starting | on | error
  const [err, setErr] = useState('');
  const [loop, setLoop] = useState(false);
  const [lvl, setLvl] = useState({ level: -100, open: false, threshold: v.threshold });
  const run = useRef(null);
  const stop = () => {
    const r = run.current;
    run.current = null;
    if (!r) return;
    cancelAnimationFrame(r.raf);
    try { r.src.disconnect(); } catch { /* gone */ }
    if (r.el) { r.el.srcObject = null; }
    r.stream.getTracks().forEach((t) => t.stop());
  };
  const start = async () => {
    stop();
    setErr('');
    setState('starting');
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia(micConstraints()); } catch (e) {
      setState('error');
      setErr(e?.name === 'NotAllowedError' ? 'Snug needs your microphone for this. Allow it in your browser’s site settings.' : e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError' ? 'That microphone isn’t connected. Pick another one.' : 'Couldn’t start your microphone.');
      return;
    }
    const c = audioCtx();
    if (!c) { stream.getTracks().forEach((t) => t.stop()); setState('error'); setErr('This browser can’t measure sound here.'); return; }
    const src = c.createMediaStreamSource(stream);
    const an = c.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    let floor = -70;
    const r = { stream, src, raf: 0, el: null };
    run.current = r;
    const frame = () => {
      if (run.current !== r) return;
      an.getFloatTimeDomainData(buf);
      const level = dbOf(buf);
      if (level < floor) floor = floor * 0.7 + level * 0.3; else floor += 0.03;
      const cur = vp();
      const threshold = cur.autoSense ? Math.min(-30, Math.max(-75, floor + 14)) : cur.threshold;
      setLvl({ level, threshold, open: level > threshold });
      r.raf = requestAnimationFrame(frame);
    };
    frame();
    setState('on');
  };
  // Hearing yourself: the microphone straight to the chosen speaker.
  useEffect(() => {
    const r = run.current;
    if (!r) return;
    if (loop && !r.el) {
      const el = new Audio();
      el.srcObject = r.stream;
      const out = vp().output;
      if (out && el.setSinkId) el.setSinkId(out).catch(() => {});
      el.play().catch(() => {});
      r.el = el;
    } else if (!loop && r.el) { r.el.srcObject = null; r.el = null; }
  }, [loop, state]);
  useEffect(() => stop, []);
  // A new microphone or processing choice restarts the test with it.
  const key = `${v.input}|${v.noise}|${v.echo}|${v.agc}`;
  const lastKey = useRef(key);
  useEffect(() => { if (lastKey.current !== key) { lastKey.current = key; if (run.current) start(); } }, [key]);

  const live = state === 'on';
  return html`<div class="vo-test">
    <${Meter} level=${live ? lvl.level : (S.call ? meter.level : -100)} threshold=${live ? lvl.threshold : meter.threshold} open=${live ? lvl.open : meter.open} showThreshold=${v.mode === 'vad'} />
    <div class="vo-test-acts">
      ${live
        ? html`<button class="btn" onClick=${() => { setLoop(false); stop(); setState('idle'); }}>Stop checking</button>
            <label class="vo-check"><input type="checkbox" checked=${loop} onChange=${(e) => setLoop(e.target.checked)} /> Hear yourself <span class="faint">(use headphones)</span></label>`
        : html`<button class="btn" disabled=${state === 'starting'} aria-busy=${String(state === 'starting')} onClick=${start}><${Icon} name="mic" size=${16} />${state === 'starting' ? 'Starting…' : 'Check your microphone'}</button>`}
    </div>
    ${err && html`<p class="vo-err" role="alert">${err}</p>`}
    ${!live && !err && html`<p class="vo-note">${S.call ? 'The bar shows your microphone in the call right now.' : 'Talk normally: the bar should move with your voice.'}</p>`}
  </div>`;
}

// ---------- Camera preview ----------

function CameraTest() {
  const v = vp();
  const [stream, setStream] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const stop = () => { setStream((s) => { s?.getTracks().forEach((t) => t.stop()); return null; }); };
  const start = async () => {
    setErr(''); setBusy(true);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: cameraConstraints({ width: { ideal: 640 }, height: { ideal: 360 } }) });
      setStream((old) => { old?.getTracks().forEach((t) => t.stop()); return s; });
    } catch (e) {
      setErr(e?.name === 'NotAllowedError' ? 'Snug needs your camera for this. Allow it in your browser’s site settings.' : e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError' ? 'That camera isn’t connected. Pick another one.' : 'Couldn’t start your camera.');
    }
    setBusy(false);
  };
  useEffect(() => () => stream?.getTracks().forEach((t) => t.stop()), [stream]);
  const lastCam = useRef(v.camera);
  useEffect(() => { if (lastCam.current !== v.camera) { lastCam.current = v.camera; if (stream) start(); } }, [v.camera]);
  const attach = (el) => { if (el && stream && el.srcObject !== stream) { el.srcObject = stream; el.play?.()?.catch(() => {}); } };
  return html`<div class="vo-cam">
    ${stream
      ? html`<video class="vo-cam-video" ref=${attach} autoplay playsinline muted aria-label="Your camera preview"></video>`
      : html`<div class="vo-cam-empty"><${Icon} name="camera" size=${24} /><span>${err || 'Your camera stays off until you check it.'}</span></div>`}
    <div class="vo-test-acts">
      ${stream ? html`<button class="btn" onClick=${stop}>Stop preview</button>`
        : html`<button class="btn" disabled=${busy} aria-busy=${String(busy)} onClick=${start}><${Icon} name="camera" size=${16} />${busy ? 'Starting…' : 'Check your camera'}</button>`}
    </div>
  </div>`;
}

// ---------- Push to talk key ----------

const keyLabel = (e) => {
  if (e.code === 'Space') return 'Space';
  if (e.code === 'Backquote') return '`';
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
  if (/^Numpad\d$/.test(e.code)) return `Num ${e.code.slice(6)}`;
  if (e.key && e.key.length === 1) return e.key.toUpperCase();
  return e.key || e.code;
};
function KeyPicker() {
  const v = vp();
  const [listening, setListening] = useState(false);
  // A layout effect, so the key is caught even if it comes before the next paint.
  useLayoutEffect(() => {
    if (!listening) return undefined;
    setCapturingKey(true);
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { setListening(false); return; }
      if (['Tab', 'Enter'].includes(e.key) && !e.code.startsWith('Numpad')) { setListening(false); return; }
      setVoice({ pttKey: e.code, pttLabel: keyLabel(e) });
      setListening(false);
    };
    addEventListener('keydown', onKey, true);
    return () => { removeEventListener('keydown', onKey, true); setCapturingKey(false); };
  }, [listening]);
  return html`<button class=${`btn vo-key${listening ? ' listening' : ''}`} aria-live="polite" aria-label=${listening ? 'Press the key for push to talk, or Escape to keep the current one' : `Push to talk key: ${v.pttLabel}. Change it`}
    onClick=${() => setListening(!listening)}>${listening ? 'Press a key…' : html`<kbd>${v.pttLabel}</kbd>Change`}</button>`;
}

// ---------- The page ----------

const AFK = [[0, 'Never'], [1, 'After 1 minute'], [5, 'After 5 minutes'], [10, 'After 10 minutes'], [30, 'After 30 minutes'], [60, 'After an hour']];

export function VoiceSettings() {
  const v = vp();
  const [devices, reread] = useDevices();
  const labelled = devices?.some((d) => d.label);
  const hasMedia = !!navigator.mediaDevices?.getUserMedia;
  const allow = async () => {
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach((t) => t.stop()); } catch { toast('Snug needs your microphone to name your devices. Allow it in your browser’s site settings.'); }
    reread();
  };
  const proc = (k) => async (on) => { setVoice({ [k]: on }); if (S.call) await restartMic(); };
  const desktop = !!window.snugApp?.setPushToTalk;
  const tuned = [...new Set([...Object.keys(v.volumes), ...Object.keys(v.muted)])].filter((id) => S.users[id]);
  return html`
    <h1>Voice and video</h1>
    <p class="lead">How you sound, what you hear and what you show, on this device. Changes apply at once, in a call too.</p>
    ${!hasMedia && html`<p class="vo-err" role="alert">This browser can’t use a microphone or camera here. Voice needs a secure (https) page.</p>`}

    <div class="set-head">Devices</div>
    ${devices && !labelled && hasMedia && html`<${Row} label="Name your devices" hint="Browsers only share device names once Snug may use the microphone.">
      <button class="btn" onClick=${allow}>Allow microphone</button>
    <//>`}
    <${Row} label="Microphone">
      <${DeviceSelect} kind="audioinput" list=${devices} value=${v.input} label="Microphone" onChange=${async (id) => { setVoice({ input: id }); if (S.call) await restartMic(); }} />
    <//>
    <${Row} label="Speaker" hint=${canPickSpeaker() ? null : 'This browser plays calls through your system’s sound output. Change it there.'}>
      ${canPickSpeaker()
        ? html`<${DeviceSelect} kind="audiooutput" list=${devices} value=${v.output} label="Speaker" onChange=${(id) => setVoice({ output: id })} />`
        : html`<span class="faint">System output</span>`}
      ${canPickSpeaker() && html`<button class="btn quiet" onClick=${() => playTestTone()}>Play a test sound</button>`}
    <//>
    <${Row} label="Microphone check" hint="See how loud you are, and hear yourself through your speaker." top><${MicTest} /><//>

    <div class="set-head">Input mode</div>
    <${Row} label="How your microphone opens">
      <${Seg} label="Input mode" value=${v.mode} onChange=${(m) => setVoice({ mode: m })} options=${[['vad', 'Voice activity'], ['ptt', 'Push to talk']]} />
    <//>
    ${v.mode === 'vad'
      ? html`
        <${Row} label="Set sensitivity automatically" hint="Snug listens to the room and opens your microphone when you talk over it.">
          <${Switch} on=${v.autoSense} label="Set sensitivity automatically" onChange=${(on) => setVoice({ autoSense: on })} />
        <//>
        ${!v.autoSense && html`<${Row} label="Sensitivity" hint="Sounds quieter than the marker are not sent. Move it left if people miss your first words." top>
          <label class="vo-range-row wide">
            <span class="vo-range-label">Open above <span class="num">${v.threshold} dB</span></span>
            <input class="vo-range" type="range" min="-100" max="0" step="1" value=${v.threshold} aria-label="Sensitivity" aria-valuetext=${`${v.threshold} decibels`}
              onInput=${(e) => setVoice({ threshold: Number(e.target.value) })} />
          </label>
        <//>`}`
      : html`
        <${Row} label="Push to talk key" hint="Hold it to talk. It works anywhere in Snug, even while typing.">
          <${KeyPicker} />
        <//>
        <${Row} label="Release delay" hint="How long your microphone stays open after you let go, so your last word isn’t cut off." top>
          <label class="vo-range-row wide">
            <span class="vo-range-label"><span class="num">${v.pttDelay} ms</span></span>
            <input class="vo-range" type="range" min="0" max="1000" step="20" value=${v.pttDelay} aria-label="Release delay" aria-valuetext=${`${v.pttDelay} milliseconds`}
              onInput=${(e) => setVoice({ pttDelay: Number(e.target.value) })} />
          </label>
        <//>
        ${desktop && html`<${Row} label="Works when Snug isn’t in front" hint="The key works in other apps too. Snug can only tell when it’s pressed, so it closes your microphone just after the presses stop.">
          <${Switch} on=${v.pttGlobal} label="Push to talk works when Snug isn’t in front" onChange=${(on) => setVoice({ pttGlobal: on })} />
        <//>`}`}

    <div class="set-head">Voice processing</div>
    <${Row} label="Noise suppression" hint="Filters out steady background sound like fans and traffic.">
      <${Switch} on=${v.noise} label="Noise suppression" onChange=${proc('noise')} />
    <//>
    <${Row} label="Echo cancellation" hint="Stops others hearing themselves through your speakers. Turn off only with headphones.">
      <${Switch} on=${v.echo} label="Echo cancellation" onChange=${proc('echo')} />
    <//>
    <${Row} label="Automatic gain" hint="Evens out your volume when you move closer or further away.">
      <${Switch} on=${v.agc} label="Automatic gain" onChange=${proc('agc')} />
    <//>

    <div class="set-head">Camera</div>
    <${Row} label="Camera">
      <${DeviceSelect} kind="videoinput" list=${devices} value=${v.camera} label="Camera" onChange=${async (id) => { setVoice({ camera: id }); await restartCamera(); }} />
    <//>
    <${Row} label="Camera check" top><${CameraTest} /><//>

    <div class="set-head">Screen share</div>
    <${Row} label="Resolution" hint="Higher shows more detail and uses more of everyone’s connection.">
      <${Seg} label="Screen share resolution" value=${v.screenRes} onChange=${(r) => { setVoice({ screenRes: r }); recapBitrates(); }} options=${Object.keys(RESOLUTIONS).map((r) => [r, r === 'source' ? 'Source' : `${r}p`])} />
    <//>
    <${Row} label="Frame rate" hint="60 suits games and video; 15 is plenty for documents.">
      <${Seg} label="Screen share frame rate" value=${v.screenFps} onChange=${(f) => { setVoice({ screenFps: f }); recapBitrates(); }} options=${FRAME_RATES.map((f) => [f, `${f} fps`])} />
    <//>
    <${Row} label="Share sound" hint="Include the sound of the tab or screen, where your browser offers it.">
      <${Switch} on=${v.screenAudio} label="Share sound with the screen" onChange=${(on) => setVoice({ screenAudio: on })} />
    <//>

    <div class="set-head">Sounds and behaviour</div>
    <${Row} label="Join and leave sounds" hint="A short chime when someone comes into or leaves your call.">
      <${Switch} on=${v.cues} label="Join and leave sounds" onChange=${(on) => setVoice({ cues: on })} />
    <//>
    <${Row} label="Mute and deafen sounds">
      <${Switch} on=${v.muteCues} label="Mute and deafen sounds" onChange=${(on) => setVoice({ muteCues: on })} />
    <//>
    <${Row} label="Deafening mutes you too" hint="When you stop hearing the room, your microphone closes as well.">
      <${Switch} on=${v.deafMutes} label="Deafening mutes you too" onChange=${(on) => setVoice({ deafMutes: on })} />
    <//>
    <${Row} label="Leave voice rooms when alone" hint="Leave a voice room after you’ve been the only one there for a while. Calls aren’t affected.">
      <select class="field" aria-label="Leave voice rooms when alone" value=${v.afk} onChange=${(e) => setVoice({ afk: Number(e.target.value) })}>
        ${AFK.map(([n, t]) => html`<option value=${n}>${t}</option>`)}
      </select>
    <//>

    ${tuned.length > 0 && html`<div class="set-head">People you’ve adjusted</div>
      ${tuned.map((id) => html`<${Row} key=${id} label=${person(id).name} hint=${v.muted[id] ? 'Muted for you' : `Volume ${Math.round((v.volumes[id] ?? 1) * 100)}%`}>
        <button class="btn quiet" onClick=${() => { setPersonVolume(id, 1); setPersonMuted(id, false); }}>Reset</button>
      <//>`)}`}`;
}

function playTestTone() {
  const c = audioCtx();
  if (!c) return;
  const o = c.createOscillator();
  const g = c.createGain();
  o.frequency.value = 660;
  g.gain.setValueAtTime(0, c.currentTime);
  g.gain.linearRampToValueAtTime(0.12, c.currentTime + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.6);
  o.connect(g); g.connect(c.destination);
  o.start(); o.stop(c.currentTime + 0.65);
}

// ---------- House settings > Voice ----------

export const MAX_SOUNDS = 24;
export const MAX_SECONDS = 5.2;
const RATE = 24000;

// Any audio file the browser can decode becomes a short mono WAV, trimmed to
// the limit. The server reads the WAV header and checks again.
export async function toWav(file) {
  const c = audioCtx();
  if (!c) throw new Error('This browser can’t read audio files here.');
  let decoded;
  try { decoded = await c.decodeAudioData(await file.arrayBuffer()); } catch { throw new Error('Snug couldn’t read that file. Choose an MP3, WAV, OGG or another audio file.'); }
  const seconds = Math.min(decoded.duration, MAX_SECONDS);
  const frames = Math.max(1, Math.floor(seconds * RATE));
  const off = new OfflineAudioContext(1, frames, RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const out = (await off.startRendering()).getChannelData(0);
  const data = new DataView(new ArrayBuffer(44 + frames * 2));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); data.setUint32(4, 36 + frames * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true); data.setUint32(24, RATE, true);
  data.setUint32(28, RATE * 2, true); data.setUint16(32, 2, true); data.setUint16(34, 16, true); w(36, 'data'); data.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) data.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, out[i])) * 32767), true);
  return { blob: new Blob([data.buffer], { type: 'audio/wav' }), seconds, trimmed: decoded.duration > MAX_SECONDS, full: decoded.duration };
}

async function upload(house, blob, name) {
  let res;
  try {
    res = await fetch(`/api/files?sound=${encodeURIComponent(house)}`, {
      method: 'POST', credentials: 'same-origin', body: blob,
      headers: { 'Content-Type': 'audio/wav', 'X-File-Name': encodeURIComponent(name) },
    });
  } catch { throw new Error('Couldn’t upload it. Check your connection and try again.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Couldn’t upload it.');
  return data;
}

const nameFrom = (f) => f.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim().slice(0, 32);

function AddSound({ house, full }) {
  const [st, setSt] = useState(null); // { status: 'reading'|'ready'|'error', file, id, seconds, trimmed, error }
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('');
  const [volume, setVolume] = useState(100);
  const [busy, setBusy] = useState(false);
  const input = useRef();
  const choose = async (file) => {
    if (!file) return;
    if (!name) setName(nameFrom(file.name));
    setSt({ status: 'reading', file: file.name });
    try {
      const wav = await toWav(file);
      const up = await upload(house, wav.blob, file.name);
      setSt({ status: 'ready', file: file.name, id: up.id, seconds: wav.seconds, trimmed: wav.trimmed, full: wav.full });
    } catch (e) { setSt({ status: 'error', file: file.name, error: e.message }); }
    if (input.current) input.current.value = '';
  };
  const reset = () => { setSt(null); setName(''); setEmoji(''); setVolume(100); };
  const add = async () => {
    setBusy(true);
    try {
      await call('sound.add', { house, file: st.id, name, emoji: emoji.trim() || null, volume: volume / 100 });
      toast(`Added ${name.trim()}.`);
      reset();
    } catch (e) { toast(e.offline ? 'You’re offline, so the sound wasn’t added.' : e.message); }
    setBusy(false);
  };
  if (full) return html`<p class="vo-note">This house has ${MAX_SOUNDS} sounds, the most it can hold. Remove one to add another.</p>`;
  const nameBad = !name.trim() ? 'Give the sound a name.' : name.trim().length > 32 ? 'Names can be at most 32 characters.' : '';
  return html`<div class="vo-add">
    <div class=${`vo-drop${st?.status === 'error' ? ' bad' : ''}`}>
      <${Icon} name="vo-sound" size=${24} />
      <div class="vo-drop-text">
        <b>${st ? st.file : 'Choose a sound'}</b>
        <span role=${st?.status === 'error' ? 'alert' : 'status'}>${!st ? `Any audio file. Snug keeps the first ${MAX_SECONDS} seconds.`
          : st.status === 'reading' ? 'Getting it ready…'
            : st.status === 'error' ? st.error
              : st.trimmed ? `${st.full.toFixed(1)} seconds long, so Snug keeps the first ${st.seconds.toFixed(1)}.` : `${st.seconds.toFixed(1)} seconds. Ready to add.`}</span>
      </div>
      <input type="file" accept="audio/*" ref=${input} class="vo-file" aria-label="Choose a sound file" onChange=${(e) => choose(e.target.files[0])} />
      <button class="btn" disabled=${st?.status === 'reading'} onClick=${() => input.current.click()}>${st ? 'Choose another' : 'Choose file'}</button>
    </div>
    ${st?.status === 'ready' && html`<div class="vo-add-form">
      <label class="vo-field"><span>Name</span><input class="field" value=${name} maxlength="40" aria-invalid=${String(!!nameBad)} onInput=${(e) => setName(e.target.value)} /></label>
      <label class="vo-field sm"><span>Emoji</span><input class="field" value=${emoji} maxlength="8" placeholder="📯" aria-label="Emoji, optional" onInput=${(e) => setEmoji(e.target.value)} /></label>
      <label class="vo-range-row"><span class="vo-range-label">Volume <span class="num">${volume}%</span></span>
        <input class="vo-range" type="range" min="0" max="100" step="5" value=${volume} aria-label="Sound volume" onInput=${(e) => setVolume(Number(e.target.value))} /></label>
      <div class="vo-add-acts">
        <button class="btn quiet" onClick=${() => preview(st.id, volume / 100).catch(() => toast('Couldn’t play it here.'))}><${Icon} name="play" size=${16} />Listen</button>
        <button class="btn primary" disabled=${!!nameBad || busy} aria-busy=${String(busy)} onClick=${add}>Add sound</button>
      </div>
      ${nameBad && name && html`<p class="vo-err" role="alert">${nameBad}</p>`}
    </div>`}
  </div>`;
}

function SoundRow({ s }) {
  const [name, setName] = useState(s.name);
  const [vol, setVol] = useState(Math.round(s.volume * 100));
  useEffect(() => { setName(s.name); setVol(Math.round(s.volume * 100)); }, [s.name, s.volume]);
  const save = (patch) => call('sound.edit', { id: s.id, ...patch }).catch((e) => { toast(e.message); setName(s.name); setVol(Math.round(s.volume * 100)); });
  const remove = () => openModal(Confirm, {
    title: `Remove ${s.name}?`, text: 'Nobody will be able to play it any more.', action: 'Remove sound', danger: true,
    onConfirm: () => call('sound.remove', { id: s.id }).catch((e) => toast(e.message)),
  });
  return html`<li class="vo-snd-row">
    <span class="vo-snd-emo lg" aria-hidden="true">${s.emoji || html`<${Icon} name="vo-sound" size=${18} />`}</span>
    <div class="vo-snd-meta">
      <input class="field" value=${name} maxlength="40" aria-label=${`Name of ${s.name}`}
        onChange=${(e) => { const n = e.target.value.trim(); if (n && n !== s.name) save({ name: n }); else setName(s.name); }} />
      <span class="faint">Added by ${person(s.by).name}</span>
    </div>
    <label class="vo-range-row sm"><span class="vo-range-label num">${vol}%</span>
      <input class="vo-range" type="range" min="0" max="100" step="5" value=${vol} aria-label=${`Volume of ${s.name}`}
        onInput=${(e) => setVol(Number(e.target.value))} onChange=${(e) => save({ volume: Number(e.target.value) / 100 })} /></label>
    <button class="ib" aria-label=${`Listen to ${s.name}`} data-tip="Listen" onClick=${() => preview(s.file, vol / 100).catch(() => toast('Couldn’t play it here.'))}><${Icon} name="play" /></button>
    <button class="ib" aria-label=${`Remove ${s.name}`} data-tip="Remove" onClick=${remove}><${Icon} name="trash" /></button>
  </li>`;
}

const LIMITS = [[0, 'No limit'], ...Array.from({ length: 12 }, (_, i) => [i + 1, `${i + 1} ${i ? 'people' : 'person'}`])];
const BITRATES = [8, 16, 24, 32, 48, 64, 96, 128];

export function HouseVoice({ house }) {
  const h = S.houses[house];
  const list = S.sounds?.[house] || [];
  const manageSounds = can(S, house, 'sounds');
  const manageRooms = can(S, house, 'rooms');
  const voiceRooms = roomIds(S, house).filter((id) => S.rooms[id]?.kind === 'voice');
  const setRoom = (room, patch) => call('room.voice', { room, ...patch }).catch((e) => toast(e.message));
  return html`
    <h1>Voice</h1>
    <p class="lead">Sounds anyone in a voice room can play for everyone there, and how many people each voice room holds.</p>
    ${manageSounds && html`
      <div class="set-head">Soundboard <span class="faint" style="font-weight:400">${list.length} of ${MAX_SOUNDS}</span></div>
      <${Row} label="Everyone can play sounds" hint="Off: only roles with “Use the soundboard” or “Manage sounds” can.">
        <${Switch} on=${h.soundOpen !== false} label="Everyone can play sounds" onChange=${(on) => call('house.soundboard', { house, open: on }).catch((e) => toast(e.message))} />
      <//>
      <${AddSound} house=${house} full=${list.length >= MAX_SOUNDS} />
      ${list.length
        ? html`<ul class="vo-snd-list">${list.map((s) => html`<${SoundRow} key=${s.id} s=${s} />`)}</ul>`
        : html`<p class="vo-note">No sounds yet. Short ones work best: a cheer, a drum roll, a door bell.</p>`}`}
    ${manageRooms && html`
      <div class="set-head">Voice rooms</div>
      ${voiceRooms.length ? voiceRooms.map((id) => html`<${Row} key=${id} label=${S.rooms[id].name} hint="User limit, and the audio quality everyone sends. Lower bitrates suit weak connections.">
        <select class="field" aria-label=${`User limit for ${S.rooms[id].name}`} value=${S.rooms[id].limit || 0} onChange=${(e) => setRoom(id, { limit: Number(e.target.value) })}>
          ${LIMITS.map(([n, t]) => html`<option value=${n}>${t}</option>`)}
        </select>
        <select class="field" aria-label=${`Bitrate for ${S.rooms[id].name}`} value=${S.rooms[id].bitrate || 64} onChange=${(e) => setRoom(id, { bitrate: Number(e.target.value) })}>
          ${BITRATES.map((b) => html`<option value=${b}>${b} kbps</option>`)}
        </select>
      <//>`) : html`<p class="vo-note">This house has no voice rooms yet.</p>`}`}`;
}
