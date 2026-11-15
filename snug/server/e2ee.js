// End-to-end encryption for DMs and groups: the server side of the key
// directory (design: the v0.12 e2ee spec, sections 5, 6, 11, 19 and 20).
//
// The server never holds a private key or a message key. It stores and hands
// out public keys, each account's device list (signed by that account's
// identity key, which only its devices hold), device prekeys (signed by each
// device), the recovery backup and the synced settings blob (both encrypted
// on a device before they arrive), and relays the steps of adding a device. It
// checks every signature it can, so a client bug or a stale tab can't publish
// a list the account didn't sign, but clients never rely on that: they check
// the same signatures themselves (js/lib/e2ee/objects.js).
//
// A socket is "bound" to a device after proving it holds that device's signing
// key over a per-socket nonce (e2ee.bind). Only a bound socket of a trusted
// device can change the account's keys.
import { createPublicKey, verify as edVerify, randomBytes } from 'node:crypto';
import { canon, parseCanon } from '../js/lib/e2ee/canon.js';
import { b64u, b64uOf } from '../js/lib/e2ee/bytes.js';
import { listProblem, prekeyProblem, isDeviceId, MAX_DEVICES, PREKEY_MAX_AGE } from '../js/lib/e2ee/objects.js';
import { PROTO } from '../js/lib/proto.js';
import { limiter, tokenHash, recentAuth } from './auth.js';
import { secRecord } from './seclog.js';
import { createE2eeConv } from './e2ee-conv.js';

export const MAX_PENDING = 3;
export const LINK_MS = 10 * 60_000;
export const MAX_BLOB = 64 * 1024;
const LIVE_PREKEYS = 3;
const FUTURE = 10 * 60_000;
const ASB_BOX_DAYS = 30;
const PREFIX = 'snug-e2ee-v1/';

// --- schema ----------------------------------------------------------------
export function migrateE2ee(db) {
  const add = (table, col, type) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  };
  // Columns the encrypted conversations use (spec section 19); unused until those land.
  add('dms', 'e2ee', 'INTEGER');
  add('dms', 'e2ee_since', 'INTEGER');
  add('messages', 'enc', 'TEXT');
  add('messages', 'ping', 'TEXT');
  add('msg_edits', 'enc', 'TEXT');
  add('msg_edits', 'rev', 'INTEGER');
  add('files', 'enc', 'INTEGER');
  add('scheduled', 'enc', 'TEXT');
  add('scheduled', 'members', 'TEXT');
  add('sessions', 'e2ee_device', 'TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS e2ee_accounts (
      user TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      aik TEXT NOT NULL, ver INTEGER NOT NULL, list TEXT NOT NULL, sig TEXT NOT NULL,
      hist INTEGER NOT NULL DEFAULT 1, epoch INTEGER, epoch_at INTEGER,
      reset_at INTEGER, updated INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS e2ee_devices (
      id TEXT PRIMARY KEY, user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      dsk TEXT NOT NULL, label TEXT NOT NULL, kind TEXT NOT NULL,
      state TEXT NOT NULL,
      session TEXT, created INTEGER NOT NULL, seen INTEGER, expires INTEGER);
    CREATE INDEX IF NOT EXISTS e2ee_devices_user ON e2ee_devices(user, state);
    CREATE TABLE IF NOT EXISTS e2ee_prekeys (
      device TEXT NOT NULL REFERENCES e2ee_devices(id) ON DELETE CASCADE,
      kid INTEGER NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL, retired INTEGER,
      PRIMARY KEY (device, kid));
    CREATE TABLE IF NOT EXISTS e2ee_wraps (
      msg TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0,
      target TEXT NOT NULL, kid INTEGER, wrap TEXT NOT NULL, PRIMARY KEY (msg, rev, target));
    CREATE INDEX IF NOT EXISTS e2ee_wraps_target ON e2ee_wraps(target);
    CREATE TABLE IF NOT EXISTS e2ee_links (
      id TEXT PRIMARY KEY, user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, device TEXT NOT NULL,
      proof TEXT, approve TEXT, state TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS e2ee_asb_boxes (
      device TEXT NOT NULL REFERENCES e2ee_devices(id) ON DELETE CASCADE, ver INTEGER NOT NULL, box TEXT NOT NULL,
      created INTEGER NOT NULL, PRIMARY KEY (device, ver));
    CREATE TABLE IF NOT EXISTS e2ee_backup (user TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      ver INTEGER NOT NULL, blob TEXT NOT NULL, updated INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS e2ee_meta (user TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      ver INTEGER NOT NULL, blob TEXT NOT NULL, updated INTEGER NOT NULL);
  `);
}

// --- signatures (node:crypto, the same check as server/peercrypto.js) -------
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
export function verifyEd(pubB64u, sigB64u, text) {
  const pub = b64uOf(pubB64u, 32), sig = b64uOf(sigB64u, 64);
  if (!pub || !sig) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(pub)]), format: 'der', type: 'spki' });
    return edVerify(null, Buffer.from(text, 'utf8'), key, Buffer.from(sig));
  } catch { return false; }
}
const unsignedCanon = (o) => { const { sig, ...rest } = o; return canon(rest); }; // eslint-disable-line no-unused-vars
const objectSigned = (pub, t, o) => verifyEd(pub, o?.sig, `${PREFIX}${t}\n${unsignedCanon(o)}`);

export function createE2eeOps({ db, M, hub, fail, ops: all = {}, on = false }) {
  const now = () => Date.now();
  const json = (s) => { try { return JSON.parse(s); } catch { return null; } };
  const account = (u) => db.get('SELECT * FROM e2ee_accounts WHERE user = ?', u);
  const deviceRow = (id) => db.get('SELECT * FROM e2ee_devices WHERE id = ?', id);
  const devicesOf = (u, states = ['trusted', 'pending']) => db.all(`SELECT * FROM e2ee_devices WHERE user = ? AND state IN (${states.map(() => '?').join(',')}) ORDER BY created`, u, ...states);
  const currentPrekey = (d) => db.get('SELECT * FROM e2ee_prekeys WHERE device = ? AND retired IS NULL ORDER BY kid DESC LIMIT 1', d);
  const off = () => fail('End-to-end encryption isn’t turned on for this server.');
  const noAccount = () => fail('Turn on end-to-end encryption first.');
  const audit = (event, c, ok = true, why = null) => {
    try { db.run('INSERT INTO auth_events (ts, user, event, ok, ip, agent, why) VALUES (?, ?, ?, ?, ?, ?, ?)', now(), c.user, event, ok ? 1 : 0, '', String(c.ws?.secReq?.headers?.['user-agent'] || '').slice(0, 80), why); } catch { /* closing */ }
  };

  // Rate limits for reads that hand out keys or the backup.
  const bundleLimit = limiter({ capacity: 30, perSecond: 0.5 });
  const backupHour = limiter({ capacity: 5, perSecond: 5 / 3600 });
  const backupDay = limiter({ capacity: 20, perSecond: 20 / 86_400 });
  (hub.extraLimits ||= []).push(bundleLimit, backupHour, backupDay);

  // --- what each socket and person sees --------------------------------------
  const bound = (c) => {
    const id = c.ws?.e2eeDevice;
    const row = id && deviceRow(id);
    return row && row.user === c.user && row.state !== 'removed' ? row : null;
  };
  const boundTrusted = (c) => {
    const row = bound(c);
    if (!row || row.state !== 'trusted') fail('This device can’t change your encryption keys. Approve it from another device first.');
    return row;
  };
  function meView(u) {
    const a = account(u);
    const devices = a ? devicesOf(u).map((d) => ({ d: d.id, label: d.label, kind: d.kind, state: d.state, created: d.created, seen: d.seen })) : [];
    return {
      state: a ? 'ready' : 'none', ver: a?.ver || 0, hist: a ? !!a.hist : true, epoch: a?.epoch || null, epochAt: a?.epoch_at || null,
      backup: !!db.get('SELECT 1 FROM e2ee_backup WHERE user = ?', u), resetAt: a?.reset_at || null, devices,
    };
  }
  hub.helloExtras.push((ws, u) => {
    ws.e2eeNonce = b64u(randomBytes(32));
    ws.e2eeDevice = null;
    return { proto: PROTO, e2ee: { on, nonce: ws.e2eeNonce, me: meView(u) } };
  });
  // The people who need to know when this person's devices change: themselves and everyone sharing a DM.
  const audienceOf = (u) => [u, ...db.all('SELECT DISTINCT d2.user AS id FROM dm_members d1 JOIN dm_members d2 ON d1.dm = d2.dm WHERE d1.user = ? AND d2.user != ?', u, u).map((r) => r.id)];
  let conv = null; // encrypted conversations (server/e2ee-conv.js), made below
  const devicesChanged = (u) => {
    const a = account(u);
    hub.toUsers(audienceOf(u), 'e2ee.devices', { user: u, ver: a?.ver || 0 });
    hub.toUser(u, 'e2ee.me', meView(u));
    conv?.readyChanged(u); // DMs whose last member just became ready turn encrypted
  };
  // Sockets of this person bound to one of their trusted devices.
  const trustedSockets = (u) => [...hub.socketsOf(u)].filter((ws) => ws.e2eeDevice && deviceRow(ws.e2eeDevice)?.state === 'trusted');
  const deviceSockets = (u, d) => [...hub.socketsOf(u)].filter((ws) => ws.e2eeDevice === d);
  const sendTo = (sockets, ev, d) => { for (const ws of sockets) if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'ev', ev, d })); };

  // --- input checks ----------------------------------------------------------
  const str = (v, max, name = 'This') => (typeof v === 'string' && v.length <= max ? v : fail(`${name} isn’t valid.`));
  const obj = (v, name) => (v && typeof v === 'object' && !Array.isArray(v) ? v : fail(`${name} is missing.`));
  const blobOk = (v, name = 'That') => { try { if (canon(v).length > MAX_BLOB) fail(`${name} is too large.`); } catch (e) { if (e.message.endsWith('too large.')) throw e; fail(`${name} isn’t valid.`); } return v; };
  function checkList(u, list, { aik, ver }) {
    obj(list, 'The device list');
    if (listProblem(list) || list.u !== u || !list.sig) fail('That device list isn’t valid.');
    if (aik && list.aik !== aik) fail('That device list is signed by a different account key.');
    if (!objectSigned(list.aik, 'devlist', list)) fail('That device list’s signature doesn’t check out.');
    if (ver !== undefined && list.ver !== ver) fail('Your encryption keys changed on another device. Try again.', { code: 'e2ee_conflict' });
    return list;
  }
  function checkDevice(dev) {
    obj(dev, 'The device');
    if (!isDeviceId(dev.d) || !b64uOf(dev.dsk, 32) || !['web', 'app'].includes(dev.kind) || typeof dev.label !== 'string' || !dev.label || dev.label.length > 80) fail('That device isn’t valid.');
    return dev;
  }
  function checkPrekey(u, d, dsk, prekey, kid) {
    obj(prekey, 'The prekey');
    if (prekeyProblem(prekey) || prekey.u !== u || prekey.d !== d) fail('That prekey isn’t valid.');
    if (kid !== undefined && prekey.kid !== kid) fail('That prekey is out of order.');
    if (Math.abs(prekey.ts - now()) > FUTURE) fail('That prekey’s time is off. Check this device’s clock.');
    if (!objectSigned(dsk, 'prekey', prekey)) fail('That prekey’s signature doesn’t check out.');
    return prekey;
  }
  function checkBackup(b, aik) {
    obj(b, 'The backup');
    blobOk(b, 'The backup');
    if (b.v !== 1 || !Number.isSafeInteger(b.ver) || b.aik !== aik || !b64uOf(b.n, 12) || !b64uOf(b.c)) fail('That backup isn’t valid.');
    return b;
  }
  const metaOk = (m) => (typeof m === 'string' && m.length <= MAX_BLOB && b64uOf(m) ? m : fail('Those settings aren’t valid.'));
  const listEntry = (list, d) => list.devs.find((x) => x.d === d);
  // A list's devices must be this account's registered devices, with the keys and labels they registered.
  function devicesMatch(u, list, allowPending = null) {
    for (const e of list.devs) {
      const row = deviceRow(e.d);
      if (!row || row.user !== u || row.state === 'removed' || (row.state === 'pending' && e.d !== allowPending)) fail('That device list names a device this account doesn’t have.');
      if (row.dsk !== e.dsk || row.kind !== e.kind) fail('That device list doesn’t match a device’s keys.');
    }
  }
  // The session a socket signed in with must be recent (or the person types their password now).
  async function freshAuth(c, d, why) {
    if (recentAuth(db, c.ws?.token)) return;
    if (typeof d.password !== 'string' || !d.password) fail('For your security, type your password to continue.', { code: 'reauth' });
    const r = await M.stepUp?.(c.user, { password: d.password, code: typeof d.code === 'string' ? d.code.replace(/\s/g, '') : '', token: c.ws?.token, what: why });
    if (r) fail(r.message, { code: 'reauth' });
  }

  function saveAccount(u, list, { reset = false } = {}) {
    const t = now();
    const prev = account(u);
    const arc = list.arc;
    const epochAt = arc ? (prev?.epoch === arc.e ? prev.epoch_at : arc.at) : null;
    db.run(`INSERT INTO e2ee_accounts (user, aik, ver, list, sig, hist, epoch, epoch_at, reset_at, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user) DO UPDATE SET aik = excluded.aik, ver = excluded.ver, list = excluded.list, sig = excluded.sig, hist = excluded.hist,
      epoch = excluded.epoch, epoch_at = excluded.epoch_at, reset_at = COALESCE(excluded.reset_at, e2ee_accounts.reset_at), updated = excluded.updated`,
    u, list.aik, list.ver, canon(list), list.sig, arc ? 1 : 0, arc?.e ?? prev?.epoch ?? null, epochAt, reset ? t : null, t);
  }
  function addPrekey(d, prekey) {
    const t = now();
    db.run('UPDATE e2ee_prekeys SET retired = ? WHERE device = ? AND retired IS NULL', t, d);
    db.run('INSERT INTO e2ee_prekeys (device, kid, body, created) VALUES (?, ?, ?, ?)', d, prekey.kid, canon(prekey), t);
    // Only the newest few are kept; older private keys are gone from the device by then anyway.
    db.run('DELETE FROM e2ee_prekeys WHERE device = ? AND kid NOT IN (SELECT kid FROM e2ee_prekeys WHERE device = ? ORDER BY kid DESC LIMIT ?)', d, d, LIVE_PREKEYS);
  }
  function insertDevice(u, dev, state, session, expires = null) {
    db.run('INSERT INTO e2ee_devices (id, user, dsk, label, kind, state, session, created, expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      dev.d, u, dev.dsk, dev.label, dev.kind, state, session, now(), expires);
  }
  function storeBoxes(u, list, boxes, from) {
    if (boxes === undefined) return;
    obj(boxes, 'The keys for your other devices');
    for (const [d, box] of Object.entries(boxes)) {
      if (d === from || !listEntry(list, d)) fail('Those keys name a device that isn’t in the list.');
      blobOk(box, 'A device’s keys');
      db.run('INSERT OR REPLACE INTO e2ee_asb_boxes (device, ver, box, created) VALUES (?, ?, ?, ?)', d, list.ver, canon(box), now());
    }
    for (const d of Object.keys(boxes)) sendTo(deviceSockets(u, d), 'e2ee.asb', { ver: list.ver });
  }
  function storeBackup(u, backup, aik) {
    if (backup === undefined) return;
    checkBackup(backup, aik);
    db.run('INSERT INTO e2ee_backup (user, ver, blob, updated) VALUES (?, ?, ?, ?) ON CONFLICT(user) DO UPDATE SET ver = excluded.ver, blob = excluded.blob, updated = excluded.updated',
      u, backup.ver, canon(backup), now());
  }
  // A device that may no longer read anything: no prekeys, no pending keys, signed out.
  function removeDevice(u, d) {
    db.run("UPDATE e2ee_devices SET state = 'removed', expires = NULL WHERE id = ? AND user = ?", d, u);
    db.run('DELETE FROM e2ee_prekeys WHERE device = ?', d);
    db.run('DELETE FROM e2ee_asb_boxes WHERE device = ?', d);
    db.run("DELETE FROM e2ee_wraps WHERE target = ?", `d:${d}`);
    for (const s of db.all('SELECT hash FROM sessions WHERE user = ? AND e2ee_device = ?', u, d)) {
      db.run('DELETE FROM sessions WHERE hash = ?', s.hash);
      hub.endToken(u, s.hash);
    }
    for (const ws of deviceSockets(u, d)) ws.close(4001, 'signed out');
  }
  const sessionOf = (c) => (c.ws?.token ? tokenHash(c.ws.token) : null);
  const linkRow = (u, id) => {
    const l = typeof id === 'string' && db.get('SELECT * FROM e2ee_links WHERE id = ? AND user = ?', id, u);
    if (!l || l.expires < now() || !['open', 'proved', 'approved'].includes(l.state)) fail('That request has ended. Start again on the new device.');
    return l;
  };

  const ops = {
    'e2ee.state': (c) => meView(c.user),

    // The first device turns encryption on for the account.
    'e2ee.setup': (c, d) => {
      if (!on) off();
      if (account(c.user)) fail('End-to-end encryption is already on for your account. Add this device from another one, or use your recovery key.');
      const list = checkList(c.user, d.devlist, { ver: 1 });
      const dev = checkDevice(d.device);
      if (list.devs.length !== 1 || list.devs[0].d !== dev.d || list.devs[0].dsk !== dev.dsk || list.devs[0].kind !== dev.kind) fail('The device list must name just this device.');
      if (deviceRow(dev.d)) fail('That device id is taken. Reload Snug and try again.');
      const prekey = checkPrekey(c.user, dev.d, dev.dsk, d.prekey, 1);
      checkBackup(d.backup, list.aik);
      const meta = metaOk(d.meta);
      db.tx(() => {
        insertDevice(c.user, dev, 'trusted', sessionOf(c));
        db.run('DELETE FROM e2ee_devices WHERE user = ? AND state != ?', c.user, 'trusted'); // leftovers of an earlier reset
        addPrekey(dev.d, prekey);
        saveAccount(c.user, list);
        storeBackup(c.user, d.backup, list.aik);
        db.run('INSERT OR REPLACE INTO e2ee_meta (user, ver, blob, updated) VALUES (?, 1, ?, ?)', c.user, meta, now());
      });
      audit('e2ee.setup', c);
      devicesChanged(c.user);
      return { me: meView(c.user) };
    },

    // Prove this socket runs on a device of this account (its signing key over this socket's nonce).
    'e2ee.bind': (c, d) => {
      const row = typeof d.d === 'string' && deviceRow(d.d);
      if (!row || row.user !== c.user || row.state === 'removed' || (row.expires && row.expires < now())) fail('This device’s encryption keys aren’t known here any more.', { code: 'e2ee_unknown_device' });
      if (!c.ws?.e2eeNonce || !verifyEd(row.dsk, d.sig, `${PREFIX}bind\n${c.user}\n${row.id}\n${c.ws.e2eeNonce}`)) fail('That device proof didn’t check out.');
      c.ws.e2eeDevice = row.id;
      const session = sessionOf(c);
      db.run('UPDATE e2ee_devices SET seen = ?, session = COALESCE(?, session) WHERE id = ?', now(), session, row.id);
      if (session) db.run('UPDATE sessions SET e2ee_device = ? WHERE hash = ?', row.id, session);
      const cur = currentPrekey(row.id);
      return { state: row.state, kid: cur?.kid || 0, prekeyAt: cur?.created || 0 };
    },

    // Public keys of people this person talks to (or could start a conversation with).
    'e2ee.bundles': (c, d) => {
      if (!bundleLimit.take(c.user)) fail('You’re going a little fast. Wait a moment and try again.');
      if (!Array.isArray(d.users) || d.users.length > 10) fail('Ask for up to 10 people at a time.');
      const peers = M.dmPeers(c.user);
      const out = {};
      for (const u of new Set(d.users)) {
        if (typeof u !== 'string' || (u !== c.user && !peers.has(u))) continue;
        const a = account(u);
        if (!a) { out[u] = { ready: false }; continue; }
        const list = json(a.list);
        const prekeys = {};
        for (const e of list.devs) {
          const p = currentPrekey(e.d);
          if (p && deviceRow(e.d)?.state === 'trusted') prekeys[e.d] = json(p.body);
        }
        out[u] = { ready: Object.keys(prekeys).length > 0, list, prekeys, hist: !!a.hist, resetAt: a.reset_at || null };
      }
      return { users: out };
    },

    // A new prekey for the bound device (weekly); the old one is retired.
    'e2ee.prekey': (c, d) => {
      const row = bound(c) || fail('Bind this device first.');
      const cur = currentPrekey(row.id);
      const prekey = checkPrekey(c.user, row.id, row.dsk, d.prekey, (cur?.kid || 0) + 1);
      db.tx(() => addPrekey(row.id, prekey));
      return { kid: prekey.kid };
    },

    // A new signed list from a trusted device: a history epoch, history on or off, a label change.
    'e2ee.publish': (c, d) => {
      const me = boundTrusted(c);
      const a = account(c.user) || noAccount();
      const list = checkList(c.user, d.devlist, { aik: a.aik, ver: a.ver + 1 });
      devicesMatch(c.user, list);
      if (!listEntry(list, me.id)) fail('A device can’t leave itself out of the list here. Use Remove instead.');
      const old = json(a.list);
      if (list.devs.length !== old.devs.length || list.devs.some((e) => !listEntry(old, e.d))) fail('Add or remove devices with their own steps.');
      if (list.arc && a.epoch && list.arc.e < a.epoch) fail('That history key is older than the current one.');
      db.tx(() => {
        saveAccount(c.user, list);
        storeBoxes(c.user, list, d.boxes, me.id);
        storeBackup(c.user, d.backup, a.aik);
      });
      devicesChanged(c.user);
      return { ver: list.ver };
    },

    // Remove a device: it gets nothing new, and every session it had ends.
    'e2ee.device.remove': (c, d) => {
      const me = boundTrusted(c);
      const a = account(c.user) || noAccount();
      const gone = typeof d.d === 'string' && deviceRow(d.d);
      if (!gone || gone.user !== c.user || gone.state === 'removed') fail('That device isn’t one of yours.');
      const list = checkList(c.user, d.devlist, { aik: a.aik, ver: a.ver + 1 });
      const old = json(a.list);
      const want = old.devs.filter((e) => e.d !== gone.id).map((e) => e.d).sort();
      if (canon(list.devs.map((e) => e.d).sort()) !== canon(want) || !want.length) fail(want.length ? 'That list must be your devices without that one.' : 'That’s your only device. Reset encryption instead.');
      devicesMatch(c.user, list);
      db.tx(() => {
        saveAccount(c.user, list);
        storeBoxes(c.user, list, d.boxes, me.id);
        storeBackup(c.user, d.backup, a.aik);
        removeDevice(c.user, gone.id);
      });
      audit('e2ee.device.remove', c);
      devicesChanged(c.user);
      return { ver: list.ver };
    },

    // Updated account keys sealed to this device by another one (after a new history epoch).
    'e2ee.asb.fetch': (c, d) => {
      const row = bound(c) || fail('Bind this device first.');
      const after = Number.isSafeInteger(d.after) ? d.after : 0;
      return { boxes: db.all('SELECT ver, box FROM e2ee_asb_boxes WHERE device = ? AND ver > ? ORDER BY ver', row.id, after).map((b) => ({ ver: b.ver, box: json(b.box) })) };
    },

    // Adding a device with another one at hand (spec 11.3). Step 1, on the new device.
    'e2ee.link.start': (c, d) => {
      if (!on) off();
      if (!account(c.user)) noAccount();
      const dev = checkDevice(d.device);
      if (deviceRow(dev.d)) fail('That device id is taken. Reload Snug and try again.');
      const prekey = checkPrekey(c.user, dev.d, dev.dsk, d.prekey, 1);
      const t = now();
      const pending = db.get("SELECT COUNT(*) n FROM e2ee_devices WHERE user = ? AND state = 'pending' AND expires > ?", c.user, t).n;
      if (pending >= MAX_PENDING) fail('Too many devices are waiting to be added. Wait ten minutes, or finish one of them.');
      if (db.get("SELECT COUNT(*) n FROM e2ee_devices WHERE user = ? AND state = 'trusted'", c.user).n >= MAX_DEVICES) fail(`You can have up to ${MAX_DEVICES} devices. Remove one first.`);
      const linkId = `lk_${b64u(randomBytes(12))}`;
      db.tx(() => {
        insertDevice(c.user, dev, 'pending', sessionOf(c), t + LINK_MS);
        addPrekey(dev.d, prekey);
        db.run("INSERT INTO e2ee_links (id, user, device, state, created, expires) VALUES (?, ?, ?, 'open', ?, ?)", linkId, c.user, dev.d, t, t + LINK_MS);
      });
      sendTo(trustedSockets(c.user), 'e2ee.link', { linkId, d: dev.d, dsk: dev.dsk, label: dev.label, kind: dev.kind, prekey, ts: t });
      return { linkId, expires: t + LINK_MS };
    },
    // Step 3, on the new device: the HMAC over its keys with the typed code. One per link.
    'e2ee.link.proof': (c, d) => {
      const l = linkRow(c.user, d.linkId);
      if (c.ws?.e2eeDevice !== l.device) fail('Send this from the new device.');
      if (l.proof || l.state !== 'open') fail('A code was already tried for this request. Start again on the new device.');
      const tag = str(d.tag1, 64, 'That code');
      if (!b64uOf(tag, 32)) fail('That code isn’t valid.');
      db.run("UPDATE e2ee_links SET proof = ?, state = 'proved' WHERE id = ?", tag, l.id);
      sendTo(trustedSockets(c.user), 'e2ee.link.proof', { linkId: l.id, tag1: tag });
      return {};
    },
    // Step 4, on the trusted device: the new list with the new device, and the account keys sealed to it.
    'e2ee.link.approve': (c, d) => {
      const me = boundTrusted(c);
      const l = linkRow(c.user, d.linkId);
      if (l.state !== 'proved') fail('The new device hasn’t sent its code yet.');
      const a = account(c.user) || noAccount();
      const list = checkList(c.user, d.devlist, { aik: a.aik, ver: a.ver + 1 });
      const old = json(a.list);
      const want = [...old.devs.map((e) => e.d), l.device].sort();
      if (canon(list.devs.map((e) => e.d).sort()) !== canon(want)) fail('That list must be your devices plus the new one.');
      devicesMatch(c.user, list, l.device);
      blobOk(d.box, 'The keys for the new device');
      if (!b64uOf(d.tag2, 32)) fail('That approval isn’t valid.');
      db.tx(() => {
        saveAccount(c.user, list);
        db.run("UPDATE e2ee_devices SET state = 'trusted', expires = NULL WHERE id = ?", l.device);
        db.run("UPDATE e2ee_links SET approve = ?, state = 'approved' WHERE id = ?", canon({ devlist: list, box: d.box, tag2: d.tag2, by: me.id }), l.id);
      });
      audit('e2ee.device.add', c);
      sendTo(deviceSockets(c.user, l.device), 'e2ee.link.done', { linkId: l.id, state: 'approved' });
      devicesChanged(c.user);
      return { ver: list.ver };
    },
    // Step 5, on the new device.
    'e2ee.link.fetch': (c, d) => {
      const l = linkRow(c.user, d.linkId);
      if (c.ws?.e2eeDevice !== l.device) fail('Fetch this from the new device.');
      if (l.state !== 'approved') return { state: l.state };
      db.run("UPDATE e2ee_links SET state = 'done' WHERE id = ?", l.id);
      return { state: 'approved', ...json(l.approve) };
    },
    'e2ee.link.cancel': (c, d) => {
      const l = typeof d.linkId === 'string' && db.get('SELECT * FROM e2ee_links WHERE id = ? AND user = ?', d.linkId, c.user);
      if (!l || !['open', 'proved'].includes(l.state)) return {};
      db.tx(() => {
        db.run("UPDATE e2ee_links SET state = 'cancelled' WHERE id = ?", l.id);
        db.run("DELETE FROM e2ee_devices WHERE id = ? AND state = 'pending'", l.device);
      });
      sendTo([...deviceSockets(c.user, l.device), ...trustedSockets(c.user)], 'e2ee.link.done', { linkId: l.id, state: 'cancelled' });
      return {};
    },

    // The recovery key route (spec 11.4): fetch the backup, then add this device with the account key it holds.
    'e2ee.backup.get': async (c, d) => {
      const b = db.get('SELECT * FROM e2ee_backup WHERE user = ?', c.user) || fail('There’s no recovery backup for your account.');
      await freshAuth(c, d, 'e2ee.backup');
      if (!backupHour.take(c.user) || !backupDay.take(c.user)) { audit('e2ee.backup.get', c, false, 'rate'); fail('Too many tries with the recovery key. Wait an hour and try again.'); }
      audit('e2ee.backup.get', c);
      secRecord(db, 'e2ee.backup', { req: c.ws?.secReq, user: c.user });
      return { blob: json(b.blob), ver: b.ver };
    },
    'e2ee.backup.put': (c, d) => {
      boundTrusted(c);
      const a = account(c.user) || noAccount();
      const cur = db.get('SELECT ver FROM e2ee_backup WHERE user = ?', c.user);
      checkBackup(d.blob, a.aik);
      if (d.blob.ver !== (cur?.ver || 0) + 1) fail('Your recovery backup changed on another device. Try again.', { code: 'e2ee_conflict' });
      storeBackup(c.user, d.blob, a.aik);
      return { ver: d.blob.ver };
    },
    'e2ee.recover': async (c, d) => {
      const l = linkRow(c.user, d.linkId);
      if (c.ws?.e2eeDevice !== l.device || !['open', 'proved'].includes(l.state)) fail('Recover from the new device.');
      await freshAuth(c, d, 'e2ee.recover');
      const a = account(c.user) || noAccount();
      const list = checkList(c.user, d.devlist, { aik: a.aik, ver: a.ver + 1 });
      if (!listEntry(list, l.device)) fail('The list must include this device.');
      const old = json(a.list);
      for (const e of list.devs) if (e.d !== l.device && !listEntry(old, e.d)) fail('Recovery can only add this device (and leave others out).');
      devicesMatch(c.user, list, l.device);
      const dropped = old.devs.filter((e) => !listEntry(list, e.d)).map((e) => e.d);
      db.tx(() => {
        saveAccount(c.user, list);
        db.run("UPDATE e2ee_devices SET state = 'trusted', expires = NULL WHERE id = ?", l.device);
        db.run("UPDATE e2ee_links SET state = 'done' WHERE id = ?", l.id);
        for (const x of dropped) removeDevice(c.user, x);
      });
      audit('e2ee.recover', c);
      sendTo(trustedSockets(c.user).filter((ws) => ws.e2eeDevice !== l.device), 'e2ee.link.done', { linkId: l.id, state: 'recovered' });
      devicesChanged(c.user);
      return { ver: list.ver };
    },

    // Synced settings (verification marks, pinned keys): an encrypted blob, compare-and-swap.
    'e2ee.meta.get': (c) => {
      const m = db.get('SELECT ver, blob FROM e2ee_meta WHERE user = ?', c.user);
      return m ? { ver: m.ver, blob: m.blob } : { ver: 0, blob: null };
    },
    'e2ee.meta.put': (c, d) => {
      boundTrusted(c);
      const cur = db.get('SELECT ver FROM e2ee_meta WHERE user = ?', c.user)?.ver || 0;
      if (d.ver !== cur + 1) fail('Your encryption settings changed on another device. Try again.', { code: 'e2ee_conflict', data: { ver: cur } });
      const blob = metaOk(d.blob);
      db.run('INSERT OR REPLACE INTO e2ee_meta (user, ver, blob, updated) VALUES (?, ?, ?, ?)', c.user, d.ver, blob, now());
      for (const ws of hub.socketsOf(c.user)) if (ws !== c.ws) sendTo([ws], 'e2ee.meta', { ver: d.ver });
      return { ver: d.ver };
    },

    // No device and no recovery key (or a device was stolen): a new account key; old history stays closed.
    'e2ee.reset': async (c, d) => {
      if (!on) off();
      const a = account(c.user) || noAccount();
      await freshAuth(c, d, 'e2ee.reset');
      const list = checkList(c.user, d.devlist, { ver: a.ver + 1 });
      if (list.aik === a.aik) fail('A reset needs a new account key.');
      const dev = checkDevice(d.device);
      if (list.devs.length !== 1 || list.devs[0].d !== dev.d || list.devs[0].dsk !== dev.dsk) fail('The device list must name just this device.');
      if (deviceRow(dev.d)) fail('That device id is taken. Reload Snug and try again.');
      const prekey = checkPrekey(c.user, dev.d, dev.dsk, d.prekey, 1);
      checkBackup(d.backup, list.aik);
      const meta = metaOk(d.meta);
      const old = devicesOf(c.user).map((r) => r.id);
      db.tx(() => {
        for (const x of old) {
          db.run("UPDATE e2ee_devices SET state = 'removed', expires = NULL WHERE id = ?", x);
          db.run('DELETE FROM e2ee_prekeys WHERE device = ?', x);
          db.run('DELETE FROM e2ee_asb_boxes WHERE device = ?', x);
        }
        db.run("UPDATE e2ee_links SET state = 'cancelled' WHERE user = ? AND state IN ('open', 'proved', 'approved')", c.user);
        insertDevice(c.user, dev, 'trusted', sessionOf(c));
        addPrekey(dev.d, prekey);
        saveAccount(c.user, list, { reset: true });
        storeBackup(c.user, d.backup, list.aik);
        db.run('INSERT OR REPLACE INTO e2ee_meta (user, ver, blob, updated) VALUES (?, 1, ?, ?)', c.user, meta, now());
      });
      for (const ws of hub.socketsOf(c.user)) if (old.includes(ws.e2eeDevice)) ws.e2eeDevice = null;
      audit('e2ee.reset', c);
      devicesChanged(c.user);
      return { me: meView(c.user) };
    },
  };

  // Housekeeping, run by the server's minute sweep: requests and pending devices that ran out,
  // fetched-long-ago device keys.
  hub.e2ee = {
    on,
    sweep(t = now()) {
      for (const l of db.all("SELECT id, user, device FROM e2ee_links WHERE state IN ('open', 'proved') AND expires < ?", t)) {
        db.run("UPDATE e2ee_links SET state = 'expired' WHERE id = ?", l.id);
        sendTo(deviceSockets(l.user, l.device), 'e2ee.link.done', { linkId: l.id, state: 'expired' });
      }
      db.run("DELETE FROM e2ee_prekeys WHERE device IN (SELECT id FROM e2ee_devices WHERE state = 'pending' AND expires < ?)", t);
      db.run("DELETE FROM e2ee_devices WHERE state = 'pending' AND expires < ?", t);
      db.run('DELETE FROM e2ee_links WHERE expires < ?', t - 86_400_000);
      db.run('DELETE FROM e2ee_asb_boxes WHERE created < ?', t - ASB_BOX_DAYS * 86_400_000);
      conv.sweep(t);
    },
    meView,
    prekeyMaxAge: PREKEY_MAX_AGE,
  };
  conv = createE2eeConv({ db, M, hub, fail, ops: all, on, verifyEd, account, deviceRow });
  hub.e2ee.conv = conv;
  return { ...ops, ...conv.ops };
}

export { parseCanon };
