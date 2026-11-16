// The signed objects of the key directory (pure; browser and server):
// - the device list, signed by the account identity key (AIK): which devices
//   may read this account's messages, and the current history key;
// - a prekey, signed by one device's signing key (DSK): the key messages are
//   sealed to for that device.
// And the rules a client applies before trusting either: pin an account key on
// first sight, never accept an older list, flag a changed account key, and
// never encrypt to a device the account key didn't sign.
import { b64u, b64uOf, base32, random, utf8 } from './bytes.js';
import { canon } from './canon.js';
import { signObject, verifyObject, sha256 } from './sig.js';

export const MAX_DEVICES = 10;
export const PREKEY_MAX_AGE = 30 * 86_400_000;
const FUTURE = 10 * 60_000;
const DEVICE_ID = /^dv_[A-Z2-7]{20}$/;
const USER_ID = /^[\w:.-]{1,80}$/;
const KINDS = ['web', 'app'];

/** dv_ + 20 base32 characters from the platform's random source (never derived from a key). */
export const newDeviceId = () => `dv_${base32(random(13)).slice(0, 20)}`;
export const isDeviceId = (d) => typeof d === 'string' && DEVICE_ID.test(d);

const int = (v, min = 0) => Number.isSafeInteger(v) && v >= min;
const key32 = (v) => !!b64uOf(v, 32);
const label = (v) => typeof v === 'string' && v.length >= 1 && v.length <= 80 && !/[\u0000-\u001f\u007f]/.test(v);

/** Why a device list is malformed, or null. Signatures are checked separately. */
export function listProblem(l) {
  if (!l || typeof l !== 'object' || Array.isArray(l)) return 'not an object';
  const keys = Object.keys(l).sort().join(',');
  if (keys !== 'aik,arc,devs,sig,t,ts,u,v,ver' && keys !== 'aik,arc,devs,t,ts,u,v,ver') return 'fields';
  if (l.v !== 1 || l.t !== 'devlist' || typeof l.u !== 'string' || !USER_ID.test(l.u)) return 'header';
  if (!int(l.ver, 1) || !int(l.ts) || !key32(l.aik)) return 'header';
  if (!Array.isArray(l.devs) || l.devs.length < 1 || l.devs.length > MAX_DEVICES) return 'devices';
  const seen = new Set();
  for (const d of l.devs) {
    if (!d || typeof d !== 'object' || Object.keys(d).sort().join(',') !== 'added,d,dsk,kind,label') return 'device';
    if (!isDeviceId(d.d) || seen.has(d.d) || !key32(d.dsk) || !KINDS.includes(d.kind) || !label(d.label) || !int(d.added)) return 'device';
    seen.add(d.d);
  }
  if (l.arc !== null) {
    if (!l.arc || typeof l.arc !== 'object' || Object.keys(l.arc).sort().join(',') !== 'at,e,pub') return 'arc';
    if (!int(l.arc.e, 1) || !key32(l.arc.pub) || !int(l.arc.at)) return 'arc';
  }
  return null;
}

export function prekeyProblem(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'not an object';
  const keys = Object.keys(p).sort().join(',');
  if (keys !== 'd,kid,pub,sig,t,ts,u,v') return 'fields';
  if (p.v !== 1 || p.t !== 'prekey' || typeof p.u !== 'string' || !USER_ID.test(p.u) || !isDeviceId(p.d)) return 'header';
  if (!int(p.kid, 1) || !int(p.ts) || !key32(p.pub)) return 'header';
  return null;
}

export async function makeList(aikPriv, { u, ver, ts = Date.now(), aik, devs, arc = null }) {
  const l = { v: 1, t: 'devlist', u, ver, ts, aik, devs, arc };
  const why = listProblem(l);
  if (why) throw new Error(`device list: ${why}`);
  return signObject(aikPriv, 'devlist', l);
}

/** Shape and signature, under `aik` (raw bytes) or, if not given, the list's own aik. */
export async function verifyList(l, aik) {
  if (listProblem(l) || !l.sig) return false;
  const key = aik || b64uOf(l.aik, 32);
  return verifyObject(key, 'devlist', l);
}

export async function makePrekey(dskPriv, { u, d, kid, pub, ts = Date.now() }) {
  const p = { v: 1, t: 'prekey', u, d, kid, pub, ts };
  if (prekeyProblem({ ...p, sig: 'x' })) throw new Error('prekey: bad fields');
  return signObject(dskPriv, 'prekey', p);
}

/** A prekey a client may seal to: well formed, for this user and device, recent, signed by that device. */
export async function verifyPrekey(p, { u, d, dsk, now = Date.now() }) {
  if (prekeyProblem(p) || p.u !== u || p.d !== d) return false;
  if (p.ts < now - PREKEY_MAX_AGE || p.ts > now + FUTURE) return false;
  const key = typeof dsk === 'string' ? b64uOf(dsk, 32) : dsk;
  return !!key && verifyObject(key, 'prekey', p);
}

/**
 * What a client does with a contact's (or its own account's) list, given what
 * it has pinned for that account ({ aik, ver } or null):
 *   { ok: true, pin, changed }           accept; pin is what to store now
 *   { ok: false, why: 'bad' }            malformed or signature doesn't verify
 *   { ok: false, why: 'rollback' }       older than one already accepted: ignore it, warn
 *   { ok: false, why: 'aik-changed' }    signed by a different account key (a reset): warn, ask before trusting
 */
export async function acceptList(pin, l) {
  if (!(await verifyList(l))) return { ok: false, why: 'bad' };
  const h = await listHash(l);
  if (!pin) return { ok: true, pin: { aik: l.aik, ver: l.ver, h }, changed: true, first: true };
  if (l.aik !== pin.aik) return { ok: false, why: 'aik-changed' };
  if (l.ver < pin.ver) return { ok: false, why: 'rollback' };
  if (l.ver === pin.ver) {
    // The same version must be the same list; two different lists with one
    // version means someone signed a fork, or the server is replaying.
    if ((pin.h && pin.h !== h) || (pin.list && pin.list !== canon(l))) return { ok: false, why: 'rollback' };
    return { ok: true, pin, changed: false };
  }
  return { ok: true, pin: { aik: l.aik, ver: l.ver, h }, changed: true };
}
/** A short fingerprint of a whole signed list, kept in pins instead of the list (review M3). */
export const listHash = async (l) => b64u(await sha256(utf8(`snug-e2ee-v1/list\n${canon(l)}`)));

/** Devices to encrypt to: only those in the signed list, whatever else the server lists. */
export function signedDevices(l, serverDevices = null) {
  const signed = new Map(l.devs.map((d) => [d.d, d]));
  if (!serverDevices) return [...signed.values()];
  return serverDevices.filter((d) => signed.has(d) || signed.has(d?.d)).map((d) => signed.get(d?.d || d));
}

/** Device ids added and removed between two accepted lists (for "added a device" lines). */
export function listDiff(before, after) {
  const a = new Set((before?.devs || []).map((d) => d.d));
  const b = new Set((after?.devs || []).map((d) => d.d));
  return { added: after.devs.filter((d) => !a.has(d.d)), removed: (before?.devs || []).filter((d) => !b.has(d.d)) };
}
