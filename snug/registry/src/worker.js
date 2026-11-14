// Snug registry Worker. Thin front door: path allowlist, body cap, uid shape check, then the single Hub DO.
import { Hub } from './hub.js';
import { now } from './platform.js';

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
  '/v1/check': 'GET',
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

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === '/v1/health') return json(env, 200, { ok: true, v: 2 });
    const method = ROUTES[path];
    if (!method) return err(env, 404, 'not_found');
    if (req.method !== method) return err(env, 405, 'bad_request');

    if (path === '/v1/ws') {
      if ((req.headers.get('upgrade') || '').toLowerCase() !== 'websocket') return err(env, 426, 'bad_request');
      if (!UID_RE.test(url.searchParams.get('uid') || '')) return err(env, 400, 'bad_request');
      return env.HUB.get(env.HUB.idFromName('hub')).fetch(req);
    }

    let body;
    if (method === 'POST') {
      if (Number(req.headers.get('content-length') || 0) > MAX_BODY) return err(env, 413, 'bad_request');
      body = await req.arrayBuffer();
      if (body.byteLength > MAX_BODY) return err(env, 413, 'bad_request');
    }
    const fwd = new Request(url.toString(), { method, headers: req.headers, body });
    return env.HUB.get(env.HUB.idFromName('hub')).fetch(fwd);
  },
};
