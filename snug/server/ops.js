// Every action a client can ask for. Each one validates its input, checks
// permission against the database, writes, and tells the people affected.
// Nothing here trusts the client's own permission checks.
import { randomBytes } from 'node:crypto';
import { PERMS } from '../js/lib/perms.js';
import { newId, now } from './model.js';

export class UserError extends Error {}
const fail = (msg) => { throw new UserError(msg); };

// Input checks
const str = (v, { max = 200, min = 0, name = 'This', trim = true } = {}) => {
  if (typeof v !== 'string') fail(`${name} is missing.`);
  const s = trim ? v.trim() : v;
  if (s.length < min) fail(min === 1 ? `${name} can’t be empty.` : `${name} needs at least ${min} characters.`);
  if (s.length > max) fail(`${name} can be at most ${max} characters.`);
  // Control characters other than newline and tab have no business in chat.
  return s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
};
const opt = (v, o) => (v === undefined ? undefined : str(v, o));
const id = (v, name = 'id') => (typeof v === 'string' && /^[\w:.-]{1,80}$/.test(v) ? v : fail(`That ${name} isn’t valid.`));
const hue = (v) => (Number.isInteger(v) && v >= 0 && v < 360 ? v : fail('Pick one of the colours.'));
const bool = (v) => v === true;
const oneOf = (v, list, name) => (list.includes(v) ? v : fail(`${name} isn’t one of the choices.`));
const MSG_ID = /^m_[a-z0-9]{8,40}$/;
const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️|⃣|[#*0-9])+$/u;
const PRESENCE = ['open', 'around', 'focus', 'away', 'offline'];
const LEVELS = ['all', 'mentions', 'muted'];
const KINDS = ['text', 'voice', 'news'];
const PERM_IDS = PERMS.map((p) => p.id);
const json = (s, f) => { try { return s == null ? f : JSON.parse(s); } catch { return f; } };

export function createOps({ db, M, hub }) {
  const member = (user, house) => (M.isMember(house, user) ? true : fail('You’re not a member of that house.'));
  const need = (user, house, perm, what) => {
    member(user, house);
    if (!M.can(user, house, perm)) fail(`Your role can’t ${what} in this house.`);
  };
  const readable = (user, conv) => (M.canRead(user, conv) ? M.where(conv) : fail('You don’t have access to this conversation.'));
  const houseOf = (houseId) => db.get('SELECT * FROM houses WHERE id = ?', houseId) || fail('That house doesn’t exist.');

  // A thread exists from its first reply or follow. Threads hang off rooms and
  // direct conversations only, never off other threads.
  function ensureThread(user, conv) {
    if (M.thread(conv)) return;
    const root = M.liveMsg(conv.slice(2));
    if (!root || root.conv.startsWith('t:') || !M.canRead(user, root.conv)) fail('That thread’s message no longer exists.');
    db.run('INSERT OR IGNORE INTO threads (id, conv, root) VALUES (?, ?, ?)', conv, root.conv, root.id);
  }

  function msgEvent(conv, row) {
    const [m] = M.withReactions([row]);
    const t = conv.startsWith('t:') ? M.thread(conv) : null;
    return { conv, m, user: hub.userView(row.author), thread: t ? { id: t.id, conv: t.conv, root: t.root } : undefined };
  }

  function canModerate(user, conv, row) {
    if (row.author === user) return true;
    const w = M.where(conv);
    return !!w?.house && M.can(user, w.house, 'moderate');
  }

  function join(user, houseId) {
    const h = houseOf(houseId);
    if (!M.isMember(houseId, user)) {
      const role = h.join_role || db.get('SELECT id FROM roles WHERE house = ? ORDER BY pos DESC LIMIT 1', houseId).id;
      const t = Date.now();
      db.tx(() => {
        db.run('INSERT INTO members (house, user, role, newcomer, joined) VALUES (?, ?, ?, 1, ?)', houseId, user, role, t);
        // Start fresh: history is there to read, but none of it counts as unread.
        for (const r of db.all('SELECT id FROM rooms WHERE house = ?', houseId)) {
          db.run('INSERT INTO reads (user, conv, ts) VALUES (?, ?, ?) ON CONFLICT (user, conv) DO UPDATE SET ts = excluded.ts', user, r.id, t);
        }
        db.run('DELETE FROM personal_invites WHERE house = ? AND user = ?', houseId, user);
      });
    }
    hub.houseChanged(houseId);
    hub.sendHouseContent(user, houseId);
    hub.sendSelf(user, { invites: db.all('SELECT house, by AS "from", ts FROM personal_invites WHERE user = ? ORDER BY ts DESC', user) });
    return { house: houseId, starter: json(h.starter, []) };
  }

  function removeMember(houseId, target) {
    db.run('DELETE FROM members WHERE house = ? AND user = ?', houseId, target);
    db.run('DELETE FROM notify WHERE user = ? AND place IN (SELECT id FROM rooms WHERE house = ?)', target, houseId);
    hub.leaveVoiceInHouse(target, houseId);
    hub.toUser(target, 'house.gone', { id: houseId });
    if (!db.get('SELECT 1 FROM members WHERE house = ?', houseId)) {
      // Nobody left: the house and everything in it goes.
      db.tx(() => {
        const rooms = db.all('SELECT id FROM rooms WHERE house = ?', houseId).map((r) => r.id);
        for (const r of rooms) {
          db.run('DELETE FROM messages WHERE conv = ? OR conv IN (SELECT id FROM threads WHERE conv = ?)', r, r);
          db.run('DELETE FROM threads WHERE conv = ?', r);
        }
        db.run('DELETE FROM houses WHERE id = ?', houseId);
      });
    } else hub.houseChanged(houseId);
  }

  const ops = {
    sync: (c) => hub.snapshotFor(c.user),

    // Messages
    'msg.send'(c, d) {
      const conv = id(d.conv, 'conversation');
      const mid = typeof d.id === 'string' && MSG_ID.test(d.id) ? d.id : fail('That message id isn’t valid.');
      const existing = M.msg(mid);
      if (existing) {
        // A retry after a dropped connection: the first copy already landed.
        if (existing.author !== c.user || existing.conv !== conv) fail('That message id is already taken.');
        return { m: msgEvent(conv, existing).m };
      }
      if (conv.startsWith('t:')) { readable(c.user, M.thread(conv)?.conv || M.liveMsg(conv.slice(2))?.conv || fail('That thread’s message no longer exists.')); ensureThread(c.user, conv); }
      const gate = M.postGate(c.user, conv);
      if (!gate.ok) fail(gate.why);
      const text = str(d.text ?? '', { max: 4000, name: 'A message', trim: false }).replace(/^\s+$/, '');
      const files = [];
      for (const f of (Array.isArray(d.files) ? d.files : []).slice(0, 6)) {
        const row = db.get('SELECT * FROM files WHERE id = ? AND owner = ? AND conv = ?', id(f?.id, 'file'), c.user, conv);
        if (!row) fail('One of the attachments didn’t finish uploading. Remove it and attach it again.');
        const out = { kind: row.type.startsWith('image/') ? 'image' : 'file', id: row.id, name: row.name, size: row.size };
        if (out.kind === 'image' && Number.isInteger(f.w) && Number.isInteger(f.h)) { out.w = Math.min(8000, Math.max(1, f.w)); out.h = Math.min(8000, Math.max(1, f.h)); }
        files.push(out);
      }
      if (!text.trim() && !files.length) fail('Write something first.');
      let replyTo = null;
      if (d.replyTo != null) {
        const r = M.liveMsg(id(d.replyTo, 'message'));
        if (!r || r.conv !== conv) fail('The message you replied to was deleted.');
        replyTo = r.id;
      }
      const w = M.where(conv);
      const ts = now();
      db.tx(() => {
        db.run('INSERT INTO messages (id, conv, author, ts, text, fold, reply_to, files) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          mid, conv, c.user, ts, text, M.foldText(text, files), replyTo, files.length ? JSON.stringify(files) : null);
        db.run('INSERT INTO reads (user, conv, ts) VALUES (?, ?, ?) ON CONFLICT (user, conv) DO UPDATE SET ts = excluded.ts', c.user, conv, ts);
        if (w.type === 'thread') db.run('INSERT OR IGNORE INTO follows (user, thread) VALUES (?, ?)', c.user, conv);
      });
      const ev = msgEvent(conv, M.msg(mid));
      hub.toConv(conv, 'msg', ev);
      hub.sendSelf(c.user, { read: { [conv]: ts }, ...(w.type === 'thread' ? { follow: { [conv]: true } } : {}) });
      // A newcomer's first message opens the rest of the house.
      if (w.house && db.get('SELECT newcomer FROM members WHERE house = ? AND user = ?', w.house, c.user)?.newcomer) {
        db.run('UPDATE members SET newcomer = 0 WHERE house = ? AND user = ?', w.house, c.user);
        hub.sendHouse(c.user, w.house);
      }
      return { m: ev.m };
    },

    'msg.edit'(c, d) {
      const conv = id(d.conv, 'conversation');
      readable(c.user, conv);
      const row = M.liveMsg(id(d.id, 'message'));
      if (!row || row.conv !== conv) fail('That message was deleted.');
      if (row.author !== c.user) fail('You can only edit your own messages.');
      const text = str(d.text, { max: 4000, name: 'A message', trim: false });
      if (!text.trim() && !row.files) fail('Write something, or delete the message instead.');
      db.run('UPDATE messages SET text = ?, fold = ?, edited = ? WHERE id = ?', text, M.foldText(text, json(row.files, [])), Date.now(), row.id);
      hub.toConv(conv, 'msg', msgEvent(conv, M.msg(row.id)));
      return {};
    },

    'msg.delete'(c, d) {
      const conv = id(d.conv, 'conversation');
      readable(c.user, conv);
      const row = M.liveMsg(id(d.id, 'message'));
      if (!row || row.conv !== conv) return {};
      if (!canModerate(c.user, conv, row)) fail('You can only delete your own messages.');
      db.run('UPDATE messages SET deleted = ? WHERE id = ?', Date.now(), row.id);
      hub.toConv(conv, 'msg.del', { conv, id: row.id });
      return {};
    },

    // Undo for a delete, within ten minutes.
    'msg.restore'(c, d) {
      const conv = id(d.conv, 'conversation');
      readable(c.user, conv);
      const row = M.msg(id(d.id, 'message'));
      if (!row || row.conv !== conv || !row.deleted) return {};
      if (!canModerate(c.user, conv, row)) fail('You can only restore messages you could delete.');
      if (Date.now() - row.deleted > 10 * 60_000) fail('It’s been too long to bring that message back.');
      db.run('UPDATE messages SET deleted = NULL WHERE id = ?', row.id);
      hub.toConv(conv, 'msg', msgEvent(conv, M.msg(row.id)));
      return {};
    },

    react(c, d) {
      const conv = id(d.conv, 'conversation');
      readable(c.user, conv);
      const row = M.liveMsg(id(d.id, 'message'));
      if (!row || row.conv !== conv) fail('That message was deleted.');
      const emoji = typeof d.emoji === 'string' && d.emoji.length <= 16 && EMOJI.test(d.emoji) ? d.emoji : fail('Reactions are emoji only.');
      if (bool(d.on)) {
        const kinds = db.get('SELECT COUNT(DISTINCT emoji) n FROM reactions WHERE msg = ?', row.id).n;
        const has = db.get('SELECT 1 FROM reactions WHERE msg = ? AND emoji = ?', row.id, emoji);
        if (!has && kinds >= 20) fail('This message has as many different reactions as it can take.');
        db.run('INSERT OR IGNORE INTO reactions (msg, user, emoji, ts) VALUES (?, ?, ?, ?)', row.id, c.user, emoji, Date.now());
      } else db.run('DELETE FROM reactions WHERE msg = ? AND user = ? AND emoji = ?', row.id, c.user, emoji);
      hub.toConv(conv, 'react', { conv, id: row.id, reactions: M.reactions([row.id])[row.id] || {} });
      return {};
    },

    typing(c, d) {
      const conv = id(d.conv, 'conversation');
      if (!M.canRead(c.user, conv)) return {};
      hub.toConv(conv, 'typing', { conv, user: c.user }, c.user);
      return {};
    },

    history(c, d) {
      const conv = id(d.conv, 'conversation');
      readable(c.user, conv);
      const before = Number.isInteger(d.before) ? d.before : undefined;
      let fromSeq;
      if (d.fromId != null) {
        const t = M.liveMsg(id(d.fromId, 'message'));
        if (!t || t.conv !== conv) fail('That message was deleted.');
        // Ten messages of context above the one you are jumping to.
        const ctx = db.all('SELECT seq FROM messages WHERE conv = ? AND deleted IS NULL AND seq <= ? ORDER BY seq DESC LIMIT 11', conv, t.seq);
        fromSeq = ctx[ctx.length - 1].seq;
      }
      const p = M.page(conv, { before, fromSeq });
      return { ...p, users: hub.usersFor(p.msgs.map((m) => m.author)) };
    },

    // Read state, synced across a person's devices.
    'read.set'(c, d) {
      const conv = id(d.conv, 'conversation');
      if (!M.canRead(c.user, conv)) return {};
      const ts = Number.isInteger(d.ts) && d.ts >= 0 ? d.ts : fail('That time isn’t valid.');
      db.run('INSERT INTO reads (user, conv, ts) VALUES (?, ?, ?) ON CONFLICT (user, conv) DO UPDATE SET ts = excluded.ts', c.user, conv, ts);
      hub.sendSelf(c.user, { read: { [conv]: ts } }, c.ws);
      return {};
    },
    'read.many'(c, d) {
      const items = Array.isArray(d.items) ? d.items.slice(0, 2000) : [];
      const out = {};
      db.tx(() => {
        for (const it of items) {
          const conv = id(it?.conv, 'conversation');
          if (!Number.isInteger(it.ts) || !M.canRead(c.user, conv)) continue;
          db.run('INSERT INTO reads (user, conv, ts) VALUES (?, ?, ?) ON CONFLICT (user, conv) DO UPDATE SET ts = excluded.ts', c.user, conv, it.ts);
          out[conv] = it.ts;
        }
      });
      hub.sendSelf(c.user, { read: out }, c.ws);
      return {};
    },

    'saved.set'(c, d) {
      const conv = id(d.conv, 'conversation');
      readable(c.user, conv);
      const row = M.liveMsg(id(d.id, 'message'));
      if (bool(d.on)) {
        if (!row || row.conv !== conv) fail('That message was deleted.');
        db.run('INSERT OR IGNORE INTO saved (user, msg, conv, at, note) VALUES (?, ?, ?, ?, ?)', c.user, row.id, conv, Date.now(), opt(d.note, { max: 200, name: 'A note' }) || '');
      } else db.run('DELETE FROM saved WHERE user = ? AND msg = ?', c.user, d.id);
      hub.sendSelf(c.user, { saved: hub.savedFor(c.user), cache: row ? { [row.id]: M.withReactions([row])[0] } : {} }, c.ws);
      return {};
    },
    'saved.note'(c, d) {
      const note = str(d.note ?? '', { max: 200, name: 'A note' });
      db.run('UPDATE saved SET note = ? WHERE user = ? AND msg = ?', note, c.user, id(d.id, 'message'));
      hub.sendSelf(c.user, { saved: hub.savedFor(c.user) }, c.ws);
      return {};
    },

    'follow.set'(c, d) {
      const thread = id(d.thread, 'thread');
      if (!thread.startsWith('t:')) fail('That isn’t a thread.');
      ensureThread(c.user, thread);
      readable(c.user, thread);
      if (bool(d.on)) db.run('INSERT OR IGNORE INTO follows (user, thread) VALUES (?, ?)', c.user, thread);
      else db.run('DELETE FROM follows WHERE user = ? AND thread = ?', c.user, thread);
      hub.sendSelf(c.user, { follow: { [thread]: bool(d.on) } }, c.ws);
      return {};
    },

    'highlight.set'(c, d) {
      const conv = id(d.conv, 'room');
      const room = M.room(conv) || fail('Highlights belong to rooms.');
      need(c.user, room.house, 'highlight', 'curate highlights');
      const row = M.liveMsg(id(d.id, 'message'));
      if (!row || row.conv !== conv) fail('That message was deleted.');
      let list = json(room.highlights, []).filter((x) => x !== row.id);
      if (bool(d.on)) list = [row.id, ...list].slice(0, 50);
      db.run('UPDATE rooms SET highlights = ? WHERE id = ?', JSON.stringify(list), conv);
      hub.houseChanged(room.house);
      return {};
    },

    'notify.set'(c, d) {
      const kind = oneOf(d.kind, ['house', 'room', 'dm'], 'Where');
      const place = id(d.id, kind);
      const level = oneOf(d.level, kind === 'dm' ? ['all', 'muted'] : LEVELS, 'That level');
      const put = (p, l) => db.run('INSERT INTO notify (user, place, level) VALUES (?, ?, ?) ON CONFLICT (user, place) DO UPDATE SET level = excluded.level', c.user, p, l);
      const drop = (p) => db.run('DELETE FROM notify WHERE user = ? AND place = ?', c.user, p);
      if (kind === 'house') {
        member(c.user, place);
        if (level === 'all') drop(place); else put(place, level);
        // Rooms that now match their house no longer need their own setting.
        db.run('DELETE FROM notify WHERE user = ? AND level = ? AND place IN (SELECT id FROM rooms WHERE house = ?)', c.user, level, place);
        hub.sendHouse(c.user, place);
      } else if (kind === 'room') {
        const room = M.room(place) || fail('That room doesn’t exist.');
        member(c.user, room.house);
        const houseLevel = M.notifyOf(c.user, room.house) || 'all';
        if (level === houseLevel) drop(place); else put(place, level);
        hub.sendHouse(c.user, room.house);
      } else {
        if (!M.inDm(place, c.user)) fail('You’re not in that conversation.');
        if (level === 'all') drop(place); else put(place, level);
        hub.sendDm(c.user, place);
      }
      return {};
    },

    // You
    'me.update'(c, d) {
      const u = M.userRow(c.user);
      const next = {
        name: d.name !== undefined ? str(d.name, { min: 1, max: 40, name: 'Your name' }) : u.name,
        about: d.about !== undefined ? str(d.about, { max: 160, name: 'About you' }) : u.about,
        status: d.status !== undefined ? str(d.status, { max: 80, name: 'Your status' }) : u.status,
        presence: d.presence !== undefined ? oneOf(d.presence, PRESENCE, 'Presence') : u.presence,
        hue: d.hue !== undefined ? hue(d.hue) : u.hue,
        emoji: d.emoji === undefined ? u.emoji : (d.emoji === null || d.emoji === '' ? null : (typeof d.emoji === 'string' && d.emoji.length <= 16 && EMOJI.test(d.emoji) ? d.emoji : fail('Your picture can be one emoji.'))),
      };
      db.run('UPDATE users SET name = ?, about = ?, status = ?, presence = ?, hue = ?, emoji = ? WHERE id = ?',
        next.name, next.about, next.status, next.presence, next.hue, next.emoji, c.user);
      hub.userChanged(c.user);
      return {};
    },

    // Houses
    'house.create'(c, d) {
      const name = str(d.name, { min: 1, max: 40, name: 'The name' });
      const h = hue(d.hue);
      const hid = newId('h');
      const owner = newId('role'), memberRole = newId('role');
      const g1 = newId('g'), g2 = newId('g');
      const rooms = [['Notices', 'news', 'News from the people who run this house', g1], ['Lounge', 'text', 'Everyday conversation', g1], ['Introductions', 'text', 'Say hello', g1], ['Hangout', 'voice', 'Drop in and talk', g2]]
        .map(([n, k, t, g]) => ({ id: newId('r'), n, k, t, g }));
      const t = Date.now();
      db.tx(() => {
        db.run('INSERT INTO houses (id, name, mark, hue, about, join_role, starter, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          hid, name, [...name][0].toUpperCase(), h, '', memberRole, JSON.stringify(rooms.slice(0, 3).map((r) => r.id)), t);
        db.run('INSERT INTO roles (id, house, name, hue, perms, pos) VALUES (?, ?, ?, ?, ?, 0)', owner, hid, 'Owner', h, JSON.stringify(PERM_IDS));
        db.run('INSERT INTO roles (id, house, name, hue, perms, pos) VALUES (?, ?, ?, NULL, ?, 1)', memberRole, hid, 'Member', JSON.stringify(['post', 'invite']));
        db.run('INSERT INTO members (house, user, role, newcomer, joined) VALUES (?, ?, ?, 0, ?)', hid, c.user, owner, t);
        db.run('INSERT INTO room_groups (id, house, name, pos) VALUES (?, ?, ?, 0), (?, ?, ?, 1)', g1, hid, 'Rooms', g2, hid, 'Live');
        rooms.forEach((r, i) => db.run('INSERT INTO rooms (id, house, grp, name, kind, topic, pos) VALUES (?, ?, ?, ?, ?, ?, ?)', r.id, hid, r.g, r.n, r.k, r.t, i));
      });
      hub.sendHouseContent(c.user, hid);
      return { house: hid, room: rooms[1].id };
    },

    'house.update'(c, d) {
      const houseId = id(d.house, 'house');
      const h = houseOf(houseId);
      need(c.user, houseId, 'roles', 'change house settings');
      const roomIds = db.all('SELECT id FROM rooms WHERE house = ?', houseId).map((r) => r.id);
      const roleIds = db.all('SELECT id FROM roles WHERE house = ?', houseId).map((r) => r.id);
      const name = d.name !== undefined ? str(d.name, { min: 1, max: 40, name: 'The name' }) : h.name;
      const about = d.about !== undefined ? str(d.about, { max: 160, name: 'About' }) : h.about;
      const hueV = d.hue !== undefined ? hue(d.hue) : h.hue;
      const starter = d.starter !== undefined
        ? (Array.isArray(d.starter) ? [...new Set(d.starter)].filter((r) => roomIds.includes(r)).slice(0, 12) : fail('Starter rooms are missing.'))
        : json(h.starter, []);
      const joinRole = d.joinRole !== undefined ? oneOf(d.joinRole, roleIds.slice(1), 'That role') : h.join_role;
      db.run('UPDATE houses SET name = ?, mark = ?, about = ?, hue = ?, starter = ?, join_role = ? WHERE id = ?',
        name, [...name][0].toUpperCase(), about, hueV, JSON.stringify(starter), joinRole, houseId);
      hub.houseChanged(houseId);
      return {};
    },

    'house.leave'(c, d) {
      const houseId = id(d.house, 'house');
      member(c.user, houseId);
      const others = db.get('SELECT COUNT(*) n FROM members WHERE house = ? AND user != ?', houseId, c.user).n;
      if (others && M.isOwner(c.user, houseId)) {
        const ownerRole = db.get('SELECT id FROM roles WHERE house = ? ORDER BY pos LIMIT 1', houseId).id;
        const owners = db.get('SELECT COUNT(*) n FROM members WHERE house = ? AND role = ?', houseId, ownerRole).n;
        if (owners < 2) fail('You’re the only owner. Give someone else the owner role first, in House settings > Members.');
      }
      removeMember(houseId, c.user);
      return {};
    },

    'member.remove'(c, d) {
      const houseId = id(d.house, 'house');
      const target = id(d.user, 'person');
      need(c.user, houseId, 'roles', 'remove members');
      if (target === c.user) fail('To leave, use Leave house instead.');
      if (!M.isMember(houseId, target)) return {};
      if (M.isOwner(target, houseId) && !M.isOwner(c.user, houseId)) fail('Only an owner can remove another owner.');
      removeMember(houseId, target);
      return {};
    },

    'member.role'(c, d) {
      const houseId = id(d.house, 'house');
      const target = id(d.user, 'person');
      need(c.user, houseId, 'roles', 'change roles');
      if (target === c.user) fail('You can’t change your own role.');
      if (!M.isMember(houseId, target)) fail('That person isn’t in this house.');
      const roles = db.all('SELECT id FROM roles WHERE house = ? ORDER BY pos', houseId).map((r) => r.id);
      const role = oneOf(d.role, roles, 'That role');
      const touchesOwner = role === roles[0] || M.isOwner(target, houseId);
      if (touchesOwner && !M.isOwner(c.user, houseId)) fail('Only an owner can give or take away the owner role.');
      db.run('UPDATE members SET role = ? WHERE house = ? AND user = ?', role, houseId, target);
      hub.houseChanged(houseId);
      return {};
    },

    // Rooms
    'room.create'(c, d) {
      const houseId = id(d.house, 'house');
      need(c.user, houseId, 'rooms', 'create rooms');
      const name = str(d.name, { min: 1, max: 40, name: 'The name' });
      if (db.get('SELECT 1 FROM rooms WHERE house = ? AND lower(name) = lower(?)', houseId, name)) fail(`There’s already a room called ${name} in this house.`);
      const kind = oneOf(d.kind, KINDS, 'The kind of room');
      const topic = str(d.topic ?? '', { max: 80, name: 'What it’s for' });
      const grp = db.get('SELECT id FROM room_groups WHERE id = ? AND house = ?', d.group, houseId)?.id
        || db.get('SELECT id FROM room_groups WHERE house = ? ORDER BY pos LIMIT 1', houseId).id;
      const pos = (db.get('SELECT MAX(pos) p FROM rooms WHERE house = ?', houseId).p ?? -1) + 1;
      const rid = newId('r');
      db.run('INSERT INTO rooms (id, house, grp, name, kind, topic, pos) VALUES (?, ?, ?, ?, ?, ?, ?)', rid, houseId, grp, name, kind, topic, pos);
      hub.houseChanged(houseId);
      return { id: rid };
    },
    'room.update'(c, d) {
      const room = M.room(id(d.room, 'room')) || fail('That room doesn’t exist.');
      need(c.user, room.house, 'rooms', 'edit rooms');
      const name = d.name !== undefined ? str(d.name, { min: 1, max: 40, name: 'The name' }) : room.name;
      if (db.get('SELECT 1 FROM rooms WHERE house = ? AND lower(name) = lower(?) AND id != ?', room.house, name, room.id)) fail(`There’s already a room called ${name} in this house.`);
      const topic = d.topic !== undefined ? str(d.topic, { max: 80, name: 'What it’s for' }) : room.topic;
      db.run('UPDATE rooms SET name = ?, topic = ? WHERE id = ?', name, topic, room.id);
      hub.houseChanged(room.house);
      return {};
    },
    'room.delete'(c, d) {
      const room = M.room(id(d.room, 'room')) || fail('That room doesn’t exist.');
      need(c.user, room.house, 'rooms', 'delete rooms');
      hub.closeVoiceRoom(room.id);
      db.tx(() => {
        db.run('DELETE FROM messages WHERE conv = ? OR conv IN (SELECT id FROM threads WHERE conv = ?)', room.id, room.id);
        db.run('DELETE FROM threads WHERE conv = ?', room.id);
        db.run('DELETE FROM notify WHERE place = ?', room.id);
        db.run('DELETE FROM rooms WHERE id = ?', room.id);
        const h = houseOf(room.house);
        db.run('UPDATE houses SET starter = ? WHERE id = ?', JSON.stringify(json(h.starter, []).filter((r) => r !== room.id)), room.house);
      });
      hub.houseChanged(room.house);
      return {};
    },

    // Roles
    'role.create'(c, d) {
      const houseId = id(d.house, 'house');
      need(c.user, houseId, 'roles', 'manage roles');
      if (db.get('SELECT COUNT(*) n FROM roles WHERE house = ?', houseId).n >= 20) fail('A house can have up to 20 roles.');
      const rid = newId('role');
      const pos = db.get('SELECT MAX(pos) p FROM roles WHERE house = ?', houseId).p + 1;
      db.run('INSERT INTO roles (id, house, name, hue, perms, pos) VALUES (?, ?, ?, ?, ?, ?)', rid, houseId, 'New role', 180, JSON.stringify(['post']), pos);
      hub.houseChanged(houseId);
      return { id: rid };
    },
    'role.update'(c, d) {
      const houseId = id(d.house, 'house');
      need(c.user, houseId, 'roles', 'manage roles');
      const roles = db.all('SELECT * FROM roles WHERE house = ? ORDER BY pos', houseId);
      const role = roles.find((r) => r.id === d.role) || fail('That role doesn’t exist.');
      const isOwnerRole = role.id === roles[0].id;
      if (isOwnerRole && !M.isOwner(c.user, houseId)) fail('Only an owner can change the owner role.');
      const name = d.name !== undefined ? str(d.name, { min: 1, max: 24, name: 'The role name' }) : role.name;
      const hueV = d.hue === null ? null : d.hue !== undefined ? hue(d.hue) : role.hue;
      let perms = json(role.perms, []);
      if (d.perms !== undefined && !isOwnerRole) {
        if (!Array.isArray(d.perms)) fail('Permissions are missing.');
        perms = [...new Set(d.perms)].filter((p) => PERM_IDS.includes(p));
      }
      db.run('UPDATE roles SET name = ?, hue = ?, perms = ? WHERE id = ?', name, hueV, JSON.stringify(perms), role.id);
      hub.houseChanged(houseId);
      return {};
    },
    'role.delete'(c, d) {
      const houseId = id(d.house, 'house');
      need(c.user, houseId, 'roles', 'manage roles');
      const roles = db.all('SELECT id FROM roles WHERE house = ? ORDER BY pos', houseId).map((r) => r.id);
      const rid = oneOf(d.role, roles.slice(1), 'That role');
      if (roles.length <= 2) fail('A house needs an owner role and at least one other.');
      const h = houseOf(houseId);
      const rest = roles.filter((r) => r !== rid);
      const fallback = h.join_role && h.join_role !== rid ? h.join_role : rest[rest.length - 1];
      db.tx(() => {
        db.run('UPDATE members SET role = ? WHERE house = ? AND role = ?', fallback, houseId, rid);
        db.run('UPDATE houses SET join_role = ? WHERE id = ?', fallback, houseId);
        db.run('DELETE FROM roles WHERE id = ?', rid);
      });
      hub.houseChanged(houseId);
      return {};
    },

    // Invitations
    'invite.create'(c, d) {
      const houseId = id(d.house, 'house');
      need(c.user, houseId, 'invite', 'invite people');
      const code = randomBytes(9).toString('base64url');
      db.run('INSERT INTO invites (code, house, by, created, expires) VALUES (?, ?, ?, ?, ?)', code, houseId, c.user, Date.now(), Date.now() + 14 * 86_400_000);
      return { code, expires: Date.now() + 14 * 86_400_000 };
    },
    'invite.accept'(c, d) {
      const code = typeof d.code === 'string' && /^[\w-]{6,40}$/.test(d.code) ? d.code : fail('That invitation link isn’t valid.');
      const inv = db.get('SELECT * FROM invites WHERE code = ?', code);
      if (!inv || inv.expires < Date.now()) fail('That invitation has expired. Ask for a new link.');
      return join(c.user, inv.house);
    },
    'invite.join'(c, d) {
      const houseId = id(d.house, 'house');
      if (!db.get('SELECT 1 FROM personal_invites WHERE house = ? AND user = ?', houseId, c.user) && !M.isMember(houseId, c.user)) fail('That invitation is no longer open.');
      return join(c.user, houseId);
    },
    'invite.user'(c, d) {
      const houseId = id(d.house, 'house');
      need(c.user, houseId, 'invite', 'invite people');
      const handle = str(d.handle, { min: 1, max: 30, name: 'The username' }).replace(/^@/, '');
      const target = db.get('SELECT id, name FROM users WHERE handle = ?', handle);
      if (!target) fail(`Nobody is called @${handle}.`);
      if (M.isMember(houseId, target.id)) fail(`${target.name} is already in this house.`);
      db.run('INSERT OR REPLACE INTO personal_invites (house, user, by, ts) VALUES (?, ?, ?, ?)', houseId, target.id, c.user, Date.now());
      hub.sendInvites(target.id);
      return { name: target.name };
    },
    'invite.decline'(c, d) {
      db.run('DELETE FROM personal_invites WHERE house = ? AND user = ?', id(d.house, 'house'), c.user);
      hub.sendInvites(c.user);
      return {};
    },

    // Direct conversations: only with people you already share a house or conversation with.
    'dm.open'(c, d) {
      const others = [...new Set(Array.isArray(d.users) ? d.users : [])].filter((u) => u !== c.user);
      if (!others.length || others.length > 9) fail('Pick between one and nine people.');
      const contacts = new Set(M.contacts(c.user));
      for (const u of others) if (!contacts.has(id(u, 'person'))) fail('You can only message people you share a house with.');
      const want = [c.user, ...others].sort();
      const existing = db.all('SELECT dm FROM dm_members WHERE user = ?', c.user).map((r) => r.dm)
        .find((dm) => db.all('SELECT user FROM dm_members WHERE dm = ? ORDER BY user', dm).map((r) => r.user).join() === want.join());
      if (existing) return { id: existing };
      const dmId = newId('d');
      db.tx(() => {
        db.run('INSERT INTO dms (id, name, created) VALUES (?, NULL, ?)', dmId, Date.now());
        for (const u of [c.user, ...others]) db.run('INSERT INTO dm_members (dm, user) VALUES (?, ?)', dmId, u);
      });
      for (const u of want) hub.sendDm(u, dmId);
      return { id: dmId };
    },

    search(c, d) {
      const q = str(d.q ?? '', { max: 200, name: 'The search' });
      const hits = M.search(c.user, q);
      return { hits, users: hub.usersFor(hits.map((h) => h.m.author)), threads: hub.threadsFor(hits.map((h) => h.conv)) };
    },

    // Voice: membership and signalling. Audio itself flows peer to peer.
    'voice.join'(c, d) {
      const room = M.room(id(d.room, 'room')) || fail('That room doesn’t exist.');
      member(c.user, room.house);
      if (room.kind !== 'voice') fail('That isn’t a voice room.');
      return { peers: hub.voiceJoin(c, room) };
    },
    'voice.leave': (c) => { hub.voiceLeave(c.user); return {}; },
    'voice.state'(c, d) { hub.voiceState(c.user, { muted: bool(d.muted), deaf: bool(d.deaf) }); return {}; },
    rtc(c, d) {
      const to = id(d.to, 'person');
      const data = d.data;
      if (!data || typeof data !== 'object' || JSON.stringify(data).length > 64_000) fail('That signal isn’t valid.');
      if (!hub.rtcRelay(c.user, to, data)) fail('That person isn’t in your voice room.');
      return {};
    },
  };

  return ops;
}
