// Sending the data file from one PC of an account to another (design 0.10 section 3.3).
//
// Two parts:
// - createXfer(): the protocol over an injected transport {send(toIk, box) -> bool}. Unit-tested over a pipe.
//   Frames travel inside an E2E box between the two device keys:
//     K   = HKDF-SHA256(X25519(myXk, theirXk), salt = xid, info = "snug-xfer-v1\n" uid "\n" senderIk "\n" receiverIk)
//     box = JSON {x: xid, n, c}, c = b64u(AES-GCM(K, dir(4) || n(8), JSON(frame), aad = xid))
//   S->R offer {size, sha, kid, created}; R->S want {off} | have {} | no {why}; S->R part {off, d};
//   R->S ack {off}; S->R end {}; R->S done {} | bad {why}. Resumable from incoming/<xid>.part.
// - createXferSocket(): this PC's own registry socket in `xfer` mode (not the normal signal socket, which
//   the registry keeps to one per account), open only while a transfer is wanted.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, statSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import WebSocket from 'ws';
import { hkdf, dh, sha256, b64u, unb64u, isKey } from './peercrypto.js';
import { MAX_FILE } from './vaultfile.js';

// 40 KiB raw parts would make a box over the registry's 64 KiB limit once base64'd twice; 30 KiB fits.
export const PART = 30 * 1024;
const WINDOW = 8;           // parts in flight without an ack
const ACK_EVERY = 4;
const ACK_TIMEOUT = 30_000;
// The registry lets an account's PCs relay 60 boxes a second between them (both ways, fixed window).
// Parts go out at most RATE a second (acks add RATE / ACK_EVERY), well under it (review 0.10 #1).
const RATE = 24;
const BURST = 8;
// A receiver missing a part (or whose want/ack got lost) asks again after this long without progress.
const STALL_MS = 2000;
// A sender that hears nothing back sends its offer (before any want) or its end again after this long:
// a lost offer, or a lost done/have at the very end, would otherwise wait out ACK_TIMEOUT and fail.
const RESEND_MS = 3000;
const PURGE_AFTER = 7 * 86_400_000;
const XID = /^[A-Za-z0-9_-]{22}$/;
// Receiver answers ({t:'no', why}) that are final for this sender: it is not allowed to send a file now.
const REFUSALS = new Set(['not_yet', 'not_allowed', 'not_waiting']);

export const xidOf = (senderIk, sha) => b64u(sha256(`${senderIk}\n${sha}`)).slice(0, 22);
export function sessionKey({ myXkPriv, theirXk, xid, uid, senderIk, receiverIk }) {
  return hkdf(dh(myXkPriv, theirXk), Buffer.from(xid, 'utf8'), `snug-xfer-v1\n${uid}\n${senderIk}\n${receiverIk}`, 32);
}
function nonce(dir, n) {
  const b = Buffer.alloc(12);
  b.writeUInt32BE(dir, 0);
  b.writeBigUInt64BE(BigInt(n), 4);
  return b;
}
export function boxSeal(K, xid, dir, n, frame) {
  const c = createCipheriv('aes-256-gcm', K, nonce(dir, n));
  c.setAAD(Buffer.from(xid, 'utf8'));
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(frame), 'utf8')), c.final(), c.getAuthTag()]);
  return JSON.stringify({ x: xid, n, c: b64u(ct) });
}
export function boxOpen(K, xid, dir, n, c) {
  const data = unb64u(c);
  if (data.length < 16) throw new Error('short');
  const d = createDecipheriv('aes-256-gcm', K, nonce(dir, n), { authTagLength: 16 }); // sec-integrate: a fixed 16-byte tag
  d.setAAD(Buffer.from(xid, 'utf8'));
  d.setAuthTag(data.subarray(data.length - 16));
  return JSON.parse(Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]).toString('utf8'));
}
function parseBox(box) {
  if (typeof box !== 'string' || box.length > 65536) return null;
  let b;
  try { b = JSON.parse(box); } catch { return null; }
  if (!b || typeof b.x !== 'string' || !XID.test(b.x) || !Number.isSafeInteger(b.n) || b.n < 1 || typeof b.c !== 'string') return null;
  return b;
}

/**
 * createXfer({ uid, me: {ik, xkPriv}, transport, dir, log, now,
 *              getFile() -> {buf, sha, kid, created} | null,         // the sender's current file
 *              mayReceive(fromIk) -> null | why,                       // may this key send me a file now?
 *              accept(buf, sha, fromIk) -> Promise<{ok:true}|{ok:false, why}>, // the receiver verifies and imports
 *              hasImported(sha) -> bool, wasSent(sha, ik) -> bool, markSent(sha, ik),
 *              onProgress({state, got, size, role, error?}) })
 * -> { send(peer:{ik, xk}) -> Promise<'done'|'have'|'failed'|'refused'|'skipped'>, receive(fromIk, fromXk, box), stop(), purge() }
 */
export function createXfer(o) {
  const { uid, me, transport, dir, log = () => {}, now = () => Date.now() } = o;
  const rate = o.rate || RATE;
  const stallMs = o.stallMs || STALL_MS;
  // n only grows, also across restarts of either side: start from the clock, and (sec-registry REG-L4) from
  // a high-water mark kept on disk, so a clock set back (NTP, by hand) can never reuse a (key, nonce) pair:
  // the key for a (device pair, file) is the same in every session. Reserved in blocks: one write per 2^20.
  const N_BLOCK = 2 ** 20;
  const nFile = join(dir, '.n');
  let nextN = 0;
  try { const v = Number(readFileSync(nFile, 'utf8')); if (Number.isSafeInteger(v) && v > 0) nextN = v; } catch { /* first run */ }
  let nReserved = nextN;
  const takeN = () => {
    nextN = Math.max(nextN + 1, now() * 1024);
    if (nextN >= nReserved) {
      nReserved = nextN + N_BLOCK;
      try { mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileSync(nFile, String(nReserved), { mode: 0o600 }); } catch (e) { log('vault', 'xfer counter', e.code || e.message); }
    }
    return nextN;
  };
  const sends = new Map();   // receiverIk -> outgoing session
  const recvs = new Map();   // `${senderIk}|${xid}` -> incoming session
  let lastProgress = 0;
  const progress = (p, force = false) => {
    const t = now();
    if (!force && t - lastProgress < 250) return;
    lastProgress = t;
    try { o.onProgress?.(p); } catch { /* the UI's problem */ }
  };
  const incoming = () => { mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; };
  const partPath = (xid) => join(incoming(), `${xid}.part`);
  const metaPath = (xid) => join(incoming(), `${xid}.json`);
  const readMeta = (xid) => { try { return JSON.parse(readFileSync(metaPath(xid), 'utf8')); } catch { return null; } };
  const rm = (f) => { try { unlinkSync(f); } catch { /* gone */ } };
  const dropPart = (xid) => { rm(partPath(xid)); rm(metaPath(xid)); };

  // ---------- Sender ----------
  function send(peer) {
    if (!peer || !isKey(peer.ik) || !isKey(peer.xk) || peer.ik === me.ik) return Promise.resolve('skipped');
    const f = o.getFile();
    if (!f || !f.buf?.length) return Promise.resolve('skipped');
    if (o.wasSent?.(f.sha, peer.ik)) return Promise.resolve('skipped');
    const old = sends.get(peer.ik);
    if (old && old.sha === f.sha && !old.ended) return old.promise;
    old?.finish('failed', 'replaced');
    const xid = xidOf(me.ik, f.sha);
    const s = {
      ik: peer.ik, xk: peer.xk, xid, sha: f.sha, buf: f.buf, size: f.buf.length,
      K: sessionKey({ myXkPriv: me.xkPriv, theirXk: peer.xk, xid, uid, senderIk: me.ik, receiverIk: peer.ik }),
      sent: 0, acked: 0, started: false, ended: false, lastIn: 0, timer: null,
      tokens: BURST, tokAt: now(), pumpT: null,
    };
    s.promise = new Promise((resolve) => {
      s.finish = (result, error) => {
        if (s.ended) return;
        s.ended = true;
        clearInterval(s.timer);
        clearTimeout(s.pumpT);
        if (sends.get(s.ik) === s) sends.delete(s.ik);
        if (result === 'done' || result === 'have') o.markSent?.(s.sha, s.ik);
        const failed = result === 'failed' || result === 'refused';
        progress({ state: failed ? 'failed' : 'done', role: 'sender', got: failed ? s.acked : s.size, size: s.size, ...(error ? { error } : {}) }, true);
        resolve(result);
      };
    });
    sends.set(peer.ik, s);
    s.lastIn = now();
    s.offer = { t: 'offer', size: s.size, sha: s.sha, kid: f.kid ?? 1, created: f.created ?? 0 };
    s.timer = setInterval(() => {
      const quiet = now() - s.lastIn;
      if (quiet > ACK_TIMEOUT) return s.finish('failed', 'timeout');
      if (quiet < RESEND_MS || now() - (s.resentAt || 0) < RESEND_MS) return undefined;
      if (!s.started) { s.resentAt = now(); out(s, 1, s.offer); } else if (s.endSent) { s.resentAt = now(); out(s, 1, { t: 'end' }); }
      return undefined;
    }, 1000);
    s.timer.unref?.();
    if (!out(s, 1, s.offer)) { s.finish('failed', 'unavailable'); return s.promise; }
    progress({ state: 'sending', role: 'sender', got: 0, size: s.size }, true);
    return s.promise;
  }
  function out(s, d, frame) {
    let ok = false;
    try { ok = transport.send(s.ik, boxSeal(s.K, s.xid, d, takeN(), frame)); } catch (e) { log('vault', 'xfer send', e.message); }
    return ok;
  }
  // Paced: a token per part, refilled at `rate` a second; out of tokens, pump again when one is back.
  const token = (s) => {
    const t = now();
    s.tokens = Math.min(BURST, s.tokens + ((t - s.tokAt) * rate) / 1000);
    s.tokAt = t;
    if (s.tokens < 1) return false;
    s.tokens -= 1;
    return true;
  };
  function pump(s) {
    while (!s.ended && s.sent < s.size && (s.sent - s.acked) < WINDOW * PART) {
      if (!token(s)) {
        if (!s.pumpT) { s.pumpT = setTimeout(() => { s.pumpT = null; pump(s); }, Math.ceil(1000 / rate)); s.pumpT.unref?.(); }
        break;
      }
      const chunk = s.buf.subarray(s.sent, Math.min(s.size, s.sent + PART));
      if (!out(s, 1, { t: 'part', off: s.sent, d: chunk.toString('base64') })) { s.finish('failed', 'unavailable'); return; }
      s.sent += chunk.length;
    }
    if (!s.ended && s.sent >= s.size && !s.endSent) { s.endSent = true; out(s, 1, { t: 'end' }); }
    progress({ state: 'sending', role: 'sender', got: s.acked, size: s.size });
  }
  function onSenderFrame(s, fr) {
    s.lastIn = now();
    if (fr.t === 'want') {
      const off = Number.isSafeInteger(fr.off) && fr.off >= 0 && fr.off <= s.size ? fr.off : 0;
      s.sent = s.acked = off;
      s.endSent = false;
      s.started = true;
      pump(s);
    } else if (fr.t === 'ack') {
      if (Number.isSafeInteger(fr.off) && fr.off > s.acked && fr.off <= s.sent) s.acked = fr.off;
      pump(s);
    } else if (fr.t === 'have') s.finish('have');
    else if (fr.t === 'done') s.finish('done');
    else if (fr.t === 'no' && REFUSALS.has(fr.why)) s.finish('refused', fr.why); // final: retrying won't help
    else if (fr.t === 'no') s.finish('failed', typeof fr.why === 'string' ? fr.why.slice(0, 40) : 'refused');
    else if (fr.t === 'bad') s.finish('failed', typeof fr.why === 'string' ? fr.why.slice(0, 40) : 'bad');
  }

  // ---------- Receiver ----------
  async function onReceiverFrame(r, fr) {
    if (fr.t === 'offer') {
      if (!Number.isSafeInteger(fr.size) || fr.size < 1 || typeof fr.sha !== 'string' || !/^[0-9a-f]{64}$/.test(fr.sha)) return reply(r, { t: 'bad', why: 'offer' });
      if (fr.size > MAX_FILE) return reply(r, { t: 'no', why: 'too_big' });
      if (xidOf(r.from, fr.sha) !== r.xid) return reply(r, { t: 'bad', why: 'xid' });
      // sec-registry REG-H1: the receiver decides first whether this sender may give it a file at all
      // (refused before a byte is stored, and before "have" tells the sender anything).
      const no = o.mayReceive?.(r.from);
      if (no) return reply(r, { t: 'no', why: String(no).slice(0, 40) });
      if (o.hasImported?.(fr.sha)) return reply(r, { t: 'have' });
      const busy = [...recvs.values()].some((x) => x !== r && x.from !== r.from && x.size && !x.ended && now() - x.lastIn < ACK_TIMEOUT);
      if (busy) return reply(r, { t: 'no', why: 'busy' });
      // A different file from the same sender replaces any half-received one.
      for (const name of safeList(incoming())) {
        if (!name.endsWith('.json')) continue;
        const m = readMeta(name.slice(0, -5));
        if (m && m.from === r.from && m.xid !== r.xid) dropPart(m.xid);
      }
      const m = readMeta(r.xid);
      let off = 0;
      if (m && m.sha === fr.sha && m.size === fr.size && m.from === r.from && existsSync(partPath(r.xid))) {
        off = Math.min(m.off, statSync(partPath(r.xid)).size);
        if (statSync(partPath(r.xid)).size !== off) truncateSync(partPath(r.xid), off);
      } else {
        writeFileSync(partPath(r.xid), Buffer.alloc(0), { mode: 0o600 });
      }
      Object.assign(r, { size: fr.size, sha: fr.sha, off, parts: 0, ended: false });
      watchStall(r);
      writeFileSync(metaPath(r.xid), JSON.stringify({ xid: r.xid, size: r.size, sha: r.sha, from: r.from, off, at: now() }), { mode: 0o600 });
      progress({ state: 'receiving', role: 'receiver', got: off, size: r.size }, true);
      return reply(r, { t: 'want', off });
    }
    // Finished: an end sent again (its answer was lost) gets the same answer again.
    if (r.ended) return fr.t === 'end' && r.final ? reply(r, r.final) : undefined;
    if (!r.size) return undefined;
    if (fr.t === 'part') {
      if (typeof fr.d !== 'string' || !Number.isSafeInteger(fr.off)) return undefined;
      if (fr.off !== r.off) {
        // A duplicate (behind) is ignored; a gap (a frame lost on the way) asks to go back, at once the first
        // time, then again from the stall timer while nothing in order arrives.
        if (fr.off > r.off && r.rewound !== r.off) { r.rewound = r.off; r.stallAt = now(); reply(r, { t: 'want', off: r.off }); }
        return undefined;
      }
      const data = Buffer.from(fr.d, 'base64');
      if (!data.length || data.length > PART || r.off + data.length > r.size) { r.ended = true; dropPart(r.xid); return reply(r, { t: 'bad', why: 'size' }); }
      appendFileSync(partPath(r.xid), data);
      r.off += data.length;
      r.stallAt = now();
      r.parts++;
      writeFileSync(metaPath(r.xid), JSON.stringify({ xid: r.xid, size: r.size, sha: r.sha, from: r.from, off: r.off, at: now() }), { mode: 0o600 });
      progress({ state: 'receiving', role: 'receiver', got: r.off, size: r.size });
      if (r.parts % ACK_EVERY === 0) reply(r, { t: 'ack', off: r.off });
      return undefined;
    }
    if (fr.t === 'end') {
      r.ended = true;
      if (r.off !== r.size) { r.ended = false; return reply(r, { t: 'ack', off: r.off }); }
      const buf = readFileSync(partPath(r.xid));
      if (buf.length !== r.size || sha256(buf).toString('hex') !== r.sha) {
        dropPart(r.xid);
        progress({ state: 'failed', role: 'receiver', got: r.off, size: r.size, error: 'sha' }, true);
        return reply(r, (r.final = { t: 'bad', why: 'sha' }));
      }
      let res;
      try { res = await o.accept(buf, r.sha, r.from); } catch (e) { res = { ok: false, why: e.code || 'failed' }; }
      dropPart(r.xid);
      if (res?.ok) {
        progress({ state: 'done', role: 'receiver', got: r.size, size: r.size }, true);
        return reply(r, (r.final = { t: 'done' }));
      }
      progress({ state: 'failed', role: 'receiver', got: r.size, size: r.size, error: res?.why || 'failed' }, true);
      return reply(r, (r.final = { t: 'bad', why: String(res?.why || 'failed').slice(0, 40) }));
    }
    return undefined;
  }
  // While receiving: no progress for stallMs (a lost part, want, ack or end) -> ask for r.off again.
  // Ends with the session, or once the sender has been silent for ACK_TIMEOUT.
  function watchStall(r) {
    clearInterval(r.stallT);
    r.stallAt = now();
    r.stallT = setInterval(() => {
      if (r.ended || !r.size || now() - r.lastIn > ACK_TIMEOUT) { clearInterval(r.stallT); r.stallT = null; return; }
      if (now() - r.stallAt < stallMs) return;
      r.stallAt = now();
      reply(r, { t: 'want', off: r.off });
    }, Math.max(100, Math.floor(stallMs / 4)));
    r.stallT.unref?.();
  }
  function reply(r, frame) {
    try { transport.send(r.from, boxSeal(r.K, r.xid, 2, takeN(), frame)); } catch (e) { log('vault', 'xfer reply', e.message); }
  }

  // ---------- Inbound boxes ----------
  async function receive(fromIk, fromXk, box) {
    const b = parseBox(box);
    if (!b || !isKey(fromIk) || !isKey(fromXk) || fromIk === me.ik) return;
    // From the receiver of one of my sends?
    const s = sends.get(fromIk);
    if (s && s.xid === b.x) {
      let fr;
      try { fr = boxOpen(s.K, s.xid, 2, b.n, b.c); } catch { return; }
      if (b.n <= (s.lastN || 0)) return;
      s.lastN = b.n;
      onSenderFrame(s, fr);
      return;
    }
    const key = `${fromIk}|${b.x}`;
    let r = recvs.get(key);
    if (!r) {
      r = { from: fromIk, xid: b.x, K: sessionKey({ myXkPriv: me.xkPriv, theirXk: fromXk, xid: b.x, uid, senderIk: fromIk, receiverIk: me.ik }), lastN: 0, lastIn: now() };
    }
    let fr;
    try { fr = boxOpen(r.K, r.xid, 1, b.n, b.c); } catch { return; }
    if (b.n <= r.lastN) return;
    r.lastN = b.n;
    r.lastIn = now();
    if (!recvs.has(key)) { recvs.set(key, r); if (recvs.size > 16) recvs.delete(recvs.keys().next().value); }
    if (!fr || typeof fr.t !== 'string') return;
    r.chain = (r.chain || Promise.resolve()).then(() => onReceiverFrame(r, fr)).catch((e) => log('vault', 'xfer receive', e.message));
    await r.chain;
  }

  function safeList(d) { try { return readdirSync(d); } catch { return []; } }
  // Half-received files older than 7 days go.
  function purge() {
    for (const name of safeList(dir)) {
      if (!name.endsWith('.json')) continue;
      const m = readMeta(name.slice(0, -5));
      if (!m || !Number.isSafeInteger(m.at) || now() - m.at > PURGE_AFTER) dropPart(name.slice(0, -5));
    }
  }

  return {
    send, receive, purge,
    sending: () => [...sends.values()].some((s) => !s.ended),
    receiving: () => [...recvs.values()].some((r) => r.size && !r.ended && now() - r.lastIn < ACK_TIMEOUT),
    stop() { for (const s of [...sends.values()]) s.finish('failed', 'stopped'); for (const r of recvs.values()) clearInterval(r.stallT); recvs.clear(); },
  };
}

/**
 * The xfer socket: auth with this PC's key in `xfer` mode; the registry tells it which other keys of the
 * account are connected (ready.others, xfer-peer) and forwards boxes between them.
 * createXferSocket({ reg, identity, version, log, onBox(fromIk, fromXk, box), onChange() })
 * -> { open(), close(), send(toIk, box), peers() -> [{ik, xk, role}], role, connected, keys }
 */
export function createXferSocket({ reg, identity, version = '0.0.0', log = () => {}, onBox, onChange = () => {} }) {
  let ws = null;
  let wanted = false;
  let attempt = 0;
  let retry = null, pingT = null, pongT = null;
  let ready = null;
  const others = new Map(); // ik -> {ik, xk, role}
  let n = 0;
  const xkOf = (ik) => {
    const o = others.get(ik);
    if (o) return o.xk;
    const k = ready?.keys;
    if (k?.pending?.ik === ik) return k.pending.xk;
    return (k?.chain || []).find((c) => c.ik === ik)?.xk || null;
  };
  const clear = () => { clearTimeout(retry); clearInterval(pingT); clearTimeout(pongT); retry = pingT = pongT = null; };
  function schedule() {
    clearTimeout(retry);
    if (!wanted) return;
    const d = Math.min(5 * 60_000, 2000 * 2 ** attempt) * (0.7 + Math.random() * 0.6);
    attempt++;
    retry = setTimeout(connect, d);
    retry.unref?.();
  }
  function connect() {
    clearTimeout(retry);
    if (!wanted || (ws && ws.readyState <= 1)) return;
    const uid = identity.self()?.uid;
    if (!uid) return;
    let sock;
    try { sock = new WebSocket(reg.wsUrl(), { maxPayload: 80 * 1024, handshakeTimeout: 10_000 }); } catch { schedule(); return; }
    ws = sock;
    sock.on('message', (buf, isBinary) => {
      if (isBinary || ws !== sock) return;
      const s = buf.toString();
      if (s === 'pong') { clearTimeout(pongT); pongT = null; return; }
      let m;
      try { m = JSON.parse(s); } catch { return; }
      if (!m || typeof m.t !== 'string') return;
      if (m.t === 'challenge') {
        if (typeof m.n !== 'string' || m.n.length !== 22) return;
        reg.sawNow?.(m.now);
        sock.send(JSON.stringify({ t: 'auth', uid, sig: identity.sign(`snug-reg-v1\nsignal-xfer\n${uid}\n${m.n}`), mode: 'xfer', v: version }));
        return;
      }
      if (m.t === 'ready' && m.mode === 'xfer') {
        attempt = 0;
        ready = m;
        others.clear();
        for (const x of Array.isArray(m.others) ? m.others : []) {
          if (isKey(x?.ik)) others.set(x.ik, { ik: x.ik, xk: isKey(x.xk) ? x.xk : xkOf(x.ik), role: x.role });
        }
        const every = Math.max(10, Math.min(3600, Number(m.ping) || 90)) * 1000;
        clearInterval(pingT);
        pingT = setInterval(() => {
          if (sock.readyState !== 1) return;
          sock.send('ping');
          clearTimeout(pongT);
          pongT = setTimeout(() => sock.terminate(), 30_000);
          pongT.unref?.();
        }, every);
        pingT.unref?.();
        onChange('ready');
        return;
      }
      if (m.t === 'xfer-peer' && isKey(m.ik)) {
        if (m.on) others.set(m.ik, { ik: m.ik, xk: isKey(m.xk) ? m.xk : xkOf(m.ik), role: m.role });
        else others.delete(m.ik);
        onChange('peer');
        return;
      }
      if (m.t === 'xfer' && isKey(m.from) && typeof m.box === 'string') {
        const xk = xkOf(m.from);
        if (xk) onBox(m.from, xk, m.box);
        return;
      }
      if (m.t === 'err') log('vault', 'xfer err', m.code);
    });
    sock.on('close', (code) => {
      if (ws === sock) ws = null;
      ready = null;
      others.clear();
      clearInterval(pingT); clearTimeout(pongT);
      onChange('closed', code);
      if (code === 4001 || code === 4003) { log('vault', 'xfer refused', code); attempt = Math.max(attempt, 4); }
      schedule();
    });
    sock.on('error', (e) => log('vault', 'xfer socket', e.code || e.message));
  }
  return {
    open() { if (wanted && ws) return; wanted = true; attempt = 0; connect(); },
    close() { wanted = false; clear(); const s = ws; ws = null; ready = null; others.clear(); if (s) { try { s.close(1000); } catch { /* closing */ } } },
    send(toIk, box) {
      if (!ws || ws.readyState !== 1 || !ready) return false;
      ws.send(JSON.stringify({ t: 'xfer', id: `x${(++n).toString(36)}`, to: toIk, box }));
      return true;
    },
    peers: () => [...others.values()].filter((p) => p.xk),
    get role() { return ready?.role || null; },
    get connected() { return !!ready; },
    get wanted() { return wanted; },
    get keys() { return ready?.keys || null; },
  };
}
