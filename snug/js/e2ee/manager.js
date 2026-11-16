// End-to-end encryption on this device: turning it on, binding this device to
// each connection, rotating prekeys, adding this device to an account (with
// another device's code, or the recovery key), approving a new device, the
// device list, history setting, recovery key, synced settings and safety
// numbers. js/e2ee/conv.js seals and opens messages with the keys kept here.
//
// What the server hands out is checked against what this device has already
// seen (review H1, M3, M4): the highest synced-settings version, the own
// device list's version and hash, each contact's pinned account key, list
// version, hash and devices, the conversations seen encrypted, and the key and
// device changes to show in conversations. All of it is kept here, sealed
// under this device's storage key, so a server can't roll it back.
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
import { metaCheck, listCheck } from '../lib/e2ee/highwater.js';
import { random } from '../lib/e2ee/bytes.js';

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
  metaProblem: null,     // 'rollback' | 'missing' | 'damaged': the server's synced settings are behind what this device has seen
  rotateProblem: null,   // why the weekly history key couldn't be replaced (a device that can't get new keys)
  events: [],            // key changes to show in conversations: { id, u, kind: 'aik'|'added'|'removed', label, ts }
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
// the app's own: the desktop app on its own server, or joined to another server with its built-in
// client (desktop/pinned.js), loads its own files; everywhere else the code comes from the server.
// The desktop app says which (snugApp.builtIn); its window on a server's own page isn't built-in.
export const builtInCode = () => window.snugApp?.builtIn === true;
export function deviceLabel(ua = navigator.userAgent) {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'this computer';
  return builtInCode() ? `Snug app on ${os}` : `${browser} on ${os}`;
}
export const deviceKind = () => (builtInCode() ? 'app' : 'web');

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

// Run when this device's account keys are loaded (js/e2ee/conv.js opens messages that waited for them).
export const readyHooks = [];
async function loadKeys(asb) {
  keys = await backup.loadAsb(asb);
  E2.status = 'ready';
  for (const fn of readyHooks) { try { fn(); } catch (e) { console.warn('e2ee ready', e); } }
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
        await loadLocal();
        await fetchAsbBoxes().catch((e) => console.warn('e2ee keys', e)); // newer account keys first: the settings may be under a new key
        await loadMeta();
        await maybeRotate().catch((e) => { console.warn('e2ee epoch', e); E2.rotateProblem = e.message; });
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
  // An account that already uses encryption, signing in on a new device, is asked at once (its encrypted
  // messages can't be read here until it is added). Turning encryption on for the first time is offered
  // without interrupting (invitePending: an invitation above the direct messages, a button in a
  // conversation's details, Settings > Encryption), since the server offers it to everyone by default.
  if (!E2.prompt && !local.get(skipKey()) && E2.status === 'new-device' && !local.get(askedKey())) E2.prompt = 'new-device';
  clearInterval(rotateTimer);
  rotateTimer = setInterval(() => { rotatePrekey().catch(() => {}); }, 3600_000);
  emit();
}
// settling: this device's keys are being loaded for a new connection (js/e2ee/conv.js waits before opening messages).
on('hello', (d) => { E2.settling = true; onHello(d).catch((e) => { console.warn('e2ee', e); E2.status = 'unsupported'; E2.support = { ok: false, reason: 'old' }; emit(); }).finally(() => { E2.settling = false; emit(); }); });
on('e2ee.me', (me) => { E2.me = me; emit(); });
on('e2ee.devices', (d) => { bundleCache.delete(d.user); if (d.user === userId()) refreshMe(); });
on('e2ee.asb', () => { fetchAsbBoxes().then(() => loadMeta()).then(emit, () => {}); });
on('e2ee.meta', () => { loadMeta().then(emit, () => {}); });
signOutHooks.push(() => {
  clearInterval(rotateTimer);
  store?.close(); store = null; keys = null; dev = null; meta = null; linkKc = null;
  bundleCache.clear(); pinCache.clear(); convs = {}; ownRec = null;
  Object.assign(E2, { on: false, status: 'off', me: null, device: null, prompt: null, approvals: [], link: null, rk: null, rkSaved: false, notice: null, metaProblem: null, rotateProblem: null, events: [] });
});

async function refreshMe() { E2.me = await call('e2ee.state'); emit(); }
async function forgetLocal() {
  dev = null; keys = null;
  await store.putDevice(null);
  await store.putAsb(null);
  await store.putSecret('rk', null);
}

/** Whether to show the invitation to turn encryption on: offered here, not set up, and not put off on this device. */
export const invitePending = () => E2.on && E2.status === 'none' && !local.get(askedKey()) && !local.get(skipKey());

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
  await saveLocalMeta(1, m);
  await loadLocal();
  await noteOwn(devlist);
  E2.me = r.me;
  E2.device = { d: dev.d, label: dev.label, kind: dev.kind };
  await bindHere();
  E2.status = 'ready';
  for (const fn of readyHooks) { try { fn(); } catch (e) { console.warn('e2ee ready', e); } }
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
  if (!list || !(await checkOwnList(list))) throw new Error('Your device list didn’t check out. Reload Snug and try again.');
  return { list, prekeys: r.users[userId()].prekeys };
}
const nextOf = async (list, change) => obj.makeList(keys.aik, { u: list.u, ver: list.ver + 1, aik: list.aik, devs: list.devs, arc: list.arc, ...change });

// The account keys as they must be before changing them: this device holds the newest ones (it
// fetched any box waiting for it, and the list's history key is in them), else it would rewrite
// the backup and the other devices' keys from an older copy (review M2).
async function freshAsb(list) {
  await fetchAsbBoxes();
  const asb = await store.getAsb();
  if (!asb || (list.arc && asb.ahk[list.arc.e]?.pub !== list.arc.pub)) {
    throw new Error('This device doesn’t have your newest encryption keys yet. Open Snug on your other device, then try again here.');
  }
  return asb;
}

/**
 * Changes to the account keys in one step, sealed only to the devices that stay (spec 11.6, 11.7):
 *   epoch: a new history key (when history is on), so a device that left can't open history sent after;
 *   sync:  a new key for the synced settings (they are sealed again under it in the same step);
 *   bk:    a new recovery key, so the backup a removed device could open (with your password) is replaced.
 * Returns what to send and keep; the caller sends it with its own op.
 */
async function nextKeys(list, devs, prekeys, { epoch = true, sync = false, bk = false } = {}) {
  let asb = await freshAsb(list);
  const change = { devs };
  if (epoch && list.arc) {
    const x = await backup.addEpoch(asb);
    asb = x.asb;
    change.arc = { e: x.e, pub: asb.ahk[x.e].pub, at: Date.now() };
  }
  if (sync) asb = { ...asb, sync: b64u(random(32)) };
  let rk = null;
  if (bk) { rk = await newRecoveryKey(); asb = { ...asb, bk: b64u(await deriveBackupKey(rk.raw)) }; }
  asb = backup.bumpAsb(asb);
  const devlist = await nextOf(list, change);
  const boxes = await boxesFor(asb, devlist, prekeys);
  const out = { asb, devlist, boxes, rk, backup: await backup.sealBackup(asb, b64uOf(asb.bk, 32), { ver: devlist.ver, aik: devlist.aik }) };
  if (sync || bk) {
    const next = { ...JSON.parse(JSON.stringify(meta || backup.emptyMeta())), ...(bk ? { rk: false } : {}) };
    out.meta = { ver: metaVer + 1, blob: await backup.sealMeta(next, b64uOf(asb.sync, 32), { u: userId(), ver: metaVer + 1 }) };
    out.metaValue = next;
  }
  return out;
}
// After the server took nextKeys' result: keep the new keys here (and a new recovery key to show).
async function keepKeys(x) {
  await store.putAsb(x.asb);
  await loadKeys(x.asb);
  await noteOwn(x.devlist);
  if (x.meta) { meta = x.metaValue; metaVer = x.meta.ver; await saveLocalMeta(metaVer, meta); E2.metaProblem = null; }
  if (x.rk) { await store.putSecret('rk', x.rk.text); E2.rk = { text: x.rk.text, fresh: true }; E2.rkSaved = false; }
}

/**
 * Remove a device (another one, or this one when others remain). A new history epoch starts in
 * the same step (when history is on), sealed only to the devices that stay, and for another
 * device a new settings key, so the removed one can't open history or settings sent after it.
 * lost: it was lost or stolen, so the recovery key is replaced too (the removed device holds the
 * key to the old backup); the new one is in E2.rk to save. Returns { recoveryKey }.
 */
export async function removeDevice(d, { lost = false } = {}) {
  const { list, prekeys } = await ownList();
  const self = d === dev?.d;
  const x = await nextKeys(list, list.devs.filter((e) => e.d !== d), prekeys, { epoch: true, sync: !self, bk: !self && lost });
  await call('e2ee.device.remove', { d, devlist: x.devlist, boxes: x.boxes, backup: x.backup, ...(x.meta ? { meta: x.meta } : {}) });
  if (self) { await forgetLocal(); await deleteStore(userId()).catch(() => {}); E2.status = 'new-device'; E2.device = null; } else await keepKeys(x);
  await refreshMe();
  emit();
  return { recoveryKey: x.rk?.text || null };
}

/**
 * "My keys may be exposed" (spec 5.3, review M1): a new history key, a new settings key and a new
 * recovery key, sealed to this account's devices. It protects what is sent from now on; it can't
 * take back what someone with the old keys already opened.
 */
export async function keysExposed() {
  const { list, prekeys } = await ownList();
  const x = await nextKeys(list, list.devs, prekeys, { epoch: true, sync: true, bk: true });
  await call('e2ee.publish', { devlist: x.devlist, boxes: x.boxes, backup: x.backup, meta: x.meta });
  await keepKeys(x);
  await refreshMe();
  emit();
  return x.rk.text;
}

/** History on new devices: on puts the newest history key in the list; off takes it out. */
export async function setHistory(onOff) {
  const { list } = await ownList();
  const asb = await store.getAsb();
  const e = Math.max(...Object.keys(asb.ahk).map(Number));
  const devlist = await nextOf(list, { arc: onOff ? { e, pub: asb.ahk[e].pub, at: Date.now() } : null });
  await call('e2ee.publish', { devlist });
  await noteOwn(devlist);
  await refreshMe();
}

/** A new recovery key: the backup is rewritten under it and every other device gets the updated account keys. */
export async function newRecoveryKeyFlow() {
  const { list, prekeys } = await ownList();
  const x = await nextKeys(list, list.devs, prekeys, { epoch: false, bk: true });
  await call('e2ee.publish', { devlist: x.devlist, boxes: x.boxes, backup: x.backup, meta: x.meta });
  await keepKeys(x);
  emit();
  return x.rk.text;
}

export const EPOCH_ROTATE = 7 * DAY;
/** Weekly: a new history epoch, by the first trusted device online. */
export async function rotateEpoch() {
  const run = async () => {
    const { list, prekeys } = await ownList();
    if (!list.arc) return false;
    const x = await nextKeys(list, list.devs, prekeys, { epoch: true });
    try { await call('e2ee.publish', { devlist: x.devlist, boxes: x.boxes, backup: x.backup }); } catch (e) { if (e.code === 'e2ee_conflict') return false; throw e; } // another device won
    await keepKeys(x);
    E2.rotateProblem = null;
    await refreshMe();
    return true;
  };
  return navigator.locks ? navigator.locks.request(`snug-e2ee:${userId()}`, run) : run();
}
async function maybeRotate() {
  const me = E2.me;
  if (E2.status !== 'ready' || !me?.hist || !me.epochAt || Date.now() - me.epochAt < EPOCH_ROTATE) return;
  if (me.devices.find((x) => x.d === dev?.d)?.state !== 'trusted') return;
  await rotateEpoch();
}

/**
 * Reset (spec 11.8): no device and no recovery key, or "lost or stolen". A new account key and
 * history key; old encrypted history can't be opened any more; every contact sees that this
 * person's safety number changed. Throws an Error with code 'reauth' when the password is needed.
 */
export async function resetEncryption({ password } = {}) {
  const rk = await newRecoveryKey();
  const nd = await makeDevice();
  const asb = await backup.newAsb(userId());
  const bk = await deriveBackupKey(rk.raw);
  asb.bk = b64u(bk);
  const k = await backup.loadAsb(asb);
  const cur = E2.me?.ver || 0;
  const devlist = await obj.makeList(k.aik, { u: userId(), ver: cur + 1, aik: k.aikPub, devs: [entryOf(nd)], arc: { e: 1, pub: asb.ahk[1].pub, at: Date.now() } });
  const m = backup.emptyMeta();
  const r = await call('e2ee.reset', {
    devlist, device: publicOf(nd), prekey: nd.prekeys[1].signed,
    backup: await backup.sealBackup(asb, bk, { ver: devlist.ver, aik: k.aikPub }),
    meta: await backup.sealMeta(m, k.sync, { u: userId(), ver: 1 }),
    ...(password ? { password } : {}),
  });
  nd.trusted = true;
  dev = nd;
  await save();
  await store.putAsb(asb);
  meta = m; metaVer = 1;
  E2.me = r.me;
  E2.device = { d: dev.d, label: dev.label, kind: dev.kind };
  E2.notice = null;
  E2.metaProblem = null;
  await bindHere();
  await loadKeys(asb);
  await saveLocalMeta(1, m);
  await noteOwn(devlist);
  await store.putSecret('rk', rk.text);
  E2.rk = { text: rk.text, fresh: true };
  E2.rkSaved = false;
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
    // Never skipped (review M2): a device left out would keep older keys without anyone knowing.
    if (!p || !(await obj.verifyPrekey(p, { u: userId(), d: e.d, dsk: e.dsk }))) {
      throw Object.assign(new Error(`Your device “${e.label}” hasn’t been online for a long time, so it can’t get your new encryption keys. Open Snug on it, or remove it, then try again.`), { code: 'e2ee_device_stale', device: e.d });
    }
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
      // Only newer account keys than these (review M2): an older box, or another one under the same serial, is refused.
      const order = backup.asbOrder(await store.getAsb(), got.asb);
      if (order === 'newer') { await store.putAsb(got.asb); await loadKeys(got.asb); } else if (order !== 'same') console.warn('e2ee: refused older account keys from the server');
      await store.putPlain('asbVer', ver);
    } catch { /* a box that doesn't open now is tried again next time (a later one may replace it) */ }
  }
}

// --- what this device has seen (sealed under its storage key) ----------------------
// own.list: { aik, ver, h, devs, gone } this account's newest list seen here; pin:<u>: the same for a
// contact; convs: { dm: e2eeSince } conversations seen encrypted; events: key changes to show;
// meta.local: { aik, ver, meta } the newest synced settings opened here.
let ownRec = null, convs = {};
const pinCache = new Map();
const MAX_EVENTS = 300, MAX_GONE = 40;
const devsOf = (list) => list.devs.map((x) => ({ d: x.d, dsk: x.dsk, label: x.label, kind: x.kind }));
async function loadLocal() {
  ownRec = await store.getSecret('own.list').catch(() => null);
  convs = (await store.getSecret('convs').catch(() => null)) || {};
  E2.events = (await store.getSecret('events').catch(() => null)) || [];
}
async function addEvents(list) {
  if (!list.length) return;
  const seen = new Set(E2.events.map((e) => e.key));
  const fresh = list.filter((e) => !seen.has(e.key)).map((e) => ({ id: b64u(random(9)), ts: Date.now(), ...e }));
  if (!fresh.length) return;
  E2.events = [...E2.events, ...fresh].slice(-MAX_EVENTS);
  await store.putSecret('events', E2.events).catch(() => {});
  emit();
}
// Devices that left a list stay known (to check messages they sent before), with when they left.
function goneAfter(rec, list) {
  const gone = { ...(rec?.gone || {}) };
  const now = new Set(list.devs.map((x) => x.d));
  for (const x of rec?.devs || []) if (!now.has(x.d)) gone[x.d] = { dsk: x.dsk, label: x.label, at: list.ts };
  for (const d of now) delete gone[d];
  return Object.fromEntries(Object.entries(gone).slice(-MAX_GONE));
}
function deviceEvents(u, before, list) {
  if (!before) return [];
  const { added, removed } = obj.listDiff(before, list);
  return [...added.map((x) => ({ key: `add:${u}:${x.d}`, u, kind: 'added', label: x.label })), ...removed.map((x) => ({ key: `rm:${u}:${x.d}`, u, kind: 'removed', label: x.label }))];
}
/**
 * This account's own list, checked: signed by our account key, and never older than (or a
 * different list at the same version as) one this device has seen. Returns the list, or throws.
 */
export async function checkOwnList(list) {
  if (!(await obj.verifyList(list, b64uOf(keys.aikPub, 32)))) return null;
  const h = await obj.listHash(list);
  const rec = ownRec?.aik === list.aik ? ownRec : null;
  const v = listCheck(rec, list, h);
  if (v !== 'ok') throw Object.assign(new Error(COPY_OWN_ROLLBACK), { code: 'e2ee_rollback' });
  if (!rec || list.ver > rec.ver) {
    const events = deviceEvents(userId(), rec, list);
    ownRec = { aik: list.aik, ver: list.ver, h, devs: devsOf(list), gone: goneAfter(rec, list) };
    await store.putSecret('own.list', ownRec);
    await addEvents(events);
  }
  return list;
}
const COPY_OWN_ROLLBACK = 'The server sent an older list of your devices than this device has seen, so Snug won’t use it. Reload Snug; if it keeps happening, tell whoever runs this server.';
const noteOwn = (list) => checkOwnList(list).catch(() => {});

async function pinOf(u) {
  if (!pinCache.has(u)) pinCache.set(u, await store.getSecret(`pin:${u}`).catch(() => null));
  return pinCache.get(u);
}
async function savePin(u, rec) { pinCache.set(u, rec); await store.putSecret(`pin:${u}`, rec); }
/**
 * A contact's list, checked against what this device pinned for them (and, the first time here,
 * what the synced settings pinned): { list, changedAik } to use, or { list: null, why }.
 * A new account key from someone not verified is pinned at once and a line says it changed;
 * from someone verified it waits for the person (sendGate). Added and removed devices become
 * lines in the conversations shared with them.
 */
export async function acceptContact(u, list) {
  const local = await pinOf(u);
  const synced = meta?.pins?.[u] || null;
  let pin = local || synced;
  if (local && synced?.aik === local.aik && synced.ver > local.ver) pin = { ...local, ver: synced.ver, h: synced.h };
  const r = await obj.acceptList(pin && { aik: pin.aik, ver: pin.ver, h: pin.h, list: pin.list }, list);
  if (r.ok) {
    if (r.changed || !local) {
      const events = deviceEvents(u, local, list);
      await savePin(u, { aik: list.aik, ver: list.ver, h: r.pin.h, devs: devsOf(list), gone: goneAfter(local, list) });
      await addEvents(events);
      if (!synced || synced.ver < list.ver || synced.aik !== list.aik) updateMeta((m) => { m.pins[u] = { aik: list.aik, ver: list.ver, h: r.pin.h }; }).catch(() => {});
    }
    return { list };
  }
  if (r.why === 'aik-changed' && (await obj.verifyList(list))) {
    await addEvents([{ key: `aik:${u}:${list.aik}`, u, kind: 'aik' }]);
    if (meta?.verified?.[u] !== pin.aik) {
      const h = await obj.listHash(list);
      await savePin(u, { aik: list.aik, ver: list.ver, h, devs: devsOf(list), gone: {} });
      updateMeta((m) => { m.pins[u] = { aik: list.aik, ver: list.ver, h }; }).catch(() => {});
    }
    return { list, changedAik: list.aik };
  }
  return { list: null, why: r.why };
}
/** The signing key of device d of user u, from the newest list this device accepted: { dsk, goneAt } or null. */
export async function senderKey(u, d) {
  const rec = u === userId() ? ownRec : await pinOf(u);
  const cur = rec?.devs?.find((x) => x.d === d);
  if (cur) return { dsk: cur.dsk, goneAt: null };
  const gone = rec?.gone?.[d];
  return gone ? { dsk: gone.dsk, goneAt: gone.at } : null;
}
/** Conversations this device has seen encrypted: { dm: e2eeSince } (local, and from the synced settings). */
export const encryptedConvs = () => convs;
export async function rememberConv(dm, since) {
  if (!dm || convs[dm] || !store) return;
  convs = { ...convs, [dm]: since || 1 };
  await store.putSecret('convs', convs).catch(() => {});
  if (!meta?.convs?.[dm]) updateMeta((m) => { (m.convs ||= {})[dm] = since || 1; }).catch(() => {});
}
function mergeConvs(from) {
  let changed = false;
  for (const [dm, since] of Object.entries(from || {})) if (!convs[dm]) { convs = { ...convs, [dm]: since }; changed = true; }
  if (changed) store.putSecret('convs', convs).catch(() => {});
}

// --- synced settings ------------------------------------------------------------
// The newest version this device opened is kept here: an older one from the server, or none, or
// one that doesn't open, is an error (E2.metaProblem), and this device keeps using its own copy.
async function localMeta() {
  const rec = await store.getSecret('meta.local').catch(() => null);
  return rec && rec.aik === keys.aikPub ? rec : null;
}
async function saveLocalMeta(ver, m) { await store.putSecret('meta.local', { aik: keys.aikPub, ver, meta: m }); }
async function loadMeta(retried = false) {
  if (!keys) return;
  const r = await call('e2ee.meta.get');
  const local = await localMeta();
  const verdict = metaCheck(local, r);
  let opened = null;
  if (r.blob && verdict !== 'rollback') opened = await backup.openMeta(r.blob, keys.sync, { u: userId(), ver: r.ver }).catch(() => null);
  if (r.blob && !opened && verdict !== 'rollback' && !retried) {
    // Maybe a new settings key this device hasn't fetched yet (another device removed one).
    await fetchAsbBoxes().catch(() => {});
    return loadMeta(true);
  }
  metaVer = r.ver;
  if (verdict === 'rollback' || verdict === 'missing' || (r.blob && !opened)) {
    E2.metaProblem = verdict === 'rollback' ? 'rollback' : verdict === 'missing' ? 'missing' : 'damaged';
    meta = local?.meta ? { ...backup.emptyMeta(), ...local.meta } : backup.emptyMeta();
  } else {
    E2.metaProblem = null;
    meta = opened || local?.meta || backup.emptyMeta();
    if (opened && verdict === 'take') await saveLocalMeta(r.ver, meta);
  }
  E2.rkSaved = !!meta.rk;
  mergeConvs(meta.convs);
}
async function updateMeta(fn) {
  for (let i = 0; i < 3; i++) {
    if (!meta) await loadMeta();
    if (E2.metaProblem) throw new Error('Your synced encryption settings on the server are older than this device’s copy. Fix it in Settings, Encryption.');
    const next = JSON.parse(JSON.stringify(meta));
    fn(next);
    try {
      const blob = await backup.sealMeta(next, keys.sync, { u: userId(), ver: metaVer + 1 });
      await call('e2ee.meta.put', { ver: metaVer + 1, blob });
      meta = next; metaVer += 1;
      await saveLocalMeta(metaVer, meta);
      return;
    } catch (e) {
      if (e.code !== 'e2ee_conflict') throw e;
      await loadMeta();
    }
  }
  throw new Error('Your encryption settings kept changing on another device. Try again.');
}
/** After a metaProblem, the person chooses to put this device's copy back on the server. */
export async function repairMeta() {
  const r = await call('e2ee.meta.get');
  const m = meta || backup.emptyMeta();
  const blob = await backup.sealMeta(m, keys.sync, { u: userId(), ver: r.ver + 1 });
  await call('e2ee.meta.put', { ver: r.ver + 1, blob });
  metaVer = r.ver + 1;
  await saveLocalMeta(metaVer, m);
  E2.metaProblem = null;
  emit();
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
  const tag1 = await link.tag1(linkKc, { linkId, u: userId(), d: dev.d, dsk: dev.dskPub, prekey: dev.prekeys[1].signed, label: dev.label, kind: dev.kind });
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
  await noteOwn(f.devlist);
}
async function completeJoin(asb) {
  await loadLocal();
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
  const want = await link.tag1(a.Kc, { linkId: a.linkId, u: userId(), d: a.d, dsk: a.dsk, prekey: a.prekey, label: a.label, kind: a.kind });
  if (!link.sameTag(a.tag1, want)) { a.step = 'mismatch'; await call('e2ee.link.cancel', { linkId: a.linkId }).catch(() => {}); return; }
  a.step = 'adding';
  emit();
  const { list } = await ownList();
  const devlist = await nextOf(list, { devs: [...list.devs, { d: a.d, dsk: a.dsk, kind: a.kind, label: a.label, added: Date.now() }] });
  const asb = await freshAsb(list); // the newest account keys, not an older copy
  const box = await sealKey(b64uOf(a.prekey.pub, 32), `snug-e2ee-v1/link-asb\n${userId()}\n${a.d}`, canon({ linkId: a.linkId, ver: devlist.ver }), utf8(canon({ asb, by: dev.d })));
  await call('e2ee.link.approve', { linkId: a.linkId, devlist, box: b64u(box), tag2: await link.tag2(a.Kc, box, devlist) });
  await noteOwn(devlist);
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
  const dropped = kept.length < cur.devs.length;
  let extra = {}, rk = null, next = asb, metaNext = null;
  if (dropped) {
    // Devices left out are treated as lost (review H3): a new history key, settings key and recovery
    // key, sealed to the devices that stay, so what they hold opens nothing sent from now on.
    let a2 = asb, arc = cur.arc;
    if (cur.arc) { const x = await backup.addEpoch(a2); a2 = x.asb; arc = { e: x.e, pub: a2.ahk[x.e].pub, at: Date.now() }; }
    rk = await newRecoveryKey();
    next = backup.bumpAsb(a2, { sync: b64u(random(32)), bk: b64u(await deriveBackupKey(rk.raw)) });
    const devlist = await obj.makeList(k.aik, { u: userId(), ver: cur.ver + 1, aik: cur.aik, devs: [...kept, entryOf(dev)], arc });
    keys = await backup.loadAsb(next);
    const m0 = await call('e2ee.meta.get');
    const old = m0.blob ? await backup.openMeta(m0.blob, k.sync, { u: userId(), ver: m0.ver }).catch(() => null) : null;
    metaNext = { ...(old || backup.emptyMeta()), rk: false };
    extra = {
      devlist, boxes: await boxesFor(next, devlist, r.users[userId()]?.prekeys || {}),
      backup: await backup.sealBackup(next, b64uOf(next.bk, 32), { ver: devlist.ver, aik: devlist.aik }),
      meta: { ver: m0.ver + 1, blob: await backup.sealMeta(metaNext, b64uOf(next.sync, 32), { u: userId(), ver: m0.ver + 1 }) },
    };
  } else {
    extra = { devlist: await obj.makeList(k.aik, { u: userId(), ver: cur.ver + 1, aik: cur.aik, devs: [...kept, entryOf(dev)], arc: cur.arc }) };
    keys = k;
  }
  await call('e2ee.recover', { linkId: dev.linkId, ...extra, ...(password ? { password } : {}) });
  if (metaNext) await saveLocalMeta(extra.meta.ver, metaNext);
  await completeJoin(next);
  await noteOwn(extra.devlist);
  if (rk) { await store.putSecret('rk', rk.text); E2.rk = { text: rk.text, fresh: true }; E2.rkSaved = false; } else E2.rkSaved = true;
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
  const acc = await acceptContact(u, b.list);
  if (!acc.list && acc.why === 'bad') return { state: 'not-ready' };
  const aik = b.list.aik;
  const number = await safetyNumber({ id: userId(), key: b64uOf(keys.aikPub, 32) }, { id: u, key: b64uOf(aik, 32) });
  return {
    state: acc.changedAik ? 'changed' : acc.list ? 'ready' : 'rollback',
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
  const cur = await pinOf(u);
  if (cur?.aik !== aik) await savePin(u, { aik, ver, h: null, devs: [], gone: {} });
  await updateMeta((m) => { m.pins[u] = { aik, ver }; delete m.verified[u]; }).catch(() => {});
  emit();
}

// The live keys, for js/e2ee/conv.js (sealing and opening messages). Read-only views of this module's state.
export const ring = {
  get dev() { return dev; }, get keys() { return keys; }, get meta() { return meta; }, get store() { return store; },
  updateMeta: (fn) => updateMeta(fn),
  checkOwnList, acceptContact, senderKey, encryptedConvs, rememberConv,
};

// For tests: run without IndexedDB.
export const _test = { memStore, useStore: (s) => { store = s; } };
