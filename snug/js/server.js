// The transport. Everything that crosses the network goes through here:
// one WebSocket to the Snug server for live changes and actions, plus plain
// HTTP for signing in and uploading files.
//
// Connection rules:
// - Reconnect with backoff (1s, 2s, 4s ... up to 15s, with jitter), and at once
//   when the network or the tab comes back.
// - Every connect starts with a full snapshot ("hello"), so nothing missed
//   while away is lost; messages still waiting to send are kept and resent.
// - Messages carry a client-made id; the server ignores a second copy of the
//   same id, so a resend after a dropped connection never duplicates.
import {
  S, emit, toast, applySnapshot, useTransport, convMeta, jumpToMsg, signedOut, checkView, findMsg,
} from './store.js';
import { needsMe, levelOf, isThread, roomIds } from './lib/attention.js';
import { plain } from './lib/format.js';

const offline = () => Object.assign(new Error('offline'), { offline: true });
let ws = null;
let seq = 0;
let attempt = 0;
let timer = null;
let opened = false;
const waiting = new Map();
const handlers = new Map();

// Other modules (voice) listen for their own events here.
export function on(ev, fn) { if (!handlers.has(ev)) handlers.set(ev, new Set()); handlers.get(ev).add(fn); }
const fire = (ev, d) => handlers.get(ev)?.forEach((fn) => fn(d));

export function call(op, d = {}) {
  if (!ws || ws.readyState !== 1 || S.conn.socket !== 'open') return Promise.reject(offline());
  const id = ++seq;
  ws.send(JSON.stringify({ t: 'op', id, op, d }));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { waiting.delete(id); reject(new Error('The server didn’t answer in time. Try again.')); }, 15000);
    waiting.set(id, { resolve, reject, t });
  });
}

// Plain HTTP, for accounts and files.
export async function api(path, body) {
  let res;
  try {
    res = await fetch(path, body === undefined ? { credentials: 'same-origin' } : {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  } catch { throw new Error('Can’t reach Snug. Check your connection and try again.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Try again.'), { status: res.status });
  return data;
}

function connect() {
  clearTimeout(timer);
  if (ws && ws.readyState <= 1) return;
  opened = false;
  S.conn.socket = attempt ? 'reconnecting' : 'connecting';
  emit();
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => { opened = true; };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.t === 'hello') {
      attempt = 0;
      S.conn.socket = 'open';
      applySnapshot(msg.d);
      fire('open');
      flushQueue();
    } else if (msg.t === 'ack') {
      const w = waiting.get(msg.id);
      if (!w) return;
      waiting.delete(msg.id);
      clearTimeout(w.t);
      if (msg.ok) w.resolve(msg.d); else w.reject(new Error(msg.error));
    } else if (msg.t === 'ev') {
      try { (EVENTS[msg.ev] || ((d) => fire(msg.ev, d)))(msg.d); } catch (err) { console.error(msg.ev, err); }
      emit();
    }
  };
  ws.onclose = async (e) => {
    for (const w of waiting.values()) { clearTimeout(w.t); w.reject(offline()); }
    waiting.clear();
    for (const list of Object.values(S.msgs)) for (const m of list) if (m.state === 'sending') m.state = 'queued';
    S.conn.socket = 'closed';
    S.typing = {};
    fire('close');
    emit();
    // 4001: this session was ended (signed out elsewhere, or the password changed).
    if (e.code === 4001) { signedOut(); return; }
    // A refused upgrade looks like any other failure; ask whether the session is still valid.
    if (!opened) {
      try {
        const r = await fetch('/api/me', { credentials: 'same-origin' });
        if (r.status === 401) { signedOut(); return; }
      } catch { /* still offline */ }
    }
    const delay = Math.min(15000, 1000 * 2 ** attempt) * (0.7 + Math.random() * 0.6);
    attempt++;
    timer = setTimeout(connect, delay);
  };
}

export function startTransport() {
  attempt = 0;
  connect();
}
export function stopTransport() {
  clearTimeout(timer);
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  S.conn.socket = 'idle';
}
addEventListener('online', () => { if (S.auth === 'in') { attempt = 0; connect(); } });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.auth === 'in' && S.conn.socket === 'closed') { attempt = 0; connect(); }
});

// Messages
const ALPHA = 'abcdefghijklmnopqrstuvwxyz0123456789';
function msgId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `m_${[...bytes].map((b) => ALPHA[b % 36]).join('')}`;
}

// Put a message where the server's order says it belongs. Messages still
// waiting for the server stay at the end.
function place(conv, m) {
  const list = (S.msgs[conv] ||= []);
  const old = list.findIndex((x) => x.id === m.id);
  if (old >= 0) list.splice(old, 1);
  let i = list.length;
  while (i > 0 && (list[i - 1].seq == null || list[i - 1].seq > m.seq)) i--;
  list.splice(i, 0, m);
  delete S.cache[m.id];
}

export function sendMessage(conv, text, { replyTo, files } = {}) {
  const m = { id: msgId(), author: S.me, ts: Date.now(), text, state: 'sending' };
  if (replyTo) m.replyTo = replyTo;
  if (files?.length) m.files = files;
  (S.msgs[conv] ||= []).push(m);
  delete S.ui.hold[conv];
  S.ui.marker[conv] = null;
  delete S.drafts[conv];
  delete S.ui.reply[conv];
  delete typingAt[conv];
  send(conv, m);
  return m;
}

function send(conv, m) {
  if (S.conn.socket !== 'open') { m.state = 'queued'; emit(); return; }
  m.state = 'sending';
  delete m.error;
  emit();
  // Voice messages also carry their length and waveform.
  const files = (m.files || []).map((f) => ({ id: f.id, w: f.w, h: f.h, duration: f.duration, peaks: f.peaks }));
  call('msg.send', { conv, id: m.id, text: m.text, replyTo: m.replyTo, files }).then((r) => {
    place(conv, { ...r.m, files: r.m.files });
    if (isThread(conv)) S.followed[conv] = true;
    emit();
    // The server's copy plays and shows from /api/files now; free the local
    // copies (a voice message's recording, a photo's preview) once it has drawn.
    const local = (m.files || []).map((f) => f.src).filter((u) => typeof u === 'string' && u.startsWith('blob:'));
    if (local.length) setTimeout(() => local.forEach((u) => URL.revokeObjectURL(u)), 1000);
  }, (e) => {
    if (e.offline) m.state = 'queued';
    else { m.state = 'failed'; m.error = e.message; }
    emit();
  });
}

export const retry = (conv, m) => send(conv, m);

function flushQueue() {
  for (const conv of Object.keys(S.msgs)) for (const m of S.msgs[conv]) if (m.state === 'queued') send(conv, m);
}

const typingAt = {};
export function sendTyping(conv) {
  if (Date.now() - (typingAt[conv] || 0) < 3000) return;
  typingAt[conv] = Date.now();
  call('typing', { conv }).catch(() => {});
}

// Files go up over HTTP first; the message then refers to them by id.
export async function uploadFile(conv, blob, name) {
  let res;
  try {
    res = await fetch(`/api/files?conv=${encodeURIComponent(conv)}`, {
      method: 'POST', credentials: 'same-origin', body: blob,
      headers: { 'Content-Type': blob.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(name) },
    });
  } catch { throw new Error(`Couldn’t upload ${name}. Check your connection and try again.`); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Couldn’t upload ${name}.`);
  return data;
}

export async function loadHistory(conv, { before, fromId } = {}) {
  const r = await call('history', { conv, before, fromId });
  Object.assign(S.users, r.users);
  const list = (S.msgs[conv] ||= []);
  const have = new Set(list.map((m) => m.id));
  list.unshift(...r.msgs.filter((m) => !have.has(m.id)));
  for (const m of r.msgs) delete S.cache[m.id];
  if (r.more) S.more[conv] = true; else delete S.more[conv];
  emit();
  return r;
}

export async function searchMessages(q) {
  const r = await call('search', { q });
  Object.assign(S.users, r.users);
  Object.assign(S.threads, r.threads);
  for (const h of r.hits) if (!(S.msgs[h.conv] || []).some((m) => m.id === h.m.id)) S.cache[h.m.id] = h.m;
  return r.hits;
}

export function resyncNow() {
  return call('sync').then((d) => applySnapshot(d), () => {});
}

useTransport({ call, resync: resyncNow, history: loadHistory });

// Notifications for things that need you, when you are looking elsewhere.
// The desktop app's window can be hidden in the tray while the page still
// reports itself visible (seen on Linux), so it also asks the app (snugApp.hidden).
const shown = () => document.visibilityState === 'visible' && !window.snugApp?.hidden?.();
function looking(conv) {
  if (!shown()) return false;
  const v = S.ui.view;
  return (v.type === 'conv' && v.id === conv) || S.ui.pane?.id === conv;
}
function notify(conv, m) {
  if (m.author === S.me || looking(conv) || levelOf(S, conv) === 'muted' || !needsMe(S, conv, m)) return;
  if (S.users[S.me]?.presence === 'focus') return;
  const meta = convMeta(conv);
  if (!meta) return;
  const who = S.users[m.author]?.name || 'Someone';
  const where = meta.kind === 'dm' ? '' : meta.kind === 'thread' ? `in a thread in ${meta.where}` : `in ${meta.title}`;
  const text = plain(m.text) || 'Sent an attachment';
  if (shown()) {
    if (S.prefs.toasts) toast(text, { note: { user: m.author, where }, run: () => jumpToMsg(conv, m.id) });
  } else if (S.prefs.desktop && 'Notification' in window && Notification.permission === 'granted') {
    const n = new Notification(where ? `${who} ${where}` : who, { body: text.slice(0, 180), tag: m.id, silent: false });
    // In the desktop app the window may be hidden in the tray: snugApp.show() brings it back.
    n.onclick = () => { window.snugApp?.show?.(); window.focus(); jumpToMsg(conv, m.id); n.close(); };
  }
}

const typingTimers = {};
function stopTyping(conv, user) {
  S.typing[conv] = (S.typing[conv] || []).filter((u) => u !== user);
}

function dropHouse(id) {
  for (const r of roomIds(S, id)) {
    delete S.rooms[r];
    delete S.msgs[r];
    for (const t of Object.keys(S.threads)) if (S.threads[t].conv === r) { delete S.threads[t]; delete S.msgs[t]; }
  }
  for (const e of Object.keys(S.events)) if (S.events[e].house === id) delete S.events[e];
  delete S.houses[id];
  S.houseOrder = S.houseOrder.filter((h) => h !== id);
  checkView();
}

// Live changes from the server. Each applier is idempotent: getting the same
// event twice (or an event for your own action) leaves the same result.
const EVENTS = {
  msg({ conv, m, user, thread }) {
    if (user) S.users[user.id] = { ...S.users[user.id], ...user };
    if (thread) S.threads[thread.id] = { conv: thread.conv, root: thread.root };
    const isNew = !findMsg(conv, m.id);
    const pending = (S.msgs[conv] || []).find((x) => x.id === m.id && x.state);
    place(conv, m);
    if (pending && isThread(conv)) S.followed[conv] = true;
    if (isNew && !pending) {
      stopTyping(conv, m.author);
      notify(conv, m);
    }
  },
  'msg.del'({ conv, id }) {
    if (S.msgs[conv]) S.msgs[conv] = S.msgs[conv].filter((m) => m.id !== id);
    delete S.cache[id];
  },
  react({ conv, id, reactions, emoji }) {
    const m = findMsg(conv, id);
    if (m) m.reactions = reactions;
    if (m && emoji) m.emoji = { ...m.emoji, ...emoji }; // custom emoji used in reactions (js/views/emoji-custom.js)
  },
  typing({ conv, user }) {
    S.typing[conv] = [...new Set([...(S.typing[conv] || []), user])];
    clearTimeout(typingTimers[`${conv}|${user}`]);
    typingTimers[`${conv}|${user}`] = setTimeout(() => { stopTyping(conv, user); emit(); }, 6000);
  },
  presence({ user, presence }) {
    if (S.users[user]) S.users[user].presence = presence;
  },
  user({ user }) {
    S.users[user.id] = { ...S.users[user.id], ...user };
  },
  house({ house, rooms, users }) {
    const before = S.houses[house.id];
    Object.assign(S.users, users);
    for (const r of Object.keys(S.rooms)) if (S.rooms[r].house === house.id && !rooms[r]) { delete S.rooms[r]; delete S.msgs[r]; }
    Object.assign(S.rooms, rooms);
    S.houses[house.id] = house;
    if (house.joined && !S.houseOrder.includes(house.id)) S.houseOrder.push(house.id);
    if (before?.joined && before.newcomer && !house.newcomer) {
      toast(`You’re in. All ${roomIds(S, house.id).length} rooms in ${house.name} are open to you now.`);
    }
    checkView();
  },
  'house.gone'({ id }) {
    const name = S.houses[id]?.name;
    const v = S.ui.view;
    const onPage = v.type === 'house' && v.id === id;
    const wasViewing = onPage || (v.type === 'conv' && S.rooms[v.id]?.house === id);
    dropHouse(id);
    // A house page would fall back to the visitor preview, which a private
    // house refuses; go home instead of showing an error.
    if (onPage) S.ui.view = { type: 'home' };
    if (wasViewing && name) toast(`You’re no longer in ${name}.`);
  },
  content({ msgs, more, read, threads, users, voice, events }) {
    Object.assign(S.events, events || {});
    Object.assign(S.users, users);
    Object.assign(S.threads, threads);
    for (const [conv, list] of Object.entries(msgs)) {
      const pending = (S.msgs[conv] || []).filter((m) => m.state);
      S.msgs[conv] = [...list, ...pending];
    }
    for (const conv of Object.keys(msgs)) if (more[conv]) S.more[conv] = true; else delete S.more[conv];
    Object.assign(S.read, read);
    for (const [room, v] of Object.entries(voice || {})) { S.voice[room] = v.users; S.voiceState[room] = v.state; }
  },
  dm({ dm, users, msgs }) {
    Object.assign(S.users, users);
    S.dms[dm.id] = dm;
    if (!S.dmOrder.includes(dm.id)) S.dmOrder.unshift(dm.id);
    if (!S.msgs[dm.id]) S.msgs[dm.id] = msgs || [];
  },
  self(d) {
    if (d.users) Object.assign(S.users, d.users);
    if (d.read) Object.assign(S.read, d.read);
    if (d.follow) for (const [t, on] of Object.entries(d.follow)) { if (on) S.followed[t] = true; else delete S.followed[t]; }
    if (d.cache) Object.assign(S.cache, d.cache);
    if (d.saved) S.saved = d.saved;
    if (d.invites) {
      for (const i of d.invites) if (!S.invites.some((x) => x.house === i.house) && S.houses[i.house]) {
        toast(`${S.users[i.from]?.name || 'Someone'} invited you to ${S.houses[i.house].name}. It’s in Catch up.`);
      }
      S.invites = d.invites;
    }
  },
  // A friendship, a request either way, or (friend: null) the end of one.
  friend({ id, user, friend }) {
    if (user) S.users[id] = { ...S.users[id], ...user };
    const before = S.friends[id]?.state;
    if (friend) S.friends[id] = friend; else delete S.friends[id];
    const name = S.users[id]?.name || 'Someone';
    // Only the other person's actions are news; your own devices already know.
    if (S.prefs.toasts && friend?.state === 'incoming' && before !== 'incoming') toast(`${name} sent you a friend request`);
    if (S.prefs.toasts && friend?.state === 'friends' && before === 'outgoing') toast(`${name} accepted your friend request`);
  },
  event({ event }) {
    S.events[event.id] = event;
  },
  'event.gone'({ id }) {
    delete S.events[id];
  },
  voice({ room, users, state }) {
    if (users.length) { S.voice[room] = users; S.voiceState[room] = state; } else { delete S.voice[room]; delete S.voiceState[room]; }
    fire('voice', { room, users, state });
  },
};
