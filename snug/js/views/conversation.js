// The main column for a room or direct conversation, plus the two context
// panes that belong to it: a thread, and the room's details.
import { html, useState } from '../../vendor/preact-htm.js';
import {
  S, person, convMeta, membersOf, togglePane, closePane, back, go,
  toggleFollow, setNotify, openModal, jumpToMsg, findMsg, openConv,
} from '../store.js';
import { levelOf, levelsFor, LEVEL_LABEL, isThread } from '../lib/attention.js';
import { can } from '../lib/perms.js';
import { fmtWhen, plural, nameList } from '../lib/util.js';
import { plain } from '../lib/format.js';
import { Icon } from '../ui/icons.js';
import { Avatar, Stack, Tile, RoomIcon, Seg, presenceLabel } from '../ui/kit.js';
import { Stream, Message, focusComposer } from './stream.js';
import { RequestBanner, StageMod } from './safety.js'; // message requests; voice moderation on the stage
import { JumpToDate } from './messaging.js'; // go to a date
import { joinVoice, leaveVoice, toggleMute, toggleDeaf } from '../voice.js';
import { leavingCall } from '../calls.js';
import { toggleCamera, toggleScreen, mediaOf, canShareScreen } from '../voice.js';
import { emit, toast } from '../store.js';
import { RoomForm, RoomBrowser } from './modals.js';
import { showProfile } from './people.js';
import { PinsButton, pinsOf } from './media.js'; // pinned messages
import { ForumView, StageRoom, RoomPlaces } from './places.js'; // forum and stage rooms; access, follows and nicknames in details
import { CallButtons, CallStrip, CallEndNote } from './calls.js'; // calls in direct conversations and groups
import { PersonExtras, RoomLimit, VoiceExtras, PopOut } from './voiceopts.js'; // per-person volume, room limit, soundboard and options, picture in picture
// Activities, reactions, the muted note, the call clock, connection quality, ringing again (voice and calls track).
import { ActivityButtons, ActivityTile, ReactionFloat, ActivityAnnouncer, MutedBanner, CallTimer, ConnHeader, RingAgain, Bars, qualityOf, QLABEL } from './activities.js';
import { videoBlocked } from '../voice.js';
import { notifyMenu, openDrawer, roomMenu, dmMenu } from './nav.js'; // the header's bell, the phone's drawer (shell track)
import { openMenu } from '../store.js';
import { togglePeople } from './people.js'; // the member list toggle, remembered (shell track)
import { vp } from '../voiceopts.js';
import { DmHeaderButtons, dmHeaderItems } from './dm-manage.js'; // Add people and the members of a group (server/dms.js)
import { DirectLine, KeyBanner, remoteOf } from './p2p.js'; // a friend on another PC: how it travels, and a changed security code

const Back = () => S.ui.phone && html`<button class="ib" aria-label="Back" onClick=${back}><${Icon} name="back" /></button>`;

// The call's controls. On the stage: one compact bar of icon buttons, in
// three groups (what you show: camera, screen, activities, reactions,
// sounds | what you say and hear: mic, deafen | settings and leave, in red).
// Compact (the shell's dock): mic, deafen, a camera or screen that is on, leave.
export function VoiceControls({ compact }) {
  const c = S.call;
  const size = compact ? 18 : 20;
  const leave = c.dm ? 'Leave call' : 'Leave voice';
  const mic = html`<button class=${`ib vc mic${c.muted ? ' on' : ''}`} aria-pressed=${String(c.muted)} aria-label=${c.muted ? 'Unmute' : 'Mute'} data-tip=${c.muted ? 'Unmute' : 'Mute'} onClick=${toggleMute}><${Icon} name=${c.muted ? 'mic-off' : 'mic'} size=${size} /></button>`;
  const ear = html`<button class=${`ib vc ear${c.deaf ? ' on' : ''}`} aria-pressed=${String(c.deaf)} aria-label=${c.deaf ? 'Hear the room again' : 'Stop hearing the room'} data-tip=${c.deaf ? 'Hear the room again' : 'Stop hearing the room'} onClick=${toggleDeaf}><${Icon} name=${c.deaf ? 'headphones-off' : 'headphones'} size=${size} /></button>`;
  const out = html`<button class="ib vc danger leave" aria-label=${leave} data-tip=${c.dm ? 'Hang up' : 'Leave'} onClick=${leaveVoice}><${Icon} name="phone-off" size=${size} /></button>`;
  if (compact) return html`${mic}${ear}<${MediaControls} c=${c} size=${size} compact />${out}`;
  // Phone: one row (mic, deafen, camera, screen, More, leave); More opens the
  // rest (activities, reactions, soundboard, push to talk, options) under it.
  if (S.ui.phone) return html`<${PhoneControls} mic=${mic} ear=${ear} out=${out} c=${c} size=${size} />`;
  return html`
    <${MediaControls} c=${c} size=${size} />
    <${ActivityButtons} />
    <${VoiceExtras} only="board" />
    <span class="vc-sep" aria-hidden="true"></span>
    ${mic}${ear}
    <${VoiceExtras} only="hold" />
    <span class="vc-sep" aria-hidden="true"></span>
    <${VoiceExtras} only="opts" />
    ${out}`;
}

function PhoneControls({ mic, ear, out, c, size }) {
  const [more, setMore] = useState(false);
  return html`
    ${mic}${ear}<${MediaControls} c=${c} size=${size} />
    <button class=${`ib vc vc-more${more ? ' open' : ''}`} aria-expanded=${String(more)} aria-label="More call controls" data-tip="More" onClick=${() => setMore(!more)}><${Icon} name="more" size=${size} /></button>
    ${out}
    ${more && html`<div class="vc-more-row" role="group" aria-label="More call controls">
      <${ActivityButtons} /><${VoiceExtras} only="board" /><${VoiceExtras} only="hold" /><${VoiceExtras} only="opts" />
    </div>`}`;
}

// Each person's line says what is really happening with their audio.
function peerNote(id, inCall) {
  if (!inCall) return null;
  // Their connection dropped; the server holds their place for a while.
  if (S.voiceState[S.call?.room]?.[id]?.reconnecting) return 'Reconnecting\u2026';
  if (id === S.me) return null;
  const st = S.peers[id];
  if (st === 'connected') return null;
  if (st === 'failed') return 'Can\u2019t connect';
  if (st === 'disconnected') return 'Reconnecting';
  return 'Connecting';
}

// How the line to each person is doing, from the live connection state.
// Only shown once you are in the room: before that there is no connection.
// Connected lines show their measured quality (js/lib/netquality.js): good, fair or poor.
function Quality({ id, inCall }) {
  if (!inCall || id === S.me) return null;
  const q = qualityOf(id);
  return html`<${Bars} q=${q} label=${S.peers[id] === 'failed' ? 'Can\u2019t connect' : QLABEL[q]} />`;
}

// Tiles (and the faces in them) get smaller as the room fills, so everyone
// fits without scrolling. The size also sets the tile width (css/places.css).
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
    ${(!compact || c.camera) && html`<button class=${`ib vc cam${c.camera ? ' live' : ''}${blocked ? ' unavailable' : ''}`} aria-pressed=${String(!!c.camera)} aria-busy=${String(!!c.cameraBusy)} aria-disabled=${blocked ? 'true' : null} aria-label=${camLabel} data-tip=${camLabel} onClick=${blocked ? null : toggleCamera}><${Icon} name=${c.camera ? 'camera' : 'camera-off'} size=${size} /></button>`}
    ${(!compact || c.screen) && html`<button class=${`ib vc scr${c.screen ? ' live' : ''}${canShare && !blocked ? '' : ' unavailable'}`} aria-pressed=${String(!!c.screen)} aria-busy=${String(!!c.screenBusy)} aria-disabled=${canShare && !blocked ? null : 'true'} aria-label=${scrLabel} data-tip=${scrLabel} onClick=${canShare && !blocked ? toggleScreen : null}><${Icon} name=${c.screen ? 'screen-off' : 'screen'} size=${size} /></button>`}`;
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
      ? html`<${Video} stream=${t.stream} mirror=${mine && t.kind === 'camera' && vp().mirror} contain=${screenTile} label=${videoLabel} />`
      : html`<span class="vt-face"><${Avatar} user=${u} size=${small ? 40 : 64} speaking=${talking} dim=${!!note} /></span>`}
    <button class="vt-hit" aria-pressed=${String(!!focused)} aria-label=${focused ? `Show everyone again` : `Make ${what} large`} onClick=${() => setFocus(t.key, focused)}></button>
    <span class="vt-label">
      ${!screenTile && quiet && html`<span class="vt-muted" role="img" aria-label=${deaf ? 'Not listening' : 'Muted'}><${Icon} name=${deaf ? 'headphones-off' : 'mic-off'} size=${14} /></span>`}
      ${screenTile && html`<${Icon} name="screen" size=${14} />`}
      <span class="trunc">${screenTile ? what : first}</span>
      ${!screenTile && html`<${Quality} id=${t.id} inCall=${true} />`}
    </span>
    ${note && html`<span class="vt-note" role="status">${note}</span>`}
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
  // Reconnecting after a dropped connection: still in the call, controls and all.
  const reconnecting = inCall && S.call.status === 'reconnecting';
  const starting = inCall && S.call.status !== 'live' && !reconnecting;
  // A call that is still ringing people shows them, waiting, beside the people in it.
  const meta = dm ? S.calls[roomId] : null;
  const ringingIds = inCall && !starting && meta ? meta.ringing.filter((id) => S.users[id] && !ids.includes(id)) : [];
  const alone = dm && inCall && !starting && ids.length <= 1 && !ringingIds.length;
  // Faces make room for an activity (the whiteboard or a game) when one is running.
  const size = inCall && S.activity?.[roomId] ? 40 : faceSize(ids.length + ringingIds.length);
  // A phone's tiles are half its width: the face stays inside them.
  const face = S.ui.phone ? Math.min(size, 48) : size;
  const ringNames = nameList(ringingIds.map((id) => S.users[id].name.split(' ')[0]));
  const status = !inCall ? null : starting
    ? html`<span class="stage-conn wait" role="status">${S.call.status === 'mic' ? 'Waiting for your microphone\u2026' : dm ? 'Calling\u2026' : 'Joining\u2026'}</span>`
    : reconnecting
      ? html`<span class="stage-conn act-reconn" role="status"><i aria-hidden="true"></i>Reconnecting\u2026</span>`
      : ringingIds.length && ids.length <= 1
        ? html`<span class="stage-conn ring" role="status"><i aria-hidden="true"></i>Ringing ${ringNames}\u2026</span>`
        : alone
          ? html`<span class="stage-conn wait" role="status">${meta?.answered ? 'Everyone else left' : 'Nobody has picked up yet'}</span>`
          : html`<${ConnHeader} room=${roomId} />`;
  // Once someone in the call shows a camera or a screen, the stage becomes tiles.
  const tiles = inCall && !starting ? mediaTiles(ids, roomId) : [];
  const media = tiles.some((t) => t.kind !== 'face');
  return html`<div class=${`stage${inCall ? ' in' : ''}${ids.length ? '' : ' empty'}${media ? ' media' : ''}${dm ? ' call' : ''}`} data-size=${size} role="region" aria-label=${dm ? 'Call' : 'Voice'}>
    <div class="stage-top">
      <span class="stage-count"><${Icon} name=${dm ? 'phone' : 'speaker'} size=${16} />${ids.length ? `${ids.length} in ${dm ? 'the call' : 'voice'}` : dm ? 'Call' : 'Voice'}<${RoomLimit} room=${roomId} n=${ids.length} /></span>
      ${status}
      ${inCall && !starting && html`<${CallTimer} room=${roomId} />`}
    </div>
    ${inCall && html`<${MutedBanner} />`}
    ${inCall && html`<${ActivityAnnouncer} />`}
    <${ActivityTile} room=${roomId} />
    ${media ? html`<${MediaStage} tiles=${tiles} roomId=${roomId} />` : ids.length
      ? html`<div class="stage-people" style=${`--face:${face}px`} data-n=${Math.min(ids.length + ringingIds.length, 9)}>
          ${ids.map((id) => {
            const u = S.users[id];
            const st = S.voiceState[roomId]?.[id] || {};
            const mine = id === S.me;
            const quiet = mine ? S.call?.muted : st.muted;
            const deaf = mine ? S.call?.deaf : st.deaf;
            const note = peerNote(id, inCall);
            const talking = !!S.speaking[id] && !quiet;
            // One tile per person: the face in the middle, the name and their
            // mic bottom left, a note top left, volume and moderation top right.
            return html`<div class=${`stage-person${talking ? ' talking' : ''}${note ? ' waiting' : ''}`} key=${id}>
              <span class="stage-face"><${Avatar} user=${u} size=${face} speaking=${talking} dim=${!!note} /></span>
              <span class="stage-name">
                ${quiet && html`<span class="muted-ic" role="img" aria-label=${deaf ? 'Not listening' : 'Muted'} data-tip=${deaf ? 'Not listening' : 'Muted'}><${Icon} name=${deaf ? 'headphones-off' : 'mic-off'} size=${14} /></span>`}
                <span class="trunc">${mine ? 'You' : u.name}</span><${MediaMarks} st=${st} /><${Quality} id=${id} inCall=${inCall && !starting} />
              </span>
              ${note && html`<span class="stage-note">${note}</span>`}
              <span class="stage-tools"><${StageMod} id=${id} room=${roomId} /><${PersonExtras} id=${id} room=${roomId} /></span>
              <${ReactionFloat} id=${id} room=${roomId} />
            </div>`;
          })}
          ${ringingIds.map((id) => html`<div class="stage-person ringing waiting" key=${id}>
            <span class="stage-face"><${Avatar} user=${S.users[id]} size=${face} dim /></span>
            <span class="stage-name"><span class="trunc">${S.users[id].name}</span></span>
            <span class="stage-note">Ringing\u2026</span>
          </div>`)}
        </div>`
      : html`<p class="stage-empty">${starting ? 'Starting your microphone\u2026' : 'Nobody\u2019s in here yet. Join, and the room shows as live to everyone.'}</p>`}
    ${dm && html`<${RingAgain} room=${roomId} />`}
    <div class="stage-acts">
      ${inCall && !starting
        ? html`<${VoiceControls} />`
        : dm
          ? html`<button class="btn live" disabled aria-busy="true"><${Icon} name="phone" size=${16} />${S.call?.status === 'mic' ? 'Starting your microphone\u2026' : 'Calling\u2026'}</button>`
          : html`<button class="btn primary" disabled=${starting} aria-busy=${String(!!starting)} onClick=${() => leavingCall(roomId, () => joinVoice(roomId))}><${Icon} name="speaker" size=${16} />${starting ? 'Joining\u2026' : 'Join voice'}</button>`}
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
        <span class="start-mark" aria-hidden="true"><${RoomIcon} kind=${meta.kind} size=${28} /></span>
        <h2>${meta.title}</h2>
        <p>${meta.topic ? `${meta.topic}. ` : ''}${empty ? 'Nothing has been said here yet.' : `This is where ${meta.title} begins.`}</p>
        ${can(S, meta.house, 'rooms') && empty && html`<div class="acts"><button class="btn" onClick=${() => openModal(RoomForm, { room: conv })}><${Icon} name="edit" size=${16} />Edit room</button></div>`}
      </div>`;
  }
  return html`<div class="start">
    ${meta.user && html`<span class="start-mark" aria-hidden="true"><${Avatar} user=${meta.user} size=${56} /></span>`}
    <h2>${meta.title}</h2>
    <p>${meta.user
      ? `This is the start of your conversation with ${meta.user.name.split(' ')[0]}. Only the two of you can read it.`
      : `A group of ${meta.dm.members.length}. Only the people in it can read it.`}</p>
  </div>`;
}

// Phone header (shell track): what does not fit beside the title goes here.
function headerMore(conv, meta, level, anchor) {
  openMenu({
    anchor,
    items: [
      ...(meta.dm ? dmHeaderItems(conv, anchor) : []),
      pinsOf(conv).length > 0 && { label: `Pinned messages (${pinsOf(conv).length})`, icon: 'pin', onSelect: () => togglePane('pins') },
      { label: level === 'muted' ? 'Notifications (muted)' : 'Notifications', icon: level === 'muted' ? 'bell-off' : 'bell', onSelect: () => setTimeout(() => notifyMenu(conv, { anchor }), 0) },
      // Go to a date opens its own popover from the (hidden) calendar button beside this menu's button.
      { label: 'Go to a date', icon: 'calendar', onSelect: goToDate },
      { label: 'Search here', icon: 'search', onSelect: () => go({ type: 'search', q: `in:"${meta.title.toLowerCase()}" ` }) },
      { label: 'Details', icon: 'info', onSelect: () => togglePane('details') },
    ],
  });
}

// Desktop header: the room's More menu starts with what moved out of the bar
// (brief 15: notifications, members, search and more stay in it).
const goToDate = () => setTimeout(() => document.querySelector('.main .bar .bar-date-src button')?.click(), 0);
function barMoreItems(conv, meta, pane) {
  return [
    !isThread(conv) && { label: 'Go to a date', icon: 'calendar', onSelect: goToDate },
    meta.room && { label: pane === 'details' ? 'Hide details' : 'Details', icon: 'info', onSelect: () => togglePane('details') },
    { sep: true },
  ];
}

export function Conversation({ conv }) {
  const meta = convMeta(conv);
  if (!meta) return null;
  const pane = S.ui.pane?.type;
  const members = membersOf(conv).map((id) => S.users[id]);
  const here = members.filter((u) => u.presence !== 'offline' && u.id !== S.me);
  const first = meta.user?.name.split(' ')[0];
  const inVoice = meta.room ? (S.voice[conv] || []).length : 0;
  const level = levelOf(S, conv);
  const phone = S.ui.phone;
  // In a live voice room or call the stage takes the room; an empty chat folds away.
  const live = S.call?.room === conv && (meta.kind === 'voice' || !!meta.dm);
  const chatEmpty = !(S.msgs[conv] || []).some((m) => !m.call);
  return html`<section class=${`main conv kind-${meta.kind}${live ? ' voice-live' : ''}${live && chatEmpty ? ' chat-empty' : ''}`} aria-label=${meta.title}>
    <header class="bar">
      <${Back} />
      <h1 class="bar-title trunc">
        ${meta.user ? html`<${Avatar} user=${meta.user} size=${24} presence />` : meta.room ? html`<${RoomIcon} kind=${meta.kind} />` : html`<${Icon} name="people" />`}
        <span class="trunc">${meta.title}</span>
      </h1>
      ${phone && meta.house && html`<button class="ib drawer-btn title-switch" aria-label="Rooms and places" data-tip="Rooms and places" onClick=${openDrawer}><${Icon} name="chev-d" size=${16} /></button>`}
      ${meta.topic && html`<span class="bar-sub trunc">${meta.topic}</span>`}
      ${meta.user && html`<span class="bar-sub trunc">${presenceLabel(meta.user)}${meta.user.status ? `. ${meta.user.status}` : ''}</span>`}
      ${meta.dm && !phone && remoteOf(conv) && html`<${DirectLine} conv=${conv} />`}
      <div class="bar-end">
        ${meta.dm && html`<${CallButtons} conv=${conv} />`}
        ${meta.dm && !phone && html`<${DmHeaderButtons} conv=${conv} />`}
        ${!phone && html`<${PinsButton} conv=${conv} />`}
        ${!phone && html`<button class=${`ib${level === 'muted' ? ' is-muted' : ''}`} aria-label="Notifications" aria-haspopup="menu" data-tip=${level === 'muted' ? 'Muted' : 'Notifications'}
          onClick=${(e) => notifyMenu(conv, { anchor: e.currentTarget.getBoundingClientRect() })}><${Icon} name=${level === 'muted' ? 'bell-off' : 'bell'} /></button>`}
        <span class="bar-date-src" aria-hidden="true"><${JumpToDate} conv=${conv} /></span>
        ${!meta.user && html`<button class=${`ib${pane === 'people' ? ' on' : ''}`} aria-pressed=${String(pane === 'people')} aria-label=${`People, ${here.length} here`}
          data-tip=${pane === 'people' ? 'Hide the member list' : `Show the member list (${here.length} here${inVoice ? `, ${inVoice} in voice` : ''})`} onClick=${togglePeople}><${Icon} name="people" /></button>`}
        ${phone
          ? html`<button class="ib" aria-label="More" aria-haspopup="menu" data-tip="More" onClick=${(e) => headerMore(conv, meta, level, e.currentTarget.getBoundingClientRect())}><${Icon} name="more-v" /></button>`
          : html`${!meta.room && html`<button class=${`ib${pane === 'details' ? ' on' : ''}`} aria-pressed=${String(pane === 'details')} aria-label="Details" data-tip="Details and notifications" onClick=${() => togglePane('details')}><${Icon} name="info" /></button>`}
            <button class="ib bar-more" aria-label="More options" aria-haspopup="menu" data-tip="More" onClick=${(e) => (meta.room ? roomMenu : dmMenu)(conv, { anchor: e.currentTarget.getBoundingClientRect() }, barMoreItems(conv, meta, pane))}><${Icon} name="more" /></button>
            <button class="bar-search" aria-label=${`Search in ${meta.title}`} onClick=${() => go({ type: 'search', q: `in:"${meta.title.toLowerCase()}" ` })}>
              <span class="bar-search-text trunc">Search ${meta.room ? meta.title : ''}</span><${Icon} name="search" size=${16} />
            </button>`}
      </div>
    </header>
    ${meta.kind === 'voice' && html`<${Stage} roomId=${conv} />`}
    ${meta.kind === 'stage' && html`<${StageRoom} conv=${conv} />`}
    ${meta.dm && (S.call?.room === conv
      ? html`<${Stage} roomId=${conv} dm />`
      : html`<${CallStrip} conv=${conv} /><${CallEndNote} conv=${conv} />`)}
    ${meta.dm && html`<${RequestBanner} conv=${conv} />`}
    ${meta.dm && html`<${KeyBanner} conv=${conv} />`}
    ${meta.kind === 'forum' ? html`<${ForumView} key=${conv} conv=${conv} />` : html`<${Stream} key=${conv} conv=${conv} intro=${html`<${Intro} conv=${conv} meta=${meta} />`}
      placeholder=${meta.user ? `Message ${first}` : `Message ${meta.room && meta.kind === 'text' ? '#' : ''}${meta.title}`} />`}
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
  return html`<aside class="pane thread-pane" aria-label="Thread">
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
              ${(can(S, room.house, 'rooms') || room.perms?.manage) && html`<div><button class="btn" onClick=${() => openModal(RoomForm, { room: conv })}><${Icon} name="edit" size=${16} />Edit room</button></div>`}
              <${RoomPlaces} conv=${conv} />`
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
