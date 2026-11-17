// The voice stage, shared by voice rooms and calls in direct conversations and
// groups: the tiles (faces, cameras, shared screens), the status line and the
// call's controls. Mounted by js/views/conversation.js. State and media live in
// js/voice.js; this file only draws them.
//
// Layout (css/calls.css, "The voice stage"):
//   status line  who is here, how the connection is, encryption, push to talk, the clock
//   body         tiles, or a shared screen large with the others in a strip
//   control bar  [mic, sound, hold to talk] [camera, screen] [activities, react,
//                sounds] [people, options] [leave]
// Desktop: the stage can fold to one line (remembered per room on this device),
// and over a camera or a screen the bar fades after a few still seconds; any
// movement, tap or key brings it back, and it never fades while it has focus.
// Phone: in a call the stage fills the screen with the bar at the bottom,
// within thumb reach; "Chat" folds it to a strip above the room's messages.
import { html, useState, useEffect, useRef } from '../../vendor/preact-htm.js';
import { S, emit, toast, person, openPop } from '../store.js';
import { nameList } from '../lib/util.js';
import { Icon } from '../ui/icons.js';
import { Avatar, EmptyState, Spinner } from '../ui/kit.js';
import { StageMod } from './safety.js'; // voice moderation on the stage
import { joinVoice, leaveVoice, toggleMute, toggleDeaf } from '../voice.js';
import { leavingCall } from '../calls.js';
import { toggleCamera, toggleScreen, mediaOf, canShareScreen } from '../voice.js';
import { PersonExtras, PersonAudio, RoomLimit, VoiceExtras, PopOut } from './voiceopts.js'; // per-person volume, room limit, soundboard and options, picture in picture
// Activities, reactions, the muted note, the call clock, connection quality, ringing again (voice and calls track).
import { ActivityButtons, ActivityTile, ReactionFloat, ActivityAnnouncer, MutedBanner, CallTimer, ConnHeader, RingAgain, Bars, qualityOf, QLABEL } from './activities.js';
import { videoBlocked, cameraPaused, showCamera, lineOf, connectsDirectly } from '../voice.js'; // data saver's paused cameras, how each line goes (relay or not)
import { vp, volumeOf, mutedForMe, pttHeld } from '../voiceopts.js';

const firstOf = (id) => (id === S.me ? 'You' : (S.users[id]?.name || 'Someone').split(' ')[0]);
const rectOf = (e) => e.currentTarget.getBoundingClientRect();

// ---------- Folding the stage (remembered per room, on this device) ----------
const FOLD_KEY = 'snug.stageFold';
let folds = null;
function foldsNow() {
  if (folds) return folds;
  try { folds = JSON.parse(localStorage.getItem(FOLD_KEY) || '{}') || {}; } catch { folds = {}; }
  return folds;
}
export const isFolded = (room) => !!foldsNow()[room];
export function setFolded(room, on) {
  const next = { ...foldsNow() };
  if (on) next[room] = 1; else delete next[room];
  folds = next;
  try { localStorage.setItem(FOLD_KEY, JSON.stringify(next)); } catch { /* private window: this visit only */ }
  emit();
}

// ---------- The call's controls ----------
// On the stage: one bar in groups, each control with its word under it where
// there is room (css/calls.css shows the words by the stage's width).
// Compact (the shell's dock and a folded stage): mic, deafen, a camera or
// screen that is on, leave.
export function VoiceControls({ compact }) {
  const c = S.call;
  const size = compact ? 18 : 20;
  const leave = c.dm ? 'Leave call' : 'Leave voice';
  // Listening without a microphone: the button adds one.
  const micLabel = c.listen ? 'Turn on your microphone' : c.muted ? 'Unmute' : 'Mute';
  const mic = html`<button class=${`ib vc mic main${c.muted ? ' on' : ''}${c.listen ? ' listen' : ''}`} aria-pressed=${String(c.muted)} aria-label=${micLabel} data-tip=${micLabel} onClick=${toggleMute}><${Icon} name=${c.muted ? 'mic-off' : 'mic'} size=${size} /><span class="vc-word" aria-hidden="true">${c.listen ? 'Talk' : c.muted ? 'Unmute' : 'Mute'}</span></button>`;
  const ear = html`<button class=${`ib vc ear main${c.deaf ? ' on' : ''}`} aria-pressed=${String(c.deaf)} aria-label=${c.deaf ? 'Hear the room again' : 'Stop hearing the room'} data-tip=${c.deaf ? 'Hear the room again' : 'Stop hearing the room'} onClick=${toggleDeaf}><${Icon} name=${c.deaf ? 'headphones-off' : 'headphones'} size=${size} /><span class="vc-word" aria-hidden="true">${c.deaf ? 'Sound off' : 'Sound'}</span></button>`;
  const out = html`<button class="ib vc danger leave main" aria-label=${leave} data-tip=${c.dm ? 'Hang up' : 'Leave'} onClick=${leaveVoice}><${Icon} name="phone-off" size=${size} /><span class="vc-word" aria-hidden="true">${c.dm ? 'Hang up' : 'Leave'}</span></button>`;
  if (compact) return html`${mic}${ear}<${MediaControls} c=${c} size=${size} compact />${out}`;
  // Phone: one row (mic, deafen, camera, screen, More, leave); More opens the
  // rest (activities, reactions, soundboard, people, options) above it.
  if (S.ui.phone) return html`<${PhoneControls} mic=${mic} ear=${ear} out=${out} c=${c} size=${size} />`;
  return html`
    <span class="vc-group" role="group" aria-label="Your microphone and sound">${mic}${ear}<${VoiceExtras} only="hold" /></span>
    <span class="vc-group" role="group" aria-label="Camera and screen"><${MediaControls} c=${c} size=${size} /></span>
    <span class="vc-group" role="group" aria-label="Together"><${ActivityButtons} /><${VoiceExtras} only="board" /></span>
    <span class="vc-group" role="group" aria-label="People and options"><${PeopleButton} c=${c} size=${size} /><${VoiceExtras} only="opts" /></span>
    ${out}`;
}

function PhoneControls({ mic, ear, out, c, size }) {
  const [more, setMore] = useState(false);
  const ptt = vp().mode === 'ptt' && !c.listen;
  return html`
    ${ptt && html`<div class="vc-hold-row"><${VoiceExtras} only="hold" /></div>`}
    ${more && html`<div class="vc-more-row" role="group" aria-label="Other call controls">
      <${ActivityButtons} /><${VoiceExtras} only="board" /><${PeopleButton} c=${c} size=${size} /><${VoiceExtras} only="opts" />
    </div>`}
    ${mic}${ear}<${MediaControls} c=${c} size=${size} />
    <button class=${`ib vc vc-more main${more ? ' open' : ''}`} aria-expanded=${String(more)} aria-label="More call controls" data-tip="More" onClick=${() => setMore(!more)}><${Icon} name="more" size=${size} /><span class="vc-word" aria-hidden="true">More</span></button>
    ${out}`;
}

// ---------- Who is in the call ----------
// A list of everyone here with what they're doing, and each person's volume:
// the same as the tiles, in one place you can read top to bottom.
function PeopleButton({ c, size }) {
  if (c.status !== 'live') return null;
  const n = (S.voice[c.room] || []).filter((id) => S.users[id]).length;
  return html`<button class="ib vc vc-people" aria-haspopup="dialog" aria-label=${`People in the call, ${n}`} data-tip="People in the call"
    onClick=${(e) => openPop({ anchor: rectOf(e), label: 'People in the call', C: PeoplePop, props: { room: c.room } })}><${Icon} name="people" size=${size} /><span class="vc-word" aria-hidden="true">People</span></button>`;
}

function stateOf(id, room, inCall) {
  const mine = id === S.me;
  const st = (mine && inCall ? S.call : S.voiceState[room]?.[id]) || {};
  return { st, quiet: mine ? !!S.call?.muted : !!st.muted, deaf: mine ? !!S.call?.deaf : !!st.deaf };
}
// What a screen reader hears for one person: the same facts the tile shows.
function personWords(id, room, inCall, note) {
  const { st, quiet, deaf } = stateOf(id, room, inCall);
  const talking = !!S.speaking[id] && !quiet;
  const bits = [id === S.me ? 'You' : S.users[id]?.name || 'Someone'];
  if (talking) bits.push('speaking');
  if (deaf) bits.push('not listening');
  else if (quiet) bits.push('muted');
  if (st.listen) bits.push('listening without a microphone');
  if (st.camera) bits.push('camera on');
  if (st.screen) bits.push('sharing their screen');
  if (inCall && id !== S.me && !note) bits.push(QLABEL[qualityOf(id)].toLowerCase());
  if (note) bits.push(note.replace(/…$/, ''));
  return bits.join(', ');
}

function PeoplePop({ room }) {
  const ids = (S.voice[room] || []).filter((id) => S.users[id]);
  const inCall = S.call?.room === room;
  return html`<div class="stage-plist">
    <b class="stage-plist-title">${ids.length === 1 ? 'Only you' : `${ids.length} in the call`}</b>
    <ul class="stage-plist-rows">
      ${ids.map((id, i) => {
        const { st, quiet, deaf } = stateOf(id, room, inCall);
        const talking = !!S.speaking[id] && !quiet;
        const v = volumeOf(id);
        const m = mutedForMe(id);
        return html`<li class=${`stage-prow${talking ? ' talking' : ''}`} key=${id}>
          <${Avatar} user=${person(id)} size=${32} speaking=${talking} />
          <span class="stage-prow-name">
            <span class="trunc">${id === S.me ? `${person(id).name} (you)` : person(id).name}</span>
            <span class="stage-prow-state">${talking ? 'Speaking' : deaf ? 'Not listening' : quiet ? 'Muted' : st.listen ? 'Listening only' : 'Here'}${st.camera ? ' · Camera on' : ''}${st.screen ? ' · Sharing their screen' : ''}</span>
          </span>
          ${quiet && html`<span class="stage-prow-ic off" role="img" aria-label=${deaf ? 'Not listening' : 'Muted'}><${Icon} name=${deaf ? 'headphones-off' : 'mic-off'} size=${16} /></span>`}
          ${inCall && id !== S.me && html`<${Bars} q=${qualityOf(id)} label=${QLABEL[qualityOf(id)]} />`}
          ${inCall && id !== S.me && html`<button class=${`btn sm stage-prow-vol${m || v !== 1 ? ' on' : ''}`} data-autofocus=${i === 0 || (i === 1 && ids[0] === S.me) ? '' : undefined}
            aria-label=${`${person(id).name}’s volume${m ? ', muted for you' : v !== 1 ? `, ${Math.round(v * 100)}%` : ''}`}
            onClick=${(e) => openPop({ anchor: rectOf(e), label: `${person(id).name}’s volume`, C: PersonAudio, props: { id } })}>
            <${Icon} name=${m ? 'speaker-off' : 'speaker'} size=${16} />${m ? 'Muted for you' : `${Math.round(v * 100)}%`}</button>`}
        </li>`;
      })}
    </ul>
    <p class="stage-plist-note">Volume changes are only for you.</p>
  </div>`;
}

// Each person's line says what is really happening with their audio.
function peerNote(id, inCall) {
  if (!inCall) return null;
  // Their connection dropped; the server holds their place for a while.
  if (S.voiceState[S.call?.room]?.[id]?.reconnecting) return 'Reconnecting…';
  if (id === S.me) return null;
  const st = S.peers[id];
  if (st === 'connected') return null;
  if (st === 'failed') return 'Can’t connect. Trying again…';
  if (st === 'disconnected' || st === 'reconnecting') return 'Reconnecting…';
  // Asked to hide my IP, and no relay: not connected rather than direct.
  if (st === 'norelay') return 'Not connected: no relay to hide your IP';
  return lineOf(id).relay ? 'Connecting through the relay…' : 'Connecting…';
}

// How the line to each person is doing, from the live connection state.
// Only shown once you are in the room: before that there is no connection.
// Connected lines show their measured quality (js/lib/netquality.js): good, fair or poor.
function Quality({ id, inCall }) {
  if (!inCall || id === S.me) return null;
  const q = qualityOf(id);
  return html`<${Bars} q=${q} label=${S.peers[id] === 'failed' ? 'Can’t connect' : QLABEL[q]} />`;
}

// Tiles (and the faces in them) get smaller as the room fills, so everyone
// fits without scrolling. The size also sets the tile width (css/calls.css).
const faceSize = (n) => (n <= 2 ? 80 : n <= 6 ? 64 : 48);

// ---------- Camera and screen sharing (video agent) ----------
// Controls: camera and screen sit between deafen and leave. In the compact
// dock they only appear while on, so you can stop them from anywhere.
function MediaControls({ c, size, compact }) {
  // A voice room may keep cameras and screens to some people ("Share camera and screen").
  const blocked = !c.camera && !c.screen ? videoBlocked(c.room) : null;
  const camLabel = blocked || (c.cameraBusy ? 'Starting your camera…' : c.camera ? 'Turn camera off' : 'Turn camera on');
  const canShare = canShareScreen();
  const scrLabel = blocked || (!canShare ? 'This browser can’t share a screen' : c.screenBusy ? 'Choosing what to share…' : c.screen ? 'Stop sharing your screen' : 'Share your screen');
  return html`
    ${(!compact || c.camera) && html`<button class=${`ib vc cam main${c.camera ? ' live' : ''}${blocked ? ' unavailable' : ''}`} aria-pressed=${String(!!c.camera)} aria-busy=${String(!!c.cameraBusy)} aria-disabled=${blocked ? 'true' : null} aria-label=${camLabel} data-tip=${camLabel} onClick=${blocked ? null : toggleCamera}><${Icon} name=${c.camera ? 'camera' : 'camera-off'} size=${size} /><span class="vc-word" aria-hidden="true">Camera</span></button>`}
    ${(!compact || c.screen) && html`<button class=${`ib vc scr main${c.screen ? ' live' : ''}${canShare && !blocked ? '' : ' unavailable'}`} aria-pressed=${String(!!c.screen)} aria-busy=${String(!!c.screenBusy)} aria-disabled=${canShare && !blocked ? null : 'true'} aria-label=${scrLabel} data-tip=${scrLabel} onClick=${canShare && !blocked ? toggleScreen : null}><${Icon} name=${c.screen ? 'screen-off' : 'screen'} size=${size} /><span class="vc-word" aria-hidden="true">Screen</span></button>`}`;
}

// Small marks beside a name: listening only, a shared screen, a camera.
function MediaMarks({ st }) {
  return html`
    ${st.listen && html`<span class="stage-media listen" role="img" aria-label="Listening, without a microphone" data-tip="Listening, without a microphone"><${Icon} name="headphones" size=${12} /><span class="listen-word">Listening</span></span>`}
    ${st.screen && html`<span class="stage-media" role="img" aria-label="Sharing their screen" data-tip="Sharing their screen"><${Icon} name="screen" size=${12} /></span>`}
    ${st.camera && html`<span class="stage-media" role="img" aria-label="Camera on" data-tip="Camera on"><${Icon} name="camera" size=${12} /></span>`}`;
}

// One tile per screen share, and one per person (a camera, or their face).
function mediaTiles(ids, roomId) {
  const tiles = [];
  for (const id of ids) {
    const st = id === S.me ? S.call : (S.voiceState[roomId]?.[id] || {});
    const m = mediaOf(id);
    if (st.screen) tiles.push({ key: `${id}:screen`, id, kind: 'screen', stream: m.screen });
    // Data saver: a camera paused for me shows the face, with a way to see it.
    if (st.camera && cameraPaused(id)) tiles.push({ key: `${id}:face`, id, kind: 'face', stream: null, paused: true });
    else tiles.push(st.camera ? { key: `${id}:camera`, id, kind: 'camera', stream: m.camera } : { key: `${id}:face`, id, kind: 'face', stream: null });
  }
  return tiles;
}

// The focused tile: the one you clicked, else the first screen share.
function focusOf(tiles) {
  const f = S.call?.focus;
  if (f === 'grid') return null;
  if (f && tiles.some((t) => t.key === f)) return f;
  return tiles.find((t) => t.kind === 'screen')?.key || null;
}
function setFocus(key, focused) {
  if (!S.call) return;
  S.call.focus = focused ? 'grid' : key;
  emit();
}

let watchingFullscreen = false;
function toggleFullscreen(e) {
  const tile = e.currentTarget.closest('.vt');
  if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
  // iPhones only let a video element go full screen.
  const video = tile?.querySelector('video');
  if (!tile?.requestFullscreen && video?.webkitEnterFullscreen) { video.webkitEnterFullscreen(); return; }
  if (!tile?.requestFullscreen) { toast('Full screen isn’t available here.'); return; }
  tile.requestFullscreen().catch(() => toast('Full screen isn’t available here.'));
}

// A video element bound to a stream. Always muted: sound plays separately.
function Video({ stream, mirror, contain, label }) {
  const attach = (el) => {
    if (!el || el.srcObject === stream) return;
    el.srcObject = stream;
    el.play?.()?.catch(() => {});
  };
  return html`<video class=${`vt-video${mirror ? ' mirror' : ''}${contain ? ' contain' : ''}`} ref=${attach} autoplay playsinline muted aria-label=${label}></video>`;
}

function MediaTile({ t, roomId, focused, small }) {
  const u = S.users[t.id];
  const mine = t.id === S.me;
  const st = (mine ? S.call : S.voiceState[roomId]?.[t.id]) || {};
  const quiet = mine ? S.call?.muted : st.muted;
  const deaf = mine ? S.call?.deaf : st.deaf;
  const screenTile = t.kind === 'screen';
  const talking = !screenTile && !!S.speaking[t.id] && !quiet;
  const first = mine ? 'You' : u.name.split(' ')[0];
  const what = screenTile ? (mine ? 'Your screen' : `${first}’s screen`) : mine ? 'You' : u.name;
  const note = t.kind !== 'face' && !t.stream ? (screenTile ? 'Screen starting…' : 'Camera starting…') : peerNote(t.id, true);
  const full = document.fullscreenElement?.dataset?.tile === t.key;
  const videoLabel = screenTile ? what : `${mine ? 'Your' : `${first}’s`} camera`;
  return html`<div class=${`vt vt-${t.kind}${talking ? ' talking' : ''}${focused ? ' focused' : ''}${small ? ' small' : ''}`} data-tile=${t.key} data-user=${t.id} role="group" aria-label=${screenTile ? what : personWords(t.id, roomId, true, note)}>
    ${t.stream
      ? html`<${Video} stream=${t.stream} mirror=${mine && t.kind === 'camera' && vp().mirror} contain=${screenTile} label=${videoLabel} />`
      : html`<span class="vt-face"><${Avatar} user=${u} size=${small ? 40 : 64} speaking=${talking} dim=${!!note} /></span>`}
    <button class="vt-hit" aria-pressed=${String(!!focused)} aria-label=${focused ? `Show everyone again` : `Make ${what} large`} onClick=${() => setFocus(t.key, focused)}></button>
    <span class="vt-label">
      ${!screenTile && quiet && html`<span class="vt-muted" role="img" aria-label=${deaf ? 'Not listening' : 'Muted'}><${Icon} name=${deaf ? 'headphones-off' : 'mic-off'} size=${14} /></span>`}
      ${screenTile && html`<${Icon} name="screen" size=${14} />`}
      <span class="trunc">${screenTile ? what : first}</span>
      ${!screenTile && st.listen && html`<span class="vt-listen" role="img" aria-label="Listening, without a microphone" data-tip="Listening"><${Icon} name="headphones" size=${14} /></span>`}
      ${!screenTile && html`<${Quality} id=${t.id} inCall=${true} />`}
    </span>
    ${note && html`<span class="vt-note" role="status">${note}</span>`}
    ${t.paused && html`<span class="vt-paused"><span>Camera paused to save data</span><button class="btn quiet sm" onClick=${() => showCamera(t.id)}>Show video</button></span>`}
    ${screenTile && t.stream && html`<button class="ib vt-full" aria-label=${full ? 'Exit full screen' : 'Show full screen'} data-tip=${full ? 'Exit full screen' : 'Show full screen'} onClick=${toggleFullscreen}><${Icon} name=${full ? 'shrink' : 'expand'} size=${18} /></button>`}
    ${t.kind !== 'face' && html`<${PopOut} t=${t} />`}
    ${!screenTile && html`<span class="vt-extras"><${PersonExtras} id=${t.id} room=${roomId} /></span>`}
    ${!screenTile && html`<${ReactionFloat} id=${t.id} room=${roomId} />`}
  </div>`;
}

function MediaStage({ tiles, roomId }) {
  if (!watchingFullscreen) { watchingFullscreen = true; document.addEventListener('fullscreenchange', () => emit()); }
  const fk = focusOf(tiles);
  if (!fk) {
    return html`<div class="vt-grid" data-n=${Math.min(tiles.length, 4)}>
      ${tiles.map((t) => html`<${MediaTile} key=${t.key} t=${t} roomId=${roomId} />`)}
    </div>`;
  }
  const big = tiles.find((t) => t.key === fk);
  const rest = tiles.filter((t) => t !== big);
  return html`<div class=${`vt-focus${rest.length ? '' : ' alone'}`}>
    <div class="vt-main"><${MediaTile} key=${big.key} t=${big} roomId=${roomId} focused=${true} /></div>
    ${rest.length > 0 && html`<div class="vt-strip" role="group" aria-label="Everyone else">${rest.map((t) => html`<${MediaTile} key=${t.key} t=${t} roomId=${roomId} small=${true} />`)}</div>`}
  </div>`;
}
// ---------- end camera and screen sharing ----------

// ---------- The status line's extras ----------
// Push to talk, said where you look: the key, and whether the microphone is open now.
function PttChip() {
  const c = S.call;
  const v = vp();
  if (!c || c.status !== 'live' || v.mode !== 'ptt' || c.listen) return null;
  const held = pttHeld() && !c.muted;
  return html`<span class=${`stage-ptt${held ? ' live' : ''}${c.muted ? ' muted' : ''}`} role="status">
    <${Icon} name=${c.muted ? 'mic-off' : 'mic'} size=${14} />
    ${c.muted ? 'Muted' : held ? 'Talking' : html`Hold <kbd>${v.pttLabel}</kbd> to talk`}
  </span>`;
}
// Sharing my screen: say so, with a way to stop, wherever the screen tile is.
function SharingChip() {
  const c = S.call;
  if (!c?.screen || c.status !== 'live') return null;
  return html`<span class="stage-sharing" role="status"><${Icon} name="screen" size=${14} /><span class="trunc">You’re sharing your screen</span>
    <button class="btn sm stage-sharing-stop" onClick=${toggleScreen}>Stop</button></span>`;
}
function FoldButton({ room, folded }) {
  const phone = S.ui.phone;
  const label = folded ? 'Show the whole call' : phone ? 'Show the chat' : 'Make the call smaller';
  return html`<button class=${`ib sm stage-fold${phone ? ' wordy' : ''}`} aria-expanded=${String(!folded)} aria-label=${label} data-tip=${label}
    onClick=${() => setFolded(room, !folded)}><${Icon} name=${folded ? 'expand' : phone ? 'dm' : 'shrink'} size=${16} />${phone && html`<span aria-hidden="true">${folded ? 'Call' : 'Chat'}</span>`}</button>`;
}

// Desktop, over a camera or a screen: the bar fades after a few still seconds.
// Kept on a data attribute Preact doesn't manage, so a render never resets it.
const IDLE_MS = 3000;
function useIdleBar(ref, active) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !active) { if (el) delete el.dataset.idle; return undefined; }
    let t = null;
    const sleep = () => {
      // Never while its own menu or popover is open, or it has the focus.
      if (S.ui.menu || S.ui.pop || el.querySelector('.stage-acts')?.contains(document.activeElement)) { t = setTimeout(sleep, IDLE_MS); return; }
      el.dataset.idle = '1';
    };
    const wake = () => { delete el.dataset.idle; clearTimeout(t); t = setTimeout(sleep, IDLE_MS); };
    const evs = ['pointermove', 'pointerdown', 'keydown', 'focusin', 'wheel'];
    evs.forEach((n) => el.addEventListener(n, wake, { passive: true }));
    wake();
    return () => { clearTimeout(t); evs.forEach((n) => el.removeEventListener(n, wake)); delete el.dataset.idle; };
  }, [active]);
}

// ---------- The voice stage ----------
// For a voice room or a call in a direct conversation (dm): the same faces,
// tiles, camera, screen share and controls.
export function Stage({ roomId, dm }) {
  const ref = useRef();
  const ids = (S.voice[roomId] || []).filter((id) => S.users[id]);
  const inCall = S.call?.room === roomId;
  // Reconnecting after a dropped connection: still in the call, controls and all.
  const reconnecting = inCall && S.call.status === 'reconnecting';
  const starting = inCall && S.call.status !== 'live' && !reconnecting;
  const live = inCall && !starting;
  // A call that is still ringing people shows them, waiting, beside the people in it.
  const meta = dm ? S.calls[roomId] : null;
  const ringingIds = live && meta ? meta.ringing.filter((id) => S.users[id] && !ids.includes(id)) : [];
  const alone = dm && live && ids.length <= 1 && !ringingIds.length;
  // Faces make room for an activity (the whiteboard or a game) when one is running.
  const size = inCall && S.activity?.[roomId] ? 40 : faceSize(ids.length + ringingIds.length);
  // A phone's tiles are half its width: the face stays inside them.
  const face = S.ui.phone ? Math.min(size, 56) : size;
  const ringNames = nameList(ringingIds.map((id) => S.users[id].name.split(' ')[0]));
  const status = !inCall ? null : starting
    ? html`<span class="stage-conn wait" role="status"><span class="stage-spin" aria-hidden="true"><${Spinner} size="sm" label="" /></span>${S.call.status === 'mic' ? 'Waiting for your microphone…' : dm ? 'Calling…' : 'Joining…'}</span>`
    : reconnecting
      ? html`<span class="stage-conn act-reconn" role="status"><i aria-hidden="true"></i>Reconnecting… Your place is kept for a moment.</span>`
      : ringingIds.length && ids.length <= 1
        ? html`<span class="stage-conn ring" role="status"><i aria-hidden="true"></i>Ringing ${ringNames}…</span>`
        : alone
          ? html`<span class="stage-conn wait" role="status">${meta?.answered ? 'Everyone else left' : 'Nobody has picked up yet'}</span>`
          : html`<${ConnHeader} room=${roomId} />`;
  // Once someone in the call shows a camera or a screen, the stage becomes tiles.
  const tiles = live ? mediaTiles(ids, roomId) : [];
  const media = tiles.some((t) => t.kind !== 'face' || t.paused);
  const folded = live && isFolded(roomId);
  useIdleBar(ref, media && !folded && !S.ui.phone);
  const roomName = S.rooms[roomId]?.name || 'this room';
  const cls = `stage${inCall ? ' in' : ''}${ids.length ? '' : ' nobody'}${media ? ' media' : ''}${dm ? ' call' : ''}${folded ? ' folded' : ''}`;
  return html`<div class=${cls} ref=${ref} data-size=${size} role="region" aria-label=${dm ? 'Call' : `Voice: ${roomName}`}>
    <div class="stage-top">
      <span class="stage-count"><${Icon} name=${dm ? 'phone' : 'speaker'} size=${16} />${ids.length ? `${ids.length} in ${dm ? 'the call' : 'voice'}` : dm ? 'Call' : 'Voice'}<${RoomLimit} room=${roomId} n=${ids.length} /></span>
      ${status}
      <${PttChip} />
      <${SharingChip} />
      <span class="stage-top-end">
        ${live && html`<${CallTimer} room=${roomId} />`}
        ${live && html`<${FoldButton} room=${roomId} folded=${folded} />`}
      </span>
    </div>
    ${inCall && html`<${ActivityAnnouncer} />`}
    ${folded
      ? html`<div class="stage-acts compact" role="group" aria-label=${dm ? 'Call controls' : 'Voice controls'}><${VoiceControls} compact /></div>`
      : html`<div class="stage-body">
          ${inCall && html`<${MutedBanner} />`}
          <${ActivityTile} room=${roomId} />
          ${media ? html`<${MediaStage} tiles=${tiles} roomId=${roomId} />` : ids.length
            ? html`<div class="stage-people" style=${`--face:${face}px`} data-n=${Math.min(ids.length + ringingIds.length, 9)}>
                ${ids.map((id) => {
                  const u = S.users[id];
                  const mine = id === S.me;
                  const { st, quiet, deaf } = stateOf(id, roomId, inCall);
                  const note = peerNote(id, inCall);
                  const talking = !!S.speaking[id] && !quiet;
                  // One tile per person: the face in the middle, the name, their
                  // mic and connection bottom left, a note top left, volume and
                  // moderation top right.
                  return html`<div class=${`stage-person${talking ? ' talking' : ''}${note ? ' waiting' : ''}${quiet ? ' quiet' : ''}`} key=${id} role="group" aria-label=${personWords(id, roomId, live, note)}>
                    <span class="stage-face"><${Avatar} user=${u} size=${face} speaking=${talking} dim=${!!note} /></span>
                    <span class="stage-name">
                      ${quiet && html`<span class="muted-ic" role="img" aria-label=${deaf ? 'Not listening' : 'Muted'} data-tip=${deaf ? 'Not listening' : 'Muted'}><${Icon} name=${deaf ? 'headphones-off' : 'mic-off'} size=${14} /></span>`}
                      <span class="trunc">${mine ? 'You' : u.name}</span><${MediaMarks} st=${st} /><${Quality} id=${id} inCall=${live} />
                    </span>
                    ${note && html`<span class="stage-note">${note}</span>`}
                    <span class="stage-tools"><${StageMod} id=${id} room=${roomId} /><${PersonExtras} id=${id} room=${roomId} /></span>
                    <${ReactionFloat} id=${id} room=${roomId} />
                  </div>`;
                })}
                ${ringingIds.map((id) => html`<div class="stage-person ringing waiting" key=${id} role="group" aria-label=${`${S.users[id].name}, ringing`}>
                  <span class="stage-face"><${Avatar} user=${S.users[id]} size=${face} dim /></span>
                  <span class="stage-name"><span class="trunc">${S.users[id].name}</span></span>
                  <span class="stage-note">Ringing…</span>
                </div>`)}
              </div>`
            : starting
              ? html`<p class="stage-empty" role="status"><span class="stage-spin" aria-hidden="true"><${Spinner} size="sm" label="" /></span>Starting your microphone…</p>`
              : html`<${EmptyState} cls="stage-empty-state" icon=${dm ? 'phone' : 'speaker'} title="Nobody is here yet"
                  text=${dm ? 'Start a call and they’ll hear it ring.' : `Join, and ${roomName} shows as live to everyone.`} />`}
          ${dm && html`<${RingAgain} room=${roomId} />`}
          <${DroppedNote} room=${roomId} dm=${dm} inCall=${inCall} />
          ${!inCall && !dm && connectsDirectly() && html`<p class="stage-direct" role="note"><${Icon} name="info" size=${16} /><span>This connects directly: people in ${roomName} can see your IP address. This Snug server has no relay to hide it.</span></p>`}
        </div>
        <div class="stage-acts" role="group" aria-label=${dm ? 'Call controls' : 'Voice controls'}>
          ${live
            ? html`<${VoiceControls} />`
            : dm
              ? html`<button class="btn live" disabled aria-busy="true"><${Icon} name="phone" size=${16} />${S.call?.status === 'mic' ? 'Starting your microphone…' : 'Calling…'}</button>`
              : html`<button class="btn primary" disabled=${starting} aria-busy=${String(!!starting)} onClick=${() => leavingCall(roomId, () => joinVoice(roomId))}><${Icon} name="speaker" size=${16} />${starting ? 'Joining…' : 'Join voice'}</button>
                ${!starting && html`<button class="btn quiet stage-listen" onClick=${() => leavingCall(roomId, () => joinVoice(roomId, { listen: true }))} data-tip="Join without your microphone: you hear everyone, nobody hears you"><${Icon} name="headphones" size=${16} />Listen only</button>`}`}
        </div>`}
  </div>`;
}

// The last call here dropped (the connection went, or the server let me go):
// say so on the stage, in plain words, with the way back.
function DroppedNote({ room, dm, inCall }) {
  const d = S.voiceDrop;
  if (inCall || dm || !d || d.room !== room || Date.now() - d.at > 10 * 60_000) return null;
  return html`<div class="stage-dropped" role="status">
    <${Icon} name="offline" size=${16} />
    <span class="grow">${d.text}</span>
    <button class="btn sm" disabled=${S.conn.socket !== 'open'} onClick=${() => { S.voiceDrop = null; leavingCall(room, () => joinVoice(room)); }}>Join again</button>
    <button class="ib sm" aria-label="Dismiss" data-tip="Dismiss" onClick=${() => { S.voiceDrop = null; emit(); }}><${Icon} name="x" size=${16} /></button>
  </div>`;
}
