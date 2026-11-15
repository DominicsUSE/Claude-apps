// Who a message must be sealed to: one rule, used by the server to refuse a
// stale or partial recipient list and by the client to build one, so the two
// can't drift apart.
//
// For a conversation with members M, the recipients are
//   to: (u, d, kid) for every member u, every trusted device d of u, and d's
//       current prekey (or the one before it, for an hour after it was retired:
//       a message sealed just before a rotation is still accepted);
//   ar: (u, e) for every member u with history on, at u's current epoch.
// Removed and pending devices never receive anything.

export const PREV_KID_GRACE = 60 * 60_000;

/** A DM can be end-to-end encrypted unless it is a P2P conversation (a member on another PC). */
export function eligible(dm, isRemote = () => false) {
  if (!dm || dm.peer || dm.p2p) return false;
  return Array.isArray(dm.members) && dm.members.length >= 2 && dm.members.every((u) => !isRemote(u));
}

/**
 * members: user ids; accounts: { u: { hist, epoch } }; devices: [{ id, user, state }];
 * prekeys: [{ device, kid, retired }]. Returns
 *   { to: [[u, d, kid]] sorted, alt: { d: previousKid }, ar: [[u, e]] sorted, missing: [u] }
 * where `missing` lists members with no account keys or no device ready.
 */
export function requiredSet({ members, accounts, devices, prekeys, now = Date.now() }) {
  const to = [], ar = [], alt = {}, missing = [];
  const live = new Map(); // device -> { cur, prev }
  for (const p of prekeys) {
    const e = live.get(p.device) || {};
    if (p.retired == null) { if (!e.cur || p.kid > e.cur) e.cur = p.kid; }
    else if (now - p.retired <= PREV_KID_GRACE && (!e.prev || p.kid > e.prev)) e.prev = p.kid;
    live.set(p.device, e);
  }
  for (const u of [...new Set(members)].sort()) {
    const acc = accounts[u];
    const devs = devices.filter((d) => d.user === u && d.state === 'trusted' && live.get(d.id)?.cur);
    if (!acc || !devs.length) { missing.push(u); continue; }
    for (const d of devs) {
      const k = live.get(d.id);
      to.push([u, d.id, k.cur]);
      if (k.prev && k.prev < k.cur) alt[d.id] = k.prev;
    }
    if (acc.hist && acc.epoch) ar.push([u, acc.epoch]);
  }
  to.sort(cmpTuple);
  ar.sort(cmpTuple);
  return { to, alt, ar, missing };
}

export function cmpTuple(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Does a header's recipient list match the required set exactly? Returns
 * { ok: true } or { ok: false, users: [u] } naming the members whose part is
 * wrong (missing, extra or stale), so the client refetches only those.
 */
export function checkRecipients(req, to, ar) {
  const bad = new Set();
  const want = new Map(req.to.map(([u, d, kid]) => [d, { u, kid }]));
  const seen = new Set();
  if (!Array.isArray(to) || !Array.isArray(ar)) return { ok: false, users: [] };
  for (const t of to) {
    if (!Array.isArray(t) || t.length !== 3) return { ok: false, users: [] };
    const [u, d, kid] = t;
    const w = want.get(d);
    if (!w || w.u !== u || seen.has(d) || (kid !== w.kid && kid !== req.alt[d])) bad.add(String(u));
    seen.add(d);
  }
  for (const [d, w] of want) if (!seen.has(d)) bad.add(w.u);
  const wantAr = new Map(req.ar.map(([u, e]) => [u, e]));
  const seenAr = new Set();
  for (const a of ar) {
    if (!Array.isArray(a) || a.length !== 2) return { ok: false, users: [] };
    const [u, e] = a;
    if (wantAr.get(u) !== e || seenAr.has(u)) bad.add(String(u));
    seenAr.add(u);
  }
  for (const u of wantAr.keys()) if (!seenAr.has(u)) bad.add(u);
  return bad.size ? { ok: false, users: [...bad].sort() } : { ok: true };
}

/** The wrap keys a header implies: "d:<device>" per device, "a:<user>:<epoch>" per history key. */
export const wrapKeys = (to, ar) => [...to.map(([, d]) => `d:${d}`), ...ar.map(([u, e]) => `a:${u}:${e}`)];

/** An edit goes to the original recipients who are still members (never to people who joined later). */
export function editSet(originalTo, members) {
  const now = new Set(members);
  return [...new Set(originalTo.map(([u]) => u))].filter((u) => now.has(u)).sort();
}
