// Groups across PCs (design 0.10 section 4): group chats with friends on other
// PCs, with no host. Every member's PC keeps the group and its messages.
//
// - Membership is a log of signed ops (create, add, remove, leave, rename,
//   icon), replayed the same way on every PC (server/grouplog.js).
// - Messages, edits, deletes, restores and reactions are items signed by their
//   author. The author queues each one to every other member's outbox; any
//   member who has an item forwards it to members missing it (inventory
//   exchange on link up), so the author going offline doesn't block delivery.
//   Forwarders can't alter an item: the author's signature travels with it.
// - Delivery state per own message: "waiting for N" until every member has it.
// - No strangers: a PC accepts a group it isn't in only from a friend.
//
// Local rows: dms (id = g, owner = the group owner's local id) and dm_members,
// so every existing view, read path and op works unchanged. Inbound items are
// applied by calling the same ops as the author's shadow (c.peer, c.ts).
import { randomBytes } from 'node:crypto';
import { UserError } from './ops.js';
import { newId, now } from './model.js';
import { shadowId, isUid, sha256, base32 } from './peercrypto.js';
import { HUES } from '../js/lib/util.js';
import {
  GID, MAX_MEMBERS, MAX_OPS, ITEM_DAYS, gidFor, signOp, verifyOp, signItem, verifyItem, opShape, itemShape, replay,
  memberAt, itemAllowed, opsDigest, exportGroups, parseGroupsSection,
} from './grouplog.js';

const DAY = 86_400_000;
const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️|⃣|[#*0-9])+$/u;
const HUE_SET = new Set(HUES.map(([h]) => h));
const fail = (m) => { throw new UserError(m); };
const json = (s, f) => { try { return s == null ? f : JSON.parse(s); } catch { return f; } };
const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';
const rid16 = () => { let s = ''; for (const b of randomBytes(16)) s += ALNUM[b % 36]; return s; };
const MIX = 'A group can have friends on other PCs or people on this PC, not both.';
const NO_CALLS = 'Group calls with friends on other PCs aren’t available yet.';

export function migrateGroups(wrapped) {
  const db = wrapped.raw || wrapped;
  db.exec(`
    CREATE TABLE IF NOT EXISTS grp_ops (g TEXT NOT NULL, id TEXT NOT NULL, by TEXT NOT NULL, ts INTEGER NOT NULL,
      body TEXT NOT NULL, sig TEXT NOT NULL, PRIMARY KEY (g, id));
    CREATE TABLE IF NOT EXISTS grp_pending (g TEXT NOT NULL, id TEXT NOT NULL, uid TEXT NOT NULL, PRIMARY KEY (g, id, uid));
    CREATE TABLE IF NOT EXISTS grp_failed (g TEXT NOT NULL, id TEXT NOT NULL, uid TEXT NOT NULL, PRIMARY KEY (g, id, uid));
  `);
  // Items are keyed by (g, id, by): an item id is the author's own, so another member can't
  // squat it and hide the real one (security review 0.10 #3). Early 0.10 trees keyed (g, id).
  const old = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'grp_items'").get()?.sql || '';
  if (old && !/PRIMARY KEY \(g, id, by\)/.test(old)) db.exec('ALTER TABLE grp_items RENAME TO grp_items_v0; DROP INDEX IF EXISTS grp_items_ts;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS grp_items (g TEXT NOT NULL, id TEXT NOT NULL, by TEXT NOT NULL, ts INTEGER NOT NULL,
      body TEXT NOT NULL, sig TEXT NOT NULL, via TEXT, PRIMARY KEY (g, id, by));
    CREATE INDEX IF NOT EXISTS grp_items_ts ON grp_items(g, ts);
  `);
  if (old && !/PRIMARY KEY \(g, id, by\)/.test(old)) db.exec('INSERT OR IGNORE INTO grp_items SELECT g, id, by, ts, body, sig, via FROM grp_items_v0; DROP TABLE grp_items_v0;');
}

export function createGroups({ db, M, hub, ops, peer, log = () => {} }) {
  migrateGroups(db);
  const off = { enabled: false, stats: () => ({}) };
  if (!peer?.enabled || !peer._g) return off;
  const X = peer._g;
  const { outbox, links, online } = X;
  const fwdMax = Number(process.env.SNUG_GROUP_FWD_MS ?? 20_000);
  const stats = { opsIn: 0, itemsIn: 0, forwarded: 0, dropped: 0, rcptOut: 0 };
  const me = () => X.myUid();
  const localId = (uid) => (uid === me() ? X.owner() : shadowId(uid));
  const uidOfLocal = (u) => (u === X.owner() ? me() : X.uidOf(u));
  const isGroup = (g) => typeof g === 'string' && GID.test(g);
  const mineC = (c) => X.active() && c.user === X.owner() && !c.peer;
  const ikPriv = () => peer.identity.me()?.ikPriv;

  // ---------- State: the op log, replayed (cached per group) ----------
  const cache = new Map();
  const opRows = (g) => db.all('SELECT body, sig FROM grp_ops WHERE g = ?', g);
  const opsOf = (g) => opRows(g).map((r) => json(r.body, null)).filter(Boolean);
  function state(g) {
    let st = cache.get(g);
    if (!st) { st = replay(g, opsOf(g)); cache.set(g, st); }
    return st;
  }
  const amIn = (g) => { const st = state(g); return st.ok && st.members.has(me()); };
  const myGroups = () => db.all('SELECT DISTINCT g FROM grp_ops').map((r) => r.g).filter((g) => isGroup(g) && amIn(g));
  // People I share at least one group with (they become contacts: links, presence).
  let contacts = null;
  function contactSet() {
    if (contacts) return contacts;
    contacts = new Set();
    if (!me()) return contacts;
    for (const g of myGroups()) for (const u of state(g).members.keys()) if (u !== me()) contacts.add(u);
    return contacts;
  }
  const invalidate = (g) => { if (g) cache.delete(g); else cache.clear(); contacts = null; };
  const shared = (uid) => myGroups().filter((g) => state(g).members.has(uid));

  X.hooks.contact = (uid) => contactSet().has(uid);
  X.hooks.watch = () => [...contactSet()];

  // ---------- Local rows from the replayed state ----------
  function line(g, byUid, act, extra = {}) {
    const by = localId(byUid);
    if (!by || !M.userRow(by)) return;
    const name = (u) => M.userRow(u)?.name || 'Someone';
    const who = name(by);
    let text = '';
    if (act === 'rename') text = extra.name ? `${who} named the group ${extra.name}` : `${who} removed the group’s name`;
    else if (act === 'icon') text = `${who} changed the group’s icon`;
    else if (act === 'add') text = `${who} added ${(extra.users || []).map(name).join(', ')}`;
    else if (act === 'leave') text = `${who} left the group`;
    else if (act === 'kick') text = `${who} removed ${name(extra.user)}`;
    const mid = newId('m');
    db.run('INSERT INTO messages (id, conv, author, ts, text, fold, sys) VALUES (?, ?, ?, ?, ?, ?, ?)',
      mid, g, by, now(), text, M.foldText(text, []), JSON.stringify({ kind: 'dm', act, by, ...extra }));
    const [m] = M.withReactions([M.msg(mid)]);
    hub.toConv(g, 'msg', { conv: g, m, user: hub.userView(by) });
  }
  function opLine(op) {
    const L = (uids) => uids.map(localId).filter((u) => M.userRow(u));
    if (op.t === 'create') line(op.g, op.by, 'add', { users: L(op.d.members) });
    else if (op.t === 'add') line(op.g, op.by, 'add', { users: L(op.d.uids) });
    else if (op.t === 'remove') line(op.g, op.by, 'kick', { user: localId(op.d.uid) });
    else if (op.t === 'leave') line(op.g, op.by, 'leave');
    else if (op.t === 'rename') line(op.g, op.by, 'rename', { name: op.d.name ?? null });
    else if (op.t === 'icon') line(op.g, op.by, 'icon');
  }
  const missingShadows = new Set();
  // Make the dms row and dm_members match the replayed state; leave the group locally if I'm out.
  function sync(g) {
    const st = state(g);
    if (!st.ok) return;
    if (!st.members.has(me())) { teardown(g); return; }
    dropGone(g, st);
    const owner = X.owner();
    const before = new Set(db.all('SELECT user FROM dm_members WHERE dm = ?', g).map((r) => r.user));
    const want = [];
    for (const u of st.members.keys()) {
      const id = localId(u);
      if (u === me() || X.peerOf(u)) want.push(id); else missingShadows.add(u);
    }
    const ownerLocal = X.peerOf(st.owner) || st.owner === me() ? localId(st.owner) : owner;
    db.tx(() => {
      if (!db.get('SELECT 1 FROM dms WHERE id = ?', g)) db.run('INSERT INTO dms (id, name, created) VALUES (?, ?, ?)', g, st.name, st.created || Date.now());
      db.run('UPDATE dms SET name = ?, owner = ?, icon = ?, icon_hue = ? WHERE id = ?', st.name, ownerLocal, st.icon?.emoji || null, st.icon?.hue ?? null, g);
      // The owner of this PC first, so the group's rowid order starts with me.
      for (const id of [owner, ...want.filter((u) => u !== owner)]) db.run('INSERT OR IGNORE INTO dm_members (dm, user) VALUES (?, ?)', g, id);
      for (const u of before) if (!want.includes(u) && u !== owner) db.run('DELETE FROM dm_members WHERE dm = ? AND user = ?', g, u);
    });
    const after = new Set(db.all('SELECT user FROM dm_members WHERE dm = ?', g).map((r) => r.user));
    if (!before.has(owner)) {
      // New to me: none of the history (there is none) counts as unread.
      db.run('INSERT INTO reads (user, conv, ts) VALUES (?, ?, ?) ON CONFLICT (user, conv) DO UPDATE SET ts = excluded.ts', owner, g, Date.now());
    }
    for (const u of new Set([...before, ...after])) if (!after.has(u)) hub.toUser(u, 'dm.gone', { id: g });
    hub.sendDm(owner, g);
    if (missingShadows.size) fetchShadows();
  }
  let shadowsBusy = false;
  async function fetchShadows() {
    if (shadowsBusy) return;
    shadowsBusy = true;
    try {
      for (const uid of [...missingShadows]) {
        missingShadows.delete(uid);
        try { await X.shadowFor(uid); } catch (e) { log('groups', 'lookup', e.message); }
      }
      for (const g of myGroups()) sync(g);
      invalidate(); X.watchSoon();
    } finally { shadowsBusy = false; }
  }
  // Out of a group (left, removed): it goes from this PC, history and all.
  function teardown(g) {
    const owner = X.owner();
    const had = db.get('SELECT 1 FROM dms WHERE id = ?', g);
    db.tx(() => {
      const ids = db.all('SELECT id FROM messages WHERE conv = ? OR conv IN (SELECT id FROM threads WHERE conv = ?)', g, g).map((r) => r.id);
      for (const id of ids) db.run('DELETE FROM reactions WHERE msg = ?', id);
      db.run('DELETE FROM messages WHERE conv = ? OR conv IN (SELECT id FROM threads WHERE conv = ?)', g, g);
      db.run('DELETE FROM reads WHERE conv = ?', g);
      try { db.run('DELETE FROM notify WHERE place = ?', g); } catch { /* no table */ }
      db.run('DELETE FROM dms WHERE id = ?', g);
      for (const t of ['grp_ops', 'grp_items', 'grp_pending', 'grp_failed']) db.run(`DELETE FROM ${t} WHERE g = ?`, g);
    });
    invalidate(g);
    if (had && owner) hub.toUser(owner, 'dm.gone', { id: g });
    X.watchSoon();
  }

  // ---------- Sending ----------
  const frame = (o, sig, key) => JSON.stringify({ [key]: o, sig });
  function queue(uid, kind, ref, body) {
    const shadow = shadowId(uid);
    if (!X.peerOf(uid) || X.blockedEither(shadow)) return false;
    if (outbox.full(shadow)) return false;
    outbox.push(shadow, kind, ref, body, Math.round(X.now()));
    links.want(uid);
    return true;
  }
  function storeOp(op, sig) {
    const r = db.run('INSERT OR IGNORE INTO grp_ops (g, id, by, ts, body, sig) VALUES (?, ?, ?, ?, ?, ?)', op.g, op.id, op.by, op.ts, JSON.stringify(op), sig);
    invalidate(op.g);
    return r?.changes !== 0;
  }
  // Sign and apply one of my own ops, then send it (and, to new members, the whole log).
  function myOp(g, t, d) {
    if (!X.active() || !ikPriv()) fail('This PC isn’t signed in to Snug.');
    if (g && db.get('SELECT COUNT(*) n FROM grp_ops WHERE g = ?', g).n >= MAX_OPS) fail('This group has had too many changes. Start a new one.');
    const id = `o_${rid16()}`;
    const op = { g: g || gidFor(me(), id), id, t, by: me(), kver: X.kver(), ts: Math.max(Math.round(X.now()), lastOpTs(g) + 1), d };
    if (!opShape(op)) fail('That change isn’t valid.');
    const sig = signOp(ikPriv(), op);
    const before = g ? state(g) : null;
    const was = before ? new Set(before.members.keys()) : new Set();
    storeOp(op, sig);
    const st = state(op.g);
    if (!st.valid.has(op.id)) { db.run('DELETE FROM grp_ops WHERE g = ? AND id = ?', op.g, op.id); invalidate(op.g); fail('That change isn’t allowed.'); }
    const body = frame(op, sig, 'op');
    // Everyone who was in it or is in it now hears the op; people new to the group get the whole log.
    const all = new Set([...was, ...st.members.keys()]);
    all.delete(me());
    const full = opRows(op.g).map((r) => ({ op: json(r.body, null), sig: r.sig })).filter((x) => x.op)
      .sort((a, b) => (a.op.ts - b.op.ts) || (a.op.id < b.op.id ? -1 : 1));
    for (const uid of all) {
      if (!was.has(uid)) { for (const x of full) queue(uid, 'grp.op', x.op.id, frame(x.op, x.sig, 'op')); } else queue(uid, 'grp.op', op.id, body);
    }
    opLine(op);
    sync(op.g);
    invalidate();
    X.watchSoon();
    stats.opsOut = (stats.opsOut || 0) + 1;
    return op;
  }
  const lastOpTs = (g) => (g ? db.get('SELECT MAX(ts) t FROM grp_ops WHERE g = ?', g)?.t || 0 : 0);

  function myItem(g, k, d, id = newId('m'), ts = Math.round(X.now())) {
    const st = state(g);
    if (!st.members.has(me())) fail('You’re not in that conversation.');
    const item = { g, id, k, by: me(), kver: X.kver(), ts, d };
    if (!itemShape(item)) fail('That message isn’t valid.');
    const sig = signItem(ikPriv(), item);
    const body = frame(item, sig, 'item');
    db.run('INSERT OR IGNORE INTO grp_items (g, id, by, ts, body, sig, via) VALUES (?, ?, ?, ?, ?, ?, NULL)', g, id, me(), item.ts, body, sig);
    let any = false;
    for (const uid of st.members.keys()) {
      if (uid === me()) continue;
      const sent = queue(uid, 'grp.item', id, body);
      if (k !== 'msg') continue;
      // Not queued: blocked either way -> not delivered; no key yet or a full outbox -> still waiting
      // (another member can forward it; their receipt clears it). Never counted as delivered.
      if (!sent && X.blockedEither(shadowId(uid))) db.run('INSERT OR IGNORE INTO grp_failed (g, id, uid) VALUES (?, ?, ?)', g, id, uid);
      else db.run('INSERT OR IGNORE INTO grp_pending (g, id, uid) VALUES (?, ?, ?)', g, id, uid);
      any = true;
    }
    if (k === 'msg' && any) emitState(g, id);
    return item;
  }
  // The delivery state of one of my messages, to my pages: waiting for N, else not delivered to F, else delivered.
  function emitState(g, id) {
    const n = db.get('SELECT COUNT(*) n FROM grp_pending WHERE g = ? AND id = ?', g, id).n;
    const f = db.get('SELECT COUNT(*) n FROM grp_failed WHERE g = ? AND id = ?', g, id).n;
    X.toOwner('msg.state', { conv: g, id, state: n ? 'waiting' : f ? 'failed' : 'delivered', waiting: n, failed: f });
  }
  function pendingDone(id, uid) {
    const row = db.get('SELECT g FROM grp_pending WHERE id = ? AND uid = ?', id, uid) || db.get('SELECT g FROM grp_failed WHERE id = ? AND uid = ?', id, uid);
    if (!row) return;
    db.run('DELETE FROM grp_pending WHERE g = ? AND id = ? AND uid = ?', row.g, id, uid);
    db.run('DELETE FROM grp_failed WHERE g = ? AND id = ? AND uid = ?', row.g, id, uid);
    emitState(row.g, id);
  }
  // People no longer in the group aren't waited for (review 0.10 #8).
  function dropGone(g, st) {
    const rows = db.all('SELECT id, uid FROM grp_pending WHERE g = ? UNION SELECT id, uid FROM grp_failed WHERE g = ?', g, g).filter((r) => !st.members.has(r.uid));
    if (!rows.length) return;
    for (const r of rows) { db.run('DELETE FROM grp_pending WHERE g = ? AND uid = ?', g, r.uid); db.run('DELETE FROM grp_failed WHERE g = ? AND uid = ?', g, r.uid); }
    for (const id of new Set(rows.map((r) => r.id))) emitState(g, id);
  }
  X.hooks.acked = (uid, rows) => { for (const r of rows) if (r.kind === 'grp.item' && r.ref) pendingDone(r.ref, uid); };
  X.hooks.expired = (rows) => {
    const failed = new Set();
    const toFailed = (g, id, uid) => {
      db.run('DELETE FROM grp_pending WHERE g = ? AND id = ? AND uid = ?', g, id, uid);
      db.run('INSERT OR IGNORE INTO grp_failed (g, id, uid) VALUES (?, ?, ?)', g, id, uid);
      failed.add(`${g} ${id}`);
    };
    for (const r of rows) {
      if (r.kind !== 'grp.item' || !r.ref) continue;
      const uid = X.uidOf(r.peer);
      const p = uid && db.get('SELECT g FROM grp_pending WHERE id = ? AND uid = ?', r.ref, uid);
      if (p) toFailed(p.g, r.ref, uid);
    }
    // Waits with no outbox row (never queued) end after 30 days too.
    const old = Date.now() - ITEM_DAYS * DAY;
    for (const p of db.all('SELECT p.g, p.id, p.uid FROM grp_pending p JOIN grp_items i ON i.g = p.g AND i.id = p.id AND i.by = ? WHERE i.ts < ?', me(), old)) toFailed(p.g, p.id, p.uid);
    for (const k of failed) { const [g, id] = k.split(' '); emitState(g, id); }
    // Items past 30 days are no longer forwarded.
    db.run('DELETE FROM grp_items WHERE ts < ?', old);
  };

  // ---------- Receiving (frames are queued and handled in order, off the link's transaction) ----------
  let chain = Promise.resolve();
  const inbound = (fn) => { chain = chain.then(fn).catch((e) => { if (!(e instanceof UserError)) log('groups', 'inbound', e.message); stats.dropped++; }); return chain; };
  const verifyBy = async (uid, check) => {
    if (uid === me()) { const m = peer.identity.me(); return m && check(m.ik) ? m.ik : null; }
    if (!X.peerOf(uid)) { try { await X.shadowFor(uid); } catch { return null; } }
    return X.verifyFrom(uid, check);
  };
  const limbo = new Map(); // g -> { at, ops: Map id -> {op, sig} } : ops of a group I'm not in yet, from friends only
  async function onOp(from, d) {
    const op = d?.op, sig = d?.sig;
    if (!opShape(op) || typeof sig !== 'string') { stats.dropped++; return; }
    if (op.ts > X.now() + 60_000) { stats.dropped++; return; }
    stats.opsIn++;
    if (db.get('SELECT 1 FROM grp_ops WHERE g = ? AND id = ?', op.g, op.id)) return;
    const known = amIn(op.g) || db.get('SELECT 1 FROM grp_ops WHERE g = ? LIMIT 1', op.g);
    if (!known) return joinFrom(from, op, sig);
    if (!X.isFriend(shadowId(from)) && !state(op.g).members.has(from) && !state(op.g).spans.has(from)) { stats.dropped++; return; }
    if (db.get('SELECT COUNT(*) n FROM grp_ops WHERE g = ?', op.g).n >= MAX_OPS) { stats.dropped++; return; }
    if (!await verifyBy(op.by, (ik) => verifyOp(ik, op, sig))) { stats.dropped++; return; }
    if (!storeOp(op, sig)) return;
    const st = state(op.g);
    if (st.valid.has(op.id)) opLine(op);
    sync(op.g);
    invalidate();
    X.watchSoon();
  }
  // A group I'm not in: only a friend can bring me in, with a create or add op (by a friend) naming me.
  async function joinFrom(from, op, sig) {
    const fs = shadowId(from);
    if (!X.isFriend(fs) || X.blockedEither(fs)) { stats.dropped++; return; }
    let L = limbo.get(op.g);
    if (!L) {
      if (limbo.size >= 50) limbo.delete(limbo.keys().next().value);
      L = { at: Date.now(), ops: new Map() };
      limbo.set(op.g, L);
    }
    if (L.ops.size >= MAX_OPS) return;
    L.ops.set(op.id, { op, sig });
    const names = (o) => (o.t === 'create' ? o.d.members : o.t === 'add' ? o.d.uids : []);
    const trigger = [...L.ops.values()].some(({ op: o }) => (o.t === 'create' || o.t === 'add') && names(o).includes(me())
      && X.isFriend(shadowId(o.by)) && !X.blockedEither(shadowId(o.by)));
    if (!trigger) return;
    const good = [];
    for (const x of L.ops.values()) if (await verifyBy(x.op.by, (ik) => verifyOp(ik, x.op, x.sig))) good.push(x);
    const st = replay(op.g, good.map((x) => x.op));
    if (!st.ok || !st.members.has(me())) return; // not yet: more of the log is on its way
    // The adder must be a friend: find the op that brought me in.
    const inBy = good.map((x) => x.op).filter((o) => st.valid.has(o.id) && names(o).includes(me())).pop();
    if (!inBy || !X.isFriend(shadowId(inBy.by))) return;
    limbo.delete(op.g);
    db.tx(() => { for (const x of good) storeOp(x.op, x.sig); });
    for (const u of st.members.keys()) if (u !== me() && !X.peerOf(u)) missingShadows.add(u);
    if (missingShadows.size) await fetchShadows();
    sync(op.g);
    invalidate();
    X.watchSoon();
  }

  const rcpts = new Map(); // author uid -> Map g -> Set ids
  let rcptT = null;
  function rcptLater(author, g, id) {
    let m = rcpts.get(author);
    if (!m) rcpts.set(author, (m = new Map()));
    if (!m.has(g)) m.set(g, new Set());
    m.get(g).add(id);
    if (!rcptT) { rcptT = setTimeout(flushRcpts, 300); rcptT.unref?.(); }
  }
  function flushRcpts() {
    rcptT = null;
    for (const [author, m] of rcpts) for (const [g, ids] of m) {
      const list = [...ids];
      for (let i = 0; i < list.length; i += 200) { if (queue(author, 'grp.rcpt', null, JSON.stringify({ g, ids: list.slice(i, i + 200) }))) stats.rcptOut++; }
    }
    rcpts.clear();
  }

  async function onItem(from, d) {
    const item = d?.item, sig = d?.sig;
    if (!itemShape(item) || typeof sig !== 'string') { stats.dropped++; return; }
    const g = item.g;
    if (!amIn(g)) { stats.dropped++; return; }
    const st = state(g);
    if (!X.isFriend(shadowId(from)) && !st.members.has(from) && !st.spans.has(from)) { stats.dropped++; return; }
    if (db.get('SELECT 1 FROM grp_items WHERE g = ? AND id = ? AND by = ?', g, item.id, item.by)) return;
    if (!itemAllowed(st, item, X.now()) || !memberAt(st, me(), item.ts)) { stats.dropped++; return; }
    if (item.by !== me() && X.blockedEither(shadowId(item.by))) { stats.dropped++; return; }
    if (!await verifyBy(item.by, (ik) => verifyItem(ik, item, sig))) { stats.dropped++; return; }
    if (db.get('SELECT 1 FROM grp_items WHERE g = ? AND id = ? AND by = ?', g, item.id, item.by)) return;
    stats.itemsIn++;
    db.run('INSERT OR IGNORE INTO grp_items (g, id, by, ts, body, sig, via) VALUES (?, ?, ?, ?, ?, ?, ?)',
      g, item.id, item.by, item.ts, frame(item, sig, 'item'), sig, from !== item.by ? from : null);
    applyItem(item);
    if (item.k === 'msg') for (const r of db.all("SELECT body FROM grp_items WHERE g = ? AND id != ? AND by = ? AND json_extract(body, '$.item.d.id') = ? ORDER BY ts", g, item.id, item.by, item.id)) {
      const later = json(r.body, null)?.item;
      if (later) applyItem(later);
    }
    if (from !== item.by && item.by !== me() && item.k === 'msg') rcptLater(item.by, g, item.id);
  }
  // The local message id of an author's item id. Normally the same; when someone else already
  // holds that id here (a squat, or a clash), the author's message gets an id of its own.
  const aliasOf = (id, by) => `m_${base32(sha256(`snug-gitem-alias\n${id}\n${by}`)).slice(0, 24)}`;
  function localMid(g, id, byLocal, byUid) {
    const m = M.msg(id);
    if (!m) return db.get('SELECT 1 FROM grp_items WHERE g = ? AND id = ? AND by != ?', g, id, byUid) ? aliasOf(id, byUid) : id;
    return m.conv === g && m.author === byLocal ? id : aliasOf(id, byUid);
  }
  function applyItem(item) {
    const g = item.g;
    const by = localId(item.by);
    if (!by || !M.userRow(by)) return;
    const own = (id) => localMid(g, id, by, item.by); // edits/deletes/restores only ever touch the author's own message
    const c = { user: by, ws: null, peer: true, ts: Math.min(item.ts, Date.now() + 60_000) };
    const d = item.d;
    // Someone who left a moment after writing: let their last items in.
    const temp = !M.inDm(g, by);
    try {
      db.tx(() => {
        if (temp) db.run('INSERT OR IGNORE INTO dm_members (dm, user) VALUES (?, ?)', g, by);
        try {
          if (item.k === 'msg') {
            const files = item.by === me() ? [] : X.acceptFiles(item.by, g, d.files);
            ops['msg.send'](c, { conv: g, id: own(item.id), text: d.text, files, ...(d.replyTo ? { replyTo: d.replyTo } : {}) });
            if (files.length) queueMicrotask(() => X.fetchPending(item.by));
          } else if (item.k === 'edit') {
            const newest = db.get("SELECT MAX(ts) t FROM grp_items WHERE g = ? AND id != ? AND json_extract(body, '$.item.k') = 'edit' AND json_extract(body, '$.item.d.id') = ?", g, item.id, d.id)?.t;
            if (!(newest > item.ts)) ops['msg.edit'](c, { conv: g, id: own(d.id), text: d.text });
          } else if (item.k === 'delete') ops['msg.delete'](c, { conv: g, id: own(d.id) });
          else if (item.k === 'restore') ops['msg.restore'](c, { conv: g, id: own(d.id) });
          else if (item.k === 'react') ops.react(c, { conv: g, id: d.id, emoji: d.emoji, on: d.on === true });
        } finally {
          if (temp) db.run('DELETE FROM dm_members WHERE dm = ? AND user = ?', g, by);
        }
      });
    } catch (e) { if (!(e instanceof UserError)) throw e; log('groups', 'item refused', item.k, e.message); }
  }

  // ---------- Forwarding: inventories on link up, needs answered with stored items ----------
  const recent = (g) => db.all('SELECT id, by FROM grp_items WHERE g = ? AND ts > ? ORDER BY ts DESC LIMIT 200', g, Date.now() - 7 * DAY);
  const digest = (g) => opsDigest(db.all('SELECT id FROM grp_ops WHERE g = ?', g).map((r) => r.id));
  function sendInv(uid) {
    // ids with their authors (bys): an id held from another author doesn't count as having it.
    for (const g of shared(uid)) { const r = recent(g); links.sendEph(uid, 'grp.inv', { g, ids: r.map((x) => x.id), bys: r.map((x) => x.by), oh: digest(g) }); }
  }
  X.hooks.up = (uid) => { if (contactSet().has(uid)) sendInv(uid); };
  function onInv(from, d) {
    if (!isGroup(d.g) || !Array.isArray(d.ids)) return;
    const g = d.g;
    const ids = d.ids.slice(0, 200).filter((x) => typeof x === 'string');
    if (!amIn(g)) {
      // A friend thinks I'm in a group I don't have: ask for its log (it comes in through joinFrom).
      if (X.isFriend(shadowId(from)) && typeof d.oh === 'string') links.sendEph(from, 'grp.need', { g, ids: [], ops: [] });
      return;
    }
    const st = state(g);
    const opsDiffer = typeof d.oh === 'string' && d.oh !== digest(g);
    if (st.members.has(from)) {
      const bys = Array.isArray(d.bys) && d.bys.length === d.ids.length ? d.bys : null;
      const pairs = d.ids.slice(0, 200).map((x, i) => [x, bys ? bys[i] : null]).filter(([x]) => typeof x === 'string');
      const rows = db.all(`SELECT id, by FROM grp_items WHERE g = ? AND id IN (${ids.map(() => '?').join(',') || "''"})`, g, ...ids);
      const have = new Set(rows.map((r) => (bys ? `${r.id} ${r.by}` : r.id)));
      const need = [...new Set(pairs.filter(([x, b]) => !have.has(bys ? `${x} ${b}` : x)).map(([x]) => x))];
      if (need.length || opsDiffer) links.sendEph(from, 'grp.need', { g, ids: need, ...(opsDiffer ? { ops: db.all('SELECT id FROM grp_ops WHERE g = ?', g).map((r) => r.id) } : {}) });
    } else if (st.spans.has(from) && opsDiffer) {
      // Someone who was removed while away: they get the log, so they learn it.
      for (const r of opRows(g)) { const op = json(r.body, null); if (op) queue(from, 'grp.op', op.id, frame(op, r.sig, 'op')); }
    }
  }
  function onNeed(from, d) {
    if (!isGroup(d.g) || !amIn(d.g)) return;
    const g = d.g;
    const st = state(g);
    if (!st.members.has(from) && !st.spans.has(from)) return;
    if (st.members.has(from)) {
      for (const id of (Array.isArray(d.ids) ? d.ids : []).slice(0, 200)) {
        if (typeof id !== 'string') continue;
        for (const row of db.all('SELECT body, ts FROM grp_items WHERE g = ? AND id = ?', g, id)) {
          const item = json(row.body, null)?.item;
          if (!item || !memberAt(st, from, item.ts) || item.ts < Date.now() - ITEM_DAYS * DAY) continue;
          if (queue(from, 'grp.item', id, row.body)) stats.forwarded++;
        }
      }
    }
    if (Array.isArray(d.ops)) {
      const has = new Set(d.ops.slice(0, MAX_OPS).filter((x) => typeof x === 'string'));
      const rows = opRows(g).map((r) => ({ op: json(r.body, null), sig: r.sig })).filter((x) => x.op && !has.has(x.op.id))
        .sort((a, b) => (a.op.ts - b.op.ts) || (a.op.id < b.op.id ? -1 : 1));
      for (const x of rows) queue(from, 'grp.op', x.op.id, frame(x.op, x.sig, 'op'));
    }
  }
  function onRcpt(from, d) {
    if (!isGroup(d.g) || !Array.isArray(d.ids)) return;
    for (const id of d.ids.slice(0, 200)) if (typeof id === 'string') pendingDone(id, from);
  }
  // A co-member came online: if I hold recent items whose author is offline, open a link (after 0-20 s) to offer them.
  const fwdT = new Map();
  X.hooks.online = (uid, on) => {
    if (!on) { clearTimeout(fwdT.get(uid)); fwdT.delete(uid); return; }
    if (!contactSet().has(uid) || fwdT.has(uid)) return;
    const groups = shared(uid);
    if (!groups.length) return;
    const since = Date.now() - 7 * DAY;
    const worth = groups.some((g) => db.all('SELECT DISTINCT by FROM grp_items WHERE g = ? AND ts > ?', g, since)
      .some((r) => r.by !== uid && r.by !== me() && !online.has(r.by)));
    if (!worth) return;
    const t = setTimeout(() => { fwdT.delete(uid); if (online.has(uid)) links.want(uid); }, Math.floor(Math.random() * fwdMax));
    t.unref?.();
    fwdT.set(uid, t);
  };

  // Frames (design 4.4). Durable ones are queued for the async handler; the link acks them at once.
  const gate = (uid) => X.isContact(shadowId(uid)) || X.isFriend(shadowId(uid));
  X.DURABLE['grp.op'] = (uid, d) => { if (gate(uid)) inbound(() => onOp(uid, d)); };
  X.DURABLE['grp.item'] = (uid, d) => { if (gate(uid)) inbound(() => onItem(uid, d)); };
  X.DURABLE['grp.rcpt'] = (uid, d) => { if (gate(uid)) inbound(() => onRcpt(uid, d)); };
  X.EPHEMERAL['grp.inv'] = (uid, d) => { if (gate(uid)) inbound(() => onInv(uid, d)); };
  X.EPHEMERAL['grp.need'] = (uid, d) => { if (gate(uid)) inbound(() => onNeed(uid, d)); };

  // ---------- The ops ----------
  const wrap = (name, fn) => { const base = ops[name]; if (!base) return; ops[name] = (c, d) => fn(c, d || {}, base); };
  const remoteFriendUids = (users, max) => {
    const out = [];
    for (const u of users) {
      if (!X.isRemote(u)) fail(MIX);
      if (!X.isFriend(u)) fail('You can only add friends to a group with friends on other PCs.');
      if (X.blockedEither(u)) fail(`You can’t add ${M.userRow(u)?.name || 'them'}.`);
      out.push(X.uidOf(u));
    }
    if (out.length > max) fail(`A group can have up to ${MAX_MEMBERS} people.`);
    return out;
  };
  function cleanName(n) {
    if (n === null || n === undefined || n === '') return null;
    if (typeof n !== 'string') fail('The name is missing.');
    const label = n.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').trim().replace(/\s+/g, ' ');
    if (!label) fail('The name can’t be empty.');
    if ([...label].length > 40) fail('The name can be at most 40 characters.');
    return label;
  }
  function create(uids, name = null) {
    const op = myOp(null, 'create', { name, members: uids });
    return op.g;
  }
  const oneToOneRemote = (dm) => {
    if (typeof dm !== 'string' || isGroup(dm)) return null;
    const m = db.all('SELECT user FROM dm_members WHERE dm = ?', dm).map((r) => r.user);
    const r = m.filter(X.isRemote);
    return r.length === 1 && m.length === 2 && !db.get('SELECT owner FROM dms WHERE id = ?', dm)?.owner ? r[0] : null;
  };
  wrap('dm.open', (c, d, base) => {
    const others = [...new Set(Array.isArray(d.users) ? d.users : [])].filter((u) => u !== c.user);
    if (c.peer || others.length < 2 || !others.some(X.isRemote) || !mineC(c)) return base(c, d);
    if (!others.every(X.isRemote)) fail(MIX);
    const uids = remoteFriendUids(others, MAX_MEMBERS - 1);
    // The same people again: the group you already have.
    const want = [me(), ...uids].sort().join();
    const have = myGroups().find((g) => [...state(g).members.keys()].sort().join() === want);
    const g = have || create(uids);
    hub.sendDm(c.user, g);
    return { id: g };
  });
  wrap('dm.add', (c, d, base) => {
    const users = Array.isArray(d.users) ? [...new Set(d.users)] : [];
    if (c.peer) return base(c, d);
    if (isGroup(d.dm)) {
      if (!mineC(c) || !amIn(d.dm)) fail('You’re not in that conversation.');
      const st = state(d.dm);
      const adding = users.filter((u) => !st.members.has(uidOfLocal(u)));
      if (!adding.length) fail('Pick someone who isn’t here yet.');
      const uids = remoteFriendUids(adding, MAX_MEMBERS - st.members.size);
      myOp(d.dm, 'add', { uids });
      return { id: d.dm };
    }
    const one = oneToOneRemote(d.dm);
    if (one && mineC(c) && users.length) {
      if (!M.inDm(d.dm, c.user)) fail('You’re not in that conversation.');
      const adding = users.filter((u) => u !== one && u !== c.user);
      if (!adding.length) fail('Pick someone who isn’t here yet.');
      const uids = remoteFriendUids(adding, MAX_MEMBERS - 2);
      const g = create([X.uidOf(one), ...uids]);
      hub.sendDm(c.user, g);
      return { id: g, created: true };
    }
    if (users.some(X.isRemote) && typeof d.dm === 'string' && db.get('SELECT 1 FROM dms WHERE id = ?', d.dm)) fail(MIX);
    return base(c, d);
  });
  const groupOnly = (name, fn) => wrap(name, (c, d, base) => {
    if (!isGroup(d.dm)) return base(c, d);
    if (c.peer || !mineC(c) || !amIn(d.dm)) fail('You’re not in that conversation.');
    return fn(c, d, state(d.dm));
  });
  groupOnly('dm.kick', (c, d, st) => {
    const uid = uidOfLocal(d.user);
    if (st.owner !== me()) fail('Only the group’s owner can remove people.');
    if (uid === me()) fail('To go, leave the group.');
    if (!uid || !st.members.has(uid)) fail('That person isn’t in this group.');
    // Every op of theirs I have: any other (back-dated) op of theirs loses to this remove.
    const seen = db.all('SELECT id FROM grp_ops WHERE g = ? AND by = ?', d.dm, uid).map((r) => r.id).slice(-MAX_OPS);
    myOp(d.dm, 'remove', { uid, seen });
    return {};
  });
  groupOnly('dm.leave', (c, d) => { myOp(d.dm, 'leave', {}); return {}; });
  groupOnly('dm.rename', (c, d, st) => {
    const name = cleanName(d.name);
    if ((st.name ?? null) === name) return {};
    myOp(d.dm, 'rename', { name });
    return {};
  });
  groupOnly('dm.icon', (c, d) => {
    if (d.emoji === null || d.emoji === undefined || d.emoji === '') { myOp(d.dm, 'icon', { emoji: null }); return {}; }
    if (typeof d.emoji !== 'string' || d.emoji.length > 16 || !EMOJI.test(d.emoji)) fail('The icon can be one emoji.');
    let hue = null;
    if (d.hue !== undefined && d.hue !== null) { if (!Number.isInteger(d.hue) || !HUE_SET.has(d.hue)) fail('Pick one of the colours.'); hue = d.hue; }
    myOp(d.dm, 'icon', { emoji: d.emoji, hue });
    return {};
  });
  // Messages: applied here as usual, then signed and queued for every other member.
  const inGroup = (c, conv) => isGroup(conv) && !c.peer;
  wrap('msg.send', (c, d, base) => {
    if (!inGroup(c, d.conv)) return base(c, d);
    if (!mineC(c) || !amIn(d.conv)) fail('You don’t have access to this conversation.');
    const fresh = typeof d.id === 'string' && !M.msg(d.id);
    const r = base(c, d);
    if (fresh && r?.m) {
      const m = r.m;
      X.later(async () => {
        const files = [];
        for (const f of m.files || []) {
          const row = db.get('SELECT id, name, type, size FROM files WHERE id = ?', f.id);
          if (!row) continue;
          const hash = await X.hashOf(row.id);
          files.push({ id: row.id, name: row.name, type: row.type, size: row.size, hash, ...(f.w ? { w: f.w, h: f.h } : {}) });
        }
        myItem(d.conv, 'msg', { text: m.text || '', ...(m.replyTo ? { replyTo: m.replyTo } : {}), ...(files.length ? { files } : {}) }, m.id, m.ts);
      });
    }
    return r;
  });
  const itemOp = (name, k, pick) => wrap(name, (c, d, base) => {
    if (!inGroup(c, d.conv)) return base(c, d);
    if (!mineC(c) || !amIn(d.conv)) fail('You don’t have access to this conversation.');
    const r = base(c, d);
    X.later(() => myItem(d.conv, k, pick(d)));
    return r;
  });
  itemOp('msg.edit', 'edit', (d) => ({ id: d.id, text: d.text }));
  itemOp('msg.delete', 'delete', (d) => ({ id: d.id }));
  itemOp('msg.restore', 'restore', (d) => ({ id: d.id }));
  itemOp('react', 'react', (d) => ({ id: d.id, emoji: d.emoji, on: d.on === true }));
  wrap('call.start', (c, d, base) => { if (isGroup(d.dm)) fail(NO_CALLS); return base(c, d); });
  wrap('call.join', (c, d, base) => { if (isGroup(d.dm)) fail(NO_CALLS); return base(c, d); });

  // Snapshot: how many people each of my recent messages still waits for.
  const baseSnap = hub.snapshotFor;
  hub.snapshotFor = (u) => {
    const snap = baseSnap(u);
    if (u === X.owner()) {
      snap.peerWaitingN = {};
      for (const r of db.all('SELECT g, id, COUNT(*) n FROM grp_pending GROUP BY g, id')) (snap.peerWaitingN[r.g] ||= {})[r.id] = r.n;
      snap.peerFailedN = {};
      for (const r of db.all('SELECT g, id, COUNT(*) n FROM grp_failed GROUP BY g, id')) (snap.peerFailedN[r.g] ||= {})[r.id] = r.n;
    }
    return snap;
  };

  // ---------- The data file section (design 2.4) ----------
  const section = {
    name: 'groups',
    export(ctx) {
      const owner = ctx?.owner || X.owner();
      const my = ctx?.myUid || me();
      const groups = myGroups().map((g) => {
        const st = state(g);
        const rows = db.all('SELECT * FROM messages WHERE conv = ? AND sys IS NULL ORDER BY seq DESC LIMIT 5000', g).reverse();
        const rx = M.reactions(rows.map((r) => r.id));
        const msgs = rows.map((r) => {
          const a = r.author === owner ? my : String(r.author).slice(2);
          const m = { id: r.id, a, ts: r.ts, text: String(r.text || '').slice(0, 4000) };
          if (r.reply_to) m.r = r.reply_to;
          if (r.edited) m.e = r.edited;
          if (r.deleted) m.d = r.deleted;
          const x = Object.entries(rx[r.id] || {}).flatMap(([e, us]) => us.map((u) => ({ u: u === owner ? my : String(u).slice(2), e })));
          if (x.length) m.x = x;
          return m;
        });
        return { g, name: st.name, icon: st.icon, ops: opRows(g), msgs };
      });
      return exportGroups(groups);
    },
    import(data, ctx) {
      const owner = ctx?.owner || X.owner();
      const my = ctx?.myUid || me();
      const D = ctx?.db || db;
      const keysOf = (uid) => D.all('SELECT ik FROM peer_keys WHERE uid = ? UNION SELECT ik FROM peers WHERE uid = ?', uid, uid).map((r) => r.ik);
      for (const grp of parseGroupsSection(data)) {
        // Ops by others are checked against the pinned keys; my own came sealed in my own data file.
        const good = grp.ops.filter((x) => x.op.by === my || keysOf(x.op.by).some((ik) => verifyOp(ik, x.op, x.sig)));
        const st = replay(grp.g, good.map((x) => x.op));
        if (!st.ok || !st.members.has(my)) continue;
        for (const x of good) D.run('INSERT OR IGNORE INTO grp_ops (g, id, by, ts, body, sig) VALUES (?, ?, ?, ?, ?, ?)', grp.g, x.op.id, x.op.by, x.op.ts, x.body, x.sig);
        invalidate(grp.g);
        const st2 = replay(grp.g, opsOf(grp.g));
        const local = (uid) => (uid === my ? owner : shadowId(uid));
        const exists = (id) => !!D.get('SELECT 1 FROM users WHERE id = ?', id);
        if (!D.get('SELECT 1 FROM dms WHERE id = ?', grp.g)) D.run('INSERT INTO dms (id, name, created) VALUES (?, ?, ?)', grp.g, st2.name, st2.created || Date.now());
        D.run('UPDATE dms SET name = ?, owner = ?, icon = ?, icon_hue = ? WHERE id = ?', st2.name, exists(local(st2.owner)) ? local(st2.owner) : owner, st2.icon?.emoji || null, st2.icon?.hue ?? null, grp.g);
        for (const uid of [my, ...[...st2.members.keys()].filter((u) => u !== my)]) if (exists(local(uid))) D.run('INSERT OR IGNORE INTO dm_members (dm, user) VALUES (?, ?)', grp.g, local(uid));
        for (const m of grp.msgs) {
          if (!m || typeof m.id !== 'string' || !/^m_[a-z0-9]{8,40}$/.test(m.id) || !isUid(m.a) || !Number.isSafeInteger(m.ts) || typeof m.text !== 'string' || m.text.length > 4000) throw new Error('bad group message');
          const author = local(m.a);
          if (!exists(author)) continue;
          const was = D.get('SELECT conv FROM messages WHERE id = ?', m.id);
          if (was) { if (was.conv !== grp.g) throw new Error('message id taken'); continue; }
          D.run('INSERT INTO messages (id, conv, author, ts, text, fold, reply_to, edited, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            m.id, grp.g, author, m.ts, m.text, M.foldText(m.text, []), typeof m.r === 'string' ? m.r : null,
            Number.isSafeInteger(m.e) ? m.e : null, Number.isSafeInteger(m.d) ? m.d : null);
          for (const x of Array.isArray(m.x) ? m.x.slice(0, 100) : []) {
            if (x && isUid(x.u) && typeof x.e === 'string' && x.e.length <= 32 && exists(local(x.u))) D.run('INSERT OR IGNORE INTO reactions (msg, user, emoji, ts) VALUES (?, ?, ?, ?)', m.id, local(x.u), x.e, m.ts);
          }
        }
      }
      invalidate();
      queueMicrotask(() => { invalidate(); X.watchSoon(); });
    },
  };
  (hub.vaultSections ||= []).push(section);

  const api = {
    enabled: true,
    stats: () => ({ ...stats, groups: myGroups().length, pending: db.get('SELECT COUNT(*) n FROM grp_pending').n, items: db.get('SELECT COUNT(*) n FROM grp_items').n }),
    state, myGroups, section,
    _flushRcpts: flushRcpts,
  };
  peer.groups = api; // tests and Track C reach it as srv.peer.groups
  return api;
}
