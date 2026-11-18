// The Snug data file ("vault") format, v1 (design 0.10 section 2.2). Pure: no state, no I/O.
//
//   bytes 0..7   "SNUGVLT1"
//   bytes 8..11  H, the header length (uint32 big-endian, 16..4096)
//   bytes 12..   the header, UTF-8 JSON with exactly HEADER_KEYS
//   then         AES-256-GCM(fileKey, iv, gzip(payload JSON), aad = bytes[0 .. 12+H)) and its 16-byte tag
//   fileKey    = HKDF-SHA256(vaultKey, salt = uid, info = "snug-vault-file-v1")
//
// Reading is all-or-nothing: any failure throws a VaultError with one of the codes in MESSAGES and
// nothing is returned. The caller applies nothing unless open() returned.
import { gzipSync, gunzipSync } from 'node:zlib';
import { randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { hkdf, b64u, unb64u, isUid, isKey } from './peercrypto.js';

export const MAGIC = Buffer.from('SNUGVLT1', 'ascii');
export const MAX_FILE = 16 * 1024 * 1024;
export const MAX_PAYLOAD = 64 * 1024 * 1024;
export const MAX_SECTION = 8 * 1024 * 1024;
export const CAPS = { conversations: 200, perConversation: 5000, messages: 100_000, text: 4000, people: 2000 };
const HEADER_KEYS = ['v', 'alg', 'z', 'uid', 'kid', 'created', 'seq', 'iv', 'app', 'len'];
const MSG_ID = /^m_[a-z0-9]{8,40}$/;
const FILE_ID = /^f_[a-z0-9]{8,40}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;
const isUsername = (s) => typeof s === 'string' && /^[a-z0-9_.]{1,32}$/.test(s);

export const MESSAGES = {
  tampered: 'This file was changed outside Snug or is damaged, so Snug won’t use it.',
  not_vault: 'This file was changed outside Snug or is damaged, so Snug won’t use it.',
  other_account: 'This data file belongs to another Snug account.',
  newer_version: 'This data file was made by a newer Snug. Update Snug first.',
  too_big: 'That file is too large to be a Snug data file.',
  no_key: 'Snug can’t reach its directory to unlock your data file. Try again when you’re online.',
  not_yet: 'Your data file can be opened on this PC once the move is done: approve it on your old PC, or wait until it completes.',
};

export class VaultError extends Error {
  constructor(code, detail) {
    super(MESSAGES[code] || code);
    this.code = code;
    this.detail = detail;
  }
}
const bad = (code, detail) => { throw new VaultError(code, detail); };

// AES-256-GCM with a byte AAD (the magic, length and header exactly as stored).
function gcmSeal(key, iv, plain, aad) {
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad);
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}
function gcmOpen(key, iv, data, aad) {
  if (data.length < 16) throw new Error('short');
  const d = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 }); // sec-integrate: a fixed 16-byte tag
  d.setAAD(aad);
  d.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
}

export const fileKey = (vaultKey, uid) => hkdf(vaultKey, Buffer.from(uid, 'utf8'), 'snug-vault-file-v1', 32);
export const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex');

// Make a sealed file. `payload` is an object; returns a Buffer.
export function seal({ key, uid, kid = 1, seq = 0, app = '0.0.0', created = Date.now(), payload }) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('vault key must be 32 bytes');
  if (!isUid(uid)) throw new Error('bad uid');
  const plain = gzipSync(Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8'));
  const iv = randomBytes(12);
  const header = { v: 1, alg: 'A256GCM', z: 'gzip', uid, kid, created, seq, iv: b64u(iv), app: String(app).slice(0, 32), len: plain.length };
  const hb = Buffer.from(JSON.stringify(header), 'utf8');
  if (hb.length < 16 || hb.length > 4096) throw new Error('header size');
  const head = Buffer.alloc(12);
  MAGIC.copy(head, 0);
  head.writeUInt32BE(hb.length, 8);
  const aad = Buffer.concat([head, hb]);
  const ct = gcmSeal(fileKey(key, uid), iv, plain, aad);
  const out = Buffer.concat([aad, ct]);
  if (out.length > MAX_FILE) bad('too_big');
  return out;
}

// Steps 1 and 2 (without the key): size, magic, header shape. `owner` = the signed-in uid.
export function readHeader(buf, owner) {
  if (!Buffer.isBuffer(buf)) bad('not_vault');
  if (buf.length > MAX_FILE) bad('too_big');
  if (buf.length < 12 || !buf.subarray(0, 8).equals(MAGIC)) bad('not_vault');
  const H = buf.readUInt32BE(8);
  if (H < 16 || H > 4096 || 12 + H > buf.length) bad('tampered', 'header length');
  let h;
  try { h = JSON.parse(buf.subarray(12, 12 + H).toString('utf8')); } catch { bad('tampered', 'header json'); }
  if (!h || typeof h !== 'object' || Array.isArray(h)) bad('tampered', 'header');
  const keys = Object.keys(h);
  if (keys.length !== HEADER_KEYS.length || !HEADER_KEYS.every((k) => Object.hasOwn(h, k))) bad('tampered', 'header keys');
  const int = (n, min = 0) => Number.isSafeInteger(n) && n >= min;
  if (!int(h.v, 1)) bad('tampered', 'v');
  if (h.v > 1) bad('newer_version');
  if (h.alg !== 'A256GCM' || h.z !== 'gzip' || !isUid(h.uid) || !int(h.kid, 1) || !int(h.created) || !int(h.seq)
    || typeof h.iv !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(h.iv) || typeof h.app !== 'string' || h.app.length > 32 || !int(h.len)) {
    bad('tampered', 'header types');
  }
  if (owner != null && h.uid !== owner) bad('other_account');
  if (h.len + 16 + 12 + H !== buf.length) bad('tampered', 'length');
  return { header: h, H };
}

// Steps 3 and 4: decrypt, gunzip, parse, check. Returns the payload object.
export function decrypt(buf, { header, H }, key) {
  let plain;
  try {
    plain = gcmOpen(fileKey(key, header.uid), unb64u(header.iv), buf.subarray(12 + H), buf.subarray(0, 12 + H));
  } catch { bad('tampered', 'tag'); }
  let json;
  try { json = gunzipSync(plain, { maxOutputLength: MAX_PAYLOAD }); } catch (e) {
    if (e?.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|too large/i.test(String(e?.message))) bad('too_big');
    bad('tampered', 'gzip');
  }
  let p;
  try { p = JSON.parse(json.toString('utf8')); } catch { bad('tampered', 'payload json'); }
  checkPayload(p, header.uid);
  return p;
}

// readHeader + decrypt in one call (the key is already known).
export function open(buf, { owner, key, kid }) {
  const parsed = readHeader(buf, owner);
  if (kid != null && parsed.header.kid !== kid) bad('tampered', 'kid');
  return { header: parsed.header, payload: decrypt(buf, parsed, key) };
}

// The payload's shape and caps (design 2.3). Anything off is "tampered": a file Snug wrote always passes.
export function checkPayload(p, uid) {
  const no = (why) => bad('tampered', why);
  const obj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const int = (n, min = 0) => Number.isSafeInteger(n) && n >= min;
  const strMax = (s, n) => typeof s === 'string' && s.length <= n;
  if (!obj(p)) no('payload');
  if (!int(p.v, 1)) no('payload v');
  if (p.v > 1) bad('newer_version');
  if (p.uid !== uid) no('payload uid');
  if (typeof p.username !== 'string' || p.username.length > 64 || !int(p.at) || !strMax(p.app ?? '', 32)) no('payload head');
  if (p.profile != null) {
    if (!obj(p.profile)) no('profile');
    for (const k of ['avatar', 'banner']) {
      const m = p.profile[k];
      if (m == null) continue;
      if (!obj(m) || typeof m.type !== 'string' || typeof m.data !== 'string' || m.data.length > Math.ceil((2 * 1024 * 1024) / 3) * 4 + 4) no(k);
    }
  }
  if (p.prefs != null && !obj(p.prefs)) no('prefs');
  if (p.privacy != null && !obj(p.privacy)) no('privacy');
  for (const k of ['people', 'keys', 'friends', 'blocks', 'dms']) if (!Array.isArray(p[k])) no(k);
  if (p.people.length > CAPS.people || p.keys.length > CAPS.people * 8 || p.friends.length > CAPS.people || p.blocks.length > CAPS.people * 4) no('people caps');
  for (const x of p.people) {
    if (!obj(x) || !isUid(x.uid) || !isUsername(x.username) || !isKey(x.ik) || !isKey(x.xk) || !int(x.kver, 1) || !strMax(x.name ?? '', 64)) no('person');
  }
  for (const x of p.keys) if (!obj(x) || !isUid(x.uid) || !int(x.kver, 1) || !isKey(x.ik) || !isKey(x.xk)) no('key');
  for (const x of p.friends) {
    if (!obj(x) || !isUid(x.uid) || !['friends', 'incoming', 'outgoing'].includes(x.state) || !int(x.since) || ![0, 1].includes(x.favorite ?? 0)) no('friend');
  }
  for (const x of p.blocks) if (!isUid(x)) no('block');
  if (p.dms.length > CAPS.conversations) no('dms cap');
  let total = 0;
  for (const c of p.dms) {
    if (!obj(c) || !isUid(c.peer) || !Array.isArray(c.msgs) || c.msgs.length > CAPS.perConversation) no('dm');
    total += c.msgs.length;
    for (const m of c.msgs) checkMsg(m, [uid, c.peer], no);
  }
  if (total > CAPS.messages) no('messages cap');
  if (p.sections != null && !obj(p.sections)) no('sections');
  return p;
}

// One message in the data file. `authors`: the uids it may be by.
export function checkMsg(m, authors, no = (why) => bad('tampered', why)) {
  const obj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const int = (n, min = 0) => Number.isSafeInteger(n) && n >= min;
  if (!obj(m) || typeof m.id !== 'string' || !MSG_ID.test(m.id) || !authors.includes(m.a) || !int(m.ts)
    || typeof m.text !== 'string' || m.text.length > CAPS.text) no('msg');
  if (m.r != null && (typeof m.r !== 'string' || !MSG_ID.test(m.r))) no('msg reply');
  if (m.e != null && !int(m.e)) no('msg edited');
  if (m.d != null && !int(m.d)) no('msg deleted');
  if (m.x != null) {
    if (!Array.isArray(m.x) || m.x.length > 200) no('msg reactions');
    for (const x of m.x) if (!obj(x) || !authors.includes(x.u) || typeof x.e !== 'string' || x.e.length > 64 || !x.e) no('reaction');
  }
  if (m.f != null) {
    if (!Array.isArray(m.f) || m.f.length > 6) no('msg files');
    for (const f of m.f) {
      if (!obj(f) || typeof f.id !== 'string' || !FILE_ID.test(f.id) || typeof f.name !== 'string' || f.name.length > 200
        || typeof f.type !== 'string' || f.type.length > 100 || !int(f.size) || (f.hash != null && !(typeof f.hash === 'string' && HASH.test(f.hash)))) no('file');
    }
  }
}
