// Moving to a new PC, PC to PC (design 0.10 section 3): the old PC sends its data file to the new one over
// the registry's xfer sockets, end to end encrypted between the two device keys, chunked and resumable.
process.env.SNUG_VAULT_RETRY_MS = '500,1000'; // the 30 s / 2 min / 10 min retry steps, shortened for tests
import './helpers/vault.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startRegistry, startPc, signUp, clientFor, until, mid } from './helpers/p2p.js';
import { createXfer, PART, xidOf, boxSeal, sessionKey } from '../server/vaultxfer.js';
import { newSigningKeys, newDhKeys, pubOf, sha256 } from '../server/peercrypto.js';
import { dmIdFor, unb64u } from '../server/peercrypto.js';
import { seal } from '../server/vaultfile.js';

// ---------- The protocol over an in-memory pipe ----------
const UID = 'abcdefghijklmnop';
function device() {
  const s = newSigningKeys(), x = newDhKeys();
  return { ik: pubOf(s.priv), xk: pubOf(x.priv), xkPriv: x.priv };
}
// Two engines joined by a pipe. `cut(box, from)` returning true drops a box.
function pair({ file, cut = () => false, uidR = UID, accept } = {}) {
  const S = device(), R = device();
  const got = [];
  const sent = { parts: 0 };
  let rx, sx;
  const deliver = (to, from, box) => setImmediate(() => (to === R.ik ? rx : sx).receive(from.ik, from.xk, box));
  sx = createXfer({
    uid: UID, me: S, dir: mkdtempSync(join(tmpdir(), 'xs-')),
    transport: { send: (to, box) => { if (cut(box, 'S')) return false; sent.parts++; deliver(to, S, box); return true; } },
    getFile: () => ({ buf: file, sha: sha256(file).toString('hex'), kid: 1, created: 1 }),
    markSent: () => {}, wasSent: () => false,
  });
  const rdir = mkdtempSync(join(tmpdir(), 'xr-'));
  const progress = [];
  const makeR = () => createXfer({
    uid: uidR, me: R, dir: rdir,
    transport: { send: (to, box) => { if (cut(box, 'R')) return false; deliver(to, R, box); return true; } },
    hasImported: () => false,
    accept: accept || (async (buf) => { got.push(buf); return { ok: true }; }),
    onProgress: (p) => progress.push(p),
  });
  rx = makeR();
  return { S, R, sx: () => sx, rx: () => rx, got, sent, rdir, progress, newSender: () => { sx = createXfer({ uid: UID, me: S, dir: mkdtempSync(join(tmpdir(), 'xs-')), transport: { send: (to, box) => { sent.parts++; deliver(to, S, box); return true; } }, getFile: () => ({ buf: file, sha: sha256(file).toString('hex'), kid: 1, created: 1 }) }); return sx; } };
}

test('xfer: a file arrives whole, in parts, with progress, and the receiver verifies it before accepting', async () => {
  const file = randomBytes(PART * 9 + 123);
  const p = pair({ file });
  assert.equal(await p.sx().send({ ik: p.R.ik, xk: p.R.xk }), 'done');
  assert.equal(p.got.length, 1);
  assert.ok(p.got[0].equals(file));
  assert.ok(p.progress.some((x) => x.state === 'receiving'));
  assert.equal(p.progress.at(-1).state, 'done');
  assert.deepEqual(readdirSync(p.rdir).filter((n) => n !== '.n'), [], 'nothing left behind (the box counter mark stays)');
});

test('xfer: cut part-way, a new session resumes from where the receiver got to', async () => {
  const file = randomBytes(PART * 12);
  let parts = 0;
  const p = pair({ file, cut: (box, from) => from === 'S' && ++parts > 6 }); // the socket drops after six boxes
  assert.equal(await p.sx().send({ ik: p.R.ik, xk: p.R.xk }), 'failed');
  await until(() => existsSync(join(p.rdir, `${xidOf(p.S.ik, sha256(file).toString('hex'))}.part`)), 2000, 'part kept');
  await new Promise((r) => setTimeout(r, 200)); // what was on the way has landed
  const before = p.sent.parts;
  const S2 = p.newSender(); // a new socket, a new process even: same file, same xid
  assert.equal(await S2.send({ ik: p.R.ik, xk: p.R.xk }), 'done');
  assert.ok(p.got[0].equals(file));
  // offer + the parts after the first ~five + end: fewer boxes than the whole file again.
  assert.ok(p.sent.parts - before <= 12 - 5 + 2, `resumed (${p.sent.parts - before} boxes)`);
});

test('xfer: a 4 MB file gets through the registry’s 60-a-second burst limit, also with lost boxes', async () => {
  // The registry relays at most 60 boxes per fixed 1 s window for an account, both directions together.
  for (const loss of [0, 0.02]) {
    const file = randomBytes(4 * 1024 * 1024 + 99);
    const S = device(), R = device();
    let win = { n: 0, reset: 0 }, dropped = 0;
    const limited = () => { const t = Date.now(); if (win.reset <= t) win = { n: 0, reset: t + 1000 }; if (win.n >= 60) { dropped++; return true; } win.n++; return false; };
    let sx, rx;
    const deliver = (to, from, box) => { if (limited() || Math.random() < loss) return; setTimeout(() => (to === R.ik ? rx : sx).receive(from.ik, from.xk, box), 20); };
    sx = createXfer({ uid: UID, me: S, dir: mkdtempSync(join(tmpdir(), 'xs-')), transport: { send: (to, b) => { deliver(to, S, b); return true; } },
      getFile: () => ({ buf: file, sha: sha256(file).toString('hex'), kid: 1, created: 1 }), markSent() {}, wasSent: () => false });
    const got = [];
    rx = createXfer({ uid: UID, me: R, dir: mkdtempSync(join(tmpdir(), 'xr-')), transport: { send: (to, b) => { deliver(to, R, b); return true; } },
      hasImported: () => false, accept: async (buf) => { got.push(buf); return { ok: true }; } });
    const t0 = Date.now();
    assert.equal(await sx.send({ ik: R.ik, xk: R.xk }), 'done', `loss ${loss}`);
    assert.ok(got[0].equals(file));
    assert.equal(dropped, 0, 'paced under the limit');
    assert.ok(Date.now() - t0 < 25_000, `took ${Date.now() - t0} ms`);
  }
});

test('xfer: a lost first offer and a lost final "done" are sent again, so the transfer still ends done', async () => {
  const file = randomBytes(PART * 3 + 5);
  const S = device(), R = device();
  let sx, rx, sFirst = true, accepted = false, dropDone = true;
  const deliver = (to, from, box) => {
    if (from === S && sFirst) { sFirst = false; return; }            // the offer never arrives
    if (from === R && accepted && dropDone) { dropDone = false; return; } // nor the receiver's "done"
    setTimeout(() => (to === R.ik ? rx : sx).receive(from.ik, from.xk, box), 5);
  };
  sx = createXfer({ uid: UID, me: S, dir: mkdtempSync(join(tmpdir(), 'xs-')), transport: { send: (to, b) => { deliver(to, S, b); return true; } },
    getFile: () => ({ buf: file, sha: sha256(file).toString('hex'), kid: 1, created: 1 }), markSent() {}, wasSent: () => false });
  const got = [];
  rx = createXfer({ uid: UID, me: R, dir: mkdtempSync(join(tmpdir(), 'xr-')), transport: { send: (to, b) => { deliver(to, R, b); return true; } },
    hasImported: () => false, accept: async (buf) => { got.push(buf); accepted = true; return { ok: true }; } });
  const t0 = Date.now();
  assert.equal(await sx.send({ ik: R.ik, xk: R.xk }), 'done');
  assert.equal(got.length, 1, 'imported once');
  assert.ok(got[0].equals(file));
  assert.equal(dropDone, false, 'the done was dropped once');
  assert.ok(Date.now() - t0 < 15_000, `took ${Date.now() - t0} ms`);
});

test('xfer: another account’s key, an edited box, and bytes that don’t match the offer are all refused', async () => {
  const file = randomBytes(PART * 2 + 7);
  // The receiver thinks it is another account: the session keys differ, every box is dropped.
  const other = pair({ file, uidR: 'zzzzzzzzzzzzzzzz' });
  const r1 = other.sx().send({ ik: other.R.ik, xk: other.R.xk });
  await new Promise((r) => setTimeout(r, 300));
  other.sx().stop();
  assert.equal(await r1, 'failed');
  assert.equal(other.got.length, 0);
  // A sender whose bytes don't match the sha it offered: the receiver says bad, accepts nothing.
  const p = pair({ file });
  const S = p.S, R = p.R;
  const xid = xidOf(S.ik, sha256(file).toString('hex'));
  const K = sessionKey({ myXkPriv: S.xkPriv, theirXk: R.xk, xid, uid: UID, senderIk: S.ik, receiverIk: R.ik });
  let nn = Date.now() * 1024;
  const rx = p.rx();
  await rx.receive(S.ik, S.xk, boxSeal(K, xid, 1, ++nn, { t: 'offer', size: file.length, sha: sha256(file).toString('hex'), kid: 1, created: 1 }));
  const wrong = Buffer.from(file); wrong[5] ^= 1;
  for (let off = 0; off < wrong.length; off += PART) await rx.receive(S.ik, S.xk, boxSeal(K, xid, 1, ++nn, { t: 'part', off, d: wrong.subarray(off, off + PART).toString('base64') }));
  // A replayed (lower n) or edited box is dropped silently.
  await rx.receive(S.ik, S.xk, boxSeal(K, xid, 1, nn - 5, { t: 'end' }));
  const bad = JSON.parse(boxSeal(K, xid, 1, ++nn, { t: 'end' }));
  bad.c = (bad.c[0] === 'A' ? 'B' : 'A') + bad.c.slice(1);
  await rx.receive(S.ik, S.xk, JSON.stringify(bad));
  assert.equal(p.got.length, 0);
  await rx.receive(S.ik, S.xk, boxSeal(K, xid, 1, ++nn, { t: 'end' }));
  assert.equal(p.got.length, 0, 'sha mismatch: not accepted');
  assert.equal(p.progress.at(-1).error, 'sha');
  // Over 16 MiB is refused at the offer.
  const big = pair({ file });
  const xb = xidOf(big.S.ik, 'a'.repeat(64));
  const Kb = sessionKey({ myXkPriv: big.S.xkPriv, theirXk: big.R.xk, xid: xb, uid: UID, senderIk: big.S.ik, receiverIk: big.R.ik });
  await big.rx().receive(big.S.ik, big.S.xk, boxSeal(Kb, xb, 1, Date.now() * 1024, { t: 'offer', size: 17 * 1024 * 1024, sha: 'a'.repeat(64) }));
  assert.equal(big.got.length, 0);
});

test('REG-L4: box counters never repeat under the same key, also after a restart with the clock set back', async () => {
  const file = randomBytes(PART * 2);
  const S = device(), R = device();
  const dir = mkdtempSync(join(tmpdir(), 'xn-'));
  const seen = [];
  const mk = (now) => createXfer({
    uid: UID, me: S, dir, now,
    transport: { send: (to, b) => { seen.push(JSON.parse(b).n); return true; } },
    getFile: () => ({ buf: file, sha: sha256(file).toString('hex'), kid: 1, created: 1 }), markSent() {}, wasSent: () => false,
  });
  const T = Date.now();
  const s1 = mk(() => T);
  const p1 = s1.send({ ik: R.ik, xk: R.xk });
  s1.stop();
  await p1;
  const last = Math.max(...seen);
  const s2 = mk(() => T - 10 * 60_000); // "restarted", and the clock stepped back ten minutes
  const p2 = s2.send({ ik: R.ik, xk: R.xk });
  s2.stop();
  await p2;
  const after = seen.slice(seen.indexOf(last) + 1);
  assert.ok(after.length > 0);
  assert.ok(after.every((n) => n > last), `no (key, nonce) reuse: ${last} then ${after}`);
});

// ---------- On real PCs, through the local registry ----------
let registry;
const pcs = [];
const pc = async (o) => { const s = await startPc(registry, o); pcs.push(s); return s; };
const off = async (S, c) => { await c?.close(); await S.close(); pcs.splice(pcs.indexOf(S), 1); };
test.before(async () => { registry = await startRegistry(); });
test.after(async () => { for (const s of pcs) await s.close().catch(() => {}); await registry.close(); });
let gh = 8000;
const uidOf = (c) => c.id.slice(2);
async function friends(nameA, nameB) {
  const A = await pc(), B = await pc();
  const gb = (gh += 2);
  const a = await signUp(A, registry, gb - 1, nameA);
  const b = await signUp(B, registry, gb, nameB);
  await a.ok('friend.request', { handle: nameB });
  await b.ok('friend.accept', { user: (await b.next('friend', (d) => d.friend?.state === 'incoming')).id });
  await a.next('friend', (d) => d.friend?.state === 'friends');
  await until(() => A.peer.isOnline(uidOf(b)) && B.peer.isOnline(uidOf(a)), 8000, 'presence');
  const dm = dmIdFor(uidOf(a), uidOf(b));
  await a.ok('dm.open', { users: [b.id] });
  const m = mid();
  await a.ok('msg.send', { conv: dm, id: m, text: 'remember this' });
  await b.next('msg', (d) => d.m.id === m);
  return { A, B, a, b, dm, gb, m };
}
async function newPcFor(ghId) {
  const B2 = await pc();
  const auth = await B2.peer.reg.authGithub(registry.github.issueToken({ id: ghId }));
  assert.equal(auth.status, 'rebind');
  const r = await B2.peer.reg.rebind(auth.ticket);
  const id = `u_${r.uid}`;
  B2.db.run("INSERT INTO users (id, handle, name, pass, hue, created) VALUES (?, ?, ?, '!', 10, ?)", id, auth.account.username, auth.account.username, Date.now());
  B2.peer.identity.setSelf({ uid: r.uid, username: auth.account.username, user: id, kver: auth.account.kver, state: 'moving', rebindAt: r.at });
  const b2 = await clientFor(B2, id);
  B2.peer.start();
  return { B2, b2 };
}

test('during a move the old PC sends nothing until the move is approved; then the new PC shows progress and imports it', async () => {
  const { B, a, b, dm, gb, m } = await friends('xf_alice1', 'xf_bob1');
  await b.ok('me.update', { name: 'Bob from the old PC' });
  const { B2, b2 } = await newPcFor(gb);
  // sec-registry REG-H1: a pending move's key proved GitHub only. Nothing leaves the old PC by itself.
  await until(() => B.peer.statusFor(b.id).rebindPending, 8000, 'old PC told');
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(B.db.get("SELECT 1 FROM vault_meta WHERE k LIKE 'sent:%'"), undefined, 'nothing sent to the pending key');
  assert.equal(B2.db.get('SELECT 1 FROM messages WHERE id = ?', m), undefined, 'nothing arrived');
  assert.equal(b2.has('vault.xfer', (d) => d.state === 'receiving'), false);
  assert.equal(B2.vault.status().error, null, 'the new PC shows no error while it waits for the move');
  // Approved on the old PC: the move completes and the old PC (now the old key) hands its file over.
  await B.peer.approveRebind();
  await until(() => B2.peer.identity.self().state === 'ok', 8000, 'move done');
  const done = await b2.next('vault.xfer', (d) => d.state === 'imported', 20_000);
  assert.ok(done.counts.messages >= 1);
  assert.ok(b2.has('vault.xfer', (d) => d.state === 'receiving' || d.state === 'done'), 'progress shown');
  assert.equal(B2.db.get('SELECT state FROM friends WHERE user = ? AND other = ?', b2.id, a.id).state, 'friends');
  assert.equal(B2.db.get('SELECT text FROM messages WHERE id = ? AND conv = ?', m, dm).text, 'remember this');
  assert.equal(B2.db.get('SELECT name FROM users WHERE id = ?', b2.id).name, 'Bob from the old PC');
  assert.equal(B2.vault.status().waiting, null, 'no longer waiting');
  await until(() => B.db.get("SELECT 1 FROM vault_meta WHERE k LIKE 'sent:%:' || ?", B2.peer.identity.ik), 5000, 'the old PC records it, so it won’t send again');
});

test('a send that fails is tried again while both PCs stay connected', async () => {
  const { B, b, gb, m } = await friends('xf_alice3', 'xf_bob3');
  let drop = 1;
  const send = B.vault._sock.send;
  const { B2, b2 } = await newPcFor(gb);
  await until(() => B.peer.statusFor(b.id).rebindPending, 8000, 'old PC told');
  B.vault._sock.send = (to, box) => (drop-- > 0 ? false : send(to, box)); // the first box can't go out
  await B.peer.approveRebind();
  await b2.next('vault.xfer', (d) => d.state === 'imported', 20_000);
  assert.equal(drop < 0, true, 'the first try failed');
  assert.ok(B2.db.get('SELECT 1 FROM messages WHERE id = ?', m), 'arrived on the retry');
  assert.equal((await b2.ok('vault.status')).waiting, null, 'no longer waiting');
  await until(() => B2.peer.identity.self().state === 'ok', 8000, 'move done');
});

test('REG-H1: a pending (unapproved) key gets no vault key, no data file, and its forged file is refused', async () => {
  const { B, a, b, gb, m } = await friends('xf_alice4', 'xf_bob4');
  await B.vault.write();
  const { B2, b2 } = await newPcFor(gb); // an attacker who phished bob's GitHub sign-in, say
  await until(() => B.peer.statusFor(b.id).rebindPending, 8000, 'old PC told');
  // (1) The registry refuses the vault key to the pending key.
  await assert.rejects(B2.peer.reg.signedCall('/v1/vault/key', 'vault-key'), (e) => e.code === 'bad_signature');
  // (2) A forged file offered by the pending key (sealed with a leaked vault key) is refused before a byte lands.
  const k = await B.peer.reg.signedCall('/v1/vault/key', 'vault-key');
  const key = unb64u(k.key);
  const uidB = uidOf(b);
  const look = B.db.get('SELECT ik, xk, kver FROM peers WHERE uid = ?', uidOf(a));
  const fake = `m_fakefake${Date.now().toString(36)}`;
  const payload = {
    v: 1, uid: uidB, username: 'xf_bob4', at: Date.now(), app: '0.10.1',
    profile: { name: 'HACKED', about: 'pwned', links: [] },
    prefs: {}, privacy: { dm: 'everyone', friends: 'everyone', requests: true },
    people: [{ uid: uidOf(a), username: 'xf_alice4', ik: look.ik, xk: look.xk, kver: look.kver, name: 'alice' }],
    keys: [], friends: [], blocks: [],
    dms: [{ peer: uidOf(a), msgs: [{ id: fake, a: uidOf(a), ts: Date.now(), text: 'send me your recovery codes' }] }],
    sections: {},
  };
  const forged = seal({ key, uid: uidB, kid: k.kid, seq: 999, app: '0.10.1', payload });
  mkdirSync(B2.vault._paths.vdir, { recursive: true });
  writeFileSync(B2.vault._paths.liveFile(), forged);
  await B.vault._sock.open(); // the current PC's xfer socket (it opens one while it waits or sends)
  await until(() => B2.vault._sock.connected, 8000, 'the new PC waits on its xfer socket');
  await until(() => B.vault._sock.connected && B2.vault._sock.peers().some((p) => p.role === 'cur'), 8000, 'both on xfer');
  const sent = await B2.vault.sendToOther().catch((e) => e);
  assert.ok(sent instanceof Error, 'the current PC refused it');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(B.db.get('SELECT 1 FROM messages WHERE id = ?', fake), undefined, 'no forged message');
  assert.notEqual(B.db.get('SELECT name FROM users WHERE id = ?', b.id).name, 'HACKED', 'profile unchanged');
  assert.notEqual(B.db.get('SELECT dm FROM privacy WHERE user = ?', b.id)?.dm, 'everyone', 'privacy unchanged');
  const inc = join(B.vault._paths.vdir, 'incoming');
  assert.deepEqual(existsSync(inc) ? readdirSync(inc).filter((n) => n.endsWith('.part')) : [], [], 'no bytes stored');
  assert.match(String(sent.message), /didn’t take the file/);
  // (3) Even when asked by hand, the current PC can't give its file to a pending key.
  assert.match(await b.refused('vault.send'), /Approve the move on this PC first/);
  assert.equal(B.db.get("SELECT 1 FROM vault_meta WHERE k LIKE 'sent:%'"), undefined, 'nothing sent');
  assert.equal(B2.db.get('SELECT 1 FROM messages WHERE id = ?', m), undefined, 'nothing arrived');
  // Stop on the old PC: nothing was taken, nothing to undo.
  await B.peer.cancelRebind?.();
});

test('the old PC was off during the move: it delivers later, as the old key, once it starts', async () => {
  const { B, a, b, gb, m } = await friends('xf_alice2', 'xf_bob2');
  await B.vault.write();
  const dir = B.dataDir;
  await off(B, b);
  const { B2, b2 } = await newPcFor(gb);
  await until(() => B2.vault.status().waiting, 8000, 'the new PC waits');
  await registry.clock.advance(72 * 3600_000 + 1000); // the move completes without the old PC
  await until(() => B2.peer.identity.self().state === 'ok', 10_000, 'move done');
  assert.equal(B2.db.get('SELECT 1 FROM messages WHERE id = ?', m), undefined, 'nothing yet');
  const Bback = await pc({ dataDir: dir }); // the old PC starts: the registry says it was moved away
  await until(() => Bback.peer.identity.self().state === 'revoked', 10_000, 'old PC learns it moved');
  await b2.next('vault.xfer', (d) => d.state === 'imported', 20_000);
  assert.equal(B2.db.get('SELECT text FROM messages WHERE id = ?', m).text, 'remember this');
  assert.equal(B2.db.get('SELECT state FROM friends WHERE user = ? AND other = ?', b2.id, a.id).state, 'friends');
});

test('“Send to my other device” with no other PC connected waits 15 s, then says so', async () => {
  const A = await pc();
  const a = await signUp(A, registry, (gh += 1), 'xf_alone');
  await until(() => A.vault.status().file, 8000, 'file');
  const t0 = Date.now();
  assert.match(await a.refused('vault.send'), /Your other PC isn’t connected/);
  assert.ok(Date.now() - t0 >= 14_000, 'waited for it');
});
