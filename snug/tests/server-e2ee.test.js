// End-to-end encryption on the real server (server/e2ee.js and the hooks it
// uses), with real sockets. The clients use the real js/lib/e2ee modules
// (tests/helpers/e2ee.js). Encryption is off by default; these servers turn it on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/index.js';
import { UserError } from '../server/ops.js';
import { Sock, register, web } from './helpers/e2ee.js';

const dirs = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'snug-e2ee-')); dirs.push(d); return d; };
let srv;
test.before(async () => { srv = await startServer({ port: 0, dataDir: tmp(), quiet: true, e2ee: true }); });
test.beforeEach(() => srv.resetLimits());
test.after(async () => { await srv.close(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const person = async (handle) => { const p = await register(srv, handle); p.sock = await new Sock(srv, p.cookie).connect(); return p; };

// ---------- step 2: hooks the encryption module builds on ----------
test('GET /api/version is public and names the protocol', async () => {
  const res = await fetch(`${web(srv).base}/api/version`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
  const v = await res.json();
  assert.deepEqual({ proto: v.proto, minClient: v.minClient, e2ee: v.e2ee }, { proto: 12, minClient: 12, e2ee: 1 });
  assert.match(v.version, /^\d+\.\d+\.\d+/);
  const off = await startServer({ port: 0, dataDir: tmp(), quiet: true, e2ee: false });
  try { assert.equal((await (await fetch(`http://127.0.0.1:${off.port}/api/version`)).json()).e2ee, 0); } finally { await off.close(); }
});

test('a refusal can carry a code and data in its ack; plain refusals stay as they were', async () => {
  const p = await person('e2-ack');
  srv.hub.ops['test.refuse'] = (c, d) => { throw d.plain ? new UserError('Plain no.') : new UserError('Keys changed.', { code: 'e2ee_stale', data: { users: { u_x: { ver: 2 } } } }); };
  try {
    const a = await p.sock.op('test.refuse', {});
    assert.deepEqual(a, { t: 'ack', id: a.id, ok: false, error: 'Keys changed.', code: 'e2ee_stale', data: { users: { u_x: { ver: 2 } } } });
    const b = await p.sock.op('test.refuse', { plain: true });
    assert.deepEqual(b, { t: 'ack', id: b.id, ok: false, error: 'Plain no.' });
  } finally { delete srv.hub.ops['test.refuse']; await p.sock.close(); }
});

test('hub.socketView lets one socket get its own copy of an event; unset, every socket gets the same', async () => {
  const p = await person('e2-view');
  const second = await new Sock(srv, p.cookie).connect();
  p.sock.ws.mark = 'one';
  for (const set of [p.sock, second]) set.events.length = 0;
  const serverSide = [...(srv.hub.socketsOf?.(p.id) || [])];
  assert.equal(serverSide.length, 2, 'hub.socketsOf lists a person’s sockets');
  serverSide[0].mark = 'first';
  const prev = srv.hub.socketView;
  srv.hub.socketView = (ws, ev, d) => (ev === 'test.ev' ? { ...d, mine: ws.mark || 'other' } : d);
  try {
    srv.hub.toUser(p.id, 'test.ev', { a: 1 });
    const got = [await p.sock.next('test.ev'), await second.next('test.ev')].map((d) => d.mine).sort();
    assert.deepEqual(got, ['first', 'other']);
    srv.hub.socketView = () => { throw new Error('broken hook'); };
    srv.hub.toUser(p.id, 'test.ev', { a: 2 });
    assert.deepEqual(await p.sock.next('test.ev'), { a: 2 }, 'a failing hook falls back to the shared event');
  } finally { srv.hub.socketView = prev; await second.close(); await p.sock.close(); }
});

