// The message envelope: one random key per message, the text sealed with it
// (AES-256-GCM, the header as associated data), the header signed by the
// sending device, and the key sealed with HPKE to every recipient device and
// history key. Stateless per message: nothing to fall out of step between
// devices, and out-of-order delivery is harmless. Pure; browser and server.
import { b64u, b64uOf, concat, utf8, fromUtf8, random } from './bytes.js';
import { canon } from './canon.js';
import { aesSeal, aesOpen, sha256, signBytes, verifyBytes } from './sig.js';
import { sealKey, openKey } from './hpke.js';

export const SUITE = 'hpke-x25519-sha256-aes256gcm/ed25519';
export const KINDS = ['msg', 'edit', 'sched'];
export const CAPS = { header: 8 * 1024, ct: 40 * 1024, wraps: 110, text: 4000, total: 64 * 1024 };
const P = 'snug-e2ee-v1/';

export const wrapInfo = (u, d, kid) => `${P}wrap\n${u}\n${d}\n${kid}`;
export const arcInfo = (u, e) => `${P}arc\n${u}\n${e}`;
export const aadOf = (h) => utf8(`${P}msg\n${canon(h)}`);
export const headerHash = (h) => sha256(utf8(`${P}hdr\n${canon(h)}`));
const sigText = async (hh, n, c) => utf8(`${P}env\n${b64u(hh)}\n${b64u(n)}\n${b64u(await sha256(c))}`);

// Padding: the body's canonical JSON grows to a multiple of 256 bytes up to
// 4 KB, then of 1 KB, so lengths say less about what was written.
export const bucket = (n) => (n <= 4096 ? Math.ceil(n / 256) * 256 : Math.ceil(n / 1024) * 1024);
export function pad(body) {
  const base = { ...body, pad: '' };
  const len = utf8(canon(base)).length;
  return { ...base, pad: '0'.repeat(bucket(len) - len) };
}

/** Why a header is malformed, or null. */
export function headerProblem(h) {
  if (!h || typeof h !== 'object' || Array.isArray(h)) return 'header';
  if (h.v !== 1 || h.s !== SUITE || !KINDS.includes(h.kind) || !Number.isSafeInteger(h.rev) || h.rev < 0) return 'header';
  for (const k of ['conv', 'place', 'id']) if (typeof h[k] !== 'string' || !h[k] || h[k].length > 120) return 'header';
  if (!h.from || typeof h.from.u !== 'string' || typeof h.from.d !== 'string') return 'from';
  if (!Number.isSafeInteger(h.ts)) return 'ts';
  if (!Array.isArray(h.to) || !h.to.length || !Array.isArray(h.ar)) return 'recipients';
  if (h.to.length + h.ar.length > CAPS.wraps) return 'too many recipients';
  for (const t of h.to) if (!Array.isArray(t) || t.length !== 3 || typeof t[0] !== 'string' || typeof t[1] !== 'string' || !Number.isSafeInteger(t[2])) return 'recipients';
  for (const a of h.ar) if (!Array.isArray(a) || a.length !== 2 || typeof a[0] !== 'string' || !Number.isSafeInteger(a[1])) return 'recipients';
  if (!h.lv || typeof h.lv !== 'object' || Array.isArray(h.lv)) return 'lv';
  if (!Array.isArray(h.ping) || h.ping.length > 10 || h.ping.some((u) => typeof u !== 'string')) return 'ping';
  if (h.re !== null && typeof h.re !== 'string') return 're';
  if (h.kind === 'sched' ? !Number.isSafeInteger(h.at) : h.at !== undefined) return 'at';
  try { if (utf8(canon(h)).length > CAPS.header) return 'header too large'; } catch { return 'header'; }
  return null;
}

/** Shape of {h, n, c, sig} as it travels and is stored (wraps travel separately). */
export function envelopeProblem(env) {
  if (!env || typeof env !== 'object') return 'envelope';
  const why = headerProblem(env.h);
  if (why) return why;
  if (!b64uOf(env.n, 12) || !b64uOf(env.sig, 64)) return 'envelope';
  const c = b64uOf(env.c);
  if (!c || c.length < 16 || c.length > CAPS.ct) return 'ciphertext';
  return null;
}

/**
 * Seals one message.
 *   header: everything in section 7.1 except to/ar (built from recipients)
 *   body:   the plaintext fields (text, files, mentions, …); conv/place/id/rev/from are copied from the header
 *   dsk:    the sending device's Ed25519 private key
 *   recipients: { to: [[u, d, kid, pubRaw]], ar: [[u, e, pubRaw]] }
 * Returns { env: {h, n, c, sig}, k: { "d:<device>"|"a:<u>:<e>": b64u wrap }, K }.
 */
export async function seal({ header, body, dsk, recipients, K = random(32), n = random(12) }) {
  const to = recipients.to.map(([u, d, kid]) => [u, d, kid]);
  const ar = recipients.ar.map(([u, e]) => [u, e]);
  const h = { ...header, v: 1, s: SUITE, to, ar };
  const why = headerProblem(h);
  if (why) throw new Error(`envelope: ${why}`);
  const inner = pad({ ...body, v: 1, conv: h.conv, place: h.place, id: h.id, rev: h.rev, from: h.from });
  if (typeof inner.text === 'string' && inner.text.length > CAPS.text) throw new Error('envelope: text too long');
  const c = await aesSeal(K, n, utf8(canon(inner)), aadOf(h));
  if (c.length > CAPS.ct) throw new Error('envelope: too large');
  const hh = await headerHash(h);
  const sig = await signBytes(dsk, await sigText(hh, n, c));
  const k = {};
  for (const [u, d, kid, pub] of recipients.to) k[`d:${d}`] = b64u(await sealKey(pub, wrapInfo(u, d, kid), hh, K));
  for (const [u, e, pub] of recipients.ar) k[`a:${u}:${e}`] = b64u(await sealKey(pub, arcInfo(u, e), hh, K));
  return { env: { h, n: b64u(n), c: b64u(c), sig: b64u(sig) }, k, K };
}

export class OpenFailure extends Error {
  constructor(reason) { super(`couldn't decrypt: ${reason}`); this.reason = reason; }
}
const no = (reason) => { throw new OpenFailure(reason); };

/**
 * Opens one message. Any failure throws OpenFailure with a short reason (for
 * the message menu); nothing of the ciphertext is ever shown.
 *   expect: { conv (root DM), place, id, author, rev? } from the stored row
 *   senderDsk: raw public key of h.from.d, taken from the sender's verified device list
 *   me: { u, d }
 *   keys: { device(kid) -> CryptoKeyPair|null, history(e) -> CryptoKeyPair|null, cached: Uint8Array|null }
 *   wraps: { "d:…"|"a:…": b64u }
 * Returns { body, K, flags } where flags lists soft warnings ('mentions').
 */
export async function open({ env, expect, senderDsk, me, keys, wraps = {} }) {
  if (envelopeProblem(env)) no('malformed');
  const { h } = env;
  if (h.conv !== expect.conv || h.place !== expect.place || h.id !== expect.id) no('moved');
  if (h.from.u !== expect.author) no('author');
  if (expect.rev !== undefined && h.rev !== expect.rev) no('revision');
  if (expect.kind && h.kind !== expect.kind) no('kind');
  const n = b64uOf(env.n, 12), c = b64uOf(env.c), sig = b64uOf(env.sig, 64);
  const hh = await headerHash(h);
  if (!(await verifyBytes(senderDsk, sig, await sigText(hh, n, c)))) no('signature');
  let K = null;
  const mine = h.to.find(([u, d]) => u === me.u && d === me.d);
  const tryOpen = async (pair, info, w) => { try { return pair && w ? await openKey(pair, info, hh, b64uOf(w)) : null; } catch { return null; } };
  if (mine) K = await tryOpen(await keys.device?.(mine[2]), wrapInfo(me.u, me.d, mine[2]), wraps[`d:${me.d}`]);
  for (const [u, e] of h.ar) {
    if (K || u !== me.u) continue;
    K = await tryOpen(await keys.history?.(e), arcInfo(u, e), wraps[`a:${u}:${e}`]);
  }
  if (!K && keys.cached) K = keys.cached;
  if (!K || K.length !== 32) no('no key');
  let body;
  try { body = JSON.parse(fromUtf8(await aesOpen(K, n, c, aadOf(h)))); } catch { no('ciphertext'); }
  if (!body || body.v !== 1 || body.conv !== h.conv || body.place !== h.place || body.id !== h.id || body.rev !== h.rev
    || body.from?.u !== h.from.u || body.from?.d !== h.from.d) no('body');
  const flags = [];
  const mentions = Array.isArray(body.mentions) ? body.mentions : [];
  if (canon([...mentions].sort()) !== canon([...h.ping].sort())) flags.push('mentions');
  const { pad: _pad, ...clean } = body; // eslint-disable-line no-unused-vars
  return { body: clean, K, flags };
}

/** The wire size of an envelope and its wraps, for the 64 KB cap. */
export const wireSize = (env, k) => utf8(canon({ ...env, k })).length;
export { concat };
