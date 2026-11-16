// 0.14: less metadata in encrypted conversations, on the real server. Device
// features signed by each device; sealed reactions, poll votes and a poll's end;
// a group's name and icon sealed to its members; reply targets inside the sealed
// body; padded attachments; push notes without group names; and the list of what
// the server still sees, as /api/privacy reports it. Clients seal and open with
// the real js/lib/e2ee modules (tests/helpers/e2ee.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startServer } from '../server/index.js';
import {
  Sock, register, newDevice, setupPayload, bind, recipientsFor, sealFrom, openAs, b64uOf, random, obj,
} from './helpers/e2ee.js';
import { encryptFile, decryptFile, padBucket, padBuckets, TAG } from '../js/lib/e2ee/attach.js';

const dirs = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'snug-e2ee-meta-')); dirs.push(d); return d; };
let srv, dataDir;
test.before(async () => { dataDir = tmp(); srv = await startServer({ port: 0, dataDir, quiet: true, e2ee: true, pushAllowLocal: true }); });
test.beforeEach(() => srv.resetLimits());
test.after(async () => { await srv.close(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const ALPHA = 'abcdefghijklmnopqrstuvwxyz0123456789';
const mid = () => `m_${[...random(16)].map((b) => ALPHA[b % 36]).join('')}`;
const dsk = (p) => b64uOf(p.dev.dskPub, 32);

async function enrolled(handle, { caps = obj.FEATURES, on = srv } = {}) {
  const p = await register(on, handle);
  p.sock = await new Sock(on, p.cookie).connect();
  p.dev = await newDevice(p.id);
  const { acct, payload } = await setupPayload(p.id, p.dev);
  p.acct = acct;
  await p.sock.ok('e2ee.setup', payload);
  await bind(p.sock, p.dev);
  if (caps) await p.sock.ok('e2ee.caps', { caps: await obj.makeCaps(p.dev.dsk.privateKey, { u: p.id, d: p.dev.d, caps }) });
  return p;
}
async function friends(a, b) {
  await a.sock.ok('friend.request', { handle: b.handle });
  await b.sock.ok('friend.accept', { user: a.id });
}
async function group(prefix, opts = []) {
  const ps = [];
  for (let i = 0; i < 3; i++) ps.push(await enrolled(`${prefix}-${i}`, opts[i]));
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) await friends(ps[i], ps[j]);
  const { id: g } = await ps[0].sock.ok('dm.open', { users: [ps[1].id, ps[2].id] });
  return { ps, g, users: ps.map((p) => p.id).sort() };
}
async function sendEnc(p, { dm, place = dm, users, text = '', id = mid(), body = {}, extra = {}, ...rest }) {
  const { e2ee } = await sealFrom(p, { conv: dm, place, id, users, body: { text, ...body }, ...rest });
  return { id, ack: await p.sock.op('msg.send', { conv: place, id, text: '', e2ee, ...extra }) };
}
// A side blob (react, vote, end) from p on message msg.
async function side(p, { dm, place = dm, users, msg, slot, body, rev = 0 }) {
  const kind = slot === 'react' ? 'react' : 'vote';
  const id = `${slot}:${msg}:${p.id}`;
  const { e2ee } = await sealFrom(p, { conv: dm, place, id, users, kind, rev, body: { text: '', target: msg, ...body } });
  return p.sock.op('e2ee.side', { conv: place, msg, slot, e2ee });
}
const openSide = (p, author, s, dm) => openAs(p, { id: s.e2ee.h.id, author: author.id, e2ee: s.e2ee, k: s.k }, { conv: dm, senderDsk: dsk(author) });
const dbText = () => {
  srv.db.run('PRAGMA wal_checkpoint(TRUNCATE)');
  return readdirSync(dataDir).filter((f) => f.startsWith('snug.db')).map((f) => readFileSync(join(dataDir, f)).toString('latin1')).join('\n');
};
const close = async (ps) => { for (const p of ps) await p.sock.close(); };

test('device features: signed by the device, refused when forged or for another device, handed out with bundles', async () => {
  const a = await enrolled('fx-a', { caps: null });
  const b = await enrolled('fx-b');
  await friends(a, b);
  // Signed by another key: refused. For another device id: refused.
  const other = await newDevice(a.id);
  await a.sock.refused('e2ee.caps', { caps: await obj.makeCaps(other.dsk.privateKey, { u: a.id, d: a.dev.d }) }, /signature/);
  await a.sock.refused('e2ee.caps', { caps: await obj.makeCaps(a.dev.dsk.privateKey, { u: a.id, d: other.d }) }, /aren’t valid/);
  const signed = await obj.makeCaps(a.dev.dsk.privateKey, { u: a.id, d: a.dev.d, caps: ['react', 'poll'] });
  assert.deepEqual((await a.sock.ok('e2ee.caps', { caps: signed })).caps, ['poll', 'react']);
  // The bundle carries the signed object; a client checks it against the device's key from the signed list.
  const r = await b.sock.ok('e2ee.bundles', { users: [a.id] });
  const got = r.users[a.id].caps[a.dev.d];
  assert.deepEqual(await obj.verifyCaps(got, { u: a.id, d: a.dev.d, dsk: a.dev.dskPub }), ['poll', 'react']);
  assert.equal(await obj.verifyCaps({ ...got, caps: [...obj.FEATURES].sort() }, { u: a.id, d: a.dev.d, dsk: a.dev.dskPub }), null, 'a feature added on the way fails the signature');
  // An older object can't replace a newer one; the bind answer says what is stored.
  await a.sock.refused('e2ee.caps', { caps: await obj.makeCaps(a.dev.dsk.privateKey, { u: a.id, d: a.dev.d, ts: Date.now() - 60_000 }) }, /older/);
  const again = await new Sock(srv, a.cookie).connect();
  assert.deepEqual((await bind(again, a.dev)).caps, ['poll', 'react']);
  await again.close(); await close([a, b]);
});

test('E1 sealed reactions: stored as opaque envelopes, each socket gets its own wraps, counts open on both sides, no emoji in the database', async () => {
  const { ps: [a, b, c], g, users } = await group('rx');
  const { id, ack } = await sendEnc(a, { dm: g, users, text: 'pottery night?' });
  assert.equal(ack.ok, true, ack.error);
  // Every device can seal reactions: a plain one is refused (an older Snug), taking one back isn't.
  await b.sock.refused('react', { conv: g, id, emoji: '🍕', on: true }, /Reactions in this conversation are encrypted\. Update Snug/);
  assert.equal((await b.sock.op('react', { conv: g, id, emoji: '🍕', on: false })).ok, true);
  // b reacts with two emoji in one sealed blob; c with one.
  const rb = await side(b, { dm: g, users, msg: id, slot: 'react', body: { emojis: ['🫖', '🎉'] } });
  assert.equal(rb.ok, true, rb.error);
  assert.equal((await side(c, { dm: g, users, msg: id, slot: 'react', body: { emojis: ['🫖'] } })).ok, true);
  const ev = await a.sock.next('e2ee.side', (d) => d.msg === id && d.user === b.id);
  assert.deepEqual(Object.keys(ev.k).sort(), [`a:${a.id}:1`, `d:${a.dev.d}`], 'only a’s device and history wraps');
  assert.deepEqual((await openSide(a, b, ev, g)).body.emojis, ['🫖', '🎉']);
  // History carries the envelopes (no emoji); e2ee.wraps hands out the wraps for them.
  const hist = await a.sock.ok('history', { conv: g });
  const m = hist.msgs.find((x) => x.id === id);
  assert.equal(m.reactions, undefined, 'no readable reactions');
  assert.deepEqual(m.side.map((s) => [s.user, s.slot]).sort(), [[b.id, 'react'], [c.id, 'react']].sort());
  const w = await a.sock.ok('e2ee.wraps', { ids: m.side.map((s) => ({ id: s.e2ee.h.id, rev: s.e2ee.h.rev })) });
  const counts = {};
  for (const s of m.side) {
    const o = await openSide(a, [b, c].find((p) => p.id === s.user), { e2ee: s.e2ee, k: w.revs[`${s.e2ee.h.id}:${s.e2ee.h.rev}`].k }, g);
    for (const e of o.body.emojis) counts[e] = (counts[e] || 0) + 1;
  }
  assert.deepEqual(counts, { '🫖': 2, '🎉': 1 });
  // A replay of an older revision, or another person's slot, is refused.
  assert.equal((await side(b, { dm: g, users, msg: id, slot: 'react', body: { emojis: [] } })).code, 'e2ee_side_rev');
  assert.equal((await side(b, { dm: g, users, msg: id, slot: 'react', body: { emojis: [] }, rev: 1 })).ok, true);
  const forged = await sealFrom(b, { conv: g, id: `react:${id}:${c.id}`, users, kind: 'react', rev: 5, body: { text: '', target: id, emojis: ['💀'] } });
  assert.match((await b.sock.op('e2ee.side', { conv: g, msg: id, slot: 'react', e2ee: forged.e2ee })).error, /doesn’t match/);
  // Someone outside the group gets no wraps for it.
  const x = await enrolled('rx-x');
  assert.deepEqual((await x.sock.ok('e2ee.wraps', { ids: [m.side[0].e2ee.h.id] })).wraps, {});
  // The database never holds the emoji.
  const raw = dbText();
  for (const e of ['🫖', '🎉', Buffer.from('🫖').toString('latin1')]) assert.equal(raw.includes(e), false, `no ${e} on the server`);
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM reactions WHERE msg = ?', id).n, 0);
  await close([a, b, c, x]);
});

test('E1: while one device can’t seal reactions, plain reactions still work there (older Snug keeps working)', async () => {
  const { ps: [a, b, c], g, users } = await group('rx-old', [{}, {}, { caps: null }]);
  const { id } = await sendEnc(a, { dm: g, users, text: 'hello' });
  assert.equal((await b.sock.op('react', { conv: g, id, emoji: '🍕', on: true })).ok, true);
  await close([a, b, c]);
});

test('E2 private room information: the name and icon are sealed to members, the server keeps none, rename lines carry no name, a new member gets the latest', async () => {
  const { ps: [a, b, c], g, users } = await group('info');
  const info = async (p, body, rev, what = 'name', us = users) => {
    const { e2ee } = await sealFrom(p, { conv: g, id: `info:${g}`, users: us, kind: 'info', rev, body: { text: '', ...body } });
    return p.sock.op('e2ee.info', { dm: g, what, e2ee });
  };
  const r = await info(a, { name: 'Glaze Club Secret', icon: '🏺', hue: 30, rev: 0 }, 0);
  assert.equal(r.ok, true, r.error);
  const row = srv.db.get('SELECT name, icon, icon_hue, info_enc FROM dms WHERE id = ?', g);
  assert.deepEqual([row.name, row.icon, row.icon_hue], [null, null, null]);
  assert.ok(row.info_enc && !row.info_enc.includes('Glaze'));
  // The line says who renamed it, not to what.
  const line = srv.db.get("SELECT text, sys FROM messages WHERE conv = ? AND sys LIKE '%\"act\":\"info\"%' ORDER BY seq DESC LIMIT 1", g);
  assert.match(line.text, /renamed the group$/);
  assert.equal(line.sys.includes('Glaze'), false);
  // b's dm view carries the sealed information and its own wraps; it opens to the name.
  const ev = await b.sock.next('dm', (d) => d.dm.id === g && d.dm.info);
  assert.equal(ev.dm.name, 'Encrypted group', 'what an older Snug shows');
  const opened = await openAs(b, { id: `info:${g}`, author: a.id, e2ee: ev.dm.info.e2ee, k: ev.dm.info.k }, { conv: g, senderDsk: dsk(a) });
  assert.equal(opened.body.name, 'Glaze Club Secret');
  // A plain rename or icon from an older Snug is refused now.
  await c.sock.refused('dm.rename', { dm: g, name: 'Plain' }, /encrypted\. Update Snug/);
  await c.sock.refused('dm.icon', { dm: g, emoji: '🐸' }, /encrypted\. Update Snug/);
  // Push and ring notes don't name the group.
  const { id: msgId } = await sendEnc(a, { dm: g, users, text: 'x' });
  const note = srv.push.noteOf(b.id, msgId);
  assert.equal(JSON.stringify(note).includes('Glaze'), false);
  assert.equal(note.title, 'info-0', 'only the sender’s name');
  assert.equal(srv.push.ringNoteOf(b.id, { from: a.id, dm: g, group: true, call: 'c1' }).body, 'Voice call in your group');
  // Someone added: a member seals the latest revision again for the new member set; they open it.
  const d = await enrolled('info-d');
  await friends(a, d);
  await a.sock.ok('dm.add', { dm: g, users: [d.id] });
  const all4 = [...users, d.id].sort();
  assert.equal((await info(a, { name: 'Glaze Club Secret', icon: '🏺', hue: 30, rev: 1 }, 1, 'members', all4)).ok, true);
  const w = await d.sock.ok('e2ee.wraps', { ids: [`info:${g}`] });
  const env = srv.db.get('SELECT info_enc FROM dms WHERE id = ?', g).info_enc;
  const got = await openAs(d, { id: `info:${g}`, author: a.id, e2ee: JSON.parse(env), k: w.wraps[`info:${g}`].k }, { conv: g, senderDsk: dsk(a) });
  assert.equal(got.body.name, 'Glaze Club Secret');
  // Someone whose devices can't open it can't be added.
  const old = await enrolled('info-old', { caps: null });
  await friends(a, old);
  await a.sock.refused('dm.add', { dm: g, users: [old.id] }, /info-old’s Test browser/);
  assert.equal(dbText().includes('Glaze Club Secret'), false, 'the name never reached the database');
  await close([a, b, c, d, old]);
});

test('E3 encrypted polls: refused naming older devices; votes and the end are sealed; counts agree for all three; the server has no question or answers', async () => {
  const mixed = await group('poll-old', [{}, {}, { caps: ['react'] }]);
  const p0 = mixed.ps[0];
  const refused = await sendEnc(p0, { dm: mixed.g, users: mixed.users, body: { poll: { question: 'Kiln day?', answers: [{ text: 'Sat' }, { text: 'Sun' }], multi: false, ends: Date.now() + 3600e3 } }, extra: { poll: true } });
  assert.equal(refused.ack.ok, false);
  assert.match(refused.ack.error, /Still on an older Snug: poll-old-2’s Test browser/);
  await close(mixed.ps);

  const { ps: [a, b, c], g, users } = await group('poll');
  const ends = Date.now() + 3600e3;
  const { id, ack } = await sendEnc(a, { dm: g, users, body: { poll: { question: 'Which glaze for the Kiln?', answers: [{ text: 'Celadon' }, { text: 'Tenmoku' }], multi: false, ends } }, extra: { poll: true } });
  assert.equal(ack.ok, true, ack.error);
  assert.equal((await side(b, { dm: g, users, msg: id, slot: 'vote', body: { choices: [1] } })).ok, true);
  assert.equal((await side(c, { dm: g, users, msg: id, slot: 'vote', body: { choices: [0] } })).ok, true);
  // c changes their vote: the newer revision replaces the older one.
  assert.equal((await side(c, { dm: g, users, msg: id, slot: 'vote', body: { choices: [1] }, rev: 1 })).ok, true);
  // Only the author can end it.
  assert.match((await side(b, { dm: g, users, msg: id, slot: 'end', body: { end: true } })).error, /Only the person who started/);
  assert.equal((await side(a, { dm: g, users, msg: id, slot: 'end', body: { end: true } })).ok, true);
  // Each of the three counts from the envelopes alone.
  for (const p of [a, b, c]) {
    const m = (await p.sock.ok('history', { conv: g })).msgs.find((x) => x.id === id);
    const w = await p.sock.ok('e2ee.wraps', { ids: [{ id, rev: 0 }, ...m.side.map((s) => ({ id: s.e2ee.h.id, rev: s.e2ee.h.rev }))] });
    const poll = (await openAs(p, { ...m, k: w.revs[`${id}:0`].k }, { conv: g, senderDsk: dsk(a) })).body.poll;
    const counts = poll.answers.map(() => 0);
    let ended = false;
    for (const s of m.side) {
      const author = [a, b, c].find((x) => x.id === s.user);
      const o = await openSide(p, author, { e2ee: s.e2ee, k: w.revs[`${s.e2ee.h.id}:${s.e2ee.h.rev}`].k }, g);
      if (s.slot === 'vote') for (const i of o.body.choices) counts[i]++;
      if (s.slot === 'end' && s.user === m.author) ended = true;
    }
    assert.deepEqual([counts, ended], [[0, 2], true], `${p.handle} counts`);
  }
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM polls WHERE msg = ?', id).n, 0);
  const raw = dbText();
  for (const s of ['Which glaze', 'Celadon', 'Tenmoku']) assert.equal(raw.includes(s), false, `no "${s}" on the server`);
  await close([a, b, c]);
});

test('E4 reply targets: inside the sealed body where every device can read them; a plain replyTo is refused there; thread replies keep their root', async () => {
  const { ps: [a, b, c], g, users } = await group('re');
  const { id: first } = await sendEnc(a, { dm: g, users, text: 'first' });
  const plain = await sendEnc(b, { dm: g, users, text: 'answer', re: first, extra: { replyTo: first } });
  assert.match(plain.ack.error, /Replies in this conversation are encrypted/);
  const sealed = await sendEnc(b, { dm: g, users, text: 'answer', body: { re: first }, ping: [a.id] });
  assert.equal(sealed.ack.ok, true, sealed.ack.error);
  assert.equal(srv.db.get('SELECT reply_to FROM messages WHERE id = ?', sealed.id).reply_to, null, 'the server row has no reply link');
  const got = await a.sock.next('msg', (d) => d.m.id === sealed.id);
  const opened = await openAs(a, got.m, { conv: g, senderDsk: dsk(b) });
  assert.equal(opened.body.re, first);
  assert.equal(got.m.replyTo, undefined);
  // A thread still hangs off its root (the conversation id names it).
  const t = await sendEnc(c, { dm: g, place: `t:${first}`, users, text: 'in a thread' });
  assert.equal(t.ack.ok, true, t.ack.error);
  await close([a, b, c]);
});

test('E5 padded attachments: sizes fall into buckets, the file opens byte for byte, and files sealed before still open', async () => {
  for (const n of [0, 1, 4090, 4091, 5000, 65_531, 65_532, 100_000, 1_000_000, 3_333_333]) {
    const bytes = new Uint8Array(randomBytes(n));
    const { ct, meta } = await encryptFile(bytes, { pad: true });
    assert.equal(meta.p, 1);
    assert.equal(ct.length - TAG, padBucket(n + 5), `size ${n}`);
    assert.ok(padBuckets(8 * 1024 * 1024).includes(ct.length - TAG));
    assert.deepEqual(await decryptFile(ct, meta), bytes);
  }
  // Overhead stays under a quarter past 64 KiB.
  for (const n of [70_000, 500_000, 9_000_000]) assert.ok(padBucket(n) < n * 1.25 + 4096);
  // An unpadded file (0.12/0.13) opens as before; a padded one with its marker removed doesn't pass as one.
  const old = await encryptFile(new Uint8Array([1, 2, 3]));
  assert.equal(old.meta.p, undefined);
  assert.deepEqual([...(await decryptFile(old.ct, old.meta))], [1, 2, 3]);
  const p = await encryptFile(new Uint8Array([9, 9]), { pad: true });
  const raw = await decryptFile(p.ct, { ...p.meta, p: undefined });
  assert.equal(raw.length, 4096, 'without the marker it is just the padded bytes, never mistaken for the file');
  // On the server: what an upload stores is the padded size.
  const a = await enrolled('pad-a');
  const b = await enrolled('pad-b');
  await friends(a, b);
  const { id: dm } = await a.sock.ok('dm.open', { users: [b.id] });
  const f = await encryptFile(new Uint8Array(randomBytes(12_345)), { pad: true });
  const res = await fetch(`http://127.0.0.1:${srv.port}/api/files?conv=${dm}&enc=1`, { method: 'POST', headers: { cookie: a.cookie, origin: `http://127.0.0.1:${srv.port}`, 'content-type': 'application/octet-stream', 'x-file-name': 'file' }, body: f.ct });
  assert.equal(res.status, 201, await res.clone().text());
  const row = srv.db.get('SELECT size, name, type FROM files WHERE id = ?', (await res.json()).id);
  assert.deepEqual({ ...row }, { size: 16_384 + TAG, name: 'file', type: 'application/octet-stream' });
  await close([a, b]);
});

test('E5: padding never takes a file past the server’s limit (a file just under it still uploads)', async () => {
  const MB = 1024 * 1024;
  // The default 100 MB server: a 90 MB file would pad to 103.4 MB; it pads to the limit instead.
  assert.ok(padBucket(90 * MB + 5) > 100 * MB);
  const big = await encryptFile(new Uint8Array(90 * MB), { pad: true, max: 100 * MB });
  assert.equal(big.meta.p, 1);
  assert.equal(big.ct.length, 100 * MB + TAG);
  assert.equal((await decryptFile(big.ct, big.meta)).length, 90 * MB);
  // Too close to the limit for the 5-byte header: sealed as it is (no padding), still within the limit.
  const edge = await encryptFile(new Uint8Array(100 * MB - 2), { pad: true, max: 100 * MB });
  assert.equal(edge.meta.p, undefined);
  assert.equal(edge.ct.length, 100 * MB - 2 + TAG);
  // Small files keep their size step.
  const small = await encryptFile(new Uint8Array(5000), { pad: true, max: 100 * MB });
  assert.equal(small.ct.length, padBucket(5005) + TAG);
  // On a server with a 1 MB limit, a file just under it uploads padded (to the limit, plus the tag).
  const s = await startServer({ port: 0, dataDir: tmp(), quiet: true, e2ee: true, maxFile: MB });
  try {
    const a = await enrolled('padmax-a', { on: s });
    const b = await enrolled('padmax-b', { on: s });
    await friends(a, b);
    const { id: dm } = await a.sock.ok('dm.open', { users: [b.id] });
    const f = await encryptFile(new Uint8Array(randomBytes(MB - 1000)), { pad: true, max: MB });
    assert.equal(f.ct.length, MB + TAG);
    const res = await fetch(`http://127.0.0.1:${s.port}/api/files?conv=${dm}&enc=1`, { method: 'POST', headers: { cookie: a.cookie, origin: `http://127.0.0.1:${s.port}`, 'content-type': 'application/octet-stream', 'x-file-name': 'file' }, body: f.ct });
    assert.equal(res.status, 201, await res.clone().text());
    await close([a, b]);
  } finally { await s.close(); }
});

test('E6 notifications: an encrypted DM or group names only the sender; "Hide names in notifications" hides that too', async () => {
  const { ps: [a, b, c], g, users } = await group('push');
  const { id } = await sendEnc(a, { dm: g, users, text: 'x' });
  const note = srv.push.noteOf(b.id, id);
  assert.deepEqual([note.title, note.body], ['push-0', 'New message']);
  assert.equal(JSON.stringify(note).includes('push-2'), false, 'no member names either');
  await b.sock.ok('prefs.set', { prefs: { notifyNames: false } });
  const hidden = srv.push.noteOf(b.id, id);
  assert.deepEqual([hidden.title, hidden.body], ['Snug', 'New message']);
  assert.equal(srv.push.ringNoteOf(b.id, { from: a.id, dm: g, group: true, call: 'c2' }).title, 'Snug');
  await close([a, b, c]);
});

test('E7 what the server still sees: one list, served by /api/privacy, matching the README', async () => {
  const res = await fetch(`http://127.0.0.1:${srv.port}/api/privacy`);
  const about = await res.json();
  const ids = about.e2eeServerSees.map((x) => x.id);
  for (const want of ['who', 'when', 'sizes', 'members', 'mentions', 'threads', 'side', 'reads', 'typing', 'presence', 'pins', 'devices', 'ips', 'gifs', 'calls', 'rooms']) {
    assert.ok(ids.includes(want), `lists ${want}`);
  }
  for (const gone of ['reactions', 'group-names', 'polls', 'replies']) assert.equal(ids.includes(gone), false, `${gone} are sealed now`);
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  for (const x of about.e2eeServerSees) assert.ok(readme.includes(x.text), `README lists: ${x.text}`);
});
