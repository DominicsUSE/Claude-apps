// The account's data file (design 0.10 section 2): the sealed format, all-or-nothing reading, the
// automatic copy, import as a merge, backups, the cached key and the owner-only HTTP routes.
import './helpers/vault.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { randomBytes, createCipheriv } from 'node:crypto';
import { join } from 'node:path';
import { startRegistry, startPc, signUp, clientFor, guest, until, mid } from './helpers/p2p.js';
import { fakeKeyStore, readLive, importFile, download, counts, flip } from './helpers/vault.js';
import { seal, open, readHeader, VaultError, MAGIC, MAX_FILE, fileKey, checkPayload } from '../server/vaultfile.js';
import { dmIdFor } from '../server/peercrypto.js';

// ---------- The format, as pure functions ----------
const UID = 'abcdefghijklmnop';
const KEY = randomBytes(32);
const payload = (extra = {}) => ({
  v: 1, uid: UID, username: 'pat', at: Date.now(), app: '0.10.0', profile: null, prefs: {}, privacy: null,
  people: [], keys: [], friends: [], blocks: [], dms: [], sections: {}, ...extra,
});
const codeOf = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof VaultError, e.stack); return e.code; } return 'ok'; };

test('format: a sealed file opens with the right key and uid, and says who and which key made it', () => {
  const f = seal({ key: KEY, uid: UID, kid: 3, seq: 7, app: '0.10.0', payload: payload({ username: 'pat' }) });
  assert.ok(f.subarray(0, 8).equals(MAGIC));
  const { header, payload: p } = open(f, { owner: UID, key: KEY, kid: 3 });
  assert.equal(header.uid, UID);
  assert.equal(header.kid, 3);
  assert.equal(header.seq, 7);
  assert.equal(p.username, 'pat');
  assert.equal(codeOf(() => open(f, { owner: UID, key: randomBytes(32) })), 'tampered', 'another key');
  assert.equal(codeOf(() => open(f, { owner: 'bbbbbbbbbbbbbbbb', key: KEY })), 'other_account');
});

test('format: a change anywhere (magic, length, header, ciphertext, tag), a cut or an extra byte is refused', () => {
  const f = seal({ key: KEY, uid: UID, payload: payload() });
  const H = f.readUInt32BE(8);
  const read = (b) => codeOf(() => open(b, { owner: UID, key: KEY }));
  assert.equal(read(f), 'ok');
  assert.equal(read(flip(f, 0)), 'not_vault', 'magic');
  assert.equal(read(flip(f, 11)), 'tampered', 'header length');
  // A byte inside the header JSON that keeps it parseable: a digit of "created".
  const hs = f.subarray(12, 12 + H).toString();
  const at = 12 + hs.indexOf('"created":') + 10;
  assert.equal(read(flip(f, at, 0x01)), 'tampered', 'header value');
  assert.equal(read(flip(f, 12 + H + 5)), 'tampered', 'ciphertext');
  assert.equal(read(flip(f, f.length - 1)), 'tampered', 'tag');
  assert.equal(read(f.subarray(0, f.length - 1)), 'tampered', 'cut');
  assert.equal(read(Buffer.concat([f, Buffer.from([0])])), 'tampered', 'appended');
  assert.equal(read(Buffer.from('hello')), 'not_vault');
  assert.equal(read(Buffer.alloc(MAX_FILE + 1)), 'too_big');
});

test('format: newer versions say so; the payload shape and caps are checked', () => {
  // A header with v 2, made by hand (seal only makes v 1).
  const hb = Buffer.from(JSON.stringify({ v: 2, alg: 'A256GCM', z: 'gzip', uid: UID, kid: 1, created: 1, seq: 0, iv: 'AAAAAAAAAAAAAAAA', app: '9', len: 0 }));
  const head = Buffer.alloc(12); MAGIC.copy(head); head.writeUInt32BE(hb.length, 8);
  assert.equal(codeOf(() => readHeader(Buffer.concat([head, hb, Buffer.alloc(16)]), UID)), 'newer_version');
  assert.equal(codeOf(() => open(seal({ key: KEY, uid: UID, payload: payload({ v: 2 }) }), { owner: UID, key: KEY })), 'newer_version');
  // Payload uid must be the header's.
  assert.equal(codeOf(() => open(seal({ key: KEY, uid: UID, payload: payload({ uid: 'bbbbbbbbbbbbbbbb' }) }), { owner: UID, key: KEY })), 'tampered');
  // Caps: 201 conversations; 5001 messages in one; a 4001-character message.
  const dm = (n, text = 'x') => ({ peer: 'cccccccccccccccc', msgs: Array.from({ length: n }, (_, i) => ({ id: `m_${String(i).padStart(10, '0')}`, a: UID, ts: i, text })) });
  assert.equal(codeOf(() => checkPayload(payload({ dms: Array.from({ length: 201 }, () => dm(0)) }), UID)), 'tampered');
  assert.equal(codeOf(() => checkPayload(payload({ dms: [dm(5001)] }), UID)), 'tampered');
  assert.equal(codeOf(() => checkPayload(payload({ dms: [dm(1, 'y'.repeat(4001))] }), UID)), 'tampered');
  assert.equal(codeOf(() => checkPayload(payload({ dms: [dm(3)] }), UID)), 'ok');
  // A message by someone who isn't in that conversation.
  assert.equal(codeOf(() => checkPayload(payload({ dms: [{ peer: 'cccccccccccccccc', msgs: [{ id: 'm_aaaaaaaaaa', a: 'dddddddddddddddd', ts: 1, text: '' }] }] }), UID)), 'tampered');
  // A properly encrypted file whose gzip unpacks past 64 MiB is refused as too big, not read.
  const bomb = gzipSync(Buffer.alloc(65 * 1024 * 1024, 0x20));
  const iv = randomBytes(12);
  const hdr = Buffer.from(JSON.stringify({ v: 1, alg: 'A256GCM', z: 'gzip', uid: UID, kid: 1, created: 1, seq: 0, iv: iv.toString('base64url'), app: '0', len: bomb.length }));
  const h12 = Buffer.alloc(12); MAGIC.copy(h12); h12.writeUInt32BE(hdr.length, 8);
  const c = createCipheriv('aes-256-gcm', fileKey(KEY, UID), iv); c.setAAD(Buffer.concat([h12, hdr]));
  const file = Buffer.concat([h12, hdr, c.update(bomb), c.final(), c.getAuthTag()]);
  assert.equal(codeOf(() => open(file, { owner: UID, key: KEY })), 'too_big');
});

// ---------- On real PCs, with the local registry ----------
let registry;
const pcs = [];
const pc = async (o) => { const s = await startPc(registry, o); pcs.push(s); return s; };
test.before(async () => { registry = await startRegistry(); });
test.after(async () => { for (const s of pcs) await s.close().catch(() => {}); await registry.close(); });
let gh = 7000;
const uidOf = (c) => c.id.slice(2);
async function friends(nameA, nameB, o = {}) {
  const A = await pc(o.a), B = await pc(o.b);
  const ga = ++gh, gb = ++gh;
  const a = await signUp(A, registry, ga, nameA);
  const b = await signUp(B, registry, gb, nameB);
  await a.ok('friend.request', { handle: nameB });
  await b.ok('friend.accept', { user: (await b.next('friend', (d) => d.friend?.state === 'incoming')).id });
  await a.next('friend', (d) => d.friend?.state === 'friends');
  await until(() => A.peer.isOnline(uidOf(b)) && B.peer.isOnline(uidOf(a)), 8000, 'presence');
  const dm = dmIdFor(uidOf(a), uidOf(b));
  await a.ok('dm.open', { users: [b.id] });
  return { A, B, a, b, dm, ga, gb };
}
const off = async (S, c) => { await c.close(); await S.close(); pcs.splice(pcs.indexOf(S), 1); };
// A second PC for an account that lives elsewhere: GitHub sign-in starts a move (pending).
async function newPcFor(ghId) {
  const B2 = await pc();
  const auth = await B2.peer.reg.authGithub(registry.github.issueToken({ id: ghId }));
  assert.equal(auth.status, 'rebind');
  const r = await B2.peer.reg.rebind(auth.ticket);
  const id = `u_${r.uid}`;
  B2.db.run("INSERT INTO users (id, handle, name, pass, hue, created) VALUES (?, ?, ?, '!', 10, ?)", id, auth.account.username, auth.account.username, Date.now());
  B2.peer.identity.setSelf({ uid: r.uid, username: auth.account.username, user: id, kver: auth.account.kver, state: 'moving', rebindAt: r.at });
  B2.peer.start();
  return { B2, b2: await clientFor(B2, id) };
}
// sec-registry REG-H1: the vault key goes to the current key only, so a file can be opened on the new PC
// once the move is done. The old PC is off in these tests: the move completes after 72 h.
async function completeMove(B2) {
  await registry.clock.advance(72 * 3600_000 + 1000);
  await until(() => B2.peer.identity.self().state === 'ok', 10_000, 'move done');
}

test('the data file is written after changes (debounced), only when something changed, and on close', async () => {
  const { A, a, b, dm } = await friends('vlt_alice1', 'vlt_bob1');
  await until(() => existsSync(A.vault._paths.liveFile()), 8000, 'first file');
  const seq0 = A.vault.status().file.seq;
  const m1 = mid();
  await a.ok('msg.send', { conv: dm, id: m1, text: 'kept in the file' });
  await until(() => A.vault.status().file?.seq > seq0, 5000, 'rewritten after a change');
  const seq1 = A.vault.status().file.seq;
  await b.ok('react', { conv: dm, id: m1, emoji: '👍', on: true }); // a friend's change lands here as their shadow's op
  await until(() => A.vault.status().file?.seq > seq1, 8000, 'rewritten after a friend’s change');
  const seq2 = A.vault.status().file.seq;
  await a.ok('typing', { conv: dm }); // never marks dirty
  await a.ok('sync');
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(A.vault.status().file.seq, seq2, 'nothing changed: no new write');
  // The file holds what it should.
  const key = await A.peer.reg.signedCall('/v1/vault/key', 'vault-key');
  const { payload: p } = open(readLive(A), { owner: uidOf(a), key: Buffer.from(key.key, 'base64url') });
  assert.equal(p.friends[0].uid, uidOf(b));
  const conv = p.dms.find((c) => c.peer === uidOf(b));
  assert.equal(conv.msgs.find((m) => m.id === m1).text, 'kept in the file');
  assert.deepEqual(conv.msgs.find((m) => m.id === m1).x, [{ u: uidOf(b), e: '👍' }]);
  // A change, then close at once: flushed before the database closes.
  await a.ok('me.update', { name: 'Alice just before quitting' });
  await a.close();
  const dir = A.dataDir;
  await A.close(); pcs.splice(pcs.indexOf(A), 1);
  const { payload: q } = open(readFileSync(join(dir, 'vault', `${uidOf(a)}.snugvault`)), { owner: uidOf(a), key: Buffer.from(key.key, 'base64url') });
  assert.equal(q.profile.name, 'Alice just before quitting');
});

test('import on a new PC of the same account: friends, keys and conversations come back; again changes nothing', async () => {
  const { B, a, b, dm, gb } = await friends('vlt_alice2', 'vlt_bob2');
  const m1 = mid(), m2 = mid();
  await a.ok('msg.send', { conv: dm, id: m1, text: 'from alice' });
  await b.next('msg', (d) => d.m.id === m1);
  await b.ok('msg.send', { conv: dm, id: m2, text: 'from bob', replyTo: m1 });
  await b.ok('me.update', { name: 'Bob Original' });
  const file = (await download(B, b.cookie)).buf;
  const ikA = B.db.get('SELECT ik FROM peers WHERE uid = ?', uidOf(a)).ik;
  await off(B, b); // the old PC is gone (no automatic transfer here; that is server-vault-xfer.test.js)
  const { B2, b2 } = await newPcFor(gb);
  const early = await importFile(B2, b2.cookie, file);
  assert.equal(early.status, 422, 'not while the move is pending: the registry gives the key to the current key only');
  assert.equal(early.body.code, 'not_yet');
  await completeMove(B2);
  const before = counts(B2);
  const r = await importFile(B2, b2.cookie, file);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.counts.friends, 1);
  assert.equal(r.body.counts.conversations, 1);
  assert.equal(r.body.counts.messages, 2);
  assert.equal(B2.db.get('SELECT state FROM friends WHERE user = ? AND other = ?', b2.id, a.id).state, 'friends');
  assert.equal(B2.db.get('SELECT ik FROM peers WHERE uid = ?', uidOf(a)).ik, ikA, 'the friend’s key is pinned as before');
  assert.equal(B2.db.get('SELECT text FROM messages WHERE id = ?', m2).text, 'from bob');
  assert.equal(B2.db.get('SELECT reply_to FROM messages WHERE id = ?', m2).reply_to, m1);
  assert.equal(B2.db.get('SELECT author FROM messages WHERE id = ?', m1).author, a.id);
  assert.equal(B2.db.get('SELECT name FROM users WHERE id = ?', b2.id).name, 'Bob Original');
  assert.ok(counts(B2).messages > before.messages);
  // Idempotent: the same file again adds nothing.
  const mid1 = counts(B2);
  const again = await importFile(B2, b2.cookie, file);
  assert.equal(again.status, 200);
  assert.deepEqual(again.body.counts, { people: 0, friends: 0, conversations: 0, messages: 0 });
  assert.deepEqual(counts(B2), mid1);
});

test('a refused file changes nothing: edited, cut, another account’s, or one a section can’t take', async () => {
  const { A, B, a, b, gb } = await friends('vlt_alice3', 'vlt_bob3');
  const fileB = (await download(B, b.cookie)).buf;
  const fileA = (await download(A, a.cookie)).buf;
  // A file made with a section the new PC can't take, made before the old PC goes away.
  B.hub.vaultSections = [...(B.hub.vaultSections || []), { name: 'boom', export: () => ({ x: 1 }), import: () => {} }];
  await b.ok('me.update', { name: 'Bob with a section' });
  await B.vault.write();
  const withSection = (await download(B, b.cookie)).buf;
  await off(B, b);
  const { B2, b2 } = await newPcFor(gb);
  await completeMove(B2);
  const before = counts(B2);
  const H = fileB.readUInt32BE(8);
  for (const [buf, code] of [
    [flip(fileB, 12 + H + 40), 'tampered'], [flip(fileB, fileB.length - 3), 'tampered'], [fileB.subarray(0, fileB.length - 100), 'tampered'],
    [Buffer.concat([fileB, Buffer.from('x')]), 'tampered'], [flip(fileB, 2), 'not_vault'], [fileA, 'other_account'],
  ]) {
    const r = await importFile(B2, b2.cookie, buf);
    assert.equal(r.status, 422);
    assert.equal(r.body.code, code);
    assert.match(r.body.error, code === 'other_account' ? /another Snug account/ : /changed outside Snug or is damaged/);
  }
  assert.deepEqual(counts(B2), before, 'nothing applied');
  // A section that throws aborts the whole import, people and messages included.
  B2.hub.vaultSections = [...(B2.hub.vaultSections || []), { name: 'boom', export: () => ({ x: 1 }), import: () => { throw new Error('no thanks'); } }];
  const r = await importFile(B2, b2.cookie, withSection);
  assert.equal(r.status, 422);
  assert.equal(r.body.code, 'failed');
  assert.deepEqual(counts(B2), before, 'the throwing section rolled everything back');
  assert.notEqual(B2.db.get('SELECT name FROM users WHERE id = ?', b2.id).name, 'Bob with a section');
  B2.hub.vaultSections = B2.hub.vaultSections.filter((s) => s.name !== 'boom');
  // The type and size rules of the route.
  assert.equal((await importFile(B2, b2.cookie, fileB, 'application/json')).status, 415);
});

test('backups keep the newest 5; the setting is saved; the cached key is wrapped and a broken cache is fetched again', async () => {
  const ks = fakeKeyStore();
  const A = await pc({ keyStore: ks });
  const a = await signUp(A, registry, ++gh, 'vlt_alice4');
  const st = await a.ok('vault.setBackup', { days: 3 });
  assert.equal(st.backupDays, 3);
  assert.equal((await a.refused('vault.setBackup', { days: 2 })), 'Pick how often to back up.');
  for (let i = 0; i < 7; i++) await A.vault.backupNow({ send: false });
  const names = readdirSync(A.vault._paths.bdir).filter((n) => n.endsWith('.snugvault'));
  assert.equal(names.length, 5);
  assert.ok(names.every((n) => n.startsWith(`${uidOf(a)}-`)));
  // Key cache: wrapped by the key store, never the plain key.
  const kf = A.vault._paths.keyFile();
  const cache = JSON.parse(readFileSync(kf, 'utf8'));
  assert.equal(cache.enc, 'safeStorage');
  assert.match(cache.blob, /^FAKE:/);
  const real = await A.peer.reg.signedCall('/v1/vault/key', 'vault-key');
  assert.equal(ks.decrypt(cache.blob), real.key);
  assert.equal(A.vault.status().protected, true);
  // A cache that no longer unwraps (another OS user, a wiped keyring) is dropped and fetched again.
  writeFileSync(kf, JSON.stringify({ v: 1, enc: 'safeStorage', kid: 1, blob: 'garbage' }));
  const dir = A.dataDir;
  await a.close();
  await A.close(); pcs.splice(pcs.indexOf(A), 1);
  const A2 = await pc({ dataDir: dir, keyStore: ks });
  const a2 = await clientFor(A2, a.id);
  await a2.ok('me.update', { name: 'after the key came back' });
  await until(() => { try { return ks.decrypt(JSON.parse(readFileSync(kf, 'utf8')).blob) === real.key; } catch { return false; } }, 8000, 'key fetched again');
  await until(() => A2.vault.status().file && !A2.vault._dirty(), 8000, 'written with it');
  const { payload: p } = open(readFileSync(A2.vault._paths.liveFile()), { owner: uidOf(a), key: Buffer.from(real.key, 'base64url') });
  assert.equal(p.profile.name, 'after the key came back');
  // Without a key store the cache says so.
  const P = await pc();
  const p1 = await signUp(P, registry, ++gh, 'vlt_plain');
  await p1.ok('me.update', { name: 'plain' });
  await until(() => P.vault.status().protected === false, 8000, 'unprotected status');
});

test('/api/vault/* and the vault ops are the owner’s only', async () => {
  const A = await pc();
  const a = await signUp(A, registry, ++gh, 'vlt_alice5');
  const g = await guest(A, 'languest5');
  await until(() => A.vault.status().file, 8000, 'file');
  const own = await download(A, a.cookie);
  assert.equal(own.status, 200);
  assert.match(own.headers.get('content-disposition'), /^attachment; filename="Snug data \d{4}-\d{2}-\d{2}\.snugvault"$/);
  assert.ok(own.buf.subarray(0, 8).equals(MAGIC));
  assert.equal((await download(A, g.cookie)).status, 404, 'a LAN guest gets nothing');
  assert.equal((await importFile(A, g.cookie, own.buf)).status, 404);
  assert.equal((await fetch(`${A.base}/api/vault/file`)).status, 401);
  assert.equal(await g.refused('vault.status'), 'Only this PC’s Snug account can do that.');
  assert.equal(await g.refused('vault.backupNow'), 'Only this PC’s Snug account can do that.');
  // From a friend's PC (an op applied as their shadow) it is refused too.
  assert.throws(() => A.hub.ops['vault.status']({ user: a.id, peer: true }, {}), /Only this PC/);
  assert.equal(a.hello.vault?.enabled, true, 'the owner’s snapshot carries the status');
  assert.equal(g.hello.vault, undefined);
  // Cross-site posts are refused before the route.
  const cross = await fetch(`${A.base}/api/vault/import`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', origin: 'http://evil.example', cookie: a.cookie }, body: own.buf });
  assert.equal(cross.status, 403);
});

test('deleting the Snug account on this PC removes its data file, cached key and backups', async () => {
  const A = await pc();
  const a = await signUp(A, registry, ++gh, 'vlt_gone');
  await a.ok('me.update', { name: 'soon gone' });
  await A.vault.backupNow({ send: false });
  const live = A.vault._paths.liveFile(), kf = A.vault._paths.keyFile();
  assert.ok(existsSync(live) && existsSync(kf));
  assert.equal(readdirSync(A.vault._paths.bdir).filter((n) => n.endsWith('.snugvault')).length, 1);
  const res = await fetch(`${A.base}/api/account/delete`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: A.base, cookie: a.cookie }, body: JSON.stringify({ confirm: 'vlt_gone' }),
  });
  assert.equal(res.status, 200, await res.text());
  assert.equal(existsSync(live), false, 'data file gone');
  assert.equal(existsSync(kf), false, 'cached key gone');
  assert.deepEqual(readdirSync(A.vault._paths.bdir).filter((n) => n.endsWith('.snugvault')), [], 'backups gone');
  await new Promise((r) => setTimeout(r, 300));
  A.vault.flush();
  assert.equal(existsSync(live), false, 'not written again');
});

test('REG-L1: the vault key rotates (by hand, and when a move is stopped); older files and backups still import', async () => {
  const { A, B, a, b, gb } = await friends('vlt_rot_a', 'vlt_rot_b');
  await A.vault.write();
  const before = (await download(A, a.cookie)).buf;
  const kid0 = readHeader(before, uidOf(a)).header.kid;
  await a.ok('vault.rotateKey');
  const now = readLive(A);
  assert.equal(readHeader(now, uidOf(a)).header.kid, kid0 + 1, 'the data file is written with the new key');
  const r = await importFile(A, a.cookie, before);
  assert.equal(r.status, 200, `an older file still opens: ${JSON.stringify(r.body)}`);
  // Stop on a move someone else started: a new kid, so a key copied earlier can't open what comes next.
  await B.vault.write();
  const kidB = readHeader(readLive(B), uidOf(b)).header.kid;
  await newPcFor(gb);
  await until(() => B.peer.statusFor(b.id).rebindPending, 8000, 'old PC told');
  await B.peer.cancelRebind();
  await until(() => readHeader(readLive(B), uidOf(b)).header.kid === kidB + 1, 8000, 'rotated after Stop');
});

test('REG-L2: a data file can’t pin made-up keys: pins for people new to this PC are checked with the registry', async () => {
  const { A, a } = await friends('vlt_pin_a', 'vlt_pin_b');
  const C = await pc();
  const c = await signUp(C, registry, 77_701, 'vlt_pin_c'); // on Snug, but A has never met them
  const cUid = uidOf(c);
  const k = await A.peer.reg.signedCall('/v1/vault/key', 'vault-key');
  const fake = () => randomBytes(32).toString('base64url');
  const fik = fake(), fxk = fake();
  const payload = {
    v: 1, uid: uidOf(a), username: 'vlt_pin_a', at: Date.now(), app: '0.10.1',
    profile: null, prefs: {}, privacy: null,
    people: [{ uid: cUid, username: 'vlt_pin_c', ik: fik, xk: fxk, kver: 999, name: 'c' }],
    keys: [{ uid: cUid, kver: 999, ik: fik, xk: fxk }], friends: [], blocks: [], dms: [], sections: {},
  };
  const file = seal({ key: Buffer.from(k.key, 'base64url'), uid: uidOf(a), kid: k.kid, seq: 5, app: '0.10.1', payload });
  const r = await importFile(A, a.cookie, file);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await until(() => A.db.get('SELECT ik FROM peers WHERE uid = ?', cUid)?.ik === C.peer.identity.ik, 8000, 'pin corrected from the registry');
  assert.equal(A.db.get('SELECT kver FROM peers WHERE uid = ?', cUid).kver, 1, 'no kver 999 downgrade trap');
  assert.equal(A.db.get('SELECT 1 FROM peer_keys WHERE uid = ? AND ik = ?', cUid, fik), undefined, 'the made-up key is gone');
});

test('REG-L2: my own group ops in a data file must verify with my key chain from the registry', async () => {
  const { A, a, b } = await friends('vlt_gop_a', 'vlt_gop_b');
  const { gidFor, signOp, exportGroups } = await import('../server/grouplog.js');
  const { newSigningKeys } = await import('../server/peercrypto.js');
  const my = uidOf(a);
  const id = 'o_forgedcreate0001';
  const op = { g: gidFor(my, id), id, t: 'create', by: my, kver: 1, ts: Date.now() - 1000, d: { name: 'forged', members: [uidOf(b)] } };
  const sig = signOp(newSigningKeys().priv, op); // not my key
  const k = await A.peer.reg.signedCall('/v1/vault/key', 'vault-key');
  const payload = {
    v: 1, uid: my, username: 'vlt_gop_a', at: Date.now(), app: '0.10.1', profile: null, prefs: {}, privacy: null,
    people: [], keys: [], friends: [], blocks: [], dms: [],
    sections: { groups: exportGroups([{ g: op.g, name: 'forged', icon: null, ops: [{ body: JSON.stringify(op), sig }], msgs: [] }]) },
  };
  const file = seal({ key: Buffer.from(k.key, 'base64url'), uid: my, kid: k.kid, seq: 7, app: '0.10.1', payload });
  const r = await importFile(A, a.cookie, file);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(A.db.get('SELECT 1 FROM grp_ops WHERE g = ?', op.g), undefined, 'a forged op “by me” is not taken');
  assert.equal(A.db.get('SELECT 1 FROM dms WHERE id = ?', op.g), undefined);
});

// 0.13: the disappearing timer and each message's expiry travel in the data file (direct conversations and
// groups), so a move to a new PC keeps them; messages already past their time aren't brought back.
test('the disappearing timer and message expiry come back after a move; expired messages stay gone; 0.12.0 still reads the file', async () => {
  const { A, B, a, b, dm, gb } = await friends('vlt_ttl_a', 'vlt_ttl_b');
  // A group across PCs too: Bea, Ana and Cy (a friend of Bea's).
  const C = await pc();
  const c = await signUp(C, registry, ++gh, 'vlt_ttl_c');
  await b.ok('friend.request', { handle: 'vlt_ttl_c' });
  await c.ok('friend.accept', { user: (await c.next('friend', (d) => d.friend?.state === 'incoming')).id });
  await b.next('friend', (d) => d.id === c.id && d.friend?.state === 'friends');
  await until(() => B.peer.capsOf(uidOf(a)).includes('ttl') && B.peer.capsOf(uidOf(c)).includes('ttl'), 10_000, 'caps');
  const g = (await b.ok('dm.open', { users: [a.id, c.id] })).id;
  const DAY = 86_400_000;
  await b.ok('dm.open', { users: [a.id] });
  await b.ok('conv.ttl', { conv: dm, ttl: DAY });
  await b.ok('conv.ttl', { conv: g, ttl: DAY });
  const live = mid(), soon = mid(), gLive = mid(), gSoon = mid();
  await b.ok('msg.send', { conv: dm, id: live, text: 'stays a day' });
  await b.ok('msg.send', { conv: dm, id: soon, text: 'nearly gone' });
  await b.ok('msg.send', { conv: g, id: gLive, text: 'group, stays a day' });
  await b.ok('msg.send', { conv: g, id: gSoon, text: 'group, nearly gone' });
  const t = Date.now();
  B.db.run('UPDATE messages SET expires = ? WHERE id IN (?, ?)', t + 2500, soon, gSoon);
  const exp = B.db.get('SELECT expires FROM messages WHERE id = ?', live).expires;
  const gExp = B.db.get('SELECT expires FROM messages WHERE id = ?', gLive).expires;
  assert.ok(exp > t + DAY - 60_000);
  const file = (await download(B, b.cookie)).buf;
  // What 0.11 and 0.12.0 read: the same file opens and its groups section parses with their code.
  const key = await B.peer.reg.signedCall('/v1/vault/key', 'vault-key');
  const old = await import('./fixtures/v0.12.0/vaultfile.js');
  const oldGroups = await import('./fixtures/v0.12.0/grouplog.js');
  const { payload: p } = old.open(file, { owner: uidOf(b), key: Buffer.from(key.key, 'base64url') });
  const conv = p.dms.find((x) => x.peer === uidOf(a));
  assert.equal(conv.ttl, DAY);
  assert.equal(conv.msgs.find((m) => m.id === live).exp, exp);
  const og = oldGroups.parseGroupsSection(p.sections.groups).find((x) => x.g === g);
  assert.ok(og.msgs.some((m) => m.id === gLive), '0.12.0 reads the group and its messages');
  assert.equal(p.sections.groups.groups.find((x) => x.g === g).ttl, DAY);
  // The move: the old PC is gone, the file goes to a new one after the messages' time has passed.
  await off(B, b);
  const { B2, b2 } = await newPcFor(gb);
  await completeMove(B2);
  await until(() => Date.now() > t + 3000, 5000, 'past the near messages’ time');
  const r = await importFile(B2, b2.cookie, file);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(B2.db.get('SELECT ttl FROM conv_ttl WHERE conv = ?', dm)?.ttl, DAY, 'the timer is on again');
  assert.equal(B2.db.get('SELECT expires FROM messages WHERE id = ?', live)?.expires, exp, 'the live message keeps its time');
  assert.equal(B2.db.get('SELECT 1 FROM messages WHERE id = ?', soon), undefined, 'the expired one isn’t brought back');
  assert.equal(B2.db.get('SELECT ttl FROM conv_ttl WHERE conv = ?', g)?.ttl, DAY, 'the group’s timer too');
  assert.equal(B2.db.get('SELECT expires FROM messages WHERE id = ?', gLive)?.expires, gExp);
  assert.equal(B2.db.get('SELECT 1 FROM messages WHERE id = ?', gSoon), undefined);
  // A file from before (0.12.0: no timer, no expiry) still imports.
  const { ttl, ...plain } = conv;
  void ttl;
  const before = { ...p, dms: [{ ...plain, msgs: plain.msgs.map(({ exp: e, ...m }) => { void e; return m; }) }], sections: {} };
  const k2 = await B2.peer.reg.signedCall('/v1/vault/key', 'vault-key');
  const oldFile = seal({ key: Buffer.from(k2.key, 'base64url'), uid: uidOf(b), kid: k2.kid, seq: 99, app: '0.12.0', payload: { ...before, at: Date.now() } });
  const r2 = await importFile(B2, b2.cookie, oldFile);
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
});
