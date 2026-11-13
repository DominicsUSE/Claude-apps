// Safety, privacy and moderation, on the server. Every rule here is checked
// against the database; nothing the browser says about permissions counts.
//
// - Blocks: a blocked person can't open a conversation with you, call you,
//   ring you in a group call, send you a friend request, write or react in a
//   one-to-one conversation with you, or reach you with a mention or a push.
//   Blocking ends a friendship and takes back pending requests both ways.
// - Privacy: who may open a conversation with you (everyone, people in your
//   houses, friends only), who may send you friend requests (everyone, friends
//   of friends, nobody), and message requests: a conversation from someone who
//   is not your friend waits in Requests until you accept it. Strangers (no
//   house in common) always land in Requests.
// - Moderation in a house: remove (kick), ban (optionally deleting the last
//   24 hours or 7 days of their messages), unban, time out (60s to a week:
//   no writing, reacting, voice or threads), and in voice: mute, deafen, move
//   and disconnect. Each needs its permission AND a role above the person's.
//   Nobody can act on an owner.
// - Reports of a message or a person go to the house's moderators ('moderate').
// - The house log (audit) records who changed what.
// - Slowmode per room, the word and link filter, invitation limits and
//   member screening (accept the rules before taking part).
import { limiter } from './auth.js';
import { newId, now } from './model.js';
import {
  TIMEOUTS, SLOWMODES, INVITE_AGES, INVITE_USES, BAN_DELETE, REPORT_REASONS, PRIVACY_DM, PRIVACY_FRIENDS,
  DEFAULT_PRIVACY, FILTER_ACTIONS, MAX_WORDS, cleanWord, filterHit, outranks, roleBelow, slowWait, left,
} from '../js/lib/safety.js';

const json = (s, f) => { try { return s == null ? f : JSON.parse(s); } catch { return f; } };
const values = (list) => list.map((x) => (Array.isArray(x) ? x[0] : x));
const DAY = 86_400_000;
const NEVER = 8_640_000_000_000_000; // the largest time a Date can hold: an invitation that never runs out
export const AUDIT_PAGE = 50;

export function createSafetyOps({ db, M, hub, fail, ops, removeMember }) {
  // Input checks (the same rules as server/ops.js).
  const id = (v, name = 'id') => (typeof v === 'string' && /^[\w:.-]{1,80}$/.test(v) ? v : fail(`That ${name} isn’t valid.`));
  const text = (v, max, name) => {
    if (v == null) return '';
    if (typeof v !== 'string') fail(`${name} isn’t valid.`);
    const s = v.trim().replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
    if (s.length > max) fail(`${name} can be at most ${max} characters.`);
    return s;
  };
  const oneOf = (v, list, name) => (list.includes(v) ? v : fail(`${name} isn’t one of the choices.`));
  const userRow = (v) => M.userRow(id(v, 'person')) || fail('That person doesn’t exist.');
  const houseRow = (v) => db.get('SELECT * FROM houses WHERE id = ?', id(v, 'house')) || fail('That house doesn’t exist.');
  const member = (user, house) => (M.isMember(house, user) ? true : fail('You’re not a member of that house.'));
  const need = (user, house, perm, what) => {
    member(user, house);
    if (!M.can(user, house, perm)) fail(`Your role can’t ${what} in this house.`);
  };
  const first = (u) => (M.userRow(u)?.name || 'They').split(' ')[0];

  // Rate limits for anything that writes or reaches other people. Registered
  // with the hub so tests can reset them like the others.
  const limits = {
    report: limiter({ capacity: 5, perSecond: 1 / 30 }),
    block: limiter({ capacity: 20, perSecond: 0.5 }),
    mod: limiter({ capacity: 30, perSecond: 1 }),
    newDm: limiter({ capacity: 10, perSecond: 1 / 30 }),
    invite: limiter({ capacity: 10, perSecond: 0.1 }),
    settings: limiter({ capacity: 20, perSecond: 0.5 }),
  };
  (hub.extraLimits ||= []).push(...Object.values(limits));
  const slow = (bucket, user) => { if (!limits[bucket].take(user)) fail('You’re going a little fast. Wait a moment and try again.'); };

  // ---------- Reads ----------
  const R = {};
  R.blocked = (a, b) => !!db.get('SELECT 1 FROM blocks WHERE user = ? AND other = ?', a, b);
  R.either = (a, b) => R.blocked(a, b) || R.blocked(b, a);
  R.privacy = (u) => {
    const p = db.get('SELECT * FROM privacy WHERE user = ?', u);
    return p ? { dm: p.dm, friends: p.friends, requests: !!p.requests } : { ...DEFAULT_PRIVACY };
  };
  R.shareHouse = (a, b) => !!db.get('SELECT 1 FROM members m1 JOIN members m2 ON m1.house = m2.house WHERE m1.user = ? AND m2.user = ? LIMIT 1', a, b);
  R.shareDm = (a, b) => !!db.get(`SELECT 1 FROM dm_members d1 JOIN dm_members d2 ON d1.dm = d2.dm
    WHERE d1.user = ? AND d2.user = ? AND NOT EXISTS (SELECT 1 FROM dm_requests r WHERE r.dm = d1.dm) LIMIT 1`, a, b);
  R.mutualFriend = (a, b) => !!db.get(`SELECT 1 FROM friends f1 JOIN friends f2 ON f2.user = f1.other
    WHERE f1.user = ? AND f1.state = 'friends' AND f2.other = ? AND f2.state = 'friends' LIMIT 1`, a, b);
  R.pending = (dm, user) => db.get('SELECT * FROM dm_requests WHERE dm = ? AND user = ? AND declined IS NULL', dm, user);
  R.anyPending = (dm) => db.all('SELECT * FROM dm_requests WHERE dm = ? AND declined IS NULL', dm);
  R.dmMembers = (dm) => db.all('SELECT user FROM dm_members WHERE dm = ?', dm).map((r) => r.user);
  // The house a conversation belongs to, threads not yet started included.
  R.houseOf = (conv) => {
    if (typeof conv !== 'string') return null;
    const w = M.where(conv);
    if (w) return w.house || null;
    if (conv.startsWith('t:')) return M.where(M.liveMsg(conv.slice(2))?.conv || '')?.house || null;
    return null;
  };
  // The direct conversation under a conversation (itself, or a thread's parent).
  R.dmOf = (conv) => {
    if (typeof conv !== 'string') return null;
    const w = M.where(conv) || (conv.startsWith('t:') ? M.where(M.liveMsg(conv.slice(2))?.conv || '') : null);
    return w?.dm || null;
  };
  R.timeout = (house, user) => db.get('SELECT * FROM timeouts WHERE house = ? AND user = ? AND until > ?', house, user, Date.now());
  R.roles = (house) => db.all('SELECT id, pos FROM roles WHERE house = ? ORDER BY pos', house);
  // Only the people involved are read (by primary key), never the whole house.
  R.members = (house, users) => {
    const out = {};
    for (const u of new Set(users)) { const r = db.get('SELECT role FROM members WHERE house = ? AND user = ?', house, u); if (r) out[u] = r.role; }
    return out;
  };
  // Extra roles (server/places.js) count: a person acts with their best role.
  R.extra = (house, users) => {
    const out = {};
    for (const u of new Set(users)) {
      const list = db.all('SELECT role FROM member_roles WHERE house = ? AND user = ?', house, u).map((r) => r.role);
      if (list.length) out[u] = list;
    }
    return out;
  };
  R.outranks = (house, actor, target) => outranks(R.roles(house), R.members(house, [actor, target]), actor, target, R.extra(house, [actor, target]));
  // The one role hierarchy every op uses: moderation here, member and role
  // management below, nicknames, role order and extra roles in server/places.js.
  M.outranks = R.outranks;
  M.roleBelow = (house, actor, role) => roleBelow(R.roles(house), R.members(house, [actor]), actor, role, R.extra(house, [actor]));
  M.rankOf = (house, user) => {
    const roles = R.roles(house);
    const mine = [db.get('SELECT role FROM members WHERE house = ? AND user = ?', house, user)?.role, ...(R.extra(house, [user])[user] || [])]
      .map((id) => roles.findIndex((r) => r.id === id)).filter((i) => i >= 0);
    return mine.length ? Math.min(...mine) : 999;
  };
  R.accepted = (house, user) => {
    const h = db.get('SELECT screening FROM houses WHERE id = ?', house);
    if (!h?.screening) return true;
    if (M.isOwner(user, house) || M.can(user, house, 'roles')) return true;
    return !!db.get('SELECT 1 FROM rule_accepts WHERE house = ? AND user = ?', house, user);
  };
  R.automod = (house) => {
    const a = db.get('SELECT * FROM automod WHERE house = ?', house);
    return a ? { words: json(a.words, []), links: !!a.links, action: a.action, timeoutMs: a.timeout_ms, exempt: json(a.exempt, []) } : null;
  };
  R.mods = (house, perm = 'moderate') => db.all('SELECT user FROM members WHERE house = ?', house).map((r) => r.user).filter((u) => M.can(u, house, perm));
  // May this moderator see what happened in this conversation (a report's
  // message, a log entry's room)? A room they can't see stays out of their
  // queue and log. A room that's gone is for owners only: it may have been private.
  R.seesConv = (user, house, conv) => {
    if (!conv) return true;
    if (M.isOwner(user, house)) return true;
    return M.canRead(user, conv);
  };
  R.openReports = (house, viewer) => db.all("SELECT conv, COUNT(*) n FROM reports WHERE house = ? AND status = 'open' GROUP BY conv", house)
    .reduce((sum, r) => sum + (R.seesConv(viewer, house, r.conv) ? r.n : 0), 0);
  R.state = (u) => {
    const blocks = db.all('SELECT other FROM blocks WHERE user = ? ORDER BY ts DESC', u).map((r) => r.other);
    const requests = db.all('SELECT dm, by, ts FROM dm_requests WHERE user = ? AND declined IS NULL ORDER BY ts DESC', u);
    const sent = db.all('SELECT dm, user, ts FROM dm_requests WHERE by = ? AND declined IS NULL', u);
    const ids = [...blocks, ...requests.map((r) => r.by)];
    const users = Object.fromEntries(ids.map((x) => [x, M.sees(u, x) ? hub.userView(x) : M.hiddenView(M.userRow(x))]).filter(([, v]) => v));
    return { blocks, privacy: R.privacy(u), requests, sent, users };
  };
  const sendState = (u, extra = {}) => hub.toUser(u, 'safety', { ...R.state(u), ...extra });

  // Used by push (server/push.js) and calls (server/hub.js): someone who
  // blocked the author, or has not accepted their message request, is not
  // notified or rung.
  M.quietFor = (user, author, conv) => {
    if (R.blocked(user, author)) return true;
    const dm = R.dmOf(conv);
    return !!(dm && R.pending(dm, user));
  };
  M.ringBlocked = (caller, user, dm) => R.either(caller, user) || !!(dm && R.pending(dm, user));
  // Taking part in a conversation without writing (voting in a poll,
  // server/messaging.js): a timeout, unaccepted rules, or a block in a
  // one-to-one conversation stop it, as they stop reacting.
  M.mayTakePart = (user, conv, what) => {
    const house = R.houseOf(conv);
    if (house && M.isMember(house, user)) guard(user, house, what);
    const dm = house ? null : R.dmOf(conv);
    if (dm && M.inDm(dm, user)) {
      const members = R.dmMembers(dm);
      const other = members.length === 2 && members.find((u) => u !== user);
      if (other && R.either(user, other)) fail('You can’t do that with this person.');
    }
  };
  // Forum post titles (server/places.js): refused or timed out like a message;
  // a "flag" hit comes back as the note, and the post is filed with fileFlag.
  M.wordFilter = (user, house, conv, body) => filter(user, house, conv, body);
  M.fileFlag = ({ house, user, msg, conv, body, note }) => fileReport({ house, by: null, user, msg, conv, body, reason: 'filter', note });
  // Words that go out with a message without being its text (poll answers, a
  // forwarded message, server/messaging.js): the same filter, for the house
  // the conversation is in. Returns what to flag afterwards, or null.
  M.filterExtra = (user, conv, body) => {
    const house = R.houseOf(conv);
    if (!house || !body || !M.isMember(house, user)) return null;
    const note = filter(user, house, conv, body);
    return note ? { house, note } : null;
  };

  // The house log.
  function audit(house, actor, action, target = null, detail = null) {
    db.run('INSERT INTO audit (house, ts, actor, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)',
      house, Date.now(), actor, action, target, detail ? JSON.stringify(detail) : null);
  }

  // Taking part in a house: not timed out, and the rules accepted when the house screens.
  function guard(user, house, what) {
    const t = R.timeout(house, user);
    if (t) fail(`You’re timed out in ${db.get('SELECT name FROM houses WHERE id = ?', house)?.name || 'this house'} for ${left(t.until - Date.now())}, so you can’t ${what} yet.`);
    if (!R.accepted(house, user)) fail('Read and accept this house’s rules first. They’re at the top of the house.');
  }

  // The word and link filter. Returns a note when the message may go through
  // but should be flagged; fails when it is blocked.
  function filter(user, house, conv, body) {
    const cfg = R.automod(house);
    if (!cfg || (!cfg.words.length && !cfg.links)) return null;
    if (M.isOwner(user, house) || M.can(user, house, 'roles')) return null;
    // Exempt roles count every role the person has (extra roles from server/places.js too).
    const roles = [db.get('SELECT role FROM members WHERE house = ? AND user = ?', house, user)?.role, ...(R.extra(house, [user])[user] || [])];
    if (roles.some((r) => r && cfg.exempt.includes(r))) return null;
    const hit = filterHit(body, cfg);
    if (!hit) return null;
    const what = hit.link ? 'Links aren’t allowed' : 'That message has a word this house doesn’t allow';
    if (cfg.action === 'flag') return hit.link ? 'Link' : `Word: ${hit.word}`;
    if (cfg.action === 'timeout') {
      const until = Date.now() + cfg.timeoutMs;
      db.run(`INSERT INTO timeouts (house, user, until, by, reason) VALUES (?, ?, ?, 'filter', ?)
        ON CONFLICT (house, user) DO UPDATE SET until = excluded.until, by = excluded.by, reason = excluded.reason`, house, user, until, 'Word filter');
      audit(house, null, 'member.timeout', user, { ms: cfg.timeoutMs, reason: 'Word filter' });
      hub.leaveVoiceInHouse(user, house);
      hub.houseChanged(house);
      fail(`${what} here. You’re timed out for ${left(cfg.timeoutMs)}.`);
    }
    fail(`${what} here, so it wasn’t sent.`);
    return null;
  }

  function fileReport({ house, by, user, msg, conv, body, reason, note }) {
    const rid = newId('rep');
    db.run('INSERT INTO reports (id, house, by, user, msg, conv, text, reason, note, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      rid, house, by, user, msg, conv, (body || '').slice(0, 2000), reason, note || '', Date.now());
    // Moderators' house view carries the count of open reports (only the ones
    // they may see, so only they hear about it).
    for (const u of R.mods(house)) if (R.seesConv(u, house, conv)) hub.sendHouse(u, house);
    return rid;
  }

  // ---------- What a house looks like, with its safety settings ----------
  const baseHouseView = M.houseView;
  M.houseView = (houseId, viewer) => {
    const v = baseHouseView(houseId, viewer);
    if (!v) return v;
    const h = db.get('SELECT screening FROM houses WHERE id = ?', houseId);
    for (const r of db.all('SELECT id, slowmode FROM rooms WHERE house = ?', houseId)) if (v.rooms[r.id]) v.rooms[r.id].slowmode = r.slowmode || 0;
    v.house.screening = !!h.screening;
    if (v.house.joined) {
      v.house.accepted = R.accepted(houseId, viewer);
      v.house.timedOut = R.timeout(houseId, viewer)?.until || null;
      if (M.can(viewer, houseId, 'timeout')) {
        v.house.timeouts = Object.fromEntries(db.all('SELECT user, until FROM timeouts WHERE house = ? AND until > ?', houseId, Date.now()).map((r) => [r.user, r.until]));
      }
      if (M.can(viewer, houseId, 'moderate')) v.house.reportsOpen = R.openReports(houseId, viewer);
    }
    return v;
  };
  // Every snapshot carries this person's blocks, privacy and message requests.
  const baseSnapshot = hub.snapshotFor;
  hub.snapshotFor = (u) => {
    const snap = baseSnapshot(u);
    const st = R.state(u);
    for (const [k, view] of Object.entries(st.users)) if (!snap.users[k]) snap.users[k] = view;
    delete st.users;
    snap.safety = st;
    return snap;
  };

  // ---------- Wrapped ops: the rules above, applied before the base op ----------
  const wrap = (name, fn) => {
    const base = ops[name];
    if (!base) return;
    ops[name] = (c, d) => fn(c, d, base);
  };

  wrap('msg.send', (c, d, base) => {
    // A retry of a message that already landed passes straight through.
    if (typeof d.id === 'string' && M.msg(d.id)) return base(c, d);
    const conv = typeof d.conv === 'string' ? d.conv : null;
    const house = R.houseOf(conv);
    let flag = null;
    if (house && M.isMember(house, c.user)) {
      guard(c.user, house, 'send messages');
      const room = M.room(conv);
      if (room?.slowmode && !M.can(c.user, house, 'moderate')) {
        const last = db.get('SELECT MAX(ts) t FROM messages WHERE conv = ? AND author = ? AND sys IS NULL', conv, c.user)?.t;
        const wait = slowWait(room.slowmode, last);
        if (wait > 0) fail(`Slowmode is on in ${room.name}. You can send again in ${left(wait)}.`);
      }
      if (typeof d.text === 'string') flag = filter(c.user, house, conv, d.text);
    }
    const dm = house ? null : R.dmOf(conv);
    if (dm && M.inDm(dm, c.user)) {
      const members = R.dmMembers(dm);
      if (members.length === 2) {
        const other = members.find((u) => u !== c.user);
        if (other && R.either(c.user, other)) fail('Your message couldn’t be delivered. You can’t message this person.');
      }
      // Replying to a message request accepts it.
      if (R.pending(dm, c.user)) { db.run('DELETE FROM dm_requests WHERE dm = ? AND user = ?', dm, c.user); sendState(c.user); }
    }
    const r = base(c, d);
    if (flag && r?.m) fileReport({ house, by: null, user: c.user, msg: r.m.id, conv, body: r.m.text, reason: 'filter', note: flag });
    return r;
  });

  wrap('msg.edit', (c, d, base) => {
    const house = R.houseOf(d.conv);
    let flag = null;
    // A timeout stops rewriting old messages as well as writing new ones.
    if (house && M.isMember(house, c.user)) guard(c.user, house, 'edit messages');
    if (house && M.isMember(house, c.user) && typeof d.text === 'string') flag = filter(c.user, house, d.conv, d.text);
    const r = base(c, d);
    if (flag) fileReport({ house, by: null, user: c.user, msg: d.id, conv: d.conv, body: d.text, reason: 'filter', note: flag });
    return r;
  });

  wrap('react', (c, d, base) => {
    const house = R.houseOf(d.conv);
    if (house && M.isMember(house, c.user) && d.on === true) guard(c.user, house, 'react');
    const dm = house ? null : R.dmOf(d.conv);
    if (dm && d.on === true) {
      const members = R.dmMembers(dm);
      const other = members.length === 2 && members.find((u) => u !== c.user);
      if (other && R.either(c.user, other)) fail('You can’t react to this person’s messages.');
    }
    return base(c, d);
  });

  wrap('typing', (c, d, base) => {
    const house = R.houseOf(d.conv);
    if (house && (R.timeout(house, c.user) || !R.accepted(house, c.user))) return {};
    return base(c, d);
  });

  wrap('voice.join', (c, d, base) => {
    const room = typeof d.room === 'string' ? M.room(d.room) : null;
    if (room && M.isMember(room.house, c.user)) guard(c.user, room.house, 'join voice');
    const r = base(c, d);
    // Mutes and deafens a moderator set last time still hold.
    const vm = room && db.get('SELECT mute, deaf FROM voice_mod WHERE house = ? AND user = ?', room.house, c.user);
    if (vm) hub.voiceState(c.user, voiceFlags(!!vm.mute, !!vm.deaf));
    return r;
  });
  const voiceFlags = (mute, deaf) => ({ smute: mute, sdeaf: deaf, ...(mute || deaf ? { muted: true } : {}), ...(deaf ? { deaf: true } : {}) });

  wrap('voice.state', (c, d, base) => {
    const place = hub.voicePlaceOf?.(c.user);
    const room = place && M.room(place);
    if (room) {
      const vm = db.get('SELECT mute, deaf FROM voice_mod WHERE house = ? AND user = ?', room.house, c.user);
      if (vm?.mute && d.muted === false) fail('A moderator muted you in this house’s voice rooms.');
      if (vm?.deaf && (d.deaf === false || d.muted === false)) fail('A moderator deafened you in this house’s voice rooms.');
    }
    return base(c, d);
  });

  // Calls in direct conversations: never with someone blocked either way, and
  // not before a message request is accepted.
  for (const name of ['call.start', 'call.join']) {
    wrap(name, (c, d, base) => {
      const dm = typeof d.dm === 'string' ? d.dm : null;
      if (dm && M.inDm(dm, c.user)) {
        const members = R.dmMembers(dm);
        const other = members.length === 2 && members.find((u) => u !== c.user);
        if (other && R.either(c.user, other)) fail('You can’t call this person.');
        if (R.pending(dm, c.user)) fail('Accept the message request before calling.');
        if (other && R.pending(dm, other)) fail(`${first(other)} hasn’t accepted your message request yet.`);
      }
      return base(c, d);
    });
  }

  // Opening a conversation: blocks and the other people's privacy settings.
  wrap('dm.open', (c, d, base) => {
    const others = [...new Set(Array.isArray(d.users) ? d.users : [])].filter((u) => u !== c.user);
    if (!others.length || others.length > 9) fail('Pick between one and nine people.');
    const rows = others.map((u) => userRow(u));
    const want = [c.user, ...others].sort().join();
    const existing = db.all('SELECT dm FROM dm_members WHERE user = ?', c.user).map((r) => r.dm)
      .find((dm) => R.dmMembers(dm).sort().join() === want);
    for (const u of rows) if (R.either(c.user, u.id)) fail(`You can’t message ${u.name}.`);
    if (existing) return base(c, d);
    const asks = [];
    let stranger = false;
    for (const u of rows) {
      const p = R.privacy(u.id);
      const friends = M.areFriends(c.user, u.id);
      const near = R.shareHouse(c.user, u.id) || R.shareDm(c.user, u.id);
      if (p.dm === 'friends' && !friends) fail(`${u.name} only takes messages from friends.`);
      if (p.dm === 'houses' && !friends && !near) fail('You can only message friends and people you share a house with.');
      if (!friends && (!near || p.requests)) {
        const declined = db.get('SELECT ts FROM dm_requests WHERE by = ? AND user = ? AND declined > ?', c.user, u.id, Date.now() - DAY);
        if (declined) fail(`${u.name} declined your last message request. You can try again tomorrow.`);
        asks.push(u.id);
      }
      if (!friends && !near) stranger = true;
    }
    slow('newDm', c.user);
    let r;
    if (!stranger) r = base(c, d);
    else {
      // Someone with no house in common who takes messages from everyone:
      // the base op only knows housemates and friends, so make it here.
      const dmId = newId('d');
      db.tx(() => {
        db.run('INSERT INTO dms (id, name, created) VALUES (?, NULL, ?)', dmId, Date.now());
        for (const u of [c.user, ...others]) db.run('INSERT INTO dm_members (dm, user) VALUES (?, ?)', dmId, u);
      });
      r = { id: dmId };
    }
    if (asks.length) {
      const t = Date.now();
      for (const u of asks) db.run('INSERT OR REPLACE INTO dm_requests (dm, user, by, ts, declined) VALUES (?, ?, ?, ?, NULL)', r.id, u, c.user, t);
    }
    if (stranger) for (const u of [c.user, ...others]) hub.sendDm(u, r.id);
    for (const u of asks) sendState(u);
    if (asks.length) sendState(c.user);
    return r;
  });

  wrap('friend.request', (c, d, base) => {
    let target;
    if (d.user !== undefined) target = M.userRow(id(d.user, 'person'));
    else if (typeof d.handle === 'string') target = db.get('SELECT * FROM users WHERE handle = ?', d.handle.trim().replace(/^@/, '').toLowerCase());
    if (target && target.id !== c.user) {
      if (R.either(c.user, target.id)) fail(`You can’t send ${target.name} a friend request.`);
      const theyAsked = M.friendRow(c.user, target.id)?.state === 'incoming';
      const p = R.privacy(target.id);
      if (!theyAsked && !M.areFriends(c.user, target.id)) {
        if (p.friends === 'nobody') fail(`${target.name} isn’t taking friend requests.`);
        if (p.friends === 'fof' && !R.mutualFriend(c.user, target.id)) fail(`${target.name} only takes friend requests from friends of friends.`);
      }
    }
    return base(c, d);
  });

  // Bans keep people out, whichever way they try to come in.
  const banned = (house, user) => !!db.get('SELECT 1 FROM bans WHERE house = ? AND user = ?', house, user);
  wrap('invite.accept', (c, d, base) => {
    const code = typeof d.code === 'string' && /^[\w-]{6,40}$/.test(d.code) ? d.code : fail('That invitation link isn’t valid.');
    const inv = db.get('SELECT * FROM invites WHERE code = ?', code);
    if (!inv || inv.expires < Date.now() || inv.revoked || (inv.max_uses && inv.uses >= inv.max_uses)) fail('That invitation has expired. Ask for a new link.');
    if (banned(inv.house, c.user)) fail('You can’t join this house.');
    const was = M.isMember(inv.house, c.user);
    const r = base(c, d);
    if (!was) {
      db.run('UPDATE invites SET uses = uses + 1 WHERE code = ?', code);
      audit(inv.house, c.user, 'member.join', c.user, { invite: code });
    }
    return r;
  });
  for (const name of ['invite.join', 'house.joinPublic']) {
    wrap(name, (c, d, base) => {
      const house = typeof d.house === 'string' ? d.house : '';
      if (banned(house, c.user)) fail('You can’t join this house.');
      const was = M.isMember(house, c.user);
      const r = base(c, d);
      if (!was && M.isMember(house, c.user)) audit(house, c.user, 'member.join', c.user, null);
      return r;
    });
  }
  wrap('invite.user', (c, d, base) => {
    const house = typeof d.house === 'string' ? d.house : '';
    const handle = typeof d.handle === 'string' ? d.handle.trim().replace(/^@/, '') : '';
    const target = handle && db.get('SELECT id, name FROM users WHERE handle = ?', handle);
    if (target && M.isMember(house, c.user)) {
      if (banned(house, target.id)) fail(`${target.name} is banned from this house. Unban them first, in House settings > Bans.`);
      if (R.blocked(target.id, c.user)) fail(`${target.name} can’t be invited by you.`);
    }
    const r = base(c, d);
    if (target) audit(house, c.user, 'invite.user', target.id, null);
    return r;
  });

  // Invitation links with an expiry and a use limit.
  ops['invite.create'] = (c, d) => {
    const h = houseRow(d.house);
    need(c.user, h.id, 'invite', 'invite people');
    const age = d.maxAge === undefined ? 14 * DAY : oneOf(d.maxAge, values(INVITE_AGES), 'That expiry');
    const uses = d.maxUses === undefined ? 0 : oneOf(d.maxUses, INVITE_USES, 'That limit');
    slow('invite', c.user);
    if (db.get('SELECT COUNT(*) n FROM invites WHERE house = ? AND revoked IS NULL AND expires > ?', h.id, Date.now()).n >= 1000) fail('This house has 1000 open invitations. Revoke some first.');
    const code = newId('i').slice(2, 14);
    const t = Date.now();
    const expires = age ? t + age : NEVER;
    db.run('INSERT INTO invites (code, house, by, created, expires, max_uses, uses) VALUES (?, ?, ?, ?, ?, ?, 0)', code, h.id, c.user, t, expires, uses);
    audit(h.id, c.user, 'invite.create', null, { code, maxAge: age, maxUses: uses });
    return { code, expires: age ? expires : null, maxUses: uses };
  };
  const inviteView = (r) => ({
    code: r.code, by: r.by, created: r.created, expires: r.expires >= NEVER ? null : r.expires, uses: r.uses, maxUses: r.max_uses,
  });
  ops['invite.list'] = (c, d) => {
    const h = houseRow(d.house);
    member(c.user, h.id);
    const all = M.can(c.user, h.id, 'roles');
    if (!all && !M.can(c.user, h.id, 'invite')) fail('Your role can’t see this house’s invitations.');
    const rows = db.all(`SELECT * FROM invites WHERE house = ? AND revoked IS NULL AND expires > ? AND (max_uses = 0 OR uses < max_uses)
      ${all ? '' : 'AND by = ?'} ORDER BY created DESC LIMIT 200`, ...(all ? [h.id, Date.now()] : [h.id, Date.now(), c.user]));
    return { invites: rows.map(inviteView), users: hub.usersFor(rows.map((r) => r.by)), all };
  };
  ops['invite.revoke'] = (c, d) => {
    const h = houseRow(d.house);
    member(c.user, h.id);
    const code = typeof d.code === 'string' && /^[\w-]{6,40}$/.test(d.code) ? d.code : fail('That invitation isn’t valid.');
    const inv = db.get('SELECT * FROM invites WHERE code = ? AND house = ?', code, h.id) || fail('That invitation doesn’t exist.');
    if (inv.by !== c.user && !M.can(c.user, h.id, 'roles')) fail('You can only revoke invitations you made.');
    if (!inv.revoked) {
      db.run('UPDATE invites SET revoked = ? WHERE code = ?', Date.now(), code);
      audit(h.id, c.user, 'invite.revoke', inv.by, { code });
    }
    return {};
  };

  // ---------- Blocks and privacy ----------
  ops['block.set'] = (c, d) => {
    const target = userRow(d.user);
    if (target.id === c.user) fail('You can’t block yourself.');
    if (typeof d.on !== 'boolean') fail('Block is yes or no.');
    slow('block', c.user);
    if (d.on) {
      if (db.get('SELECT COUNT(*) n FROM blocks WHERE user = ?', c.user).n >= 1000) fail('You can block up to 1000 people.');
      const left1 = [];
      db.tx(() => {
        db.run('INSERT OR IGNORE INTO blocks (user, other, ts) VALUES (?, ?, ?)', c.user, target.id, Date.now());
        db.run('DELETE FROM friends WHERE (user = ? AND other = ?) OR (user = ? AND other = ?)', c.user, target.id, target.id, c.user);
        // Their unanswered message requests to me go away, and I leave those conversations.
        for (const r of db.all('SELECT dm FROM dm_requests WHERE by = ? AND user = ?', target.id, c.user)) {
          db.run('DELETE FROM dm_requests WHERE dm = ? AND user = ?', r.dm, c.user);
          db.run('DELETE FROM dm_members WHERE dm = ? AND user = ?', r.dm, c.user);
          left1.push(r.dm);
        }
        db.run('DELETE FROM dm_requests WHERE by = ? AND user = ?', c.user, target.id);
      });
      hub.friendChanged(c.user, target.id);
      sendState(c.user, left1.length ? { left: left1 } : {});
      sendState(target.id);
    } else {
      db.run('DELETE FROM blocks WHERE user = ? AND other = ?', c.user, target.id);
      sendState(c.user);
    }
    return {};
  };

  ops['privacy.set'] = (c, d) => {
    const p = R.privacy(c.user);
    const next = {
      dm: d.dm === undefined ? p.dm : oneOf(d.dm, values(PRIVACY_DM), 'Who can message you'),
      friends: d.friends === undefined ? p.friends : oneOf(d.friends, values(PRIVACY_FRIENDS), 'Who can send you friend requests'),
      requests: d.requests === undefined ? p.requests : (typeof d.requests === 'boolean' ? d.requests : fail('Message requests is yes or no.')),
    };
    slow('settings', c.user);
    db.run(`INSERT INTO privacy (user, dm, friends, requests) VALUES (?, ?, ?, ?)
      ON CONFLICT (user) DO UPDATE SET dm = excluded.dm, friends = excluded.friends, requests = excluded.requests`, c.user, next.dm, next.friends, next.requests ? 1 : 0);
    sendState(c.user);
    return {};
  };

  ops['dm.request.accept'] = (c, d) => {
    const dm = id(d.dm, 'conversation');
    if (!R.pending(dm, c.user)) return {};
    db.run('DELETE FROM dm_requests WHERE dm = ? AND user = ?', dm, c.user);
    sendState(c.user);
    const by = db.get('SELECT by FROM dm_requests WHERE dm = ?', dm)?.by;
    for (const u of R.dmMembers(dm)) if (u !== c.user) sendState(u);
    void by;
    return {};
  };
  ops['dm.request.decline'] = (c, d) => {
    const dm = id(d.dm, 'conversation');
    const req = R.pending(dm, c.user);
    if (!req) return {};
    db.tx(() => {
      db.run('UPDATE dm_requests SET declined = ? WHERE dm = ? AND user = ?', Date.now(), dm, c.user);
      db.run('DELETE FROM dm_members WHERE dm = ? AND user = ?', dm, c.user);
    });
    sendState(c.user, { left: [dm] });
    sendState(req.by);
    return {};
  };

  // ---------- Moderation ----------
  // A moderator acting on a member: permission, a role above theirs, never yourself.
  function target(c, d, perm, what) {
    const h = houseRow(d.house);
    need(c.user, h.id, perm, what);
    const t = userRow(d.user);
    if (t.id === c.user) fail('You can’t do that to yourself.');
    if (M.isMember(h.id, t.id) && !R.outranks(h.id, c.user, t.id)) {
      fail(M.isOwner(t.id, h.id) ? 'Nobody can do that to an owner.' : `${first(t.id)}’s role is the same as yours or above it.`);
    }
    slow('mod', c.user);
    return { h, t };
  }
  const reasonOf = (d) => text(d.reason, 300, 'The reason');
  const notice = (u, d) => hub.toUser(u, 'mod.notice', d);

  ops['mod.kick'] = (c, d) => {
    const { h, t } = target(c, d, 'kick', 'remove people');
    if (!M.isMember(h.id, t.id)) fail(`${t.name} isn’t in this house.`);
    const reason = reasonOf(d);
    notice(t.id, { house: h.id, name: h.name, action: 'kick', reason });
    db.run('DELETE FROM rule_accepts WHERE house = ? AND user = ?', h.id, t.id);
    removeMember(h.id, t.id);
    audit(h.id, c.user, 'member.kick', t.id, { reason });
    return {};
  };

  ops['mod.ban'] = (c, d) => {
    const { h, t } = target(c, d, 'ban', 'ban people');
    const reason = reasonOf(d);
    const window = d.deleteMs === undefined ? 0 : oneOf(d.deleteMs, values(BAN_DELETE), 'How much to delete');
    db.run('INSERT OR REPLACE INTO bans (house, user, by, reason, ts) VALUES (?, ?, ?, ?, ?)', h.id, t.id, c.user, reason, Date.now());
    db.run('DELETE FROM personal_invites WHERE house = ? AND user = ?', h.id, t.id);
    db.run('DELETE FROM rule_accepts WHERE house = ? AND user = ?', h.id, t.id);
    // Webhook addresses they made stop working: they still know the secret.
    db.run("DELETE FROM hooks WHERE house = ? AND by = ? AND kind = 'webhook'", h.id, t.id);
    let deleted = 0;
    if (window) {
      const rooms = db.all('SELECT id FROM rooms WHERE house = ?', h.id).map((r) => r.id);
      const convs = rooms.length ? [...rooms, ...db.all(`SELECT id FROM threads WHERE conv IN (${rooms.map(() => '?').join(',')})`, ...rooms).map((r) => r.id)] : [];
      const t0 = Date.now();
      for (const conv of convs) {
        const gone = db.all('SELECT id FROM messages WHERE conv = ? AND author = ? AND deleted IS NULL AND sys IS NULL AND ts > ?', conv, t.id, t0 - window);
        for (const m of gone) {
          db.run('UPDATE messages SET deleted = ? WHERE id = ?', t0, m.id);
          hub.toConv(conv, 'msg.del', { conv, id: m.id });
        }
        deleted += gone.length;
      }
    }
    if (M.isMember(h.id, t.id)) {
      notice(t.id, { house: h.id, name: h.name, action: 'ban', reason });
      removeMember(h.id, t.id);
    }
    audit(h.id, c.user, 'member.ban', t.id, { reason, deleted });
    return { deleted };
  };

  ops['mod.unban'] = (c, d) => {
    const h = houseRow(d.house);
    need(c.user, h.id, 'ban', 'unban people');
    const t = userRow(d.user);
    slow('mod', c.user);
    if (db.run('DELETE FROM bans WHERE house = ? AND user = ?', h.id, t.id).changes) audit(h.id, c.user, 'member.unban', t.id, null);
    return {};
  };

  ops['mod.bans'] = (c, d) => {
    const h = houseRow(d.house);
    need(c.user, h.id, 'ban', 'see bans');
    const rows = db.all('SELECT user, by, reason, ts FROM bans WHERE house = ? ORDER BY ts DESC LIMIT 500', h.id);
    const ids = [...rows.map((r) => r.user), ...rows.map((r) => r.by)];
    return { bans: rows, users: Object.fromEntries(ids.map((u) => [u, M.hiddenView(M.userRow(u))]).filter(([, v]) => v)) };
  };

  ops['mod.timeout'] = (c, d) => {
    const { h, t } = target(c, d, 'timeout', 'time people out');
    if (!M.isMember(h.id, t.id)) fail(`${t.name} isn’t in this house.`);
    const ms = d.ms === 0 ? 0 : oneOf(d.ms, values(TIMEOUTS), 'That length');
    const reason = reasonOf(d);
    if (ms) {
      db.run(`INSERT INTO timeouts (house, user, until, by, reason) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (house, user) DO UPDATE SET until = excluded.until, by = excluded.by, reason = excluded.reason`, h.id, t.id, Date.now() + ms, c.user, reason);
      hub.leaveVoiceInHouse(t.id, h.id);
      notice(t.id, { house: h.id, name: h.name, action: 'timeout', reason, ms });
      audit(h.id, c.user, 'member.timeout', t.id, { ms, reason });
    } else if (db.run('DELETE FROM timeouts WHERE house = ? AND user = ?', h.id, t.id).changes) {
      audit(h.id, c.user, 'member.untimeout', t.id, null);
    }
    hub.houseChanged(h.id);
    return {};
  };

  // Voice: mute and deafen hold across rejoining until a moderator lifts them.
  ops['mod.voice'] = (c, d) => {
    const { h, t } = target(c, d, 'voicemod', 'moderate voice');
    if (!M.isMember(h.id, t.id)) fail(`${t.name} isn’t in this house.`);
    const cur = db.get('SELECT mute, deaf FROM voice_mod WHERE house = ? AND user = ?', h.id, t.id) || { mute: 0, deaf: 0 };
    const mute = d.mute === undefined ? !!cur.mute : (typeof d.mute === 'boolean' ? d.mute : fail('Mute is yes or no.'));
    const deaf = d.deaf === undefined ? !!cur.deaf : (typeof d.deaf === 'boolean' ? d.deaf : fail('Deafen is yes or no.'));
    if (mute || deaf) {
      db.run(`INSERT INTO voice_mod (house, user, mute, deaf) VALUES (?, ?, ?, ?)
        ON CONFLICT (house, user) DO UPDATE SET mute = excluded.mute, deaf = excluded.deaf`, h.id, t.id, mute ? 1 : 0, deaf ? 1 : 0);
    } else db.run('DELETE FROM voice_mod WHERE house = ? AND user = ?', h.id, t.id);
    const place = hub.voicePlaceOf?.(t.id);
    if (place && M.room(place)?.house === h.id) hub.voiceState(t.id, voiceFlags(mute, deaf));
    if (mute !== !!cur.mute) audit(h.id, c.user, mute ? 'voice.mute' : 'voice.unmute', t.id, null);
    if (deaf !== !!cur.deaf) audit(h.id, c.user, deaf ? 'voice.deafen' : 'voice.undeafen', t.id, null);
    return { mute, deaf };
  };
  // Where someone is talking, for moving and disconnecting: a voice room in this house.
  function inVoiceHere(c, d) {
    const t = userRow(d.user);
    const place = hub.voicePlaceOf?.(t.id);
    const room = place && M.room(place);
    if (!room) fail(`${t.name} isn’t in a voice room.`);
    target(c, { house: room.house, user: t.id }, 'voicemod', 'moderate voice');
    return { t, room };
  }
  ops['mod.move'] = (c, d) => {
    const { t, room } = inVoiceHere(c, d);
    const to = M.room(id(d.room, 'room'));
    if (!to || to.house !== room.house || to.kind !== 'voice') fail('Pick a voice room in the same house.');
    if (to.id === room.id) return {};
    hub.voiceLeave(t.id);
    hub.toUser(t.id, 'voice.moved', { room: room.id, to: to.id, name: to.name });
    audit(room.house, c.user, 'voice.move', t.id, { from: room.name, to: to.name, fromId: room.id, toId: to.id });
    return {};
  };
  ops['mod.disconnect'] = (c, d) => {
    const { t, room } = inVoiceHere(c, d);
    hub.toUser(t.id, 'voice.kicked', { room: room.id, reason: 'moderator' });
    hub.voiceLeave(t.id);
    audit(room.house, c.user, 'voice.disconnect', t.id, { room: room.name, roomId: room.id });
    return {};
  };

  // ---------- Reports and the moderation queue ----------
  ops['report.create'] = (c, d) => {
    const reason = oneOf(d.reason, values(REPORT_REASONS), 'The reason');
    const note = text(d.note, 500, 'The note');
    let house, user, msg = null, conv = null, body = '';
    if (d.msg !== undefined) {
      conv = id(d.conv, 'conversation');
      if (!M.canRead(c.user, conv)) fail('You don’t have access to this conversation.');
      const row = M.liveMsg(id(d.msg, 'message'));
      if (!row || row.conv !== conv) fail('That message was deleted.');
      if (row.sys) fail('Call records can’t be reported.');
      if (row.author === c.user) fail('That’s your own message.');
      house = R.houseOf(conv);
      if (!house) fail('Reports go to a house’s moderators. In a direct conversation, block the person instead.');
      user = row.author;
      msg = row.id;
      body = row.text;
    } else {
      house = houseRow(d.house).id;
      member(c.user, house);
      user = userRow(d.user).id;
      if (user === c.user) fail('You can’t report yourself.');
      if (!M.isMember(house, user)) fail('That person isn’t in this house.');
    }
    const dup = msg
      ? db.get("SELECT 1 FROM reports WHERE by = ? AND msg = ? AND status = 'open'", c.user, msg)
      : db.get("SELECT 1 FROM reports WHERE by = ? AND user = ? AND msg IS NULL AND house = ? AND status = 'open'", c.user, user, house);
    if (dup) fail('You’ve already reported this. The moderators will look at it.');
    slow('report', c.user);
    return { id: fileReport({ house, by: c.user, user, msg, conv, body, reason, note }) };
  };

  ops['report.list'] = (c, d) => {
    const h = houseRow(d.house);
    need(c.user, h.id, 'moderate', 'see reports');
    const open = d.status !== 'closed';
    // Reports from rooms this moderator can't see aren't theirs to read.
    const rows = db.all(`SELECT * FROM reports WHERE house = ? AND ${open ? "status = 'open'" : "status != 'open'"} ORDER BY ts DESC LIMIT 1000`, h.id)
      .filter((r) => R.seesConv(c.user, h.id, r.conv)).slice(0, 200);
    const ids = rows.flatMap((r) => [r.by, r.user, r.handled_by]).filter(Boolean);
    return {
      reports: rows.map((r) => ({
        id: r.id, by: r.by, user: r.user, msg: r.msg, conv: r.conv, text: r.text, reason: r.reason, note: r.note, ts: r.ts,
        status: r.status, handledBy: r.handled_by, handledTs: r.handled_ts, live: !!(r.msg && M.liveMsg(r.msg)),
      })),
      users: Object.fromEntries(ids.map((u) => [u, hub.userView(u)]).filter(([, v]) => v)),
    };
  };

  ops['report.resolve'] = (c, d) => {
    const r = db.get('SELECT * FROM reports WHERE id = ?', id(d.id, 'report')) || fail('That report doesn’t exist.');
    need(c.user, r.house, 'moderate', 'handle reports');
    if (!R.seesConv(c.user, r.house, r.conv)) fail('That report doesn’t exist.');
    const status = oneOf(d.status, ['resolved', 'dismissed', 'open'], 'That status');
    db.run('UPDATE reports SET status = ?, handled_by = ?, handled_ts = ? WHERE id = ?', status, status === 'open' ? null : c.user, status === 'open' ? null : Date.now(), r.id);
    audit(r.house, c.user, `report.${status}`, r.user, { reason: r.reason });
    for (const u of R.mods(r.house)) if (R.seesConv(u, r.house, r.conv)) hub.sendHouse(u, r.house);
    return {};
  };

  // ---------- The house log ----------
  ops['audit.list'] = (c, d) => {
    const h = houseRow(d.house);
    need(c.user, h.id, 'audit', 'see the house log');
    const where = ['house = ?'];
    const params = [h.id];
    if (d.action != null) { where.push('action LIKE ?'); params.push(`${text(d.action, 40, 'The kind of change').replace(/[^\w.]/g, '')}%`); }
    if (d.actor != null) { where.push('actor = ?'); params.push(id(d.actor, 'person')); }
    if (d.before != null) { where.push('id < ?'); params.push(Number.isSafeInteger(d.before) ? d.before : fail('That page isn’t valid.')); }
    const rows = db.all(`SELECT * FROM audit WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${AUDIT_PAGE + 1}`, ...params);
    const more = rows.length > AUDIT_PAGE;
    const list = rows.slice(0, AUDIT_PAGE).map((r) => ({ id: r.id, ts: r.ts, actor: r.actor, action: r.action, target: r.target, detail: redact(c.user, h.id, r) }));
    const people = list.flatMap((r) => [r.actor, r.target]).filter(Boolean);
    return { entries: list, more, users: Object.fromEntries(people.map((u) => [u, M.hiddenView(M.userRow(u))]).filter(([, v]) => v)) };
  };

  // What a log entry says about a room or a message, for this viewer: the
  // room's name and a deleted message's words only for people who can see
  // that room (owners always). Older entries that don't say where are for owners.
  const ROOM_FIELDS = ['name', 'hook', 'from', 'to', 'room', 'text'];
  function redact(viewer, house, r) {
    const d = json(r.detail, null);
    if (!d) return d;
    const owner = M.isOwner(viewer, house);
    let places = null;
    if (r.action === 'msg.delete') places = d.conv ? [d.conv] : null;
    else if (r.action === 'voice.move') places = d.fromId ? [d.fromId, d.toId] : null;
    else if (r.action === 'voice.disconnect') places = d.roomId ? [d.roomId] : null;
    else if (/^(room|hook)\./.test(r.action)) places = [r.target];
    else return d;
    const ok = owner || (places && places.every((p) => R.seesConv(viewer, house, p)));
    if (ok) return d;
    const out = { ...d, hidden: true };
    for (const k of ROOM_FIELDS) if (k in out) out[k] = k === 'text' ? '' : k === 'hook' ? 'a webhook' : 'a private room';
    delete out.conv;
    return out;
  }

  // Changes made through other ops, recorded after they succeed.
  const logged = (name, fn) => wrap(name, (c, d, base) => {
    const before = fn.before ? fn.before(c, d) : null;
    const r = base(c, d);
    try { const e = fn(c, d, r, before); if (e) audit(e.house, c.user, e.action || name, e.target ?? null, e.detail ?? null); } catch { /* the change stands */ }
    return r;
  });
  logged('house.update', (c, d) => ({ house: d.house, detail: { fields: Object.keys(d).filter((k) => k !== 'house') } }));
  logged('room.create', (c, d, r) => ({ house: d.house, target: r?.id, detail: { name: d.name, kind: d.kind } }));
  const roomBefore = (c, d) => (typeof d.room === 'string' ? M.room(d.room) : null);
  const roomEntry = Object.assign((c, d, r, before) => before && ({ house: before.house, target: before.id, detail: { name: d.name ?? before.name } }), { before: roomBefore });
  logged('room.update', roomEntry);
  logged('room.delete', Object.assign((c, d, r, before) => before && ({ house: before.house, target: before.id, detail: { name: before.name } }), { before: roomBefore }));
  logged('role.create', (c, d, r) => ({ house: d.house, target: r?.id, detail: null }));
  logged('role.update', (c, d) => ({ house: d.house, target: d.role, detail: { name: d.name, perms: d.perms } }));
  logged('role.delete', (c, d) => ({ house: d.house, target: d.role, detail: null }));
  logged('member.role', (c, d) => ({ house: d.house, target: d.user, detail: { role: d.role } }));
  logged('member.remove', Object.assign((c, d, r, was) => was && ({ house: d.house, action: 'member.kick', target: d.user, detail: null }), {
    before: (c, d) => typeof d.house === 'string' && typeof d.user === 'string' && M.isMember(d.house, d.user),
  }));
  logged('msg.delete', Object.assign((c, d, r, row) => row && row.author !== c.user && R.houseOf(row.conv) && ({
    house: R.houseOf(row.conv), action: 'msg.delete', target: row.author, detail: { text: (row.text || '').slice(0, 200), conv: row.conv },
  }), { before: (c, d) => (typeof d.id === 'string' ? M.liveMsg(d.id) : null) }));
  for (const name of ['emoji.add', 'emoji.rename', 'emoji.remove']) {
    logged(name, (c, d, r) => ({ house: d.house || (typeof d.id === 'string' ? db.get('SELECT house FROM house_emoji WHERE id = ?', d.id)?.house : null) || r?.emoji?.house, detail: { name: d.name } }));
  }

  // The role hierarchy on member and role management, checked before the base
  // op: someone who isn't an owner may only change people and roles below
  // their own best role, and may only hand out roles below it.
  const ranked = (c, d, { user, role }) => {
    if (typeof d.house !== 'string' || !M.isMember(d.house, c.user) || M.isOwner(c.user, d.house)) return;
    if (user && typeof d.user === 'string' && d.user !== c.user && M.isMember(d.house, d.user) && !R.outranks(d.house, c.user, d.user)) {
      fail(M.isOwner(d.user, d.house) ? 'Only an owner can do that to an owner.' : `${first(d.user)}’s role is the same as yours or above it.`);
    }
    if (user && (typeof d.user !== 'string' || !M.isMember(d.house, d.user))) return; // the op says who isn't here
    const roles = R.roles(d.house);
    // The owner role has its own rule in the op ("Only an owner can...").
    if (role && typeof d.role === 'string' && roles.some((r, i) => i > 0 && r.id === d.role) && !M.roleBelow(d.house, c.user, d.role)) {
      fail('You can only change roles below your own.');
    }
  };
  wrap('member.role', (c, d, base) => { ranked(c, d, { user: true, role: true }); return base(c, d); });
  wrap('member.remove', (c, d, base) => { ranked(c, d, { user: true }); return base(c, d); });
  wrap('role.update', (c, d, base) => { ranked(c, d, { role: true }); return base(c, d); });
  wrap('role.delete', (c, d, base) => { ranked(c, d, { role: true }); return base(c, d); });

  // Ops other modules add after this one (server/ops.js calls this last):
  // their changes to roles, rooms, access and the house go in the log too.
  M.auditLate = () => {
    const roomOf = (d) => (typeof d.room === 'string' ? M.room(d.room) : null);
    const inRoom = (fn) => Object.assign((c, d, r, room) => room && { house: room.house, target: room.id, detail: { name: room.name, ...fn(d) } }, { before: (c, d) => roomOf(d) });
    logged('role.move', (c, d) => ({ house: d.house, target: d.role, detail: { index: d.index } }));
    logged('member.roles', (c, d) => ({ house: d.house, target: d.user, detail: { roles: Array.isArray(d.roles) ? d.roles.slice(0, 20) : [] } }));
    // Which of the nickname, picture and colour changed, and the nickname after.
    const profileOf = (d) => db.get('SELECT nick, emoji, hue FROM member_profiles WHERE house = ? AND user = ?', d.house, d.user) || { nick: null, emoji: null, hue: null };
    logged('member.profile', Object.assign((c, d, r, was) => {
      if (!was) return null;
      const now = profileOf(d);
      const fields = ['nick', 'emoji', 'hue'].filter((k) => (now[k] ?? null) !== (was[k] ?? null));
      return fields.length ? { house: d.house, target: d.user, detail: { fields, nick: now.nick ?? null } } : null;
    }, { before: (c, d) => typeof d.house === 'string' && typeof d.user === 'string' && d.user !== c.user && profileOf(d) }));
    logged('room.private', inRoom((d) => ({ on: !!d.on })));
    logged('room.override', inRoom((d) => ({ type: d.type })));
    logged('room.voice', inRoom((d) => ({ limit: d.limit, bitrate: d.bitrate })));
    logged('forum.tags', Object.assign((c, d, r, room) => room && { house: room.house, action: 'room.tags', target: room.id, detail: { name: room.name } }, { before: (c, d) => roomOf(d) }));
    logged('hook.create', inRoom((d) => ({ hook: typeof d.name === 'string' ? d.name.slice(0, 40) : 'Webhook' })));
    const hookRoom = (c, d) => (typeof d.hook === 'string' ? M.room(db.get('SELECT room FROM hooks WHERE id = ?', d.hook)?.room) : null);
    logged('hook.delete', Object.assign((c, d, r, room) => room && { house: room.house, target: room.id, detail: { name: room.name } }, { before: hookRoom }));
    logged('hook.regen', Object.assign((c, d, r, room) => room && { house: room.house, target: room.id, detail: { name: room.name } }, { before: hookRoom }));
    logged('onboard.set', (c, d) => ({ house: d.house, action: 'house.welcome', detail: null }));
    logged('house.soundboard', (c, d) => ({ house: d.house, detail: { open: !!d.open } }));
    logged('sound.add', (c, d) => ({ house: d.house, detail: { name: d.name } }));
    const soundHouse = (c, d) => (typeof d.id === 'string' ? db.get('SELECT house, name FROM house_sounds WHERE id = ?', d.id) : null);
    logged('sound.edit', Object.assign((c, d, r, s) => s && { house: s.house, detail: { name: d.name ?? s.name } }, { before: soundHouse }));
    logged('sound.remove', Object.assign((c, d, r, s) => s && { house: s.house, detail: { name: s.name } }, { before: soundHouse }));
    logged('sticker.add', (c, d) => ({ house: d.house, detail: { name: d.name } }));
    const stickerHouse = (c, d) => (typeof d.id === 'string' ? db.get('SELECT house, name FROM house_stickers WHERE id = ?', d.id) : null);
    logged('sticker.remove', Object.assign((c, d, r, s) => s && { house: s.house, detail: { name: s.name } }, { before: stickerHouse }));

    // A timeout takes away everything but reading and leaving: no pinning,
    // managing rooms, roles, webhooks, events, invites, emoji or members, and no
    // moderating others, whatever the person's role (writing, reacting and voice
    // are stopped above). Wrapped last so it holds over every module's version.
    const str = (v) => (typeof v === 'string' ? v : null);
    const byId = (table) => (d) => (str(d.id) ? db.get(`SELECT house FROM ${table} WHERE id = ?`, d.id)?.house : null);
    const houseOfOp = (d) => str(d.house) || M.room(str(d.room) || '')?.house || R.houseOf(str(d.conv))
      || (str(d.hook) ? db.get('SELECT house FROM hooks WHERE id = ?', d.hook)?.house : null)
      || (str(d.event) ? M.eventRow?.(d.event)?.house : null) || null;
    const custom = {
      'forum.edit': (d) => M.room(str(d.id) ? db.get('SELECT room FROM forum_posts WHERE msg = ?', d.id)?.room || '' : '')?.house,
      'emoji.rename': byId('house_emoji'), 'emoji.remove': byId('house_emoji'),
      'sticker.remove': byId('house_stickers'), 'sound.edit': byId('house_sounds'), 'sound.remove': byId('house_sounds'),
      'sound.play': byId('house_sounds'),
      'invite.revoke': (d) => (str(d.code) ? db.get('SELECT house FROM invites WHERE code = ?', d.code)?.house : null),
    };
    const NO_TIMEOUT = {
      'msg.pin': 'pin messages', 'msg.unpin': 'unpin messages', 'msg.restore': 'bring messages back', 'highlight.set': 'curate highlights',
      'forum.edit': 'change posts', 'forum.tags': 'change tags', 'member.profile': 'change your profile here',
      'hook.create': 'manage webhooks', 'hook.regen': 'manage webhooks', 'hook.delete': 'manage webhooks',
      'news.follow': 'follow notice rooms', 'news.unfollow': 'follow notice rooms',
      'event.create': 'plan events', 'event.delete': 'cancel events',
      'room.create': 'manage rooms', 'room.update': 'manage rooms', 'room.delete': 'manage rooms', 'room.override': 'manage rooms',
      'room.private': 'manage rooms', 'room.voice': 'manage rooms', 'room.slowmode': 'manage rooms',
      'invite.create': 'invite people', 'invite.user': 'invite people', 'invite.revoke': 'manage invitations',
      'house.update': 'change the house', 'house.screening': 'change the house', 'house.soundboard': 'change the house', 'onboard.set': 'change the house',
      'emoji.add': 'manage emoji', 'emoji.rename': 'manage emoji', 'emoji.remove': 'manage emoji',
      'sticker.add': 'manage stickers', 'sticker.remove': 'manage stickers',
      'sound.add': 'manage sounds', 'sound.edit': 'manage sounds', 'sound.remove': 'manage sounds', 'sound.play': 'play sounds',
      'role.create': 'manage roles', 'role.update': 'manage roles', 'role.delete': 'manage roles', 'role.move': 'manage roles',
      'member.role': 'manage members', 'member.roles': 'manage members', 'member.remove': 'remove people',
      'mod.kick': 'moderate', 'mod.ban': 'moderate', 'mod.unban': 'moderate', 'mod.timeout': 'moderate', 'mod.voice': 'moderate',
      'mod.move': 'moderate', 'mod.disconnect': 'moderate', 'automod.set': 'change the filter', 'report.resolve': 'resolve reports',
    };
    for (const [name, what] of Object.entries(NO_TIMEOUT)) {
      if (!ops[name]) continue;
      wrap(name, (c, d, base) => {
        let house = null;
        try { house = (custom[name] || houseOfOp)(d); } catch { house = null; }
        // mod.move and mod.disconnect name a person in a voice room, not a house.
        if (!house && (name === 'mod.move' || name === 'mod.disconnect') && str(d.user)) house = M.room(hub.voicePlaceOf?.(d.user) || '')?.house;
        if (house && M.isMember(house, c.user) && R.timeout(house, c.user)) guard(c.user, house, what);
        return base(c, d);
      });
    }
    // Deleting someone else's message is moderating; your own stays yours to delete.
    wrap('msg.delete', (c, d, base) => {
      const row = str(d.id) ? M.liveMsg(d.id) : null;
      const house = row && row.author !== c.user ? R.houseOf(row.conv) : null;
      if (house && M.isMember(house, c.user) && R.timeout(house, c.user)) guard(c.user, house, 'remove other people’s messages');
      return base(c, d);
    });
  };

  // ---------- Slowmode, the filter, screening ----------
  ops['room.slowmode'] = (c, d) => {
    const room = M.room(id(d.room, 'room')) || fail('That room doesn’t exist.');
    need(c.user, room.house, 'rooms', 'change slowmode');
    const seconds = oneOf(d.seconds, SLOWMODES, 'That slowmode');
    slow('settings', c.user);
    db.run('UPDATE rooms SET slowmode = ? WHERE id = ?', seconds, room.id);
    audit(room.house, c.user, 'room.slowmode', room.id, { name: room.name, seconds });
    hub.houseChanged(room.house);
    return {};
  };

  ops['automod.get'] = (c, d) => {
    const h = houseRow(d.house);
    need(c.user, h.id, 'roles', 'change the word filter');
    return R.automod(h.id) || { words: [], links: false, action: 'block', timeoutMs: 5 * 60_000, exempt: [] };
  };
  ops['automod.set'] = (c, d) => {
    const h = houseRow(d.house);
    need(c.user, h.id, 'roles', 'change the word filter');
    const cur = R.automod(h.id) || { words: [], links: false, action: 'block', timeoutMs: 5 * 60_000, exempt: [] };
    let words = cur.words;
    if (d.words !== undefined) {
      if (!Array.isArray(d.words) || d.words.length > MAX_WORDS) fail(`The filter holds up to ${MAX_WORDS} words.`);
      words = [...new Set(d.words.map((w) => cleanWord(w) || fail(`“${String(w).slice(0, 40)}” can’t be filtered. Use letters and numbers, up to 40 characters.`)))];
    }
    const links = d.links === undefined ? cur.links : (typeof d.links === 'boolean' ? d.links : fail('Links is yes or no.'));
    const action = d.action === undefined ? cur.action : oneOf(d.action, values(FILTER_ACTIONS), 'That action');
    const timeoutMs = d.timeoutMs === undefined ? cur.timeoutMs : oneOf(d.timeoutMs, values(TIMEOUTS), 'That length');
    const roles = R.roles(h.id).map((r) => r.id);
    const exempt = d.exempt === undefined ? cur.exempt.filter((r) => roles.includes(r))
      : (Array.isArray(d.exempt) ? [...new Set(d.exempt)].map((r) => oneOf(r, roles, 'That role')) : fail('Exempt roles are missing.'));
    slow('settings', c.user);
    db.run(`INSERT INTO automod (house, words, links, action, timeout_ms, exempt) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (house) DO UPDATE SET words = excluded.words, links = excluded.links, action = excluded.action, timeout_ms = excluded.timeout_ms, exempt = excluded.exempt`,
    h.id, JSON.stringify(words), links ? 1 : 0, action, timeoutMs, JSON.stringify(exempt));
    audit(h.id, c.user, 'automod.update', null, { words: words.length, links, action });
    return { words, links, action, timeoutMs, exempt };
  };

  ops['house.screening'] = (c, d) => {
    const h = houseRow(d.house);
    need(c.user, h.id, 'roles', 'change member screening');
    if (typeof d.on !== 'boolean') fail('Screening is on or off.');
    if (d.on && !(h.rules || '').trim()) fail('Write the house rules first, then turn on screening.');
    slow('settings', c.user);
    db.tx(() => {
      db.run('UPDATE houses SET screening = ? WHERE id = ?', d.on ? 1 : 0, h.id);
      // Everyone already here counts as having accepted; screening is for newcomers.
      if (d.on && !h.screening) {
        const t = Date.now();
        for (const r of db.all('SELECT user FROM members WHERE house = ?', h.id)) db.run('INSERT OR IGNORE INTO rule_accepts (house, user, ts) VALUES (?, ?, ?)', h.id, r.user, t);
      }
    });
    audit(h.id, c.user, 'house.screening', null, { on: d.on });
    hub.houseChanged(h.id);
    return {};
  };
  ops['rules.accept'] = (c, d) => {
    const h = houseRow(d.house);
    member(c.user, h.id);
    db.run('INSERT OR IGNORE INTO rule_accepts (house, user, ts) VALUES (?, ?, ?)', h.id, c.user, Date.now());
    hub.sendHouse(c.user, h.id);
    return {};
  };
  // A newcomer to a screening house starts without having accepted.
  for (const name of ['invite.accept', 'invite.join', 'house.joinPublic']) {
    const inner = ops[name];
    ops[name] = (c, d) => {
      const before = new Set(M.houseIdsOf(c.user));
      const r = inner(c, d);
      const house = r?.house;
      if (house && !before.has(house)) {
        db.run('DELETE FROM rule_accepts WHERE house = ? AND user = ?', house, c.user);
        if (db.get('SELECT screening FROM houses WHERE id = ?', house)?.screening) hub.sendHouse(c.user, house);
      }
      return r;
    };
  }

  return {};
}
