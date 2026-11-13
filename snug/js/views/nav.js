// Navigation, in three fixed levels: the rail (where you are: Home, Messages,
// Discover, your communities), the context column (what is in that place),
// and your own panel pinned at the bottom of the column. Nothing here
// reorders itself under your pointer.
//
// The place you are in is S.ui.space: 'home' | 'messages' | 'discover' | a
// house id. It follows the view (opening a room puts you in its house, a
// direct message in Messages) and is remembered on this device with the last
// view in each place, so coming back to a place reopens where you were.
import { html } from '../../vendor/preact-htm.js';
import {
  S, me, go, openConv, openThread, openPop, openMenu, openModal, openQuick, openLayer, toggleGroup,
  setNotify, markConvRead, markHouseRead, leaveHouse, deleteRoom, convMeta, isOnline, toast, person,
} from '../store.js';
import { attention, houseAttention, levelOf, unreadOf, threadsOf, roomIds, levelsFor, LEVEL_LABEL } from '../lib/attention.js';
import { can } from '../lib/perms.js';
import { plural, fmtWhen } from '../lib/util.js';
import { plain } from '../lib/format.js';
import { TOPICS, friendRequests, upcomingEvents, eventState } from '../lib/social.js';
import { Icon } from '../ui/icons.js';
import { Nook } from '../ui/brand.js';
import { Avatar, Stack, Tile, RoomIcon, PRESENCE, presenceLabel } from '../ui/kit.js';
import { MePop } from './people.js';
import { RoomForm, Confirm, Invite, AddHouse, NewMessage, RoomBrowser } from './modals.js';
import { Settings, HouseSettings } from './settings.js';
import { modPages, requestOf } from './safety.js'; // moderation entry in the house menu; message requests
import { VoiceControls } from './conversation.js';
import { RailHouses } from './places.js'; // the rail's folders and house order
import { joinVoice } from '../voice.js';
import { leavingCall } from '../calls.js';

const rectOf = (e) => e.currentTarget.getBoundingClientRect();
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
export const MOD = isMac ? '⌘' : 'Ctrl';

// ---------- Where you are ----------

const NAV_KEY = 'snug.nav';
const kept = (() => { try { return JSON.parse(localStorage.getItem(NAV_KEY)) || {}; } catch { return {}; } })();
let lastIn = kept.lastIn && typeof kept.lastIn === 'object' ? kept.lastIn : {};
let space = typeof kept.space === 'string' ? kept.space : null;
// Whose places these are: another account signing in on this device starts fresh.
let navMe = typeof kept.me === 'string' ? kept.me : null;
function keep() {
  try { localStorage.setItem(NAV_KEY, JSON.stringify({ me: navMe, space: S.ui.space, lastIn })); } catch { /* full or blocked */ }
}

export const isHouseSpace = (sp) => !!sp && sp !== 'home' && sp !== 'messages' && sp !== 'discover';
const validSpace = (sp) => sp === 'home' || sp === 'messages' || sp === 'discover' || !!S.houses[sp]?.joined;

// The place a view belongs to, or null if it can be seen from anywhere
// (search, a person's page), in which case you stay where you were.
export function spaceOf(view) {
  switch (view?.type) {
    case 'conv': {
      const meta = convMeta(view.id);
      if (!meta) return null;
      return meta.house || 'messages';
    }
    case 'house': return S.houses[view.id]?.joined ? view.id : 'discover';
    case 'discover': return 'discover';
    case 'messages': return 'messages';
    case 'home': case 'catchup': case 'saved': case 'friends': return 'home';
    default: return null;
  }
}

// Views visited before the current one, for Back on desktop (newest last).
const trail = [];
let seen = null;
let returning = false;
const sameView = (a, b) => a && b && a.type === b.type && a.id === b.id && a.section === b.section && a.topic === b.topic && a.tab === b.tab;

// Called once per render, before anything reads S.ui.space.
export function syncSpace() {
  if (S.me && S.me !== navMe) {
    if (navMe) { trail.length = 0; lastIn = {}; seen = null; space = null; if (!validSpace(S.ui.space)) S.ui.space = undefined; }
    navMe = S.me;
  }
  if (S.ui.space === undefined) S.ui.space = space;
  const v = S.ui.view;
  if (v !== seen) {
    if (seen && !returning && !sameView(seen, v) && !(seen.type === 'search' && v.type === 'search')) {
      trail.push(seen);
      if (trail.length > 50) trail.shift();
    }
    returning = false;
    seen = v;
    const sp = spaceOf(v);
    if (sp) {
      S.ui.space = sp;
      lastIn = { ...lastIn, [sp]: v };
    } else if (!S.ui.space) S.ui.space = 'home';
    keep();
  }
  if (!validSpace(S.ui.space)) { S.ui.space = 'home'; keep(); }
  space = S.ui.space;
}

// Back to the previous view (desktop). False when there is nowhere to go.
export function goBack() {
  while (trail.length) {
    const v = trail.pop();
    if (v.type === 'conv' && !convMeta(v.id)) continue;
    returning = true;
    if (v.type === 'conv') openConv(v.id); else go(v);
    return true;
  }
  return false;
}

const roomVisible = (id) => {
  const room = S.rooms[id];
  const h = room && S.houses[room.house];
  return !!h?.joined && (!h.newcomer || h.starter.includes(id));
};

// Go to a place from the rail. Choosing the place you are already in goes to
// its front page; choosing another reopens where you were there.
export function openSpace(sp) {
  const again = S.ui.space === sp;
  const last = again ? null : lastIn[sp];
  S.ui.space = sp;
  keep();
  if (sp === 'home') return go(last && spaceOf(last) === 'home' ? last : { type: 'home' });
  if (sp === 'discover') return go(last?.type === 'discover' ? last : { type: 'discover' });
  if (sp === 'messages') {
    if (again && S.ui.view.type === 'conv' && spaceOf(S.ui.view) === 'messages') return undefined;
    const id = last?.type === 'conv' && S.dms[last.id] ? last.id : S.dmOrder[0];
    return id ? openConv(id) : go({ type: 'messages' });
  }
  if (!S.ui.phone && last?.type === 'conv' && roomVisible(last.id) && S.rooms[last.id].house === sp) return openConv(last.id);
  return go({ type: 'house', id: sp });
}

// Open a community wherever you are: its place on desktop, its screen on a phone.
export const openHouse = (id) => (S.ui.phone ? go({ type: 'house', id }) : openSpace(id));

// ---------- Rows ----------

function Marker({ attn }) {
  if (attn?.needs) return html`<span class="badge" aria-label=${`${attn.needs} need you`}>${attn.needs}</span>`;
  if (attn?.soft) return html`<span class="dot" role="img" aria-label="New activity"></span>`;
  return null;
}

function Row({ icon, label, hint, sel, attn, muted, sub, live, end, onClick, onMenu }) {
  const cls = `row${sel ? ' sel' : ''}${attn?.soft || attn?.needs ? ' unread' : ''}${muted ? ' muted' : ''}${sub ? ' nested' : ''}${live ? ' live' : ''}`;
  return html`<button class=${cls} aria-current=${sel ? 'page' : undefined} onClick=${onClick}
    onContextMenu=${onMenu && ((e) => { e.preventDefault(); onMenu({ x: e.clientX, y: e.clientY }); })}>
    <span class="row-ic">${icon}</span>
    <span class="trunc grow">${label}${hint && html`<span class="row-hint">${hint}</span>`}</span>
    <span class="row-end">${end}<${Marker} attn=${attn} /></span>
  </button>`;
}

const current = () => (S.ui.view.type === 'conv' ? S.ui.view.id : null);
// Home's Recent list repeats places counted elsewhere (Catch up carries the
// total), so it marks them with a plain dot instead of another coral count.
const quietAttn = (a) => ({ needs: 0, soft: !!(a?.needs || a?.soft) });

function notifyItems(kind, id, level) {
  const levels = levelsFor(S, kind, id);
  return [
    { heading: 'Notify me about' },
    ...levels.map((l) => ({ label: LEVEL_LABEL[l], checked: level === l, onSelect: () => setNotify(kind, id, l) })),
  ];
}

function roomMenu(id, pos) {
  const room = S.rooms[id];
  const manage = can(S, room.house, 'rooms');
  const a = attention(S, id);
  openMenu({
    ...pos,
    items: [
      { label: 'Mark read', icon: 'check', disabled: !a.soft && !a.needs, onSelect: () => markConvRead(id) },
      ...notifyItems('room', id, levelOf(S, id)),
      manage && { sep: true },
      manage && { label: 'Edit room', icon: 'edit', onSelect: () => openModal(RoomForm, { room: id }) },
      manage && {
        label: 'Delete room', icon: 'trash', danger: true,
        onSelect: () => openModal(Confirm, {
          title: `Delete ${room.name}?`, danger: true, action: 'Delete room',
          text: `Everything written in ${room.name} goes with it, for everyone. This can’t be undone.`,
          onConfirm: () => deleteRoom(id),
        }),
      },
    ],
  });
}

function dmMenu(id, pos) {
  const a = attention(S, id);
  openMenu({
    ...pos,
    items: [
      { label: 'Mark read', icon: 'check', disabled: !a.soft && !a.needs, onSelect: () => markConvRead(id) },
      ...notifyItems('dm', id, levelOf(S, id)),
    ],
  });
}

export function houseMenu(id, pos) {
  const h = S.houses[id];
  const a = houseAttention(S, id);
  const settings = can(S, id, 'roles');
  openMenu({
    ...pos,
    items: [
      { label: 'Mark house as read', icon: 'check', disabled: !a.soft && !a.needs, onSelect: () => markHouseRead(id) },
      ...notifyItems('house', id, h.notify),
      { sep: true },
      can(S, id, 'invite') && { label: 'Invite people', icon: 'link', onSelect: () => openModal(Invite, { house: id }) },
      { label: 'Browse rooms', icon: 'room', onSelect: () => openModal(RoomBrowser, { house: id }) },
      can(S, id, 'rooms') && { label: 'New room', icon: 'plus', onSelect: () => openModal(RoomForm, { house: id, group: h.groups[0].id }) },
      settings && { label: 'House settings', icon: 'sliders', onSelect: () => openLayer({ C: HouseSettings, props: { house: id } }) },
      // Custom emoji: roles that may manage emoji but not the house reach the Emoji page from here.
      !settings && can(S, id, 'emoji') && { label: 'Custom emoji', icon: 'smile', onSelect: () => openLayer({ C: HouseSettings, props: { house: id, page: 'emoji' } }) },
      // Soundboard and voice rooms (js/views/voiceopts-settings.js): for roles that manage sounds but not the house.
      !settings && can(S, id, 'sounds') && { label: 'Soundboard', icon: 'voice', onSelect: () => openLayer({ C: HouseSettings, props: { house: id, page: 'voice' } }) },
      // Moderation (js/views/safety-settings.js): reports, bans and the house log, each by its own permission.
      modPages(id) && { label: h.reportsOpen ? `Moderation (${h.reportsOpen} open)` : 'Moderation', icon: 'shield', onSelect: () => openLayer({ C: HouseSettings, props: { house: id, page: can(S, id, 'moderate') ? 'reports' : can(S, id, 'ban') ? 'bans' : 'log' } }) },
      { sep: true },
      {
        label: 'Leave house', icon: 'leave', danger: true,
        onSelect: () => openModal(Confirm, {
          title: `Leave ${h.name}?`, danger: true, action: 'Leave house',
          text: 'Its rooms leave your sidebar. You’ll need a new invitation to come back.',
          onConfirm: () => leaveHouse(id).catch((e) => toast(e.offline ? 'You’re offline. Try again when you’re back.' : e.message)),
        }),
      },
    ],
  });
}

// ---------- Counts the rail and tabs share ----------

export function dmAttention() {
  let needs = 0, soft = false;
  for (const d of S.dmOrder) { const a = attention(S, d); needs += a.needs; soft = soft || a.soft; }
  return { needs, soft };
}
// Home holds Catch up's invitations and the friend requests waiting on you.
export const homeNeeds = () => S.invites.length + friendRequests(S, 'incoming').length;
// Members online right now, not counting you: the one rule for "here" and "online".
export const onlineIn = (h) => Object.keys(h.members || {}).filter((u) => u !== S.me && S.users[u] && S.users[u].presence !== 'offline').length;
// How that count reads: a mint dot and a number, or "Just you" with no dot.
export const OnlineCount = ({ n, cls = '' }) => (n > 0
  ? html`<span class=${cls}><i class="pres inline open" aria-hidden="true"></i><span class="num">${n}</span> online</span>`
  : html`<span class=${cls}>Just you</span>`);

// ---------- The rail ----------

function RailItem({ label, sel, attn, onClick, onMenu, cls = '', children }) {
  const needs = attn?.needs || 0;
  const unread = !needs && attn?.soft;
  const said = needs ? `, ${plural(needs, 'thing needs', 'things need')} you` : unread ? ', new activity' : '';
  return html`<div class=${`rail-item${sel ? ' sel' : ''}${unread ? ' unread' : ''}`}>
    <button class=${`rail-btn ${cls}`} aria-current=${sel ? 'page' : undefined} data-tip=${label} data-tip-side="right"
      onClick=${onClick} onContextMenu=${onMenu && ((e) => { e.preventDefault(); onMenu({ x: e.clientX, y: e.clientY }); })}>
      <span class="rail-face" aria-hidden="true">${children}</span>
      <span class="sr">${label}${said}</span>
      ${needs > 0 && html`<span class="badge rail-badge" aria-hidden="true">${needs > 99 ? '99+' : needs}</span>`}
    </button>
  </div>`;
}

// Up and Down move between rail items, as in any vertical toolbar.
function onRailKey(e) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
  const list = [...e.currentTarget.querySelectorAll('.rail-btn')];
  const i = list.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  const n = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
  list[n].focus();
}

export function Rail() {
  const sp = S.ui.space;
  return html`<nav class="rail" aria-label="Places" onKeyDown=${onRailKey}>
    <div class="rail-scroll">
      <${RailItem} label="Home" cls="rail-home" sel=${sp === 'home'} attn=${{ needs: 0, soft: homeNeeds() > 0 }} onClick=${() => openSpace('home')}>
        <${Nook} size=${32} />
      <//>
      <${RailItem} label="Messages" sel=${sp === 'messages'} attn=${dmAttention()} onClick=${() => openSpace('messages')}>
        <${Icon} name="room" size=${22} />
      <//>
      <${RailItem} label="Discover" sel=${sp === 'discover'} onClick=${() => openSpace('discover')}>
        <${Icon} name="compass" size=${22} />
      <//>
      <div class="rail-sep" role="separator"></div>
      <${RailHouses} sp=${sp} RailItem=${RailItem} houseMenu=${houseMenu} openSpace=${openSpace} houseAttention=${houseAttention} />
      <${RailItem} label="Create or join a community" cls="rail-add" attn=${{ needs: 0 }} onClick=${() => openModal(AddHouse)}>
        <${Icon} name="plus" size=${22} />
      <//>
    </div>
  </nav>`;
}

// ---------- Context column: one per place ----------

function JumpButton({ label }) {
  return html`<button class="jump-btn" onClick=${() => openQuick()} aria-label="Jump to a room or person, or search messages">
    <${Icon} name="search" size=${16} /><span class="trunc">${label}</span><span class="kbd">${MOD} K</span>
  </button>`;
}

function CtxHead({ children, cls = '' }) {
  return html`<div class=${`ctx-head ${cls}`}>${children}</div>`;
}

// The conversations you were in most recently, across every place.
function recentConvs(n = 8) {
  const last = (c) => { const l = S.msgs[c] || []; return l.length ? l[l.length - 1].ts : 0; };
  const rooms = S.houseOrder.flatMap((h) => roomIds(S, h)).filter((r) => roomVisible(r) && S.rooms[r].kind !== 'voice');
  return [...S.dmOrder, ...rooms].filter((c) => last(c)).sort((a, b) => last(b) - last(a)).slice(0, n);
}

// A mint mark on a conversation with a call going on in it.
const callLive = (id) => (S.voice[id] || []).length > 0;
const CallMark = () => html`<span class="call-mark" role="img" aria-label="Call in progress" data-tip="Call in progress"><${Icon} name="phone" size=${14} /></span>`;

function convIcon(id) {
  const meta = convMeta(id);
  if (meta.user) return html`<${Avatar} user=${meta.user} presence />`;
  if (meta.dm) return html`<span class="avatar" style="--tile-c:0;--tile-ink-c:0">${meta.dm.members.length}</span>`;
  return html`<${RoomIcon} kind=${meta.kind} size=${18} />`;
}

function HomeCtx() {
  const v = S.ui.view;
  const cur = current();
  const requests = friendRequests(S, 'incoming').length;
  const catchNeeds = S.invites.length + S.houseOrder.reduce((n, h) => n + houseAttention(S, h).needs, 0) + dmAttention().needs;
  const recent = recentConvs();
  return html`
    <${CtxHead}><${JumpButton} label="Find or start a conversation" /><//>
    <div class="nav-scroll">
      <div class="nav-group">
        <${Row} icon=${html`<${Icon} name="house" />`} label="Home" sel=${v.type === 'home'} onClick=${() => go({ type: 'home' })} />
        <${Row} icon=${html`<${Icon} name="tray" />`} label="Catch up" sel=${v.type === 'catchup'} attn=${{ needs: catchNeeds }} onClick=${() => go({ type: 'catchup' })} />
        <${Row} icon=${html`<${Icon} name="people" />`} label="Friends" sel=${v.type === 'friends'} attn=${{ needs: requests }} onClick=${() => go({ type: 'friends' })} />
        <${Row} icon=${html`<${Icon} name="save" />`} label="Saved" sel=${v.type === 'saved'} end=${S.saved.length ? html`<span class="num faint">${S.saved.length}</span>` : null} onClick=${() => go({ type: 'saved' })} />
      </div>
      ${recent.length > 0 && html`<div class="nav-group">
        <div class="sect"><span>Recent</span></div>
        ${recent.map((id) => {
          const meta = convMeta(id);
          return html`<${Row} key=${id} icon=${convIcon(id)} label=${meta.title} hint=${meta.house ? S.houses[meta.house].name : null}
            sel=${cur === id} attn=${quietAttn(attention(S, id))} muted=${levelOf(S, id) === 'muted'} end=${meta.dm && callLive(id) ? html`<${CallMark} />` : null}
            onClick=${() => openConv(id)} onMenu=${(pos) => (meta.house ? roomMenu(id, pos) : dmMenu(id, pos))} />`;
        })}
      </div>`}
    </div>`;
}

export function NavDirect() {
  const cur = current();
  return html`<div class="nav-group">
    <div class="sect"><span>Direct messages</span>
      <button class="ib sm" aria-label="New message" data-tip="New message" onClick=${() => openModal(NewMessage)}><${Icon} name="plus" size=${16} /></button>
    </div>
    ${S.dmOrder.filter((id) => !requestOf(id)).map((id) => {
      const meta = convMeta(id);
      if (S.ui.phone) return html`<${DmRow} key=${id} id=${id} />`;
      return html`<${Row} key=${id} icon=${convIcon(id)} label=${meta.title} sel=${cur === id} attn=${attention(S, id)} muted=${levelOf(S, id) === 'muted'}
        end=${callLive(id) ? html`<${CallMark} />` : null}
        onClick=${() => openConv(id)} onMenu=${(pos) => dmMenu(id, pos)} />`;
    })}
    ${!S.dmOrder.length && html`<p class="ctx-note">No conversations yet. Start one with the plus, or from someone’s profile.</p>`}
    ${(S.safety?.requests || []).some((r) => S.dms[r.dm]) && html`
      <div class="sect"><span>Message requests</span></div>
      ${S.safety.requests.filter((r) => S.dms[r.dm]).map((r) => html`<${Row} key=${r.dm} icon=${convIcon(r.dm)} label=${convMeta(r.dm).title}
        hint="Wants to talk" sel=${cur === r.dm} onClick=${() => openConv(r.dm)} />`)}`}
  </div>`;
}

// Phone: a person-sized row. Face with presence, name and time, then the last line.
function DmRow({ id }) {
  const meta = convMeta(id);
  const a = attention(S, id);
  const list = (S.msgs[id] || []).filter((m) => !m.sys);
  const last = list[list.length - 1];
  const who = last && (last.author === S.me ? 'You: ' : meta.user ? '' : `${person(last.author).name.split(' ')[0]}: `);
  const text = last ? `${who}${plain(last.text).slice(0, 120) || (last.files?.length ? 'Sent a file' : '')}` : 'No messages yet';
  const face = meta.user ? html`<${Avatar} user=${meta.user} size=${40} presence />`
    : html`<span class="avatar" style="--sz:40px;--tile-c:0;--tile-ink-c:0">${meta.dm.members.length}</span>`;
  const unread = a.needs || a.soft;
  return html`<button class=${`row two${unread ? ' unread' : ''}${levelOf(S, id) === 'muted' ? ' muted' : ''}`} onClick=${() => openConv(id)}
    onContextMenu=${(e) => { e.preventDefault(); dmMenu(id, { x: e.clientX, y: e.clientY }); }}>
    <span class="row-ic">${face}</span>
    <span class="grow row-two">
      <span class="row-two-top"><span class="trunc grow">${meta.title}</span>${last && html`<span class="row-two-time num">${fmtWhen(last.ts)}</span>`}</span>
      <span class="row-two-sub">${callLive(id) ? html`<span class="trunc grow call-now">In a call now</span><${CallMark} />` : html`<span class="trunc grow">${text}</span>`}<${Marker} attn=${a} /></span>
    </span>
  </button>`;
}

function MessagesCtx() {
  return html`
    <${CtxHead}><${JumpButton} label="Find a conversation" /><//>
    <div class="nav-scroll"><${NavDirect} /></div>`;
}

// Discover's sections. The section names are the route's `section` values.
export const DISCOVER_SECTIONS = [
  { id: undefined, label: 'For you', icon: 'compass' },
  { id: 'communities', label: 'Communities', icon: 'house' },
  { id: 'people', label: 'People', icon: 'people' },
  { id: 'events', label: 'Events', icon: 'calendar' },
];

function DiscoverCtx() {
  const v = S.ui.view.type === 'discover' ? S.ui.view : null;
  return html`
    <${CtxHead} cls="ctx-title"><h2 class="ctx-name">Discover</h2><//>
    <div class="nav-scroll">
      <div class="nav-group">
        ${DISCOVER_SECTIONS.map((s) => html`<${Row} key=${s.label} icon=${html`<${Icon} name=${s.icon} />`} label=${s.label}
          sel=${!!v && !v.topic && v.section === s.id} onClick=${() => go({ type: 'discover', section: s.id })} />`)}
      </div>
      <div class="nav-group">
        <div class="sect"><span>Topics</span></div>
        ${TOPICS.map((t) => html`<${Row} key=${t} icon=${html`<span class="topic-mark" aria-hidden="true">#</span>`} label=${t}
          sel=${!!v && v.topic === t} onClick=${() => go({ type: 'discover', topic: t })} />`)}
      </div>
    </div>`;
}

function RoomRow({ id }) {
  const room = S.rooms[id];
  const cur = current();
  const voice = room.kind === 'voice' || room.kind === 'stage'; // stage: js/views/places.js
  const inside = voice ? (S.voice[id] || []).map((u) => S.users[u]).filter(Boolean) : [];
  const end = inside.length ? html`<${Stack} users=${inside} max=${3} />${inside.length > 3 ? html`<span class="num faint">${inside.length}</span>` : null}` : null;
  const row = html`<${Row} icon=${html`<${RoomIcon} kind=${room.kind} size=${18} />`} label=${room.name} sel=${cur === id}
    attn=${attention(S, id)} muted=${levelOf(S, id) === 'muted'} live=${inside.length > 0} end=${end}
    onClick=${() => openConv(id)} onMenu=${(pos) => roomMenu(id, pos)} />`;
  const pane = S.ui.pane?.type === 'thread' ? S.ui.pane.id : null;
  const threads = threadsOf(S, id).filter((t) => (S.followed[t] && unreadOf(S, t).count > 0) || t === pane);
  return html`
    ${voice && S.call?.room !== id
      ? html`<div class="row-wrap">${row}<div class="row-acts"><button class="ib sm" aria-label=${`Join ${room.name}`} data-tip="Join" onClick=${() => leavingCall(id, () => joinVoice(id))}><${Icon} name="plus" size=${16} /></button></div></div>`
      : row}
    ${threads.map((t) => {
      const u = unreadOf(S, t);
      return html`<${Row} key=${t} sub icon=${html`<${Icon} name="thread" size=${16} />`} label=${convMeta(t).title} sel=${pane === t}
        attn=${{ needs: S.followed[t] ? u.needs : 0, soft: u.count > 0 }} onClick=${() => { openConv(id); openThread(id, S.threads[t].root); }} />`;
    })}`;
}

// A house's rooms by group, with its front page and events first.
export function HouseRooms({ id }) {
  const h = S.houses[id];
  const cur = current();
  const mayAdd = can(S, id, 'rooms');
  const hidden = h.newcomer ? roomIds(S, id).length - h.starter.length : 0;
  const now = Date.now();
  const events = upcomingEvents(S, now, { house: id });
  const live = events.some((e) => eventState(e, now) === 'now');
  const front = S.ui.view.type === 'house' && S.ui.view.id === id;
  return html`
    <div class="nav-group">
      <${Row} icon=${html`<${Icon} name="info" />`} label="About" sel=${front && !S.ui.view.events} onClick=${() => go({ type: 'house', id, about: true })} />
      <${Row} icon=${html`<${Icon} name="calendar" />`} label="Events" sel=${front && !!S.ui.view.events}
        end=${events.length ? html`${live && html`<span class="ev-live">Now</span>`}<span class="num faint">${events.length}</span>` : null}
        onClick=${() => go({ type: 'house', id, about: true, events: true })} />
    </div>
    ${h.groups.map((g) => {
      const gShut = !!S.prefs.groupShut[g.id];
      let rooms = h.newcomer ? g.rooms.filter((r) => h.starter.includes(r)) : g.rooms;
      if (!rooms.length && !mayAdd) return null;
      // A collapsed group still shows the room you are in and anything that needs you.
      if (gShut) rooms = rooms.filter((r) => r === cur || attention(S, r).needs > 0);
      return html`<div class="nav-group" key=${g.id}>
        <div class="sect">
          <button class="sect-name" aria-expanded=${String(!gShut)} onClick=${() => toggleGroup(g.id)}>
            <span class=${`chev${gShut ? ' shut' : ''}`}><${Icon} name="chev-d" size=${14} /></span>${g.name}
          </button>
          ${mayAdd && html`<button class="ib sm" aria-label=${`New room in ${g.name}`} data-tip="New room" onClick=${() => openModal(RoomForm, { house: id, group: g.id })}><${Icon} name="plus" size=${16} /></button>`}
        </div>
        ${rooms.map((r) => html`<${RoomRow} key=${r} id=${r} />`)}
      </div>`;
    })}
    ${hidden > 0 && html`<div class="nav-group"><${Row} icon=${html`<${Icon} name="chev-r" size=${16} />`} label=${`Browse ${plural(hidden, 'more room')}`} onClick=${() => openModal(RoomBrowser, { house: id })} /></div>`}`;
}

function HouseHead({ id }) {
  const h = S.houses[id];
  const members = Object.keys(h.members || {}).length;
  const online = onlineIn(h);
  return html`<button class="house-row ctx-house" aria-label=${`${h.name}, house menu`} aria-haspopup="menu"
    onClick=${(e) => houseMenu(id, { anchor: rectOf(e) })}
    onContextMenu=${(e) => { e.preventDefault(); houseMenu(id, { x: e.clientX, y: e.clientY }); }}>
    <${Tile} house=${h} />
    <span class="grow">
      <span class="ctx-name trunc">${h.name}</span>
      <span class="ctx-meta"><span class="num">${plural(members, 'member')}</span><${OnlineCount} n=${online} cls="ctx-online" /></span>
    </span>
    <${Icon} name="chev-d" size=${16} />
  </button>`;
}

function HouseCtx({ id }) {
  return html`
    <${CtxHead} cls="ctx-house-head"><${HouseHead} id=${id} /><//>
    <div class="nav-scroll"><${HouseRooms} id=${id} /></div>`;
}

// ---------- Your panel, pinned at the bottom ----------

// Appears only while you are in a voice room or a call, wherever you go, and
// takes you back to it.
export function LiveDock() {
  const c = S.call;
  if (!c) return null;
  const room = S.rooms[c.room];
  const meta = !room && c.dm ? convMeta(c.room) : null;
  if (!room && !meta) return null;
  const users = (S.voice[c.room] || []).map((id) => S.users[id]).filter(Boolean);
  const sub = room ? S.houses[room.house].name : c.status !== 'live' ? 'Calling\u2026' : (S.calls[c.room]?.ringing.length && users.length <= 1 ? 'Ringing\u2026' : 'Call');
  return html`<div class=${`dock${meta ? ' call' : ''}`} role="region" aria-label=${room ? 'Voice room you are in' : 'Call you are in'}>
    <button class="dock-head" onClick=${() => openConv(c.room)} aria-label=${room ? `Back to ${room.name}` : `Back to the call with ${meta.title}`}>
      <${Icon} name=${room ? 'voice' : 'phone'} size=${16} />
      <span class="trunc"><span class="dock-name">${room ? room.name : meta.title}</span> <span class="faint">${sub}</span></span>
    </button>
    <div class="dock-row"><${Stack} users=${users} max=${4} size=${24} /><${VoiceControls} compact /></div>
  </div>`;
}

export function SelfPanel() {
  // While Snug can't be reached, nobody sees you as here: say so.
  const u = isOnline() ? me() : { ...me(), presence: 'offline' };
  return html`<div class="me-panel">
    <${LiveDock} />
    <div class="me-row">
      <button class="self" aria-label=${`${u.name}, ${presenceLabel(u)}. Change presence and status`} onClick=${(e) => openPop({ anchor: rectOf(e), label: 'Presence and status', C: MePop, props: {} })}>
        <${Avatar} user=${u} presence />
        <span class="grow self-text">
          <span class="self-name trunc">${u.name}</span>
          <span class="self-status trunc">${u.status || PRESENCE[u.presence].label}</span>
        </span>
      </button>
      <button class="ib" aria-label="Settings" data-tip="Settings" onClick=${() => openLayer({ C: Settings, props: {} })}><${Icon} name="sliders" /></button>
    </div>
  </div>`;
}

// ---------- Keyboard: the places in the context column, in order ----------

export function contextPlaces() {
  const sp = S.ui.space;
  const v = S.ui.view;
  const conv = (id) => ({ sel: v.type === 'conv' && v.id === id, run: () => openConv(id), conv: id });
  const view = (to, sel) => ({ sel, run: () => go(to) });
  if (sp === 'home') {
    return [
      view({ type: 'home' }, v.type === 'home'),
      view({ type: 'catchup' }, v.type === 'catchup'),
      view({ type: 'friends' }, v.type === 'friends'),
      view({ type: 'saved' }, v.type === 'saved'),
      ...recentConvs().map(conv),
    ];
  }
  if (sp === 'messages') return S.dmOrder.map(conv);
  if (sp === 'discover') {
    return [
      ...DISCOVER_SECTIONS.map((s) => view({ type: 'discover', section: s.id }, v.type === 'discover' && !v.topic && v.section === s.id)),
      ...TOPICS.map((t) => view({ type: 'discover', topic: t }, v.type === 'discover' && v.topic === t)),
    ];
  }
  if (!S.houses[sp]) return [];
  const front = v.type === 'house' && v.id === sp;
  return [
    view({ type: 'house', id: sp, about: true }, front && !v.events),
    view({ type: 'house', id: sp, about: true, events: true }, front && !!v.events),
    ...roomIds(S, sp).filter(roomVisible).map(conv),
  ];
}

// ---------- The whole navigation (desktop) ----------

export function Nav() {
  const sp = S.ui.space;
  let ctx;
  if (sp === 'messages') ctx = html`<${MessagesCtx} />`;
  else if (sp === 'discover') ctx = html`<${DiscoverCtx} />`;
  else if (isHouseSpace(sp) && S.houses[sp]) ctx = html`<${HouseCtx} key=${sp} id=${sp} />`;
  else ctx = html`<${HomeCtx} />`;
  const label = sp === 'messages' ? 'Messages' : sp === 'discover' ? 'Discover' : isHouseSpace(sp) ? S.houses[sp]?.name : 'Home';
  return html`<div class="nav">
    <${Rail} />
    <nav class="ctx" aria-label=${label}>
      ${ctx}
      ${!isOnline() && S.ui.view.type !== 'conv' && html`<div class="conn" role="status"><${Icon} name="offline" size=${16} />Can’t reach Snug. Trying again…</div>`}
      <${SelfPanel} />
    </nav>
  </div>`;
}
