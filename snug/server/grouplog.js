// Groups across PCs (design 0.10 section 4): the pure part. Group ids, the
// shapes of signed membership ops and message items, their signed strings, and
// replay(): the same op set gives the same group on every member's PC.
// No state, no I/O.
import { canon, sha256, base32, signStr, verifyStr, UID } from './peercrypto.js';

export const MAX_MEMBERS = 25;          // including the creator
export const MAX_OPS = 300;
// sec-registry REG-M3: room past MAX_OPS for the ops that keep membership in hand (a remove by the owner, a
// leave), so a member can't freeze a group by filling the log; and a per-member quota (the owner has none).
export const MAX_OPS_HARD = MAX_OPS + 60;
export const AUTHOR_MAX = 30;
export const ITEM_DAYS = 30;
export const LEFT_GRACE = 24 * 3600_000; // items by someone who left: at most this long after the leave
export const GID = /^dg_[a-z2-7]{26}$/;
export const OP_ID = /^o_[a-z0-9]{16}$/;
export const ITEM_ID = /^m_[a-z0-9]{8,40}$/;
const OP_TYPES = new Set(['create', 'add', 'remove', 'leave', 'rename', 'icon']);
// pin and ttl: 0.12 (a 0.11 PC drops items of a kind it doesn't know, and is never sent a ttl).
const ITEM_KINDS = new Set(['msg', 'edit', 'delete', 'restore', 'react', 'pin', 'ttl']);
const TTLS = [0, 3_600_000, 86_400_000, 7 * 86_400_000, 30 * 86_400_000];
const isUid = (s) => typeof s === 'string' && UID.test(s);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

export const gidFor = (creatorUid, createOpId) => `dg_${base32(sha256(`snug-group-v1\n${creatorUid}\n${createOpId}`)).slice(0, 26)}`;
export const opString = (op) => `snug-gop-v1\n${canon(op)}`;
export const itemString = (item) => `snug-gitem-v1\n${canon(item)}`;
export const signOp = (ikPriv, op) => signStr(ikPriv, opString(op));
export const verifyOp = (ik, op, sig) => { try { return verifyStr(ik, opString(op), sig); } catch { return false; } };
export const signItem = (ikPriv, item) => signStr(ikPriv, itemString(item));
export const verifyItem = (ik, item, sig) => { try { return verifyStr(ik, itemString(item), sig); } catch { return false; } };

const nameOk = (n) => n === null || (typeof n === 'string' && n.trim().length > 0 && [...n].length <= 40);
const iconOk = (i) => isObj(i) && typeof i.emoji === 'string' && i.emoji.length > 0 && i.emoji.length <= 16
  && (i.hue === null || i.hue === undefined || Number.isInteger(i.hue));

// The shape of an op, before any signature or membership check. True when well formed.
export function opShape(op) {
  if (!isObj(op) || !GID.test(op.g) || typeof op.id !== 'string' || !OP_ID.test(op.id) || !OP_TYPES.has(op.t)
    || !isUid(op.by) || !Number.isSafeInteger(op.kver) || op.kver < 1 || !Number.isSafeInteger(op.ts) || op.ts < 0 || !isObj(op.d)) return false;
  const keys = Object.keys(op).sort().join();
  if (keys !== 'by,d,g,id,kver,t,ts') return false;
  const d = op.d;
  switch (op.t) {
    case 'create':
      return nameOk(d.name ?? null) && Array.isArray(d.members) && d.members.length <= MAX_MEMBERS - 1
        && d.members.every(isUid) && new Set(d.members).size === d.members.length && !d.members.includes(op.by)
        && (d.icon === undefined || d.icon === null || iconOk(d.icon));
    case 'add': return Array.isArray(d.uids) && d.uids.length >= 1 && d.uids.length <= MAX_MEMBERS - 1 && d.uids.every(isUid) && new Set(d.uids).size === d.uids.length;
    // seen: the ids of the removed member's ops the remover had (remove wins over the rest, see replay()).
    case 'remove': return isUid(d.uid) && (d.seen === undefined || (Array.isArray(d.seen) && d.seen.length <= MAX_OPS && d.seen.every((x) => typeof x === 'string' && OP_ID.test(x))));
    case 'leave': return Object.keys(d).length === 0;
    case 'rename': return nameOk(d.name ?? null);
    case 'icon': return iconOk(d) || (d.emoji === null);
    default: return false;
  }
}

export function itemShape(item) {
  if (!isObj(item) || !GID.test(item.g) || typeof item.id !== 'string' || !ITEM_ID.test(item.id) || !ITEM_KINDS.has(item.k)
    || !isUid(item.by) || !Number.isSafeInteger(item.kver) || item.kver < 1 || !Number.isSafeInteger(item.ts) || item.ts < 0 || !isObj(item.d)) return false;
  if (Object.keys(item).sort().join() !== 'by,d,g,id,k,kver,ts') return false;
  const d = item.d;
  const mid = (v) => typeof v === 'string' && ITEM_ID.test(v);
  switch (item.k) {
    // t (0.12): a thread reply names its thread's first message.
    case 'msg': return typeof d.text === 'string' && d.text.length <= 4000 && (d.replyTo === undefined || mid(d.replyTo))
      && (d.files === undefined || (Array.isArray(d.files) && d.files.length <= 6)) && (d.t === undefined || mid(d.t));
    case 'edit': return mid(d.id) && typeof d.text === 'string' && d.text.length <= 4000;
    case 'delete': case 'restore': return mid(d.id);
    case 'react': return mid(d.id) && typeof d.emoji === 'string' && d.emoji.length <= 32 && typeof d.on === 'boolean';
    case 'pin': return mid(d.id) && typeof d.on === 'boolean';
    case 'ttl': return TTLS.includes(d.ttl);
    default: return false;
  }
}

// Replay a group's ops (already signature-checked) into its state.
// Sorted by (ts, id); exactly one create whose id gives g; every other op only
// counts when its author is a member at that point. Invalid ops are ignored.
// Remove wins: an op by a removed member that sorts before the remove and that
// the remover hadn't seen (not in remove.d.seen) is dropped, so a removed member
// can't get back in by signing a back-dated op (security review 0.10 #1).
// Returns { ok, g, owner, name, icon, members: Map uid -> {joinedTs},
//           spans: Map uid -> [{from, to|null}], valid: Set(opId), created }.
const opCmp = (a, b) => (a.ts - b.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
export function replay(g, ops) {
  let use = [...ops].filter((o) => o && o.g === g);
  for (let round = 0; round < 8; round++) {
    const st = replayOnce(g, use);
    const drop = new Set();
    for (const r of use) {
      // Removes made by this code always carry seen; one without it (none shipped) keeps the plain rule.
      if (r.t !== 'remove' || !st.valid.has(r.id) || !Array.isArray(r.d.seen)) continue;
      const seen = new Set(r.d.seen);
      for (const o of use) if (o.by === r.d.uid && o.t !== 'create' && opCmp(o, r) < 0 && !seen.has(o.id)) drop.add(o.id);
    }
    if (!drop.size) return st;
    use = use.filter((o) => !drop.has(o.id));
  }
  return replayOnce(g, use);
}
function replayOnce(g, ops) {
  const sorted = [...ops].filter((o) => o && o.g === g).sort(opCmp);
  const st = { ok: false, g, owner: null, name: null, icon: null, members: new Map(), spans: new Map(), valid: new Set(), created: null };
  const join = (uid, ts) => {
    st.members.set(uid, { joinedTs: ts });
    if (!st.spans.has(uid)) st.spans.set(uid, []);
    st.spans.get(uid).push({ from: ts, to: null });
  };
  const part = (uid, ts) => {
    st.members.delete(uid);
    const s = st.spans.get(uid);
    if (s?.length) s[s.length - 1].to = ts;
  };
  const longest = () => [...st.members.entries()].sort((a, b) => (a[1].joinedTs - b[1].joinedTs) || (a[0] < b[0] ? -1 : 1))[0]?.[0] || null;
  for (const op of sorted) {
    if (!opShape(op)) continue;
    if (op.t === 'create') {
      if (st.ok || gidFor(op.by, op.id) !== g) continue;
      st.ok = true;
      st.created = op.ts;
      st.owner = op.by;
      st.name = op.d.name ?? null;
      st.icon = op.d.icon ? { emoji: op.d.icon.emoji, hue: op.d.icon.hue ?? null } : null;
      join(op.by, op.ts);
      for (const u of op.d.members) join(u, op.ts);
      st.valid.add(op.id);
      continue;
    }
    if (!st.ok || !st.members.has(op.by)) continue;
    const d = op.d;
    if (op.t === 'add') {
      if (d.uids.some((u) => st.members.has(u)) || st.members.size + d.uids.length > MAX_MEMBERS) continue;
      for (const u of d.uids) join(u, op.ts);
    } else if (op.t === 'remove') {
      if (op.by !== st.owner || d.uid === op.by || !st.members.has(d.uid)) continue;
      part(d.uid, op.ts);
    } else if (op.t === 'leave') {
      part(op.by, op.ts);
      if (st.owner === op.by) st.owner = longest();
    } else if (op.t === 'rename') {
      st.name = d.name ?? null;
    } else if (op.t === 'icon') {
      st.icon = d.emoji ? { emoji: d.emoji, hue: d.hue ?? null } : null;
    }
    st.valid.add(op.id);
  }
  return st;
}

// Was uid a member at time ts? (a join at ts counts; a leave at ts does not)
export function memberAt(st, uid, ts) {
  return (st.spans.get(uid) || []).some((s) => s.from <= ts && (s.to === null || ts < s.to));
}
// When uid's latest membership ended (null while a member, or never one).
export function leftAt(st, uid) {
  if (st.members.has(uid)) return null;
  const s = st.spans.get(uid);
  return s?.length ? s[s.length - 1].to : null;
}
// May an item by `by` at `ts` be accepted, received at `now`?
export function itemAllowed(st, item, now) {
  if (!st.ok || !memberAt(st, item.by, item.ts)) return false;
  if (item.ts < now - ITEM_DAYS * 86_400_000 || item.ts > now + 60_000) return false;
  const left = leftAt(st, item.by);
  if (left !== null && now > left + LEFT_GRACE) return false;
  return true;
}
// A stable digest of a set of op ids (for the inventory exchange).
export const opsDigest = (ids) => base32(sha256([...ids].sort().join('\n'))).slice(0, 16);

// The vault section (design 2.4) as pure functions over plain data.
// exportGroups(rows) -> JSON-able; importGroups(data) -> normalized list, or throws.
export function exportGroups(groups) {
  return { groups: groups.map((x) => ({ g: x.g, name: x.name ?? null, icon: x.icon ?? null, ops: x.ops.map((o) => ({ body: o.body, sig: o.sig })), msgs: (x.msgs || []).slice(-5000) })) };
}
export function parseGroupsSection(data) {
  if (!isObj(data) || !Array.isArray(data.groups) || data.groups.length > 200) throw new Error('bad groups section');
  return data.groups.map((x) => {
    if (!isObj(x) || !GID.test(x.g) || !Array.isArray(x.ops) || x.ops.length > MAX_OPS_HARD || !Array.isArray(x.msgs) || x.msgs.length > 5000) throw new Error('bad group');
    const ops = x.ops.map((o) => {
      if (!isObj(o) || typeof o.body !== 'string' || typeof o.sig !== 'string' || o.body.length > 16384) throw new Error('bad op');
      const op = JSON.parse(o.body);
      if (!opShape(op) || op.g !== x.g) throw new Error('bad op');
      return { op, body: o.body, sig: o.sig };
    });
    return { g: x.g, ops, msgs: x.msgs };
  });
}
