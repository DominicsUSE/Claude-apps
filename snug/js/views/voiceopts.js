// Voice options on screen, while in a call or a voice room: each person's
// volume and a mute only you hear, the soundboard, the options menu (input
// mode, screen share quality), a hold-to-talk button, the floating call that
// stays with you while you look elsewhere, and popping a shared screen out
// into its own picture-in-picture window. Also the background work: push to
// talk keys (and the desktop app's global shortcut), join and leave sounds,
// leaving a voice room after a while alone, and who just played a sound.
import { html, useRef, useState, useEffect } from '../../vendor/preact-htm.js';
import { S, emit, toast, person, openPop, closePop, openMenu, openConv, convMeta, subscribe } from '../store.js';
import { call, on } from '../server.js';
import { can } from '../lib/perms.js';
import { Icon, addIcons } from '../ui/icons.js';
import { Avatar } from '../ui/kit.js';
import { leaveVoice, toggleMute, toggleDeaf, mediaOf, recapBitrates } from '../voice.js';
import {
  vp, setVoice, volumeOf, mutedForMe, setPersonVolume, setPersonMuted, pttPress, pttRelease, pttHeld,
  playIntoCall, cue, RESOLUTIONS, FRAME_RATES,
} from '../voiceopts.js';

addIcons({
  'vo-sound': 'M4 8v4h3l4 3.5v-11L7 8H4Z|M14 7.5a3.5 3.5 0 0 1 0 5|M16 5a7 7 0 0 1 0 10',
  'vo-sound-off': 'M4 8v4h3l4 3.5v-11L7 8H4Z|M14 8l4 4|M18 8l-4 4',
  'vo-board': 'M4 4h5v5H4z|M11 4h5v5h-5z|M4 11h5v5H4z|M11 11h5v5h-5z',
  'vo-pip': 'M3.5 5.5A1.5 1.5 0 0 1 5 4h10a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 15 16H5a1.5 1.5 0 0 1-1.5-1.5Z|M10.5 10.5h4v3.5h-4z',
  'vo-grip': 'M7.5 5v.2|M12.5 5v.2|M7.5 10v.2|M12.5 10v.2|M7.5 15v.2|M12.5 15v.2',
  'vo-talk': 'M10 3a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 10 3Z|M5 9.5a5 5 0 0 0 10 0|M10 14.5V17',
});

const first = (id) => person(id).name.split(' ')[0];
const rectOf = (e) => e.currentTarget.getBoundingClientRect();
const pct = (n) => `${Math.round(n * 100)}%`;
const houseOfCall = () => (S.call && S.rooms[S.call.room]?.house) || null;

// ---------- Each person: volume and a mute only I hear ----------

function PersonAudio({ id }) {
  const v = volumeOf(id);
  const m = mutedForMe(id);
  const name = person(id).name;
  return html`<div class="vo-pa">
    <div class="vo-pa-head"><${Avatar} user=${person(id)} size=${32} /><b class="trunc">${name}</b></div>
    <label class="vo-range-row">
      <span class="vo-range-label">Volume <span class="num" aria-hidden="true">${pct(v)}</span></span>
      <input class="vo-range" type="range" min="0" max="200" step="5" value=${Math.round(v * 100)} data-autofocus
        aria-label=${`${name}’s volume`} aria-valuetext=${pct(v)} disabled=${m}
        onInput=${(e) => setPersonVolume(id, Number(e.target.value) / 100)} />
    </label>
    <div class="vo-pa-acts">
      <button class=${`btn${m ? ' danger' : ''}`} aria-pressed=${String(m)} onClick=${() => setPersonMuted(id, !m)}>
        <${Icon} name=${m ? 'vo-sound-off' : 'vo-sound'} size=${16} />${m ? `Unmute ${first(id)}` : `Mute ${first(id)} for me`}
      </button>
      ${v !== 1 && html`<button class="btn quiet" onClick=${() => setPersonVolume(id, 1)}>Reset</button>`}
    </div>
    <p class="vo-note">Only you hear this change. Snug remembers it for ${first(id)}.</p>
  </div>`;
}

// Beside each person in a call: their volume, and the sound they just played.
export function PersonExtras({ id, room }) {
  const played = S.soundNow && S.soundNow.user === id && S.soundNow.room === room ? S.soundNow : null;
  const chip = played && html`<span class="vo-played" role="status">${played.emoji ? `${played.emoji} ` : ''}${played.name}</span>`;
  if (id === S.me || S.call?.room !== room) return chip;
  const v = volumeOf(id);
  const m = mutedForMe(id);
  const label = m ? `${person(id).name} is muted for you` : v !== 1 ? `${person(id).name}’s volume, ${pct(v)}` : `${person(id).name}’s volume`;
  return html`${chip}<button class=${`ib sm vo-vol${m || v !== 1 ? ' on' : ''}`} aria-label=${label} data-tip=${m ? 'Muted for you' : v !== 1 ? pct(v) : 'Volume'} aria-haspopup="dialog"
    onClick=${(e) => openPop({ anchor: rectOf(e), label: `${person(id).name}’s volume`, C: PersonAudio, props: { id } })}><${Icon} name=${m ? 'vo-sound-off' : 'vo-sound'} size=${14} /></button>`;
}

// A voice room's user limit, beside the count on the stage.
export function RoomLimit({ room, n }) {
  const lim = S.rooms[room]?.limit;
  if (!lim) return null;
  return html`<span class=${`vo-limit${n >= lim ? ' full' : ''}`} aria-label=${n >= lim ? `Full: ${lim} at most` : `${lim} at most`}>${n >= lim ? 'Full' : `of ${lim}`}</span>`;
}

// ---------- Soundboard ----------

let cooldownUntil = 0;
export async function playSound(s) {
  if (Date.now() < cooldownUntil) { toast('Wait a moment before the next sound.'); return false; }
  try {
    const r = await call('sound.play', { id: s.id });
    cooldownUntil = Date.now() + (r.cooldown || 3000);
    await playIntoCall(r.file, r.volume);
    emit();
    return true;
  } catch (e) {
    toast(e.offline ? 'You’re offline, so the sound didn’t play.' : e.message);
    return false;
  }
}
const mayUseBoard = (house) => !!S.houses[house] && (S.houses[house].soundOpen !== false || can(S, house, 'soundboard') || can(S, house, 'sounds'));

function Soundboard({ house }) {
  const list = S.sounds?.[house] || [];
  const c = S.call;
  const why = !c ? 'Join a voice room to play sounds.'
    : (c.muted || c.deaf) ? 'Unmute to play sounds.'
      : !mayUseBoard(house) ? 'This house keeps the soundboard to some roles.' : null;
  const manage = can(S, house, 'sounds');
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => Date.now() < cooldownUntil + 200 && tick((n) => n + 1), 250); return () => clearInterval(t); }, []);
  const cooling = Date.now() < cooldownUntil;
  return html`<div class="vo-board">
    <div class="vo-board-head"><b>Soundboard</b><span class="faint">${S.houses[house]?.name}</span></div>
    ${why && html`<p class="vo-note" role="status">${why}</p>`}
    ${list.length
      ? html`<div class="vo-board-grid" role="group" aria-label="Sounds">
          ${list.map((s, i) => html`<button key=${s.id} class="vo-snd" disabled=${!!why || cooling} data-autofocus=${i === 0 ? '' : undefined}
            aria-label=${`Play ${s.name} for everyone`} onClick=${() => playSound(s)}>
            <span class="vo-snd-emo" aria-hidden="true">${s.emoji || html`<${Icon} name="vo-sound" size=${16} />`}</span><span class="trunc">${s.name}</span>
          </button>`)}
        </div>`
      : html`<div class="vo-board-empty"><${Icon} name="vo-board" size=${24} /><b>No sounds yet</b>
          <span>${manage ? 'Add short sounds for this house, then play them for everyone in voice.' : 'People who manage sounds here can add some.'}</span></div>`}
    ${cooling && !why && html`<p class="vo-note" role="status">One sound every few seconds.</p>`}
    ${manage && html`<button class="btn quiet block" onClick=${() => { closePop(); openHouseVoice(house); }}><${Icon} name="plus" size=${16} />${list.length ? 'Manage sounds' : 'Add sounds'}</button>`}
  </div>`;
}

let openHouseVoice = () => {};
export function setHouseVoiceOpener(fn) { openHouseVoice = fn; }
let openVoiceSettings = () => {};
export function setVoiceSettingsOpener(fn) { openVoiceSettings = fn; }

// ---------- Extra controls on the stage ----------

function holdHandlers() {
  const down = (e) => { e.preventDefault(); e.currentTarget.setPointerCapture?.(e.pointerId); pttPress('button'); };
  const up = () => pttRelease('button');
  return {
    onPointerDown: down, onPointerUp: up, onPointerCancel: up, onLostPointerCapture: up,
    onKeyDown: (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); pttPress('button'); } },
    onKeyUp: (e) => { if (e.key === ' ' || e.key === 'Enter') pttRelease('button'); },
  };
}

function optionsMenu(e) {
  const v = vp();
  openMenu({
    anchor: rectOf(e), align: 'end',
    items: [
      { heading: 'Your microphone' },
      { label: 'Voice activity', checked: v.mode === 'vad', onSelect: () => setVoice({ mode: 'vad' }) },
      { label: `Push to talk (${v.pttLabel})`, checked: v.mode === 'ptt', onSelect: () => setVoice({ mode: 'ptt' }) },
      { sep: true },
      { heading: 'Screen share quality' },
      ...Object.keys(RESOLUTIONS).map((r) => ({ label: r === 'source' ? 'Source resolution' : `${r}p`, checked: v.screenRes === r, onSelect: () => { setVoice({ screenRes: r }); recapBitrates(); } })),
      ...FRAME_RATES.map((f) => ({ label: `${f} frames a second`, checked: v.screenFps === f, onSelect: () => { setVoice({ screenFps: f }); recapBitrates(); } })),
      { label: 'Share sound with the screen', checked: !!v.screenAudio, onSelect: () => setVoice({ screenAudio: !v.screenAudio }) },
      { sep: true },
      { label: 'Voice and video settings', icon: 'sliders', onSelect: () => openVoiceSettings() },
    ],
  });
}

export function VoiceExtras({ compact }) {
  const c = S.call;
  if (!c || c.status !== 'live') return null;
  const v = vp();
  const house = houseOfCall();
  const ptt = v.mode === 'ptt';
  const held = pttHeld();
  return html`
    ${ptt && !compact && html`<button class=${`btn vo-hold${held ? ' live' : ''}`} aria-pressed=${String(held)} aria-label=${`Hold to talk, or hold ${v.pttLabel}`} ...${holdHandlers()}>
      <${Icon} name="vo-talk" size=${16} />${held ? 'Talking' : 'Hold to talk'}</button>`}
    ${house && !compact && html`<button class="ib vc vo-board-btn" aria-label="Soundboard" data-tip="Soundboard" aria-haspopup="dialog"
      onClick=${(e) => openPop({ anchor: rectOf(e), label: 'Soundboard', C: Soundboard, props: { house } })}><${Icon} name="vo-board" size=${20} /></button>`}
    ${!compact && html`<button class="ib vc vo-opts" aria-label="Voice options" data-tip="Voice options" aria-haspopup="menu" onClick=${optionsMenu}><${Icon} name="sliders" size=${20} /></button>`}`;
}

// ---------- Picture in picture for a shared screen or a camera ----------

export const canPopOut = () => typeof window !== 'undefined' && (!!window.documentPictureInPicture || !!document.pictureInPictureEnabled);
async function popOut(video, title) {
  if (!video?.srcObject) return;
  try {
    if (window.documentPictureInPicture) {
      const w = await window.documentPictureInPicture.requestWindow({ width: 640, height: 360 });
      w.document.title = title;
      w.document.body.style.cssText = 'margin:0;background:#0E0F10;display:grid;height:100vh';
      const v = w.document.createElement('video');
      v.autoplay = true; v.muted = true; v.playsInline = true;
      v.style.cssText = 'width:100%;height:100%;object-fit:contain';
      v.srcObject = video.srcObject;
      w.document.body.append(v);
      v.play().catch(() => {});
      return;
    }
    if (document.pictureInPictureElement === video) { await document.exitPictureInPicture(); return; }
    await video.requestPictureInPicture();
  } catch { toast('This browser couldn’t open a picture-in-picture window.'); }
}
// A button on a video tile: pop it out into a window that stays on top.
export function PopOut({ t }) {
  if (!t?.stream || !canPopOut()) return null;
  const who = t.id === S.me ? 'your' : `${first(t.id)}’s`;
  const what = t.kind === 'screen' ? `${who} screen` : `${who} camera`;
  return html`<button class="ib vt-pip" aria-label=${`Pop out ${what}`} data-tip="Picture in picture"
    onClick=${(e) => popOut(e.currentTarget.closest('.vt, .vo-mini')?.querySelector('video'), what)}><${Icon} name="vo-pip" size=${18} /></button>`;
}

// ---------- The floating call ----------

function Video({ stream, label }) {
  const attach = (el) => { if (el && el.srcObject !== stream) { el.srcObject = stream; el.play?.()?.catch(() => {}); } };
  return html`<video class="vo-mini-video" ref=${attach} autoplay playsinline muted aria-label=${label}></video>`;
}

const clampPos = (x, y, w, h) => ({
  x: Math.max(8, Math.min(innerWidth - w - 8, x)),
  y: Math.max(8, Math.min(innerHeight - h - 8, y)),
});

// While I'm in a call and looking at something else, the call stays with me:
// who is talking, a shared screen or camera if there is one, and the controls.
export function MiniCall() {
  const ref = useRef();
  const drag = useRef(null);
  const [pos, setPos] = useState(() => vp().mini);
  const [, relayout] = useState(0);
  useEffect(() => { const f = () => relayout((n) => n + 1); addEventListener('resize', f); return () => removeEventListener('resize', f); }, []);
  const c = S.call;
  const v = S.ui.view;
  if (!c || c.status !== 'live' || S.ui.miniHidden === c.room || (v.type === 'conv' && v.id === c.room)) return null;
  const room = S.rooms[c.room];
  const meta = room ? null : convMeta(c.room);
  if (!room && !meta) return null;
  const title = room ? room.name : meta.title;
  const ids = (S.voice[c.room] || []).filter((id) => S.users[id]);
  // A shared screen first, then a camera, else faces.
  let shown = null;
  for (const id of ids) {
    const m = mediaOf(id);
    if (m.screen) { shown = { id, kind: 'screen', stream: m.screen }; break; }
  }
  if (!shown) for (const id of ids) { const m = mediaOf(id); if (m.camera && id !== S.me) { shown = { id, kind: 'camera', stream: m.camera }; break; } }

  const w = ref.current?.offsetWidth || 288, h = ref.current?.offsetHeight || 160;
  const p = pos ? clampPos(pos.x, pos.y, w, h) : null;
  const style = p ? `left:${p.x}px;top:${p.y}px;right:auto;bottom:auto` : '';
  const save = (np) => { setPos(np); setVoice({ mini: np }); };
  const onDown = (e) => {
    if (e.button !== 0) return;
    const r = ref.current.getBoundingClientRect();
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e) => {
    const d = drag.current;
    if (!d) return;
    d.moved = true;
    setPos(clampPos(e.clientX - d.dx, e.clientY - d.dy, ref.current.offsetWidth, ref.current.offsetHeight));
  };
  const onUp = () => { const d = drag.current; drag.current = null; if (d?.moved && ref.current) { const r = ref.current.getBoundingClientRect(); save({ x: r.left, y: r.top }); } };
  const onKey = (e) => {
    const step = e.shiftKey ? 64 : 16;
    const dir = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!dir) return;
    e.preventDefault();
    const r = ref.current.getBoundingClientRect();
    save(clampPos(r.left + dir[0], r.top + dir[1], r.width, r.height));
  };
  const leave = c.dm ? 'Leave call' : 'Leave voice';
  return html`<div class="vo-mini float" ref=${ref} style=${style} role="region" aria-label=${`${c.dm ? 'Call' : 'Voice'}: ${title}`}>
    <div class="vo-mini-head">
      <button class="vo-mini-grip" aria-label="Move the call window. Use the arrow keys." data-tip="Drag to move"
        onPointerDown=${onDown} onPointerMove=${onMove} onPointerUp=${onUp} onPointerCancel=${onUp} onKeyDown=${onKey}><${Icon} name="vo-grip" size=${16} /></button>
      <button class="vo-mini-title" onClick=${() => openConv(c.room)} aria-label=${`Back to ${title}`}>
        <${Icon} name=${room ? 'voice' : 'phone'} size=${16} /><span class="trunc">${title}</span><span class="faint num">${ids.length}</span>
      </button>
      <button class="ib sm" aria-label="Hide the call window" data-tip="Hide" onClick=${() => { S.ui.miniHidden = c.room; emit(); }}><${Icon} name="x" size=${16} /></button>
    </div>
    ${shown
      ? html`<div class="vo-mini-media"><${Video} stream=${shown.stream} label=${`${shown.id === S.me ? 'Your' : `${first(shown.id)}’s`} ${shown.kind}`} />
          <${PopOut} t=${shown} /></div>`
      : html`<div class="vo-mini-faces">
          ${ids.slice(0, 6).map((id) => {
            const st = id === S.me ? c : (S.voiceState[c.room]?.[id] || {});
            const talking = !!S.speaking[id] && !st.muted;
            return html`<span class="vo-mini-face" key=${id} title=${person(id).name}><${Avatar} user=${person(id)} size=${32} speaking=${talking} />
              ${st.muted && html`<span class="vo-mini-muted" role="img" aria-label=${`${first(id)} is muted`}><${Icon} name="mic-off" size=${10} /></span>`}</span>`;
          })}
          ${ids.length > 6 && html`<span class="vo-mini-more num">+${ids.length - 6}</span>`}
        </div>`}
    <div class="vo-mini-acts">
      <button class=${`ib vc${c.muted ? ' on' : ''}`} aria-pressed=${String(c.muted)} aria-label=${c.muted ? 'Unmute' : 'Mute'} data-tip=${c.muted ? 'Unmute' : 'Mute'} onClick=${toggleMute}><${Icon} name=${c.muted ? 'mic-off' : 'mic'} size=${18} /></button>
      <button class=${`ib vc${c.deaf ? ' on' : ''}`} aria-pressed=${String(c.deaf)} aria-label=${c.deaf ? 'Hear the room again' : 'Stop hearing the room'} data-tip=${c.deaf ? 'Hear again' : 'Deafen'} onClick=${toggleDeaf}><${Icon} name=${c.deaf ? 'ear-off' : 'ear'} size=${18} /></button>
      <button class="btn quiet grow" onClick=${() => openConv(c.room)}>Back to ${c.dm ? 'call' : 'voice'}</button>
      <button class="ib vc danger" aria-label=${leave} data-tip=${c.dm ? 'Hang up' : 'Leave'} onClick=${leaveVoice}><${Icon} name="leave" size=${18} /></button>
    </div>
  </div>`;
}

// ---------- Background work ----------

// Push to talk from the keyboard, while Snug has focus. The key keeps working
// in text boxes too (it still types), like a walkie-talkie button would.
let capturingKey = false;
export function setCapturingKey(on) { capturingKey = on; }
const pttActive = () => S.call?.status === 'live' && vp().mode === 'ptt';
document.addEventListener('keydown', (e) => {
  if (capturingKey || e.repeat || !pttActive() || e.code !== vp().pttKey) return;
  pttPress('key');
}, true);
document.addEventListener('keyup', (e) => { if (e.code === vp().pttKey) pttRelease('key'); }, true);
// Without focus there's no key-up to wait for: let go now (the desktop app's global key takes over).
addEventListener('blur', () => pttRelease('key', 0));

// The desktop app: a global shortcut, so the key works while another app is in
// front. The system only reports presses (and repeats while held), so the
// microphone stays open while presses keep coming and closes shortly after.
const ACCEL = (code) => {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F\d{1,2}$/.test(code)) return code;
  if (/^Numpad\d$/.test(code)) return `num${code.slice(6)}`;
  return {
    Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: '\'',
    Comma: ',', Period: '.', Slash: '/', Space: 'Space', CapsLock: 'Capslock', ScrollLock: 'Scrolllock', Pause: 'Pause',
    Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  }[code] || null;
};
export const accelFor = ACCEL;
let globalKey = null;
let globalTimer = null;
function syncGlobal() {
  const app = window.snugApp;
  if (!app?.setPushToTalk) return;
  const v = vp();
  const want = pttActive() && v.pttGlobal ? ACCEL(v.pttKey) : null;
  if (want === globalKey) return;
  globalKey = want;
  app.setPushToTalk(want).then((ok) => {
    if (want && ok === false && globalKey === want) toast(`Another app is using ${v.pttLabel}, so push to talk only works while Snug is in front.`);
  }).catch(() => {});
}
window.snugApp?.onPushToTalk?.(() => {
  if (!pttActive()) return;
  pttPress('global');
  clearTimeout(globalTimer);
  // Long enough to bridge the pause before a held key starts repeating.
  globalTimer = setTimeout(() => pttRelease('global'), 650);
});

// Join and leave sounds for other people; leaving after a while alone.
const lastUsers = new Map();
on('voice', ({ room, users }) => {
  const before = lastUsers.get(room) || null;
  lastUsers.set(room, users);
  if (!before || S.call?.room !== room || S.call.status !== 'live' || !users.includes(S.me)) return;
  const others = (l) => l.filter((u) => u !== S.me);
  const came = others(users).filter((u) => !before.includes(u));
  const went = others(before).filter((u) => !users.includes(u));
  if (came.length) cue('join'); else if (went.length) cue('leave');
});
on('open', () => { lastUsers.clear(); for (const [r, u] of Object.entries(S.voice)) lastUsers.set(r, u); });

let aloneSince = 0;
setInterval(() => {
  const c = S.call;
  const mins = vp().afk;
  if (!c || c.dm || c.status !== 'live' || !mins) { aloneSince = 0; return; }
  const alone = !(S.voice[c.room] || []).some((u) => u !== S.me);
  if (!alone) { aloneSince = 0; return; }
  aloneSince ||= Date.now();
  if (Date.now() - aloneSince >= mins * 60_000) {
    const name = S.rooms[c.room]?.name || 'voice';
    aloneSince = 0;
    leaveVoice();
    toast(`You left ${name} after ${mins} ${mins === 1 ? 'minute' : 'minutes'} on your own.`);
  }
}, 5000);

// Who just played a sound, for a few seconds beside their name.
let soundTimer = null;
on('sound.play', (d) => {
  if (!d || typeof d !== 'object' || typeof d.user !== 'string') return;
  S.soundNow = { room: d.room, user: d.user, name: String(d.name || '').slice(0, 32), emoji: d.emoji || null, at: Date.now() };
  clearTimeout(soundTimer);
  soundTimer = setTimeout(() => { S.soundNow = null; emit(); }, 3000);
});
// The house's sounds changed.
on('sounds', (d) => {
  if (!d || typeof d.house !== 'string' || !Array.isArray(d.list)) return;
  S.sounds = { ...(S.sounds || {}), [d.house]: d.list };
});

// Things that follow the call: the global key, the room's bitrate, a floating call shown again for a new call.
let lastRoom = null;
let lastBitrate = null;
subscribe(() => {
  syncGlobal();
  const room = S.call?.room || null;
  if (room !== lastRoom) { lastRoom = room; if (S.ui.miniHidden && S.ui.miniHidden !== room) S.ui.miniHidden = null; }
  const br = room && S.rooms[room]?.bitrate;
  if (br && br !== lastBitrate && S.call?.status === 'live') { lastBitrate = br; recapBitrates(); }
});
