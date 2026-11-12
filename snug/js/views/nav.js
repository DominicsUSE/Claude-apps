// The navigation column. It reads big to small from top to bottom: you, your
// direct conversations, then each house with its rooms and followed threads.
// Nothing here reorders itself.
import { html } from '../../vendor/preact-htm.js';
import {
  S, me, go, openConv, openThread, openPop, openMenu, openModal, openQuick, openLayer, toggleHouse, toggleGroup,
  setNotify, markConvRead, markHouseRead, leaveHouse, deleteRoom, convMeta, isOnline, toast,
} from '../store.js';
import { attention, houseAttention, levelOf, unreadOf, threadsOf, totalNeeds, roomIds, levelsFor, LEVEL_LABEL } from '../lib/attention.js';
import { can } from '../lib/perms.js';
import { plural } from '../lib/util.js';
import { Icon } from '../ui/icons.js';
import { Avatar, Stack, Tile, RoomIcon, PRESENCE, presenceLabel } from '../ui/kit.js';
import { MePop } from './people.js';
import { RoomForm, Confirm, Invite, AddHouse, NewMessage, RoomBrowser } from './modals.js';
import { HouseSettings } from './settings.js';
import { VoiceControls } from './conversation.js';
import { joinVoice } from '../voice.js';

const rectOf = (e) => e.currentTarget.getBoundingClientRect();
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
export const MOD = isMac ? '⌘' : 'Ctrl';

function Marker({ attn }) {
  if (attn?.needs) return html`<span class="badge" aria-label=${`${attn.needs} need you`}>${attn.needs}</span>`;
  if (attn?.soft) return html`<span class="dot" role="img" aria-label="New activity"></span>`;
  return null;
}

function Row({ icon, label, sel, attn, muted, sub, live, end, onClick, onMenu }) {
  const cls = `row${sel ? ' sel' : ''}${attn?.soft || attn?.needs ? ' unread' : ''}${muted ? ' muted' : ''}${sub ? ' nested' : ''}${live ? ' live' : ''}`;
  return html`<button class=${cls} aria-current=${sel ? 'page' : undefined} onClick=${onClick}
    onContextMenu=${onMenu && ((e) => { e.preventDefault(); onMenu({ x: e.clientX, y: e.clientY }); })}>
    <span class="row-ic">${icon}</span>
    <span class="trunc grow">${label}</span>
    <span class="row-end">${end}<${Marker} attn=${attn} /></span>
  </button>`;
}

const current = () => (S.ui.view.type === 'conv' ? S.ui.view.id : null);

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
      { sep: true },
      {
        label: 'Leave house', icon: 'leave', danger: true,
        onSelect: () => openModal(Confirm, {
          title: `Leave ${h.name}?`, danger: true, action: 'Leave house',
          text: 'Its rooms leave your sidebar. You’ll need a new invitation to come back.',
          onConfirm: () => leaveHouse(id).catch((e) => toast(e.offline ? 'You\u2019re offline. Try again when you\u2019re back.' : e.message)),
        }),
      },
    ],
  });
}

export function NavTop() {
  const u = me();
  return html`<div class="nav-top">
    <button class="self" aria-label=${`${u.name}, ${presenceLabel(u)}. Change presence and status`} onClick=${(e) => openPop({ anchor: rectOf(e), label: 'Presence and status', C: MePop, props: {} })}>
      <${Avatar} user=${u} presence />
      <span class="grow" style="text-align:left">
        <span class="self-name trunc" style="display:block">${u.name}</span>
        <span class="self-status trunc" style="display:block">${u.status || PRESENCE[u.presence].label}</span>
      </span>
      <${Icon} name="chev-d" size=${16} />
    </button>
    <button class="jump-btn" onClick=${() => openQuick()} aria-label="Jump to a room or person, or search messages">
      <${Icon} name="search" size=${16} /><span>Jump to or search</span><span class="kbd">${MOD} K</span>
    </button>
  </div>`;
}

export function NavPrimary() {
  const t = S.ui.view.type;
  const needs = totalNeeds(S);
  return html`<div class="nav-group">
    <${Row} icon=${html`<${Icon} name="tray" />`} label="Catch up" sel=${t === 'catchup'} attn=${{ needs }} onClick=${() => go({ type: 'catchup' })} />
    <${Row} icon=${html`<${Icon} name="save" />`} label="Saved" sel=${t === 'saved'} onClick=${() => go({ type: 'saved' })} />
  </div>`;
}

export function NavDirect() {
  const cur = current();
  return html`<div class="nav-group">
    <div class="sect"><span>Direct</span>
      <button class="ib sm" aria-label="New message" data-tip="New message" onClick=${() => openModal(NewMessage)}><${Icon} name="plus" size=${16} /></button>
    </div>
    ${S.dmOrder.map((id) => {
      const meta = convMeta(id);
      const icon = meta.user
        ? html`<${Avatar} user=${meta.user} presence dim=${meta.user.presence === 'offline'} />`
        : html`<span class="avatar" style="--hue:165">${meta.dm.members.length}</span>`;
      return html`<${Row} key=${id} icon=${icon} label=${meta.title} sel=${cur === id} attn=${attention(S, id)} muted=${levelOf(S, id) === 'muted'}
        onClick=${() => openConv(id)} onMenu=${(pos) => dmMenu(id, pos)} />`;
    })}
    ${!S.dmOrder.length && html`<p class="faint" style="padding:4px 8px">No conversations yet. Start one with the plus.</p>`}
  </div>`;
}

function RoomRow({ id }) {
  const room = S.rooms[id];
  const cur = current();
  const voice = room.kind === 'voice';
  const inside = voice ? (S.voice[id] || []).map((u) => S.users[u]) : [];
  const end = inside.length ? html`<${Stack} users=${inside} max=${3} />${inside.length > 3 ? html`<span class="num faint">${inside.length}</span>` : null}` : null;
  const row = html`<${Row} icon=${html`<${RoomIcon} kind=${room.kind} size=${18} />`} label=${room.name} sel=${cur === id}
    attn=${attention(S, id)} muted=${levelOf(S, id) === 'muted'} live=${inside.length > 0} end=${end}
    onClick=${() => openConv(id)} onMenu=${(pos) => roomMenu(id, pos)} />`;
  const pane = S.ui.pane?.type === 'thread' ? S.ui.pane.id : null;
  const threads = threadsOf(S, id).filter((t) => (S.followed[t] && unreadOf(S, t).count > 0) || t === pane);
  return html`
    ${voice && S.call?.room !== id
      ? html`<div class="row-wrap">${row}<div class="row-acts"><button class="ib sm" aria-label=${`Join ${room.name}`} data-tip="Join" onClick=${() => joinVoice(id)}><${Icon} name="plus" size=${16} /></button></div></div>`
      : row}
    ${threads.map((t) => {
      const u = unreadOf(S, t);
      return html`<${Row} key=${t} sub icon=${html`<${Icon} name="thread" size=${16} />`} label=${convMeta(t).title} sel=${pane === t}
        attn=${{ needs: S.followed[t] ? u.needs : 0, soft: u.count > 0 }} onClick=${() => { openConv(id); openThread(id, S.threads[t].root); }} />`;
    })}`;
}

function House({ id }) {
  const h = S.houses[id];
  const shut = !!S.prefs.houseShut[id];
  const attn = houseAttention(S, id);
  const cur = current();
  const mayAdd = can(S, id, 'rooms');
  const hidden = h.newcomer ? roomIds(S, id).length - h.starter.length : 0;
  return html`<div class="nav-group">
    <div class="row-wrap">
      <button class="row house-row" aria-expanded=${String(!shut)} onClick=${() => toggleHouse(id)}
        onContextMenu=${(e) => { e.preventDefault(); houseMenu(id, { x: e.clientX, y: e.clientY }); }}>
        <span class="row-ic"><${Tile} house=${h} /></span>
        <span class="trunc grow">${h.name}</span>
        <span class="row-end">${shut && html`<${Marker} attn=${attn} />`}<span class=${`chev${shut ? ' shut' : ''}`}><${Icon} name="chev-d" size=${16} /></span></span>
      </button>
      <div class="row-acts"><button class="ib sm" aria-label=${`${h.name} menu`} data-tip="House menu" onClick=${(e) => houseMenu(id, { anchor: rectOf(e) })}><${Icon} name="more" size=${16} /></button></div>
    </div>
    ${!shut && h.groups.map((g) => {
      const gShut = !!S.prefs.groupShut[g.id];
      let rooms = h.newcomer ? g.rooms.filter((r) => h.starter.includes(r)) : g.rooms;
      if (!rooms.length && !mayAdd) return null;
      // A collapsed group still shows the room you are in and anything that needs you.
      if (gShut) rooms = rooms.filter((r) => r === cur || attention(S, r).needs > 0);
      return html`<div key=${g.id}>
        <div class="sect">
          <button class="sect-name" aria-expanded=${String(!gShut)} onClick=${() => toggleGroup(g.id)}>
            <span class=${`chev${gShut ? ' shut' : ''}`}><${Icon} name="chev-d" size=${14} /></span>${g.name}
          </button>
          ${mayAdd && html`<button class="ib sm" aria-label=${`New room in ${g.name}`} data-tip="New room" onClick=${() => openModal(RoomForm, { house: id, group: g.id })}><${Icon} name="plus" size=${16} /></button>`}
        </div>
        ${rooms.map((r) => html`<${RoomRow} key=${r} id=${r} />`)}
      </div>`;
    })}
    ${!shut && hidden > 0 && html`<${Row} icon=${html`<${Icon} name="chev-r" size=${16} />`} label=${`Browse ${plural(hidden, 'more room')}`} onClick=${() => openModal(RoomBrowser, { house: id })} />`}
  </div>`;
}

export function NavHouses() {
  return html`
    ${S.houseOrder.map((id) => html`<${House} key=${id} id=${id} />`)}
    <div class="nav-group">
      <${Row} icon=${html`<${Icon} name="plus" />`} label="Add a house" end=${S.invites.length ? html`<span class="faint">${plural(S.invites.length, 'invitation')}</span>` : null}
        onClick=${() => openModal(AddHouse)} />
    </div>`;
}

// Appears only while you are in a voice room, wherever you go.
export function LiveDock() {
  const c = S.call;
  if (!c || !S.rooms[c.room]) return null;
  const room = S.rooms[c.room];
  const users = (S.voice[c.room] || []).map((id) => S.users[id]);
  return html`<div class="dock" role="region" aria-label="Voice room you are in">
    <button class="dock-head" onClick=${() => openConv(c.room)}>
      <${Icon} name="voice" size=${16} />
      <span class="trunc"><span class="dock-name">${room.name}</span> <span class="faint">${S.houses[room.house].name}</span></span>
    </button>
    <div class="dock-row"><${Stack} users=${users} max=${4} size=${24} /><${VoiceControls} compact /></div>
  </div>`;
}

export function Nav() {
  return html`<nav class="nav" aria-label="Places">
    <${NavTop} />
    <div class="nav-scroll">
      <${NavPrimary} />
      <${NavDirect} />
      <${NavHouses} />
    </div>
    ${!isOnline() && html`<div class="conn" role="status"><${Icon} name="offline" size=${16} />Can\u2019t reach Snug. Trying again\u2026</div>`}
    <${LiveDock} />
  </nav>`;
}
