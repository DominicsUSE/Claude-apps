// The real-time hub. Owns the WebSocket connections, works out who is online,
// and delivers each change only to the people allowed to see it.
import { WebSocketServer } from 'ws';
import { readCookie, sessionUser, COOKIE, limiter } from './auth.js';
import { createOps, UserError } from './ops.js';
import { addMediaSnapshot } from './media.js'; // pins and saved GIFs in every snapshot
import { addEmojiSnapshot } from './emoji.js'; // each house's custom emoji in every snapshot

const OFFLINE_GRACE = 5000;

export function createHub({ db, M, server, origins, ice = [], log = () => {} }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
  const socks = new Map();        // user -> Set<ws>
  const offlineTimers = new Map();
  const voiceRooms = new Map();   // room -> Map<user, { ws, muted, deaf }>
  const voiceOf = new Map();      // user -> room
  let closed = false;

  const limits = {
    default: limiter({ capacity: 60, perSecond: 15 }),
    'msg.send': limiter({ capacity: 15, perSecond: 1 }),
    typing: limiter({ capacity: 3, perSecond: 0.5 }),
    search: limiter({ capacity: 8, perSecond: 1 }),
    // Friend requests go to anyone, so they are kept slow: 10 at once, then one every 10 seconds.
    'friend.request': limiter({ capacity: 10, perSecond: 0.1 }),
    discover: limiter({ capacity: 10, perSecond: 0.5 }),
    // Taking back requests, and joining open houses, both notify other people.
    'friend.remove': limiter({ capacity: 10, perSecond: 0.2 }),
    'house.joinPublic': limiter({ capacity: 5, perSecond: 0.1 }),
    rtc: limiter({ capacity: 400, perSecond: 80 }),
  };

  // Inside the grace period after the last socket closes, a person still counts as online.
  const online = (u) => (socks.get(u)?.size || 0) > 0 || offlineTimers.has(u);
  const pref = (u) => M.userRow(u)?.presence || 'offline';
  const presenceOf = (u) => (online(u) && pref(u) !== 'offline' ? pref(u) : 'offline');

  const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
  const hub = {};

  hub.toUser = (u, ev, d, exceptWs) => { for (const ws of socks.get(u) || []) if (ws !== exceptWs) send(ws, { t: 'ev', ev, d }); };
  hub.toUsers = (users, ev, d, exceptUser) => { for (const u of new Set(users)) if (u !== exceptUser) hub.toUser(u, ev, d); };
  hub.toConv = (conv, ev, d, exceptUser) => hub.toUsers(M.audience(conv), ev, d, exceptUser);

  // People as others see them, and as they see themselves.
  hub.userView = (u) => M.userView(M.userRow(u), presenceOf(u));
  const selfView = (u) => M.userView(M.userRow(u), pref(u));
  hub.usersFor = (ids) => Object.fromEntries([...new Set(ids)].map((u) => [u, hub.userView(u)]).filter(([, v]) => v));
  hub.savedFor = (u) => db.all('SELECT msg AS id, conv, at, note FROM saved WHERE user = ? ORDER BY at DESC', u);
  hub.threadsFor = (convs) => Object.fromEntries(convs.filter((c) => c.startsWith('t:')).map((c) => [c, M.thread(c)]).filter(([, t]) => t).map(([c, t]) => [c, { conv: t.conv, root: t.root }]));

  hub.sendSelf = (u, d, exceptWs) => hub.toUser(u, 'self', d, exceptWs);
  hub.userChanged = (u) => {
    hub.toUsers(M.contacts(u), 'user', { user: hub.userView(u) }, u);
    hub.toUser(u, 'user', { user: selfView(u) });
  };

  // Friends: each side sees the pair from their own side, on every device.
  // Someone you have only asked (or just unfriended, with no place in common)
  // shows as offline with no status, and stops getting updates.
  hub.sendFriend = (u, other) => {
    const user = M.sees(u, other) ? hub.userView(other) : M.hiddenView(M.userRow(other));
    hub.toUser(u, 'friend', { id: other, user, friend: M.friendView(M.friendRow(u, other)) || null });
  };
  hub.friendChanged = (a, b) => { hub.sendFriend(a, b); hub.sendFriend(b, a); };

  // Events reach everyone in the house.
  hub.eventChanged = (eventId) => {
    const e = M.eventView(M.eventRow(eventId));
    if (e) hub.toUsers(db.all('SELECT user FROM members WHERE house = ?', e.house).map((r) => r.user), 'event', { event: e });
  };
  hub.eventGone = (houseId, eventId, extra = []) => {
    hub.toUsers([...db.all('SELECT user FROM members WHERE house = ?', houseId).map((r) => r.user), ...extra], 'event.gone', { id: eventId, house: houseId });
  };

  // Liveness, for discovery: who is connected, and how many people are in these voice rooms.
  hub.isOnline = (u) => presenceOf(u) !== 'offline';
  hub.inVoice = (rooms) => rooms.reduce((n, r) => n + (voiceRooms.get(r)?.size || 0), 0);
  // Push notifications (server/push.js): does this person have any socket open right now?
  hub.connected = (u) => (socks.get(u)?.size || 0) > 0;

  hub.sendHouse = (u, houseId) => {
    const v = M.houseView(houseId, u);
    if (v) hub.toUser(u, 'house', { house: v.house, rooms: v.rooms, users: hub.usersFor(v.userIds) });
  };
  hub.houseChanged = (houseId) => {
    for (const r of db.all('SELECT user FROM members WHERE house = ?', houseId)) hub.sendHouse(r.user, houseId);
    for (const r of db.all('SELECT user FROM personal_invites WHERE house = ?', houseId)) hub.sendHouse(r.user, houseId);
  };
  // A house plus its conversations, for someone who has just joined or created it.
  hub.sendHouseContent = (u, houseId) => {
    hub.sendHouse(u, houseId);
    const rooms = db.all('SELECT id FROM rooms WHERE house = ?', houseId).map((r) => r.id);
    const threads = rooms.length ? db.all(`SELECT * FROM threads WHERE conv IN (${rooms.map(() => '?').join(',')})`, ...rooms) : [];
    const msgs = {}, more = {};
    for (const conv of [...rooms, ...threads.map((t) => t.id)]) {
      const p = M.page(conv);
      msgs[conv] = p.msgs;
      if (p.more) more[conv] = true;
    }
    const read = Object.fromEntries(rooms.map((r) => [r, db.get('SELECT ts FROM reads WHERE user = ? AND conv = ?', u, r)?.ts || 0]));
    hub.toUser(u, 'content', {
      msgs, more, read,
      threads: Object.fromEntries(threads.map((t) => [t.id, { conv: t.conv, root: t.root }])),
      users: hub.usersFor(Object.values(msgs).flat().map((m) => m.author)),
      voice: Object.fromEntries(rooms.filter((r) => voiceRooms.has(r)).map((r) => [r, voiceView(r)])),
      events: Object.fromEntries(M.eventsFor(u).filter((e) => e.house === houseId).map((e) => [e.id, e])),
    });
  };
  hub.sendDm = (u, dmId) => {
    const v = M.dmView(dmId, u);
    if (v) hub.toUser(u, 'dm', { dm: v, users: hub.usersFor(v.members), msgs: M.page(dmId).msgs });
  };
  hub.sendInvites = (u) => {
    const invites = db.all('SELECT house, by AS "from", ts FROM personal_invites WHERE user = ? ORDER BY ts DESC', u);
    for (const i of invites) hub.sendHouse(u, i.house);
    hub.sendSelf(u, { invites, users: hub.usersFor(invites.map((i) => i.from)) });
  };

  hub.snapshotFor = (u) => {
    const voice = Object.fromEntries([...voiceRooms.keys()].map((r) => [r, voiceView(r)]));
    const snap = M.snapshot(u, presenceOf, voice);
    addMediaSnapshot(db, M, u, snap);
    addEmojiSnapshot(db, M, u, snap);
    snap.users[u] = selfView(u);
    return snap;
  };

  // Presence
  function presenceChanged(u) {
    const user = hub.userView(u);
    hub.toUsers(M.contacts(u), 'presence', { user: u, presence: user.presence }, u);
  }

  // Voice
  function voiceView(room) {
    const m = voiceRooms.get(room);
    if (!m) return { users: [], state: {} };
    return { users: [...m.keys()], state: Object.fromEntries([...m].map(([u, s]) => [u, { muted: s.muted, deaf: s.deaf, camera: !!s.camera, screen: !!s.screen }])) };
  }
  function voiceChanged(room) {
    const r = M.room(room);
    if (!r) return;
    const d = { room, ...voiceView(room) };
    hub.toUsers(db.all('SELECT user FROM members WHERE house = ?', r.house).map((x) => x.user), 'voice', d);
  }
  hub.voiceJoin = (c, room) => {
    hub.voiceLeave(c.user);
    if (!voiceRooms.has(room.id)) voiceRooms.set(room.id, new Map());
    const m = voiceRooms.get(room.id);
    if (m.size >= 12) throw new UserError('This voice room is full. It holds up to 12 people.');
    const peers = [...m.keys()];
    m.set(c.user, { ws: c.ws, muted: false, deaf: false, camera: false, screen: false });
    voiceOf.set(c.user, room.id);
    voiceChanged(room.id);
    return peers;
  };
  hub.voiceLeave = (u) => {
    const room = voiceOf.get(u);
    if (!room) return;
    voiceOf.delete(u);
    const m = voiceRooms.get(room);
    m?.delete(u);
    if (m && !m.size) voiceRooms.delete(room);
    voiceChanged(room);
  };
  hub.voiceState = (u, s) => {
    const room = voiceOf.get(u);
    const entry = room && voiceRooms.get(room)?.get(u);
    if (!entry) return;
    Object.assign(entry, s);
    voiceChanged(room);
  };
  hub.rtcRelay = (from, to, data) => {
    const room = voiceOf.get(from);
    if (!room || voiceOf.get(to) !== room) return false;
    send(voiceRooms.get(room).get(to).ws, { t: 'ev', ev: 'rtc', d: { from, data } });
    return true;
  };
  hub.leaveVoiceInHouse = (u, houseId) => {
    const room = voiceOf.get(u);
    if (room && M.room(room)?.house === houseId) { hub.toUser(u, 'voice.kicked', { room }); hub.voiceLeave(u); }
  };
  hub.closeVoiceRoom = (room) => {
    for (const u of [...(voiceRooms.get(room)?.keys() || [])]) { hub.toUser(u, 'voice.kicked', { room }); hub.voiceLeave(u); }
  };

  const ops = createOps({ db, M, hub });

  // Connections
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws') return socket.destroy();
    // A page on another site must not be able to open a socket with this person's cookie.
    const origin = req.headers.origin;
    if (!origin || !origins(req).includes(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    const user = sessionUser(db, readCookie(req.headers.cookie, COOKIE));
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => connected(ws, user, readCookie(req.headers.cookie, COOKIE)));
    return undefined;
  });

  function connected(ws, user, token) {
    ws.user = user;
    ws.token = token;
    ws.alive = true;
    const first = !online(user);
    if (offlineTimers.has(user)) { clearTimeout(offlineTimers.get(user)); offlineTimers.delete(user); }
    if (!socks.has(user)) socks.set(user, new Set());
    socks.get(user).add(ws);
    if (first) presenceChanged(user);
    send(ws, { t: 'hello', d: { ...hub.snapshotFor(user), ice } });
    log('connect', user);

    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', (buf) => {
      let msg;
      try { msg = JSON.parse(buf); } catch { return; }
      if (!msg || msg.t !== 'op' || typeof msg.op !== 'string') return;
      const reply = (ok, d) => msg.id != null && send(ws, ok ? { t: 'ack', id: msg.id, ok: true, d } : { t: 'ack', id: msg.id, ok: false, error: d });
      // A session ended elsewhere (sign out everywhere) closes its sockets.
      if (!sessionUser(db, token)) { reply(false, 'You’ve been signed out. Sign in again.'); ws.close(4001, 'signed out'); return; }
      const handler = Object.hasOwn(ops, msg.op) ? ops[msg.op] : null;
      if (!handler) return reply(false, 'Snug doesn’t know how to do that.');
      const bucket = limits[msg.op] || limits.default;
      if (!bucket.take(`${user}:${msg.op in limits ? msg.op : '*'}`)) {
        if (msg.op === 'typing') return reply(true, {});
        return reply(false, 'You’re going a little fast. Wait a moment and try again.');
      }
      try {
        reply(true, handler({ user, ws }, msg.d && typeof msg.d === 'object' ? msg.d : {}) || {});
      } catch (e) {
        if (e instanceof UserError) reply(false, e.message);
        else { log('error', msg.op, e); reply(false, 'Something went wrong on the server. Try again.'); }
      }
      return undefined;
    });
    ws.on('close', () => {
      if (closed) return;
      socks.get(user)?.delete(ws);
      const room = voiceOf.get(user);
      if (room && voiceRooms.get(room)?.get(user)?.ws === ws) hub.voiceLeave(user);
      if (!socks.get(user)?.size) {
        socks.delete(user);
        // A reload or a short drop should not flash "offline" to everyone.
        offlineTimers.set(user, setTimeout(() => { offlineTimers.delete(user); if (!socks.has(user)) presenceChanged(user); }, OFFLINE_GRACE));
      }
    });
  }

  // Drop connections that stop answering, so presence stays honest.
  const beat = setInterval(() => {
    for (const set of socks.values()) for (const ws of set) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      ws.ping();
    }
  }, 25_000);

  hub.endSessions = (u, exceptToken) => {
    for (const ws of socks.get(u) || []) if (ws.token !== exceptToken) ws.close(4001, 'signed out');
  };
  hub.close = () => {
    closed = true;
    clearInterval(beat);
    for (const t of offlineTimers.values()) clearTimeout(t);
    for (const set of socks.values()) for (const ws of set) ws.terminate();
    wss.close();
  };
  hub.ops = ops;
  hub.resetLimits = () => Object.values(limits).forEach((l) => l.reset());
  return hub;
}
