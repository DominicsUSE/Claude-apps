// Shared test helpers for the registry tests (not a test file itself).
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startLocalRegistry } from '../dev.js';

export const HOUR = 3600_000;
export const DAY = 24 * HOUR;
export const OWNER_ID = 900001; // fake owner GitHub id (the real one never appears in the repo)

export function makeKeys() {
  const ed = crypto.generateKeyPairSync('ed25519');
  const x = crypto.generateKeyPairSync('x25519');
  const raw = (k) => k.export({ format: 'jwk' }).x;
  return {
    ik: raw(ed.publicKey),
    xk: raw(x.publicKey),
    sign: (s) => crypto.sign(null, Buffer.from(s, 'utf8'), ed.privateKey).toString('base64url'),
  };
}

export function verify(ik, sig, msg) {
  const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: ik }, format: 'jwk' });
  return crypto.verify(null, Buffer.from(msg, 'utf8'), key, Buffer.from(sig, 'base64url'));
}

export async function start(opts = {}) {
  const reg = await startLocalRegistry(opts);
  let lastTs = 0;
  reg.ts = () => (lastTs = Math.max(reg.clock.now(), lastTs + 1));
  /** HTTP call; asserts every response carries x-snug-now. */
  reg.call = async (path, body, { method = body === undefined ? 'GET' : 'POST', ip } = {}) => {
    const headers = { 'content-type': 'application/json' };
    if (ip) headers['cf-connecting-ip'] = ip;
    const res = await fetch(reg.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    assert.match(res.headers.get('x-snug-now') || '', /^\d{13}$/, `x-snug-now missing on ${path}`);
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, body: json, headers: res.headers };
  };
  reg.auth = (k, token, opt) => {
    const ts = reg.ts();
    return reg.call('/v1/auth/github', { token, ik: k.ik, xk: k.xk, ts, sig: k.sign(`snug-reg-v1\nauth\n${k.ik}\n${k.xk}\n${ts}`) }, opt);
  };
  reg.authId = (k, ghId, opt) => reg.auth(k, reg.github.issueToken({ id: ghId }), opt);
  reg.claim = (k, ticket, username, opt) => {
    const ts = reg.ts();
    return reg.call('/v1/claim', { ticket, username, ts, sig: k.sign(`snug-reg-v1\nclaim\n${ticket}\n${username}\n${ts}`) }, opt);
  };
  reg.signUp = async (ghId, username, k = makeKeys()) => {
    const a = await reg.authId(k, ghId);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const c = await reg.claim(k, a.body.ticket, username);
    assert.equal(c.status, 200, JSON.stringify(c.body));
    return { uid: c.body.account.uid, k, account: c.body.account, ghId };
  };
  reg.signed = (path, k, fields, parts) => {
    const ts = reg.ts();
    return reg.call(path, { ...fields, ts, sig: k.sign(['snug-reg-v1', ...parts(ts)].join('\n')) });
  };
  reg.rename = (u, username) => reg.signed('/v1/rename', u.k, { uid: u.uid, username }, (ts) => ['rename', u.uid, username, ts]);
  reg.lookup = (u, q) => reg.signed('/v1/lookup', u.k, { uid: u.uid, q }, (ts) => ['lookup', u.uid, ts, q.name ?? q.uid]);
  reg.wsUrl = (uid) => `${reg.url.replace('http', 'ws')}/v1/ws?uid=${uid}`;
  reg.signAuth = (uid, k) => (c) => ({ t: 'auth', uid, sig: k.sign(`snug-reg-v1\nsignal\n${uid}\n${c.n}`) });
  /** Open a signal socket. auth: true (sign with k), false (no auth frame), or a function(challenge) -> frame. */
  reg.connect = async (uid, k, { auth = true } = {}) => {
    const s = await openSocket(reg.wsUrl(uid));
    s.challenge = await s.next((m) => m.t === 'challenge');
    if (auth === true) {
      s.send({ t: 'auth', uid, sig: k.sign(`snug-reg-v1\nsignal\n${uid}\n${s.challenge.n}`) });
      s.ready = await s.next((m) => m.t === 'ready');
    } else if (typeof auth === 'function') s.send(auth(s.challenge));
    return s;
  };
  return reg;
}

export function openSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const q = [];
    let wake = null;
    let isClosed = false;
    const s = {
      ws,
      q,
      closed: new Promise((r) => ws.on('close', (code, reason) => {
        isClosed = true;
        wake?.();
        r({ code, reason: String(reason) });
      })),
      send: (obj) => ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)),
      close: () => ws.close(),
      async next(pred = () => true, ms = 3000) {
        const until = Date.now() + ms;
        for (;;) {
          const i = q.findIndex(pred);
          if (i >= 0) return q.splice(i, 1)[0];
          if (isClosed) throw new Error(`socket closed while waiting; queue: ${JSON.stringify(q).slice(0, 400)}`);
          const left = until - Date.now();
          if (left <= 0) throw new Error(`timeout waiting for frame; queue: ${JSON.stringify(q).slice(0, 400)}`);
          await new Promise((r) => {
            wake = r;
            setTimeout(r, left);
          });
        }
      },
      /** Wait `ms` and assert nothing matching arrived. */
      async none(pred, ms = 150) {
        await new Promise((r) => setTimeout(r, ms));
        assert.equal(q.filter(pred).length, 0, `unexpected frame: ${JSON.stringify(q.filter(pred))}`);
      },
    };
    ws.on('message', (d) => {
      const t = String(d);
      q.push(t === 'pong' ? { t: 'pong' } : JSON.parse(t));
      wake?.();
    });
    ws.on('open', () => resolve(s));
    ws.on('unexpected-response', (req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    ws.on('error', (e) => reject(e));
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
