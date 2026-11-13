// Houses and community, on the server. Every rule here is checked against the
// database; what the browser shows is only a preview of it.
//
// - Categories (room groups): create, rename, delete (rooms move to another
//   group), reorder; rooms move between groups and within one.
// - House pictures: an icon (drawn in the arch), a banner and an invitation
//   background. Type from the bytes, size and pixel limits, served only to
//   people who may see the house.
// - Deleting a house (owners, its exact name, a code with two-factor on) and
//   handing ownership to someone else.
// - Finer permissions: 'house', 'events', 'hooks' and 'react', given once to
//   existing roles from what they replace.
// - Events: editing, a location somewhere else, a cover picture, "interested"
//   beside "going", and reminders 15 minutes before and at the start.
// - Automatic moderation spam rules: mentions, flooding, invitations to other
//   houses, shouting; each with its own action and room exemptions.
// - Verification levels for newcomers, two-factor for moderators, pausing
//   invitations, a custom invitation link, join announcements and a default
//   notification level for new members.
import { writeFile, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { limiter } from './auth.js';
import { newId, now } from './model.js';
import { imageInfo } from './messaging.js';
import { safeLink, LIMITS, eventState } from '../js/lib/social.js';
import { left } from '../js/lib/safety.js';
import { fold } from '../js/lib/util.js';
import { MANAGING } from './places.js';
import {
  GROUP_NAME_MAX, MAX_GROUPS, PICTURES, PICTURE_TYPES, COVER_TYPES, COVER_BYTES, LOCATION_MAX, RSVP_KINDS, REMIND_LEAD,
  VERIFY_IDS, verifyWaitUntil, PAUSE_HOURS, NEVER, vanityProblem, SPAM_ACTION_IDS, SPAM_RULES, SPAM_DEFAULT,
  mentionCount, shouting, inviteCodes, flooding,
} from '../js/lib/community.js';

const json = (s, f) => { try { return s == null ? f : JSON.parse(s); } catch { return f; } };
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const TYPE_NAMES = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WebP', 'image/gif': 'GIF' };

// What each new permission was before it had its own name.
export function backfillPerms(perms) {
  const p = new Set(perms);
  if (p.has('roles')) { p.add('house'); p.add('hooks'); }
  if (p.has('rooms')) p.add('hooks'); // webhooks needed Manage rooms before
  if (p.has('announce') || p.has('rooms')) p.add('events');
  p.add('react');
  return [...p];
}

// --- Schema (called from server/db.js migrate) ---------------------------
export function migrateCommunity(db) {
  const have = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c);
  // Names and types are fixed here, never from input.
  for (const [table, column, type] of [
    ['houses', 'icon', 'TEXT'],
    ['houses', 'banner', 'TEXT'],
    ['houses', 'splash', 'TEXT'],
    ['houses', 'verify', "TEXT NOT NULL DEFAULT 'none'"],
    ['houses', 'mod2fa', 'INTEGER NOT NULL DEFAULT 0'],
    ['houses', 'paused_until', 'INTEGER'],
    ['houses', 'vanity', 'TEXT'],
    ['houses', 'announce_room', 'TEXT'],
    ['houses', 'default_notify', "TEXT NOT NULL DEFAULT 'all'"],
    ['events', 'location', "TEXT NOT NULL DEFAULT ''"],
    ['events', 'cover', 'TEXT'],
    ['events', 'reminded', 'INTEGER NOT NULL DEFAULT 0'],
    ['event_rsvps', 'kind', "TEXT NOT NULL DEFAULT 'going'"],
    ['automod', 'mentions', 'INTEGER NOT NULL DEFAULT 0'],
    ['automod', 'mentions_action', "TEXT NOT NULL DEFAULT 'block'"],
    ['automod', 'flood', 'INTEGER NOT NULL DEFAULT 0'],
    ['automod', 'flood_action', "TEXT NOT NULL DEFAULT 'timeout'"],
    ['automod', 'invites', 'INTEGER NOT NULL DEFAULT 0'],
    ['automod', 'invites_action', "TEXT NOT NULL DEFAULT 'block'"],
    ['automod', 'caps', 'INTEGER NOT NULL DEFAULT 0'],
    ['automod', 'caps_action', "TEXT NOT NULL DEFAULT 'flag'"],
    ['automod', 'exempt_rooms', "TEXT NOT NULL DEFAULT '[]'"],
    // 1 once a role has the new permissions worked out. Roles written before
    // (an older database, or the sample data) are 0 until the next start.
    ['roles', 'perms_v', 'INTEGER NOT NULL DEFAULT 0'],
  ]) if (!have(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS houses_vanity ON houses(vanity) WHERE vanity IS NOT NULL');
  // The new permissions, once per role, from the ones they replace: nobody
  // loses anything they could do the day before.
  for (const r of db.prepare('SELECT id, perms FROM roles WHERE perms_v = 0').all()) {
    db.prepare('UPDATE roles SET perms = ?, perms_v = 1 WHERE id = ?').run(JSON.stringify(backfillPerms(json(r.perms, []))), r.id);
  }
}

export function createCommunityOps({ db, M, hub, fail, ops }) {
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
  const oneOf = (v, list, name) => (list.includes(v) ? v : fail(`${name} isn’t one of the choices.`));
  const houseRow = (v) => db.get('SELECT * FROM houses WHERE id = ?', id(v, 'house')) || fail('That house doesn’t exist.');
  const roomRow = (v) => M.room(id(v, 'room')) || fail('That room doesn’t exist.');
  const member = (user, house) => (M.isMember(house, user) ? true : fail('You’re not a member of that house.'));
  const need = (user, house, perm, what) => { member(user, house); if (!M.can(user, house, perm)) fail(`Your role can’t ${what} in this house.`); };
  const str0 = (v) => (typeof v === 'string' ? v : null);
  const timedOut = (house, user) => db.get('SELECT until FROM timeouts WHERE house = ? AND user = ? AND until > ?', house, user, Date.now());
  const notTimedOut = (house, user, what) => {
    const t = timedOut(house, user);
    if (t) fail(`You’re timed out here for ${left(t.until - Date.now())}, so you can’t ${what} yet.`);
  };
  function audit(house, actor, action, target = null, detail = null) {
    db.run('INSERT INTO audit (house, ts, actor, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)',
      house, Date.now(), actor, action, target, detail ? JSON.stringify(detail) : null);
  }

  // ---------- Rate limits ----------
  const limits = {
    write: limiter({ capacity: 30, perSecond: 1 }),
    settings: limiter({ capacity: 20, perSecond: 0.5 }),
    danger: limiter({ capacity: 5, perSecond: 1 / 30 }),
    vanity: limiter({ capacity: 3, perSecond: 3 / 3600 }),
    announce: limiter({ capacity: 10, perSecond: 1 / 60 }),
    events: limiter({ capacity: 20, perSecond: 0.5 }),
  };
  (hub.extraLimits ||= []).push(...Object.values(limits));
  const slow = (bucket, key) => { if (!limits[bucket].take(key)) fail('You’re going a little fast. Wait a moment and try again.'); };

  // ---------- Acting with an older permission's name ----------
  // The base ops check the permission each new one replaced ('roles' for the
  // house, 'announce' for events). After this module has checked the new
  // one, the base op runs as if the person had the old one, for that call only.
  let grant = null;
  const baseCan = M.can;
  M.can = (u, h, p) => (!!grant && grant.user === u && grant.house === h && grant.perms.includes(p)) || baseCan(u, h, p);
  const asIf = (user, house, perms, fn) => {
    const was = grant;
    grant = { user, house, perms };
    try { return fn(); } finally { grant = was; }
  };
  const wrap = (name, fn) => { const base = ops[name]; if (base) ops[name] = (c, d) => fn(c, d, base); };
  const houseOfConv = (conv) => {
    if (typeof conv !== 'string') return null;
    const w = M.where(conv);
    if (w) return w.house || null;
    if (conv.startsWith('t:')) return M.where(M.liveMsg(conv.slice(2))?.conv || '')?.house || null;
    return null;
  };
  const roomOfConv = (conv) => {
    if (typeof conv !== 'string') return null;
    const w = M.where(conv) || (conv.startsWith('t:') ? M.where(M.liveMsg(conv.slice(2))?.conv || '') : null);
    return w?.room || null;
  };

  // ---------- Finer permissions ----------
  for (const name of ['house.update', 'house.screening', 'onboard.set']) {
    wrap(name, (c, d, base) => {
      const h = houseRow(d.house);
      need(c.user, h.id, 'house', 'change house settings');
      return asIf(c.user, h.id, ['roles'], () => base(c, d));
    });
  }
  wrap('house.soundboard', (c, d, base) => {
    const h = typeof d.house === 'string' ? d.house : '';
    if (M.isMember(h, c.user) && !M.can(c.user, h, 'sounds') && M.can(c.user, h, 'house')) return asIf(c.user, h, ['sounds'], () => base(c, d));
    return base(c, d);
  });
  // Webhooks and followed notices: 'hooks' in the room's house, as well as managing the room.
  const hookHouse = {
    'hook.create': (d) => M.room(str0(d.room) || '')?.house,
    'hook.list': (d) => M.room(str0(d.room) || '')?.house,
    'hook.regen': (d) => (str0(d.hook) ? db.get('SELECT house FROM hooks WHERE id = ?', d.hook)?.house : null),
    'hook.delete': (d) => (str0(d.hook) ? db.get('SELECT house FROM hooks WHERE id = ?', d.hook)?.house : null),
    'news.follow': (d) => M.room(str0(d.target) || '')?.house,
    'news.unfollow': (d) => (str0(d.hook) ? db.get('SELECT house FROM hooks WHERE id = ?', d.hook)?.house : null),
  };
  for (const [name, houseOf] of Object.entries(hookHouse)) {
    wrap(name, (c, d, base) => {
      const h = houseOf(d);
      if (h && M.isMember(h, c.user) && !M.can(c.user, h, 'hooks')) fail('Your role can’t manage webhooks in this house.');
      return base(c, d);
    });
  }
  // New houses and roles start with reactions (and, from a template, the
  // permissions each role's old ones stood for). A copied house keeps its roles as they were.
  wrap('house.create', (c, d, base) => {
    const r = base(c, d);
    if (r?.house && d.from === undefined) {
      for (const role of db.all('SELECT id, perms FROM roles WHERE house = ? AND pos > 0', r.house)) {
        db.run('UPDATE roles SET perms = ? WHERE id = ?', JSON.stringify(backfillPerms(json(role.perms, []))), role.id);
      }
      hub.sendHouse(c.user, r.house);
    }
    if (r?.house) db.run('UPDATE roles SET perms_v = 1 WHERE house = ?', r.house);
    return r;
  });
  wrap('role.create', (c, d, base) => {
    const r = base(c, d);
    if (r?.id) {
      const row = db.get('SELECT perms FROM roles WHERE id = ?', r.id);
      const p = json(row?.perms, []);
      db.run('UPDATE roles SET perms = ?, perms_v = 1 WHERE id = ?', JSON.stringify(p.includes('react') ? p : [...p, 'react']), r.id);
      if (!p.includes('react')) hub.houseChanged(d.house);
    }
    return r;
  });

  // ---------- Verification ----------
  const exemptFromVerify = (user, house) => M.isOwner(user, house) || ['moderate', 'house', 'roles', 'kick', 'ban', 'timeout'].some((p) => M.can(user, house, p));
  // When this person may take part here, or 0.
  M.verifyWait = (user, house) => {
    const h = db.get('SELECT verify FROM houses WHERE id = ?', house);
    if (!h || h.verify === 'none' || !VERIFY_IDS.includes(h.verify)) return 0;
    if (exemptFromVerify(user, house)) return 0;
    const u = M.userRow(user);
    const m = db.get('SELECT joined FROM members WHERE house = ? AND user = ?', house, user);
    const until = verifyWaitUntil(h.verify, { account: u?.created || 0, joined: m?.joined || 0 });
    return until > Date.now() ? until : 0;
  };
  const verifyGate = (user, house, what) => {
    const until = M.verifyWait(user, house);
    if (until) {
      const name = db.get('SELECT name FROM houses WHERE id = ?', house)?.name || 'This house';
      fail(`${name} asks newcomers to wait a little before they ${what}. You can in ${left(until - Date.now())}.`);
    }
  };

  // ---------- Automatic moderation: spam rules ----------
  const recent = new Map(); // `${house}\n${user}` -> [{ ts, text }], the last 30 seconds
  const spamCfg = (house) => {
    const a = db.get('SELECT * FROM automod WHERE house = ?', house);
    if (!a) return { ...SPAM_DEFAULT, exempt: [] };
    return {
      mentions: a.mentions || 0, mentionsAction: a.mentions_action, flood: a.flood || 0, floodAction: a.flood_action,
      invites: !!a.invites, invitesAction: a.invites_action, caps: !!a.caps, capsAction: a.caps_action,
      exemptRooms: json(a.exempt_rooms, []), exempt: json(a.exempt, []),
    };
  };
  M.automodRoomExempt = (house, conv) => {
    const room = roomOfConv(conv);
    return !!room && room.house === house && spamCfg(house).exemptRooms.includes(room.id);
  };
  const exemptFromSpam = (user, house, conv, cfg) => {
    if (M.isOwner(user, house) || M.can(user, house, 'roles')) return true;
    const roles = [db.get('SELECT role FROM members WHERE house = ? AND user = ?', house, user)?.role,
      ...db.all('SELECT role FROM member_roles WHERE house = ? AND user = ?', house, user).map((r) => r.role)];
    if (roles.some((r) => r && cfg.exempt.includes(r))) return true;
    const room = roomOfConv(conv);
    return !!room && cfg.exemptRooms.includes(room.id);
  };
  const otherHouseInvite = (house, code) => {
    const inv = db.get('SELECT house FROM invites WHERE code = ?', code);
    if (inv) return inv.house !== house;
    const v = db.get('SELECT id FROM houses WHERE vanity = ?', code.toLowerCase());
    if (v) return v.id !== house;
    return true; // a link to nowhere here is not this house's either
  };
  const RULE_NOTE = { mentions: 'Too many mentions', flood: 'Flooding', invites: 'An invitation to another house', caps: 'Shouting' };
  const RULE_WHY = {
    mentions: 'That message mentions too many people',
    flood: 'You’re sending messages too quickly',
    invites: 'Invitations to other houses aren’t allowed',
    caps: 'That message is mostly capital letters',
  };
  // Called from the msg.send and msg.edit wrapper (server/safety.js), after
  // the word filter and before anything is stored. Returns a note to flag
  // the message with, or null; fails when a rule blocks it.
  M.spamCheck = (user, house, conv, text, edit = false) => {
    const cfg = spamCfg(house);
    if (!cfg.mentions && !cfg.flood && !cfg.invites && !cfg.caps) return null;
    if (exemptFromSpam(user, house, conv, cfg)) return null;
    const hits = [];
    if (cfg.mentions && mentionCount(text) > cfg.mentions) hits.push(['mentions', cfg.mentionsAction]);
    if (cfg.flood && !edit) {
      const t = Date.now();
      const list = (recent.get(`${house}\n${user}`) || []).filter((r) => r.ts > t - 30_000);
      if (flooding(list, text, t, cfg.flood)) hits.push(['flood', cfg.floodAction]);
    }
    if (cfg.invites && inviteCodes(text).some((code) => otherHouseInvite(house, code))) hits.push(['invites', cfg.invitesAction]);
    if (cfg.caps && shouting(text)) hits.push(['caps', cfg.capsAction]);
    if (!hits.length) return null;
    // The strongest action wins: time out, then block, then flag.
    const rank = { timeout: 2, block: 1, flag: 0 };
    const [rule, action] = hits.sort((a, b) => rank[b[1]] - rank[a[1]])[0];
    audit(house, null, 'automod.hit', user, { rule, action });
    if (action === 'flag') return hits.map(([r]) => RULE_NOTE[r]).join('. ');
    if (action === 'timeout') {
      const ms = db.get('SELECT timeout_ms FROM automod WHERE house = ?', house)?.timeout_ms || 5 * MIN;
      db.run(`INSERT INTO timeouts (house, user, until, by, reason) VALUES (?, ?, ?, 'filter', ?)
        ON CONFLICT (house, user) DO UPDATE SET until = excluded.until, by = excluded.by, reason = excluded.reason`, house, user, Date.now() + ms, 'Spam filter');
      audit(house, null, 'member.timeout', user, { ms, reason: 'Spam filter' });
      hub.leaveVoiceInHouse(user, house);
      hub.houseChanged(house);
      recent.delete(`${house}\n${user}`);
      fail(`${RULE_WHY[rule]}. You’re timed out for ${left(ms)}.`);
    }
    fail(`${RULE_WHY[rule]}, so it wasn’t sent.`);
    return null;
  };
  // A message went out: remember it for the flood rule.
  M.spamSent = (user, house, text) => {
    const key = `${house}\n${user}`;
    const t = Date.now();
    const list = (recent.get(key) || []).filter((r) => r.ts > t - 30_000);
    list.push({ ts: t, text: fold(text || '').trim() });
    recent.set(key, list.slice(-60));
    if (recent.size > 5000) for (const k of [...recent.keys()].slice(0, 1000)) recent.delete(k);
  };
  const spamOut = (cfg) => ({
    mentions: cfg.mentions, mentionsAction: cfg.mentionsAction, flood: cfg.flood, floodAction: cfg.floodAction,
    invites: cfg.invites, invitesAction: cfg.invitesAction, caps: cfg.caps, capsAction: cfg.capsAction, exemptRooms: cfg.exemptRooms,
  });
  wrap('automod.get', (c, d, base) => {
    const r = base(c, d);
    return { ...r, ...spamOut(spamCfg(d.house)) };
  });
  wrap('automod.set', (c, d, base) => {
    const h = houseRow(d.house);
    need(c.user, h.id, 'roles', 'change the word filter');
    const cur = spamCfg(h.id);
    const next = spamOut(cur);
    const action = (k) => (d[k] === undefined ? cur[k] : oneOf(d[k], SPAM_ACTION_IDS, 'That action'));
    const num = (k, rule) => {
      if (d[k] === undefined) return cur[k];
      if (d[k] === 0 || d[k] === false || d[k] === null) return 0;
      if (!Number.isInteger(d[k]) || d[k] < rule.min || d[k] > rule.max) fail(`${rule.label} can be ${rule.min} to ${rule.max}.`);
      return d[k];
    };
    const rule = (rid) => SPAM_RULES.find((r) => r.id === rid);
    next.mentions = num('mentions', rule('mentions'));
    next.flood = num('flood', rule('flood'));
    next.invites = d.invites === undefined ? cur.invites : bool(d.invites, 'Invitations');
    next.caps = d.caps === undefined ? cur.caps : bool(d.caps, 'Shouting');
    for (const k of ['mentionsAction', 'floodAction', 'invitesAction', 'capsAction']) next[k] = action(k);
    const rooms = db.all('SELECT id FROM rooms WHERE house = ?', h.id).map((r) => r.id);
    next.exemptRooms = d.exemptRooms === undefined ? cur.exemptRooms.filter((r) => rooms.includes(r))
      : (Array.isArray(d.exemptRooms) && d.exemptRooms.length <= 200 ? [...new Set(d.exemptRooms)].map((r) => oneOf(r, rooms, 'That room')) : fail('Exempt rooms are missing.'));
    const rest = { ...d };
    for (const k of [...Object.keys(next)]) delete rest[k];
    const r = base(c, rest);
    db.run(`UPDATE automod SET mentions = ?, mentions_action = ?, flood = ?, flood_action = ?, invites = ?, invites_action = ?,
      caps = ?, caps_action = ?, exempt_rooms = ? WHERE house = ?`,
    next.mentions, next.mentionsAction, next.flood, next.floodAction, next.invites ? 1 : 0, next.invitesAction,
    next.caps ? 1 : 0, next.capsAction, JSON.stringify(next.exemptRooms), h.id);
    if (JSON.stringify(next) !== JSON.stringify(spamOut(cur))) {
      audit(h.id, c.user, 'automod.spam', null, { mentions: next.mentions, flood: next.flood, invites: next.invites, caps: next.caps });
    }
    return { ...r, ...next };
  });

  // ---------- Taking part: reactions, verification ----------
  wrap('msg.send', (c, d, base) => {
    const fresh = typeof d.id === 'string' && !M.msg(d.id);
    const house = fresh ? houseOfConv(d.conv) : null;
    if (house && M.isMember(house, c.user)) verifyGate(c.user, house, 'write');
    return base(c, d);
  });
  wrap('react', (c, d, base) => {
    const house = d.on === true ? houseOfConv(d.conv) : null;
    // Someone timed out hears that first (server/safety.js says so, inside).
    if (house && M.isMember(house, c.user) && !timedOut(house, c.user)) {
      if (!M.can(c.user, house, 'react')) fail('Your role can’t add reactions in this house.');
      verifyGate(c.user, house, 'react');
    }
    return base(c, d);
  });
  wrap('voice.join', (c, d, base) => {
    const room = typeof d.room === 'string' ? M.room(d.room) : null;
    if (room && M.isMember(room.house, c.user)) verifyGate(c.user, room.house, 'join voice');
    return base(c, d);
  });

  // ---------- Two-factor for moderators ----------
  const mod2fa = (house, user) => {
    if (!house || !M.isMember(house, user)) return;
    if (!db.get('SELECT mod2fa FROM houses WHERE id = ?', house)?.mod2fa) return;
    if (!M.totpOn?.(user)) fail('This house asks moderators to turn on two-factor sign-in first. It’s in Settings > Account.');
  };
  const voiceHouse = (d) => M.room(hub.voicePlaceOf?.(str0(d.user) || '') || '')?.house || null;
  const MOD_OPS = {
    'mod.kick': (d) => str0(d.house), 'mod.ban': (d) => str0(d.house), 'mod.unban': (d) => str0(d.house),
    'mod.timeout': (d) => str0(d.house), 'mod.voice': (d) => str0(d.house), 'member.remove': (d) => str0(d.house),
    'mod.move': voiceHouse, 'mod.disconnect': voiceHouse,
    'report.resolve': (d) => (str0(d.id) ? db.get('SELECT house FROM reports WHERE id = ?', d.id)?.house : null),
  };
  for (const [name, houseOf] of Object.entries(MOD_OPS)) wrap(name, (c, d, base) => { mod2fa(houseOf(d), c.user); return base(c, d); });
  wrap('msg.delete', (c, d, base) => {
    const row = str0(d.id) ? M.liveMsg(d.id) : null;
    if (row && row.author !== c.user) mod2fa(houseOfConv(row.conv), c.user);
    return base(c, d);
  });

  // ---------- Joining: pause, custom links, announcements, default level ----------
  const paused = (h) => !!h?.paused_until && h.paused_until > Date.now();
  const PAUSED = 'This house has paused new members for now. Try again later.';
  const resolveCode = (code) => {
    if (typeof code !== 'string') return null;
    const inv = /^[\w-]{6,40}$/.test(code) ? db.get('SELECT * FROM invites WHERE code = ?', code) : null;
    if (inv) return { house: inv.house, invite: inv };
    const w = code.toLowerCase();
    if (!vanityProblem(w)) { const h = db.get('SELECT id FROM houses WHERE vanity = ?', w); if (h) return { house: h.id, vanity: w }; }
    return null;
  };
  M.resolveInvite = resolveCode;
  const announceLine = (house, user) => {
    const h = db.get('SELECT announce_room FROM houses WHERE id = ?', house);
    const room = h?.announce_room && M.room(h.announce_room);
    if (!room || room.house !== house || !['text', 'news'].includes(room.kind)) return;
    if (!limits.announce.take(house)) return; // a raid writes a few lines, not hundreds
    const u = M.userRow(user);
    const mid = newId('m');
    const text = `${u?.name || 'Someone'} joined the house.`;
    db.run('INSERT INTO messages (id, conv, author, ts, text, fold, sys) VALUES (?, ?, ?, ?, ?, ?, ?)',
      mid, room.id, user, now(), text, M.foldText(text, []), JSON.stringify({ kind: 'join', user }));
    const [m] = M.withReactions([M.msg(mid)]);
    hub.toConv(room.id, 'msg', { conv: room.id, m, user: hub.userView(user) });
  };
  const welcomed = (house, user) => {
    const h = db.get('SELECT default_notify FROM houses WHERE id = ?', house);
    if (h?.default_notify === 'mentions') {
      db.run("INSERT INTO notify (user, place, level) VALUES (?, ?, 'mentions') ON CONFLICT (user, place) DO NOTHING", user, house);
      hub.sendHouse(user, house);
    }
    announceLine(house, user);
  };
  for (const name of ['invite.accept', 'invite.join', 'house.joinPublic']) {
    wrap(name, (c, d, base) => {
      let house = name === 'invite.accept' ? resolveCode(d.code)?.house : str0(d.house);
      const h = house && db.get('SELECT * FROM houses WHERE id = ?', house);
      const was = !!h && M.isMember(h.id, c.user);
      // Only someone who could otherwise come in hears that the house is paused.
      const could = h && (name === 'invite.accept' || (name === 'house.joinPublic' ? !!h.public : !!db.get('SELECT 1 FROM personal_invites WHERE house = ? AND user = ?', h.id, c.user)));
      if (h && !was && could && paused(h)) fail(PAUSED);
      let r;
      const custom = name === 'invite.accept' && resolveCode(d.code)?.vanity;
      if (custom) {
        if (was) return { house: h.id, starter: json(h.starter, []) };
        // A custom link joins like a personal invitation, so bans, screening and the rest apply as usual.
        const by = db.get('SELECT m.user FROM members m JOIN roles r ON r.id = m.role WHERE m.house = ? ORDER BY r.pos LIMIT 1', h.id)?.user || c.user;
        const had = db.get('SELECT 1 FROM personal_invites WHERE house = ? AND user = ?', h.id, c.user);
        if (!had) db.run('INSERT INTO personal_invites (house, user, by, ts) VALUES (?, ?, ?, ?)', h.id, c.user, by, Date.now());
        try { r = ops['invite.join'](c, { house: h.id }); } catch (e) {
          if (!had) db.run('DELETE FROM personal_invites WHERE house = ? AND user = ?', h.id, c.user);
          throw e;
        }
        audit(h.id, c.user, 'member.join', c.user, { link: custom });
        return r;
      }
      r = base(c, d);
      house = r?.house || house;
      if (house && !was && M.isMember(house, c.user)) welcomed(house, c.user);
      return r;
    });
  }

  // ---------- What a house looks like, with all of the above ----------
  const baseHouseView = M.houseView;
  M.houseView = (houseId, viewer) => {
    const v = baseHouseView(houseId, viewer);
    if (!v) return v;
    const h = db.get('SELECT * FROM houses WHERE id = ?', houseId);
    const joined = v.house.joined;
    v.house.icon = h.icon || null;
    v.house.splash = h.splash || null;
    v.house.banner = joined || h.public ? h.banner || null : null;
    if (joined) {
      v.house.verify = h.verify || 'none';
      v.house.waitUntil = M.verifyWait(viewer, houseId) || null;
      v.house.mod2fa = !!h.mod2fa;
      v.house.pausedUntil = paused(h) ? (h.paused_until >= NEVER ? -1 : h.paused_until) : null;
      v.house.vanity = h.vanity || null;
      v.house.announceRoom = h.announce_room && v.rooms[h.announce_room] ? h.announce_room : null;
      v.house.defaultNotify = h.default_notify || 'all';
    }
    return v;
  };
  // Join lines are written by the server: they read as "Name joined", never as a call.
  const baseMsgView = M.msgView;
  M.msgView = (row, rx) => {
    const m = baseMsgView(row, rx);
    if (m.call && m.call.kind === 'join') { m.join = { user: m.call.user }; delete m.call; }
    return m;
  };
  // Discovery cards and previews carry the pictures anyone may see.
  for (const name of ['discover', 'house.preview']) {
    wrap(name, (c, d, base) => {
      const r = base(c, d);
      const add = (card) => {
        const h = db.get('SELECT icon, banner, splash, public FROM houses WHERE id = ?', card.id);
        if (!h) return card;
        card.icon = h.icon || null;
        card.splash = h.splash || null;
        card.banner = h.public || M.isMember(card.id, c.user) ? h.banner || null : null;
        return card;
      };
      if (name === 'discover') r.houses = (r.houses || []).map(add); else add(r);
      for (const e of r.events || []) {
        const row = db.get('SELECT location FROM events WHERE id = ?', e.id);
        e.location = row?.location || '';
      }
      return r;
    });
  }

  // ---------- Events ----------
  const baseEventView = M.eventView;
  M.eventView = (row) => {
    const v = baseEventView(row);
    if (!v) return v;
    const rs = db.all('SELECT user, kind FROM event_rsvps WHERE event = ? ORDER BY ts', row.id);
    v.going = rs.filter((r) => r.kind !== 'interested').map((r) => r.user);
    v.interested = rs.filter((r) => r.kind === 'interested').map((r) => r.user);
    v.location = row.location || '';
    v.cover = row.cover || null;
    return v;
  };
  const locationOf = (v) => {
    if (v === undefined) return undefined;
    if (v === null) return '';
    const s = str(v, { max: LOCATION_MAX, name: 'Where it is' });
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) || /^www\./i.test(s)) {
      if (!safeLink(s)) fail('A link for where it is needs to be a full https:// address.');
    }
    return s;
  };
  const mayEditEvent = (user, e) => e.by === user || M.can(user, e.house, 'events');
  wrap('event.create', (c, d, base) => {
    const h = houseRow(d.house);
    member(c.user, h.id);
    if (!M.can(c.user, h.id, 'events')) fail('Your role can’t plan events in this house.');
    const location = locationOf(d.location);
    const r = asIf(c.user, h.id, ['announce'], () => base(c, d));
    if (r?.id && location) {
      db.run('UPDATE events SET location = ? WHERE id = ?', location, r.id);
      hub.eventChanged(r.id);
      return { ...r, event: M.eventView(M.eventRow(r.id)) };
    }
    return r;
  });
  wrap('event.delete', (c, d, base) => {
    const e = typeof d.event === 'string' ? M.eventRow(d.event) : null;
    if (e && M.isMember(e.house, c.user) && e.by !== c.user) {
      if (!M.can(c.user, e.house, 'events')) fail('Your role can’t cancel events in this house.');
      const cover = e.cover;
      const r = asIf(c.user, e.house, ['announce'], () => base(c, d));
      if (cover) dropFile(cover);
      audit(e.house, c.user, 'event.delete', null, { title: e.title });
      return r;
    }
    const r = base(c, d);
    if (e?.cover && !M.eventRow(e.id)) dropFile(e.cover);
    return r;
  });
  // Going or interested, counted separately; null takes the answer back.
  ops['event.rsvp'] = (c, d) => {
    const e = M.eventRow(id(d.event, 'event')) || fail('That event was cancelled.');
    member(c.user, e.house);
    if (eventState(e, Date.now()) === 'past') fail('That event is over.');
    const kind = d.kind !== undefined ? (d.kind === null ? null : oneOf(d.kind, RSVP_KINDS, 'That answer')) : (d.going === true ? 'going' : null);
    slow('events', c.user);
    if (kind) {
      db.run(`INSERT INTO event_rsvps (event, user, ts, kind) VALUES (?, ?, ?, ?)
        ON CONFLICT (event, user) DO UPDATE SET kind = excluded.kind`, e.id, c.user, Date.now(), kind);
    } else db.run('DELETE FROM event_rsvps WHERE event = ? AND user = ?', e.id, c.user);
    hub.eventChanged(e.id);
    return {};
  };

  // ---------- Reminders ----------
  hub.community = hub.community || {};
  const stats = hub.community.stats = { notes: [], pushed: [], quiet: [] };
  const lead = (() => {
    const v = Number(process.env.SNUG_EVENT_LEAD_MS);
    return process.env.NODE_TEST_CONTEXT && Number.isFinite(v) && v >= 1000 ? v : REMIND_LEAD;
  })();
  function remind(e, when) {
    const view = M.eventView(e);
    const room = e.room && M.room(e.room);
    const voice = room && (room.kind === 'voice' || room.kind === 'stage');
    const houseName = db.get('SELECT name FROM houses WHERE id = ?', e.house)?.name || 'A house';
    for (const r of db.all('SELECT user, kind FROM event_rsvps WHERE event = ?', e.id)) {
      const u = r.user;
      if (!M.isMember(e.house, u)) continue;
      const join = voice && M.canRead(u, room.id) ? room.id : null;
      const shown = join || (room && M.canRead(u, room.id)) ? view : { ...view, room: null };
      hub.toUser(u, 'event.remind', { event: shown, when, join });
      stats.notes.push({ event: e.id, user: u, when });
      // A push for a closed device: never for a muted house, while Focused, or in quiet hours.
      const row = M.userRow(u);
      if (M.notifyOf(u, e.house) === 'muted' || row?.presence === 'focus' || M.quietHours?.(u)) { stats.quiet.push({ event: e.id, user: u }); continue; }
      stats.pushed.push({ event: e.id, user: u, when });
      hub.hooks.note?.(u, {
        title: when === 'now' ? `${e.title} is starting` : `${e.title} starts in ${Math.round(lead / MIN)} minutes`,
        body: `${houseName}${join ? ` · ${room.name}` : e.location ? ` · ${e.location}` : ''}`,
        tag: `snug:event:${e.id}`, house: e.house, event: e.id, ...(join ? { conv: join, join: true } : {}),
      });
    }
  }
  hub.community.tick = (t = Date.now()) => {
    for (const e of db.all('SELECT * FROM events WHERE reminded < 3 AND starts <= ? AND starts > ? LIMIT 500', t + lead, t - 10 * MIN)) {
      let flag = e.reminded;
      let when = null;
      if (t >= e.starts && !(flag & 2)) { when = 'now'; flag |= 3; } else if (t < e.starts && !(flag & 1)) { when = 'soon'; flag |= 1; }
      if (!when) continue;
      db.run('UPDATE events SET reminded = ? WHERE id = ?', flag, e.id);
      try { remind(e, when); } catch (err) { console.error('event reminder', err); }
    }
  };

  // ---------- Files ----------
  let filesDir = null;
  hub.community.setFilesDir = (dir) => { filesDir = dir; };
  function dropFile(fileId) {
    if (!fileId) return;
    db.run('DELETE FROM files WHERE id = ?', fileId);
    if (filesDir) unlink(join(filesDir, fileId)).catch(() => {});
  }
  hub.community.dropFile = dropFile;

  // ---------- New ops ----------
  const out = {};

  // Categories and room order.
  function layout(house) {
    const groups = db.all('SELECT id, name FROM room_groups WHERE house = ? ORDER BY pos', house).map((g) => ({ id: g.id, name: g.name, rooms: [] }));
    const byId = new Map(groups.map((g) => [g.id, g]));
    for (const r of db.all('SELECT id, grp FROM rooms WHERE house = ? ORDER BY pos', house)) (byId.get(r.grp) || groups[0])?.rooms.push(r.id);
    return groups;
  }
  function saveLayout(groups) {
    db.tx(() => {
      let p = 0;
      groups.forEach((g, i) => {
        db.run('UPDATE room_groups SET pos = ? WHERE id = ?', i, g.id);
        for (const r of g.rooms) db.run('UPDATE rooms SET grp = ?, pos = ? WHERE id = ?', g.id, p++, r);
      });
    });
  }
  const groupRow = (v) => db.get('SELECT * FROM room_groups WHERE id = ?', id(v, 'category')) || fail('That category doesn’t exist.');
  const index = (v, name = 'Where to') => (Number.isInteger(v) && v >= 0 && v <= 10_000 ? v : fail(`${name} isn’t valid.`));
  out['group.create'] = (c, d) => {
    const h = houseRow(d.house);
    need(c.user, h.id, 'rooms', 'manage rooms');
    notTimedOut(h.id, c.user, 'manage rooms');
    const name = str(d.name, { min: 1, max: GROUP_NAME_MAX, name: 'The name' });
    slow('write', c.user);
    const n = db.get('SELECT COUNT(*) n, MAX(pos) p FROM room_groups WHERE house = ?', h.id);
    if (n.n >= MAX_GROUPS) fail(`A house can have up to ${MAX_GROUPS} categories.`);
    const gid = newId('g');
    db.run('INSERT INTO room_groups (id, house, name, pos) VALUES (?, ?, ?, ?)', gid, h.id, name, (n.p ?? -1) + 1);
    audit(h.id, c.user, 'group.create', gid, { name });
    hub.houseChanged(h.id);
    return { id: gid };
  };
  out['group.update'] = (c, d) => {
    const g = groupRow(d.group);
    need(c.user, g.house, 'rooms', 'manage rooms');
    notTimedOut(g.house, c.user, 'manage rooms');
    const name = str(d.name, { min: 1, max: GROUP_NAME_MAX, name: 'The name' });
    slow('write', c.user);
    db.run('UPDATE room_groups SET name = ? WHERE id = ?', name, g.id);
    audit(g.house, c.user, 'group.update', g.id, { name, was: g.name });
    hub.houseChanged(g.house);
    return {};
  };
  out['group.delete'] = (c, d) => {
    const g = groupRow(d.group);
    need(c.user, g.house, 'rooms', 'manage rooms');
    notTimedOut(g.house, c.user, 'manage rooms');
    const groups = layout(g.house);
    if (groups.length < 2) fail('A house needs at least one category.');
    const i = groups.findIndex((x) => x.id === g.id);
    let to;
    if (d.moveTo != null) {
      to = groups.find((x) => x.id === id(d.moveTo, 'category'));
      if (!to || to.id === g.id) fail('Pick another category in this house for its rooms.');
    } else to = groups[i > 0 ? i - 1 : 1];
    slow('write', c.user);
    to.rooms.push(...groups[i].rooms);
    const rest = groups.filter((x) => x.id !== g.id);
    db.tx(() => {
      let p = 0;
      rest.forEach((x, n) => {
        db.run('UPDATE room_groups SET pos = ? WHERE id = ?', n, x.id);
        for (const r of x.rooms) db.run('UPDATE rooms SET grp = ?, pos = ? WHERE id = ?', x.id, p++, r);
      });
      db.run('DELETE FROM room_groups WHERE id = ?', g.id);
    });
    audit(g.house, c.user, 'group.delete', g.id, { name: g.name, moveTo: to.name, rooms: groups[i].rooms.length });
    hub.houseChanged(g.house);
    return { moveTo: to.id };
  };
  out['group.move'] = (c, d) => {
    const g = groupRow(d.group);
    need(c.user, g.house, 'rooms', 'manage rooms');
    notTimedOut(g.house, c.user, 'manage rooms');
    const to = index(d.to);
    slow('write', c.user);
    const groups = layout(g.house);
    const from = groups.findIndex((x) => x.id === g.id);
    const [moving] = groups.splice(from, 1);
    groups.splice(Math.min(to, groups.length), 0, moving);
    saveLayout(groups);
    audit(g.house, c.user, 'group.move', g.id, { name: g.name, index: groups.indexOf(moving) });
    hub.houseChanged(g.house);
    return {};
  };
  out['room.move'] = (c, d) => {
    const room = roomRow(d.room);
    need(c.user, room.house, 'rooms', 'move rooms');
    if (!M.roomPerms?.(c.user, room)?.manage && !M.isOwner(c.user, room.house)) fail(`You can’t manage ${room.name}.`);
    notTimedOut(room.house, c.user, 'manage rooms');
    const groups = layout(room.house);
    const target = d.group == null ? groups.find((g) => g.rooms.includes(room.id)) : groups.find((g) => g.id === id(d.group, 'category'));
    if (!target) fail('That category isn’t in this house.');
    const to = index(d.to);
    slow('write', c.user);
    for (const g of groups) g.rooms = g.rooms.filter((r) => r !== room.id);
    // The index counts the rooms this person can see, so a private room they
    // can't see never shifts where theirs lands.
    const seen = target.rooms.filter((r) => M.canRead(c.user, r));
    if (to >= seen.length) {
      const last = seen[seen.length - 1];
      target.rooms.splice(last ? target.rooms.indexOf(last) + 1 : target.rooms.length, 0, room.id);
    } else target.rooms.splice(target.rooms.indexOf(seen[to]), 0, room.id);
    saveLayout(groups);
    audit(room.house, c.user, 'room.move', room.id, { name: room.name, group: target.name });
    hub.houseChanged(room.house);
    return {};
  };

  // House settings that live here: announcements, default level, removing pictures.
  wrap('house.update', (c, d, base) => {
    const h = houseRow(d.house);
    need(c.user, h.id, 'house', 'change house settings');
    const set = {};
    for (const k of ['icon', 'banner', 'splash']) {
      if (d[k] === undefined) continue;
      if (d[k] !== null) fail('Upload a picture first, or remove it.');
      set[k] = null;
    }
    if (d.announceRoom !== undefined) {
      if (d.announceRoom === null) set.announce_room = null;
      else {
        const r = M.room(id(d.announceRoom, 'room'));
        if (!r || r.house !== h.id || !M.canRead(c.user, r.id)) fail('That room isn’t in this house.');
        if (!['text', 'news'].includes(r.kind)) fail('Newcomers can be announced in a conversation or notice room.');
        set.announce_room = r.id;
      }
    }
    if (d.defaultNotify !== undefined) set.default_notify = oneOf(d.defaultNotify, ['all', 'mentions'], 'The default level');
    // The role newcomers get hands out power, so it stays with people who
    // manage roles ('house' alone renames the house), and below an owner it is
    // a role under your own that manages nothing, as an interest's roles are.
    if (d.joinRole !== undefined && d.joinRole !== h.join_role && !M.isOwner(c.user, h.id)) {
      if (!baseCan(c.user, h.id, 'roles')) fail('Your role can’t choose the role newcomers get in this house.');
      const role = db.get('SELECT * FROM roles WHERE id = ? AND house = ? AND id != (SELECT id FROM roles WHERE house = ? ORDER BY pos LIMIT 1)',
        typeof d.joinRole === 'string' ? d.joinRole : '', h.id, h.id) || fail('That role isn’t one of the choices.');
      if (json(role.perms, []).some((p) => MANAGING.includes(p))) fail(`${role.name} can manage or moderate, so newcomers can’t start with it.`);
      if (!M.roleBelow(h.id, c.user, role.id)) fail('You can only give newcomers a role below your own.');
    }
    const rest = { ...d };
    for (const k of ['icon', 'banner', 'splash', 'announceRoom', 'defaultNotify']) delete rest[k];
    const r = base(c, rest);
    const old = [];
    for (const [k, v] of Object.entries(set)) {
      if (['icon', 'banner', 'splash'].includes(k) && h[k]) old.push(h[k]);
      db.run(`UPDATE houses SET ${k} = ? WHERE id = ?`, v, h.id); // k is one of the fixed names above
    }
    old.forEach(dropFile);
    if (Object.keys(set).length) hub.houseChanged(h.id);
    return r;
  });

  // Deleting a house: owners only, with its exact name, and a code when two-factor is on.
  out['house.delete'] = (c, d) => {
    const h = houseRow(d.house);
    member(c.user, h.id);
    if (!M.isOwner(c.user, h.id)) fail('Only an owner can delete this house.');
    slow('danger', c.user);
    if (typeof d.confirmName !== 'string' || d.confirmName.trim() !== h.name) fail(`Type the house’s name, ${h.name}, exactly as it is.`);
    if (M.totpOn?.(c.user) && !M.verifySecond?.(c.user, String(d.code || ''))) fail('Type a code from your authenticator app, or a backup code.');
    const people = [...new Set([
      ...db.all('SELECT user FROM members WHERE house = ?', h.id).map((r) => r.user),
      ...db.all('SELECT user FROM personal_invites WHERE house = ?', h.id).map((r) => r.user),
    ])];
    const rooms = db.all('SELECT id FROM rooms WHERE house = ?', h.id).map((r) => r.id);
    for (const r of rooms) hub.closeVoiceRoom(r);
    const threads = rooms.length ? db.all('SELECT id FROM threads WHERE conv IN (SELECT value FROM json_each(?))', JSON.stringify(rooms)).map((r) => r.id) : [];
    const convs = JSON.stringify([...rooms, ...threads]);
    const fileIds = [
      ...db.all('SELECT id FROM files WHERE conv IN (SELECT value FROM json_each(?))', convs).map((r) => r.id),
      ...db.all("SELECT id FROM files WHERE conv LIKE ? ESCAPE '\\'", `housepic:${h.id.replace(/[\\%_]/g, (x) => `\\${x}`)}:%`).map((r) => r.id),
      ...db.all('SELECT cover AS id FROM events WHERE house = ? AND cover IS NOT NULL', h.id).map((r) => r.id),
    ];
    for (const t of ['house_emoji', 'house_stickers', 'house_sounds']) {
      try { fileIds.push(...db.all(`SELECT file AS id FROM ${t} WHERE house = ?`, h.id).map((r) => r.id)); } catch { /* that table isn't here */ } // t is fixed above
    }
    db.tx(() => {
      db.run('DELETE FROM reactions WHERE msg IN (SELECT id FROM messages WHERE conv IN (SELECT value FROM json_each(?)))', convs);
      for (const t of ['pins', 'saved', 'reads']) db.run(`DELETE FROM ${t} WHERE conv IN (SELECT value FROM json_each(?))`, convs); // fixed names
      db.run('DELETE FROM follows WHERE thread IN (SELECT value FROM json_each(?))', convs);
      db.run('DELETE FROM notify WHERE place = ? OR place IN (SELECT value FROM json_each(?))', h.id, convs);
      db.run('DELETE FROM messages WHERE conv IN (SELECT value FROM json_each(?))', convs);
      db.run('DELETE FROM threads WHERE conv IN (SELECT value FROM json_each(?))', JSON.stringify(rooms));
      db.run('DELETE FROM files WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(fileIds));
      db.run('DELETE FROM hooks WHERE house = ?', h.id);
      db.run('DELETE FROM events WHERE house = ?', h.id);
      db.run('DELETE FROM audit WHERE house = ?', h.id);
      db.run('DELETE FROM houses WHERE id = ?', h.id);
    });
    if (filesDir) for (const f of fileIds) unlink(join(filesDir, f)).catch(() => {});
    for (const u of people) hub.toUser(u, 'house.gone', { id: h.id, deleted: true, name: h.name });
    return {};
  };

  // Handing the house to someone else.
  out['house.transfer'] = (c, d) => {
    const h = houseRow(d.house);
    member(c.user, h.id);
    if (!M.isOwner(c.user, h.id)) fail('Only an owner can give the house to someone else.');
    const target = id(d.user, 'person');
    if (target === c.user) fail('That’s you already.');
    if (!M.isMember(h.id, target)) fail('That person isn’t in this house.');
    const stepDown = d.stepDown === undefined ? false : bool(d.stepDown, 'Step down');
    slow('danger', c.user);
    if (M.totpOn?.(c.user) && !M.verifySecond?.(c.user, String(d.code || ''))) fail(d.code ? 'That code isn’t right.' : 'Type a code from your authenticator app, or a backup code.');
    const roles = db.all('SELECT id FROM roles WHERE house = ? ORDER BY pos', h.id).map((r) => r.id);
    db.tx(() => {
      db.run('UPDATE members SET role = ? WHERE house = ? AND user = ?', roles[0], h.id, target);
      db.run('DELETE FROM member_roles WHERE house = ? AND user = ? AND role = ?', h.id, target, roles[0]);
      if (stepDown && roles[1]) db.run('UPDATE members SET role = ? WHERE house = ? AND user = ?', roles[1], h.id, c.user);
    });
    audit(h.id, c.user, 'house.transfer', target, { stepDown });
    hub.houseChanged(h.id);
    for (const u of [c.user, target]) hub.sendHouseContent(u, h.id);
    return {};
  };

  // Verification, two-factor for moderators, and pausing invitations.
  out['house.safety'] = (c, d) => {
    const h = houseRow(d.house);
    member(c.user, h.id);
    if (!M.can(c.user, h.id, 'house') && !M.can(c.user, h.id, 'ban')) fail('Your role can’t change who may take part in this house.');
    notTimedOut(h.id, c.user, 'change the house');
    const changes = {};
    if (d.verify !== undefined) changes.verify = oneOf(d.verify, VERIFY_IDS, 'That level');
    if (d.mod2fa !== undefined) {
      const on = bool(d.mod2fa, 'Two-factor for moderators');
      if (!M.isOwner(c.user, h.id)) fail('Only an owner can change this.');
      if (on && !M.totpOn?.(c.user)) fail('Turn on two-factor sign-in for yourself first, in Settings > Account.');
      changes.mod2fa = on ? 1 : 0;
    }
    if (d.pause !== undefined) {
      if (d.pause === null || d.pause === false) changes.paused_until = null;
      else changes.paused_until = oneOf(d.pause, PAUSE_HOURS, 'That length') ? Date.now() + d.pause * HOUR : NEVER;
    }
    if (!Object.keys(changes).length) return {};
    slow('settings', c.user);
    for (const [k, v] of Object.entries(changes)) db.run(`UPDATE houses SET ${k} = ? WHERE id = ?`, v, h.id); // fixed names above
    if ('verify' in changes) audit(h.id, c.user, 'house.verify', null, { level: changes.verify });
    if ('mod2fa' in changes) audit(h.id, c.user, 'house.mod2fa', null, { on: !!changes.mod2fa });
    if ('paused_until' in changes) audit(h.id, c.user, changes.paused_until ? 'house.pause' : 'house.unpause', null, changes.paused_until ? { hours: d.pause } : null);
    hub.houseChanged(h.id);
    return {};
  };

  // A custom invitation link: /join/<word>.
  out['house.vanity'] = (c, d) => {
    const h = houseRow(d.house);
    member(c.user, h.id);
    if (!M.isOwner(c.user, h.id)) fail('Only an owner can set the house’s own link.');
    let word = null;
    if (d.word !== null && d.word !== '') {
      const p = vanityProblem(d.word);
      if (p) fail(p);
      word = d.word.trim().toLowerCase();
      if (word === h.vanity) return { word };
      if (db.get('SELECT 1 FROM houses WHERE vanity = ? AND id != ?', word, h.id) || db.get('SELECT 1 FROM invites WHERE lower(code) = ?', word)) fail(`/join/${word} is taken. Try another word.`);
    } else if (!h.vanity) return { word: null };
    if (!limits.vanity.take(h.id)) fail('The link has changed a few times this hour. Try again later.');
    db.run('UPDATE houses SET vanity = ? WHERE id = ?', word, h.id);
    audit(h.id, c.user, 'house.vanity', null, { word });
    hub.houseChanged(h.id);
    return { word };
  };

  // Editing an event: whoever planned it, or a role that may plan events.
  out['event.update'] = (c, d) => {
    const e = M.eventRow(id(d.event, 'event')) || fail('That event was cancelled.');
    member(c.user, e.house);
    if (!mayEditEvent(c.user, e)) fail('You can only change events you planned.');
    notTimedOut(e.house, c.user, 'change events');
    const t = Date.now();
    const title = d.title !== undefined ? str(d.title, { min: 1, max: LIMITS.eventTitle, name: 'The title' }) : e.title;
    const about = d.about !== undefined ? str(d.about ?? '', { max: LIMITS.eventAbout, name: 'The description' }) : e.about;
    let starts = e.starts;
    if (d.starts !== undefined) {
      starts = Number.isSafeInteger(d.starts) ? d.starts : fail('Pick when it starts.');
      if (starts < t - 60 * MIN && starts !== e.starts) fail('That time has already passed.');
      if (starts > t + 366 * DAY) fail('Events can be planned up to a year ahead.');
    }
    let ends = e.ends ?? null;
    if (d.ends !== undefined) ends = d.ends === null ? null : (Number.isSafeInteger(d.ends) ? d.ends : fail('That end time isn’t valid.'));
    if (ends != null) {
      if (ends <= starts) fail('It has to end after it starts.');
      if (ends - starts > 7 * DAY) fail('An event can last up to a week.');
    }
    let room = e.room ?? null;
    if (d.room !== undefined) {
      if (d.room === null) room = null;
      else {
        const r = M.room(id(d.room, 'room'));
        if (!r || r.house !== e.house || !M.canRead(c.user, r.id)) fail('That room isn’t in this house.');
        room = r.id;
      }
    }
    const location = d.location !== undefined ? locationOf(d.location) : e.location || '';
    slow('events', c.user);
    const reminded = starts !== e.starts ? 0 : e.reminded;
    db.run('UPDATE events SET title = ?, about = ?, starts = ?, ends = ?, room = ?, location = ?, reminded = ? WHERE id = ?',
      title, about, starts, ends, room, location, reminded, e.id);
    const fields = ['title', 'about', 'starts', 'ends', 'room', 'location'].filter((k) => d[k] !== undefined);
    audit(e.house, c.user, 'event.update', null, { title, fields });
    hub.eventChanged(e.id);
    return { event: M.eventView(M.eventRow(e.id)) };
  };
  out['event.cover'] = (c, d) => {
    const e = M.eventRow(id(d.event, 'event')) || fail('That event was cancelled.');
    member(c.user, e.house);
    if (!mayEditEvent(c.user, e)) fail('You can only change events you planned.');
    notTimedOut(e.house, c.user, 'change events');
    if (d.cover !== null) fail('Upload a cover first, or remove it.');
    if (e.cover) { db.run('UPDATE events SET cover = NULL WHERE id = ?', e.id); dropFile(e.cover); hub.eventChanged(e.id); }
    return {};
  };

  Object.assign(ops, out);
  return out;
}

// --- HTTP: house pictures, event covers, invitation previews -------------
// Mounted in server/index.js: `open` before sign-in is checked (pictures an
// invitation may show, invitation previews), `authed` after.
export function createCommunityHttp({ db, M, hub, filesDir, sendJson, error, body, headers, uploadLimit, userOf }) {
  hub.community?.setFilesDir?.(filesDir);
  const picLimit = limiter({ capacity: 10, perSecond: 0.1 });
  (hub.extraLimits ||= []).push(picLimit);
  // Event reminders: a tick every 30 seconds (shorter only under the test runner).
  const tickMs = (() => {
    const v = Number(process.env.SNUG_EVENT_TICK_MS);
    return process.env.NODE_TEST_CONTEXT && Number.isFinite(v) && v >= 50 ? v : 30_000;
  })();
  const timer = setInterval(() => { try { hub.community?.tick?.(); } catch (e) { console.error('event reminders', e); } }, tickMs);
  timer.unref?.();
  const baseClose = hub.close;
  hub.close = () => { clearInterval(timer); baseClose?.(); };

  const paused = (h) => !!h?.paused_until && h.paused_until > Date.now();
  const validInvite = (code, house) => {
    if (typeof code !== 'string' || !code) return false;
    const r = M.resolveInvite?.(code);
    if (!r || r.house !== house) return false;
    const inv = r.invite;
    return !inv || (inv.expires >= Date.now() && !inv.revoked && !(inv.max_uses && inv.uses >= inv.max_uses));
  };
  async function readImage(req, res, max, types, label) {
    const size = Number(req.headers['content-length']);
    if (!size) { error(res, 400, 'That picture is empty.'); return null; }
    const mb = `${max / 1024 / 1024} MB`;
    if (size > max) { error(res, 413, `${label} can be up to ${mb}.`); return null; }
    let data;
    try { data = await body(req, max); } catch (e) { if (e.status === 413) { error(res, 413, `${label} can be up to ${mb}.`); return null; } throw e; }
    const img = imageInfo(data);
    // A JPEG whose size can't be read (no frame header) is not a picture: refuse it like any other junk.
    if (!img || !types.includes(img.type) || !(img.w > 0 && img.h > 0)) {
      const names = types.map((t) => TYPE_NAMES[t]);
      error(res, 415, `${label} need to be ${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}.`);
      return null;
    }
    return { data, img };
  }
  function serve(res, row) {
    headers(res, {
      'Content-Type': row.type, 'Content-Length': String(row.size), 'Cache-Control': 'private, max-age=86400',
      'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Content-Type-Options': 'nosniff',
    });
    res.writeHead(200);
    createReadStream(join(filesDir, row.id)).pipe(res);
  }

  async function open(req, res, path, url) {
    // A house picture: members always; the icon and invitation background to
    // anyone holding a valid invitation, and to anyone for a public house; the banner to members and public previews.
    let m = /^\/api\/housepics\/(f_[a-z0-9]{8,40})$/.exec(path);
    if (req.method === 'GET' && m) {
      const row = db.get('SELECT * FROM files WHERE id = ?', m[1]);
      const [, houseId, kind] = /^housepic:([\w-]+):(icon|banner|splash)$/.exec(row?.conv || '') || [];
      const h = houseId && db.get('SELECT * FROM houses WHERE id = ?', houseId);
      if (!h || h[kind] !== row.id) { error(res, 404, 'Not found'); return true; }
      const user = userOf(req);
      let ok = !!user && M.isMember(h.id, user);
      if (!ok && h.public) ok = true;
      if (!ok && kind !== 'banner') {
        ok = validInvite(url.searchParams.get('invite'), h.id)
          || (!!user && !!db.get('SELECT 1 FROM personal_invites WHERE house = ? AND user = ?', h.id, user));
      }
      if (!ok) { error(res, 404, 'Not found'); return true; }
      serve(res, row);
      return true;
    }
    // Invitation previews are public, so a link shows what you are joining before you sign in.
    m = /^\/api\/invite\/([\w-]{3,40})$/.exec(path);
    if (req.method === 'GET' && m) {
      const r = M.resolveInvite?.(m[1]);
      const inv = r?.invite;
      if (!r || (inv && (inv.expires < Date.now() || inv.revoked || (inv.max_uses && inv.uses >= inv.max_uses)))) { error(res, 404, 'That invitation has expired. Ask for a new link.'); return true; }
      const h = db.get('SELECT * FROM houses WHERE id = ?', r.house);
      if (!h) { error(res, 404, 'That invitation has expired. Ask for a new link.'); return true; }
      const count = db.get('SELECT COUNT(*) n FROM members WHERE house = ?', h.id).n;
      const by = inv ? db.get('SELECT name FROM users WHERE id = ?', inv.by)?.name : null;
      sendJson(res, 200, {
        house: { name: h.name, mark: h.mark, hue: h.hue, about: h.about, members: count, icon: h.icon || null, splash: h.splash || null, banner: h.public ? h.banner || null : null },
        by, paused: paused(h), custom: !!r.vanity,
      });
      return true;
    }
    return false;
  }

  async function authed(req, res, path, url, user) {
    const post = req.method === 'POST' && path === '/api/files';
    if (post && url.searchParams.has('housePic')) {
      const kind = url.searchParams.get('housePic');
      const spec = Object.hasOwn(PICTURES, kind) ? PICTURES[kind] : null;
      if (!spec) { error(res, 400, 'That kind of picture isn’t one of the choices.'); return true; }
      const h = db.get('SELECT * FROM houses WHERE id = ?', url.searchParams.get('house') || '');
      if (!h || !M.isMember(h.id, user)) { error(res, 404, 'That house doesn’t exist.'); return true; }
      if (!M.can(user, h.id, 'house')) { error(res, 403, 'Your role can’t change this house’s pictures.'); return true; }
      if (db.get('SELECT 1 FROM timeouts WHERE house = ? AND user = ? AND until > ?', h.id, user, Date.now())) { error(res, 403, 'You’re timed out here, so you can’t change the house yet.'); return true; }
      if ((uploadLimit && !uploadLimit.take(user)) || !picLimit.take(user)) { error(res, 429, 'Too many uploads at once. Wait a moment.'); return true; }
      const got = await readImage(req, res, spec.bytes, PICTURE_TYPES, 'Pictures');
      if (!got) return true;
      const { data, img } = got;
      if (img.w < spec.minPx || img.h < spec.minPx) { error(res, 422, `Pictures need to be at least ${spec.minPx} pixels on each side.`); return true; }
      if (img.w > spec.maxPx || img.h > spec.maxPx) { error(res, 422, `${spec.label}s can be up to ${spec.maxPx} pixels on each side.`); return true; }
      if (spec.square && img.w !== img.h) { error(res, 422, 'Icons need to be square. Crop it to the same width and height.'); return true; }
      const fid = newId('f');
      await writeFile(join(filesDir, fid), data, { mode: 0o600 });
      db.run('INSERT INTO files (id, owner, conv, name, type, size, created, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        fid, user, `housepic:${h.id}:${kind}`, kind, img.type, data.length, Date.now(), JSON.stringify({ w: img.w, h: img.h }));
      db.run(`UPDATE houses SET ${kind} = ? WHERE id = ?`, fid, h.id); // kind is one of PICTURES' keys
      if (h[kind]) hub.community?.dropFile?.(h[kind]);
      db.run('INSERT INTO audit (house, ts, actor, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)', h.id, Date.now(), user, 'house.picture', null, JSON.stringify({ kind }));
      hub.houseChanged(h.id);
      sendJson(res, 201, { id: fid, kind, w: img.w, h: img.h, type: img.type });
      return true;
    }
    if (post && url.searchParams.has('eventCover')) {
      const e = M.eventRow(url.searchParams.get('eventCover') || '');
      if (!e || !M.isMember(e.house, user)) { error(res, 404, 'That event was cancelled.'); return true; }
      if (e.by !== user && !M.can(user, e.house, 'events')) { error(res, 403, 'You can only change events you planned.'); return true; }
      if (db.get('SELECT 1 FROM timeouts WHERE house = ? AND user = ? AND until > ?', e.house, user, Date.now())) { error(res, 403, 'You’re timed out here, so you can’t change events yet.'); return true; }
      if ((uploadLimit && !uploadLimit.take(user)) || !picLimit.take(user)) { error(res, 429, 'Too many uploads at once. Wait a moment.'); return true; }
      const got = await readImage(req, res, COVER_BYTES, COVER_TYPES, 'Covers');
      if (!got) return true;
      const { data, img } = got;
      if (img.w > 4096 || img.h > 4096) { error(res, 422, 'Covers can be up to 4096 pixels on each side.'); return true; }
      const fid = newId('f');
      await writeFile(join(filesDir, fid), data, { mode: 0o600 });
      db.run('INSERT INTO files (id, owner, conv, name, type, size, created, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        fid, user, `eventcover:${e.id}`, 'cover', img.type, data.length, Date.now(), JSON.stringify({ w: img.w, h: img.h }));
      db.run('UPDATE events SET cover = ? WHERE id = ?', fid, e.id);
      if (e.cover) hub.community?.dropFile?.(e.cover);
      hub.eventChanged(e.id);
      sendJson(res, 201, { id: fid, w: img.w, h: img.h, type: img.type });
      return true;
    }
    // An event's cover: for people in its house.
    const m = /^\/api\/eventcovers\/(f_[a-z0-9]{8,40})$/.exec(path);
    if (req.method === 'GET' && m) {
      const row = db.get('SELECT * FROM files WHERE id = ?', m[1]);
      const eid = row?.conv?.startsWith('eventcover:') ? row.conv.slice(11) : null;
      const e = eid && M.eventRow(eid);
      if (!e || e.cover !== row.id || !M.isMember(e.house, user)) { error(res, 404, 'Not found'); return true; }
      serve(res, row);
      return true;
    }
    return false;
  }
  return { open, authed };
}
