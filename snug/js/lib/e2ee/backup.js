// The account secret bundle (ASB) and the two blobs made from it.
//   ASB:    {"v":1,"u":…,"aik":<pkcs8>,"ahk":{"<e>":{"sk":<pkcs8>,"pub":<raw>}},"sync":<32B>,"bk":<32B>}
//           everything a trusted device needs besides its own keys; moved between
//           devices sealed to a device's prekey, never in the clear.
//   backup: the ASB under BK (from the recovery key), so a recovery key alone
//           brings an account's encryption back. The server stores only this.
//   meta:   verification marks, pinned account keys and "this conversation is
//           encrypted", under SYNC, so they follow the person between devices.
import { b64u, b64uOf, random, utf8, fromUtf8 } from './bytes.js';
import { canon, parseCanon } from './canon.js';
import { aesSeal, aesOpen, importSigning, importDhPair, pkcs8Of, rawPublic } from './sig.js';
import { deriveBackupKey } from '../recovery.js';

export const MAX_BLOB = 64 * 1024;
export { deriveBackupKey };

const key32 = (v) => !!b64uOf(v, 32);

export function asbProblem(a) {
  if (!a || typeof a !== 'object' || a.v !== 1 || typeof a.u !== 'string') return 'asb';
  if (!b64uOf(a.aik) || !key32(a.sync) || !key32(a.bk)) return 'asb';
  if (!a.ahk || typeof a.ahk !== 'object' || Array.isArray(a.ahk)) return 'asb';
  for (const [e, k] of Object.entries(a.ahk)) if (!/^[1-9]\d{0,8}$/.test(e) || !k || !b64uOf(k.sk) || !key32(k.pub)) return 'asb';
  return null;
}

/**
 * A new account: AIK (Ed25519) and the first history key (X25519) are made
 * extractable only to be written into the ASB; callers re-import them
 * non-extractable with loadAsb.
 */
export async function newAsb(u, { history = true } = {}) {
  const subtle = globalThis.crypto.subtle;
  const aik = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const ahk = {};
  if (history) {
    const h = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
    ahk[1] = { sk: b64u(await pkcs8Of(h.privateKey)), pub: b64u(await rawPublic(h.publicKey)) };
  }
  return { v: 1, u, aik: b64u(await pkcs8Of(aik.privateKey)), ahk, sync: b64u(random(32)), bk: b64u(random(32)) };
}

/** A new history epoch added to an ASB (old epochs stay, to read old history). */
export async function addEpoch(asb) {
  const subtle = globalThis.crypto.subtle;
  const e = Math.max(0, ...Object.keys(asb.ahk).map(Number)) + 1;
  const h = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  return { asb: { ...asb, ahk: { ...asb.ahk, [e]: { sk: b64u(await pkcs8Of(h.privateKey)), pub: b64u(await rawPublic(h.publicKey)) } } }, e };
}

/** The raw public key of the AIK inside an ASB (Ed25519 pkcs8 carries no public key, so it is derived once). */
export async function asbAikPublic(asb) {
  const subtle = globalThis.crypto.subtle;
  const k = await subtle.importKey('pkcs8', b64uOf(asb.aik), { name: 'Ed25519' }, true, ['sign']);
  const jwk = await subtle.exportKey('jwk', k);
  return jwk.x;
}

/** Working keys from an ASB, all non-extractable. */
export async function loadAsb(asb) {
  if (asbProblem(asb)) throw new Error('account keys are damaged');
  const ahk = {};
  for (const [e, k] of Object.entries(asb.ahk)) ahk[e] = await importDhPair(b64uOf(k.sk), b64uOf(k.pub));
  return { u: asb.u, aik: await importSigning(b64uOf(asb.aik)), aikPub: await asbAikPublic(asb), ahk, sync: b64uOf(asb.sync, 32), bk: b64uOf(asb.bk, 32) };
}

const backupAad = (u, aik, ver) => utf8(`snug-e2ee-v1/backup\n${u}\n${aik}\n${ver}`);

/** The backup blob the server keeps: { v, ver, aik, n, c }. */
export async function sealBackup(asb, bk, { ver, aik }) {
  const n = random(12);
  const c = await aesSeal(bk, n, utf8(canon(asb)), backupAad(asb.u, aik, ver));
  return { v: 1, ver, aik, n: b64u(n), c: b64u(c) };
}
/** The ASB inside a backup, or throws (wrong recovery key, or a blob moved to another user or version). */
export async function openBackup(blob, bk, u) {
  if (!blob || blob.v !== 1 || !Number.isSafeInteger(blob.ver) || !key32(blob.aik)) throw new Error('backup damaged');
  const pt = await aesOpen(bk, b64uOf(blob.n, 12), b64uOf(blob.c), backupAad(u, blob.aik, blob.ver));
  const asb = parseCanon(fromUtf8(pt), MAX_BLOB);
  if (!asb || asbProblem(asb) || asb.u !== u) throw new Error('backup damaged');
  return asb;
}

const metaAad = (u, ver) => utf8(`snug-e2ee-v1/meta\n${u}\n${ver}`);
export const emptyMeta = () => ({ verified: {}, pins: {}, convs: {} });
export async function sealMeta(meta, sync, { u, ver }) {
  const n = random(12);
  const c = await aesSeal(sync, n, utf8(canon(meta)), metaAad(u, ver));
  return b64u(new Uint8Array([...n, ...c]));
}
export async function openMeta(blob, sync, { u, ver }) {
  const b = b64uOf(blob);
  if (!b || b.length < 28) throw new Error('meta damaged');
  const m = parseCanon(fromUtf8(await aesOpen(sync, b.slice(0, 12), b.slice(12), metaAad(u, ver))), MAX_BLOB);
  if (!m || typeof m !== 'object') throw new Error('meta damaged');
  return { ...emptyMeta(), ...m };
}
