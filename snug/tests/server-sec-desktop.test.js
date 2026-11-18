// sec-desktop D10: in the desktop app, GitHub sign-in answers only the app's own window. Other programs and
// other OS accounts on the same PC reach 127.0.0.1 too; only the window holds the per-launch resume cookie.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startRegistry, startPc } from './helpers/p2p.js';

let registry;
const pcs = [];
before(async () => { registry = await startRegistry(); });
after(async () => { for (const p of pcs) await p.close().catch(() => {}); await registry.close(); });
async function pc(extra) { const p = await startPc(registry, extra); pcs.push(p); return p; }

async function call(srv, method, path, { cookie, body } = {}) {
  const res = await fetch(`${srv.base}${path}`, {
    method,
    headers: { origin: srv.base, ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const SECRET = 'per-launch-secret-0123456789abcdefghij';

test('desktop (ghWindowOnly): start, wait, claim, check and cancel need the window\'s cookie; config shows nothing without it', async () => {
  const p = await pc({ resumeSecret: SECRET, ghWindowOnly: true });
  const window = `snug_resume=${SECRET}`;
  // Another program on this PC: no cookie, or a guess.
  for (const cookie of [undefined, 'snug_resume=guess']) {
    assert.equal((await call(p, 'POST', '/api/gh/start', { cookie, body: {} })).status, 403);
    assert.equal((await call(p, 'POST', '/api/gh/claim', { cookie, body: { flow: 'x', username: 'mallory' } })).status, 403);
    assert.equal((await call(p, 'POST', '/api/gh/wait', { cookie, body: { flow: 'x' } })).status, 403);
    assert.equal((await call(p, 'POST', '/api/gh/cancel', { cookie, body: { flow: 'x' } })).status, 403);
    assert.equal((await call(p, 'GET', '/api/gh/check?name=mallory', { cookie })).status, 403);
    assert.deepEqual((await call(p, 'GET', '/api/gh/config', { cookie })).data, { enabled: false });
  }
  // The window itself.
  assert.equal((await call(p, 'GET', '/api/gh/config', { cookie: window })).data.enabled, true);
  const s = await call(p, 'POST', '/api/gh/start', { cookie: window, body: {} });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.match(s.data.userCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
});

test('without ghWindowOnly (a server run by hand, the existing tests) nothing changes', async () => {
  const p = await pc({ resumeSecret: SECRET });
  assert.equal((await call(p, 'POST', '/api/gh/start', { body: {} })).status, 200);
  assert.equal((await call(p, 'GET', '/api/gh/config')).data.enabled, true);
});
