// Places, structure and community, on the server. Every rule is checked here
// against the database; what the browser shows is only a preview of it.
//
// - Room permissions: overrides per role and per member (see, send, join
//   voice, speak, manage) and private rooms. One resolver (js/lib/places.js
//   resolveRoom) answers every check: reading (M.canRead, M.audience,
//   M.readable, so search, history, files, push and live delivery all
//   follow), writing (M.postGate), voice (voice.join, voice.state), and
//   managing a room (room.update, room.delete, room.slowmode, webhooks,
//   follows, the stage).
// - More than one role per person (member_roles), role icons, "show
//   separately", mentionable, and role order.
// - Per-house nicknames and pictures.
// - Forum rooms: posts with a title and tags, each one a thread.
// - Notice rooms other houses can follow: new notices are copied into a room
//   the follower manages, with where they came from.
// - Stage rooms: speakers and an audience; hands up; moderators invite to
//   speak or move people back; a topic while it is live.
// - Webhooks: a secret address per hook that posts into one room.
// - The rail's folders and house order, per person, on every device.
// - Welcome and pick-your-interests (interests grant roles).
// - House templates, and copying a house's structure.
// - Insights for owners.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { limiter } from './auth.js';
import { newId, now } from './model.js';
import { PERMS } from '../js/lib/perms.js';
import { HUES } from '../js/lib/util.js';
import {
  resolveRoom, ROOM_PERM_IDS, ROOM_KINDS, VOICE_KINDS, PLACE_LIMITS as L, TEMPLATES, HUE_IDS, dayOf, railItems,
} from '../js/lib/places.js';

const json = (s, f) => { try { return s == null ? f : JSON.parse(s); } catch { return f; } };
const DAY = 86_400_000;
const NONE = Object.freeze({ view: false, send: false, connect: false, speak: false, manage: false });
const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️|⃣|[#*0-9])+$/u;
const MSG_ID = /^m_[a-z0-9]{8,40}$/;
// Roles an interest may hand out: none that can manage or moderate anything.
const MANAGING = ['rooms', 'roles', 'kick', 'ban', 'timeout', 'voicemod', 'audit', 'moderate', 'emoji', 'nicks'];
const sha = (s) => createHash('sha256').update(s).digest('hex');

// --- Schema (called from server/db.js migrate) ---------------------------
export function migratePlaces(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS room_overrides (
      room TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      target TEXT NOT NULL,
      allow TEXT NOT NULL DEFAULT '[]',
      deny TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (room, type, target)
    );
    CREATE TABLE IF NOT EXISTS member_roles (
      house TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
      user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      via TEXT NOT NULL DEFAULT 'manual',
      PRIMARY KEY (house, user, role)
    );
    CREATE TABLE IF NOT EXISTS member_profiles (
      house TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
      user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      nick TEXT,
      emoji TEXT,
      hue INTEGER,
      picks TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (house, user)
    );
    CREATE TABLE IF NOT EXISTS forum_posts (
      msg TEXT PRIMARY KEY,
      room TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS forum_posts_room ON forum_posts(room);
    CREATE TABLE IF NOT EXISTS hooks (
      id TEXT PRIMARY KEY,
      house TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
      room TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      bot TEXT NOT NULL,
      token TEXT,
      source TEXT,
      by TEXT NOT NULL,
      created INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS hooks_source ON hooks(source);
    CREATE INDEX IF NOT EXISTS hooks_room ON hooks(room);
    CREATE TABLE IF NOT EXISTS rails (
      user TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      layout TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS member_log (
      house TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
      user TEXT NOT NULL,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS member_log_house ON member_log(house, ts);`);
  const have = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c);
  const firstTime = !have('roles', 'hoist');
  // Names and types are fixed here, never from input.
  for (const [table, column, type] of [
    ['rooms', 'private', 'INTEGER NOT NULL DEFAULT 0'],
    ['rooms', 'tags', "TEXT NOT NULL DEFAULT '[]'"],
    ['rooms', 'tag_required', 'INTEGER NOT NULL DEFAULT 0'],
    ['roles', 'icon', 'TEXT'],
    ['roles', 'hoist', 'INTEGER NOT NULL DEFAULT 1'],
    ['roles', 'mentionable', 'INTEGER NOT NULL DEFAULT 1'],
    ['houses', 'welcome', "TEXT NOT NULL DEFAULT ''"],
    ['houses', 'interests', "TEXT NOT NULL DEFAULT '[]'"],
    ['messages', 'bot', 'TEXT'],
  ]) if (!have(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  // Changing your own nickname is a permission now; everyone had it before, so
  // every existing role keeps it (once, when this column first appears).
  if (firstTime) {
    for (const r of db.prepare('SELECT id, perms FROM roles').all()) {
      const p = json(r.perms, []);
      if (!p.includes('nick')) db.prepare('UPDATE roles SET perms = ? WHERE id = ?').run(JSON.stringify([...p, 'nick']), r.id);
    }
  }
}

export function createPlacesOps({ db, M, hub, fail, ops }) {
  // ---------- Input checks (the same rules as server/ops.js) ----------
  const str = (v, { max = 200, min = 0, name = 'This' } = {}) => {
    if (typeof v !== 'string') fail(`${name} is missing.`);
    const s = v.trim().replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
    if (s.length < min) fail(min === 1 ? `${name} can’t be empty.` : `${name} needs at least ${min} characters.`);
    if (s.length > max) fail(`${name} can be at most ${max} characters.`);
    return s;
  };
  const id = (v, name = 'id') => (typeof v === 'string' && /^[\w:.-]{1,80}$/.test(v) ? v : fail(`That ${name} isn’t valid.`));
  const bool = (v, name) => (typeof v === 'boolean' ? v : fail(`${name} is yes or no.`));
  const emojiOrNull = (v, name) => (v === null || v === '' ? null
    : typeof v === 'string' && v.length <= L.roleIcon && EMOJI.test(v) ? v : fail(`${name} can be one emoji.`));
  const hueOrNull = (v) => (v === null ? null : HUE_IDS.includes(v) ? v : fail('Pick one of the colours.'));
  const houseRow = (v) => db.get('SELECT * FROM houses WHERE id = ?', id(v, 'house')) || fail('That house doesn’t exist.');
  const roomRow = (v) => M.room(id(v, 'room')) || fail('That room doesn’t exist.');
  const member = (user, house) => (M.isMember(house, user) ? true : fail('You’re not a member of that house.'));
  const need = (user, house, perm, what) => { member(user, house); if (!M.can(user, house, perm)) fail(`Your role can’t ${what} in this house.`); };

  // ---------- Rate limits for everything here that writes or reaches people ----------
  const limits = {
    write: limiter({ capacity: 30, perSecond: 1 }),
    post: limiter({ capacity: 5, perSecond: 0.1 }),
    hooks: limiter({ capacity: 10, perSecond: 0.2 }),
    stage: limiter({ capacity: 20, perSecond: 1 }),
    create: limiter({ capacity: 3, perSecond: 1 / 60 }),
    onboard: limiter({ capacity: 10, perSecond: 0.2 }),
    insights: limiter({ capacity: 10, perSecond: 0.5 }),
  };
  (hub.extraLimits ||= []).push(...Object.values(limits));
  const slow = (bucket, key) => { if (!limits[bucket].take(key)) fail('You’re going a little fast. Wait a moment and try again.'); };

  // ---------- The permission resolver, fed from the database ----------
  const P = {};
  P.ownerRole = (house) => db.get('SELECT id FROM roles WHERE house = ? ORDER BY pos LIMIT 1', house)?.id;
  P.roleIds = (house, user) => {
    const m = db.get('SELECT role FROM members WHERE house = ? AND user = ?', house, user);
    if (!m) return [];
    return [m.role, ...db.all('SELECT role FROM member_roles WHERE house = ? AND user = ? AND role != ?', house, user, m.role).map((r) => r.role)];
  };
  P.housePerms = (house, roleIds) => {
    const out = new Set();
    if (!roleIds.length) return out;
    for (const r of db.all(`SELECT perms FROM roles WHERE house = ? AND id IN (${roleIds.map(() => '?').join(',')})`, house, ...roleIds)) json(r.perms, []).forEach((p) => out.add(p));
    return out;
  };
  P.overrides = (room) => db.all('SELECT type, target, allow, deny FROM room_overrides WHERE room = ?', room)
    .map((o) => ({ type: o.type, target: o.target, allow: json(o.allow, []), deny: json(o.deny, []) }));
  // A room anyone in the house can see without working anything out.
  P.restricted = (room) => !!room.private || !!db.get('SELECT 1 FROM room_overrides WHERE room = ? LIMIT 1', room.id);

  // What one person may do in one room.
  M.roomPerms = (user, roomOrId) => {
    const room = typeof roomOrId === 'string' ? M.room(roomOrId) : roomOrId;
    if (!room) return NONE;
    const roleIds = P.roleIds(room.house, user);
    if (!roleIds.length) return NONE;
    return resolveRoom({
      housePerms: P.housePerms(room.house, roleIds), owner: roleIds[0] === P.ownerRole(room.house),
      kind: room.kind, isPrivate: !!room.private, overrides: P.overrides(room.id), roleIds, userId: user,
    });
  };
  // Everyone in the house who can see a room, worked out in a few queries.
  P.viewers = (room) => {
    const owner = P.ownerRole(room.house);
    const rolePerms = new Map(db.all('SELECT id, perms FROM roles WHERE house = ?', room.house).map((r) => [r.id, json(r.perms, [])]));
    const roles = new Map(db.all('SELECT user, role FROM members WHERE house = ?', room.house).map((r) => [r.user, [r.role]]));
    for (const r of db.all('SELECT user, role FROM member_roles WHERE house = ?', room.house)) roles.get(r.user)?.push(r.role);
    const overrides = P.overrides(room.id);
    const out = new Set();
    for (const [user, roleIds] of roles) {
      const housePerms = new Set(roleIds.flatMap((r) => rolePerms.get(r) || []));
      if (resolveRoom({ housePerms, owner: roleIds[0] === owner, kind: room.kind, isPrivate: !!room.private, overrides, roleIds, userId: user }).view) out.add(user);
    }
    return out;
  };
  P.canView = (user, room) => !P.restricted(room) || M.roomPerms(user, room).view;
  // Rooms in this person's houses they may not see.
  P.hiddenFor = (user) => new Set(db.all(`SELECT r.* FROM rooms r JOIN members m ON m.house = r.house AND m.user = ?
    WHERE r.private = 1 OR EXISTS (SELECT 1 FROM room_overrides o WHERE o.room = r.id)`, user)
    .filter((r) => !M.roomPerms(user, r).view).map((r) => r.id));
  // Can everyone in the house see it (for following notices and previews)?
  P.open = (room) => !room.private && !db.all('SELECT deny FROM room_overrides WHERE room = ?', room.id).some((o) => json(o.deny, []).includes('view'));

  // House-wide permissions count every role a person has. While a room
  // manager acts on their own room, they act with the house's room rights.
  let grant = null;
  const baseCan = M.can;
  M.can = (user, houseId, perm) => {
    if (grant && grant.user === user && grant.house === houseId && grant.perm === perm) return true;
    if (baseCan(user, houseId, perm)) return true;
    return db.all('SELECT r.perms FROM member_roles mr JOIN roles r ON r.id = mr.role WHERE mr.house = ? AND mr.user = ?', houseId, user)
      .some((r) => json(r.perms, []).includes(perm));
  };
  const asManager = (user, room, fn) => {
    if (!M.roomPerms(user, room).manage) fail(`You can’t manage ${room.name}.`);
    if (M.can(user, room.house, 'rooms')) return fn();
    grant = { user, house: room.house, perm: 'rooms' };
    try { return fn(); } finally { grant = null; }
  };

  // Reading: a room's conversation and its threads need "see the room".
  const baseCanRead = M.canRead;
  M.canRead = (user, conv) => {
    if (!baseCanRead(user, conv)) return false;
    const w = M.where(conv);
    return !w?.room || P.canView(user, w.room);
  };
  const baseAudience = M.audience;
  M.audience = (conv) => {
    const list = baseAudience(conv);
    const w = M.where(conv);
    if (!w?.room || !P.restricted(w.room)) return list;
    const ok = P.viewers(w.room);
    return list.filter((u) => ok.has(u));
  };
  const baseReadable = M.readable;
  M.readable = (user) => {
    const hidden = P.hiddenFor(user);
    const list = baseReadable(user);
    if (!hidden.size) return list;
    return list.filter((c) => !hidden.has(c) && !(c.startsWith('t:') && hidden.has(M.thread(c)?.conv)));
  };

  // Writing. Forum rooms take posts only (forum.post), never plain messages.
  let forumSend = null;
  const basePostGate = M.postGate;
  M.postGate = (user, conv) => {
    const w = M.where(conv);
    if (!w?.room) return basePostGate(user, conv);
    if (!M.canRead(user, conv)) return { ok: false, why: 'You don’t have access to this conversation.' };
    const p = M.roomPerms(user, w.room);
    if (w.type === 'room') {
      if (w.room.kind === 'forum' && forumSend !== w.room.id) return { ok: false, why: `${w.room.name} is a forum. Start a post, or reply in a post’s thread.` };
      if (p.send) return { ok: true };
      // Same refusal as before overrides existed, when it says why best.
      const b = basePostGate(user, conv);
      if (!b.ok) return b;
      return { ok: false, why: `You can’t send messages in ${w.room.name}.` };
    }
    if (p.send || (w.room.kind === 'news' && M.can(user, w.house, 'post'))) return { ok: true };
    return { ok: false, why: `You can’t reply in ${w.room.name}.` };
  };

  // ---------- Messages: bots (webhooks, followed notices) and forum posts ----------
  const baseMsgView = M.msgView;
  M.msgView = (row, rx) => {
    const m = baseMsgView(row, rx);
    if (row.bot) m.bot = json(row.bot, null);
    const post = db.get('SELECT title, tags FROM forum_posts WHERE msg = ?', row.id);
    if (post) {
      const t = db.get('SELECT COUNT(*) n, MAX(ts) last FROM messages WHERE conv = ? AND deleted IS NULL', `t:${row.id}`);
      m.post = { title: post.title, tags: json(post.tags, []), replies: t.n, last: t.last || row.ts };
    }
    return m;
  };
  const msgEvent = (conv, mid) => {
    const [m] = M.withReactions([M.msg(mid)]);
    return { conv, m, user: hub.userView(m.author) };
  };
  // A message from a bot user (webhook or followed notices): stored, sent to
  // everyone who can read the room, and pushed like any other.
  function botPost(hook, conv, text, bot) {
    const mid = newId('m');
    const ts = now();
    db.run('INSERT INTO messages (id, conv, author, ts, text, fold, bot) VALUES (?, ?, ?, ?, ?, ?, ?)',
      mid, conv, hook.bot, ts, text, M.foldText(text, []), JSON.stringify(bot));
    hub.toConv(conv, 'msg', msgEvent(conv, mid));
    hub.hooks.message?.(conv, mid);
    return mid;
  }
  function botUser(name) {
    const uid = newId('u');
    const hue = HUES[Math.floor(Math.random() * HUES.length)][0];
    // '!' is never a valid password hash, so nobody can sign in as a bot.
    db.run('INSERT INTO users (id, handle, name, pass, hue, emoji, about, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      uid, `bot-${randomBytes(6).toString('hex')}`, name.slice(0, 40), '!', hue, '🤖', 'A bot. It posts for something outside Snug.', Date.now());
    return uid;
  }

  // ---------- What a house looks like, with all of the above ----------
  const stages = new Map(); // room -> { topic, speakers: Set, hands: Set }
  const inVoiceHere = (room, u) => hub.voicePlaceOf?.(u) === room;
  const stageOf = (room) => { if (!stages.has(room)) stages.set(room, { topic: '', speakers: new Set(), hands: new Set() }); return stages.get(room); };
  const stageView = (room) => {
    const s = stages.get(room);
    if (!s) return { topic: '', speakers: [], hands: [] };
    for (const u of [...s.speakers]) if (!inVoiceHere(room, u)) s.speakers.delete(u);
    for (const u of [...s.hands]) if (!inVoiceHere(room, u)) s.hands.delete(u);
    if (!s.speakers.size && !s.hands.size && !hub.inVoice([room])) s.topic = '';
    return { topic: s.topic, speakers: [...s.speakers], hands: [...s.hands] };
  };

  const baseHouseView = M.houseView;
  M.houseView = (houseId, viewer) => {
    const v = baseHouseView(houseId, viewer);
    if (!v) return v;
    const h = db.get('SELECT welcome, interests, join_role FROM houses WHERE id = ?', houseId);
    const joined = v.house.joined;
    const roleRows = Object.fromEntries(db.all('SELECT id, icon, hoist, mentionable FROM roles WHERE house = ?', houseId).map((r) => [r.id, r]));
    for (const r of v.house.roles) {
      const x = roleRows[r.id];
      r.icon = x?.icon || null; r.hoist = x ? !!x.hoist : true; r.mentionable = x ? !!x.mentionable : true;
    }
    const roomRows = db.all('SELECT * FROM rooms WHERE house = ?', houseId);
    const hidden = new Set();
    for (const room of roomRows) {
      const out = v.rooms[room.id];
      if (!out) continue;
      const restricted = P.restricted(room);
      let perms;
      if (joined) perms = M.roomPerms(viewer, room);
      else perms = resolveRoom({ housePerms: P.housePerms(houseId, [h.join_role].filter(Boolean)), kind: room.kind, isPrivate: !!room.private, overrides: P.overrides(room.id), roleIds: [h.join_role].filter(Boolean), userId: viewer });
      if (!perms.view) { hidden.add(room.id); delete v.rooms[room.id]; continue; }
      out.private = !!room.private;
      out.restricted = restricted;
      out.perms = perms;
      if (room.kind === 'forum') { out.tags = json(room.tags, []); out.tagRequired = !!room.tag_required; }
      if (joined && restricted) out.viewers = [...P.viewers(room)];
      if (joined && perms.manage) out.overrides = P.overrides(room.id);
      if (joined && room.kind === 'stage') out.stage = stageView(room.id);
    }
    if (hidden.size) {
      for (const g of v.house.groups) g.rooms = g.rooms.filter((r) => !hidden.has(r));
      v.house.starter = v.house.starter.filter((r) => !hidden.has(r));
      if (v.house.firstStep?.room && hidden.has(v.house.firstStep.room)) v.house.firstStep = undefined;
    }
    v.house.welcome = h.welcome || '';
    v.house.interests = json(h.interests, []);
    if (joined) {
      v.house.extra = {};
      for (const r of db.all('SELECT user, role FROM member_roles WHERE house = ?', houseId)) (v.house.extra[r.user] ||= []).push(r.role);
      v.house.profiles = {};
      for (const p of db.all('SELECT user, nick, emoji, hue FROM member_profiles WHERE house = ?', houseId)) {
        if (p.nick || p.emoji || p.hue != null) v.house.profiles[p.user] = { nick: p.nick || null, emoji: p.emoji || null, hue: p.hue ?? null };
      }
      v.house.picks = json(db.get('SELECT picks FROM member_profiles WHERE house = ? AND user = ?', houseId, viewer)?.picks, []);
    }
    return v;
  };

  // Discovery and previews show only the rooms everyone in the house can see.
  for (const name of ['discover', 'house.preview']) {
    const base = ops[name];
    ops[name] = (c, d) => {
      const r = base(c, d);
      const strip = (card) => {
        const shut = new Set(db.all('SELECT * FROM rooms WHERE house = ?', card.id).filter((x) => !P.open(x)).map((x) => x.name.toLowerCase()));
        if (shut.size) card.rooms = card.rooms.filter((x) => !shut.has(x.name.toLowerCase()));
        return card;
      };
      if (name === 'discover') r.houses = r.houses.map(strip); else strip(r);
      return r;
    };
  }

  // A permission or role change: everyone sees the house again, gets the
  // conversations they can now read, and leaves voice they may no longer join.
  function accessChanged(houseId) {
    hub.houseChanged(houseId);
    for (const r of db.all('SELECT user FROM members WHERE house = ?', houseId)) {
      hub.sendHouseContent(r.user, houseId);
      enforceVoice(r.user);
    }
  }
  // Someone in a voice room or stage they may no longer join is taken out;
  // someone who may not speak there is muted by the server.
  function enforceVoice(user) {
    const place = hub.voicePlaceOf?.(user);
    const room = place && M.room(place);
    if (!room || !VOICE_KINDS.includes(room.kind)) return;
    const p = M.roomPerms(user, room);
    if (!p.connect) { hub.toUser(user, 'voice.kicked', { room: room.id }); hub.voiceLeave(user); return; }
    const speaker = canSpeak(user, room, p);
    const vm = db.get('SELECT mute FROM voice_mod WHERE house = ? AND user = ?', room.house, user);
    if (!speaker) hub.voiceState(user, { smute: true, muted: true, camera: false, screen: false });
    else if (!vm?.mute && (room.kind === 'stage' || P.restricted(room))) hub.voiceState(user, { smute: false });
  }
  const canSpeak = (user, room, p = M.roomPerms(user, room)) => p.speak || (room.kind === 'stage' && !!stages.get(room.id)?.speakers.has(user));
  const stageChanged = (room) => hub.toUsers(M.audience(room), 'stage', { room, ...stageView(room) });

  // ---------- Wrapped ops ----------
  const wrap = (name, fn) => { const base = ops[name]; if (base) ops[name] = (c, d) => fn(c, d, base); };

  wrap('voice.join', (c, d, base) => {
    const room = typeof d.room === 'string' ? M.room(d.room) : null;
    if (room && M.isMember(room.house, c.user)) {
      const p = M.roomPerms(c.user, room);
      if (!p.view) fail('That room doesn’t exist.');
      if (VOICE_KINDS.includes(room.kind) && !p.connect) fail(`You can’t join ${room.name}.`);
    }
    const r = base(c, d);
    if (room) { enforceVoice(c.user); if (room.kind === 'stage') stageChanged(room.id); }
    return r;
  });
  wrap('voice.state', (c, d, base) => {
    const place = hub.voicePlaceOf?.(c.user);
    const room = place && M.room(place);
    if (room && VOICE_KINDS.includes(room.kind) && !canSpeak(c.user, room)) {
      if (d.muted === false || d.camera === true || d.screen === true) fail(room.kind === 'stage' ? 'You’re in the audience. Raise your hand to ask to speak.' : `You can’t speak in ${room.name}.`);
    }
    return base(c, d);
  });
  wrap('voice.leave', (c, d, base) => {
    const place = hub.voicePlaceOf?.(c.user);
    const r = base(c, d);
    if (place && M.room(place)?.kind === 'stage') stageChanged(place);
    return r;
  });
  // A moderator's unmute never makes an audience member a speaker.
  wrap('mod.voice', (c, d, base) => { const r = base(c, d); if (typeof d.user === 'string') enforceVoice(d.user); return r; });

  // Managing one room: house-wide "Manage rooms", or "Manage the room" on it.
  for (const name of ['room.update', 'room.delete', 'room.slowmode']) {
    wrap(name, (c, d, base) => {
      const room = M.room(typeof d.room === 'string' ? d.room : '');
      // Without "Manage the room" here the base op refuses in its own words.
      if (!room || !M.isMember(room.house, c.user) || !M.roomPerms(c.user, room).manage) return base(c, d);
      return asManager(c.user, room, () => {
        const r = base(c, d);
        if (name === 'room.delete') db.run("DELETE FROM hooks WHERE source = ? AND kind = 'follow'", room.id);
        return r;
      });
    });
  }
  // New rooms: forums and stages too.
  wrap('room.create', (c, d, base) => {
    if (d.kind !== undefined && !ROOM_KINDS.includes(d.kind)) fail('The kind of room isn’t one of the choices.');
    if (d.group === undefined) d = { ...d, group: null }; // no group: the house's first
    const r = base(c, d);
    if (d.private === true && r?.id) {
      db.run('UPDATE rooms SET private = 1 WHERE id = ?', r.id);
      accessChanged(M.room(r.id).house);
    }
    return r;
  });

  // Messages in notice rooms go on to the rooms that follow them.
  wrap('msg.send', (c, d, base) => {
    const fresh = typeof d.id === 'string' && !M.msg(d.id);
    const r = base(c, d);
    if (fresh && r?.m && typeof d.conv === 'string') {
      const room = M.room(d.conv);
      if (room?.kind === 'news' && P.open(room)) {
        const house = db.get('SELECT name FROM houses WHERE id = ?', room.house)?.name || 'A house';
        const text = r.m.text || (r.m.files?.length ? `(${r.m.files.length === 1 ? 'An attachment' : `${r.m.files.length} attachments`} in ${house})` : '');
        if (text) {
          for (const hook of db.all("SELECT * FROM hooks WHERE source = ? AND kind = 'follow'", room.id)) {
            botPost(hook, hook.room, text, { name: hook.name, hook: hook.id, follow: { house, room: room.name } });
          }
        }
      }
    }
    return r;
  });

  // Joining and leaving, for insights; leaving drops extra roles and nicknames.
  for (const name of ['invite.accept', 'invite.join', 'house.joinPublic']) {
    wrap(name, (c, d, base) => {
      const before = new Set(M.houseIdsOf(c.user));
      const r = base(c, d);
      const house = r?.house;
      if (house && !before.has(house) && M.isMember(house, c.user)) db.run("INSERT INTO member_log (house, user, ts, kind) VALUES (?, ?, ?, 'join')", house, c.user, Date.now());
      return r;
    });
  }
  for (const name of ['house.leave', 'member.remove', 'mod.kick', 'mod.ban']) {
    wrap(name, (c, d, base) => {
      const house = typeof d.house === 'string' ? d.house : null;
      const target = name === 'house.leave' ? c.user : typeof d.user === 'string' ? d.user : null;
      const was = house && target && M.isMember(house, target);
      const r = base(c, d);
      if (was && !M.isMember(house, target) && db.get('SELECT 1 FROM houses WHERE id = ?', house)) {
        db.run("INSERT INTO member_log (house, user, ts, kind) VALUES (?, ?, ?, 'leave')", house, target, Date.now());
        db.run('DELETE FROM member_roles WHERE house = ? AND user = ?', house, target);
        db.run('DELETE FROM member_profiles WHERE house = ? AND user = ?', house, target);
        db.run("DELETE FROM room_overrides WHERE type = 'member' AND target = ? AND room IN (SELECT id FROM rooms WHERE house = ?)", target, house);
      }
      return r;
    });
  }

  // Roles: icons, "show separately", mentionable, and names in theme-safe colours.
  wrap('role.update', (c, d, base) => {
    if (d.hue !== undefined && d.hue !== null && !HUE_IDS.includes(d.hue)) fail('Pick one of the colours.');
    const icon = d.icon !== undefined ? emojiOrNull(d.icon, 'A role’s icon') : undefined;
    const hoist = d.hoist !== undefined ? bool(d.hoist, 'Show separately') : undefined;
    const mentionable = d.mentionable !== undefined ? bool(d.mentionable, 'Mentionable') : undefined;
    const r = base(c, d);
    if (icon !== undefined || hoist !== undefined || mentionable !== undefined) {
      const row = db.get('SELECT * FROM roles WHERE id = ? AND house = ?', d.role, d.house);
      db.run('UPDATE roles SET icon = ?, hoist = ?, mentionable = ? WHERE id = ?',
        icon !== undefined ? icon : row.icon, hoist !== undefined ? (hoist ? 1 : 0) : row.hoist, mentionable !== undefined ? (mentionable ? 1 : 0) : row.mentionable, row.id);
      hub.houseChanged(d.house);
    }
    if (d.perms !== undefined) accessChanged(d.house);
    return r;
  });
  wrap('role.delete', (c, d, base) => { const r = base(c, d); accessChanged(d.house); return r; });
  wrap('member.role', (c, d, base) => { const r = base(c, d); accessChanged(d.house); return r; });
  // New houses give members their own nickname.
  wrap('house.create', (c, d, base) => {
    if (d.template !== undefined || d.from !== undefined) return createFrom(c, d);
    const r = base(c, d);
    for (const role of db.all('SELECT id, perms FROM roles WHERE house = ? AND pos > 0', r.house)) {
      const p = json(role.perms, []);
      if (!p.includes('nick')) db.run('UPDATE roles SET perms = ? WHERE id = ?', JSON.stringify([...p, 'nick']), role.id);
    }
    hub.sendHouse(c.user, r.house);
    return r;
  });

  // The rank a person acts with: their best role's position (owner is 0).
  const rankOf = (house, user) => Math.min(...P.roleIds(house, user).map((r) => db.get('SELECT pos FROM roles WHERE id = ?', r)?.pos ?? 999));
  const orderedRoles = (house) => db.all('SELECT * FROM roles WHERE house = ? ORDER BY pos', house);

  // ---------- Templates and copying a house ----------
  function createFrom(c, d) {
    slow('create', c.user);
    const name = str(d.name, { min: 1, max: 40, name: 'The name' });
    const hue = Number.isInteger(d.hue) && d.hue >= 0 && d.hue < 360 ? d.hue : fail('Pick one of the colours.');
    let plan;
    if (d.template !== undefined) {
      const t = TEMPLATES.find((x) => x.id === d.template) || fail('That template isn’t one of the choices.');
      plan = {
        about: t.about,
        roles: t.roles.map((r) => ({ key: r.key, name: r.name, hue: r.hue, perms: [...r.perms, 'nick'], icon: r.icon || null, hoist: true, mentionable: true })),
        groups: t.groups.map((g) => ({ name: g.name, rooms: g.rooms.map(([n, kind, topic, x = {}]) => ({
          name: n, kind, topic, tags: (x.tags || []).map((tn) => ({ id: newId('tg'), name: tn })), required: !!x.required,
          private: !!x.only, overrides: (x.only || []).map((k) => ({ type: 'role', target: k, allow: ['view'], deny: [] })),
        })) })),
        welcome: '', interests: [],
      };
    } else {
      const src = houseRow(d.from);
      need(c.user, src.id, 'roles', 'copy this house');
      const roles = orderedRoles(src.id);
      const hiddenRooms = P.hiddenFor(c.user);
      plan = {
        about: src.about,
        roles: roles.slice(1).map((r) => ({ key: r.id, name: r.name, hue: r.hue, perms: json(r.perms, []), icon: r.icon, hoist: !!r.hoist, mentionable: !!r.mentionable })),
        groups: db.all('SELECT * FROM room_groups WHERE house = ? ORDER BY pos', src.id).map((g) => ({
          name: g.name,
          rooms: db.all('SELECT * FROM rooms WHERE grp = ? ORDER BY pos', g.id).filter((r) => !hiddenRooms.has(r.id)).map((r) => ({
            name: r.name, kind: r.kind, topic: r.topic, tags: json(r.tags, []), required: !!r.tag_required, private: !!r.private,
            overrides: P.overrides(r.id).filter((o) => o.type !== 'member').map((o) => ({ ...o, target: o.type === 'everyone' ? o.target : o.target === roles[0].id ? null : o.target })).filter((o) => o.target),
          })),
        })),
        welcome: src.welcome || '',
        interests: json(src.interests, []),
        ownerName: roles[0].name,
      };
    }
    const hid = newId('h'), owner = newId('role');
    const keyToRole = Object.fromEntries(plan.roles.map((r) => [r.key, newId('role')]));
    const t = Date.now();
    let firstText = null;
    const starter = [];
    db.tx(() => {
      db.run('INSERT INTO houses (id, name, mark, hue, about, join_role, starter, created, welcome, interests) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        hid, name, [...name][0].toUpperCase(), hue, plan.about || '', keyToRole[plan.roles[plan.roles.length - 1]?.key] || null, '[]', t, plan.welcome,
        JSON.stringify(plan.interests.map((i) => ({ ...i, roles: (i.roles || []).map((r) => keyToRole[r]).filter(Boolean) }))));
      db.run('INSERT INTO roles (id, house, name, hue, perms, pos) VALUES (?, ?, ?, ?, ?, 0)', owner, hid, plan.ownerName || 'Owner', hue, JSON.stringify(PERMS.map((p) => p.id)));
      plan.roles.forEach((r, i) => db.run('INSERT INTO roles (id, house, name, hue, perms, pos, icon, hoist, mentionable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        keyToRole[r.key], hid, r.name, r.hue, JSON.stringify(r.perms), i + 1, r.icon || null, r.hoist ? 1 : 0, r.mentionable ? 1 : 0));
      if (!plan.roles.length) {
        const m = newId('role');
        db.run("INSERT INTO roles (id, house, name, hue, perms, pos) VALUES (?, ?, 'Member', NULL, ?, 1)", m, hid, JSON.stringify(['post', 'invite', 'nick']));
        db.run('UPDATE houses SET join_role = ? WHERE id = ?', m, hid);
      }
      db.run('INSERT INTO members (house, user, role, newcomer, joined) VALUES (?, ?, ?, 0, ?)', hid, c.user, owner, t);
      let pos = 0;
      plan.groups.forEach((g, gi) => {
        const gid = newId('g');
        db.run('INSERT INTO room_groups (id, house, name, pos) VALUES (?, ?, ?, ?)', gid, hid, g.name, gi);
        for (const r of g.rooms) {
          const rid = newId('r');
          db.run('INSERT INTO rooms (id, house, grp, name, kind, topic, pos, private, tags, tag_required) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            rid, hid, gid, r.name, r.kind, r.topic || '', pos++, r.private ? 1 : 0, JSON.stringify(r.tags || []), r.required ? 1 : 0);
          for (const o of r.overrides || []) {
            const target = o.type === 'everyone' ? o.target : keyToRole[o.target];
            if (target) db.run('INSERT OR IGNORE INTO room_overrides (room, type, target, allow, deny) VALUES (?, ?, ?, ?, ?)', rid, o.type, target, JSON.stringify(o.allow), JSON.stringify(o.deny));
          }
          if (!r.private && starter.length < 3 && ['text', 'news', 'forum'].includes(r.kind)) starter.push(rid);
          if (!firstText && r.kind === 'text' && !r.private) firstText = rid;
        }
      });
      db.run('UPDATE houses SET starter = ? WHERE id = ?', JSON.stringify(starter), hid);
      db.run("INSERT INTO member_log (house, user, ts, kind) VALUES (?, ?, ?, 'join')", hid, c.user, t);
    });
    hub.sendHouseContent(c.user, hid);
    return { house: hid, room: firstText || starter[0] || null };
  }

  // ---------- New ops ----------
  const out = {};

  // Room privacy and overrides. type: 'everyone' | 'role' | 'member'.
  out['room.private'] = (c, d) => {
    const room = roomRow(d.room);
    asManager(c.user, room, () => {});
    slow('write', c.user);
    db.run('UPDATE rooms SET private = ? WHERE id = ?', bool(d.on, 'Private') ? 1 : 0, room.id);
    accessChanged(room.house);
    return {};
  };
  out['room.override'] = (c, d) => {
    const room = roomRow(d.room);
    asManager(c.user, room, () => {});
    slow('write', c.user);
    const type = ['everyone', 'role', 'member'].includes(d.type) ? d.type : fail('That kind of override isn’t one of the choices.');
    let target;
    if (type === 'everyone') target = '*';
    else if (type === 'role') {
      target = id(d.target, 'role');
      const role = db.get('SELECT id, pos FROM roles WHERE id = ? AND house = ?', target, room.house) || fail('That role isn’t in this house.');
      if (role.pos === 0) fail('The owner role can always do everything.');
    } else {
      target = id(d.target, 'person');
      if (!M.isMember(room.house, target)) fail('That person isn’t in this house.');
    }
    const clean = (v, name) => {
      if (v === undefined) return [];
      if (!Array.isArray(v) || v.length > ROOM_PERM_IDS.length) fail(`${name} isn’t valid.`);
      return [...new Set(v)].map((p) => (ROOM_PERM_IDS.includes(p) ? p : fail(`${name} has a permission that doesn’t exist.`)));
    };
    const allow = clean(d.allow, 'Allow');
    const deny = clean(d.deny, 'Deny').filter((p) => !allow.includes(p));
    if (!allow.length && !deny.length) db.run('DELETE FROM room_overrides WHERE room = ? AND type = ? AND target = ?', room.id, type, target);
    else {
      if (!db.get('SELECT 1 FROM room_overrides WHERE room = ? AND type = ? AND target = ?', room.id, type, target)
        && db.get('SELECT COUNT(*) n FROM room_overrides WHERE room = ?', room.id).n >= L.overrides) fail(`A room can have up to ${L.overrides} overrides.`);
      db.run(`INSERT INTO room_overrides (room, type, target, allow, deny) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (room, type, target) DO UPDATE SET allow = excluded.allow, deny = excluded.deny`, room.id, type, target, JSON.stringify(allow), JSON.stringify(deny));
    }
    accessChanged(room.house);
    return {};
  };
  // What someone can do in a room, for the access editor's preview.
  out['room.perms'] = (c, d) => {
    const room = roomRow(d.room);
    member(c.user, room.house);
    if (!M.roomPerms(c.user, room).manage) fail(`You can’t manage ${room.name}.`);
    const user = id(d.user, 'person');
    return { perms: M.roomPerms(user, room) };
  };

  // Roles: order (drag or keys) and extra roles per person.
  out['role.move'] = (c, d) => {
    const house = houseRow(d.house).id;
    need(c.user, house, 'roles', 'manage roles');
    slow('write', c.user);
    const roles = orderedRoles(house);
    const role = roles.find((r) => r.id === d.role) || fail('That role doesn’t exist.');
    const index = Number.isInteger(d.index) ? d.index : fail('Where to isn’t valid.');
    if (role.pos === 0 || index < 1) fail('The owner role always comes first.');
    const owner = M.isOwner(c.user, house);
    const mine = rankOf(house, c.user);
    if (!owner && (role.pos <= mine || index <= mine)) fail('You can only move roles below your own.');
    const ids = roles.map((r) => r.id).filter((r) => r !== role.id);
    ids.splice(Math.min(index, ids.length), 0, role.id);
    db.tx(() => ids.forEach((r, i) => db.run('UPDATE roles SET pos = ? WHERE id = ?', i, r)));
    hub.houseChanged(house);
    return {};
  };
  out['member.roles'] = (c, d) => {
    const house = houseRow(d.house).id;
    need(c.user, house, 'roles', 'change roles');
    slow('write', c.user);
    const target = id(d.user, 'person');
    if (!M.isMember(house, target)) fail('That person isn’t in this house.');
    if (!Array.isArray(d.roles) || d.roles.length > 20) fail('Roles are missing.');
    const roles = orderedRoles(house);
    const primary = db.get('SELECT role FROM members WHERE house = ? AND user = ?', house, target).role;
    const want = [...new Set(d.roles)].map((r) => roles.find((x) => x.id === r) || fail('That role isn’t in this house.'));
    if (want.some((r) => r.pos === 0)) fail('The owner role is given in Members, by an owner.');
    const owner = M.isOwner(c.user, house);
    const mine = rankOf(house, c.user);
    const have = db.all('SELECT role FROM member_roles WHERE house = ? AND user = ?', house, target).map((r) => r.role);
    const changed = [...want.map((r) => r.id).filter((r) => !have.includes(r)), ...have.filter((r) => !want.some((x) => x.id === r))];
    if (!owner && changed.some((r) => (roles.find((x) => x.id === r)?.pos ?? 0) <= mine)) fail('You can only give or take roles below your own.');
    db.tx(() => {
      db.run('DELETE FROM member_roles WHERE house = ? AND user = ?', house, target);
      for (const r of want) if (r.id !== primary) db.run("INSERT INTO member_roles (house, user, role, via) VALUES (?, ?, ?, 'manual')", house, target, r.id);
    });
    accessChanged(house);
    return {};
  };

  // Per-house nickname and picture. Your own needs "Change nickname";
  // someone else's needs "Manage nicknames" and a role above theirs.
  out['member.profile'] = (c, d) => {
    const house = houseRow(d.house).id;
    member(c.user, house);
    slow('write', c.user);
    const target = d.user === undefined ? c.user : id(d.user, 'person');
    if (!M.isMember(house, target)) fail('That person isn’t in this house.');
    if (target === c.user) { if (!M.can(c.user, house, 'nick')) fail('Your role can’t change its nickname in this house.'); }
    else {
      if (!M.can(c.user, house, 'nicks')) fail('Your role can’t change other people’s nicknames in this house.');
      if (M.isOwner(target, house) || (!M.isOwner(c.user, house) && rankOf(house, target) <= rankOf(house, c.user))) fail('You can only change nicknames of people below your role.');
    }
    const row = db.get('SELECT * FROM member_profiles WHERE house = ? AND user = ?', house, target) || {};
    const nick = d.nick === undefined ? row.nick ?? null : d.nick === null || d.nick === '' ? null : str(d.nick, { max: L.nick, name: 'A nickname' }) || null;
    const emoji = d.emoji === undefined ? row.emoji ?? null : emojiOrNull(d.emoji, 'A picture');
    const hue = d.hue === undefined ? row.hue ?? null : hueOrNull(d.hue);
    db.run(`INSERT INTO member_profiles (house, user, nick, emoji, hue) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (house, user) DO UPDATE SET nick = excluded.nick, emoji = excluded.emoji, hue = excluded.hue`, house, target, nick, emoji, hue);
    hub.houseChanged(house);
    return {};
  };

  // Forum rooms.
  const tagsOf = (room) => json(room.tags, []);
  const pickTags = (room, v) => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > L.postTags) fail(`A post can have up to ${L.postTags} tags.`);
    const known = tagsOf(room).map((t) => t.id);
    return [...new Set(v)].map((t) => (known.includes(t) ? t : fail('That tag isn’t one of this forum’s.')));
  };
  out['forum.post'] = (c, d) => {
    const room = roomRow(d.room);
    if (room.kind !== 'forum') fail('Posts go in forum rooms.');
    const mid = typeof d.id === 'string' && MSG_ID.test(d.id) ? d.id : fail('That message id isn’t valid.');
    if (M.msg(mid)) { const row = M.msg(mid); if (row.author !== c.user || row.conv !== room.id) fail('That message id is already taken.'); return { m: M.withReactions([row])[0] }; }
    if (!M.canRead(c.user, room.id)) fail('You don’t have access to this conversation.');
    if (!M.roomPerms(c.user, room).send) fail(`You can’t post in ${room.name}.`);
    const title = str(d.title, { min: 1, max: L.postTitle, name: 'The title' });
    const tags = pickTags(room, d.tags);
    if (room.tag_required && !tags.length) fail(`Pick at least one tag. ${room.name} asks for one.`);
    slow('post', c.user);
    const body = typeof d.text === 'string' ? d.text : '';
    forumSend = room.id;
    let r;
    try { r = ops['msg.send'](c, { conv: room.id, id: mid, text: body.trim() ? body : title, files: d.files }); } finally { forumSend = null; }
    db.tx(() => {
      db.run('INSERT OR IGNORE INTO forum_posts (msg, room, title, tags) VALUES (?, ?, ?, ?)', mid, room.id, title, JSON.stringify(tags));
      db.run('INSERT OR IGNORE INTO threads (id, conv, root) VALUES (?, ?, ?)', `t:${mid}`, room.id, mid);
      db.run('INSERT OR IGNORE INTO follows (user, thread) VALUES (?, ?)', c.user, `t:${mid}`);
    });
    const ev = msgEvent(room.id, mid);
    ev.thread = undefined;
    hub.toConv(room.id, 'msg', ev);
    hub.toConv(room.id, 'forum.thread', { id: `t:${mid}`, conv: room.id, root: mid });
    hub.sendSelf(c.user, { follow: { [`t:${mid}`]: true } });
    return { m: ev.m };
  };
  out['forum.edit'] = (c, d) => {
    const row = M.liveMsg(id(d.id, 'message')) || fail('That post was deleted.');
    const post = db.get('SELECT * FROM forum_posts WHERE msg = ?', row.id) || fail('That isn’t a post.');
    const room = M.room(post.room);
    if (!M.canRead(c.user, room.id)) fail('You don’t have access to this conversation.');
    if (row.author !== c.user && !M.roomPerms(c.user, room).manage) fail('You can only change your own posts.');
    slow('write', c.user);
    const title = d.title !== undefined ? str(d.title, { min: 1, max: L.postTitle, name: 'The title' }) : post.title;
    const tags = d.tags !== undefined ? pickTags(room, d.tags) : json(post.tags, []);
    if (room.tag_required && !tags.length) fail(`Pick at least one tag. ${room.name} asks for one.`);
    db.run('UPDATE forum_posts SET title = ?, tags = ? WHERE msg = ?', title, JSON.stringify(tags), row.id);
    hub.toConv(room.id, 'msg', msgEvent(room.id, row.id));
    return {};
  };
  out['forum.tags'] = (c, d) => {
    const room = roomRow(d.room);
    if (room.kind !== 'forum') fail('Tags belong to forum rooms.');
    asManager(c.user, room, () => {});
    slow('write', c.user);
    if (!Array.isArray(d.tags) || d.tags.length > L.tags) fail(`A forum can have up to ${L.tags} tags.`);
    const seen = new Set();
    const tags = d.tags.map((t) => {
      if (!t || typeof t !== 'object') fail('That tag isn’t valid.');
      const name = str(t.name, { min: 1, max: L.tagName, name: 'A tag' });
      if (seen.has(name.toLowerCase())) fail(`There are two tags called ${name}.`);
      seen.add(name.toLowerCase());
      const tid = typeof t.id === 'string' && /^tg_[a-z0-9]{4,30}$/.test(t.id) ? t.id : newId('tg');
      const emoji = t.emoji ? emojiOrNull(t.emoji, 'A tag’s emoji') : null;
      return emoji ? { id: tid, name, emoji } : { id: tid, name };
    });
    const required = d.required !== undefined ? bool(d.required, 'Required') : !!room.tag_required;
    db.run('UPDATE rooms SET tags = ?, tag_required = ? WHERE id = ?', JSON.stringify(tags), required && tags.length ? 1 : 0, room.id);
    hub.houseChanged(room.house);
    return { tags };
  };

  // Stage rooms. The people who run a stage (Manage the room) invite
  // speakers; people who may speak there step up themselves.
  const stageRoom = (v, user) => {
    const room = roomRow(v);
    if (room.kind !== 'stage' || !M.canRead(user, room.id)) fail('That isn’t a stage.');
    return room;
  };
  out['stage.hand'] = (c, d) => {
    const room = stageRoom(d.room, c.user);
    if (!inVoiceHere(room.id, c.user)) fail('Join the stage first.');
    slow('stage', c.user);
    const s = stageOf(room.id);
    if (bool(d.up, 'Hand up') && !canSpeak(c.user, room)) s.hands.add(c.user); else s.hands.delete(c.user);
    stageChanged(room.id);
    return {};
  };
  out['stage.invite'] = (c, d) => {
    const room = stageRoom(d.room, c.user);
    if (!M.roomPerms(c.user, room).manage) fail('Only the people who run this stage can invite speakers.');
    slow('stage', c.user);
    const target = id(d.user, 'person');
    if (!inVoiceHere(room.id, target)) fail('They’ve left the stage.');
    const s = stageOf(room.id);
    s.speakers.add(target);
    s.hands.delete(target);
    enforceVoice(target);
    stageChanged(room.id);
    return {};
  };
  out['stage.audience'] = (c, d) => {
    const room = stageRoom(d.room, c.user);
    const target = d.user === undefined ? c.user : id(d.user, 'person');
    if (target !== c.user && !M.roomPerms(c.user, room).manage) fail('Only the people who run this stage can move speakers.');
    slow('stage', c.user);
    stageOf(room.id).speakers.delete(target);
    if (inVoiceHere(room.id, target)) {
      // Someone who may always speak here just goes quiet; anyone else is muted by the server.
      if (M.roomPerms(target, room).speak) hub.voiceState(target, { muted: true, camera: false, screen: false });
      else enforceVoice(target);
    }
    stageChanged(room.id);
    return {};
  };
  // Step up yourself, if you may speak here without an invitation.
  out['stage.speak'] = (c, d) => {
    const room = stageRoom(d.room, c.user);
    if (!inVoiceHere(room.id, c.user)) fail('Join the stage first.');
    if (!M.roomPerms(c.user, room).speak) fail('Raise your hand to ask to speak.');
    slow('stage', c.user);
    const s = stageOf(room.id);
    s.speakers.add(c.user);
    s.hands.delete(c.user);
    enforceVoice(c.user);
    stageChanged(room.id);
    return {};
  };
  out['stage.topic'] = (c, d) => {
    const room = stageRoom(d.room, c.user);
    if (!M.roomPerms(c.user, room).manage) fail('Only the people who run this stage can set its topic.');
    slow('stage', c.user);
    stageOf(room.id).topic = str(d.topic ?? '', { max: L.stageTopic, name: 'The topic' });
    stageChanged(room.id);
    return {};
  };

  // Webhooks.
  const hookRow = (v) => db.get('SELECT * FROM hooks WHERE id = ?', id(v, 'webhook')) || fail('That webhook doesn’t exist.');
  const hookView = (h) => ({
    id: h.id, kind: h.kind, name: h.name, room: h.room, by: h.by, created: h.created, bot: h.bot,
    ...(h.kind === 'follow' ? { source: (() => { const r = M.room(h.source); return r ? { room: r.name, house: db.get('SELECT name FROM houses WHERE id = ?', r.house)?.name } : null; })() } : {}),
  });
  const newToken = () => randomBytes(24).toString('base64url');
  out['hook.create'] = (c, d) => {
    const room = roomRow(d.room);
    asManager(c.user, room, () => {});
    if (!['text', 'news'].includes(room.kind)) fail('Webhooks post into conversation and notice rooms.');
    slow('hooks', c.user);
    const name = str(d.name ?? 'Webhook', { min: 1, max: L.hookName, name: 'The name' });
    if (db.get("SELECT COUNT(*) n FROM hooks WHERE room = ? AND kind = 'webhook'", room.id).n >= L.hooksPerRoom) fail(`A room can have up to ${L.hooksPerRoom} webhooks.`);
    const hid = newId('wh');
    const token = newToken();
    db.run("INSERT INTO hooks (id, house, room, kind, name, bot, token, by, created) VALUES (?, ?, ?, 'webhook', ?, ?, ?, ?, ?)",
      hid, room.house, room.id, name, botUser(name), sha(token), c.user, Date.now());
    return { hook: hookView(hookRow(hid)), url: `/api/hooks/${hid}/${token}` };
  };
  out['hook.list'] = (c, d) => {
    const room = roomRow(d.room);
    asManager(c.user, room, () => {});
    return { hooks: db.all('SELECT * FROM hooks WHERE room = ? ORDER BY created', room.id).map(hookView) };
  };
  out['hook.regen'] = (c, d) => {
    const h = hookRow(d.hook);
    if (h.kind !== 'webhook') fail('Only webhooks have an address.');
    asManager(c.user, M.room(h.room), () => {});
    slow('hooks', c.user);
    const token = newToken();
    db.run('UPDATE hooks SET token = ? WHERE id = ?', sha(token), h.id);
    return { url: `/api/hooks/${h.id}/${token}` };
  };
  out['hook.delete'] = (c, d) => {
    const h = db.get('SELECT * FROM hooks WHERE id = ?', id(d.hook, 'webhook'));
    if (!h) return {};
    asManager(c.user, M.room(h.room), () => {});
    slow('hooks', c.user);
    db.run('DELETE FROM hooks WHERE id = ?', h.id);
    return {};
  };

  // Following a notice room into a room you manage in another house.
  out['news.follow'] = (c, d) => {
    const source = roomRow(d.source);
    const target = roomRow(d.target);
    if (source.kind !== 'news') fail('Only notice rooms can be followed.');
    if (!M.canRead(c.user, source.id)) fail('That room doesn’t exist.');
    if (!P.open(source)) fail(`${source.name} is private, so it can’t be followed.`);
    if (source.house === target.house) fail('Pick a room in another house.');
    if (!['text', 'news'].includes(target.kind)) fail('Notices can go into a conversation or notice room.');
    asManager(c.user, target, () => {});
    slow('hooks', c.user);
    if (db.get("SELECT 1 FROM hooks WHERE source = ? AND room = ? AND kind = 'follow'", source.id, target.id)) fail(`${target.name} already follows ${source.name}.`);
    if (db.get("SELECT COUNT(*) n FROM hooks WHERE room = ? AND kind = 'follow'", target.id).n >= L.followsPerRoom) fail(`A room can follow up to ${L.followsPerRoom} notice rooms.`);
    if (db.get("SELECT COUNT(*) n FROM hooks WHERE source = ? AND kind = 'follow'", source.id).n >= 50) fail('That room has as many followers as it can take.');
    const houseName = db.get('SELECT name FROM houses WHERE id = ?', source.house).name;
    const name = `${houseName} · ${source.name}`.slice(0, 40);
    const hid = newId('wh');
    db.run("INSERT INTO hooks (id, house, room, kind, name, bot, source, by, created) VALUES (?, ?, ?, 'follow', ?, ?, ?, ?, ?)",
      hid, target.house, target.id, name, botUser(name), source.id, c.user, Date.now());
    return { hook: hookView(hookRow(hid)) };
  };
  out['news.unfollow'] = out['hook.delete'];

  // The rail: house order and folders, on every device.
  out['rail.set'] = (c, d) => {
    slow('write', c.user);
    if (!Array.isArray(d.items) || d.items.length > 200) fail('The list of houses isn’t valid.');
    const mine = new Set(M.houseIdsOf(c.user));
    let folders = 0;
    const items = d.items.map((it) => {
      if (typeof it === 'string') return mine.has(it) ? it : fail('That house isn’t one of yours.');
      if (!it || typeof it !== 'object' || !Array.isArray(it.houses) || !it.houses.length || it.houses.length > 100) fail('That folder isn’t valid.');
      if (++folders > L.folders) fail(`You can have up to ${L.folders} folders.`);
      const fid = typeof it.id === 'string' && /^fd_[a-z0-9]{4,30}$/.test(it.id) ? it.id : newId('fd');
      return {
        id: fid, name: str(it.name ?? '', { max: L.folderName, name: 'A folder’s name' }), hue: it.hue == null ? null : hueOrNull(it.hue),
        open: it.open === true, houses: it.houses.map((h) => (mine.has(h) ? h : fail('That house isn’t one of yours.'))),
      };
    });
    const flat = items.flatMap((x) => (typeof x === 'string' ? [x] : x.houses));
    if (new Set(flat).size !== flat.length) fail('A house can only be in one place on the rail.');
    const layout = { items: railItems({ items }, [...mine]) };
    db.run('INSERT INTO rails (user, layout) VALUES (?, ?) ON CONFLICT (user) DO UPDATE SET layout = excluded.layout', c.user, JSON.stringify(layout));
    hub.toUser(c.user, 'places', { rail: layout });
    return { rail: layout };
  };

  // Welcome and interests.
  out['onboard.set'] = (c, d) => {
    const house = houseRow(d.house);
    need(c.user, house.id, 'roles', 'change the welcome');
    slow('write', c.user);
    const welcome = d.welcome !== undefined ? str(d.welcome, { max: L.welcome, name: 'The welcome' }) : house.welcome;
    let interests = json(house.interests, []);
    if (d.interests !== undefined) {
      if (!Array.isArray(d.interests) || d.interests.length > L.interests) fail(`A house can offer up to ${L.interests} interests.`);
      const roles = orderedRoles(house.id);
      interests = d.interests.map((i) => {
        if (!i || typeof i !== 'object') fail('That interest isn’t valid.');
        const label = str(i.label, { min: 1, max: L.interestLabel, name: 'An interest' });
        const iid = typeof i.id === 'string' && /^in_[a-z0-9]{4,30}$/.test(i.id) ? i.id : newId('in');
        const emoji = i.emoji ? emojiOrNull(i.emoji, 'An interest’s emoji') : null;
        if (!Array.isArray(i.roles) || i.roles.length > 5) fail('An interest can give up to 5 roles.');
        const rs = [...new Set(i.roles)].map((r) => {
          const role = roles.find((x) => x.id === r) || fail('That role isn’t in this house.');
          if (role.pos === 0 || json(role.perms, []).some((p) => MANAGING.includes(p))) fail(`${role.name} can manage or moderate, so it can’t be handed out by an interest.`);
          return role.id;
        });
        return { id: iid, label, ...(emoji ? { emoji } : {}), roles: rs };
      });
    }
    db.run('UPDATE houses SET welcome = ?, interests = ? WHERE id = ?', welcome, JSON.stringify(interests), house.id);
    hub.houseChanged(house.id);
    return {};
  };
  out['onboard.pick'] = (c, d) => {
    const house = houseRow(d.house);
    member(c.user, house.id);
    slow('onboard', c.user);
    const all = json(house.interests, []);
    if (!Array.isArray(d.interests) || d.interests.length > all.length) fail('Pick from this house’s interests.');
    const picked = [...new Set(d.interests)].map((i) => all.find((x) => x.id === i) || fail('That interest isn’t offered here.'));
    const roles = orderedRoles(house.id);
    const safe = (rid) => { const r = roles.find((x) => x.id === rid); return r && r.pos > 0 && !json(r.perms, []).some((p) => MANAGING.includes(p)); };
    const give = new Set(picked.flatMap((i) => i.roles).filter(safe));
    const primary = db.get('SELECT role FROM members WHERE house = ? AND user = ?', house.id, c.user).role;
    db.tx(() => {
      db.run("DELETE FROM member_roles WHERE house = ? AND user = ? AND via = 'interest'", house.id, c.user);
      for (const r of give) if (r !== primary) db.run("INSERT OR IGNORE INTO member_roles (house, user, role, via) VALUES (?, ?, ?, 'interest')", house.id, c.user, r);
      db.run(`INSERT INTO member_profiles (house, user, picks) VALUES (?, ?, ?)
        ON CONFLICT (house, user) DO UPDATE SET picks = excluded.picks`, house.id, c.user, JSON.stringify(picked.map((i) => i.id)));
    });
    accessChanged(house.id);
    return { roles: [...give] };
  };

  // Insights: owners only.
  out['insights.get'] = (c, d) => {
    const house = houseRow(d.house);
    member(c.user, house.id);
    if (!M.isOwner(c.user, house.id)) fail('Only owners can see this house’s insights.');
    slow('insights', c.user);
    const days = d.days === 7 || d.days === 90 ? d.days : 30;
    const t = Date.now();
    const since = dayOf(t) - (days - 1) * DAY;
    const series = () => Array.from({ length: days }, (_, i) => ({ day: since + i * DAY, n: 0 }));
    const fill = (rows) => { const s = series(); for (const r of rows) { const i = Math.round((r.day - since) / DAY); if (s[i]) s[i].n += r.n; } return s; };
    const convs = `(SELECT id FROM rooms WHERE house = ?1) OR conv IN (SELECT t.id FROM threads t JOIN rooms r ON r.id = t.conv WHERE r.house = ?1)`;
    const messages = fill(db.all(`SELECT (ts / ${DAY}) * ${DAY} AS day, COUNT(*) n FROM messages WHERE (conv IN ${convs}) AND ts >= ?2 AND sys IS NULL GROUP BY day`, house.id, since));
    // Joins before the log began come from when people joined.
    const logged = db.get("SELECT MIN(ts) t FROM member_log WHERE house = ? AND kind = 'join'", house.id)?.t ?? t;
    const joined = fill([
      ...db.all(`SELECT (ts / ${DAY}) * ${DAY} AS day, COUNT(*) n FROM member_log WHERE house = ? AND kind = 'join' AND ts >= ? GROUP BY day`, house.id, since),
      ...db.all(`SELECT (joined / ${DAY}) * ${DAY} AS day, COUNT(*) n FROM members WHERE house = ? AND joined >= ? AND joined < ? GROUP BY day`, house.id, since, logged),
    ]);
    const left = fill(db.all(`SELECT (ts / ${DAY}) * ${DAY} AS day, COUNT(*) n FROM member_log WHERE house = ? AND kind = 'leave' AND ts >= ? GROUP BY day`, house.id, since));
    const rooms = db.all(`SELECT r.id, r.name, r.kind, COUNT(m.seq) n FROM rooms r
      LEFT JOIN messages m ON (m.conv = r.id OR m.conv IN (SELECT id FROM threads WHERE conv = r.id)) AND m.ts >= ? AND m.sys IS NULL
      WHERE r.house = ? GROUP BY r.id ORDER BY n DESC, r.pos LIMIT 5`, since, house.id).filter((r) => r.n > 0);
    const active = db.get(`SELECT COUNT(DISTINCT author) n FROM messages WHERE (conv IN ${convs}) AND ts >= ?2 AND sys IS NULL AND bot IS NULL`, house.id, t - 7 * DAY).n;
    return {
      days, messages, joined, left, rooms,
      members: db.get('SELECT COUNT(*) n FROM members WHERE house = ?', house.id).n, active,
    };
  };

  // Every snapshot carries the rail and the live stages.
  const baseSnap = hub.snapshotFor;
  hub.snapshotFor = (u) => {
    const snap = baseSnap(u);
    const rail = json(db.get('SELECT layout FROM rails WHERE user = ?', u)?.layout, {});
    snap.places = { rail: { items: railItems(rail, snap.houseOrder || []) } };
    return snap;
  };

  // The hub's default bucket limits every new op as well as the buckets above.
  Object.assign(ops, out);
  return { M, P };
}

// --- Webhook deliveries over HTTP (mounted in server/index.js) -----------
// POST /api/hooks/<id>/<token> with JSON { content, username?, avatar_url? }.
// avatar_url is checked and kept but never fetched or shown: Snug does not
// load images from other sites, so readers' addresses never leak to them.
export function createPlacesHttp({ db, M, hub, sendJson, error, jsonBody, ipOf }) {
  const limits = hub.extraLimits || [];
  const perHook = limiter({ capacity: 5, perSecond: 0.5 });
  const perIp = limiter({ capacity: 30, perSecond: 0.5 });
  limits.push(perHook, perIp);
  return async function placesHttp(req, res, path) {
    const m = /^\/api\/hooks\/(wh_[a-z0-9]{8,40})\/([\w-]{20,80})$/.exec(path);
    if (!m) return false;
    if (req.method !== 'POST') { error(res, 405, 'Webhooks take POST.'); return true; }
    if (!perIp.take(ipOf(req))) { error(res, 429, 'Too many webhook messages. Slow down.'); return true; }
    const hook = db.get("SELECT * FROM hooks WHERE id = ? AND kind = 'webhook'", m[1]);
    const want = Buffer.from(hook?.token || sha('none'), 'hex');
    const got = Buffer.from(sha(m[2]), 'hex');
    if (!hook || !timingSafeEqual(want, got)) { error(res, 401, 'That webhook address isn’t valid.'); return true; }
    if (!perHook.take(hook.id)) { error(res, 429, 'Too many webhook messages. Slow down.'); return true; }
    const d = await jsonBody(req);
    const content = typeof d?.content === 'string' ? d.content.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '') : '';
    if (!content.trim()) { error(res, 400, 'content is missing.'); return true; }
    if (content.length > L.hookContent) { error(res, 400, `content can be at most ${L.hookContent} characters.`); return true; }
    let name = hook.name;
    if (d.username !== undefined) {
      if (typeof d.username !== 'string' || !d.username.trim() || d.username.trim().length > L.hookName) { error(res, 400, `username can be 1 to ${L.hookName} characters.`); return true; }
      name = d.username.trim().replace(/[\u0000-\u001f\u007f]/g, '');
    }
    let avatar = null;
    if (d.avatar_url !== undefined && d.avatar_url !== null) {
      let ok = false;
      try { const u = new URL(String(d.avatar_url)); ok = u.protocol === 'https:' && String(d.avatar_url).length <= 500; } catch { ok = false; }
      if (!ok) { error(res, 400, 'avatar_url must be an https address.'); return true; }
      avatar = String(d.avatar_url);
    }
    const room = M.room(hook.room);
    if (!room) { error(res, 404, 'That room is gone.'); return true; }
    const mid = newId('m');
    const ts = now();
    db.run('INSERT INTO messages (id, conv, author, ts, text, fold, bot) VALUES (?, ?, ?, ?, ?, ?, ?)',
      mid, room.id, hook.bot, ts, content, M.foldText(content, []), JSON.stringify({ name, hook: hook.id, ...(avatar ? { avatar } : {}) }));
    const [msg] = M.withReactions([M.msg(mid)]);
    hub.toConv(room.id, 'msg', { conv: room.id, m: msg, user: hub.userView(hook.bot) });
    hub.hooks.message?.(room.id, mid);
    sendJson(res, 200, { id: mid });
    return true;
  };
}
