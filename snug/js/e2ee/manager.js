// End-to-end encryption on this device: turning it on, binding this device to
// each connection, rotating prekeys, adding this device to an account (with
// another device's code, or the recovery key), approving a new device, the
// device list, history setting, recovery key, synced settings and safety
// numbers. Conversations don't encrypt yet in this build; this is the key
// directory they will use.
//
// State lives in E2 (not in S: every hello replaces S). Views read E2 and call
// the functions here; every change ends with emit().
import { S, emit, signOutHooks } from '../store.js';
import { call, on } from '../server.js';
import { b64u, b64uOf, utf8, fromUtf8 } from '../lib/e2ee/bytes.js';
import { canon, parseCanon } from '../lib/e2ee/canon.js';
import * as sig from '../lib/e2ee/sig.js';
import * as obj from '../lib/e2ee/objects.js';
import * as backup from '../lib/e2ee/backup.js';
import * as link from '../lib/e2ee/link.js';
import { sealKey, openKey } from '../lib/e2ee/hpke.js';
import { safetyNumber } from '../lib/e2ee/fingerprint.js';
import { supported } from '../lib/e2ee/support.js';
import { newRecoveryKey, parseRecoveryKey, deriveBackupKey } from '../lib/recovery.js';
import { openStore, deleteStore, memStore } from './store.js';

const DAY = 86_400_000;
export const PREKEY_ROTATE = 7 * DAY;
export const PREKEY_KEEP = 14 * DAY;

/**
 * status: 'off' (server has it off) | 'unsupported' | 'none' (account has no keys) | 'new-device'
 * (account has keys, this device doesn't) | 'pending' (this device is waiting to be added) | 'ready'
 */
export const E2 = {
  on: false, status: 'off', support: null, me: null, device: null,
  prompt: null,          // 'setup' | 'new-device' | 'recovery-key' | 'approve': what the app should open next
  approvals: [],         // requests to add a device, on a trusted device
  link: null,            // this device being added: { linkId, step: 'type'|'waiting'|'cancelled'|'expired'|'done', error }
  rk: null,              // a recovery key to show: { text, fresh }
  rkSaved: false,        // the person confirmed they saved it (synced)
  notice: null,          // 'removed': this device's keys were removed elsewhere
};

let store = null, keys = null, dev = null, meta = null, metaVer = 0, linkKc = null, rotateTimer = null;
const bundleCache = new Map();
const userId = () => S.me;
const skipKey = () => `snug-e2ee-skip:${userId()}`;
const askedKey = () => `snug-e2ee-asked:${userId()}`;
const local = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage off */ } },
};

// What this device calls itself in the device list ("Firefox on Windows"), and whether its code is
// the app's own: the desktop app on its own server loads its built-in files; everywhere else the
// code comes from the server.
export function deviceLabel(ua = navigator.userAgent) {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'this computer';
  return window.snugApp && isLoopback() ? `Snug app on ${os}` : `${browser} on ${os}`;
}
const isLoopback = () => ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
export const deviceKind = () => (window.snugApp && isLoopback() ? 'app' : 'web');

// --- this device's keys ------------------------------------------------------
async function makeDevice() {
  const d = obj.newDeviceId();
  const dsk = await sig.newSigningPair(false);
  const nd = { d, dsk, dskPub: b64u(await sig.rawPublic(dsk.publicKey)), label: deviceLabel(), kind: deviceKind(), kid: 0, prekeys: {} };
  await addPrekey(nd);
  return nd;
}
async function addPrekey(target) {
  const pair = await sig.newDhPair(false);
  const kid = target.kid + 1;
  const t = Date.now();
  const signed = await obj.makePrekey(target.dsk.privateKey, { u: userId(), d: target.d, kid, pub: b64u(await sig.rawPublic(pair.publicKey)), ts: t });
  for (const p of Object.values(target.prekeys)) if (!p.retired) p.retired = t;
  target.prekeys[kid] = { pair, signed, created: t, retired: null };
  target.kid = kid;
  return signed;
}
const entryOf = (x) => ({ d: x.d, dsk: x.dskPub, kind: x.kind, label: x.label, added: Date.now() });
const publicOf = (x) => ({ d: x.d, dsk: x.dskPub, label: x.label, kind: x.kind });
const save = () => store.putDevice(dev);

async function bindHere() {
  const nonce = S.e2ee?.nonce;
  const s = b64u(await sig.signBytes(dev.dsk.privateKey, utf8(`snug-e2ee-v1/bind\n${userId()}\n${dev.d}\n${nonce}`)));
  return call('e2ee.bind', { d: dev.d, sig: s });
}

// Weekly prekey; private halves deleted 14 days after they were retired.
async function rotatePrekey() {
  if (!dev) return;
  const cur = dev.prekeys[dev.kid];
  let changed = false;
  if (!cur || Date.now() - cur.created >= PREKEY_ROTATE) {
    const signed = await addPrekey(dev);
    await call('e2ee.prekey', { prekey: signed });
    changed = true;
  }
  for (const [kid, p] of Object.entries(dev.prekeys)) {
    if (p.retired && Date.now() - p.retired > PREKEY_KEEP) { delete dev.prekeys[kid]; changed = true; }
  }
  if (changed) await save();
}

async function loadKeys(asb) {
  keys = await backup.loadAsb(asb);
  E2.status = 'ready';
}

// --- connecting --------------------------------------------------------------
async function onHello(d) {
  const info = d?.e2ee;
  if (!info) { E2.status = 'off'; emit(); return; }
  E2.on = !!info.on;
  E2.me = info.me;
  if (!E2.on && info.me.state === 'none') { E2.status = 'off'; emit(); return; }
  E2.support ||= await supported().catch(() => ({ ok: false, reason: 'old' }));
  if (!E2.support.ok) { E2.status = 'unsupported'; emit(); return; }
  try { store ||= await openStore(userId()); } catch { E2.support = { ok: false, reason: 'storage' }; E2.status = 'unsupported'; emit(); return; }
  dev = await store.getDevice();
  const known = dev && info.me.devices.find((x) => x.d === dev.d);
  if (dev && !known) {
    // Removed from another device, reset, or a request that ran out: start over on this device.
    if (dev.trusted) E2.notice = 'removed';
    await forgetLocal();
  }
  E2.device = dev ? { d: dev.d, label: dev.label, kind: dev.kind } : null;
  if (dev) {
    await bindHere();
    if (known.state === 'trusted') {
      const asb = await store.getAsb();
      if (asb) {
        await loadKeys(asb);
        if (!dev.trusted) { dev.trusted = true; await save(); }
        await rotatePrekey();
        await Promise.all([loadMeta(), fetchAsbBoxes()]);
        const rk = await store.getSecret('rk');
        if (rk && !E2.rkSaved) E2.rk = { text: rk, fresh: false };
      } else if (dev.linkId) await finishLink().catch(() => { E2.status = 'pending'; });
      else E2.status = 'pending';
    } else {
      E2.status = 'pending';
      await rotatePrekey().catch(() => {});
      if (dev.linkId && !E2.link) E2.link = { linkId: dev.linkId, step: 'restart' };
    }
  } else {
    E2.status = info.me.state === 'ready' ? 'new-device' : 'none';
    keys = null;
  }
  if (!E2.prompt && !local.get(skipKey())) {
    if (E2.status === 'none' && E2.on && !local.get(askedKey())) E2.prompt = 'setup';
    else if (E2.status === 'new-device' && !local.get(askedKey())) E2.prompt = 'new-device';
  }
  clearInterval(rotateTimer);
  rotateTimer = setInterval(() => { rotatePrekey().catch(() => {}); }, 3600_000);
  emit();
}
on('hello', (d) => { onHello(d).catch((e) => { console.warn('e2ee', e); E2.status = 'unsupported'; E2.support = { ok: false, reason: 'old' }; emit(); }); });
on('e2ee.me', (me) => { E2.me = me; emit(); });
on('e2ee.devices', (d) => { bundleCache.delete(d.user); if (d.user === userId()) refreshMe(); });
on('e2ee.asb', () => { fetchAsbBoxes().then(emit, () => {}); });
on('e2ee.meta', () => { loadMeta().then(emit, () => {}); });
signOutHooks.push(() => {
  clearInterval(rotateTimer);
  store?.close(); store = null; keys = null; dev = null; meta = null; linkKc = null;
  bundleCache.clear();
  Object.assign(E2, { on: false, status: 'off', me: null, device: null, prompt: null, approvals: [], link: null, rk: null, rkSaved: false, notice: null });
});

async function refreshMe() { E2.me = await call('e2ee.state'); emit(); }
async function forgetLocal() {
  dev = null; keys = null;
  await store.putDevice(null);
  await store.putAsb(null);
  await store.putSecret('rk', null);
}

export function dismissPrompt(skip = false) {
  if (skip) local.set(skipKey(), '1');
  else local.set(askedKey(), '1');
  E2.prompt = null;
  emit();
}

// --- turning it on (spec 11.1) -----------------------------------------------
/** Makes every key, turns encryption on for the account, binds this device. `existing` reuses a recovery key the person already has. */
export async function setup({ history = true, existing = null } = {}) {
  if (E2.status !== 'none') throw new Error('Encryption is already set up for this account.');
  let rk;
  if (existing) {
    const p = await parseRecoveryKey(existing);
    if (p.error) throw new Error(p.message);
    rk = { raw: p.raw, text: null };
  } else rk = await newRecoveryKey();
  const nd = await makeDevice();
  const asb = await backup.newAsb(userId()); // a history key always exists; history on/off is the list's arc
  const bk = await deriveBackupKey(rk.raw);
  asb.bk = b64u(bk);
  const k = await backup.loadAsb(asb);
  const arc = history ? { e: 1, pub: asb.ahk[1].pub, at: Date.now() } : null;
  const devlist = await obj.makeList(k.aik, { u: userId(), ver: 1, aik: k.aikPub, devs: [entryOf(nd)], arc });
  const m = backup.emptyMeta();
  if (existing) m.rk = true;
  const r = await call('e2ee.setup', {
    devlist, device: publicOf(nd), prekey: nd.prekeys[1].signed,
    backup: await backup.sealBackup(asb, bk, { ver: 1, aik: k.aikPub }),
    meta: await backup.sealMeta(m, k.sync, { u: userId(), ver: 1 }),
  });
  nd.trusted = true;
  dev = nd;
  await save();
  await store.putAsb(asb);
  meta = m; metaVer = 1;
  keys = k;
  E2.me = r.me;
  E2.device = { d: dev.d, label: dev.label, kind: dev.kind };
  await bindHere();
  E2.status = 'ready';
  E2.rkSaved = !!existing;
  if (rk.text) { await store.putSecret('rk', rk.text); E2.rk = { text: rk.text, fresh: true }; }
  local.set(skipKey(), null);
  emit();
  return { recoveryKey: rk.text };
}

/** The person typed back the last group: the key is saved somewhere, so this device forgets it. */
export async function confirmRecoveryKey(lastGroup) {
  if (!E2.rk) return false;
  const last = E2.rk.text.split('-').pop();
  if (String(lastGroup || '').trim().toUpperCase() !== last) return false;
  await store.putSecret('rk', null);
  E2.rk = null;
  E2.rkSaved = true;
  await updateMeta((m) => { m.rk = true; });
  emit();
  return true;
}

// --- the account's own list ---------------------------------------------------
async function ownList() {
  const r = await call('e2ee.bundles', { users: [userId()] });
  const list = r.users[userId()]?.list;
  if (!list || !(await obj.verifyList(list, b64uOf(keys.aikPub, 32)))) throw new Error('Your device list didn’t check out. Reload Snug and try again.');
  return { list, prekeys: r.users[userId()].prekeys };
}
const nextOf = async (list, change) => obj.makeList(keys.aik, { u: list.u, ver: list.ver + 1, aik: list.aik, devs: list.devs, arc: list.arc, ...change });

/** Remove a device (another one, or this one when others remain). */
export async function removeDevice(d) {
  const { list } = await ownList();
  const devlist = await nextOf(list, { devs: list.devs.filter((x) => x.d !== d) });
  await call('e2ee.device.remove', { d, devlist });
  if (d === dev?.d) { await forgetLocal(); await deleteStore(userId()).catch(() => {}); E2.status = 'new-device'; E2.device = null; }
  await refreshMe();
}

/** History on new devices: on puts the newest history key in the list; off takes it out. */
export async function setHistory(onOff) {
  const { list } = await ownList();
  const asb = await store.getAsb();
  const e = Math.max(...Object.keys(asb.ahk).map(Number));
  const devlist = await nextOf(list, { arc: onOff ? { e, pub: asb.ahk[e].pub, at: Date.now() } : null });
  await call('e2ee.publish', { devlist });
  await refreshMe();
}

/** A new recovery key: the backup is rewritten under it and every other device gets the updated account keys. */
export async function newRecoveryKeyFlow() {
  const { list, prekeys } = await ownList();
  const rk = await newRecoveryKey();
  const bk = await deriveBackupKey(rk.raw);
  const asb = { ...(await store.getAsb()), bk: b64u(bk) };
  const devlist = await nextOf(list, {});
  const boxes = await boxesFor(asb, devlist, prekeys);
  await call('e2ee.publish', { devlist, boxes, backup: await backup.sealBackup(asb, bk, { ver: devlist.ver, aik: devlist.aik }) });
  await store.putAsb(asb);
  await loadKeys(asb);
  await store.putSecret('rk', rk.text);
  E2.rk = { text: rk.text, fresh: true };
  E2.rkSaved = false;
  await updateMeta((m) => { m.rk = false; });
  emit();
  return rk.text;
}

// The account secret bundle sealed to each other trusted device's prekey, signed by this device.
const asbInfo = (u, d, kid) => `snug-e2ee-v1/asb\n${u}\n${d}\n${kid}`;
async function boxesFor(asb, devlist, prekeys) {
  const boxes = {};
  for (const e of devlist.devs) {
    if (e.d === dev.d) continue;
    const p = prekeys[e.d];
    if (!p || !(await obj.verifyPrekey(p, { u: userId(), d: e.d, dsk: e.dsk }))) continue;
    const blob = await sealKey(b64uOf(p.pub, 32), asbInfo(userId(), e.d, p.kid), canon({ u: userId(), ver: devlist.ver }), utf8(canon({ asb, by: dev.d })));
    const h = b64u(await sig.sha256(blob));
    const s = b64u(await sig.signBytes(dev.dsk.privateKey, utf8(`snug-e2ee-v1/asbbox\n${canon({ u: userId(), d: e.d, kid: p.kid, ver: devlist.ver, h })}`)));
    boxes[e.d] = { kid: p.kid, blob: b64u(blob), by: dev.d, sig: s };
  }
  return boxes;
}
async function fetchAsbBoxes() {
  if (!dev || !keys) return;
  const after = (await store.getPlain('asbVer')) || 0;
  const { boxes } = await call('e2ee.asb.fetch', { after });
  if (!boxes.length) return;
  const { list } = await ownList();
  for (const { ver, box } of boxes) {
    try {
      const signer = list.devs.find((x) => x.d === box.by);
      const pair = dev.prekeys[box.kid]?.pair;
      const blob = b64uOf(box.blob);
      const h = b64u(await sig.sha256(blob));
      const ok = signer && pair && await sig.verifyBytes(b64uOf(signer.dsk, 32), b64uOf(box.sig, 64), utf8(`snug-e2ee-v1/asbbox\n${canon({ u: userId(), d: dev.d, kid: box.kid, ver, h })}`));
      if (!ok) continue;
      const got = parseCanon(fromUtf8(await openKey(pair, asbInfo(userId(), dev.d, box.kid), canon({ u: userId(), ver }), blob)), 128 * 1024);
      if (!got?.asb || backup.asbProblem(got.asb) || await backup.asbAikPublic(got.asb) !== keys.aikPub) continue;
      await store.putAsb(got.asb);
      await loadKeys(got.asb);
    } catch { /* a box that doesn't open is skipped; a later one may */ }
    await store.putPlain('asbVer', ver);
  }
}

// --- synced settings ------------------------------------------------------------
async function loadMeta() {
  if (!keys) return;
  const r = await call('e2ee.meta.get');
  metaVer = r.ver;
  meta = r.blob ? await backup.openMeta(r.blob, keys.sync, { u: userId(), ver: r.ver }).catch(() => backup.emptyMeta()) : backup.emptyMeta();
  E2.rkSaved = !!meta.rk;
}
async function updateMeta(fn) {
  for (let i = 0; i < 3; i++) {
    if (!meta) await loadMeta();
    const next = JSON.parse(JSON.stringify(meta));
    fn(next);
    try {
      const blob = await backup.sealMeta(next, keys.sync, { u: userId(), ver: metaVer + 1 });
      await call('e2ee.meta.put', { ver: metaVer + 1, blob });
      meta = next; metaVer += 1;
      return;
    } catch (e) {
      if (e.code !== 'e2ee_conflict') throw e;
      await loadMeta();
    }
  }
  throw new Error('Your encryption settings kept changing on another device. Try again.');
}

// --- adding this device with another one at hand (spec 11.3) ----------------------
export async function startLink() {
  if (dev && E2.status === 'pending' && E2.link?.linkId && E2.link.step === 'type') return E2.link;
  if (dev) await forgetLocal();
  const nd = await makeDevice();
  const r = await call('e2ee.link.start', { device: publicOf(nd), prekey: nd.prekeys[1].signed });
  nd.linkId = r.linkId;
  dev = nd;
  await save();
  await bindHere();
  E2.device = { d: dev.d, label: dev.label, kind: dev.kind };
  E2.status = 'pending';
  E2.link = { linkId: r.linkId, step: 'type', expires: r.expires };
  emit();
  return E2.link;
}
/** The person typed the code shown on their other device. */
export async function submitCode(text) {
  const code = link.parseLinkCode(text);
  if (!code) throw new Error('The code has 12 letters and numbers, like ABCD-EFGH-JKMN.');
  const { linkId } = E2.link;
  linkKc = await link.linkKey(code, linkId);
  const tag1 = await link.tag1(linkKc, { linkId, u: userId(), d: dev.d, dsk: dev.dskPub, prekey: dev.prekeys[1].signed });
  await call('e2ee.link.proof', { linkId, tag1 });
  E2.link = { ...E2.link, step: 'waiting' };
  emit();
}
on('e2ee.link.done', (d) => {
  if (E2.link?.linkId === d.linkId) {
    if (d.state === 'approved') finishLink().then(emit, (e) => { E2.link = { ...E2.link, step: 'cancelled', error: e.message }; emit(); });
    else if (d.state === 'cancelled' || d.state === 'expired') { E2.link = { ...E2.link, step: d.state }; emit(); }
  }
  const i = E2.approvals.findIndex((a) => a.linkId === d.linkId);
  // A request this device already settled (a wrong code it caught, or one it approved) keeps its own ending.
  if (i >= 0 && d.state !== 'approved' && !['mismatch', 'done'].includes(E2.approvals[i].step)) { E2.approvals[i] = { ...E2.approvals[i], step: d.state === 'recovered' ? 'done' : 'cancelled' }; emit(); }
});
async function finishLink() {
  const linkId = dev.linkId;
  const f = await call('e2ee.link.fetch', { linkId });
  if (f.state !== 'approved') return;
  const box = b64uOf(f.box);
  if (!linkKc || !link.sameTag(f.tag2, await link.tag2(linkKc, box, f.devlist))) throw new Error('The approval didn’t check out. Start again on this device.');
  if (!(await obj.verifyList(f.devlist)) || !f.devlist.devs.some((x) => x.d === dev.d && x.dsk === dev.dskPub)) throw new Error('The new device list didn’t check out.');
  const got = parseCanon(fromUtf8(await openKey(dev.prekeys[1].pair, `snug-e2ee-v1/link-asb\n${userId()}\n${dev.d}`, canon({ linkId, ver: f.devlist.ver }), box)), 128 * 1024);
  if (!got?.asb || await backup.asbAikPublic(got.asb) !== f.devlist.aik) throw new Error('The keys from your other device didn’t check out.');
  await completeJoin(got.asb);
}
async function completeJoin(asb) {
  await store.putAsb(asb);
  delete dev.linkId;
  dev.trusted = true;
  await save();
  await loadKeys(asb);
  linkKc = null;
  E2.link = { ...(E2.link || {}), step: 'done' };
  E2.notice = null;
  await loadMeta();
  await refreshMe();
}

// --- approving a new device, on a trusted one ---------------------------------------
on('e2ee.link', (d) => {
  if (E2.status !== 'ready' || E2.approvals.some((a) => a.linkId === d.linkId)) return;
  E2.approvals.push({ ...d, step: 'ask' });
  E2.prompt = 'approve';
  emit();
});
on('e2ee.link.proof', (d) => { const a = E2.approvals.find((x) => x.linkId === d.linkId); if (a) { a.tag1 = d.tag1; checkProof(a).then(emit, () => emit()); } });

/** "Yes, that's me": show a one-time code to type on the new device. */
export async function approveAsk(linkId) {
  const a = E2.approvals.find((x) => x.linkId === linkId);
  if (!(await obj.verifyPrekey(a.prekey, { u: userId(), d: a.d, dsk: a.dsk }))) { await rejectLink(linkId); throw new Error('That request’s keys didn’t check out, so it was cancelled.'); }
  const { code, text } = link.newLinkCode();
  a.Kc = await link.linkKey(code, linkId);
  a.code = text;
  a.step = 'code';
  emit();
  if (a.tag1) await checkProof(a);
}
async function checkProof(a) {
  if (!a.Kc || !a.tag1 || a.step !== 'code') return;
  const want = await link.tag1(a.Kc, { linkId: a.linkId, u: userId(), d: a.d, dsk: a.dsk, prekey: a.prekey });
  if (!link.sameTag(a.tag1, want)) { a.step = 'mismatch'; await call('e2ee.link.cancel', { linkId: a.linkId }).catch(() => {}); return; }
  a.step = 'adding';
  emit();
  const { list } = await ownList();
  const devlist = await nextOf(list, { devs: [...list.devs, { d: a.d, dsk: a.dsk, kind: a.kind, label: a.label, added: Date.now() }] });
  const asb = await store.getAsb();
  const box = await sealKey(b64uOf(a.prekey.pub, 32), `snug-e2ee-v1/link-asb\n${userId()}\n${a.d}`, canon({ linkId: a.linkId, ver: devlist.ver }), utf8(canon({ asb, by: dev.d })));
  await call('e2ee.link.approve', { linkId: a.linkId, devlist, box: b64u(box), tag2: await link.tag2(a.Kc, box, devlist) });
  a.step = 'done';
  delete a.Kc;
  await refreshMe();
}
export async function rejectLink(linkId) {
  await call('e2ee.link.cancel', { linkId }).catch(() => {});
  E2.approvals = E2.approvals.filter((x) => x.linkId !== linkId);
  emit();
}
export function clearApproval(linkId) { E2.approvals = E2.approvals.filter((x) => x.linkId !== linkId); emit(); }

// --- adding this device with the recovery key (spec 11.4) ---------------------------
/**
 * keep: ids of current devices to keep (the rest are removed in the same step); default all.
 * Throws an Error with code 'reauth' when the server wants the password.
 */
export async function recover(text, { password, keep } = {}) {
  const p = await parseRecoveryKey(text);
  if (p.error) throw new Error(p.message);
  if (!dev || E2.status !== 'pending') await startLink();
  const got = await call('e2ee.backup.get', password ? { password } : {});
  let asb;
  try { asb = await backup.openBackup(got.blob, await deriveBackupKey(p.raw), userId()); } catch { throw new Error('That recovery key doesn’t open your backup. Check it against the one you saved.'); }
  const k = await backup.loadAsb(asb);
  const r = await call('e2ee.bundles', { users: [userId()] });
  const cur = r.users[userId()]?.list;
  if (!cur || cur.aik !== k.aikPub || !(await obj.verifyList(cur, b64uOf(k.aikPub, 32)))) throw new Error('Your device list didn’t check out against your recovery key.');
  const kept = cur.devs.filter((x) => !keep || keep.includes(x.d));
  const devlist = await obj.makeList(k.aik, { u: userId(), ver: cur.ver + 1, aik: cur.aik, devs: [...kept, entryOf(dev)], arc: cur.arc });
  await call('e2ee.recover', { linkId: dev.linkId, devlist, ...(password ? { password } : {}) });
  keys = k;
  await completeJoin(asb);
  E2.rkSaved = true;
  emit();
}
/** The devices a recovering person may choose to drop (from the server's list; checked once the key opens it). */
export async function currentDevices() {
  const r = await call('e2ee.bundles', { users: [userId()] });
  return (r.users[userId()]?.list?.devs || []).filter((x) => x.d !== dev?.d);
}

// --- safety numbers (spec 12) ------------------------------------------------------------
/** { state: 'unknown'|'not-ready'|'ready'|'changed', number, verified, aik, devices } for a person. */
export async function safetyFor(u) {
  if (!keys) return { state: 'unknown' };
  if (!meta) await loadMeta();
  const r = await call('e2ee.bundles', { users: [u] });
  const b = r.users[u];
  if (!b || !b.list) return { state: 'not-ready' };
  const pin = meta.pins[u] || null;
  const acc = await obj.acceptList(pin, b.list);
  if (!acc.ok && acc.why === 'bad') return { state: 'not-ready' };
  const aik = b.list.aik;
  if (acc.ok && acc.changed) await updateMeta((m) => { m.pins[u] = { aik, ver: b.list.ver }; });
  const number = await safetyNumber({ id: userId(), key: b64uOf(keys.aikPub, 32) }, { id: u, key: b64uOf(aik, 32) });
  return {
    state: !acc.ok && acc.why === 'aik-changed' ? 'changed' : acc.ok ? 'ready' : 'rollback',
    number, aik, ver: b.list.ver, verified: meta.verified[u] === aik, devices: b.list.devs.map((x) => ({ label: x.label, kind: x.kind })),
  };
}
export async function setVerified(u, aik, yes) {
  await updateMeta((m) => {
    if (yes) { m.verified[u] = aik; m.pins[u] = { ...(m.pins[u] || {}), aik }; } else delete m.verified[u];
  });
  emit();
}
/** After a safety number change: trust the new key (pin it) without marking it verified. */
export async function acceptChange(u, aik, ver) {
  await updateMeta((m) => { m.pins[u] = { aik, ver }; delete m.verified[u]; });
  emit();
}

// For tests: run without IndexedDB.
export const _test = { memStore, useStore: (s) => { store = s; } };
