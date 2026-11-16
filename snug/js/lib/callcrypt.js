// End-to-end encryption of call media (calls C1), as pure code on top of
// WebCrypto so it is tested on its own (tests/logic-callcrypt.test.js) and
// runs the same in the call's worker (js/callcrypt-worker.js).
//
// WebRTC already encrypts media between two browsers (DTLS-SRTP). This adds a
// layer the browsers' connection keys can't open: every encoded frame is
// sealed with AES-256-GCM under a call key that only the people in the call
// hold (js/e2ee/callkeys.js hands keys out, sealed to their devices).
//
// A sealed frame is   header | ciphertext + 16-byte tag | counter (8) | key id (1)
//   header: the codec's first bytes, left readable because the browser's
//     packetiser reads them (VP8: 10 bytes on a key frame, 3 otherwise; Opus:
//     1). They are authenticated with the trailer, not hidden.
//   counter: 64 bits, never repeated under one key (the AES-GCM nonce is 4
//     zero bytes then the counter); it starts at a random high half.
//   key id: which of the sender's keys sealed it (0-255, rolling over).
//
// Each sender has its own key (a "sender key"): a new one whenever someone
// joins or leaves, so a newcomer can't open what was said before and someone
// who left can't open what is said after. A sender encrypts to a person only
// once that person acknowledged the key; until then frames go as before
// (DTLS-SRTP only) and the call's label says so. A receiver plays plain
// frames from someone until the first frame from them opens, then drops
// anything that doesn't open: a call never quietly falls back.

export const TRAILER = 9;
export const TAG = 16;
export const KEY_BYTES = 32;
export const KEEP_OLD_MS = 2000; // a receiver keeps a sender's previous key this long after the new one is in use
// After a new key of mine, a person who hasn't acknowledged it this long is no longer counted as end to end:
// I still encrypt to them under the key they have, which someone who left also has.
export const ACK_WAIT_MS = 5000;

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();

/** How many leading bytes stay readable, or null for a frame left alone (a codec whose packetiser parses the payload). */
export function clearBytes({ kind, type, mime } = {}) {
  if (kind === 'audio') return 1;
  const m = String(mime || '').toLowerCase();
  if (m && m !== 'video/vp8') return null;
  return type === 'key' ? 10 : 3;
}

/** The AES-256-GCM key for one 32-byte call key (HKDF-SHA256, so the raw call key is never used directly). */
export async function frameKey(raw) {
  if (!(raw instanceof Uint8Array) || raw.length !== KEY_BYTES) throw new Error('A call key is 32 bytes.');
  const ikm = await subtle().importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('snug-call-v1/frame') },
    ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function trailerOf(ctr, keyId) {
  const t = new Uint8Array(TRAILER);
  const v = new DataView(t.buffer);
  v.setUint32(0, ctr.hi >>> 0);
  v.setUint32(4, ctr.lo >>> 0);
  t[8] = keyId & 255;
  return t;
}
const ivOf = (trailer) => { const iv = new Uint8Array(12); iv.set(trailer.subarray(0, 8), 4); return iv; };
const join = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/** header | AES-GCM(payload) | counter | keyId. */
export async function sealFrame(key, keyId, ctr, data, clear) {
  const d = data instanceof Uint8Array ? data : new Uint8Array(data);
  const n = Math.min(clear, d.length);
  const head = d.subarray(0, n);
  const trailer = trailerOf(ctr, keyId);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: ivOf(trailer), additionalData: join(head, trailer) }, key, d.subarray(n)));
  return join(head, ct, trailer);
}
/** The key id a sealed frame says it is under (its last byte), or null for one too short to be sealed. */
export const keyIdOf = (data, clear) => (data.length >= TAG + TRAILER ? data[data.length - 1] : null);
/** The frame as it was sealed. Throws when anything (key, header, payload, trailer) is wrong. */
export async function openFrame(key, data, clear) {
  const d = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (d.length < TAG + TRAILER) throw new Error('short frame');
  // A frame shorter than its codec header (an empty video frame) was sealed with all of it readable.
  clear = Math.min(clear, d.length - TAG - TRAILER);
  const head = d.subarray(0, clear);
  const trailer = d.subarray(d.length - TRAILER);
  const pt = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: ivOf(trailer), additionalData: join(head, trailer) }, key, d.subarray(clear, d.length - TRAILER)));
  return join(head, pt);
}

const randomHi = () => globalThis.crypto.getRandomValues(new Uint32Array(1))[0] >>> 1;

// The keys of one call on one device: my sender keys, and each other
// person's keys for what they send me. Used by the worker for every
// sender and receiver of every connection, so one counter serves each key.
export class FrameCrypto {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.send = new Map();    // keyId -> { key, ctr: { hi, lo } }
    this.newest = null;       // my newest sender key id
    this.newestAt = 0;        // when it was made
    this.peerKey = new Map(); // person -> the key id they acknowledged (what I encrypt to them with)
    this.recv = new Map();    // person -> { keys: Map(keyId -> { key, n }), n, cur, curSince, strict }
    this.counts = new Map();  // person -> { enc, plain, dec, drop, pass }
    this.tamper = new Set();  // tests: people whose frames I damage on the way out
  }
  #count(peer) {
    let c = this.counts.get(peer);
    if (!c) this.counts.set(peer, (c = { enc: 0, plain: 0, dec: 0, drop: 0, pass: 0, passKeyed: 0, rawOut: 0, rawIn: 0 }));
    return c;
  }
  async setSendKey(id, raw) {
    const key = await frameKey(raw);
    raw.fill(0);
    this.send.set(id & 255, { key, ctr: { hi: randomHi(), lo: 0 } });
    this.newest = id & 255;
    this.newestAt = this.now();
  }
  /** That person acknowledged my key id: encrypt to them with it from now on. */
  useFor(peer, id) {
    if (!this.send.has(id)) return false;
    this.peerKey.set(peer, id);
    this.#pruneSend();
    return true;
  }
  #pruneSend() {
    const used = new Set(this.peerKey.values());
    for (const id of [...this.send.keys()]) if (id !== this.newest && !used.has(id)) this.send.delete(id);
  }
  async addRecvKey(peer, id, raw) {
    const key = await frameKey(raw);
    raw.fill(0);
    let r = this.recv.get(peer);
    if (!r) this.recv.set(peer, (r = { keys: new Map(), n: 0, cur: null, curSince: 0, strict: false }));
    r.keys.set(id & 255, { key, n: ++r.n });
  }
  dropPeer(peer) {
    this.recv.delete(peer);
    this.peerKey.delete(peer);
    this.counts.delete(peer);
    this.tamper.delete(peer);
    this.#pruneSend();
  }
  wipe() {
    this.send.clear(); this.peerKey.clear(); this.recv.clear(); this.counts.clear(); this.tamper.clear();
    this.newest = null;
    this.newestAt = 0;
  }
  sendKeyIds() { return [...this.send.keys()]; }
  recvKeyIds(peer) { return [...(this.recv.get(peer)?.keys.keys() || [])]; }

  /** A frame on its way to one person: { data, e2ee }. */
  async encrypt(peer, data, clear) {
    const c = this.#count(peer);
    const id = this.peerKey.get(peer);
    const k = id == null ? null : this.send.get(id);
    if (!(data?.length ?? data?.byteLength)) return { data, e2ee: false }; // nothing in it
    if (!k || clear == null) { c.plain++; if (k) c.rawOut++; return { data, e2ee: false }; }
    const ctr = { hi: k.ctr.hi, lo: k.ctr.lo };
    if (++k.ctr.lo > 0xffffffff) { k.ctr.lo = 0; k.ctr.hi = (k.ctr.hi + 1) >>> 0; }
    let out = await sealFrame(k.key, id, ctr, data, clear);
    if (this.tamper.has(peer)) { out = out.slice(); out[out.length - TRAILER - 1] ^= 0x5a; }
    c.enc++;
    return { data: out, e2ee: true };
  }
  /** A frame from one person: { data, e2ee }, data null for a frame to drop. */
  async decrypt(peer, data, clear) {
    const c = this.#count(peer);
    const r = this.recv.get(peer);
    if (r?.cur != null && r.curSince && this.now() - r.curSince > KEEP_OLD_MS) {
      const cur = r.keys.get(r.cur);
      for (const [id, k] of [...r.keys]) if (cur && k.n < cur.n) r.keys.delete(id);
      r.curSince = 0;
    }
    const d = data instanceof Uint8Array ? data : new Uint8Array(data);
    // An empty frame (the browser makes some for audio) carries nothing to open or to hide.
    if (!d.length) return { data, e2ee: false };
    // A codec whose packetiser reads the payload (H264): its sender can't seal it either.
    if (clear == null) { c.pass++; c.rawIn++; return { data, e2ee: false }; }
    const id = keyIdOf(d, clear);
    const k = id == null ? null : r?.keys.get(id);
    if (k) {
      try {
        const pt = await openFrame(k.key, d, clear);
        r.strict = true;
        if (r.cur !== id && !(r.keys.get(r.cur)?.n > k.n)) { r.cur = id; r.curSince = this.now(); }
        c.dec++;
        return { data: pt, e2ee: true };
      } catch { /* not sealed under this key */ }
    }
    if (r?.strict) { c.drop++; return { data: null, e2ee: false }; }
    c.pass++;
    if (r?.keys.size) c.passKeyed++;
    return { data, e2ee: false };
  }
  /** Per person: what went out encrypted or plain, what came in opened, plain or dropped, and whether they're held to encryption. */
  stats() {
    const out = {};
    for (const p of new Set([...this.counts.keys(), ...this.recv.keys(), ...this.peerKey.keys()])) {
      const c = this.counts.get(p) || { enc: 0, plain: 0, dec: 0, drop: 0, pass: 0, passKeyed: 0, rawOut: 0, rawIn: 0 };
      const strict = !!this.recv.get(p)?.strict, sendKey = this.peerKey.get(p) ?? null, recvKeys = this.recvKeyIds(p);
      // Still on an older key of mine well after a new one was made: waiting for their acknowledgement.
      const waiting = sendKey != null && sendKey !== this.newest && this.now() - this.newestAt > ACK_WAIT_MS;
      // End to end with this person: they hold my newest key (or had a moment to acknowledge it) and I hold
      // theirs, nothing went either way that couldn't be sealed, and what they sent since I had their key
      // opened (or they sent nothing).
      const e2ee = sendKey != null && !waiting && recvKeys.length > 0 && !c.rawOut && !c.rawIn && (strict || !c.passKeyed);
      out[p] = { ...c, strict, sendKey, recvKeys, e2ee, waiting };
    }
    return out;
  }
}
