// One state object, plain functions that change it, and one way to hear about
// changes. Views never mutate state themselves: they call these actions.
//
// The server is the source of truth. Each action updates the screen at once
// and sends the change through the transport (js/server.js). If the server
// refuses, the person is told why and the state is reloaded from the server.
import { useLayoutEffect, useState } from '../vendor/preact-htm.js';
import { uid } from './lib/util.js';
import { plain } from './lib/format.js';
import { unreadOf, isThread, roomIds } from './lib/attention.js';

export const PAGE = 40;
const KEYS = { prefs: 'snug.prefs', drafts: 'snug.drafts', cache: 'snug.cache', last: 'snug.last' };
const local = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or blocked */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* blocked */ } },
};

const DEFAULT_PREFS = {
  theme: 'system', density: 'regular', text: 'm', motion: 'system', contrast: 'system',
  toasts: true, desktop: false, houseShut: {}, groupShut: {}, recent: [],
};

// Everything that comes from the server.
const DATA = ['me', 'users', 'houses', 'rooms', 'houseOrder', 'dms', 'dmOrder', 'msgs', 'more', 'threads', 'read', 'followed', 'saved', 'cache', 'invites', 'voice', 'voiceState', 'friends', 'events'];
DATA.push('pins', 'gifFavs'); // pinned messages and saved GIFs (js/views/media.js)
DATA.push('emoji'); // each joined house's custom emoji (js/views/emoji-custom.js)
function blank() {
  return {
    me: null, users: {}, houses: {}, rooms: {}, houseOrder: [], dms: {}, dmOrder: [], msgs: {}, more: {}, threads: {},
    read: {}, followed: {}, saved: [], cache: {}, invites: [], voice: {}, voiceState: {},
    friends: {},   // { [userId]: { state: 'friends'|'incoming'|'outgoing', favorite, since } }
    events: {},    // { [eventId]: { id, house, room, title, about, starts, ends, by, going: [userId], created } }
    pins: {},      // { [conv]: [{ id, by, at }] }, newest first
    gifFavs: [],   // [{ id, name, size, w, h, kind, at }]: GIFs this person saved
    emoji: {},     // { [houseId]: [{ id, house, name, file, by, created }] }: custom emoji
  };
}

function freshUi() {
  return {
    view: local.get(KEYS.last) || { type: 'catchup' },
    pane: null,          // { type: 'thread', id } | { type: 'people' } | { type: 'details' }
    depth: 0,            // phone: 0 shows the tabs, 1 shows the open view
    tab: 'home',
    marker: {}, hold: {}, win: {}, loaded: {}, reply: {}, jump: null, editing: null,
    menu: null, pop: null, modal: null, layer: null, quick: null, lightbox: null,
    toasts: [], search: null, joinCode: null,
  };
}

export const S = {
  ...blank(),
  auth: 'checking',      // 'checking' | 'out' | 'in' | 'unreachable'
  ready: false,          // true once there is data to show, from the server or the device cache
  prefs: { ...DEFAULT_PREFS, ...(local.get(KEYS.prefs) || {}) },
  drafts: local.get(KEYS.drafts) || {},
  typing: {}, speaking: {}, call: null, peers: {},
  // Calls in direct conversations (js/calls.js): each live call's details by
  // conversation, the calls ringing for me, and how my last call ended.
  calls: {},       // { [dm]: { id, by, video, started, answered, group, ringing: [userId] } }
  ringing: {},     // { [dm]: { dm, call, from, video, group, until, quiet } }
  callEnd: null,   // { dm, reason, at }: shown for a few seconds after a call ends
  conn: { socket: 'idle' }, // 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'
  ice: [],
  ui: freshUi(),
};
export const scrollPos = new Map();

// The transport registers itself here, so this module never imports it.
let transport = {
  call: () => Promise.reject(Object.assign(new Error('offline'), { offline: true })),
  resync() {},
  history: () => Promise.reject(Object.assign(new Error('offline'), { offline: true })),
};
export function useTransport(t) { transport = t; }
const call = (op, d) => transport.call(op, d);
export const resync = () => transport.resync();

// Send a change; if it does not go through, say so and fetch the truth again.
function save(op, d) {
  return call(op, d).catch((e) => {
    toast(e.offline ? 'You’re offline, so that change wasn’t saved.' : e.message);
    if (!e.offline) transport.resync();
  });
}

// Background bookkeeping (read markers): nothing to tell the person while
// offline. What was read offline is kept and sent after the next snapshot.
const offlineReads = {};
function saveQuiet(op, d) {
  return call(op, d).catch((e) => {
    if (!e.offline) { transport.resync(); return; }
    for (const { conv, ts } of d.items || [d]) offlineReads[conv] = ts;
  });
}
function flushOfflineReads() {
  const items = [];
  for (const [conv, ts] of Object.entries(offlineReads)) {
    delete offlineReads[conv];
    if (ts > (S.read[conv] || 0)) { S.read[conv] = ts; items.push({ conv, ts }); }
  }
  if (items.length) saveQuiet('read.many', { items });
}

// Ask for something without changing anything: say why if it fails, resolve with null.
function ask(op, d) {
  return call(op, d).catch((e) => {
    toast(e.offline ? 'You’re offline. Try again once you’re back.' : e.message);
    return null;
  });
}

// Change notification and the device copy
const subs = new Set();
let queued = false;
let saveTimer;

function cacheData() {
  const out = {};
  for (const k of DATA) out[k] = S[k];
  // Local image previews are only valid in this tab.
  return JSON.parse(JSON.stringify(out, (k, v) => (k === 'src' && typeof v === 'string' && v.startsWith('blob:') ? undefined : v)));
}
export function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    local.set(KEYS.prefs, S.prefs);
    local.set(KEYS.drafts, S.drafts);
    if (S.me && S.ready) local.set(KEYS.cache, cacheData());
  }, 400);
}

export function emit() {
  persist();
  if (queued) return;
  queued = true;
  queueMicrotask(() => { queued = false; subs.forEach((f) => f()); });
}

// For modules that react to state rather than draw it (the ringtone).
export function subscribe(f) { subs.add(f); return () => subs.delete(f); }

export function useStore() {
  const [, set] = useState(0);
  // A layout effect, so the listener exists before anything can emit. A normal
  // effect waits for a paint, which a background tab may delay for seconds.
  useLayoutEffect(() => {
    const f = () => set((n) => n + 1);
    subs.add(f);
    return () => subs.delete(f);
  }, []);
  return S;
}

// Data in
function checkView() {
  const v = S.ui.view;
  if (v.type === 'conv' && !convMeta(v.id)) S.ui.view = { type: 'catchup' };
  if (S.ui.pane?.type === 'thread' && !convMeta(S.ui.pane.id)) S.ui.pane = null;
}
export { checkView };

// Open from the device copy, for a fast start and for working offline.
export function loadCache(userId) {
  const c = local.get(KEYS.cache);
  if (!c || !c.me || (userId && c.me !== userId)) return false;
  Object.assign(S, blank(), c);
  for (const list of Object.values(S.msgs)) for (const m of list) if (m.state === 'sending') m.state = 'queued';
  S.ready = true;
  checkView();
  const v = S.ui.view;
  if (v.type === 'conv') S.ui.marker[v.id] = unreadOf(S, v.id).firstTs;
  emit();
  return true;
}

// A full picture from the server. Messages still waiting to send are kept.
// A ring as this device keeps it. The server says how long it still rings
// (ms); `until` is counted on this device's clock from that, since the two
// clocks need not agree.
export function localRing(d) {
  const ms = Number.isFinite(d.ms) ? Math.max(0, d.ms) : 30_000;
  return { dm: d.dm, call: d.call, from: d.from, video: d.video, group: d.group, until: Date.now() + ms, quiet: d.quiet };
}

export function applySnapshot(d) {
  const pending = {};
  for (const [conv, list] of Object.entries(S.msgs)) {
    const p = list.filter((m) => m.state);
    if (p.length) pending[conv] = p;
  }
  const first = !S.ready;
  Object.assign(S, blank(), d);
  S.voice = {};
  S.voiceState = {};
  S.calls = {};
  for (const [room, v] of Object.entries(d.voice || {})) {
    if (v.users.length) { S.voice[room] = v.users; S.voiceState[room] = v.state; }
    if (v.call) S.calls[room] = v.call;
  }
  S.ringing = Object.fromEntries((d.ringing || []).map((r) => [r.dm, localRing(r)]));
  for (const [conv, list] of Object.entries(pending)) {
    const have = new Set((S.msgs[conv] ||= []).map((m) => m.id));
    for (const m of list) if (!have.has(m.id)) S.msgs[conv].push(m);
  }
  S.ready = true;
  flushOfflineReads();
  checkView();
  const v = S.ui.view;
  if (first && v.type === 'conv') S.ui.marker[v.id] = unreadOf(S, v.id).firstTs;
  emit();
}

export function signedOut() {
  local.del(KEYS.cache);
  Object.assign(S, blank());
  S.ready = false;
  S.auth = 'out';
  S.call = null;
  S.calls = {};
  S.ringing = {};
  S.callEnd = null;
  local.del(KEYS.last);
  S.ui = freshUi();
  // The next person to sign in starts at home, not on the last person's page.
  S.ui.view = { type: 'home' };
  emit();
}

// Reading state
export const me = () => S.users[S.me] || { id: S.me, name: '', handle: '', hue: 165, presence: 'around', status: '', about: '' };
export const person = (id) => S.users[id] || { id, name: 'Former member', handle: 'gone', hue: 165, presence: 'offline', status: '', about: '' };
export const findMsg = (conv, id) => (S.msgs[conv] || []).find((m) => m.id === id) || S.cache[id];
export const isSaved = (id) => S.saved.some((s) => s.id === id);
export const isOnline = () => S.conn.socket === 'open';

export function convMeta(conv) {
  if (isThread(conv)) {
    const t = S.threads[conv];
    if (!t) return null;
    const root = findMsg(t.conv, t.root);
    const p = convMeta(t.conv);
    if (!p) return null;
    return { kind: 'thread', title: root ? plain(root.text).slice(0, 64) || 'Thread' : 'Thread', parent: t.conv, root, house: p.house, where: p.title };
  }
  const room = S.rooms[conv];
  if (room && S.houses[room.house]?.joined) return { kind: room.kind, title: room.name, room, house: room.house, topic: room.topic };
  const dm = S.dms[conv];
  if (dm) {
    const others = dm.members.filter((u) => u !== S.me);
    const person = (u) => S.users[u] || { id: u, name: 'Someone', handle: u, hue: 165, presence: 'offline' };
    return {
      kind: others.length > 1 ? 'group' : 'dm',
      title: dm.name || others.map((u) => person(u).name).join(', ') || 'Just you',
      dm, others, user: others.length === 1 ? person(others[0]) : null,
    };
  }
  return null;
}

export function membersOf(conv) {
  const meta = convMeta(conv);
  if (!meta) return [];
  if (meta.house) return Object.keys(S.houses[meta.house].members).filter((u) => S.users[u]);
  if (meta.dm) return meta.dm.members.filter((u) => S.users[u]);
  if (meta.parent) return membersOf(meta.parent);
  return [];
}

// Where the person is in a voice room, if anywhere.
export const voiceRoomOf = (userId) => Object.keys(S.voice).find((r) => S.voice[r].includes(userId) && S.rooms[r]);

// Navigation
function remember(view) { local.set(KEYS.last, view.type === 'search' ? { type: 'catchup' } : view); }
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
  remember(view);
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
    remember(S.ui.view);
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

// Go to any message, wherever it lives. If it is older than what is loaded,
// fetch everything between it and the loaded part first, so there is no gap.
export async function jumpToMsg(conv, id) {
  const loaded = (S.msgs[conv] || []).some((m) => m.id === id);
  if (!loaded) {
    try {
      const first = (S.msgs[conv] || []).find((m) => m.seq != null);
      await transport.history(conv, { fromId: id, before: first?.seq });
    } catch (e) {
      toast(e.offline ? 'That message isn’t on this device yet. Connect and try again.' : e.message);
      return;
    }
  }
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
  return undefined;
}
export function setTab(tab) { S.ui.tab = tab; S.ui.depth = 0; emit(); }

// Read state, synced to the server and from there to your other devices.
export function setRead(conv, ts) {
  if (S.read[conv] === ts) return;
  S.read[conv] = ts;
  emit();
  saveQuiet('read.set', { conv, ts });
}

export function markRead(conv) {
  if (S.ui.hold[conv]) return;
  const list = (S.msgs[conv] || []).filter((m) => !m.state);
  const last = list[list.length - 1];
  if (!last) return;
  const ts = Math.max(last.ts, S.read[conv] || 0);
  if (S.read[conv] === ts) return;
  setRead(conv, ts);
}

export function markUnreadFrom(conv, m) {
  S.ui.marker[conv] = m.ts;
  S.ui.hold[conv] = true;
  setRead(conv, m.ts - 1);
}

function allConvs() {
  const out = [...S.dmOrder];
  for (const h of S.houseOrder) out.push(...roomIds(S, h));
  for (const t of Object.keys(S.threads)) if (out.includes(S.threads[t].conv)) out.push(t);
  return out;
}

export function markManyRead(convs, label) {
  const before = {};
  const items = [];
  for (const c of convs) {
    const l = (S.msgs[c] || []).filter((m) => !m.state);
    const ts = Math.max(S.read[c] || 0, l.length ? l[l.length - 1].ts : 0);
    if (ts === (S.read[c] || 0)) continue;
    before[c] = S.read[c] || 0;
    S.read[c] = ts;
    items.push({ conv: c, ts });
  }
  emit();
  if (items.length) saveQuiet('read.many', { items });
  toast(label, {
    undo: () => {
      for (const c of Object.keys(before)) S.read[c] = before[c];
      emit();
      save('read.many', { items: Object.entries(before).map(([conv, ts]) => ({ conv, ts })) });
    },
  });
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
  const next = text.trim();
  if (m && next && m.text !== next) {
    m.text = next;
    m.edited = Date.now();
    save('msg.edit', { conv, id, text: next });
  }
  emit();
}

export function deleteMsg(conv, id) {
  const list = S.msgs[conv] || [];
  const i = list.findIndex((m) => m.id === id);
  if (i < 0) return;
  const [m] = list.splice(i, 1);
  emit();
  // A message that never reached the server only needs to leave this screen.
  if (m.state) return;
  save('msg.delete', { conv, id });
  toast('Message deleted', {
    undo: () => {
      list.splice(Math.min(i, list.length), 0, m);
      emit();
      save('msg.restore', { conv, id });
    },
  });
}

export function react(conv, id, emoji) {
  const m = findMsg(conv, id);
  if (!m || m.state) return;
  const all = (m.reactions ||= {});
  const who = (all[emoji] ||= []);
  const on = !who.includes(S.me);
  if (on) who.push(S.me); else who.splice(who.indexOf(S.me), 1);
  if (!who.length) delete all[emoji];
  S.prefs.recent = [emoji, ...(S.prefs.recent || []).filter((e) => e !== emoji)].slice(0, 8);
  emit();
  save('react', { conv, id, emoji, on });
}

export function toggleSave(conv, id) {
  const i = S.saved.findIndex((s) => s.id === id);
  if (i >= 0) {
    const [s] = S.saved.splice(i, 1);
    save('saved.set', { conv, id, on: false });
    toast('Removed from Saved', {
      undo: () => { S.saved.splice(i, 0, s); emit(); save('saved.set', { conv, id, on: true, note: s.note }); },
    });
  } else {
    S.saved.unshift({ id, conv, at: Date.now(), note: '' });
    save('saved.set', { conv, id, on: true });
  }
  emit();
}
const noteTimers = {};
export function setSavedNote(id, note) {
  const s = S.saved.find((x) => x.id === id);
  if (!s) return;
  s.note = note;
  persist();
  clearTimeout(noteTimers[id]);
  noteTimers[id] = setTimeout(() => save('saved.note', { id, note }), 600);
}

export function toggleHighlight(conv, id) {
  const room = S.rooms[conv];
  if (!room) return;
  const on = !room.highlights.includes(id);
  room.highlights = on ? [id, ...room.highlights] : room.highlights.filter((x) => x !== id);
  emit();
  save('highlight.set', { conv, id, on });
  toast(on ? `Added to ${room.name} highlights` : `Removed from ${room.name} highlights`, {
    undo: () => {
      room.highlights = on ? room.highlights.filter((x) => x !== id) : [id, ...room.highlights];
      emit();
      save('highlight.set', { conv, id, on: !on });
    },
  });
}

export function toggleFollow(tid) {
  const on = !S.followed[tid];
  if (on) S.followed[tid] = true; else delete S.followed[tid];
  emit();
  save('follow.set', { thread: tid, on });
}

export function setReply(conv, id) { S.ui.reply[conv] = id; emit(); }
export function setEditing(id) { S.ui.editing = id; emit(); }

// You
export function updateMe(patch) {
  Object.assign(S.users[S.me], patch);
  emit();
  save('me.update', patch);
}
export const setPresence = (presence) => updateMe({ presence });
export const setStatus = (text) => updateMe({ status: text.trim().slice(0, 80) });

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
  save('notify.set', { kind, id, level });
}

// Joining: by a personal invitation (house) or by a link (code).
function joined(r) {
  S.ui.modal = null;
  S.ui.joinCode = null;
  openConv(r.starter?.[0] || roomIds(S, r.house)[0]);
}
export const joinHouse = (house) => call('invite.join', { house }).then(joined);
export const joinByCode = (code) => call('invite.accept', { code }).then(joined);

export function declineInvite(id) {
  S.invites = S.invites.filter((i) => i.house !== id);
  emit();
  save('invite.decline', { house: id });
  toast('Invitation dismissed');
}

export function leaveHouse(id) {
  const name = S.houses[id]?.name;
  return call('house.leave', { house: id }).then(() => {
    S.ui.modal = null; S.ui.layer = null;
    go({ type: 'catchup' });
    toast(`You left ${name}`);
  });
}

export function createHouse({ name, hue }) {
  return call('house.create', { name, hue }).then((r) => {
    S.ui.modal = null;
    openConv(r.room);
    return r.house;
  });
}
export function updateHouse(id, patch) { Object.assign(S.houses[id], patch); emit(); save('house.update', { house: id, ...patch }); }

export function createRoom(houseId, groupId, { name, kind, topic }) {
  return call('room.create', { house: houseId, group: groupId, name, kind, topic }).then((r) => {
    S.ui.modal = null;
    openConv(r.id);
    return r.id;
  });
}
export function updateRoom(id, patch) {
  return call('room.update', { room: id, ...patch }).then(() => { S.ui.modal = null; emit(); });
}
export function deleteRoom(id) {
  const name = S.rooms[id]?.name;
  return call('room.delete', { room: id }).then(() => { S.ui.modal = null; toast(`${name} deleted`); }, (e) => toast(e.message));
}

export function setRolePerm(houseId, roleId, perm, on) {
  const role = S.houses[houseId].roles.find((r) => r.id === roleId);
  role.perms = on ? [...new Set([...role.perms, perm])] : role.perms.filter((p) => p !== perm);
  emit();
  save('role.update', { house: houseId, role: roleId, perms: role.perms });
}
export function updateRole(houseId, roleId, patch) {
  Object.assign(S.houses[houseId].roles.find((r) => r.id === roleId), patch);
  emit();
  save('role.update', { house: houseId, role: roleId, ...patch });
}
export const addRole = (houseId) => call('role.create', { house: houseId }).then((r) => r.id, (e) => { toast(e.message); return null; });
export function removeRole(houseId, roleId) { save('role.delete', { house: houseId, role: roleId }); }
export function setMemberRole(houseId, userId, roleId) {
  S.houses[houseId].members[userId] = roleId;
  emit();
  save('member.role', { house: houseId, user: userId, role: roleId });
}
export function removeMember(houseId, userId) {
  const name = S.users[userId]?.name;
  const house = S.houses[houseId]?.name;
  return call('member.remove', { house: houseId, user: userId }).then(() => toast(`${name} was removed from ${house}`), (e) => toast(e.message));
}

// Friends. Each resolves with the server's answer, or with nothing if it was
// refused (the reason is shown as a toast and the state is fetched again).
export function sendFriendRequest(handleOrUserId) {
  const v = String(handleOrUserId || '').trim();
  const d = S.users[v] && v !== S.me ? { user: v } : { handle: v.replace(/^@/, '') };
  return save('friend.request', d).then((r) => {
    if (!r) return r;
    if (r.state === 'friends') toast(`You and ${S.users[r.user]?.name || 'they'} are friends now`);
    else toast(`Friend request sent to ${S.users[r.user]?.name || `@${d.handle || v}`}`);
    return r;
  });
}
function setFriend(id, friend) {
  if (friend) S.friends[id] = friend; else delete S.friends[id];
  emit();
}
export function acceptFriend(userId) {
  const f = S.friends[userId];
  if (f) setFriend(userId, { ...f, state: 'friends', since: Date.now() });
  return save('friend.accept', { user: userId });
}
export function declineFriend(userId) {
  setFriend(userId, null);
  return save('friend.decline', { user: userId });
}
// Unfriend, or take back a request you sent.
export function removeFriend(userId) {
  const was = S.friends[userId]?.state;
  setFriend(userId, null);
  return save('friend.remove', { user: userId }).then((r) => {
    if (r && was === 'friends') toast(`${S.users[userId]?.name || 'They'} isn’t on your friends list any more`);
    return r;
  });
}
export function setFavoriteFriend(userId, on) {
  const f = S.friends[userId];
  if (f) setFriend(userId, { ...f, favorite: !!on });
  return save('friend.favorite', { user: userId, on: !!on });
}

// Discovery. Resolves with { houses, people }, or null if it could not load.
export function discover({ q = '', topic = null } = {}) {
  return ask('discover', { q, topic }).then((r) => {
    if (!r) return null;
    // People you might know become openable profiles; keep what is already known.
    for (const p of r.people) if (!S.users[p.user.id]) S.users[p.user.id] = p.user;
    return r;
  });
}
// A public house as a visitor sees it, with its rules and upcoming events. Null if it could not load.
export const previewHouse = (houseId) => ask('house.preview', { house: houseId });
export function joinPublicHouse(houseId) {
  // A community you found yourself opens on its own page (welcome, rules,
  // what is happening), not straight in a room.
  return save('house.joinPublic', { house: houseId }).then((r) => {
    if (r) {
      S.ui.modal = null;
      if (S.houses[r.house || houseId]?.joined) go({ type: 'house', id: r.house || houseId, about: true });
      else joined(r);
    }
    return r;
  });
}

// Events
export function createEvent(houseId, { title, about = '', starts, ends = null, room = null }) {
  return save('event.create', { house: houseId, title, about, starts, ends, room }).then((r) => {
    if (r?.event) { S.events[r.id] = r.event; S.ui.modal = null; emit(); }
    return r;
  });
}
export function rsvpEvent(eventId, going) {
  const e = S.events[eventId];
  if (e) {
    e.going = going ? [...new Set([...e.going, S.me])] : e.going.filter((u) => u !== S.me);
    emit();
  }
  return save('event.rsvp', { event: eventId, going: !!going });
}
export function deleteEvent(eventId) {
  const title = S.events[eventId]?.title;
  delete S.events[eventId];
  emit();
  return save('event.delete', { event: eventId }).then((r) => { if (r && title) toast(`${title} cancelled`); return r; });
}

export function startDm(userIds) {
  return call('dm.open', { users: userIds }).then((r) => {
    S.ui.modal = null; S.ui.pop = null; S.ui.quick = null;
    openConv(r.id);
  }, (e) => toast(e.offline ? 'You’re offline. Start the conversation once you’re back.' : e.message));
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
  setTimeout(() => dismissToast(id), opts.undo || opts.note ? 7000 : 4500);
  return id;
}
export function dismissToast(id) {
  if (!S.ui.toasts.some((t) => t.id === id)) return;
  S.ui.toasts = S.ui.toasts.filter((t) => t.id !== id);
  emit();
}
