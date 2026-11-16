// Call keys and call identities on this device (calls C1 and C2), with the
// end-to-end encryption keys of js/e2ee/manager.js. Nothing here is new
// cryptography: HPKE (js/lib/e2ee/hpke.js) seals a key to a device, Ed25519
// (js/lib/e2ee/sig.js) signs.
//
// C1, call keys: each person's device makes its own 32-byte key for what it
// sends (js/lib/callcrypt.js) and seals it to each device the other person
// lists in their signed device list (checked here, never taken on the
// server's word), signed with this device's key. The server only passes the
// sealed blob on; it can't open it.
//
// C2, connection identity: the DTLS certificate fingerprint and ICE username
// of every offer and answer are signed with this device's key, so a server
// that swapped certificates to sit in the middle of a call is caught.
import { S } from '../store.js';
import { E2, ring, callStore } from './manager.js';
import { callDevices, listedDevices, sendGate } from './conv.js';
import { signerBook } from '../lib/callsigners.js';
import { sealKey, openKey } from '../lib/e2ee/hpke.js';
import * as sig from '../lib/e2ee/sig.js';
import { b64u, b64uOf, utf8 } from '../lib/e2ee/bytes.js';

/** Whether this device can take part: its encryption keys are set up and unlocked. */
export const callKeysReady = () => E2.on === true && E2.status === 'ready' && !!ring.dev?.dsk?.privateKey;
export const myDevice = () => ring.dev?.d || null;
/** Whether this server offers end-to-end encryption at all. */
export const e2eeOffered = () => E2.on === true;
const MAX_AGE = 10 * 60_000;
const info = (m, d) => `snug-call-v1/key\n${m.place}\n${m.from}\n${m.d}\n${m.to}\n${d}\n${m.id}`;

/** A key sealed to every device `to` lists, signed by this device: the `ck` signal, or null when they have no devices with keys. */
export async function sealCallKey({ place, to, id, raw }) {
  if (!callKeysReady()) return null;
  const devs = await callDevices(to).catch(() => []);
  if (!devs.length) return null;
  const m = { v: 1, t: 'key', place, from: S.me, d: ring.dev.d, to, id, ts: Date.now(), w: [] };
  for (const x of devs.slice(0, 12)) m.w.push([x.d, x.kid, b64u(await sealKey(x.pub, info(m, x.d), '', raw))]);
  return sig.signObject(ring.dev.dsk.privateKey, 'callkey', m);
}

/** The signing key of device d of user u, from their checked list (fetched once if not known yet). */
export async function deviceKey(u, d) {
  let k = await ring.senderKey(u, d).catch(() => null);
  if (!k) { await callDevices(u, true).catch(() => []); k = await ring.senderKey(u, d).catch(() => null); }
  return k && !k.goneAt ? b64uOf(k.dsk, 32) : null;
}

/**
 * A `ck` key from `from`, checked: for this place and this device, recent, signed by a device in
 * their list. Returns { id, raw } or throws.
 */
export async function openCallKey(from, m, place) {
  if (!callKeysReady()) throw new Error('no keys here');
  if (m?.t !== 'key' || m.from !== from || m.to !== S.me || m.place !== place) throw new Error('not for this call');
  if (!Number.isSafeInteger(m.ts) || Math.abs(Date.now() - m.ts) > MAX_AGE) throw new Error('stale');
  const dsk = await deviceKey(from, m.d);
  if (!dsk || !(await sig.verifyObject(dsk, 'callkey', m))) throw new Error('bad signature');
  const box = (m.w || []).find((x) => Array.isArray(x) && x[0] === ring.dev.d);
  const pair = box && ring.dev.prekeys?.[box[1]]?.pair;
  const blob = box && b64uOf(box[2]);
  if (!pair || !blob) throw new Error('not sealed to this device');
  const raw = await openKey(pair, info(m, ring.dev.d), '', blob);
  if (raw.length !== 32) throw new Error('bad key');
  return { id: m.id, raw };
}

// ---------- C2: the connection's certificate, signed ----------
/** "v1 <device> <signature>" for the a=x-snug-fp line of an offer or answer, or null without keys. */
export async function signFingerprint(stmt) {
  if (!callKeysReady()) return null;
  return `v1 ${ring.dev.d} ${b64u(await sig.signBytes(ring.dev.dsk.privateKey, utf8(stmt)))}`;
}
/** Splits an a=x-snug-fp value: { d, sig } or null. */
export function parseFpAttr(v) {
  const m = /^v1 (dv_[A-Za-z0-9]{8,40}) ([A-Za-z0-9_-]{80,100})$/.exec(typeof v === 'string' ? v.trim() : '');
  return m ? { d: m[1], sig: m[2] } : null;
}
/** true: signed by that device of theirs; false: not; null: no such device known (nothing to check against). */
export async function verifyFingerprint(from, d, stmt, sigText) {
  const dsk = await deviceKey(from, d);
  if (!dsk) return null;
  const s = b64uOf(sigText, 64);
  return !!s && sig.verifyBytes(dsk, s, utf8(stmt));
}
// ---------- C2: who signed calls with me before ----------
// Each device of someone whose signed offer, answer or call key checked here is
// remembered on this device (js/lib/callsigners.js: sealed under its storage key,
// js/e2ee/store.js; never sent anywhere). A later call from them that arrives
// unsigned is then judged against their signed list (js/lib/callnet.js
// unsignedVerdict) instead of being taken as an older Snug. The store is opened
// for this even when the server's hello says encryption is off (callStore).
// Read once before a call is joined (loadCallSigners), so an unsigned offer from
// someone never remembered waits on nothing.
const lockSigners = (fn) => (globalThis.navigator?.locks?.request ? navigator.locks.request(`snug-callsig:${S.me}`, fn) : fn());
let book = { me: null, b: null };
const mine = () => { if (book.me !== S.me || !book.b) book = { me: S.me, b: signerBook({ open: callStore, lock: lockSigners }) }; return book.b; };
export const loadCallSigners = () => mine().load();
/** The devices of u that signed calls with this device before: [device ids]. */
export const callSigners = (u) => mine().get(u);
/** The same, if already known (null while it is still to be read from this device's store). */
export const signersNow = (u) => mine().now(u);
/** Device d of u signed something of this call that checked. */
export async function rememberSigner(u, d) {
  if (!u || !d || u === S.me) return;
  await mine().remember(u, d);
}
/** Their signers still in their list (`listed`): the others are forgotten. */
export const pruneSigners = (u, listed) => mine().prune(u, listed);
/** u's account key changed and they are a verified contact not accepted again: an empty or new list isn't their reset. */
export const keyHeld = (u) => sendGate([u]).length > 0;
/** The account uses encryption but this device can't sign calls (not added, waiting, locked, unsupported). */
export const signsElsewhere = () => E2.on === true && E2.me?.state === 'ready' && !callKeysReady();
export { listedDevices };

/** Both devices' identity keys, for the longer security code: mine and theirs (raw), or null. */
export async function identityKeys(from, d) {
  const theirs = await deviceKey(from, d);
  const mine = ring.dev?.dskPub ? b64uOf(ring.dev.dskPub, 32) : null;
  return theirs && mine ? { mine, theirs } : null;
}
