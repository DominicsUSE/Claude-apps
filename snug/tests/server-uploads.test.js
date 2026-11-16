// Big files (server/uploads.js): chunked, resumable uploads streamed to disk,
// the per-file limit (SNUG_MAX_FILE_MB, 100 MB by default), per-person and
// per-house quotas, the free-disk floor, type checks after assembly, the
// single-request upload with no 10 MB cap, and the sweep of abandoned uploads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';
import { uploadLimits } from '../server/uploads.js';

const MB = 1024 * 1024;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a20000000049454e44ae426082', 'hex');

// Two servers: one with the default limits, one small enough to hit every limit quickly.
const dirA = mkdtempSync(join(tmpdir(), 'snug-up-a-'));
const dirB = mkdtempSync(join(tmpdir(), 'snug-up-b-'));
let A, B;
const disk = { free: 500 * 1024 * MB };
test.before(async () => {
  A = await startServer({ port: 0, dataDir: dirA, quiet: true, uploads: { statfs: () => ({ bavail: Math.floor(disk.free / 4096), bsize: 4096 }) } });
  B = await startServer({ port: 0, dataDir: dirB, quiet: true, uploads: { maxFile: 600 * 1024, chunk: 64 * 1024, quota: 1000 * 1024, houseQuota: 1500 * 1024, diskFloor: 0 } });
});
test.beforeEach(() => { A.resetLimits(); B.resetLimits(); disk.free = 500 * 1024 * MB; });
test.after(async () => { await A.close(); await B.close(); rmSync(dirA, { recursive: true, force: true }); rmSync(dirB, { recursive: true, force: true }); });

const baseOf = (s) => `http://127.0.0.1:${s.port}`;
let hn = 0;
async function person(s, p = 'up') {
  const base = baseOf(s);
  const res = await fetch(`${base}/api/register`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ handle: `${p}${++hn}`, name: `Up ${hn}`, password: 'a long password' }) });
  assert.equal(res.status, 201, await res.clone().text());
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`, { headers: { cookie, origin: base } });
  const acks = new Map(); let seq = 0;
  await new Promise((r) => ws.on('message', (buf) => { const m = JSON.parse(buf); if (m.t === 'hello') r(); else if (m.t === 'ack') acks.get(m.id)?.(m); }));
  const op = (o, d = {}) => { const id = ++seq; ws.send(JSON.stringify({ t: 'op', id, op: o, d })); return new Promise((r) => acks.set(id, r)); };
  const json = (method, path, body) => fetch(base + path, { method, headers: { cookie, origin: base, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const chunk = (id, offset, bytes) => fetch(`${base}/api/uploads/${id}?offset=${offset}`, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/octet-stream' }, body: bytes });
  const room = (await op('house.create', { name: `Files ${hn}`, hue: 20 })).d;
  return { cookie, base, op, json, chunk, room: room.room, house: room.house, close: () => ws.close() };
}
// Sends a whole buffer in chunk-sized parts, in order.
async function sendAll(p, id, data, size) {
  for (let o = 0; o < data.length; o += size) {
    const r = await p.chunk(id, o, data.subarray(o, o + size));
    assert.equal(r.status, 200, await r.clone().text());
  }
}

test('limits come from SNUG_MAX_FILE_MB and friends; host mode allows 100 MB by default', () => {
  const d = uploadLimits({});
  assert.equal(d.maxFile, 100 * MB);
  assert.equal(d.chunk, 4 * MB);
  assert.equal(d.quota, 2048 * MB);
  assert.equal(d.houseQuota, 10240 * MB);
  assert.equal(d.diskFloor, 1024 * MB);
  const e = uploadLimits({ SNUG_MAX_FILE_MB: '250', SNUG_QUOTA_MB: '5000', SNUG_HOUSE_QUOTA_MB: '0', SNUG_DISK_FLOOR_MB: '200' });
  assert.equal(e.maxFile, 250 * MB);
  assert.equal(e.quota, 5000 * MB);
  assert.equal(e.houseQuota, 0, '0 means no house quota');
  assert.equal(e.diskFloor, 200 * MB);
  assert.equal(uploadLimits({ SNUG_MAX_FILE_MB: 'lots' }).maxFile, 100 * MB, 'nonsense falls back to the default');
});

test('chunked upload: parts in order, assembled on disk, typed by its bytes, then sent like any file', async () => {
  const p = await person(A);
  const cfg = await (await p.json('GET', '/api/uploads')).json();
  assert.equal(cfg.maxFile, 100 * MB);
  assert.equal(cfg.chunk, 4 * MB);
  const data = Buffer.concat([PNG, randomBytes(9 * MB)]);
  const begin = await p.json('POST', '/api/uploads', { conv: p.room, name: 'big picture.png', size: data.length, type: 'image/png' });
  assert.equal(begin.status, 201, await begin.clone().text());
  const { id, chunk, received } = await begin.json();
  assert.match(id, /^u_[a-z0-9]+$/);
  assert.equal(chunk, 4 * MB);
  assert.equal(received, 0);
  await sendAll(p, id, data, chunk);
  assert.deepEqual(await (await p.json('GET', `/api/uploads/${id}`)).json(), { id, size: data.length, received: data.length, chunk });
  const done = await p.json('POST', `/api/uploads/${id}/done`);
  assert.equal(done.status, 201, await done.clone().text());
  const f = await done.json();
  assert.match(f.id, /^f_/);
  assert.equal(f.size, data.length);
  assert.equal(f.kind, 'image');
  assert.equal(f.name, 'big picture.png');
  const back = Buffer.from(await (await fetch(`${p.base}/api/files/${f.id}`, { headers: { cookie: p.cookie } })).arrayBuffer());
  assert.ok(back.equals(data), 'the bytes come back exactly');
  const sent = await p.op('msg.send', { conv: p.room, id: 'm_bigfile00000001', text: '', files: [{ id: f.id, w: 1, h: 1 }] });
  assert.equal(sent.ok, true, sent.error);
  // Nothing of the upload is left over.
  assert.equal(readdirSync(join(dirA, 'files', 'partial')).length, 0);
  assert.equal((await p.json('GET', `/api/uploads/${id}`)).status, 404);
  p.close();
});

test('chunked upload: a wrong offset is refused with where to carry on; a part past the declared size is refused', async () => {
  const p = await person(B);
  const data = randomBytes(200 * 1024);
  const { id } = await (await p.json('POST', '/api/uploads', { conv: p.room, name: 'notes.bin', size: data.length, type: 'application/octet-stream' })).json();
  assert.equal((await p.chunk(id, 0, data.subarray(0, 64 * 1024))).status, 200);
  const skip = await p.chunk(id, 128 * 1024, data.subarray(128 * 1024, 192 * 1024));
  assert.equal(skip.status, 409, 'a part from later on is out of order');
  assert.equal((await skip.json()).received, 64 * 1024);
  const again = await p.chunk(id, 0, data.subarray(0, 64 * 1024));
  assert.equal(again.status, 409, 'a part already received is not written twice');
  const big = await p.chunk(id, 64 * 1024, Buffer.alloc(64 * 1024 + 1));
  assert.equal(big.status, 413, 'a part over the chunk size');
  const early = await p.json('POST', `/api/uploads/${id}/done`);
  assert.equal(early.status, 409, 'not finished yet');
  assert.match((await early.json()).error, /isn’t finished/);
  p.close();
});

test('chunked upload: a cut connection loses only that part, and the upload resumes where it stopped', async () => {
  const p = await person(B);
  const data = randomBytes(150 * 1024);
  const { id } = await (await p.json('POST', '/api/uploads', { conv: p.room, name: 'cut.bin', size: data.length, type: 'application/octet-stream' })).json();
  assert.equal((await p.chunk(id, 0, data.subarray(0, 64 * 1024))).status, 200);
  // Half of the second part, then the connection drops.
  await new Promise((resolve) => {
    const u = new URL(`${p.base}/api/uploads/${id}?offset=${64 * 1024}`);
    const req = request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers: { cookie: p.cookie, origin: p.base, 'content-type': 'application/octet-stream', 'content-length': 64 * 1024 } });
    req.on('error', () => resolve());
    req.write(data.subarray(64 * 1024, 96 * 1024));
    setTimeout(() => { req.destroy(); setTimeout(resolve, 100); }, 100);
  });
  const st = await (await p.json('GET', `/api/uploads/${id}`)).json();
  assert.equal(st.received, 64 * 1024, 'the broken part does not count');
  let o = st.received;
  while (o < data.length) {
    const r = await p.chunk(id, o, data.subarray(o, o + 64 * 1024));
    assert.equal(r.status, 200);
    o = (await r.json()).received;
  }
  const f = await (await p.json('POST', `/api/uploads/${id}/done`)).json();
  const back = Buffer.from(await (await fetch(`${p.base}/api/files/${f.id}`, { headers: { cookie: p.cookie } })).arrayBuffer());
  assert.ok(back.equals(data));
  p.close();
});

test('size refusals: over the per-file limit, chunked or in one request, with the limit in the message', async () => {
  const p = await person(B);
  const r = await p.json('POST', '/api/uploads', { conv: p.room, name: 'huge.zip', size: 600 * 1024 + 1, type: 'application/zip' });
  assert.equal(r.status, 413);
  assert.match((await r.json()).error, /up to 600 KB/);
  const one = await fetch(`${p.base}/api/files?conv=${p.room}`, { method: 'POST', headers: { cookie: p.cookie, origin: p.base, 'content-type': 'application/zip', 'x-file-name': 'huge.zip' }, body: Buffer.alloc(600 * 1024 + 1) });
  assert.equal(one.status, 413);
  assert.match((await one.json()).error, /up to 600 KB/);
  assert.equal((await p.json('POST', '/api/uploads', { conv: p.room, name: 'none', size: 0, type: 'text/plain' })).status, 400, 'empty files go the simple way');
  p.close();
});

test('the one-request upload is streamed to disk and no longer stops at 10 MB', async () => {
  const p = await person(A);
  const data = Buffer.concat([Buffer.from('GIF89a'), randomBytes(11 * MB)]);
  const r = await fetch(`${p.base}/api/files?conv=${p.room}`, { method: 'POST', headers: { cookie: p.cookie, origin: p.base, 'content-type': 'image/gif', 'x-file-name': 'eleven.gif' }, body: data });
  assert.equal(r.status, 201, await r.clone().text());
  const f = await r.json();
  assert.equal(f.size, data.length);
  assert.equal(f.kind, 'image');
  p.close();
});

test('quotas: a person over their quota, and a house over its quota, are refused with a clear message', async () => {
  const p = await person(B);
  const q = await person(B);
  const up = async (who, conv, size) => {
    const r = await who.json('POST', '/api/uploads', { conv, name: 'part.bin', size, type: 'application/octet-stream' });
    if (r.status !== 201) return r;
    const { id } = await r.json();
    await sendAll(who, id, randomBytes(size), 64 * 1024);
    return who.json('POST', `/api/uploads/${id}/done`);
  };
  assert.equal((await up(p, p.room, 500 * 1024)).status, 201);
  // An upload still in progress counts too, so two at once can't slip past.
  const half = await p.json('POST', '/api/uploads', { conv: p.room, name: 'more.bin', size: 400 * 1024, type: 'application/octet-stream' });
  assert.equal(half.status, 201);
  const over = await p.json('POST', '/api/uploads', { conv: p.room, name: 'more.bin', size: 200 * 1024, type: 'application/octet-stream' });
  assert.equal(over.status, 413);
  assert.match((await over.json()).error, /room for your files/);
  const single = await fetch(`${p.base}/api/files?conv=${p.room}`, { method: 'POST', headers: { cookie: p.cookie, origin: p.base, 'content-type': 'text/plain', 'x-file-name': 'a.txt' }, body: Buffer.alloc(200 * 1024, 97) });
  assert.equal(single.status, 413, 'the one-request path checks the quota too');
  await p.json('POST', `/api/uploads/${(await half.json()).id}/cancel`);
  // The house: q joins p's house; together they pass its 1500 KB.
  const { code } = (await p.op('invite.create', { house: p.house })).d;
  assert.equal((await q.op('invite.accept', { code })).ok, true);
  assert.equal((await up(p, p.room, 400 * 1024)).status, 201);
  assert.equal((await up(q, p.room, 500 * 1024)).status, 201);
  const full = await q.json('POST', '/api/uploads', { conv: p.room, name: 'last.bin', size: 300 * 1024, type: 'application/octet-stream' });
  assert.equal(full.status, 413);
  assert.match((await full.json()).error, /house is out of room/);
  // q's own house still has room.
  assert.equal((await up(q, q.room, 300 * 1024)).status, 201);
  p.close(); q.close();
});

test('free disk: big uploads are refused while the disk is nearly full', async () => {
  const p = await person(A);
  disk.free = 1024 * MB + 5 * MB;
  const r = await p.json('POST', '/api/uploads', { conv: p.room, name: 'big.bin', size: 20 * MB, type: 'application/octet-stream' });
  assert.equal(r.status, 507);
  assert.match((await r.json()).error, /nearly out of disk space/);
  const small = await p.json('POST', '/api/uploads', { conv: p.room, name: 'small.bin', size: 2 * MB, type: 'application/octet-stream' });
  assert.equal(small.status, 201, 'a file that still leaves the floor free is fine');
  p.close();
});

test('only the uploader can add to, read or finish an upload; a room they can’t post in refuses it', async () => {
  const p = await person(B);
  const q = await person(B);
  const { id } = await (await p.json('POST', '/api/uploads', { conv: p.room, name: 'mine.bin', size: 10, type: 'application/octet-stream' })).json();
  assert.equal((await q.chunk(id, 0, Buffer.alloc(10))).status, 404);
  assert.equal((await q.json('GET', `/api/uploads/${id}`)).status, 404);
  assert.equal((await q.json('POST', `/api/uploads/${id}/done`)).status, 404);
  assert.equal((await q.json('POST', `/api/uploads/${id}/cancel`)).status, 404);
  assert.equal((await q.json('POST', '/api/uploads', { conv: p.room, name: 'x', size: 10, type: 'text/plain' })).status, 403);
  // Cross-site requests are refused like every other state change.
  const cross = await fetch(`${p.base}/api/uploads/${id}?offset=0`, { method: 'POST', headers: { cookie: p.cookie, origin: 'https://evil.example', 'content-type': 'application/octet-stream' }, body: Buffer.alloc(10) });
  assert.equal(cross.status, 403);
  p.close(); q.close();
});

test('types are checked after assembly: a page named .png is stored as bytes; an encrypted blob stays opaque', async () => {
  const p = await person(B);
  const html = Buffer.from('<html><script>alert(1)</script></html>'.padEnd(70 * 1024, ' '));
  const { id } = await (await p.json('POST', '/api/uploads', { conv: p.room, name: 'photo.png', size: html.length, type: 'image/png' })).json();
  await sendAll(p, id, html, 64 * 1024);
  const f = await (await p.json('POST', `/api/uploads/${id}/done`)).json();
  assert.equal(f.kind, 'file');
  const got = await fetch(`${p.base}/api/files/${f.id}`, { headers: { cookie: p.cookie } });
  assert.equal(got.headers.get('content-type'), 'application/octet-stream');
  assert.match(got.headers.get('content-disposition'), /^attachment/);
  await got.arrayBuffer();
  // Ciphertext from an end-to-end encrypted conversation is just bytes, uploaded the same way.
  const blob = randomBytes(100 * 1024);
  const b = await (await p.json('POST', '/api/uploads', { conv: p.room, name: 'file', size: blob.length, type: 'application/octet-stream' })).json();
  await sendAll(p, b.id, blob, 64 * 1024);
  const e = await (await p.json('POST', `/api/uploads/${b.id}/done`)).json();
  assert.equal(e.kind, 'file');
  assert.equal(e.size, blob.length);
  p.close();
});

test('cancel removes the part file; uploads left alone for a day are swept, row and bytes', async () => {
  const p = await person(B);
  const a = await (await p.json('POST', '/api/uploads', { conv: p.room, name: 'gone.bin', size: 100 * 1024, type: 'application/octet-stream' })).json();
  await p.chunk(a.id, 0, randomBytes(64 * 1024));
  const partial = join(dirB, 'files', 'partial');
  assert.ok(existsSync(join(partial, a.id)));
  assert.equal((await p.json('POST', `/api/uploads/${a.id}/cancel`)).status, 200);
  assert.equal(existsSync(join(partial, a.id)), false);
  const b = await (await p.json('POST', '/api/uploads', { conv: p.room, name: 'left.bin', size: 100 * 1024, type: 'application/octet-stream' })).json();
  await p.chunk(b.id, 0, randomBytes(64 * 1024));
  assert.equal(B.sweepUploads(Date.now() + 3600_000), 0, 'an hour is not abandoned');
  assert.ok(B.sweepUploads(Date.now() + 25 * 3600_000) >= 1, 'this one and any other test’s leftovers');
  assert.equal(existsSync(join(partial, b.id)), false);
  assert.equal((await p.json('GET', `/api/uploads/${b.id}`)).status, 404);
  p.close();
});

// review-media 1: server-side copies (forwarding, GIF reuse) count against the same quota and disk floor.
test('copies made on the server (forward, GIF reuse) are held to the quota like uploads', async () => {
  const p = await person(B);
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(560 * 1024, 1)]);
  const up = await fetch(`${p.base}/api/files?conv=${p.room}`, { method: 'POST', headers: { cookie: p.cookie, origin: p.base, 'content-type': 'image/gif', 'x-file-name': 'big.gif' }, body: gif });
  assert.equal(up.status, 201, await up.clone().text());
  const f = await up.json();
  const sent = await p.op('msg.send', { conv: p.room, id: 'm_quotafwd0000001', text: '', files: [{ id: f.id }] });
  assert.equal(sent.ok, true, sent.error);
  // 560 KB stored of 1000 KB: a second copy would pass the quota.
  const use = await p.json('POST', '/api/gifs/use', { conv: p.room, file: f.id });
  assert.equal(use.status, 413, 'GIF reuse checks the quota');
  assert.match((await use.json()).error, /room for your files/);
  const fwd = await p.op('msg.forward', { conv: p.room, id: 'm_quotafwd0000001', to: p.room, newId: 'm_quotafwd0000002' });
  assert.equal(fwd.ok, false, 'forwarding a file checks the quota');
  assert.match(fwd.error, /room for your files/);
  p.close();
});

test('the free-disk floor counts bytes still owed to unfinished uploads', async () => {
  const p = await person(A);
  disk.free = 1024 * MB + 30 * MB;
  const a = await p.json('POST', '/api/uploads', { conv: p.room, name: 'a.bin', size: 20 * MB, type: 'application/octet-stream' });
  assert.equal(a.status, 201);
  const b = await p.json('POST', '/api/uploads', { conv: p.room, name: 'b.bin', size: 20 * MB, type: 'application/octet-stream' });
  assert.equal(b.status, 507, 'the first upload’s 20 MB is already promised');
  await p.json('POST', `/api/uploads/${(await a.json()).id}/cancel`);
  p.close();
});

test('a one-request upload still streaming counts against the quota', async () => {
  const p = await person(B);
  const size = 550 * 1024;
  const req = request(`${p.base}/api/files?conv=${p.room}`, { method: 'POST', headers: { cookie: p.cookie, origin: p.base, 'content-type': 'application/octet-stream', 'x-file-name': 'slow.bin', 'content-length': String(size) } });
  const done = new Promise((r) => { req.on('response', (res) => { res.resume(); res.on('end', () => r(res.statusCode)); }); req.on('error', () => r(0)); });
  req.write(Buffer.alloc(64 * 1024));
  await new Promise((r) => setTimeout(r, 150));
  const over = await p.json('POST', '/api/uploads', { conv: p.room, name: 'more.bin', size: 500 * 1024, type: 'application/octet-stream' });
  assert.equal(over.status, 413, 'the 550 KB still arriving is counted');
  req.end(Buffer.alloc(size - 64 * 1024));
  assert.equal(await done, 201);
  p.close();
});
