// The browser's side of big uploads (js/lib/upload.js), against an in-memory
// stand-in for the server's /api/uploads: parts in order, progress, resuming
// after a dropped part and after the server says "carry on from here", cancel,
// and the size limit checked before anything is sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadBlob, needsChunks, limitText } from '../js/lib/upload.js';

const MB = 1024 * 1024;
// A tiny server: one upload at a time, chunk size `chunk`, with hooks to break things.
function fakeServer({ chunk = 64 * 1024, maxFile = 100 * MB, breakOn = new Set(), stale = new Set() } = {}) {
  const st = { calls: [], parts: [], up: null, cancelled: false, done: null };
  const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
  st.fetch = async (url, init = {}) => {
    const u = new URL(url, 'http://x');
    const method = init.method || 'GET';
    st.calls.push(`${method} ${u.pathname}${u.search}`);
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (u.pathname === '/api/uploads' && method === 'GET') return reply(200, { maxFile, chunk });
    if (u.pathname === '/api/uploads' && method === 'POST') {
      const d = JSON.parse(init.body);
      st.up = { id: 'u_test00000001', size: d.size, data: new Uint8Array(d.size), received: 0, name: d.name, type: d.type, conv: d.conv };
      return reply(201, { id: st.up.id, chunk, received: 0 });
    }
    if (u.pathname === `/api/uploads/${st.up?.id}` && method === 'GET') return reply(200, { id: st.up.id, size: st.up.size, received: st.up.received, chunk });
    if (u.pathname === `/api/uploads/${st.up?.id}/cancel`) { st.cancelled = true; return reply(200, {}); }
    if (u.pathname === `/api/uploads/${st.up?.id}/done`) {
      if (st.up.received !== st.up.size) return reply(409, { error: 'not finished', received: st.up.received });
      st.done = st.up.data;
      return reply(201, { id: 'f_done00000001', name: st.up.name, size: st.up.size, kind: 'file' });
    }
    if (u.pathname === `/api/uploads/${st.up?.id}` && method === 'POST') {
      const offset = Number(u.searchParams.get('offset'));
      const n = st.parts.length;
      if (breakOn.has(n)) { breakOn.delete(n); st.parts.push({ offset, dropped: true }); throw new TypeError('Failed to fetch'); }
      if (stale.has(n)) { stale.delete(n); st.parts.push({ offset, stale: true }); return reply(409, { error: 'out of order', received: st.up.received }); }
      if (offset !== st.up.received) return reply(409, { error: 'out of order', received: st.up.received });
      const bytes = new Uint8Array(await init.body.arrayBuffer());
      st.up.data.set(bytes, offset);
      st.up.received += bytes.length;
      st.parts.push({ offset, len: bytes.length });
      return reply(200, { received: st.up.received });
    }
    return reply(404, { error: 'Not found' });
  };
  return st;
}
const blobOf = (n) => new Blob([Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) & 255)], { type: 'application/zip' });
const noWait = () => Promise.resolve();

test('needsChunks: small files go in one request, big ones in parts; limits read in MB', () => {
  assert.equal(needsChunks(5 * MB), false);
  assert.equal(needsChunks(8 * MB), false);
  assert.equal(needsChunks(8 * MB + 1), true);
  assert.equal(limitText(100 * MB), '100 MB');
  assert.equal(limitText(600 * 1024), '600 KB');
  assert.equal(limitText(2048 * MB), '2 GB');
});

test('uploadBlob: parts go in order, progress climbs to 1, the file comes back whole', async () => {
  const s = fakeServer();
  const blob = blobOf(200 * 1024 + 5);
  const seen = [];
  const f = await uploadBlob({ fetch: s.fetch, conv: 'r_1', blob, name: 'big.zip', onProgress: (p) => seen.push(p), wait: noWait });
  assert.equal(f.id, 'f_done00000001');
  assert.deepEqual(s.parts.map((p) => p.offset), [0, 65536, 131072, 196608]);
  assert.deepEqual(Buffer.from(s.done), Buffer.from(new Uint8Array(await blob.arrayBuffer())));
  assert.ok(seen.every((p, i) => i === 0 || p >= seen[i - 1]), 'progress never goes back');
  assert.equal(seen.at(-1), 1);
  assert.equal(s.up.type, 'application/zip');
});

test('uploadBlob: a dropped part is sent again from where the server got to', async () => {
  const s = fakeServer({ breakOn: new Set([1]), stale: new Set([3]) });
  const blob = blobOf(200 * 1024);
  const f = await uploadBlob({ fetch: s.fetch, conv: 'r_1', blob, name: 'cut.zip', wait: noWait });
  assert.equal(f.size, blob.size);
  assert.deepEqual(Buffer.from(s.done), Buffer.from(new Uint8Array(await blob.arrayBuffer())));
  assert.ok(s.calls.includes('GET /api/uploads/u_test00000001'), 'it asked the server where to carry on');
  assert.equal(s.parts.filter((p) => p.dropped).length, 1);
});

test('uploadBlob: gives up after repeated failures with a clear message, and cancels on the server', async () => {
  const s = fakeServer({ breakOn: new Set(Array.from({ length: 40 }, (_, i) => i + 1)) });
  await assert.rejects(uploadBlob({ fetch: s.fetch, conv: 'r_1', blob: blobOf(200 * 1024), name: 'flaky.zip', wait: noWait }), /flaky\.zip.*connection/);
  assert.equal(s.cancelled, true, 'the half upload is not left on the server');
});

test('uploadBlob: Cancel stops it and tells the server', async () => {
  const s = fakeServer();
  const ctl = new AbortController();
  const p = uploadBlob({ fetch: s.fetch, conv: 'r_1', blob: blobOf(300 * 1024), name: 'stop.zip', signal: ctl.signal, onProgress: (x) => { if (x > 0.3) ctl.abort(); }, wait: noWait });
  await assert.rejects(p, (e) => e.name === 'AbortError');
  assert.equal(s.cancelled, true);
  assert.equal(s.done, null);
});

test('uploadBlob: over the server’s limit is refused before a byte is sent', async () => {
  const s = fakeServer({ maxFile: 100 * 1024 });
  await assert.rejects(uploadBlob({ fetch: s.fetch, conv: 'r_1', blob: blobOf(100 * 1024 + 1), name: 'huge.zip', limits: { maxFile: 100 * 1024, chunk: 64 * 1024 }, wait: noWait }), /huge\.zip is 100 KB.*up to 100 KB/);
  assert.deepEqual(s.calls, []);
});

// review-media 8: a 409 that doesn't move the offset (the server still writing the last part) waits and
// backs off instead of asking again at once, and gives up after a while.
test('uploadBlob: a 409 that leaves the offset where it was backs off, and gives up in the end', async () => {
  const s = fakeServer({ chunk: 64 * 1024, stale: new Set([0, 1]) });
  const waits = [];
  const f = await uploadBlob({ fetch: s.fetch, conv: 'r_1', blob: blobOf(100 * 1024), name: 'a.zip', limits: { maxFile: 100 * MB, chunk: 64 * 1024 }, wait: async (n) => { waits.push(n); } });
  assert.equal(f.id, 'f_done00000001');
  assert.deepEqual(waits, [1, 2], 'each stale reply waited longer');
  // A server that keeps saying "still writing": no tight loop, a clear message.
  const stuck = fakeServer({ chunk: 64 * 1024, stale: new Set(Array.from({ length: 100 }, (_, i) => i)) });
  let n = 0;
  await assert.rejects(uploadBlob({ fetch: stuck.fetch, conv: 'r_1', blob: blobOf(100 * 1024), name: 'b.zip', limits: { maxFile: 100 * MB, chunk: 64 * 1024 }, wait: async () => { n++; } }), /stopped uploading/);
  assert.ok(stuck.parts.length < 20, `asked ${stuck.parts.length} times`);
  assert.ok(n > 0);
  assert.equal(stuck.cancelled, true);
});
