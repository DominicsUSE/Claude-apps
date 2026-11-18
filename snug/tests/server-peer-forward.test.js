// Snug 0.13: forwarding a whole message into a conversation with friends on other
// PCs. The forwarded card (who wrote it, when, its text, a sticker) and its copied
// attachments reach the friends' PCs, in direct conversations and in groups.
// A 0.11 or 0.12.0 PC, which doesn't know forwarded cards, gets the same frame and
// reads its text: the note, the quoted message and who wrote it, with the files.
process.env.SNUG_GROUP_FWD_MS = '200';
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, crc32 } from 'node:zlib';
import { startRegistry, until, mid } from './helpers/p2p.js';
import { threePcs, uidOf } from './helpers/groups.js';
import { dmIdFor } from '../server/peercrypto.js';

let registry;
const pcs = [];
test.before(async () => { registry = await startRegistry(); });
test.after(async () => { for (const s of pcs) await s.close().catch(() => {}); await registry.close(); });

function png(w, h, rgb = [0x60, 0x80, 0xa0]) {
  const chunk = (t, d) => { const b = Buffer.alloc(8 + d.length + 4); b.writeUInt32BE(d.length, 0); b.write(t, 4, 'latin1'); d.copy(b, 8); b.writeUInt32BE(crc32(Buffer.concat([Buffer.from(t, 'latin1'), d])), 8 + d.length); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: w }, () => Buffer.from(rgb)))]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}
async function upload(s, c, conv, body) {
  const res = await fetch(`${s.base}/api/files?conv=${conv}`, { method: 'POST', headers: { cookie: c.cookie, origin: s.base, 'content-type': 'image/png', 'x-file-name': 'photo.png' }, body });
  assert.equal(res.status, 201, await res.clone().text());
  return res.json();
}
const row = (s, id) => s.db.get('SELECT * FROM messages WHERE id = ?', id);
const fwdOf = (s, id) => JSON.parse(row(s, id)?.fwd || 'null');

let t, pic, src, grp;
test('a message with a picture, forwarded into a direct conversation with a friend on another PC: the card and the file arrive', async () => {
  t = await threePcs(registry, pcs, ['fwdana', 'fwdbea', 'fwdcal']);
  const { A, B, C, a, b, c } = t;
  // Cal sends Ana a photo; Ana forwards it to Bea, with a note.
  const ac = dmIdFor(uidOf(a), uidOf(c));
  assert.equal((await c.ok('dm.open', { users: [a.id] })).id, ac);
  pic = png(64, 48, [9, 120, 200]);
  const up = await upload(C, c, ac, pic);
  src = mid();
  await c.ok('msg.send', { conv: ac, id: src, text: 'the glaze came out blue', files: [{ id: up.id, w: 64, h: 48 }] });
  await until(() => row(A, src) && JSON.parse(A.db.get('SELECT meta FROM files WHERE id = ?', JSON.parse(row(A, src).files)[0].id).meta).have === 1, 10_000, 'the photo on Ana’s PC');
  const ab = dmIdFor(uidOf(a), uidOf(b));
  await a.ok('dm.open', { users: [b.id] });
  const id = mid();
  // Ana's PC writes the frame in a form a 0.11 or 0.12.0 PC also reads: watch what goes into her outbox.
  const sent = [];
  const basePush = A.peer._outbox.push;
  A.peer._outbox.push = (user, kind, ref, body, at) => { if (kind === 'dm.msg') sent.push(JSON.parse(body)); return basePush(user, kind, ref, body, at); };
  await a.ok('msg.forward', { conv: ac, id: src, to: ab, newId: id, comment: 'look at this' });
  const got = await b.next('msg', (d) => d.m.id === id, 10_000);
  A.peer._outbox.push = basePush;
  assert.equal(got.m.text, 'look at this');
  assert.equal(got.m.fwd.text, 'the glaze came out blue');
  assert.equal(got.m.fwd.name, 'fwdcal', 'who wrote it, by name (Bea’s PC doesn’t know Cal)');
  assert.equal(got.m.fwd.ts, row(A, src).ts);
  assert.equal(got.m.files.length, 1);
  // Stored, and the bytes come from Ana's PC.
  assert.equal(fwdOf(B, id).text, 'the glaze came out blue');
  const fid = JSON.parse(row(B, id).files)[0].id;
  await until(() => JSON.parse(B.db.get('SELECT meta FROM files WHERE id = ?', fid).meta).have === 1, 10_000, 'the photo on Bea’s PC');
  const res = await fetch(`${B.base}/api/files/${fid}`, { headers: { cookie: b.cookie } });
  assert.equal(res.status, 200);
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(pic));
  // The form an older PC reads: the note, the quoted message, who wrote it; the file as usual.
  const f = sent.find((x) => x.id === id);
  assert.ok(f, 'the frame was queued');
  assert.equal(f.text, 'look at this\n\n> the glaze came out blue\n— fwdcal, forwarded');
  assert.equal(f.note, 'look at this');
  assert.equal(f.files.length, 1);
  // Search on Bea's PC finds the forwarded words.
  assert.match(row(B, id).fold, /glaze/);
});

test('forwarding Bea’s own message back to her, with no note: her PC shows her as who wrote it', async () => {
  const { A, B, a, b } = t;
  const ab = dmIdFor(uidOf(a), uidOf(b));
  const orig = mid();
  await b.ok('msg.send', { conv: ab, id: orig, text: 'meet at the studio' });
  await until(() => row(A, orig), 10_000, 'Bea’s message on Ana’s PC');
  const id = mid();
  await a.ok('msg.forward', { conv: ab, id: orig, to: ab, newId: id });
  await until(() => row(B, id), 10_000, 'the forward on Bea’s PC');
  assert.equal(row(B, id).text, '');
  assert.equal(fwdOf(B, id).author, b.id);
  assert.equal(fwdOf(B, id).text, 'meet at the studio');
});

test('forwarding into a group across PCs: every member’s PC gets the card and the picture', async () => {
  const { A, B, C, a, b, c } = t;
  const g = grp = (await a.ok('dm.open', { users: [b.id, c.id] })).id;
  const all = [a.id, b.id, c.id].sort().join();
  const members = (s) => s.db.all('SELECT user FROM dm_members WHERE dm = ? ORDER BY user', g).map((r) => r.user).join();
  await until(() => members(B) === all && members(C) === all, 12_000, 'group on every PC');
  const ac = dmIdFor(uidOf(a), uidOf(c));
  const id = mid();
  await a.ok('msg.forward', { conv: ac, id: src, to: g, newId: id, comment: 'for everyone' });
  await until(() => row(B, id) && row(C, id), 12_000, 'the forward on every PC');
  for (const s of [B, C]) {
    assert.equal(row(s, id).text, 'for everyone');
    assert.equal(fwdOf(s, id).text, 'the glaze came out blue');
    assert.equal(JSON.parse(row(s, id).files).length, 1);
  }
  // Cal wrote it: his own PC shows him.
  assert.equal(fwdOf(C, id).author, c.id);
  const fid = JSON.parse(row(B, id).files)[0].id;
  await until(() => JSON.parse(B.db.get('SELECT meta FROM files WHERE id = ?', fid).meta).have === 1, 12_000, 'the photo on Bea’s PC');
});

test('a forwarded card from a friend’s PC only carries a real account when this PC holds that person’s message', async () => {
  const { A, B, b, c } = t;
  assert.ok(B.db.get('SELECT 1 FROM users WHERE id = ?', c.id), 'Bea’s PC knows Cal from the group');
  // A modified PC sends Bea a "forward" of words Cal never wrote, and of words she never wrote.
  const send = (fwd) => {
    const id = mid();
    A.peer._outbox.push(b.id, 'dm.msg', id, JSON.stringify({ id, text: `> ${fwd.text}\n— x, forwarded`, note: '', fwd }), Date.now());
    A.peer._links.want(uidOf(b));
    return id;
  };
  const cal = send({ a: uidOf(c), name: 'Cal (really)', ts: Date.now() - 3600_000, text: 'I owe Ana 500' });
  const bea = send({ a: uidOf(b), name: 'fwdbea', ts: Date.now() - 3600_000, text: 'I said Ana can have my car' });
  await until(() => row(B, cal) && row(B, bea), 12_000, 'on Bea’s PC');
  assert.equal(fwdOf(B, cal).author, null, 'not shown as Cal’s account');
  assert.equal(fwdOf(B, cal).name, 'Cal (really)', 'only the name the other PC gave');
  assert.equal(fwdOf(B, bea).author, null, 'not shown as Bea herself');
  // Words Cal did write in the group, which Bea's PC holds, keep his account and the time he wrote them.
  const said = mid();
  await c.ok('msg.send', { conv: grp, id: said, text: 'kiln opens at nine' });
  await until(() => row(B, said), 12_000, 'Cal’s group message on Bea’s PC');
  const real = send({ a: uidOf(c), name: 'fwdcal', ts: 1, text: 'kiln opens at nine' });
  await until(() => row(B, real), 12_000, 'the true one on Bea’s PC');
  assert.equal(fwdOf(B, real).author, c.id);
  assert.equal(fwdOf(B, real).ts, row(B, said).ts);
});
