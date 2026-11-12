// What a given person may see, shaped the way the client's state expects it.
// Every read goes through here, so access rules live in one place.
import { randomBytes } from 'node:crypto';
import { can, canPost } from '../js/lib/perms.js';
import { fold } from '../js/lib/util.js';
import { parseQuery } from '../js/lib/search.js';
import { EVENT_LENGTH } from '../js/lib/social.js';

export const PAGE = 60;
const ALPHA = 'abcdefghijklmnopqrstuvwxyz0123456789';
export function newId(prefix) {
  const bytes = randomBytes(14);
  let s = '';
  for (const b of bytes) s += ALPHA[b % 36];
  return `${prefix}_${s}`;
}

const json = (s, fallback) => { try { return s == null ? fallback : JSON.parse(s); } catch { return fallback; } };

// Server time that never goes backwards, so ts order equals send order.
let lastTs = 0;
export function now() { lastTs = Math.max(Date.now(), lastTs + 1); return lastTs; }

export function createModel(db) {
  const M = {};

  // People
  M.userRow = (id) => db.get('SELECT * FROM users WHERE id = ?', id);
  M.userView = (row, presence) => row && ({
    id: row.id, handle: row.handle, name: row.name, hue: row.hue, emoji: row.emoji || undefined,
    about: row.about, status: row.status, presence,
    interests: json(row.interests, []), links: json(row.links, []), since: row.created,
  });

  // Conversations
  M.room = (id) => db.get('SELECT * FROM rooms WHERE id = ?', id);
  M.isMember = (house, user) => !!db.get('SELECT 1 FROM members WHERE house = ? AND user = ?', house, user);
  M.inDm = (dm, user) => !!db.get('SELECT 1 FROM dm_members WHERE dm = ? AND user = ?', dm, user);
  M.thread = (id) => db.get('SELECT * FROM threads WHERE id = ?', id);

  // Where a conversation lives: a room in a house, a direct conversation, or a thread on one of those.
  M.where = (conv) => {
    if (typeof conv !== 'string') return null;
    if (conv.startsWith('t:')) {
      const t = M.thread(conv);
      const parent = t ? M.where(t.conv) : null;
      return parent && { type: 'thread', id: conv, parent: t.conv, root: t.root, house: parent.house, room: parent.room, dm: parent.dm };
    }
    const room = M.room(conv);
    if (room) return { type: 'room', id: conv, house: room.house, room };
    if (db.get('SELECT 1 FROM dms WHERE id = ?', conv)) return { type: 'dm', id: conv, dm: conv };
    return null;
  };

  M.canRead = (user, conv) => {
    const w = M.where(conv);
    if (!w) return false;
    if (w.house) return M.isMember(w.house, user);
    return M.inDm(w.dm, user);
  };

  // Everyone allowed to read a conversation.
  M.audience = (conv) => {
    const w = M.where(conv);
    if (!w) return [];
    if (w.house) return db.all('SELECT user FROM members WHERE house = ?', w.house).map((r) => r.user);
    return db.all('SELECT user FROM dm_members WHERE dm = ?', w.dm).map((r) => r.user);
  };

  // Everyone who shares a house or a direct conversation with this person,
  // plus their friends and the people they sent a request to: the people who
  // see this person's presence and profile changes. Sending someone a request
  // does not let you see them; only their saying yes (or asking you) does.
  M.contacts = (user) => db.all(`
    SELECT DISTINCT m2.user AS id FROM members m1 JOIN members m2 ON m1.house = m2.house WHERE m1.user = ?
    UNION SELECT DISTINCT d2.user FROM dm_members d1 JOIN dm_members d2 ON d1.dm = d2.dm WHERE d1.user = ?
    UNION SELECT other FROM friends WHERE user = ? AND state IN ('friends', 'outgoing')`, user, user, user).map((r) => r.id);
  // Whether "viewer" may see "user"'s presence and status (the mirror of contacts).
  M.sees = (viewer, user) => viewer === user || !!db.get(`
    SELECT 1 FROM members m1 JOIN members m2 ON m1.house = m2.house WHERE m1.user = ? AND m2.user = ?
    UNION SELECT 1 FROM dm_members d1 JOIN dm_members d2 ON d1.dm = d2.dm WHERE d1.user = ? AND d2.user = ?
    UNION SELECT 1 FROM friends WHERE user = ? AND other = ? AND state IN ('friends', 'incoming')
    LIMIT 1`, viewer, user, viewer, user, viewer, user);
  // How someone looks to a person not allowed to see them: no presence, no status.
  M.hiddenView = (row) => row && { ...M.userView(row, 'offline'), status: '' };
  // The people this person may start a conversation with: shared houses and
  // conversations, and accepted friends (a pending request is not enough).
  M.dmPeers = (user) => new Set(db.all(`
    SELECT DISTINCT m2.user AS id FROM members m1 JOIN members m2 ON m1.house = m2.house WHERE m1.user = ?
    UNION SELECT DISTINCT d2.user FROM dm_members d1 JOIN dm_members d2 ON d1.dm = d2.dm WHERE d1.user = ?
    UNION SELECT other FROM friends WHERE user = ? AND state = 'friends'`, user, user, user).map((r) => r.id));

  // Friends, from one person's side. Favourites are private to that person.
  M.friendView = (row) => row && { state: row.state, favorite: !!row.favorite, since: row.since };
  M.friendRow = (user, other) => db.get('SELECT * FROM friends WHERE user = ? AND other = ?', user, other);
  M.friendsOf = (user) => Object.fromEntries(db.all('SELECT * FROM friends WHERE user = ?', user).map((r) => [r.other, M.friendView(r)]));
  M.areFriends = (a, b) => M.friendRow(a, b)?.state === 'friends';

  // Events
  M.eventRow = (id) => db.get('SELECT * FROM events WHERE id = ?', id);
  M.eventView = (row) => row && {
    id: row.id, house: row.house, room: row.room || null, title: row.title, about: row.about,
    starts: row.starts, ends: row.ends ?? null, by: row.by, created: row.created,
    going: db.all('SELECT user FROM event_rsvps WHERE event = ? ORDER BY ts', row.id).map((r) => r.user),
  };
  // Events in the houses this person has joined that are not long over.
  M.eventsFor = (user, at = Date.now()) => db.all(`
    SELECT e.* FROM events e JOIN members m ON m.house = e.house AND m.user = ?
    WHERE COALESCE(e.ends, e.starts + ?) > ? ORDER BY e.starts LIMIT 500`, user, EVENT_LENGTH, at - 86_400_000)
    .map(M.eventView);

  // The client's permission rules, fed with this house's real roles and members.
  M.permState = (houseId, user) => {
    const roles = db.all('SELECT id, name, hue, perms FROM roles WHERE house = ? ORDER BY pos', houseId)
      .map((r) => ({ ...r, perms: json(r.perms, []) }));
    const members = Object.fromEntries(db.all('SELECT user, role FROM members WHERE house = ?', houseId).map((r) => [r.user, r.role]));
    const rooms = Object.fromEntries(db.all('SELECT id, house, name, kind FROM rooms WHERE house = ?', houseId).map((r) => [r.id, r]));
    return { me: user, houses: { [houseId]: { id: houseId, roles, members } }, rooms };
  };
  M.can = (user, houseId, perm) => can(M.permState(houseId, user), houseId, perm);
  M.isOwner = (user, houseId) => {
    const owner = db.get('SELECT id FROM roles WHERE house = ? ORDER BY pos LIMIT 1', houseId);
    const mine = db.get('SELECT role FROM members WHERE house = ? AND user = ?', houseId, user);
    return !!owner && mine?.role === owner.id;
  };

  // Can this person write here? Threads only need the right to post, so people
  // can reply in threads under notices they cannot post in.
  M.postGate = (user, conv) => {
    const w = M.where(conv);
    if (!w || !M.canRead(user, conv)) return { ok: false, why: 'You don’t have access to this conversation.' };
    if (!w.house) return { ok: true };
    if (w.type === 'thread') return M.can(user, w.house, 'post') ? { ok: true } : { ok: false, why: 'Your role can read this room but not write in it.' };
    return canPost(M.permState(w.house, user), conv);
  };

  // Messages
  M.reactions = (ids) => {
    const out = {};
    if (!ids.length) return out;
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = db.all(`SELECT msg, user, emoji FROM reactions WHERE msg IN (${chunk.map(() => '?').join(',')}) ORDER BY ts`, ...chunk);
      for (const r of rows) ((out[r.msg] ||= {})[r.emoji] ||= []).push(r.user);
    }
    return out;
  };
  M.msgView = (row, rx) => {
    const m = { id: row.id, author: row.author, ts: row.ts, seq: row.seq, text: row.text };
    if (row.reply_to) m.replyTo = row.reply_to;
    if (row.files) m.files = json(row.files, []);
    if (row.edited) m.edited = row.edited;
    if (rx && Object.keys(rx).length) m.reactions = rx;
    return m;
  };
  M.withReactions = (rows) => {
    const rx = M.reactions(rows.map((r) => r.id));
    return rows.map((r) => M.msgView(r, rx[r.id]));
  };
  M.msg = (id) => db.get('SELECT * FROM messages WHERE id = ?', id);
  M.liveMsg = (id) => db.get('SELECT * FROM messages WHERE id = ? AND deleted IS NULL', id);

  // A page of a conversation, oldest first.
  M.page = (conv, { before, fromSeq, limit = PAGE } = {}) => {
    let rows;
    if (fromSeq != null) {
      rows = db.all('SELECT * FROM messages WHERE conv = ? AND deleted IS NULL AND seq >= ? AND seq < ? ORDER BY seq LIMIT 2000',
        conv, fromSeq, before ?? Number.MAX_SAFE_INTEGER);
    } else {
      rows = db.all('SELECT * FROM messages WHERE conv = ? AND deleted IS NULL AND seq < ? ORDER BY seq DESC LIMIT ?',
        conv, before ?? Number.MAX_SAFE_INTEGER, limit + 1).reverse();
    }
    const first = rows[0];
    const more = !!first && !!db.get('SELECT 1 FROM messages WHERE conv = ? AND deleted IS NULL AND seq < ? LIMIT 1', conv, first.seq);
    if (fromSeq == null && rows.length > limit) rows.shift();
    return { msgs: M.withReactions(rows), more };
  };

  M.foldText = (text, files) => fold(`${text || ''} ${(files || []).map((f) => f.name).join(' ')}`);

  // Houses
  M.notifyOf = (user, place) => db.get('SELECT level FROM notify WHERE user = ? AND place = ?', user, place)?.level;

  M.houseView = (id, viewer) => {
    const h = db.get('SELECT * FROM houses WHERE id = ?', id);
    if (!h) return null;
    const roles = db.all('SELECT id, name, hue, perms FROM roles WHERE house = ? ORDER BY pos', id)
      .map((r) => ({ id: r.id, name: r.name, hue: r.hue, perms: json(r.perms, []) }));
    const mem = db.all('SELECT user, role, newcomer FROM members WHERE house = ?', id);
    const mine = mem.find((m) => m.user === viewer);
    const groups = db.all('SELECT id, name FROM room_groups WHERE house = ? ORDER BY pos', id);
    const roomRows = db.all('SELECT * FROM rooms WHERE house = ? ORDER BY pos', id);
    const rooms = {};
    for (const r of roomRows) {
      rooms[r.id] = { id: r.id, house: id, name: r.name, kind: r.kind, topic: r.topic, notify: mine ? M.notifyOf(viewer, r.id) || null : null, highlights: mine ? json(r.highlights, []) : [] };
    }
    return {
      house: {
        id, name: h.name, mark: h.mark, hue: h.hue, about: h.about, joined: !!mine, newcomer: !!mine?.newcomer,
        public: !!h.public, topic: h.topic || null, rules: h.rules || '', created: h.created,
        notify: (mine && M.notifyOf(viewer, id)) || 'all', roles, joinRole: h.join_role,
        members: Object.fromEntries(mem.map((m) => [m.user, m.role])),
        groups: groups.map((g) => ({ id: g.id, name: g.name, rooms: roomRows.filter((r) => r.grp === g.id).map((r) => r.id) })),
        starter: json(h.starter, []), firstStep: json(h.first_step, undefined),
      },
      rooms,
      userIds: mem.map((m) => m.user),
    };
  };

  M.dmView = (id, viewer) => {
    const d = db.get('SELECT * FROM dms WHERE id = ?', id);
    if (!d) return null;
    const members = db.all('SELECT user FROM dm_members WHERE dm = ? ORDER BY rowid', id).map((r) => r.user);
    const v = { id, members };
    if (d.name) v.name = d.name;
    const level = M.notifyOf(viewer, id);
    if (level) v.notify = level;
    return v;
  };

  M.houseIdsOf = (user) => db.all('SELECT house FROM members WHERE user = ? ORDER BY joined', user).map((r) => r.house);
  M.dmIdsOf = (user) => db.all('SELECT d.id FROM dms d JOIN dm_members m ON m.dm = d.id WHERE m.user = ? ORDER BY d.created DESC', user).map((r) => r.id);

  // Every conversation this person can read, threads included.
  M.readable = (user) => {
    const rooms = db.all('SELECT r.id FROM rooms r JOIN members m ON m.house = r.house WHERE m.user = ?', user).map((r) => r.id);
    const convs = [...rooms, ...M.dmIdsOf(user)];
    const threads = convs.length
      ? db.all(`SELECT id FROM threads WHERE conv IN (${convs.map(() => '?').join(',')})`, ...convs).map((r) => r.id)
      : [];
    return [...convs, ...threads];
  };

  // Everything a client needs on connect, for one person.
  M.snapshot = (user, presenceOf, voice) => {
    const users = new Set([user]);
    const houses = {}, rooms = {}, dms = {}, msgs = {}, more = {}, threads = {}, cache = {};
    const houseOrder = M.houseIdsOf(user);
    const invites = db.all('SELECT house, by AS "from", ts FROM personal_invites WHERE user = ? ORDER BY ts DESC', user);
    for (const id of [...houseOrder, ...invites.map((i) => i.house)]) {
      const v = M.houseView(id, user);
      if (!v) continue;
      houses[id] = v.house;
      Object.assign(rooms, v.rooms);
      v.userIds.forEach((u) => users.add(u));
    }
    invites.forEach((i) => users.add(i.from));
    const friends = M.friendsOf(user);
    Object.keys(friends).forEach((u) => users.add(u));
    const events = Object.fromEntries(M.eventsFor(user).map((e) => [e.id, e]));
    const dmOrder = M.dmIdsOf(user);
    for (const id of dmOrder) {
      dms[id] = M.dmView(id, user);
      dms[id].members.forEach((u) => users.add(u));
    }
    const convs = M.readable(user);
    for (const conv of convs) {
      const p = M.page(conv);
      msgs[conv] = p.msgs;
      if (p.more) more[conv] = true;
      p.msgs.forEach((m) => users.add(m.author));
    }
    for (const t of db.all(`SELECT * FROM threads WHERE id IN (${convs.map(() => '?').join(',') || "''"})`, ...convs)) {
      threads[t.id] = { conv: t.conv, root: t.root };
    }
    // People you have only asked, with no place in common, stay offline to you until they say yes.
    const hidden = new Set(Object.entries(friends).filter(([u, f]) => f.state === 'outgoing' && !M.sees(user, u)).map(([u]) => u));
    const read = Object.fromEntries(db.all('SELECT conv, ts FROM reads WHERE user = ?', user).map((r) => [r.conv, r.ts]));
    const followed = Object.fromEntries(db.all('SELECT thread FROM follows WHERE user = ?', user).map((r) => [r.thread, true]));
    const saved = db.all('SELECT msg AS id, conv, at, note FROM saved WHERE user = ? ORDER BY at DESC', user)
      .filter((s) => convs.includes(s.conv));
    // Saved and highlighted messages outside the loaded pages still need their text.
    const loaded = new Set(Object.values(msgs).flat().map((m) => m.id));
    const extra = [...saved.map((s) => s.id), ...Object.values(rooms).flatMap((r) => r.highlights)].filter((id) => !loaded.has(id));
    for (const m of M.withReactions(extra.map(M.liveMsg).filter(Boolean))) { cache[m.id] = m; users.add(m.author); }
    const roomIds = new Set(Object.keys(rooms).filter((r) => houses[rooms[r].house]?.joined));
    const voiceState = {};
    for (const [room, state] of Object.entries(voice)) if (roomIds.has(room)) voiceState[room] = state;
    return {
      me: user,
      users: Object.fromEntries([...users].map((id) => [id, hidden.has(id) ? M.hiddenView(M.userRow(id)) : M.userView(M.userRow(id), presenceOf(id))]).filter(([, u]) => u)),
      houses, rooms, houseOrder, dms, dmOrder, msgs, more, threads, read, followed, saved, cache,
      invites, voice: voiceState, friends, events,
    };
  };

  // Search over stored messages the person can read.
  M.search = (user, q, limit = 80) => {
    const p = parseQuery(q);
    if (!p.terms.length && !p.from.length && !p.in.length && !p.has.length && !p.saved) return [];
    let convs = M.readable(user);
    if (p.in.length) {
      const nameOf = (conv) => {
        const w = M.where(conv);
        if (!w) return '';
        if (w.room) return w.room.name;
        const d = db.get('SELECT name FROM dms WHERE id = ?', w.dm);
        if (d?.name) return d.name;
        return db.all('SELECT u.name FROM dm_members m JOIN users u ON u.id = m.user WHERE m.dm = ? AND m.user != ?', w.dm, user).map((r) => r.name).join(' ');
      };
      convs = convs.filter((c) => { const n = fold(nameOf(c)); return p.in.every((v) => n.includes(v)); });
    }
    if (!convs.length) return [];
    const where = [`conv IN (${convs.map(() => '?').join(',')})`, 'deleted IS NULL'];
    const params = [...convs];
    for (const t of p.terms) { where.push("fold LIKE ? ESCAPE '\\'"); params.push(`%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`); }
    if (p.from.length) {
      const authors = db.all('SELECT id, name, handle FROM users').filter((u) => p.from.every((v) => fold(`${u.name} ${u.handle}`).includes(v))).map((u) => u.id);
      if (!authors.length) return [];
      where.push(`author IN (${authors.map(() => '?').join(',')})`);
      params.push(...authors);
    }
    if (p.saved) { where.push('id IN (SELECT msg FROM saved WHERE user = ?)'); params.push(user); }
    const rows = db.all(`SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT 1000`, ...params)
      .filter((r) => {
        const files = json(r.files, []);
        return p.has.every((h) => (h === 'image' && files.some((f) => f.kind === 'image'))
          || (h === 'file' && files.some((f) => f.kind === 'file'))
          || (h === 'link' && /https?:\/\//.test(r.text)));
      }).slice(0, limit);
    return M.withReactions(rows).map((m, i) => ({ conv: rows[i].conv, m }));
  };

  return M;
}
