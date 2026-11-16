// Houses and community where people meet them: category menus and moving
// rooms in the sidebar, the line a newcomer's arrival writes, event
// reminders, the newcomer wait above the message box, and the house banner.
// The server checks every one of these (server/community.js); this file only
// shows them and asks.
import { html, useEffect, useState } from '../../vendor/preact-htm.js';
import { S, emit, openMenu, openModal, closeModal, toast, openConv, go } from '../store.js';
import { call, on as onEvent, sendMessage } from '../server.js';
import { can, canPost } from '../lib/perms.js';
import { placeRoom, placeGroup, stepRoom, GROUP_NAME_MAX } from '../lib/community.js';
import { left } from '../lib/safety.js';
import { Icon, addIcons } from '../ui/icons.js';
import { Avatar } from '../ui/kit.js';
import { RoomForm } from './modals.js';

// Up, beside the set's down arrow, for moving rooms and categories.
addIcons({ up: 'M10 16V4|M5 9l5-5 5 5' });

export const errText = (e) => (e?.offline ? 'You’re offline. Try again when you’re back.' : e?.message || 'That didn’t work. Try again.');

// ---------- Moving rooms and categories ----------
// Each change shows at once and is sent; the server's answer (a fresh house)
// puts things right if it refused.
export function moveRoom(house, room, group, to) {
  const h = S.houses[house];
  if (!h) return Promise.resolve();
  h.groups = placeRoom(h.groups, room, group, to);
  emit();
  return call('room.move', { room, group, to }).catch((e) => toast(errText(e)));
}
export function moveGroup(house, group, to) {
  const h = S.houses[house];
  if (!h) return Promise.resolve();
  h.groups = placeGroup(h.groups, group, to);
  emit();
  return call('group.move', { group, to }).catch((e) => toast(errText(e)));
}
// One step up or down, across categories at the ends. Returns words for a
// live region ("Lounge, place 1 of 3 in Live"), or '' when it can't move.
export function stepMove(house, room, dir) {
  const h = S.houses[house];
  const s = h && stepRoom(h.groups, room, dir);
  if (!s) return '';
  moveRoom(house, room, s.group, s.to);
  const g = S.houses[house].groups.find((x) => x.id === s.group);
  return `${S.rooms[room]?.name || 'Room'}, place ${s.to + 1} of ${g.rooms.length} in ${g.name}`;
}
export function stepGroup(house, group, dir) {
  const h = S.houses[house];
  const i = h ? h.groups.findIndex((g) => g.id === group) : -1;
  const to = i + dir;
  if (i < 0 || to < 0 || to >= h.groups.length) return '';
  moveGroup(house, group, to);
  return `${h.groups.find((g) => g.id === group)?.name || 'Category'}, place ${to + 1} of ${h.groups.length}`;
}
export const mayArrange = (house) => !!S.houses[house]?.joined && can(S, house, 'rooms');

// Dragging: one thing at a time, a room or a category.
let drag = null;
export const dragging = () => drag;
// A room row you can drag; dropping a room on it puts that room just before it.
export function roomDrag(house, room) {
  if (!mayArrange(house)) return {};
  return {
    draggable: 'true',
    'data-drag-room': room,
    onDragStart: (e) => { drag = { kind: 'room', id: room, house }; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', S.rooms[room]?.name || room); } catch { /* old browsers */ } },
    onDragEnd: () => { drag = null; document.querySelectorAll('.drop-before,.drop-into').forEach((x) => x.classList.remove('drop-before', 'drop-into')); },
    onDragOver: (e) => { if (drag?.kind === 'room' && drag.house === house && drag.id !== room) { e.preventDefault(); e.currentTarget.classList.add('drop-before'); } },
    onDragLeave: (e) => e.currentTarget.classList.remove('drop-before'),
    onDrop: (e) => {
      e.currentTarget.classList.remove('drop-before');
      if (drag?.kind !== 'room' || drag.house !== house || drag.id === room) return;
      e.preventDefault();
      const g = S.houses[house].groups.find((x) => x.rooms.includes(room));
      const rest = g.rooms.filter((r) => r !== drag.id);
      moveRoom(house, drag.id, g.id, rest.indexOf(room));
      drag = null;
    },
  };
}
// A category heading: drag it to reorder; drop a room on it to put the room at its end.
export function groupDrag(house, group) {
  if (!mayArrange(house)) return {};
  return {
    draggable: 'true',
    onDragStart: (e) => { drag = { kind: 'group', id: group, house }; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', group); } catch { /* old browsers */ } },
    onDragEnd: () => { drag = null; document.querySelectorAll('.drop-before,.drop-into').forEach((x) => x.classList.remove('drop-before', 'drop-into')); },
    onDragOver: (e) => { if (drag?.house === house && drag.id !== group) { e.preventDefault(); e.currentTarget.classList.add(drag.kind === 'room' ? 'drop-into' : 'drop-before'); } },
    onDragLeave: (e) => e.currentTarget.classList.remove('drop-into', 'drop-before'),
    onDrop: (e) => {
      e.currentTarget.classList.remove('drop-into', 'drop-before');
      if (!drag || drag.house !== house || drag.id === group) return;
      e.preventDefault();
      const h = S.houses[house];
      if (drag.kind === 'room') moveRoom(house, drag.id, group, h.groups.find((g) => g.id === group).rooms.filter((r) => r !== drag.id).length);
      else moveGroup(house, drag.id, h.groups.findIndex((g) => g.id === group));
      drag = null;
    },
  };
}

// ---------- Category menus and forms ----------
export function GroupForm({ house, group }) {
  const g = group ? S.houses[house]?.groups.find((x) => x.id === group) : null;
  const [name, setName] = useState(g?.name || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = (e) => {
    e.preventDefault();
    const clean = name.trim();
    if (!clean) { setError('Give the category a name.'); return; }
    setBusy(true);
    call(g ? 'group.update' : 'group.create', g ? { group, name: clean } : { house, name: clean })
      .then(() => closeModal(), (err) => { setBusy(false); setError(errText(err)); });
  };
  return html`<form class="form" onSubmit=${submit} novalidate>
    <h2>${g ? `Rename ${g.name}` : `New category in ${S.houses[house]?.name}`}</h2>
    <div>
      <label class="label" for="cm-group-name">Name</label>
      <input id="cm-group-name" class=${`field${error ? ' bad' : ''}`} data-autofocus maxlength=${GROUP_NAME_MAX} placeholder="Making things" value=${name}
        aria-invalid=${String(!!error)} aria-describedby="cm-group-msg" onInput=${(e) => { setName(e.target.value); setError(''); }} />
      ${error ? html`<div class="err" id="cm-group-msg" role="alert"><${Icon} name="alert" size=${14} />${error}</div>`
        : html`<div class="hint" id="cm-group-msg">Categories hold rooms in the sidebar. Drag rooms into it afterwards.</div>`}
    </div>
    <div class="modal-foot">
      <button type="button" class="btn" onClick=${closeModal}>Cancel</button>
      <button type="submit" class="btn primary" disabled=${busy}>${g ? 'Save' : 'Create category'}</button>
    </div>
  </form>`;
}

export function DeleteGroup({ house, group }) {
  const h = S.houses[house];
  const g = h?.groups.find((x) => x.id === group);
  const others = h ? h.groups.filter((x) => x.id !== group) : [];
  const i = h ? h.groups.findIndex((x) => x.id === group) : 0;
  const [to, setTo] = useState((others[Math.max(0, i - 1)] || others[0])?.id || '');
  const [error, setError] = useState('');
  if (!g) return null;
  const go2 = () => call('group.delete', { group, moveTo: to }).then(() => closeModal(), (e) => setError(errText(e)));
  return html`<h2>Delete ${g.name}?</h2>
    <p class="modal-lead">${g.rooms.length ? 'Its rooms stay, with everything in them. Pick where they go.' : 'It has no rooms in it.'}</p>
    ${g.rooms.length > 0 && html`<div>
      <label class="label" for="cm-group-to">Move its rooms to</label>
      <select id="cm-group-to" class="field" value=${to} onChange=${(e) => setTo(e.target.value)}>
        ${others.map((x) => html`<option key=${x.id} value=${x.id}>${x.name}</option>`)}
      </select>
    </div>`}
    ${error && html`<div class="err" role="alert"><${Icon} name="alert" size=${14} />${error}</div>`}
    <div class="modal-foot">
      <button class="btn" data-autofocus onClick=${closeModal}>Cancel</button>
      <button class="btn danger" onClick=${go2}>Delete category</button>
    </div>`;
}

export function groupMenu(house, group, pos) {
  const h = S.houses[house];
  const i = h.groups.findIndex((g) => g.id === group);
  openMenu({
    ...pos,
    items: [
      { label: 'New room here', icon: 'plus', onSelect: () => openModal(RoomForm, { house, group }) },
      { label: 'Rename category', icon: 'edit', onSelect: () => openModal(GroupForm, { house, group }) },
      i > 0 && { label: 'Move category up', icon: 'up', onSelect: () => moveGroup(house, group, i - 1) },
      i < h.groups.length - 1 && { label: 'Move category down', icon: 'down', onSelect: () => moveGroup(house, group, i + 1) },
      h.groups.length > 1 && { sep: true },
      h.groups.length > 1 && { label: 'Delete category', icon: 'trash', danger: true, onSelect: () => openModal(DeleteGroup, { house, group }) },
    ],
  });
}

// Menu items for moving one room, for its menu in the sidebar (keyboard
// people open it with the menu key or Shift+F10).
export function roomMoveItems(room) {
  const r = S.rooms[room];
  if (!r || !mayArrange(r.house) || !r.perms?.manage) return [];
  const h = S.houses[r.house];
  const g = h.groups.find((x) => x.rooms.includes(room));
  return [
    { sep: true },
    stepRoom(h.groups, room, -1) && { label: 'Move up', icon: 'up', onSelect: () => stepMove(r.house, room, -1) },
    stepRoom(h.groups, room, 1) && { label: 'Move down', icon: 'down', onSelect: () => stepMove(r.house, room, 1) },
    ...h.groups.filter((x) => x.id !== g?.id).slice(0, 8).map((x) => ({ label: `Move to ${x.name}`, icon: 'chev-r', onSelect: () => moveRoom(r.house, room, x.id, x.rooms.length) })),
  ];
}

// ---------- A newcomer's arrival ----------
// "Name joined the house", written by the server, with a button to say hi.
export function JoinLine({ conv, m }) {
  const u = S.users[m.join?.user] || S.users[m.author];
  const [said, setSaid] = useState(false);
  const mayWrite = canPost(S, conv).ok && m.author !== S.me;
  const hi = () => {
    if (!u) return;
    sendMessage(conv, `Hi @${u.handle}, welcome!`, { replyTo: m.id });
    setSaid(true);
  };
  return html`<div class="joinline" data-mid=${m.id}>
    <span class="joinline-ic" aria-hidden="true"><${Icon} name="user-plus" size=${16} /></span>
    ${u && html`<${Avatar} user=${u} size=${20} />`}
    <span class="joinline-text"><b>${u?.name || 'Someone'}</b> joined the house.</span>
    <time class="joinline-time num" datetime=${new Date(m.ts).toISOString()}>${new Date(m.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
    ${mayWrite && html`<button class="btn sm joinline-hi" disabled=${said} onClick=${hi}>${said ? 'Said hi' : 'Say hi'}</button>`}
  </div>`;
}

// ---------- The newcomer wait, above the message box ----------
export function WaitNote({ conv }) {
  const room = S.rooms[conv] || S.rooms[S.threads[conv]?.conv];
  const h = room && S.houses[room.house];
  const until = h?.waitUntil || 0;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!until || until <= Date.now()) return undefined;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [until]);
  if (!until || until <= Date.now()) return null;
  return html`<div class="waitnote" role="status">
    <${Icon} name="clock" size=${16} />
    <span>${h.name} asks newcomers to settle in first. You can write, react and join voice in <b class="num">${left(until - Date.now())}</b>.</span>
  </div>`;
}

// ---------- The banner at the top of a house's sidebar ----------
export function HouseBanner({ house }) {
  const h = S.houses[house];
  if (!h?.banner) return null;
  return html`<div class="ctx-banner" aria-hidden="true"><img src=${`/api/housepics/${h.banner}`} alt="" loading="lazy" onError=${(e) => { e.currentTarget.parentNode.hidden = true; }} /></div>`;
}

// ---------- Event reminders ----------
onEvent('event.remind', ({ event, when, join }) => {
  if (!event) return;
  S.events[event.id] = { ...S.events[event.id], ...event };
  const house = S.houses[event.house]?.name || '';
  const text = when === 'now' ? `${event.title} is starting${join ? '. Press to join.' : ''}` : `${event.title} starts soon${house ? ` in ${house}` : ''}`;
  const run = () => (join ? openConv(join) : go({ type: 'house', id: event.house, about: true, events: true }));
  if (S.users[event.by]) toast(text, { note: { user: event.by, where: when === 'now' ? 'Event starting' : 'Event soon' }, run });
  else toast(text);
});
