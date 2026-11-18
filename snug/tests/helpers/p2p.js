// Two (or more) Snug servers on one machine, each its own "PC", with a local
// registry and mock GitHub (registry/dev.js). Used by tests/server-peer.test.js.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../../server/index.js';
import { createSession, sessionCookie } from '../../server/auth.js';
import { startLocalRegistry } from '../../registry/dev.js';

export const OWNER_GH = 900001; // the fake owner id the local registry is started with

export async function startRegistry() {
  return startLocalRegistry({ env: { OWNER_GITHUB_IDS: String(OWNER_GH) } });
}

// One PC: a server with its own data folder, pointed at the registry.
export async function startPc(registry, { dataDir = mkdtempSync(join(tmpdir(), 'snug-pc-')), ...extra } = {}) {
  const srv = await startServer({
    port: 0, dataDir, quiet: true, ringMs: 4000, voiceGraceMs: 300,
    registryUrl: registry.url, githubClientId: registry.github.clientId, githubBase: registry.github.url,
    peerIdleMs: 4000, ...extra,
  });
  srv.dataDir = dataDir;
  srv.base = `http://127.0.0.1:${srv.port}`;
  return srv;
}

// What server/ghauth.js does after GitHub sign-in on a fresh PC: token -> registry
// ticket -> claim -> the local owner row (u_<uid>) -> peer_self -> peer.start().
export async function signUp(srv, registry, ghId, username) {
  const token = registry.github.issueToken({ id: ghId });
  const auth = await srv.peer.reg.authGithub(token);
  assert.equal(auth.status, 'new', JSON.stringify(auth));
  const { account } = await srv.peer.reg.claim(auth.ticket, username);
  const id = `u_${account.uid}`;
  srv.db.run("INSERT INTO users (id, handle, name, pass, hue, created) VALUES (?, ?, ?, '!', 200, ?)", id, account.username, account.username, Date.now());
  srv.peer.identity.setSelf({ uid: account.uid, username: account.username, user: id, kver: account.kver, state: 'ok' });
  srv.peer.start();
  return clientFor(srv, id);
}

// Sign in on a PC whose account is already set up (after a restart).
export async function clientFor(srv, id) {
  const token = createSession(srv.db, id, 'test');
  const c = new Client(srv, sessionCookie(token, {}).split(';')[0], id);
  await c.connect();
  return c;
}

// A plain password account on a PC (a LAN guest).
export async function guest(srv, handle) {
  const res = await fetch(`${srv.base}/api/register`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: srv.base },
    body: JSON.stringify({ handle, name: handle, password: 'a long password' }),
  });
  assert.equal(res.status, 201);
  const c = new Client(srv, res.headers.get('set-cookie').split(';')[0], (await res.json()).user.id);
  await c.connect();
  return c;
}

export class Client {
  constructor(srv, cookie, id) { this.srv = srv; this.cookie = cookie; this.id = id; }
  connect() {
    this.events = [];
    this.acks = new Map();
    this.seq = 0;
    this.ws = new WebSocket(`ws://127.0.0.1:${this.srv.port}/ws`, { headers: { cookie: this.cookie, origin: this.srv.base } });
    return new Promise((resolve, reject) => {
      this.ws.on('error', reject);
      this.ws.on('message', (buf) => {
        const m = JSON.parse(buf);
        if (m.t === 'hello') { this.hello = m.d; resolve(this); } else if (m.t === 'ack') this.acks.get(m.id)?.(m);
        else if (m.t === 'ev') { this.events.push(m); this.waiter?.(); }
      });
    });
  }
  op(op, d = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ t: 'op', id, op, d }));
    return new Promise((r) => this.acks.set(id, r));
  }
  async ok(op, d) { const a = await this.op(op, d); assert.equal(a.ok, true, `${op}: ${a.error}`); return a.d; }
  async refused(op, d) { const a = await this.op(op, d); assert.equal(a.ok, false, `${op} should be refused`); return a.error; }
  async next(ev, pred = () => true, ms = 8000) {
    const end = Date.now() + ms;
    for (;;) {
      const i = this.events.findIndex((e) => e.ev === ev && pred(e.d));
      if (i >= 0) return this.events.splice(i, 1)[0].d;
      if (Date.now() > end) throw new Error(`no "${ev}" event arrived`);
      await new Promise((r) => { this.waiter = r; setTimeout(r, 50); });
    }
  }
  has(ev, pred = () => true) { return this.events.some((e) => e.ev === ev && pred(e.d)); }
  close() { return new Promise((r) => { if (this.ws.readyState > 1) return r(); this.ws.on('close', r); this.ws.close(); return undefined; }); }
}

// Test-only waiting: check a condition until it holds.
export async function until(fn, ms = 8000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

let n = 0;
export const mid = () => `m_p2p${String(++n).padStart(6, '0')}${Math.random().toString(36).slice(2, 8)}`;
