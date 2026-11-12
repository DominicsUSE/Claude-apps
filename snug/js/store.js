// One state object, plain functions that change it, and one way to hear about
// changes. Views never mutate state themselves: they call these actions.
import { useEffect, useState } from '../vendor/preact-htm.js';
import { seed } from './seed.js';
import { uid } from './lib/util.js';
import { plain } from './lib/format.js';
import { unreadOf, isThread, roomIds } from './lib/attention.js';

const KEY = 'snug.v1';
const EPHEMERAL = new Set(['typing', 'speaking', 'ui', 'conn']);
export const PAGE = 40;

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    return s && s.v === 1 ? s : null;
  } catch { return null; }
}

function freshUi(s) {
  return {
    view: s.last?.view || { type: 'catchup' },
    pane: null,          // { type: 'thread', id } | { type: 'people' } | { type: 'details' }
    depth: 0,            // phone: 0 shows the tabs, 1 shows the open view
    tab: 'home',
    marker: {}, hold: {}, win: {}, loaded: {}, reply: {}, jump: null, editing: null,
    menu: null, pop: null, modal: null, layer: null, quick: null, lightbox: null,
    toasts: [],
  };
}

function boot() {
  const s = load() || seed(Date.now());
  s.typing = {};
  s.speaking = {};
  s.conn = { online: typeof navigator === 'undefined' || navigator.onLine !== false, simOffline: false, simFail: false };
  s.ui = freshUi(s);
  const v = s.ui.view;
  if (v.type === 'conv') {
    const room = s.rooms[v.id];
    const ok = room ? s.houses[room.house]?.joined : !!s.dms[v.id];
    if (!ok) s.ui.view = { type: 'catchup' };
    else s.ui.marker[v.id] = unreadOf(s, v.id).firstTs;
  }
  // Anything still marked as sending when the page closed never left.
  for (const list of Object.values(s.msgs)) for (const m of list) if (m.state === 'sending') m.state = 'queued';
  return s;
}

export const S = boot();
export const scrollPos = new Map();

// Change notification
const subs = new Set();
let queued = false;
let saveTimer;

export function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const out = {};
    for (const k of Object.keys(S)) if (!EPHEMERAL.has(k)) out[k] = S[k];
    try {
      localStorage.setItem(KEY, JSON.stringify(out));
    } catch {
      // Storage full or blocked: keep working in memory, drop uploaded image data from the copy.
      try { localStorage.setItem(KEY, JSON.stringify(out, (k, v) => (k === 'src' ? undefined : v))); } catch { /* unavailable */ }
    }
  }, 400);
}

export function emit() {
  persist();
  if (queued) return;
  queued = true;
  queueMicrotask(() => { queued = false; subs.forEach((f) => f()); });
}

export function useStore() {
  const [, set] = useState(0);
  useEffect(() => {
    const f = () => set((n) => n + 1);
    subs.add(f);
    return () => subs.delete(f);
  }, []);
  return S;
}

export function resetAll() {
  try { localStorage.removeItem(KEY); } catch { /* unavailable */ }
  clearTimeout(saveTimer);
  location.reload();
}

// Reading state
export const me = () => S.users[S.me];
export const findMsg = (conv, id) => (S.msgs[conv] || []).find((m) => m.id === id);
export const isSaved = (id) => S.saved.some((s) => s.id === id);
export const isOnline = () => S.conn.online && !S.conn.simOffline;

export function convMeta(conv) {
  if (isThread(conv)) {
    const t = S.threads[conv];
    if (!t) return null;
    const root = findMsg(t.conv, t.root);
    const p = convMeta(t.conv);
    return { kind: 'thread', title: root ? plain(root.text).slice(0, 64) || 'Thread' : 'Thread', parent: t.conv, root, house: p?.house, where: p?.title };
  }
  const room = S.rooms[conv];
  if (room) return { kind: room.kind, title: room.name, room, house: room.house, topic: room.topic };
  const dm = S.dms[conv];
  if (dm) {
    const others = dm.members.filter((u) => u !== S.me);
    return {
      kind: others.length > 1 ? 'group' : 'dm',
      title: dm.name || others.map((u) => S.users[u].name).join(', '),
      dm, others, user: others.length === 1 ? S.users[others[0]] : null,
    };
  }
  return null;
}

export function membersOf(conv) {
  const meta = convMeta(conv);
  if (!meta) return [];
  if (meta.house) return Object.keys(S.houses[meta.house].members);
  if (meta.dm) return meta.dm.members;
  if (meta.parent) return membersOf(meta.parent);
  return [];
}

// Where the person is in a voice room, if anywhere.
export const voiceRoomOf = (userId) => Object.keys(S.voice).find((r) => S.voice[r].includes(userId) && S.rooms[r]);

// Navigation
function leave() {
  const v = S.ui.view;
  if (v.type === 'conv') { delete S.ui.marker[v.id]; delete S.ui.hold[v.id]; }
  S.ui.editing = null;
}

export function go(view) {
  leave();
  S.ui.view = view;
  S.ui.depth = 1;
  if (S.ui.pane?.type === 'thread') S.ui.pane = null;
  S.last = { view: view.type === 'search' ? { type: 'catchup' } : view };
  emit();
}

function aim(conv, id) {
  const list = S.msgs[conv] || [];
  const i = list.findIndex((m) => m.id === id);
  if (i < 0) return;
  const need = list.length - i + 5;
  if ((S.ui.win[conv] || PAGE) < need) S.ui.win[conv] = need;
  S.ui.jump = { conv, id, n: (S.ui.jump?.n || 0) + 1 };
}

export function openConv(id, { at } = {}) {
  const cur = S.ui.view;
  if (!(cur.type === 'conv' && cur.id === id)) {
    leave();
    S.ui.marker[id] = unreadOf(S, id).firstTs;
    S.ui.view = { type: 'conv', id };
    if (S.ui.pane?.type === 'thread') S.ui.pane = null;
    S.last = { view: S.ui.view };
    const room = S.rooms[id];
    if (room) delete S.prefs.houseShut[room.house];
  }
  S.ui.depth = 1;
  if (at) aim(id, at);
  emit();
}

export function openThread(conv, rootId, { at } = {}) {
  const tid = `t:${rootId}`;
  if (!S.threads[tid]) S.threads[tid] = { conv, root: rootId };
  if (!S.msgs[tid]) S.msgs[tid] = [];
  if (S.ui.pane?.id !== tid) S.ui.marker[tid] = unreadOf(S, tid).firstTs;
  S.ui.pane = { type: 'thread', id: tid };
  if (at) aim(tid, at);
  emit();
}

// Go to any message, wherever it lives.
export function jumpToMsg(conv, id) {
  if (isThread(conv)) {
    const t = S.threads[conv];
    openConv(t.conv, { at: t.root });
    openThread(t.conv, t.root, { at: id });
  } else openConv(conv, { at: id });
}

export function togglePane(type) {
  S.ui.pane = S.ui.pane?.type === type ? null : { type };
  emit();
}
export function closePane() {
  if (S.ui.pane?.type === 'thread') delete S.ui.marker[S.ui.pane.id];
  S.ui.pane = null;
  emit();
}
export function back() {
  if (S.ui.pane) return closePane();
  leave();
  S.ui.depth = 0;
  emit();
}
export function setTab(tab) { S.ui.tab = tab; S.ui.depth = 0; emit(); }

// Read state
export function markRead(conv) {
  if (S.ui.hold[conv]) return;
  const list = S.msgs[conv] || [];
  const last = list[list.length - 1];
  const ts = last ? Math.max(last.ts, S.read[conv] || 0) : Date.now();
  if (S.read[conv] === ts) return;
  S.read[conv] = ts;
  emit();
}

export function markUnreadFrom(conv, m) {
  S.read[conv] = m.ts - 1;
  S.ui.marker[conv] = m.ts;
  S.ui.hold[conv] = true;
  emit();
}

function allConvs() {
  const out = [...S.dmOrder];
  for (const h of S.houseOrder) out.push(...roomIds(S, h));
  for (const t of Object.keys(S.threads)) if (out.includes(S.threads[t].conv)) out.push(t);
  return out;
}

export function markManyRead(convs, label) {
  const before = {};
  for (const c of convs) { before[c] = S.read[c]; const l = S.msgs[c] || []; S.read[c] = Math.max(Date.now(), l.length ? l[l.length - 1].ts : 0); }
  emit();
  toast(label, { undo: () => { for (const c of convs) S.read[c] = before[c]; emit(); } });
}
export const markAllRead = () => markManyRead(allConvs(), 'Everything marked as read');
export function markHouseRead(houseId) {
  const rooms = roomIds(S, houseId);
  const threads = Object.keys(S.threads).filter((t) => rooms.includes(S.threads[t].conv));
  markManyRead([...rooms, ...threads], `${S.houses[houseId].name} marked as read`);
}
export function markConvRead(conv) {
  const threads = Object.keys(S.threads).filter((t) => S.threads[t].conv === conv);
  markManyRead([conv, ...threads], `${convMeta(conv).title} marked as read`);
}

// Messages
export function editMsg(conv, id, text) {
  const m = findMsg(conv, id);
  S.ui.editing = null;
  if (m && text.trim() && m.text !== text.trim()) { m.text = text.trim(); m.edited = Date.now(); }
  emit();
}

export function deleteMsg(conv, id) {
  const list = S.msgs[conv] || [];
  const i = list.findIndex((m) => m.id === id);
  if (i < 0) return;
  const [m] = list.splice(i, 1);
  emit();
  toast('Message deleted', { undo: () => { list.splice(Math.min(i, list.length), 0, m); emit(); } });
}

export function react(conv, id, emoji) {
  const m = findMsg(conv, id);
  if (!m) return;
  const all = (m.reactions ||= {});
  const who = (all[emoji] ||= []);
  const i = who.indexOf(S.me);
  if (i >= 0) who.splice(i, 1); else who.push(S.me);
  if (!who.length) delete all[emoji];
  S.prefs.recent = [emoji, ...(S.prefs.recent || []).filter((e) => e !== emoji)].slice(0, 8);
  emit();
}

export function toggleSave(conv, id) {
  const i = S.saved.findIndex((s) => s.id === id);
  if (i >= 0) {
    const [s] = S.saved.splice(i, 1);
    toast('Removed from Saved', { undo: () => { S.saved.splice(i, 0, s); emit(); } });
  } else S.saved.unshift({ id, conv, at: Date.now(), note: '' });
  emit();
}
export function setSavedNote(id, note) {
  const s = S.saved.find((x) => x.id === id);
  if (s) { s.note = note; persist(); }
}

export function toggleHighlight(conv, id) {
  const room = S.rooms[conv];
  if (!room) return;
  const i = room.highlights.indexOf(id);
  if (i >= 0) room.highlights.splice(i, 1); else room.highlights.unshift(id);
  emit();
  toast(i >= 0 ? `Removed from ${room.name} highlights` : `Added to ${room.name} highlights`, {
    undo: () => { if (i >= 0) room.highlights.splice(i, 0, id); else room.highlights.splice(room.highlights.indexOf(id), 1); emit(); },
  });
}

export function toggleFollow(tid) {
  if (S.followed[tid]) delete S.followed[tid]; else S.followed[tid] = true;
  emit();
}

export function setReply(conv, id) { S.ui.reply[conv] = id; emit(); }
export function setEditing(id) { S.ui.editing = id; emit(); }

// You
export function setPresence(p) { me().presence = p; emit(); }
export function setStatus(text) { me().status = text.trim().slice(0, 80); emit(); }
export function updateMe(patch) { Object.assign(me(), patch); emit(); }

const ATTR = { theme: 'data-theme', density: 'data-density', text: 'data-text', motion: 'data-motion' };
export function applyPrefs() {
  const root = document.documentElement;
  const p = S.prefs;
  const set = (name, val, skip) => (val && val !== skip ? root.setAttribute(name, val) : root.removeAttribute(name));
  set(ATTR.theme, p.theme, 'system');
  set(ATTR.density, p.density, 'regular');
  set(ATTR.text, p.text, 'm');
  set(ATTR.motion, p.motion === 'reduced' ? 'off' : null);
  set('data-contrast', p.contrast, 'system');
}
export function setPref(key, val) { S.prefs[key] = val; applyPrefs(); emit(); }

// Voice
export function leaveVoice() {
  if (!S.call) return;
  const list = S.voice[S.call.room] || [];
  const i = list.indexOf(S.me);
  if (i >= 0) list.splice(i, 1);
  S.call = null;
  emit();
}
export function joinVoice(roomId) {
  if (S.call?.room === roomId) return;
  leaveVoice();
  (S.voice[roomId] ||= []).push(S.me);
  S.call = { room: roomId, muted: false, deaf: false };
  emit();
}
export function toggleMute() { if (S.call) { S.call.muted = !S.call.muted; if (!S.call.muted) S.call.deaf = false; emit(); } }
export function toggleDeaf() { if (S.call) { S.call.deaf = !S.call.deaf; if (S.call.deaf) S.call.muted = true; emit(); } }

// Houses, rooms, roles
export function toggleHouse(id) { if (S.prefs.houseShut[id]) delete S.prefs.houseShut[id]; else S.prefs.houseShut[id] = true; emit(); }
export function toggleGroup(id) { if (S.prefs.groupShut[id]) delete S.prefs.groupShut[id]; else S.prefs.groupShut[id] = true; emit(); }

export function setNotify(kind, id, level) {
  if (kind === 'house') {
    S.houses[id].notify = level;
    for (const r of roomIds(S, id)) if (S.rooms[r].notify === level) S.rooms[r].notify = null;
  } else if (kind === 'room') {
    const room = S.rooms[id];
    room.notify = level === S.houses[room.house].notify ? null : level;
  } else S.dms[id].notify = level === 'all' ? null : level;
  emit();
}

export function joinHouse(id) {
  const h = S.houses[id];
  h.joined = true;
  h.newcomer = true;
  h.members[S.me] = h.joinRole;
  if (!S.houseOrder.includes(id)) S.houseOrder.push(id);
  S.invites = S.invites.filter((i) => i.house !== id);
  const now = Date.now();
  for (const r of roomIds(S, id)) S.read[r] = now;
  S.ui.modal = null;
  openConv(h.starter[0]);
}
export function declineInvite(id) {
  const before = S.invites;
  S.invites = S.invites.filter((i) => i.house !== id);
  emit();
  toast('Invitation dismissed', { undo: () => { S.invites = before; emit(); } });
}
export function welcomeDone(houseId) {
  const h = S.houses[houseId];
  if (!h?.newcomer) return;
  h.newcomer = false;
  emit();
  toast(`You’re in. All ${roomIds(S, houseId).length} rooms in ${h.name} are open to you now.`);
}
export function leaveHouse(id) {
  const h = S.houses[id];
  if (S.call && S.rooms[S.call.room]?.house === id) leaveVoice();
  h.joined = false;
  delete h.members[S.me];
  S.houseOrder = S.houseOrder.filter((x) => x !== id);
  S.ui.modal = null; S.ui.layer = null;
  go({ type: 'catchup' });
  toast(`You left ${h.name}`);
}

export function createHouse({ name, hue }) {
  const id = uid('h');
  const mk = (rname, kind, topic) => {
    const rid = uid('r');
    S.rooms[rid] = { id: rid, house: id, name: rname, kind, topic, notify: null, highlights: [] };
    S.msgs[rid] = [];
    if (kind === 'voice') S.voice[rid] = [];
    return rid;
  };
  const rooms = [mk('Notices', 'news', 'News from the people who run this house'), mk('Lounge', 'text', 'Everyday conversation'), mk('Introductions', 'text', 'Say hello')];
  const live = [mk('Hangout', 'voice', 'Drop in and talk')];
  S.houses[id] = {
    id, name, mark: name.trim()[0].toUpperCase(), hue, joined: true, newcomer: false, notify: 'all', about: '',
    roles: [
      { id: 'owner', name: 'Owner', hue, perms: ['post', 'announce', 'highlight', 'moderate', 'rooms', 'invite', 'roles'] },
      { id: 'member', name: 'Member', hue: null, perms: ['post', 'invite'] },
    ],
    joinRole: 'member',
    members: { [S.me]: 'owner' },
    groups: [{ id: uid('g'), name: 'Rooms', rooms }, { id: uid('g'), name: 'Live', rooms: live }],
    starter: rooms,
  };
  S.houseOrder.push(id);
  S.ui.modal = null;
  openConv(rooms[1]);
  return id;
}
export function updateHouse(id, patch) { Object.assign(S.houses[id], patch); emit(); }

export function createRoom(houseId, groupId, { name, kind, topic }) {
  const id = uid('r');
  S.rooms[id] = { id, house: houseId, name, kind, topic: topic || '', notify: null, highlights: [] };
  S.msgs[id] = [];
  if (kind === 'voice') S.voice[id] = [];
  const h = S.houses[houseId];
  (h.groups.find((g) => g.id === groupId) || h.groups[0]).rooms.push(id);
  S.ui.modal = null;
  openConv(id);
  return id;
}
export function updateRoom(id, patch) { Object.assign(S.rooms[id], patch); S.ui.modal = null; emit(); }
export function deleteRoom(id) {
  const room = S.rooms[id];
  const h = S.houses[room.house];
  if (S.call?.room === id) leaveVoice();
  for (const g of h.groups) g.rooms = g.rooms.filter((r) => r !== id);
  h.starter = h.starter.filter((r) => r !== id);
  delete S.rooms[id];
  S.ui.modal = null;
  if (S.ui.view.type === 'conv' && S.ui.view.id === id) go({ type: 'catchup' }); else emit();
  toast(`${room.name} deleted`);
}

export function setRolePerm(houseId, roleId, perm, on) {
  const role = S.houses[houseId].roles.find((r) => r.id === roleId);
  role.perms = on ? [...new Set([...role.perms, perm])] : role.perms.filter((p) => p !== perm);
  emit();
}
export function updateRole(houseId, roleId, patch) { Object.assign(S.houses[houseId].roles.find((r) => r.id === roleId), patch); emit(); }
export function addRole(houseId) {
  const role = { id: uid('role'), name: 'New role', hue: 180, perms: ['post'] };
  S.houses[houseId].roles.push(role);
  emit();
  return role.id;
}
export function removeRole(houseId, roleId) {
  const h = S.houses[houseId];
  const fallback = h.joinRole === roleId ? h.roles[h.roles.length - 1].id : h.joinRole;
  h.roles = h.roles.filter((r) => r.id !== roleId);
  for (const u of Object.keys(h.members)) if (h.members[u] === roleId) h.members[u] = fallback;
  emit();
}
export function setMemberRole(houseId, userId, roleId) { S.houses[houseId].members[userId] = roleId; emit(); }

export function startDm(userIds) {
  const members = [S.me, ...userIds];
  const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
  let id = S.dmOrder.find((d) => same(S.dms[d].members, members));
  if (!id) {
    id = uid('d');
    S.dms[id] = { id, members };
    S.msgs[id] = [];
    S.dmOrder.unshift(id);
  }
  S.ui.modal = null; S.ui.pop = null; S.ui.quick = null;
  openConv(id);
}

// Overlays
export function openMenu(menu) { S.ui.menu = { ...menu, k: uid('k') }; emit(); }
export function closeMenu() { if (S.ui.menu) { S.ui.menu = null; emit(); } }
export function openPop(pop) { S.ui.pop = { ...pop, k: uid('k') }; S.ui.menu = null; emit(); }
export function closePop() { if (S.ui.pop) { S.ui.pop = null; emit(); } }
export function openModal(C, props = {}) { S.ui.modal = { C, props, k: uid('k') }; S.ui.menu = null; S.ui.pop = null; S.ui.quick = null; emit(); }
export function closeModal() { S.ui.modal = null; emit(); }
export function openLayer(layer) { S.ui.layer = layer; S.ui.menu = null; S.ui.pop = null; S.ui.quick = null; emit(); }
export function closeLayer() { S.ui.layer = null; emit(); }
export function openQuick(q = '') { S.ui.quick = { q }; S.ui.menu = null; S.ui.pop = null; emit(); }
export function closeQuick() { S.ui.quick = null; emit(); }
export function openLightbox(src, alt) { S.ui.lightbox = { src, alt }; emit(); }
export function closeLightbox() { S.ui.lightbox = null; emit(); }

export function toast(text, opts = {}) {
  const id = uid('toast');
  S.ui.toasts = [...S.ui.toasts.slice(-2), { id, text, ...opts }];
  emit();
  setTimeout(() => dismissToast(id), opts.undo || opts.note ? 7000 : 4000);
  return id;
}
export function dismissToast(id) {
  if (!S.ui.toasts.some((t) => t.id === id)) return;
  S.ui.toasts = S.ui.toasts.filter((t) => t.id !== id);
  emit();
}
