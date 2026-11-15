// End-to-end encryption test helpers: a signed-in person with sockets against
// the real server, and an encryption "device" made from the real js/lib/e2ee
// modules (keys kept in memory, like js/e2ee/store.js memStore()).
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { b64u, b64uOf, random } from '../../js/lib/e2ee/bytes.js';
import { canon } from '../../js/lib/e2ee/canon.js';
import * as sig from '../../js/lib/e2ee/sig.js';
import * as obj from '../../js/lib/e2ee/objects.js';
import * as backup from '../../js/lib/e2ee/backup.js';
import { newRecoveryKey, deriveBackupKey } from '../../js/lib/recovery.js';

export const PW = 'a long password';

export function web(srv) {
  const base = `http://127.0.0.1:${srv.port}`;
  const post = (path, body, cookie) => fetch(base + path, {
    method: 'POST', headers: { origin: base, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body || {}),
  });
  return { base, post };
}

export class Sock {
  constructor(srv, cookie) { this.srv = srv; this.cookie = cookie; }
  connect() {
    this.events = []; this.acks = new Map(); this.seq = 0;
    const base = `http://127.0.0.1:${this.srv.port}`;
    this.ws = new WebSocket(`ws://127.0.0.1:${this.srv.port}/ws`, { headers: { cookie: this.cookie, origin: base } });
    return new Promise((resolve, reject) => {
      this.ws.on('error', reject);
      this.ws.on('close', (code) => { this.closed = code; this.waiter?.(); });
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
  async refused(op, d, re) { const a = await this.op(op, d); assert.equal(a.ok, false, `${op} should be refused`); if (re) assert.match(a.error, re); return a; }
  async next(ev, pred = () => true, ms = 2000) {
    const end = Date.now() + ms;
    for (;;) {
      const i = this.events.findIndex((e) => e.ev === ev && pred(e.d));
      if (i >= 0) return this.events.splice(i, 1)[0].d;
      if (Date.now() > end) throw new Error(`no "${ev}" event arrived`);
      await new Promise((r) => { this.waiter = r; setTimeout(r, 50); });
    }
  }
  async none(ev, pred = () => true, ms = 250) {
    await new Promise((r) => setTimeout(r, ms));
    assert.equal(this.events.some((e) => e.ev === ev && pred(e.d)), false, `unexpected "${ev}" event`);
  }
  close() { return new Promise((r) => { if (this.ws.readyState === 3) return r(); this.ws.on('close', r); this.ws.close(); return undefined; }); }
}

export async function register(srv, handle) {
  const { post } = web(srv);
  const res = await post('/api/register', { handle, name: handle, password: PW });
  assert.equal(res.status, 201, await res.clone().text());
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const id = (await res.json()).user.id;
  return { id, handle, cookie };
}
export async function login(srv, handle) {
  const { post } = web(srv);
  const res = await post('/api/login', { handle, password: PW });
  assert.equal(res.status, 200, await res.clone().text());
  return res.headers.get('set-cookie').split(';')[0];
}

// One device's keys, in memory.
export async function newDevice(u, { label = 'Test browser', kind = 'web' } = {}) {
  const d = obj.newDeviceId();
  const dsk = await sig.newSigningPair(false);
  const dskPub = b64u(await sig.rawPublic(dsk.publicKey));
  const dev = { u, d, dsk, dskPub, label, kind, prekeys: {}, kid: 0 };
  await nextPrekey(dev);
  return dev;
}
export async function nextPrekey(dev, ts = Date.now()) {
  const pair = await sig.newDhPair(false);
  dev.kid += 1;
  const signed = await obj.makePrekey(dev.dsk.privateKey, { u: dev.u, d: dev.d, kid: dev.kid, pub: b64u(await sig.rawPublic(pair.publicKey)), ts });
  dev.prekeys[dev.kid] = { pair, signed };
  return signed;
}
export const deviceEntry = (dev, added = Date.now()) => ({ d: dev.d, dsk: dev.dskPub, kind: dev.kind, label: dev.label, added });
export const devicePublic = (dev) => ({ d: dev.d, dsk: dev.dskPub, label: dev.label, kind: dev.kind });

// A first device turning encryption on: what e2ee.setup sends, and what the account keeps.
export async function setupPayload(u, dev, { history = true } = {}) {
  const asb = await backup.newAsb(u, { history });
  const keys = await backup.loadAsb(asb);
  const rk = await newRecoveryKey();
  const bk = await deriveBackupKey(rk.raw);
  asb.bk = b64u(bk);
  const arc = history ? { e: 1, pub: asb.ahk[1].pub, at: Date.now() } : null;
  const devlist = await obj.makeList(keys.aik, { u, ver: 1, aik: keys.aikPub, devs: [deviceEntry(dev)], arc });
  const meta = await backup.sealMeta(backup.emptyMeta(), keys.sync, { u, ver: 1 });
  return {
    acct: { asb, keys, rk, bk, list: devlist },
    payload: { devlist, device: devicePublic(dev), prekey: dev.prekeys[dev.kid].signed, backup: await backup.sealBackup(asb, bk, { ver: 1, aik: keys.aikPub }), meta, hist: history },
  };
}

export async function bindSig(dev, nonce) {
  return b64u(await sig.signBytes(dev.dsk.privateKey, new TextEncoder().encode(`snug-e2ee-v1/bind\n${dev.u}\n${dev.d}\n${nonce}`)));
}
export async function bind(sock, dev) {
  return sock.ok('e2ee.bind', { d: dev.d, sig: await bindSig(dev, sock.hello.e2ee.nonce) });
}

/** The next signed list: `change(list)` returns the new devs/arc. */
export async function nextList(acct, change) {
  const cur = acct.list;
  const next = { u: cur.u, ver: cur.ver + 1, aik: cur.aik, devs: cur.devs, arc: cur.arc, ...change(cur) };
  acct.list = await obj.makeList(acct.keys.aik, next);
  return acct.list;
}

export { b64u, b64uOf, random, canon, sig, obj, backup };
