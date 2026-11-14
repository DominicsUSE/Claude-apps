// Links between this PC and a friend's PC (design sections 1.4, 5.3, 5.4).
//
// A link is opened on demand (outbox items, a profile push, typing, a call, a
// blob), runs a signed X25519 handshake over whichever transport it got (a
// WebRTC data channel hosted by the desktop renderer, or the registry relay),
// then carries signed, AES-256-GCM encrypted frames. Durable frames come from
// the per-peer outbox with sequence numbers, cumulative acks and epochs;
// ephemeral ones are dropped when the link is down. Links close after
// `idleMs` without app frames. Nothing here polls: the only timers are the
// handshake and dial timeouts, the ack debounce, the unacked timeout and an
// idle sweep that exists only while a link is open.
import { randomBytes } from 'node:crypto';
import {
  canon, parseCapped, hs1Make, hs2Make, hsShape, hs2Binds, sessionKeys, frameSeal, frameOpen, b64u, MAX_COUNTER,
} from './peercrypto.js';
import { limiter } from './auth.js';

const WINDOW = 64;
const MAX_LINKS = 32;
const HS_MS = 10_000;
const UNACKED_MS = 30_000;
const SKEW_MS = 10 * 60_000;
const FRAME_MAX = 64 * 1024;
const BATCH_MAX = 60 * 1024;

export function createLinks(ctx) {
  const {
    me, now, db, outbox, peerOf, verifyHs, online, relaySend, sigSend, host, onFrame, applyDurable, onUp, onDown,
    isUserError, log = () => {}, stats, opts = {},
  } = ctx;
  const idleMs = opts.idleMs ?? 120_000;
  const dialMs = opts.dialMs ?? 8000;
  const links = new Map();         // uid -> link
  const seenSids = new Map();      // sid -> 1, last 1000
  const failures = new Map();      // `${uid}:${seq}` -> count (non-validation apply errors)
  // Data frames that arrive while a handshake is still being verified (hs2 and the
  // first frames often come in one relay batch): kept, then handled once it is up.
  const early = new Map();         // uid -> [frame]
  const L_frames = limiter({ capacity: 200, perSecond: 50 });
  const L_durable = limiter({ capacity: 20, perSecond: 20 });
  const L_hour = limiter({ capacity: 2000, perSecond: 2000 / 3600 });
  let sweep = null;

  const seen = (sid) => {
    if (seenSids.has(sid)) return true;
    seenSids.set(sid, 1);
    if (seenSids.size > 1000) seenSids.delete(seenSids.keys().next().value);
    return false;
  };
  const touch = (L) => { L.lastApp = Date.now(); links.delete(L.uid); links.set(L.uid, L); };

  function ensureSweep() {
    if (sweep || !links.size) return;
    sweep = setInterval(() => {
      const t = Date.now();
      for (const L of [...links.values()]) {
        if (L.state === 'up' && t - L.lastApp >= idleMs && L.acked >= L.sentUpTo && !L.busyBlob) close(L, 'idle');
        else if (L.state !== 'up' && t - L.lastApp >= 30_000) close(L, 'stale');
      }
      if (!links.size) { clearInterval(sweep); sweep = null; }
    }, Math.max(50, Math.min(30_000, Math.floor(idleMs / 2))));
    sweep.unref?.();
  }

  function newLink(uid) {
    const p = peerOf(uid);
    if (!p) return null;
    // Hard cap: the least recently used idle link makes room.
    if (links.size >= MAX_LINKS) {
      const victim = [...links.values()].find((x) => x.acked >= x.sentUpTo);
      if (victim) close(victim, 'cap'); else return null;
    }
    const L = {
      uid, user: p.user, state: 'new', transport: null, sid: null, role: null, eph: null, hs1: null, sess: null,
      peerIk: null, sentUpTo: 0, acked: 0, lastApp: Date.now(), rxSinceAck: 0, ackTimer: null, unackedT: null,
      hsT: null, dialT: null, directSid: null, dialRole: null, outQ: [], flushQueued: false, paused: false, wantReset: null,
      waiters: [],
    };
    links.set(uid, L);
    ensureSweep();
    return L;
  }

  // ---------- Transport ----------
  function flush(L) {
    L.flushQueued = false;
    if (!L.outQ.length || L.state === 'closed') return;
    if (L.transport === 'direct') {
      if (L.paused) return;
      // One op per batch, at most 16 frames and 400 KB (section 5.2).
      while (L.outQ.length) {
        const fs = [];
        let size = 0;
        while (L.outQ.length && fs.length < 16 && size + L.outQ[0].length <= 400 * 1024) { size += L.outQ[0].length; fs.push(L.outQ.shift()); }
        if (!fs.length) fs.push(L.outQ.shift());
        if (!host.out(L.uid, L.directSid, fs)) { L.outQ.length = 0; close(L, 'host gone', true); return; }
      }
      return;
    }
    // Relay: frames of the same tick go as batch frames of at most 60 KB (S2).
    while (L.outQ.length) {
      const fs = [];
      let size = 20;
      while (L.outQ.length && (fs.length === 0 || size + L.outQ[0].length + 3 <= BATCH_MAX)) { size += L.outQ[0].length + 3; fs.push(L.outQ.shift()); }
      const box = fs.length === 1 ? fs[0] : JSON.stringify({ k: 'b', fs });
      if (!relaySend(L.uid, box)) { L.outQ.length = 0; close(L, 'relay down', true); return; }
    }
  }
  function tx(L, str) {
    if (str.length > FRAME_MAX) throw new Error('frame too big');
    L.outQ.push(str);
    if (!L.flushQueued) { L.flushQueued = true; queueMicrotask(() => flush(L)); }
  }

  // ---------- Opening ----------
  const directOk = () => opts.direct !== false && host.available() && !opts.hideIp?.();
  // A reason to talk to this friend: open a link if there is none.
  function want(uid) {
    if (!online(uid)) return null;
    let L = links.get(uid);
    if (L && L.state !== 'closed') { if (L.state === 'up') pump(L); return L; }
    L = newLink(uid);
    if (!L) return null;
    if (directOk()) {
      L.state = 'dialing';
      L.directSid = b64u(randomBytes(12));
      L.dialRole = 'offer';
      host.dial(uid, L.directSid, null);
      L.dialT = setTimeout(() => toRelay(L, 'timeout'), dialMs);
    } else startHandshake(L, 'relay');
    return L;
  }
  // The direct attempt did not open in time (or the other side has no host): use the relay.
  function toRelay(L, why) {
    if (L.state !== 'dialing' || links.get(L.uid) !== L) return;
    clearTimeout(L.dialT);
    stats.directFail++;
    stats.relayed = true;
    if (L.directSid) host.hangup(L.uid, L.directSid);
    L.directSid = null;
    log('peer', 'direct failed', why);
    if (L.dialRole === 'offer') startHandshake(L, 'relay');
    else L.state = 'new'; // the other side starts the relay handshake
  }
  function startHandshake(L, transport) {
    const m = me();
    const p = peerOf(L.uid);
    if (!m || !p) { close(L, 'gone'); return; }
    L.transport = transport;
    L.role = 'A';
    L.state = 'hs';
    const { hs, eph } = hs1Make(m, L.uid, { ...ctx.hsInfo(), ep: p.out_ep, rx: { ep: p.in_ep, upto: p.in_seq }, now: Math.round(now()) });
    L.hs1 = hs;
    L.eph = eph;
    L.sid = hs.sid;
    clearTimeout(L.hsT);
    L.hsT = setTimeout(() => { if (L.state === 'hs') close(L, 'handshake timeout'); }, HS_MS);
    tx(L, JSON.stringify(hs));
  }

  // ---------- Receiving ----------
  // A transport string from the relay (via 'relay') or the link host (via 'direct', with its dial sid).
  function receive(uid, str, via, dsid, nested = false) {
    if (!L_frames.take(uid)) { const L = links.get(uid); if (L) close(L, 'flood'); return; }
    const f = parseCapped(str, FRAME_MAX + 1024);
    if (!f || typeof f.k !== 'string') { stats.rejected++; return; }
    if (f.k === 'b') {
      if (nested || via !== 'relay' || !Array.isArray(f.fs)) { stats.rejected++; return; }
      for (const s of f.fs.slice(0, 256)) if (typeof s === 'string') receive(uid, s, via, dsid, true);
      return;
    }
    if (f.k === 'hs1' || f.k === 'hs2') {
      const mine = !early.has(uid);
      if (mine) early.set(uid, []);
      const done = () => {
        if (!mine) return;
        const q = early.get(uid) || [];
        early.delete(uid);
        for (const x of q) onData(uid, x);
      };
      (f.k === 'hs1' ? onHs1(uid, f, via, dsid) : onHs2(uid, f, via)).catch((e) => log('peer', f.k, e.message)).finally(done);
      return undefined;
    }
    if (f.k === 'd') {
      const q = early.get(uid);
      if (q) { if (q.length < 256) q.push(f); return undefined; }
      return onData(uid, f);
    }
    if (f.k === 'bye') { const L = links.get(uid); if (L && typeof f.s === 'string' && f.s === L.sid) close(L, 'bye', true); return; }
    stats.rejected++;
  }
  const fresh = (ts) => Math.abs(ts - now()) <= SKEW_MS;

  async function onHs1(uid, hs, via, dsid) {
    const m = me();
    if (!m || !hsShape(hs) || hs.k !== 'hs1' || hs.from !== uid || hs.to !== m.uid || !fresh(hs.ts) || seenSids.has(hs.sid)) { stats.rejected++; return; }
    let L = links.get(uid);
    // Glare: both sides sent hs1 at once. The lower uid's wins.
    if (L && L.state === 'hs' && L.role === 'A' && m.uid < uid) return;
    const ik = await verifyHs(uid, hs);
    if (!ik) { stats.rejected++; return; }
    if (seen(hs.sid)) return;
    L = links.get(uid);
    if (L && L.state === 'hs' && L.role === 'A' && m.uid < uid) return;
    if (!L || L.state === 'closed') L = newLink(uid);
    if (!L) return;
    resetSession(L);
    L.transport = via;
    if (via === 'direct') L.directSid = dsid;
    else if (L.directSid) { host.hangup(uid, L.directSid); L.directSid = null; }
    clearTimeout(L.dialT);
    L.role = 'B';
    L.sid = hs.sid;
    L.peerIk = ik;
    const reset = epochs(L, hs);
    const p = peerOf(uid);
    const { hs: hs2, eph } = hs2Make(m, hs, { ...ctx.hsInfo(), ep: p.out_ep, rx: { ep: p.in_ep, upto: p.in_seq }, now: Math.round(now()) });
    L.sess = { ...sessionKeys('B', eph, hs.e, hs, hs2, uid, m.uid), nOut: 0, nIn: 0 };
    tx(L, JSON.stringify(hs2));
    up(L, reset, hs);
  }
  async function onHs2(uid, hs, via) {
    const m = me();
    const L = links.get(uid);
    if (!m || !L || L.state !== 'hs' || L.role !== 'A' || !hsShape(hs) || hs.k !== 'hs2' || hs.sid !== L.sid || !hs2Binds(hs, L.hs1) || !fresh(hs.ts)) { stats.rejected++; return; }
    const ik = await verifyHs(uid, hs);
    if (!ik || links.get(uid) !== L || L.state !== 'hs' || L.sid !== hs.sid) { if (!ik) stats.rejected++; return; }
    if (via !== L.transport) { stats.rejected++; return; }
    clearTimeout(L.hsT);
    L.peerIk = ik;
    const reset = epochs(L, hs);
    L.sess = { ...sessionKeys('A', L.eph, hs.e, L.hs1, hs, m.uid, uid), nOut: 0, nIn: 0 };
    L.eph = null;
    up(L, reset, hs);
  }
  function resetSession(L) {
    clearTimeout(L.hsT); clearTimeout(L.ackTimer); clearTimeout(L.unackedT);
    L.sess = null; L.eph = null; L.hs1 = null; L.sentUpTo = 0; L.acked = 0; L.rxSinceAck = 0; L.ackTimer = null; L.unackedT = null;
  }

  // Sequence epochs (section 5.4.1). Returns the new epoch when this side renumbered, else null.
  function epochs(L, hs) {
    const p = peerOf(L.uid);
    if (hs.ep !== p.in_ep) db.run("UPDATE peers SET in_ep = ?, in_seq = 0 WHERE user = ?", hs.ep, L.user);
    const min = outbox.minSeq(L.user);
    const rx = hs.rx;
    // Everything after what they hold must still be here to send; otherwise they lost my epoch.
    const ok = rx.ep === p.out_ep && rx.upto <= p.out_seq && (min == null ? rx.upto === p.out_seq : rx.upto >= min - 1);
    if (ok) {
      const rows = outbox.ack(L.user, rx.upto);
      if (rows.length) ctx.onAcked(L.uid, rows);
      L.sentUpTo = rx.upto; L.acked = rx.upto;
      return null;
    }
    const ep = outbox.renumber(L.user);
    L.sentUpTo = 0; L.acked = 0;
    return ep;
  }
  function up(L, reset, hs) {
    L.state = 'up';
    L.hs1 = null;
    touch(L);
    stats.links++;
    if (L.transport === 'direct') stats.direct++; else stats.relay++;
    if (reset) sendEph(L.uid, 'reset', { ep: reset });
    onUp(L.uid, hs);
    pump(L);
    for (const w of L.waiters.splice(0)) w(true);
  }

  function onData(uid, f) {
    const L = links.get(uid);
    if (!L || L.state !== 'up' || !L.sess) return;
    const P = frameOpen(L.sess, L.sid, L.peerIk, f);
    if (!P) { stats.rejected++; return; }
    stats.framesIn++;
    if (L.sess.nIn > MAX_COUNTER - 1) { close(L, 'counter'); return; }
    if (P.seq > 0) { touch(L); return durable(L, P); }
    switch (P.t) {
      case 'ack': return onAck(L, P.d?.upto);
      case 'nack': return onNack(L, P.d?.expect);
      case 'reset':
        if (typeof P.d?.ep === 'string' && /^[A-Za-z0-9_-]{11}$/.test(P.d.ep)) db.run('UPDATE peers SET in_ep = ?, in_seq = 0 WHERE user = ?', P.d.ep, L.user);
        return undefined;
      default:
        touch(L);
        try { onFrame(uid, P, L); } catch (e) { if (!isUserError(e)) log('peer', 'frame', P.t, e.message); stats.rejected++; }
        return undefined;
    }
  }

  function durable(L, P) {
    const p = peerOf(L.uid);
    if (!p) return;
    if (P.seq <= p.in_seq) { scheduleAck(L, true); return; }
    if (P.seq > p.in_seq + 1) { sendEph(L.uid, 'nack', { expect: p.in_seq + 1 }); return; }
    if (!L_durable.take(L.uid)) { close(L, 'flood'); return; }
    if (!L_hour.take(L.uid)) return; // over the hourly cap: not acked, sent again later
    const key = `${L.uid}:${P.seq}`;
    try {
      db.tx(() => {
        applyDurable(L.uid, P, L);
        db.run('UPDATE peers SET in_seq = ? WHERE user = ?', P.seq, L.user);
      });
      failures.delete(key);
    } catch (e) {
      if (isUserError(e)) {
        db.run('UPDATE peers SET in_seq = ? WHERE user = ?', P.seq, L.user);
        stats.rejected++;
        log('peer', 'refused', P.t, e.message);
      } else {
        const n = (failures.get(key) || 0) + 1;
        failures.set(key, n);
        if (failures.size > 1000) failures.delete(failures.keys().next().value);
        log('peer', 'apply failed', P.t, e.message);
        if (n < 3) return;
        failures.delete(key);
        db.run('UPDATE peers SET in_seq = ? WHERE user = ?', P.seq, L.user);
        stats.rejected++;
      }
    }
    scheduleAck(L);
  }
  function scheduleAck(L, now_ = false) {
    L.rxSinceAck++;
    if (now_ || L.rxSinceAck >= 16) return sendAck(L);
    if (!L.ackTimer) { L.ackTimer = setTimeout(() => sendAck(L), 250); L.ackTimer.unref?.(); }
    return undefined;
  }
  function sendAck(L) {
    clearTimeout(L.ackTimer); L.ackTimer = null; L.rxSinceAck = 0;
    const p = peerOf(L.uid);
    if (p && L.state === 'up') sendEph(L.uid, 'ack', { upto: p.in_seq });
  }
  function onAck(L, upto) {
    if (!Number.isSafeInteger(upto) || upto <= L.acked || upto > L.sentUpTo) return;
    const rows = outbox.ack(L.user, upto);
    L.acked = upto;
    if (rows.length) ctx.onAcked(L.uid, rows);
    clearTimeout(L.unackedT); L.unackedT = null;
    if (L.acked < L.sentUpTo) armUnacked(L);
    pump(L);
  }
  function onNack(L, expect) {
    if (!Number.isSafeInteger(expect) || expect < 1 || expect > L.sentUpTo + 1) return;
    L.sentUpTo = Math.max(L.acked, expect - 1);
    pump(L);
  }
  const armUnacked = (L) => { if (!L.unackedT) { L.unackedT = setTimeout(() => close(L, 'unacked'), UNACKED_MS); L.unackedT.unref?.(); } };

  // ---------- Sending ----------
  function pump(L) {
    if (!L || L.state !== 'up' || L.paused) return;
    const room = (ctx.windowFor?.(L.uid) ?? WINDOW) - (L.sentUpTo - L.acked);
    if (room <= 0) return;
    const rows = outbox.after(L.user, L.sentUpTo, room);
    const m = me();
    for (const r of rows) {
      const P = canon({ t: r.kind, seq: r.seq, ts: r.created, d: JSON.parse(r.body) });
      tx(L, frameSeal(L.sess, L.sid, m.ikPriv, P));
      stats.framesOut++;
      L.sentUpTo = r.seq;
    }
    if (rows.length) { touch(L); armUnacked(L); }
  }
  // An ephemeral frame (seq 0); false when there is no open link.
  function sendEph(uid, t, d) {
    const L = links.get(uid);
    if (!L || L.state !== 'up' || !L.sess) return false;
    const P = canon({ t, seq: 0, ts: Math.round(now()), d: d ?? {} });
    if (Buffer.byteLength(P) > 48 * 1024) throw new Error('frame too big');
    tx(L, frameSeal(L.sess, L.sid, me().ikPriv, P));
    stats.framesOut++;
    if (t !== 'ack' && t !== 'nack') touch(L);
    return true;
  }

  // ---------- Closing ----------
  function close(L, why, quiet = false) {
    if (!L || L.state === 'closed') return;
    const wasUp = L.state === 'up';
    const sayBye = !quiet && (L.state === 'up' || L.state === 'hs') && L.sid;
    L.state = 'closed';
    // Whatever is still queued goes first, then bye; a transport that fails here is simply gone.
    if (sayBye) {
      const fs = [...L.outQ.splice(0), JSON.stringify({ k: 'bye', s: L.sid })];
      try {
        if (L.transport === 'direct' && L.directSid) host.out(L.uid, L.directSid, fs);
        else if (L.transport === 'relay') for (const f of fs) relaySend(L.uid, f);
      } catch { /* transport gone */ }
    }
    clearTimeout(L.hsT); clearTimeout(L.dialT); clearTimeout(L.ackTimer); clearTimeout(L.unackedT);
    if (L.directSid) host.hangup(L.uid, L.directSid);
    if (links.get(L.uid) === L) links.delete(L.uid);
    for (const w of L.waiters.splice(0)) w(false);
    log('peer', 'link closed', why);
    if (wasUp) onDown(L.uid, why);
    if (!links.size && sweep) { clearInterval(sweep); sweep = null; }
  }

  return {
    want,
    receive,
    sendEph,
    pump: (uid) => pump(links.get(uid)),
    get: (uid) => links.get(uid),
    isUp: (uid) => links.get(uid)?.state === 'up',
    transportOf: (uid) => (links.get(uid)?.state === 'up' ? links.get(uid).transport : null),
    sentUpTo: (uid) => { const L = links.get(uid); return L?.state === 'up' ? L.sentUpTo : 0; },
    // Resolves true once the link is up (or false if it fails), within ms.
    ready(uid, ms = 12_000) {
      const L = want(uid);
      if (!L) return Promise.resolve(false);
      if (L.state === 'up') return Promise.resolve(true);
      return new Promise((resolve) => {
        const t = setTimeout(() => { L.waiters = L.waiters.filter((w) => w !== done); resolve(false); }, ms);
        const done = (ok) => { clearTimeout(t); resolve(ok); };
        L.waiters.push(done);
      });
    },
    close: (uid, why = 'closed') => close(links.get(uid), why),
    closeAll(why = 'stopped') { for (const L of [...links.values()]) close(L, why); },
    count: () => links.size,
    // ---------- Direct path plumbing (the renderer link host, section 5.2) ----------
    onSig(uid, obj) {
      const L0 = links.get(uid);
      if (obj.t === 'link.offer') {
        if (typeof obj.sid !== 'string' || typeof obj.sdp !== 'string' || obj.sdp.length > 12_000) return;
        if (!directOk()) { sigSend(uid, { t: 'link.nodirect', sid: obj.sid }); return; }
        if (L0 && L0.state === 'up') return;
        if (L0 && L0.state === 'dialing' && L0.dialRole === 'offer') {
          if (me().uid < uid) return; // glare: my offer wins
          host.hangup(uid, L0.directSid);
          clearTimeout(L0.dialT);
        }
        if (L0 && L0.state === 'hs') return;
        const L = L0 && L0.state !== 'closed' ? L0 : newLink(uid);
        if (!L) return;
        L.state = 'dialing';
        L.dialRole = 'answer';
        L.directSid = obj.sid;
        host.dial(uid, obj.sid, obj.sdp);
        clearTimeout(L.dialT);
        L.dialT = setTimeout(() => toRelay(L, 'timeout'), dialMs + 2000);
      } else if (obj.t === 'link.answer') {
        if (L0?.state === 'dialing' && L0.directSid === obj.sid && typeof obj.sdp === 'string' && obj.sdp.length <= 12_000) host.answer(uid, obj.sid, obj.sdp);
      } else if (obj.t === 'link.nodirect') {
        if (L0?.state === 'dialing' && L0.directSid === obj.sid) toRelay(L0, 'nodirect');
      }
    },
    onLocalSdp(uid, sid, sdp) {
      const L = links.get(uid);
      if (!L || L.state !== 'dialing' || L.directSid !== sid) return;
      sigSend(uid, { t: L.dialRole === 'offer' ? 'link.offer' : 'link.answer', sid, sdp });
    },
    onOpen(uid, sid) {
      const L = links.get(uid);
      if (!L || L.directSid !== sid || L.state !== 'dialing') return;
      clearTimeout(L.dialT);
      if (L.dialRole === 'offer') startHandshake(L, 'direct');
    },
    onClosed(uid, sid) {
      const L = links.get(uid);
      if (!L || L.directSid !== sid) return;
      if (L.state === 'dialing') toRelay(L, 'closed');
      else if (L.transport === 'direct') { L.directSid = null; close(L, 'channel closed', true); }
    },
    onBusy(uid, sid, busy) {
      const L = links.get(uid);
      if (!L || L.directSid !== sid) return;
      L.paused = busy;
      if (!busy) { flush(L); pump(L); }
    },
    // The link host went away: direct links and dials end.
    hostGone() { for (const L of [...links.values()]) if (L.directSid) { if (L.state === 'dialing') toRelay(L, 'host gone'); else close(L, 'host gone', true); } },
  };
}
