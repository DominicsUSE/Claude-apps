// The main column for a room or direct conversation, plus the two context
// panes that belong to it: a thread, and the room's details.
import { html } from '../../vendor/preact-htm.js';
import {
  S, person, convMeta, membersOf, togglePane, closePane, back, go,
  toggleFollow, setNotify, openModal, jumpToMsg, findMsg, openConv, setReply,
} from '../store.js';
import { levelOf, levelsFor, LEVEL_LABEL } from '../lib/attention.js';
import { can } from '../lib/perms.js';
import { fmtWhen, plural, nameList } from '../lib/util.js';
import { plain } from '../lib/format.js';
import { Icon } from '../ui/icons.js';
import { Avatar, Stack, Tile, RoomIcon, Seg, Pres, presenceLabel } from '../ui/kit.js';
import { Stream, Message, focusComposer } from './stream.js';
import { joinVoice, leaveVoice, toggleMute, toggleDeaf } from '../voice.js';
import { leavingCall } from '../calls.js';
import { toggleCamera, toggleScreen, mediaOf, canShareScreen } from '../voice.js';
import { emit, toast } from '../store.js';
import { RoomForm, RoomBrowser } from './modals.js';
import { showProfile } from './people.js';
import { PinsButton } from './media.js'; // pinned messages
import { CallButtons, CallStrip, CallEndNote } from './calls.js'; // calls in direct conversations and groups

const Back = () => S.ui.phone && html`<button class="ib" aria-label="Back" onClick=${back}><${Icon} name="back" /></button>`;

export function VoiceControls({ compact }) {
  const c = S.call;
  const size = compact ? 18 : 20;
  const leave = c.dm ? 'Leave call' : 'Leave voice';
  return html`
    <button class=${`ib vc${c.muted ? ' on' : ''}`} aria-pressed=${String(c.muted)} aria-label=${c.muted ? 'Unmute' : 'Mute'} data-tip=${c.muted ? 'Unmute' : 'Mute'} onClick=${toggleMute}><${Icon} name=${c.muted ? 'mic-off' : 'mic'} size=${size} /></button>
    <button class=${`ib vc${c.deaf ? ' on' : ''}`} aria-pressed=${String(c.deaf)} aria-label=${c.deaf ? 'Hear the room again' : 'Stop hearing the room'} data-tip=${c.deaf ? 'Hear the room again' : 'Stop hearing the room'} onClick=${toggleDeaf}><${Icon} name=${c.deaf ? 'ear-off' : 'ear'} size=${size} /></button>
    <${MediaControls} c=${c} size=${size} compact=${compact} />
    <button class="ib vc danger leave" aria-label=${leave} data-tip=${c.dm ? 'Hang up' : 'Leave'} onClick=${leaveVoice}><${Icon} name="leave" size=${size} /></button>`;
}

// Each person's line says what is really happening with their audio.
function peerNote(id, inCall) {
  if (!inCall || id === S.me) return null;
  const st = S.peers[id];
  if (st === 'connected') return null;
  if (st === 'failed') return 'Can\u2019t connect';
  if (st === 'disconnected') return 'Reconnecting';
  return 'Connecting';
}

// How the line to each person is doing, from the live connection state.
// Only shown once you are in the room: before that there is no connection.
function Quality({ id, inCall }) {
  if (!inCall || id === S.me) return null;
  const st = S.peers[id];
  const q = st === 'connected' ? 'good' : st === 'disconnected' ? 'weak' : st === 'failed' ? 'bad' : 'wait';
  const label = { good: 'Connected', weak: 'Connection is weak, reconnecting', bad: 'Can\u2019t connect', wait: 'Connecting' }[q];
  return html`<span class=${`stage-q ${q}`} role="img" aria-label=${label} data-tip=${label}><i></i><i></i><i></i></span>`;
}

// Faces get smaller as the room fills, so everyone fits without scrolling.
const faceSize = (n) => (n <= 2 ? 96 : n <= 6 ? 64 : 48);

// ---------- Camera and screen sharing (video agent) ----------
// Controls: camera and screen sit between deafen and leave. In the compact
// dock they only appear while on, so you can stop them from anywhere.
function MediaControls({ c, size, compact }) {
  const camLabel = c.cameraBusy ? 'Starting your camera…' : c.camera ? 'Turn camera off' : 'Turn camera on';
  const canShare = canShareScreen();
  const scrLabel = !canShare ? 'This browser can’t share a screen' : c.screenBusy ? 'Choosing what to share…' : c.screen ? 'Stop sharing your screen' : 'Share your screen';
  return html`
    ${(!compact || c.camera) && html`<button class=${`ib vc cam${c.camera ? ' live' : ''}`} aria-pressed=${String(!!c.camera)} aria-busy=${String(!!c.cameraBusy)} aria-label=${camLabel} data-tip=${camLabel} onClick=${toggleCamera}><${Icon} name=${c.camera ? 'camera' : 'camera-off'} size=${size} /></button>`}
    ${(!compact || c.screen) && html`<button class=${`ib vc scr${c.screen ? ' live' : ''}${canShare ? '' : ' unavailable'}`} aria-pressed=${String(!!c.screen)} aria-busy=${String(!!c.screenBusy)} aria-disabled=${canShare ? null : 'true'} aria-label=${scrLabel} data-tip=${scrLabel} onClick=${canShare ? toggleScreen : null}><${Icon} name=${c.screen ? 'screen-off' : 'screen'} size=${size} /></button>`}`;
}

// Small marks beside a name for people watching from outside the call.
function MediaMarks({ st }) {
  return html`
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
    tiles.push(st.camera ? { key: `${id}:camera`, id, kind: 'camera', stream: m.camera } : { key: `${id}:face`, id, kind: 'face', stream: null });
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
  const st = S.voiceState[roomId]?.[t.id] || {};
  const quiet = mine ? S.call?.muted : st.muted;
  const deaf = mine ? S.call?.deaf : st.deaf;
  const screenTile = t.kind === 'screen';
  const talking = !screenTile && !!S.speaking[t.id] && !quiet;
  const first = mine ? 'You' : u.name.split(' ')[0];
  const what = screenTile ? (mine ? 'Your screen' : `${first}’s screen`) : mine ? 'You' : u.name;
  const note = t.kind !== 'face' && !t.stream ? (screenTile ? 'Screen starting…' : 'Camera starting…') : peerNote(t.id, true);
  const full = document.fullscreenElement?.dataset?.tile === t.key;
  const videoLabel = screenTile ? what : `${mine ? 'Your' : `${first}’s`} camera`;
  return html`<div class=${`vt vt-${t.kind}${talking ? ' talking' : ''}${focused ? ' focused' : ''}${small ? ' small' : ''}`} data-tile=${t.key} data-user=${t.id} role="group" aria-label=${what}>
    ${t.stream
      ? html`<${Video} stream=${t.stream} mirror=${mine && t.kind === 'camera'} contain=${screenTile} label=${videoLabel} />`
      : html`<span class="vt-face"><${Avatar} user=${u} size=${small ? 40 : 64} speaking=${talking} dim=${!!note} /></span>`}
    <button class="vt-hit" aria-pressed=${String(!!focused)} aria-label=${focused ? `Show everyone again` : `Make ${what} large`} onClick=${() => setFocus(t.key, focused)}></button>
    <span class="vt-label">
      ${!screenTile && quiet && html`<span class="vt-muted" role="img" aria-label=${deaf ? 'Not listening' : 'Muted'}><${Icon} name=${deaf ? 'ear-off' : 'mic-off'} size=${14} /></span>`}
      ${screenTile && html`<${Icon} name="screen" size=${14} />`}
      <span class="trunc">${screenTile ? what : first}</span>
      ${!screenTile && html`<${Quality} id=${t.id} inCall=${true} />`}
    </span>
    ${note && html`<span class="vt-note" role="status">${note}</span>`}
    ${screenTile && t.stream && html`<button class="ib vt-full" aria-label=${full ? 'Exit full screen' : 'Show full screen'} data-tip=${full ? 'Exit full screen' : 'Show full screen'} onClick=${toggleFullscreen}><${Icon} name=${full ? 'shrink' : 'expand'} size=${18} /></button>`}
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
  return html`<div class="vt-focus">
    <div class="vt-main"><${MediaTile} key=${big.key} t=${big} roomId=${roomId} focused=${true} /></div>
    ${rest.length > 0 && html`<div class="vt-strip">${rest.map((t) => html`<${MediaTile} key=${t.key} t=${t} roomId=${roomId} small=${true} />`)}</div>`}
  </div>`;
}
// ---------- end camera and screen sharing ----------

// The voice stage, for a voice room or a call in a direct conversation (dm):
// the same faces, tiles, camera, screen share and controls.
function Stage({ roomId, dm }) {
  const ids = (S.voice[roomId] || []).filter((id) => S.users[id]);
  const inCall = S.call?.room === roomId;
  const starting = inCall && S.call.status !== 'live';
  // A call that is still ringing people shows them, waiting, beside the people in it.
  const meta = dm ? S.calls[roomId] : null;
  const ringingIds = inCall && !starting && meta ? meta.ringing.filter((id) => S.users[id] && !ids.includes(id)) : [];
  const alone = dm && inCall && !starting && ids.length <= 1 && !ringingIds.length;
  const size = faceSize(ids.length + ringingIds.length);
  const ringNames = nameList(ringingIds.map((id) => S.users[id].name.split(' ')[0]));
  const status = !inCall ? null : starting
    ? html`<span class="stage-conn wait" role="status">${S.call.status === 'mic' ? 'Waiting for your microphone\u2026' : dm ? 'Calling\u2026' : 'Joining\u2026'}</span>`
    : ringingIds.length && ids.length <= 1
      ? html`<span class="stage-conn ring" role="status"><i aria-hidden="true"></i>Ringing ${ringNames}\u2026</span>`
      : alone
        ? html`<span class="stage-conn wait" role="status">${meta?.answered ? 'Everyone else left' : 'Nobody has picked up yet'}</span>`
        : html`<span class="stage-conn ok" role="status"><i aria-hidden="true"></i>Connected</span>`;
  // Once someone in the call shows a camera or a screen, the stage becomes tiles.
  const tiles = inCall && !starting ? mediaTiles(ids, roomId) : [];
  const media = tiles.some((t) => t.kind !== 'face');
  return html`<div class=${`stage${inCall ? ' in' : ''}${ids.length ? '' : ' empty'}${media ? ' media' : ''}${dm ? ' call' : ''}`} data-size=${size} role="region" aria-label=${dm ? 'Call' : 'Voice'}>
    <div class="stage-top">
      <span class="stage-count"><${Icon} name=${dm ? 'phone' : 'voice'} size=${16} />${ids.length ? `${ids.length} in ${dm ? 'the call' : 'voice'}` : dm ? 'Call' : 'Voice'}</span>
      ${status}
    </div>
    ${media ? html`<${MediaStage} tiles=${tiles} roomId=${roomId} />` : ids.length
      ? html`<div class="stage-people" style=${`--face:${size}px`}>
          ${ids.map((id) => {
            const u = S.users[id];
            const st = S.voiceState[roomId]?.[id] || {};
            const mine = id === S.me;
            const quiet = mine ? S.call?.muted : st.muted;
            const deaf = mine ? S.call?.deaf : st.deaf;
            const note = peerNote(id, inCall);
            const talking = !!S.speaking[id] && !quiet;
            return html`<div class=${`stage-person${talking ? ' talking' : ''}`} key=${id}>
              <span class="stage-face">
                <${Avatar} user=${u} size=${size} speaking=${talking} dim=${!!note} />
                ${quiet && html`<span class="muted-ic" role="img" aria-label=${deaf ? 'Not listening' : 'Muted'}><${Icon} name=${deaf ? 'ear-off' : 'mic-off'} size=${size >= 64 ? 16 : 12} /></span>`}
              </span>
              <span class="stage-name"><span class="trunc">${mine ? 'You' : u.name.split(' ')[0]}</span><${MediaMarks} st=${st} /><${Quality} id=${id} inCall=${inCall && !starting} /></span>
              ${note && html`<span class="stage-note">${note}</span>`}
            </div>`;
          })}
          ${ringingIds.map((id) => html`<div class="stage-person ringing" key=${id}>
            <span class="stage-face"><${Avatar} user=${S.users[id]} size=${size} dim /></span>
            <span class="stage-name"><span class="trunc">${S.users[id].name.split(' ')[0]}</span></span>
            <span class="stage-note">Ringing\u2026</span>
          </div>`)}
        </div>`
      : html`<p class="stage-empty">${starting ? 'Starting your microphone\u2026' : 'Nobody\u2019s in here yet. Join, and the room shows as live to everyone.'}</p>`}
    <div class="stage-acts">
      ${inCall && !starting
        ? html`<${VoiceControls} />`
        : dm
          ? html`<button class="btn live" disabled aria-busy="true"><${Icon} name="phone" size=${16} />${S.call?.status === 'mic' ? 'Starting your microphone\u2026' : 'Calling\u2026'}</button>`
          : html`<button class="btn primary" disabled=${starting} aria-busy=${String(!!starting)} onClick=${() => leavingCall(roomId, () => joinVoice(roomId))}><${Icon} name="voice" size=${16} />${starting ? 'Joining\u2026' : 'Join voice'}</button>`}
    </div>
  </div>`;
}

export function Welcome({ house, inPage }) {
  const h = S.houses[house];
  const step = h.firstStep || { room: h.starter[1] || h.starter[0], label: 'Say hello', draft: '' };
  const start = () => {
    if (step.draft && !S.drafts[step.room]) S.drafts[step.room] = step.draft;
    openConv(step.room);
    focusComposer(step.room);
  };
  return html`<div class="welcome">
    ${inPage
      ? html`<div class="welcome-head"><div><span class="welcome-kicker">You’re new here</span><h2>Welcome to ${h.name}. Start with hello.</h2></div></div>`
      : html`<div class="welcome-head"><${Tile} house=${h} lg /><div><span class="welcome-kicker">You’re new here</span><h2>Welcome to ${h.name}</h2><div class="faint">${h.about}</div></div></div>`}
    <p>You start with ${plural(h.starter.length, 'room')}. The rest of the house opens once you’ve posted your first message.</p>
    <div class="welcome-rooms">
      ${h.starter.map((id) => html`<button class="welcome-room" key=${id} onClick=${() => openConv(id)}>
        <${RoomIcon} kind=${S.rooms[id].kind} /><span><b>${S.rooms[id].name}</b> <span>${S.rooms[id].topic}</span></span>
      </button>`)}
    </div>
    <div class="welcome-acts">
      <button class="btn primary" onClick=${start}>${step.label}</button>
      <button class="btn" onClick=${() => openModal(RoomBrowser, { house })}>Look around first</button>
    </div>
  </div>`;
}

function Intro({ conv, meta }) {
  const empty = !(S.msgs[conv] || []).length;
  if (meta.room) {
    const h = S.houses[meta.house];
    const welcome = h.newcomer && h.starter[0] === conv;
    return html`
      ${welcome && html`<${Welcome} house=${meta.house} />`}
      <div class="start">
        <h2><${RoomIcon} kind=${meta.kind} size=${24} />${meta.title}</h2>
        <p>${meta.topic ? `${meta.topic}. ` : ''}${empty ? 'Nothing has been said here yet.' : `This is where ${meta.title} begins.`}</p>
        ${can(S, meta.house, 'rooms') && empty && html`<div class="acts"><button class="btn" onClick=${() => openModal(RoomForm, { room: conv })}><${Icon} name="edit" size=${16} />Edit room</button></div>`}
      </div>`;
  }
  return html`<div class="start">
    <h2>${meta.user ? html`<${Avatar} user=${meta.user} />` : null}${meta.title}</h2>
    <p>${meta.user
      ? `This is the start of your conversation with ${meta.user.name.split(' ')[0]}. Only the two of you can read it.`
      : `A group of ${meta.dm.members.length}. Only the people in it can read it.`}</p>
  </div>`;
}

export function Conversation({ conv }) {
  const meta = convMeta(conv);
  if (!meta) return null;
  const pane = S.ui.pane?.type;
  const members = membersOf(conv).map((id) => S.users[id]);
  const here = members.filter((u) => u.presence !== 'offline' && u.id !== S.me);
  const first = meta.user?.name.split(' ')[0];
  const inVoice = meta.room ? (S.voice[conv] || []).length : 0;
  return html`<section class=${`main conv kind-${meta.kind}`} aria-label=${meta.title}>
    <header class="bar">
      <${Back} />
      <h1 class="bar-title trunc">
        ${meta.user ? html`<${Avatar} user=${meta.user} size=${24} presence />` : meta.room ? html`<${RoomIcon} kind=${meta.kind} />` : html`<${Icon} name="people" />`}
        <span class="trunc">${meta.title}</span>
      </h1>
      ${meta.topic && html`<span class="bar-sub trunc">${meta.topic}</span>`}
      ${meta.user && html`<span class="bar-sub trunc">${presenceLabel(meta.user)}${meta.user.status ? `. ${meta.user.status}` : ''}</span>`}
      <div class="bar-end">
        ${!meta.user && html`<span class="bar-live" role="status" aria-label=${`${here.length ? `${plural(here.length, 'other person', 'other people')} here` : 'Just you here'}${inVoice ? `, ${inVoice} in voice` : ''}`}>
          ${here.length > 0 && html`<${Stack} users=${here} max=${3} size=${20} />`}
          ${here.length > 0 ? html`<span><i class="pres inline open" aria-hidden="true"></i><span class="num">${here.length}</span> here</span>` : html`<span>Just you</span>`}
          ${inVoice > 0 && html`<span class="bar-voice"><${Icon} name="voice" size=${16} /><span class="num">${inVoice}</span> in voice</span>`}
        </span>`}
        ${meta.dm && html`<${CallButtons} conv=${conv} />`}
        <${PinsButton} conv=${conv} />
        <button class="ib" aria-label=${`Search in ${meta.title}`} data-tip="Search here" onClick=${() => go({ type: 'search', q: `in:"${meta.title.toLowerCase()}" ` })}><${Icon} name="search" /></button>
        ${!meta.user && html`<button class=${`ib${pane === 'people' ? ' on' : ''}`} aria-pressed=${String(pane === 'people')} aria-label=${`People, ${here.length} here`}
          data-tip="People" onClick=${() => togglePane('people')}><${Icon} name="people" /></button>`}
        <button class=${`ib${pane === 'details' ? ' on' : ''}`} aria-pressed=${String(pane === 'details')} aria-label="Details" data-tip="Details and notifications" onClick=${() => togglePane('details')}><${Icon} name="info" /></button>
      </div>
    </header>
    ${meta.kind === 'voice' && html`<${Stage} roomId=${conv} />`}
    ${meta.dm && (S.call?.room === conv
      ? html`<${Stage} roomId=${conv} dm />`
      : html`<${CallStrip} conv=${conv} /><${CallEndNote} conv=${conv} />`)}
    <${Stream} key=${conv} conv=${conv} intro=${html`<${Intro} conv=${conv} meta=${meta} />`}
      placeholder=${meta.user ? `Message ${first}` : `Message ${meta.title}`} />
  </section>`;
}

export function ThreadPane({ tid }) {
  const meta = convMeta(tid);
  const t = S.threads[tid];
  if (!meta || !t) return null;
  const n = (S.msgs[tid] || []).length;
  const following = !!S.followed[tid];
  const intro = html`
    ${meta.root
      ? html`<${Message} conv=${t.conv} m=${meta.root} inThread />`
      : html`<div class="older-msg">The message this thread started from was deleted.</div>`}
    <div class="thread-count">${n ? plural(n, 'reply', 'replies') : 'No replies yet. Yours will be the first.'}</div>`;
  return html`<aside class="pane" aria-label="Thread">
    <header class="bar">
      ${S.ui.phone && html`<button class="ib" aria-label="Back" onClick=${closePane}><${Icon} name="back" /></button>`}
      <h1 class="bar-title"><${Icon} name="thread" />Thread</h1>
      <span class="bar-sub trunc">${meta.where}</span>
      <div class="bar-end">
        <button class=${`ib${following ? ' on' : ''}`} aria-pressed=${String(following)} aria-label=${following ? 'Stop following this thread' : 'Follow this thread'}
          data-tip=${following ? 'Following. New replies reach Catch up.' : 'Follow to hear about new replies'} onClick=${() => toggleFollow(tid)}><${Icon} name=${following ? 'bell' : 'bell-off'} /></button>
        ${!S.ui.phone && html`<button class="ib" aria-label="Close thread" data-tip="Close" data-key="Esc" onClick=${closePane}><${Icon} name="x" /></button>`}
      </div>
    </header>
    <${Stream} key=${tid} conv=${tid} intro=${intro} placeholder="Reply in thread" />
  </aside>`;
}

const LEVEL_HINT = {
  all: 'A dot for anything new, a number when something needs you.',
  mentions: 'Stays quiet unless you’re mentioned, replied to, or a thread you follow moves.',
  muted: 'No dots, no numbers, no pop-ups. Messages are still here when you visit.',
};

export function NotifyControl({ kind, id, level }) {
  const options = levelsFor(S, kind, id).map((l) => [l, LEVEL_LABEL[l]]);
  return html`<${Seg} label="Notify me about" value=${level} options=${options} onChange=${(l) => setNotify(kind, id, l)} />`;
}

export function DetailsPane({ conv }) {
  const meta = convMeta(conv);
  if (!meta) return null;
  const room = meta.room;
  const level = levelOf(S, conv);
  const files = (S.msgs[conv] || []).flatMap((m) => (m.files || []).map((f) => ({ f, m }))).reverse().slice(0, 8);
  const highlights = room ? room.highlights.map((id) => findMsg(conv, id)).filter(Boolean) : [];
  return html`<aside class="pane" aria-label="Details">
    <header class="bar">
      ${S.ui.phone && html`<button class="ib" aria-label="Back" onClick=${closePane}><${Icon} name="back" /></button>`}
      <h1 class="bar-title">Details</h1>
      <div class="bar-end">${!S.ui.phone && html`<button class="ib" aria-label="Close details" data-tip="Close" data-key="Esc" onClick=${closePane}><${Icon} name="x" /></button>`}</div>
    </header>
    <div class="pane-body pad">
      <div class="detail">
        ${room
          ? html`<h2 style="display:flex;gap:8px;align-items:center"><${RoomIcon} kind=${room.kind} />${room.name}</h2>
              <p class="sub">${room.topic || 'No description yet.'}</p>
              <p class="faint">In ${S.houses[room.house].name}</p>
              ${can(S, room.house, 'rooms') && html`<div><button class="btn" onClick=${() => openModal(RoomForm, { room: conv })}><${Icon} name="edit" size=${16} />Edit room</button></div>`}`
          : meta.user
            ? html`<button class="person" style="margin:0 -8px;width:calc(100% + 16px)" onClick=${(e) => showProfile(meta.user, e.currentTarget.getBoundingClientRect())}>
                <${Avatar} user=${meta.user} presence /><span class="grow"><span class="person-name" style="display:block">${meta.user.name}</span><span class="person-sub" style="display:block">${presenceLabel(meta.user)}</span></span>
              </button>`
            : html`<h2>${meta.title}</h2><p class="sub">${meta.dm.members.map((id) => S.users[id].name.split(' ')[0]).join(', ')}</p>`}
      </div>
      <div class="detail">
        <h3>Notify me about</h3>
        <${NotifyControl} kind=${room ? 'room' : 'dm'} id=${conv} level=${level} />
        <p class="hint" style="margin:0">${LEVEL_HINT[level]}${room && !room.notify ? ` Same as the rest of ${S.houses[room.house].name}.` : ''}</p>
      </div>
      ${room && html`<div class="detail">
        <h3>Highlights</h3>
        ${highlights.length
          ? highlights.map((m) => html`<button class="hl" key=${m.id} onClick=${() => jumpToMsg(conv, m.id)}>
              <span class="hl-meta">${person(m.author).name}, ${fmtWhen(m.ts)}</span>
              <span class="hl-text">${plain(m.text)}</span>
            </button>`)
          : html`<p class="sub">Nothing highlighted yet. ${can(S, room.house, 'highlight') ? 'Open a message’s menu and choose Add to room highlights.' : 'People who look after this room can pin the messages worth keeping.'}</p>`}
      </div>`}
      <div class="detail">
        <h3>Files</h3>
        ${files.length
          ? files.map(({ f, m }, i) => html`<button class="hl" key=${i} onClick=${() => jumpToMsg(conv, m.id)}>
              <span style="display:flex;gap:8px;align-items:center"><${Icon} name=${f.kind === 'image' ? 'image' : 'file'} size=${16} /><span class="trunc">${f.name}</span></span>
              <span class="hl-meta">${person(m.author).name}, ${fmtWhen(m.ts)}</span>
            </button>`)
          : html`<p class="sub">No files have been shared here.</p>`}
      </div>
    </div>
  </aside>`;
}
