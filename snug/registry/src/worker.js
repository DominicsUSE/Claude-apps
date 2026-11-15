// Snug registry Worker. Thin front door: path allowlist, body cap, uid shape check, then the single Hub DO.
import { Hub } from './hub.js';
import { now } from './platform.js';
import { gifWorker } from './gif.js'; // 0.12: GIF search and files, stateless (never the Hub)

export { Hub };

const MAX_BODY = 16 * 1024;
const UID_RE = /^[a-z2-7]{16}$/;

const ROUTES = {
  '/v1/auth/github': 'POST',
  '/v1/claim': 'POST',
  '/v1/rebind': 'POST',
  '/v1/rebind/approve': 'POST',
  '/v1/rebind/cancel': 'POST',
  '/v1/rename': 'POST',
  '/v1/release': 'POST',
  '/v1/lookup': 'POST',
  '/v1/turn': 'POST',
  '/v1/admin': 'POST', // v0.10: admin actions (signed, permission-checked in the Hub)
  '/v1/vault/key': 'POST', // v0.10: the account's data file key
  '/v1/vault/rotate': 'POST', // sec-registry REG-L1: a new data file key (the old ones stay readable)
  '/v1/notices': 'GET', // v0.10: announcements + minimum app version (public)
  '/v1/check': 'GET',
  '/v1/gif/token': 'POST', // 0.12: a short-lived token for GIF search (signed, budgeted in the Hub)
  '/v1/ws': 'GET',
};

function json(env, status, obj) {
  const t = now(env);
  return new Response(JSON.stringify(status >= 400 ? { ...obj, now: t } : obj), {
    status,
    headers: { 'content-type': 'application/json', 'x-snug-now': String(t) },
  });
}

const err = (env, status, code) => json(env, status, { error: code, message: code });

/**
 * The body, read with a running byte cap: a chunked body with no Content-Length is cut off at the first chunk
 * past the cap instead of being buffered whole first (sec-registry hardening). null when it is too big.
 */
async function readCapped(req, max) {
  if (!req.body) return new ArrayBuffer(0);
  const reader = req.body.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      try { await reader.cancel(); } catch { /* gone */ }
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out.buffer;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === '/v1/health') return json(env, 200, { ok: true, v: 3 });
    // 0.12: /v1/gif/search and /v1/gif/file are answered here, with a token from /v1/gif/token.
    const gif = await gifWorker(req, env, ctx, (status, obj) => json(env, status, obj), now(env));
    if (gif) return gif;
    const method = ROUTES[path];
    if (!method) return err(env, 404, 'not_found');
    if (req.method !== method) return err(env, 405, 'bad_request');

    if (path === '/v1/ws') {
      if ((req.headers.get('upgrade') || '').toLowerCase() !== 'websocket') return err(env, 426, 'bad_request');
      if (!UID_RE.test(url.searchParams.get('uid') || '')) return err(env, 400, 'bad_request');
      return env.HUB.get(env.HUB.idFromName(env.HUB_NAME || 'hub')).fetch(req);
    }

    let body;
    if (method === 'POST') {
      if (Number(req.headers.get('content-length') || 0) > MAX_BODY) return err(env, 413, 'bad_request');
      body = await readCapped(req, MAX_BODY);
      if (!body) return err(env, 413, 'bad_request');
    }
    const fwd = new Request(url.toString(), { method, headers: req.headers, body });
    return env.HUB.get(env.HUB.idFromName(env.HUB_NAME || 'hub')).fetch(fwd);
  },
};
