// The real-time hub. Owns the WebSocket connections, works out who is online,
// and delivers each change only to the people allowed to see it.
import { WebSocketServer } from 'ws';
import { readCookie, sessionUser, COOKIE, limiter } from './auth.js';
import { createOps, UserError } from './ops.js';
import { newId, now } from './model.js';
import { addMediaSnapshot } from './media.js'; // pins and saved GIFs in every snapshot
import { addEmojiSnapshot } from './emoji.js'; // each house's custom emoji in every snapshot

const OFFLINE_GRACE = 5000;
export const RING_MS = 30_000;
const VOICE_MAX = 12;

// How long a call rings. SNUG_RING_MS shortens it, but only under the test
// runner (node --test sets NODE_TEST_CONTEXT), so a stray variable on a real
// server can't change it.
export function ringMsFrom(env = process.env) {
  const v = Number(env.SNUG_RING_MS);
  return env.NODE_TEST_CONTEXT && Number.isFinite(v) && v >= 100 ? v : RING_MS;
}

// "4m 12s", "38s", "1h 2m": the length of a call in its record.
export function callLength(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (h) return `${h}h ${m}m`;
  return m ? `${m}m ${r}s` : `${r}s`;
}

export function createHub({ db, M, server, origins, ice = [], log = () => {}, ringMs = ringMsFrom() }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
  const socks = new Map();        // user -> Set<ws>
  const offlineTimers = new Map();
  // A voice place is a house's voice room or a direct conversation with a
  // call in it; both use the same membership, state and signalling.
  const voiceRooms = new Map();   // place -> Map<user, { ws, muted, deaf, camera, screen }>
  const voiceOf = new Map();      // user -> place
  // Calls in direct conversations and groups, by conversation id.
  // { id, dm, by, video, started, answered, group, joined: Set, declined: Set, ringing: Map<user, { timer, until }> }
  const calls = new Map();
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
    // Starting a call rings other people's devices: four at once, then one every 15 seconds.
    'call.start': limiter({ capacity: 4, perSecond: 1 / 15 }),
  };

  // Inside the grace period after the last socket closes, a person still counts as online.
  const online = (u) => (socks.get(u)?.size || 0) > 0 || offlineTimers.has(u);
  const pref = (u) => M.userRow(u)?.presence || 'offline';
  const presenceOf = (u) => (online(u) && pref(u) !== 'offline' ? pref(u) : 'offline');

  const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
  const hub = {};
  // Set by the server (index.js): a stored message to push, a ring for someone
  // with nothing open, and the end of a ring (so a pushed "is calling" note
  // doesn't stay on their phone).
  hub.hooks = { message: null, ring: null, ringStop: null };

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
    const rooms = db.all('SELECT id FROM rooms WHERE house = ?', houseId).map((r) => r.id).filter((r) => M.canRead(u, r)); // private rooms (server/places.js)
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
    // Calls in this person's direct conversations, and the ones ringing for them now.
    for (const dm of M.dmIdsOf(u)) if (voiceRooms.has(dm) || calls.has(dm)) snap.voice[dm] = voiceView(dm);
    snap.ringing = [...calls.values()].filter((c) => c.ringing.has(u)).map((c) => ringView(c, u));
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

  // Voice: house voice rooms and calls in direct conversations share all of this.
  const dmMembers = (dm) => db.all('SELECT user FROM dm_members WHERE dm = ? ORDER BY rowid', dm).map((r) => r.user);
  // Who hears about a voice place: the house for a room, only the conversation's people for a call.
  function audienceOf(place) {
    const r = M.room(place);
    if (r) return M.audience(place); // who can see the room (server/places.js)
    return dmMembers(place);
  }
  function callView(call) {
    return call && {
      id: call.id, by: call.by, video: call.video, started: call.started, answered: call.answered || null,
      group: call.group, ringing: [...call.ringing.keys()],
    };
  }
  function voiceView(place) {
    const m = voiceRooms.get(place);
    const call = calls.get(place);
    const v = !m ? { users: [], state: {} } : { users: [...m.keys()], state: Object.fromEntries([...m].map(([u, s]) => [u, { muted: s.muted, deaf: s.deaf, camera: !!s.camera, screen: !!s.screen, ...(s.smute ? { smute: true } : {}), ...(s.sdeaf ? { sdeaf: true } : {}) }])) };
    if (call) v.call = callView(call);
    else if (!M.room(place)) v.call = null;
    return v;
  }
  function voiceChanged(place) {
    const users = audienceOf(place);
    if (!users.length) return;
    hub.toUsers(users, 'voice', { room: place, ...voiceView(place) });
  }
  // Join a voice place (a room or a call). Leaves wherever this person was:
  // one live call per person. Returns who is already there, to call.
  hub.voiceJoin = (c, place) => {
    const was = voiceOf.get(c.user);
    const before = was && voiceRooms.get(was)?.get(c.user);
    const m0 = voiceRooms.get(place);
    if (was !== place && (m0?.size || 0) >= VOICE_MAX) {
      throw new UserError(calls.has(place) ? 'This call is full. It holds up to 12 people.' : 'This voice room is full. It holds up to 12 people.');
    }
    // Joined somewhere from another device: that device stops.
    if (before && before.ws !== c.ws) send(before.ws, { t: 'ev', ev: 'voice.kicked', d: { room: was, reason: 'elsewhere' } });
    hub.voiceLeave(c.user, { moving: was === place });
    if (!voiceRooms.has(place)) voiceRooms.set(place, new Map());
    const m = voiceRooms.get(place);
    const peers = [...m.keys()];
    m.set(c.user, { ws: c.ws, muted: false, deaf: false, camera: false, screen: false });
    voiceOf.set(c.user, place);
    voiceChanged(place);
    return peers;
  };
  hub.voiceLeave = (u, { moving = false } = {}) => {
    const place = voiceOf.get(u);
    if (!place) return;
    voiceOf.delete(u);
    const m = voiceRooms.get(place);
    m?.delete(u);
    if (m && !m.size) voiceRooms.delete(place);
    const call = calls.get(place);
    if (call && !moving) {
      const left = voiceRooms.get(place)?.size || 0;
      // A call lasts while anyone is in it; a one-to-one call ends when either person hangs up.
      if (!left) return endCall(call, call.answered ? 'ended' : 'cancelled');
      if (!call.group && call.answered) return endCall(call, 'ended');
    }
    voiceChanged(place);
    return undefined;
  };
  hub.voiceState = (u, s) => {
    const room = voiceOf.get(u);
    const entry = room && voiceRooms.get(room)?.get(u);
    if (!entry) return false;
    Object.assign(entry, s);
    voiceChanged(room);
    return true;
  };
  hub.rtcRelay = (from, to, data) => {
    const room = voiceOf.get(from);
    if (!room || voiceOf.get(to) !== room) return false;
    send(voiceRooms.get(room).get(to).ws, { t: 'ev', ev: 'rtc', d: { from, data } });
    return true;
  };
  // Where someone is talking right now (server/safety.js: voice moderation).
  hub.voicePlaceOf = (u) => voiceOf.get(u) || null;
  // Who is in a voice place, and one person's flags there (server/voiceopts.js: the soundboard).
  hub.voiceUsers = (place) => [...(voiceRooms.get(place)?.keys() || [])];
  hub.voiceStateOf = (u) => {
    const e = voiceOf.has(u) && voiceRooms.get(voiceOf.get(u))?.get(u);
    return e ? { muted: !!e.muted, deaf: !!e.deaf, smute: !!e.smute, sdeaf: !!e.sdeaf } : null;
  };
  hub.leaveVoiceInHouse = (u, houseId) => {
    const room = voiceOf.get(u);
    if (room && M.room(room)?.house === houseId) { hub.toUser(u, 'voice.kicked', { room }); hub.voiceLeave(u); }
  };
  hub.closeVoiceRoom = (room) => {
    for (const u of [...(voiceRooms.get(room)?.keys() || [])]) { hub.toUser(u, 'voice.kicked', { room }); hub.voiceLeave(u); }
  };

  // ---------- Calls in direct conversations and groups ----------
  // The ring for one person: who calls, how, until when, and whether their
  // device should stay quiet (a muted conversation, or Focused). `ms` is how
  // long it still rings: devices count from that, not from `until`, because
  // their clocks need not agree with this server's.
  function ringView(call, u) {
    const quiet = M.notifyOf(u, call.dm) === 'muted' || M.userRow(u)?.presence === 'focus';
    const until = call.ringing.get(u)?.until || Date.now();
    return { dm: call.dm, call: call.id, from: call.by, video: call.video, group: call.group, until, ms: Math.max(0, until - Date.now()), quiet };
  }
  function ring(call, u) {
    const until = Date.now() + ringMs;
    call.ringing.set(u, { until, timer: setTimeout(() => ringTimeout(call, u), ringMs) });
    hub.toUser(u, 'call.ring', { ...ringView(call, u), users: hub.usersFor([call.by]) });
    // Nothing open anywhere: the phone or computer gets a push instead.
    if (!hub.connected(u)) hub.hooks.ring?.(u, ringView(call, u));
  }
  function stopRing(call, u, reason) {
    const r = call.ringing.get(u);
    if (!r) return;
    clearTimeout(r.timer);
    call.ringing.delete(u);
    hub.toUser(u, 'call.ring.stop', { dm: call.dm, call: call.id, reason });
    hub.hooks.ringStop?.(u, { dm: call.dm, call: call.id, from: call.by, video: call.video, group: call.group, reason });
  }
  function ringTimeout(call, u) {
    if (calls.get(call.dm) !== call || !call.ringing.has(u)) return;
    stopRing(call, u, 'timeout');
    // Nobody picked up a one-to-one call: it ends for the caller with "No answer".
    if (!call.group && !call.answered) endCall(call, 'no-answer');
    else voiceChanged(call.dm);
  }
  // The call is over: stop every ring, drop everyone still in it, and write
  // its record into the conversation.
  function endCall(call, reason) {
    if (calls.get(call.dm) !== call) return;
    calls.delete(call.dm);
    for (const u of [...call.ringing.keys()]) stopRing(call, u, 'ended');
    for (const u of [...(voiceRooms.get(call.dm)?.keys() || [])]) voiceOf.delete(u);
    voiceRooms.delete(call.dm);
    const members = dmMembers(call.dm);
    hub.toUsers(members, 'call.ended', { dm: call.dm, call: call.id, reason });
    voiceChanged(call.dm);
    writeRecord(call, reason, members);
  }
  // "Missed call", "Declined call" or "Call · 4m 12s", by whoever started it.
  // Written by the server, so nobody can edit or delete it. Nobody's read
  // marker moves: it is one pointer per conversation, and moving it would mark
  // every message before the record read too (a message sent just before the
  // call, or during it). The record itself needs only the people who missed
  // the call (js/lib/attention.js missedCall, push.js needs).
  function writeRecord(call, reason, members) {
    if (!members.includes(call.by)) return;
    const t = now();
    const outcome = call.answered ? 'answered' : reason === 'declined' ? 'declined' : 'missed';
    const rec = { id: call.id, by: call.by, video: call.video, outcome, joined: [...call.joined], declined: [...call.declined], started: call.started };
    if (call.answered) rec.dur = t - call.answered;
    const text = outcome === 'answered' ? `Call · ${callLength(rec.dur)}` : outcome === 'declined' ? 'Declined call' : 'Missed call';
    const mid = newId('m');
    db.run('INSERT INTO messages (id, conv, author, ts, text, fold, sys) VALUES (?, ?, ?, ?, ?, ?, ?)',
      mid, call.dm, call.by, t, text, M.foldText(text, []), JSON.stringify(rec));
    const [m] = M.withReactions([M.msg(mid)]);
    hub.toConv(call.dm, 'msg', { conv: call.dm, m, user: hub.userView(call.by) });
    hub.hooks.message?.(call.dm, mid);
  }

  // Start a call in a direct conversation (or join the one already live there)
  // and ring everyone else in it on every device they have open.
  hub.callStart = (c, dm, video) => {
    if (calls.has(dm)) return hub.callJoin(c, dm);
    const members = dmMembers(dm);
    const call = {
      id: newId('call'), dm, by: c.user, video: !!video, started: Date.now(), answered: null,
      group: members.length > 2, joined: new Set([c.user]), declined: new Set(), ringing: new Map(),
    };
    calls.set(dm, call);
    let peers;
    try { peers = hub.voiceJoin(c, dm); } catch (e) { calls.delete(dm); throw e; }
    // Nobody who blocked the caller (or hasn't accepted their message request) is rung (server/safety.js).
    for (const u of members) if (u !== c.user && !M.ringBlocked?.(c.user, u, dm)) ring(call, u);
    voiceChanged(dm);
    return { peers, call: call.id };
  };
  hub.callJoin = (c, dm) => {
    const call = calls.get(dm);
    if (!call) throw new UserError('That call has ended.');
    // Picking up on one device stops the ring on the others.
    if (call.ringing.has(c.user)) {
      if ((voiceRooms.get(dm)?.size || 0) >= VOICE_MAX) throw new UserError('This call is full. It holds up to 12 people.');
      stopRing(call, c.user, 'answered');
    }
    const peers = hub.voiceJoin(c, dm);
    call.joined.add(c.user);
    call.declined.delete(c.user);
    if (c.user !== call.by && !call.answered) { call.answered = Date.now(); voiceChanged(dm); }
    return { peers, call: call.id };
  };
  hub.callDecline = (u, dm, callId) => {
    const call = calls.get(dm);
    if (!call || (callId && call.id !== callId) || !call.ringing.has(u)) return;
    stopRing(call, u, 'declined');
    call.declined.add(u);
    if (!call.group && !call.answered) endCall(call, 'declined');
    else voiceChanged(dm);
  };
  hub.callOf = (dm) => callView(calls.get(dm)) || null;

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
    for (const call of calls.values()) for (const r of call.ringing.values()) clearTimeout(r.timer);
    for (const set of socks.values()) for (const ws of set) ws.terminate();
    wss.close();
  };
  hub.ops = ops;
  hub.resetLimits = () => { Object.values(limits).forEach((l) => l.reset()); (hub.extraLimits || []).forEach((l) => l.reset()); };
  return hub;
}
