// End-to-end encrypted conversations on the real server (spec sections 7, 8,
// 10, 15 and 16): what the server enforces, what it stores, and what it hands
// to each socket. Clients seal and open with the real js/lib/e2ee modules
// (tests/helpers/e2ee.js). Includes the canary: a sent marker text and picture
// never reach the database, its WAL or the files folder in readable form.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/index.js';
import {
  Sock, register, web, newDevice, setupPayload, bind, login, nextPrekey, nextList, deviceEntry, devicePublic,
  recipientsFor, sealFrom, openAs, b64u, b64uOf, random,
} from './helpers/e2ee.js';
import { encryptFile, decryptFile } from '../js/lib/e2ee/attach.js';

const dirs = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'snug-e2ee-conv-')); dirs.push(d); return d; };
let srv, dataDir;
test.before(async () => { dataDir = tmp(); srv = await startServer({ port: 0, dataDir, quiet: true, e2ee: true, pushAllowLocal: true }); });
test.beforeEach(() => srv.resetLimits());
test.after(async () => { await srv.close(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const ALPHA = 'abcdefghijklmnopqrstuvwxyz0123456789';
const mid = () => `m_${[...random(16)].map((b) => ALPHA[b % 36]).join('')}`;
const RELOAD = /end-to-end encrypted\. Reload Snug/;

async function person(handle) {
  const p = await register(srv, handle);
  p.sock = await new Sock(srv, p.cookie).connect();
  return p;
}
async function enrol(p, opts) {
  p.dev = await newDevice(p.id);
  const { acct, payload } = await setupPayload(p.id, p.dev, opts);
  p.acct = acct;
  await p.sock.ok('e2ee.setup', payload);
  await bind(p.sock, p.dev);
  return p;
}
const enrolled = async (handle, opts) => enrol(await person(handle), opts);
async function friends(a, b) {
  await a.sock.ok('friend.request', { handle: b.handle });
  await b.sock.ok('friend.accept', { user: a.id });
}
const dsk = (p) => b64uOf(p.dev.dskPub, 32);
// Send an encrypted message as p into place (a DM or a thread under one).
async function sendEnc(p, { dm, place = dm, users, text, id = mid(), files = [], body = {}, ...rest }) {
  const { e2ee } = await sealFrom(p, { conv: dm, place, id, users, body: { text, ...body }, ...rest });
  return { id, ack: await p.sock.op('msg.send', { conv: place, id, text: '', files, e2ee, replyTo: rest.re || undefined }), e2ee };
}
async function pair(prefix) {
  const a = await enrolled(`${prefix}-a`);
  const b = await enrolled(`${prefix}-b`);
  await friends(a, b);
  const { id: dm } = await a.sock.ok('dm.open', { users: [b.id] });
  return { a, b, dm };
}
const close = async (...ps) => { for (const p of ps) await p.sock.close(); };

test('a DM between two people with encryption on is created encrypted, says so, and refuses plain text', async () => {
  const { a, b, dm } = await pair('ec-new');
  const row = srv.db.get('SELECT e2ee, e2ee_since FROM dms WHERE id = ?', dm);
  assert.equal(row.e2ee, 1);
  const ev = await b.sock.next('dm', (d) => d.dm.id === dm && d.dm.e2ee);
  assert.equal(ev.dm.e2ee, true, 'the dm view says it is encrypted');
  // A plaintext send (a stale tab, an old bundle, a downgrade) is refused with the reload message.
  await a.sock.refused('msg.send', { conv: dm, id: mid(), text: 'hello in the clear' }, RELOAD);
  await a.sock.refused('msg.send', { conv: dm, id: mid(), text: 'both', e2ee: (await sealFrom(a, { conv: dm, id: mid(), users: [a.id, b.id] })).e2ee }, RELOAD);
  await close(a, b);
});

test('an encrypted message is stored with no text, and each socket gets only its own wraps', async () => {
  const { a, b, dm } = await pair('ec-send');
  const other = await new Sock(srv, b.cookie).connect(); // b's second tab, not bound to a device
  const { id, ack } = await sendEnc(a, { dm, users: [a.id, b.id], text: 'see you at six' });
  assert.equal(ack.ok, true, ack.error);
  const row = srv.db.get('SELECT text, fold, enc, ping, files FROM messages WHERE id = ?', id);
  assert.deepEqual([row.text, row.fold, row.files], ['', '', null]);
  assert.ok(row.enc && !row.enc.includes('see you'));
  assert.ok(ack.d.m.e2ee, 'the sender gets the envelope back');
  const got = await b.sock.next('msg', (d) => d.m.id === id);
  assert.equal(got.m.text, '');
  assert.deepEqual(Object.keys(got.m.k).sort(), [`a:${b.id}:1`, `d:${b.dev.d}`], 'only this device and its own history key');
  const opened = await openAs(b, got.m, { conv: dm, senderDsk: dsk(a) });
  assert.equal(opened.body.text, 'see you at six');
  // Through the history wrap alone (a new device of b's would use this).
  const viaHistory = await openAs(b, got.m, { conv: dm, senderDsk: dsk(a), wraps: { [`a:${b.id}:1`]: got.m.k[`a:${b.id}:1`] } });
  assert.equal(viaHistory.body.text, 'see you at six');
  const unbound = await other.next('msg', (d) => d.m.id === id);
  assert.equal(unbound.m.k, undefined, 'a socket bound to no device gets no wraps');
  // History, snapshot and the wraps op: wraps come only from e2ee.wraps, per device.
  const hist = await b.sock.ok('history', { conv: dm });
  const h = hist.msgs.find((m) => m.id === id);
  assert.ok(h.e2ee && !h.k);
  const w = await b.sock.ok('e2ee.wraps', { ids: [id] });
  assert.deepEqual(Object.keys(w.wraps[id].k).sort(), [`a:${b.id}:1`, `d:${b.dev.d}`]);
  assert.equal((await other.ok('e2ee.wraps', { ids: [id] })).wraps[id]?.k?.[`d:${b.dev.d}`], undefined, 'an unbound socket gets no device wraps');
  // A retry with the same id returns the stored message once.
  const again = await a.sock.op('msg.send', { conv: dm, id, text: '', e2ee: ack.d.m.e2ee });
  assert.equal(again.ok, true);
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM messages WHERE id = ?', id).n, 1);
  await other.close(); await close(a, b);
});

test('the server refuses envelopes that are wrong: device, binding, signature, time, recipients', async () => {
  const { a, b, dm } = await pair('ec-bad');
  const users = [a.id, b.id];
  const rc = await recipientsFor(a.sock, users);
  const send = async (e2ee, id) => a.sock.op('msg.send', { conv: dm, id, text: '', e2ee });
  // Another conversation or message id in the header.
  let id = mid();
  let s = await sealFrom(a, { conv: dm, id: mid(), users, recipients: rc });
  assert.match((await send(s.e2ee, id)).error, /doesn’t match/);
  // A bad signature.
  id = mid();
  s = await sealFrom(a, { conv: dm, id, users, recipients: rc });
  assert.match((await send({ ...s.e2ee, sig: b64u(random(64)) }, id)).error, /signature/);
  // An old timestamp.
  id = mid();
  s = await sealFrom(a, { conv: dm, id, users, recipients: rc, ts: Date.now() - 30 * 60_000 });
  assert.match((await send(s.e2ee, id)).error, /clock/);
  // Missing b's device: e2ee_stale names b with the version to fetch.
  id = mid();
  s = await sealFrom(a, { conv: dm, id, users, recipients: { ...rc, to: rc.to.filter(([u]) => u !== b.id) } });
  const stale = await send(s.e2ee, id);
  assert.equal(stale.code, 'e2ee_stale');
  assert.deepEqual(Object.keys(stale.data.users), [b.id]);
  assert.equal(srv.db.get('SELECT 1 FROM messages WHERE id = ?', id), undefined, 'nothing stored');
  // A wrap to someone who isn't a member.
  const x = await enrolled('ec-bad-x');
  await friends(a, x);
  const rx = await recipientsFor(a.sock, [x.id]);
  s = await sealFrom(a, { conv: dm, id, users, recipients: { to: [...rc.to, ...rx.to], ar: rc.ar, lv: rc.lv } });
  assert.equal((await send(s.e2ee, id)).code, 'e2ee_stale');
  // Then the right recipients with the same id succeed, once.
  s = await sealFrom(a, { conv: dm, id, users, recipients: rc });
  assert.equal((await send(s.e2ee, id)).ok, true);
  // Sent from a socket not bound to the device named in the header.
  const unbound = await new Sock(srv, a.cookie).connect();
  const id2 = mid();
  s = await sealFrom(a, { conv: dm, id: id2, users, recipients: rc });
  const r = await unbound.op('msg.send', { conv: dm, id: id2, text: '', e2ee: s.e2ee });
  assert.match(r.error, /device/);
  // Wraps that don't match the header.
  const id3 = mid();
  s = await sealFrom(a, { conv: dm, id: id3, users, recipients: rc });
  const k = { ...s.e2ee.k };
  delete k[`d:${b.dev.d}`];
  assert.match((await send({ ...s.e2ee, k }, id3)).error, /keys/);
  await unbound.close(); await close(a, b, x);
});

test('a device added later: a sender with the old list gets e2ee_stale, refetches and gets through', async () => {
  const { a, b, dm } = await pair('ec-stale');
  const old = await recipientsFor(a.sock, [a.id, b.id]);
  // b adds a second device (server steps of the link flow).
  const b2 = await new Sock(srv, await login(srv, b.handle)).connect();
  const dev = await newDevice(b.id);
  const { linkId } = await b2.ok('e2ee.link.start', { device: devicePublic(dev), prekey: dev.prekeys[1].signed });
  await bind(b2, dev);
  await b2.ok('e2ee.link.proof', { linkId, tag1: b64u(random(32)) });
  const list = await nextList(b.acct, (cur) => ({ devs: [...cur.devs, deviceEntry(dev)] }));
  await b.sock.ok('e2ee.link.approve', { linkId, devlist: list, box: b64u(random(120)), tag2: b64u(random(32)) });
  await a.sock.next('e2ee.devices', (d) => d.user === b.id);
  const id = mid();
  let s = await sealFrom(a, { conv: dm, id, users: [a.id, b.id], recipients: old });
  const r = await a.sock.op('msg.send', { conv: dm, id, text: '', e2ee: s.e2ee });
  assert.equal(r.code, 'e2ee_stale');
  s = await sealFrom(a, { conv: dm, id, users: [a.id, b.id] });
  assert.equal((await a.sock.op('msg.send', { conv: dm, id, text: '', e2ee: s.e2ee })).ok, true);
  const got = await b2.next('msg', (d) => d.m.id === id);
  assert.ok(got.m.k[`d:${dev.d}`], 'the new device has its own wrap');
  await b2.close(); await close(a, b);
});

test('existing DMs upgrade when the last person turns encryption on; earlier messages are marked legacy', async () => {
  const a = await enrolled('ec-up-a');
  const b = await person('ec-up-b');
  await friends(a, b);
  const { id: dm } = await a.sock.ok('dm.open', { users: [b.id] });
  assert.equal(srv.db.get('SELECT e2ee FROM dms WHERE id = ?', dm).e2ee, null, 'not everyone is ready');
  const old = mid();
  await a.sock.ok('msg.send', { conv: dm, id: old, text: 'from before' });
  await enrol(b);
  const row = srv.db.get('SELECT e2ee, e2ee_since FROM dms WHERE id = ?', dm);
  assert.equal(row.e2ee, 1);
  const line = await a.sock.next('msg', (d) => d.conv === dm && d.m.dmLine?.act === 'e2ee');
  assert.equal(line.m.dmLine.legacy, true, 'the line knows earlier messages exist');
  const hist = await b.sock.ok('history', { conv: dm });
  assert.equal(hist.msgs.find((m) => m.id === old).legacy, true);
  assert.equal(hist.msgs.find((m) => m.dmLine)?.legacy, undefined, 'the server line itself isn’t a legacy message');
  await a.sock.refused('msg.send', { conv: dm, id: mid(), text: 'plain again' }, RELOAD);
  await close(a, b);
});

test('threads under an encrypted DM are encrypted; the header keeps the thread and the DM apart', async () => {
  const { a, b, dm } = await pair('ec-thread');
  const { id: root } = await sendEnc(a, { dm, users: [a.id, b.id], text: 'root' });
  const t = `t:${root}`;
  await a.sock.refused('msg.send', { conv: t, id: mid(), text: 'plain reply' }, RELOAD);
  // Sealed for the DM but posted in the thread: refused.
  const id = mid();
  const wrongPlace = await sealFrom(b, { conv: dm, place: dm, id, users: [a.id, b.id] });
  assert.match((await b.sock.op('msg.send', { conv: t, id, text: '', e2ee: wrongPlace.e2ee })).error, /doesn’t match/);
  const { ack } = await sendEnc(b, { dm, place: t, id, users: [a.id, b.id], text: 'in the thread' });
  assert.equal(ack.ok, true, ack.error);
  const got = await a.sock.next('msg', (d) => d.m.id === id);
  assert.equal(got.conv, t);
  assert.equal((await openAs(a, got.m, { conv: dm, place: t, senderDsk: dsk(b) })).body.text, 'in the thread');
  await assert.rejects(openAs(a, got.m, { conv: dm, place: dm, senderDsk: dsk(b) }), /moved/);
  await close(a, b);
});

test('edits: a new envelope with rev + 1; the old one goes to the edit history; plain edits refused', async () => {
  const { a, b, dm } = await pair('ec-edit');
  const users = [a.id, b.id];
  const { id } = await sendEnc(a, { dm, users, text: 'first' });
  await a.sock.refused('msg.edit', { conv: dm, id, text: 'plain edit' }, RELOAD);
  const bad = await sealFrom(a, { conv: dm, id, users, kind: 'edit', rev: 2, body: { text: 'skip a rev' } });
  assert.match((await a.sock.op('msg.edit', { conv: dm, id, e2ee: bad.e2ee })).error, /doesn’t match/);
  const e = await sealFrom(a, { conv: dm, id, users, kind: 'edit', rev: 1, body: { text: 'second' } });
  assert.equal((await a.sock.op('msg.edit', { conv: dm, id, e2ee: e.e2ee })).ok, true);
  const got = await b.sock.next('msg', (d) => d.m.id === id && d.m.e2ee.h.rev === 1);
  assert.ok(got.m.edited);
  assert.equal((await openAs(b, got.m, { conv: dm, senderDsk: dsk(a) })).body.text, 'second');
  const hist = await b.sock.ok('msg.edits', { conv: dm, id });
  assert.equal(hist.current.e2ee.h.rev, 1);
  assert.equal(hist.edits.length, 1);
  assert.equal(hist.edits[0].e2ee.h.rev, 0);
  const w = await b.sock.ok('e2ee.wraps', { ids: [{ id, rev: 0 }] });
  const first = await openAs(b, { id, author: a.id, e2ee: hist.edits[0].e2ee }, { conv: dm, senderDsk: dsk(a), wraps: w.wraps[id].k });
  assert.equal(first.body.text, 'first');
  // Someone else can't edit it.
  const be = await sealFrom(b, { conv: dm, id, users, kind: 'edit', rev: 2, body: { text: 'not mine' } });
  assert.match((await b.sock.op('msg.edit', { conv: dm, id, e2ee: be.e2ee })).error, /your own/);
  await close(a, b);
});

test('server features in encrypted DMs: search finds nothing, push says "New message", ping drives mentions, polls, rolls and forwards are refused', async () => {
  const a = await enrolled('ec-feat-a');
  const b = await enrolled('ec-feat-b');
  const c = await enrolled('ec-feat-c');
  await friends(a, b); await friends(a, c); await friends(b, c);
  const { id: g } = await a.sock.ok('dm.open', { users: [b.id, c.id] });
  assert.equal(srv.db.get('SELECT e2ee FROM dms WHERE id = ?', g).e2ee, 1, 'a group of ready people is encrypted too');
  const users = [a.id, b.id, c.id].sort();
  const { id, ack } = await sendEnc(a, { dm: g, users, text: 'pancakes for @ec-feat-b', ping: [b.id] });
  assert.equal(ack.ok, true, ack.error);
  // Search on the server never matches encrypted rows.
  const hits = await b.sock.ok('search', { q: 'pancakes' });
  assert.equal(hits.hits.length, 0);
  const fromA = await b.sock.ok('search', { q: 'from:ec-feat-a' });
  assert.equal(fromA.hits.some((h) => h.m.id === id), false);
  // Push: the body never carries text; the declared mention makes it need b (a group set to mentions only).
  await b.sock.ok('notify.set', { kind: 'dm', id: g, level: 'mentions' });
  assert.equal(srv.push.wouldPush(b.id, id), true);
  assert.equal(srv.push.noteOf(b.id, id).body, 'New message');
  // c, also in "mentions only", isn't needed: c wasn't pinged.
  await c.sock.ok('notify.set', { kind: 'dm', id: g, level: 'mentions' });
  assert.equal(srv.push.wouldPush(c.id, id), false);
  const ml = await b.sock.ok('mentions.list', {});
  assert.ok(ml.items.some((it) => it.m.id === id), 'mentions.list finds it by its declared mention');
  // Pinging someone who isn't in the group is refused.
  const x = await enrolled('ec-feat-x');
  const bad = await sendEnc(a, { dm: g, users, text: 'hi', ping: [x.id] });
  assert.match(bad.ack.error, /mention/);
  // Polls, rolls and forwards of encrypted messages need plaintext on the server: refused.
  await a.sock.refused('poll.create', { conv: g, id: mid(), question: 'Lunch?', answers: [{ text: 'Yes' }, { text: 'No' }], hours: 1 }, /Polls aren’t available in encrypted/);
  await a.sock.refused('cmd.roll', { conv: g, id: mid(), spec: '1d6' }, /roll/i);
  const { id: other } = await a.sock.ok('dm.open', { users: [x.id] }).catch(() => ({ id: null }));
  await a.sock.refused('msg.forward', { conv: g, id, to: other || g, newId: mid() }, /forwarded from your device/);
  // No link preview work for empty text.
  await srv.hub.messaging.idle();
  assert.equal(srv.db.get('SELECT embeds FROM messages WHERE id = ?', id).embeds, null);
  await close(a, b, c, x);
});

test('dm.add: someone without encryption can’t join an encrypted group; a removed member gets nothing new', async () => {
  const a = await enrolled('ec-mem-a');
  const b = await enrolled('ec-mem-b');
  const c = await enrolled('ec-mem-c');
  const lou = await person('ec-mem-lou');
  for (const [x, y] of [[a, b], [a, c], [b, c], [a, lou]]) await friends(x, y);
  const { id: g } = await a.sock.ok('dm.open', { users: [b.id, c.id] });
  await a.sock.refused('dm.add', { dm: g, users: [lou.id] }, /needs to open an up-to-date Snug/);
  await a.sock.ok('dm.kick', { dm: g, user: c.id });
  // A sender still including c is told to refetch; without c it goes through and c's socket gets nothing.
  const withC = await recipientsFor(a.sock, [a.id, b.id, c.id]);
  const id = mid();
  let s = await sealFrom(a, { conv: g, id, users: [a.id, b.id, c.id], recipients: withC });
  assert.equal((await a.sock.op('msg.send', { conv: g, id, text: '', e2ee: s.e2ee })).code, 'e2ee_stale');
  s = await sealFrom(a, { conv: g, id, users: [a.id, b.id] });
  assert.equal((await a.sock.op('msg.send', { conv: g, id, text: '', e2ee: s.e2ee })).ok, true);
  await c.sock.none('msg', (d) => d.m?.id === id);
  assert.deepEqual((await c.sock.ok('e2ee.wraps', { ids: [id] })).wraps, {}, 'nothing for a conversation c can’t read');
  await close(a, b, c, lou);
});

test('P2P-shadow conversations never become encrypted', async () => {
  const a = await enrolled('ec-p2p-a');
  const t = Date.now();
  srv.db.run("INSERT INTO users (id, handle, name, pass, hue, created, remote) VALUES ('u_shadowp2p', 'shadow~p2p', 'Shadow', '!', 0, ?, 1)", t);
  srv.db.run("INSERT INTO dms (id, name, created) VALUES ('d_shadowp2p', NULL, ?)", t);
  srv.db.run("INSERT INTO dm_members (dm, user) VALUES ('d_shadowp2p', ?), ('d_shadowp2p', 'u_shadowp2p')", a.id);
  srv.db.run("INSERT INTO e2ee_accounts (user, aik, ver, list, sig, updated) VALUES ('u_shadowp2p', 'x', 1, '{}', 'x', ?)", t);
  await a.sock.ok('dm.encrypt', { dm: 'd_shadowp2p' }).catch(() => {});
  assert.equal(srv.db.get("SELECT e2ee FROM dms WHERE id = 'd_shadowp2p'").e2ee, null);
  await close(a);
});

test('deleted encrypted messages lose their envelope and wraps after the undo window', async () => {
  const { a, b, dm } = await pair('ec-del');
  const { id } = await sendEnc(a, { dm, users: [a.id, b.id], text: 'oops' });
  await a.sock.ok('msg.delete', { conv: dm, id });
  srv.hub.e2ee.sweep(Date.now() + 12 * 60_000);
  assert.deepEqual({ ...srv.db.get('SELECT enc, ping FROM messages WHERE id = ?', id) }, { enc: null, ping: null });
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM e2ee_wraps WHERE msg = ?', id).n, 0);
  await close(a, b);
});

test('canary: a sent marker text and picture never reach the database, its WAL or the files folder readable', async () => {
  const { a, b, dm } = await pair('ec-canary');
  const MARK = `CANARY-${b64u(random(9))}`;
  // A picture with a recognisable byte run, encrypted before upload.
  const pic = new Uint8Array(4096);
  pic.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const tag = new TextEncoder().encode(`PICTURE-${MARK}`);
  pic.set(tag, 100);
  const { ct, meta } = await encryptFile(pic);
  const base = web(srv).base;
  // A plain upload into an encrypted DM is refused; an encrypted one is stored as an opaque blob.
  const plain = await fetch(`${base}/api/files?conv=${dm}`, { method: 'POST', headers: { cookie: a.cookie, origin: base, 'content-type': 'image/png', 'x-file-name': 'p.png' }, body: pic });
  assert.equal(plain.status, 409);
  const up = await fetch(`${base}/api/files?conv=${dm}&enc=1`, { method: 'POST', headers: { cookie: a.cookie, origin: base, 'content-type': 'application/octet-stream', 'x-file-name': 'file' }, body: ct });
  assert.equal(up.status, 201, await up.clone().text());
  const file = await up.json();
  const { id, ack } = await sendEnc(a, {
    dm, users: [a.id, b.id], text: `the secret is ${MARK}`, files: [{ id: file.id }],
    body: { files: [{ id: file.id, ...meta, name: `${MARK}.png`, type: 'image/png', size: pic.length, w: 1, h: 1 }] },
  });
  assert.equal(ack.ok, true, ack.error);
  const got = await b.sock.next('msg', (d) => d.m.id === id);
  const opened = await openAs(b, got.m, { conv: dm, senderDsk: dsk(a) });
  assert.equal(opened.body.text, `the secret is ${MARK}`);
  // The download is an opaque attachment; it opens with the key from the message.
  const res = await fetch(`${base}/api/files/${file.id}`, { headers: { cookie: b.cookie } });
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.match(res.headers.get('content-disposition'), /^attachment/);
  const back = await decryptFile(new Uint8Array(await res.arrayBuffer()), opened.body.files[0]);
  assert.deepEqual([...back.slice(100, 100 + tag.length)], [...tag]);
  // Scan: rows, raw database and WAL bytes, every file stored.
  const needles = [MARK, `PICTURE-${MARK}`].map((s) => Buffer.from(s));
  const rows = JSON.stringify([srv.db.all('SELECT * FROM messages'), srv.db.all('SELECT * FROM files'), srv.db.all('SELECT * FROM e2ee_wraps')]);
  assert.equal(rows.includes(MARK), false, 'no row holds the marker');
  srv.db.run('PRAGMA wal_checkpoint(PASSIVE)');
  for (const f of ['snug.db', 'snug.db-wal']) {
    const p = join(dataDir, f);
    if (!existsSync(p)) continue;
    const bytes = readFileSync(p);
    for (const n of needles) assert.equal(bytes.includes(n), false, `${f} holds the marker`);
  }
  const filesDir = join(dataDir, 'files');
  for (const f of readdirSync(filesDir)) {
    const bytes = readFileSync(join(filesDir, f));
    for (const n of [...needles, Buffer.from(tag)]) assert.equal(bytes.includes(n), false, `files/${f} holds the marker`);
    assert.notDeepEqual([...bytes.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'no PNG stored readable');
  }
  await close(a, b);
});

test('a prekey rotation is fine for an hour: a message sealed to the previous prekey is accepted', async () => {
  const { a, b, dm } = await pair('ec-rot');
  const old = await recipientsFor(a.sock, [a.id, b.id]);
  await b.sock.ok('e2ee.prekey', { prekey: await nextPrekey(b.dev) });
  const { id, e2ee } = await sendEnc(a, { dm, users: [a.id, b.id], text: 'sealed to the old key', recipients: old });
  assert.ok(e2ee);
  const got = await b.sock.next('msg', (d) => d.m.id === id);
  assert.equal((await openAs(b, got.m, { conv: dm, senderDsk: dsk(a) })).body.text, 'sealed to the old key');
  await close(a, b);
});
