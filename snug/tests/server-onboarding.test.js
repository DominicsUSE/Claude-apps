// Getting in, on the real server: an invitation preview says why a link
// doesn't work (unknown, expired, used up, turned off), /api/me says which
// Snug this is, and the Messages list comes newest activity first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';

const dir = mkdtempSync(join(tmpdir(), 'snug-onboarding-'));
let srv, base;
test.before(async () => { srv = await startServer({ port: 0, dataDir: dir, quiet: true }); base = `http://127.0.0.1:${srv.port}`; });
test.beforeEach(() => srv.resetLimits());
test.after(async () => { await srv.close(); rmSync(dir, { recursive: true, force: true }); });

const post = (path, body, cookie) => fetch(base + path, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
});
let n = 0;
const mid = () => `m_ob${Date.now().toString(36)}${(n++).toString(36)}xx`;

class Client {
  static async make(handle) {
    const res = await post('/api/register', { handle, name: handle, password: 'a long password' });
    assert.equal(res.status, 201, await res.clone().text());
    const c = new Client();
    c.cookie = res.headers.get('set-cookie').split(';')[0];
    c.id = (await res.json()).user.id;
    await c.connect();
    return c;
  }
  connect() {
    this.acks = new Map(); this.seq = 0;
    this.ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { cookie: this.cookie, origin: base } });
    return new Promise((resolve, reject) => {
      this.ws.on('error', reject);
      this.ws.on('message', (buf) => {
        const m = JSON.parse(buf);
        if (m.t === 'hello') { this.hello = m.d; resolve(this); } else if (m.t === 'ack') this.acks.get(m.id)?.(m);
      });
    });
  }
  async reconnect() { this.ws.close(); await this.connect(); return this.hello; }
  op(op, d = {}) { const id = ++this.seq; this.ws.send(JSON.stringify({ t: 'op', id, op, d })); return new Promise((r) => this.acks.set(id, r)); }
  async ok(op, d) { const a = await this.op(op, d); assert.equal(a.ok, true, `${op}: ${a.error}`); return a.d; }
  close() { this.ws.close(); }
}

const preview = async (code) => { const r = await fetch(`${base}/api/invite/${code}`); return { status: r.status, body: await r.json() }; };

test('invitation previews say why a link does not work, and a good one still shows the house', async () => {
  const ava = await Client.make('ava_ob');
  const bo = await Client.make('bo_ob');
  try {
    const { house } = await ava.ok('house.create', { name: 'Clay', hue: 25 });
    const good = await ava.ok('invite.create', { house });
    const ok = await preview(good.code);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.house.name, 'Clay');

    const unknown = await preview('notarealcode99');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.reason, 'unknown');
    assert.match(unknown.body.error, /doesn’t match any invitation/);

    const once = await ava.ok('invite.create', { house, maxUses: 1 });
    await bo.ok('invite.accept', { code: once.code });
    const used = await preview(once.code);
    assert.equal(used.status, 404);
    assert.equal(used.body.reason, 'used');

    const off = await ava.ok('invite.create', { house });
    await ava.ok('invite.revoke', { house, code: off.code });
    assert.equal((await preview(off.code)).body.reason, 'revoked');

    const old = await ava.ok('invite.create', { house });
    srv.db.run('UPDATE invites SET expires = ? WHERE code = ?', Date.now() - 1000, old.code);
    const expired = await preview(old.code);
    assert.equal(expired.body.reason, 'expired');
    assert.match(expired.body.error, /expired/);
  } finally { ava.close(); bo.close(); }
});

test('/api/me says which version of Snug this server runs', async () => {
  const res = await post('/api/register', { handle: 'ver_ob', name: 'Ver', password: 'a long password' });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const me = await (await fetch(`${base}/api/me`, { headers: { cookie } })).json();
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(me.version, pkg.version);
});

test('the Messages list comes newest activity first, and each conversation says when it started', async () => {
  const me = await Client.make('me_ob');
  const x = await Client.make('x_ob');
  const y = await Client.make('y_ob');
  try {
    await x.ok('friend.request', { user: me.id });
    await me.ok('friend.request', { user: x.id });
    await y.ok('friend.request', { user: me.id });
    await me.ok('friend.request', { user: y.id });
    const withX = (await me.ok('dm.open', { users: [x.id] })).id;
    await new Promise((r) => setTimeout(r, 5));
    const withY = (await me.ok('dm.open', { users: [y.id] })).id;
    // Started later, so Y comes first while nobody has written.
    let snap = await me.reconnect();
    assert.deepEqual(snap.dmOrder.filter((d) => [withX, withY].includes(d)), [withY, withX]);
    assert.ok(snap.dms[withX].created > 0, 'created is sent');
    await me.ok('msg.send', { conv: withX, id: mid(), text: 'hello X' });
    snap = await me.reconnect();
    assert.deepEqual(snap.dmOrder.filter((d) => [withX, withY].includes(d)), [withX, withY], 'the one with the newest message first');
  } finally { me.close(); x.close(); y.close(); }
});
