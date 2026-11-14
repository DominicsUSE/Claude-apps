// Mock GitHub (github.com device flow + api.github.com app-token endpoints) on one local port.
// Test/dev only. Behaves like GitHub where it matters to Snug:
//  - 403 for any request without a User-Agent;
//  - device endpoints answer JSON only with `Accept: application/json`, otherwise form-encoded;
//  - tokens are bound to the OAuth app that issued them; DELETE revokes.
// Also serves a fake Cloudflare TURN credentials endpoint at /turn/:keyId/credentials/generate.
import http from 'node:http';
import { randomBytes } from 'node:crypto';

const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
const rand = (n, alphabet) => [...randomBytes(n)].map((b) => alphabet[b % alphabet.length]).join('');

function readBody(req) {
  return new Promise((resolve) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      const text = Buffer.concat(parts).toString('utf8');
      if (!text) return resolve({});
      if ((req.headers['content-type'] || '').includes('json')) {
        try {
          return resolve(JSON.parse(text) || {});
        } catch {
          return resolve({});
        }
      }
      return resolve(Object.fromEntries(new URLSearchParams(text)));
    });
  });
}

/**
 * startMockGithub({port=0, clientId='Iv1.test', clientSecret='test-secret', turnToken='turn-token'})
 *   -> Promise<{url, clientId, clientSecret, close(), authorize(userCode,{id}), deny(userCode),
 *               issueToken({id, clientId?}) -> token, calls}>
 */
export async function startMockGithub({ port = 0, clientId = 'Iv1.test', clientSecret = 'test-secret', turnToken = 'turn-token' } = {}) {
  const flows = new Map(); // device_code -> flow
  const byUser = new Map(); // user_code -> flow
  const tokens = new Map(); // token -> {id, clientId, revoked}
  const calls = [];
  let url = '';

  const issueToken = ({ id, clientId: cid = clientId }) => {
    const token = `gho_${rand(36, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789')}`;
    tokens.set(token, { id, clientId: cid, revoked: false });
    return token;
  };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const body = await readBody(req);
    const ua = req.headers['user-agent'] || null;
    const auth = req.headers.authorization || '';
    const bearer = /^(?:Bearer|token) (.+)$/i.exec(auth)?.[1] || null;
    calls.push({
      method: req.method, path: u.pathname, ua, accept: req.headers.accept || null,
      apiVersion: req.headers['x-github-api-version'] || null,
      scope: body.scope ?? null, clientId: body.client_id ?? null, token: body.access_token || bearer || null,
    });
    const send = (status, obj, type = 'application/json') => {
      const text = type === 'application/json' ? JSON.stringify(obj) : new URLSearchParams(obj).toString();
      res.writeHead(status, { 'content-type': type });
      res.end(status === 204 ? undefined : text);
    };
    const oauth = (obj) => send(200, obj, (req.headers.accept || '').includes('application/json') ? 'application/json' : 'application/x-www-form-urlencoded');

    if (!ua) return send(403, { message: 'Request forbidden by administrative rules. Please make sure your request has a User-Agent header.' });

    if (req.method === 'POST' && u.pathname === '/login/device/code') {
      if (!body.client_id) return oauth({ error: 'unauthorized_client' });
      const flow = {
        device_code: rand(40, 'abcdef0123456789'), user_code: `${rand(4, ALNUM)}-${rand(4, ALNUM)}`,
        client_id: body.client_id, scope: body.scope ?? null, state: 'pending', id: null, exp: Date.now() + 900_000,
      };
      flows.set(flow.device_code, flow);
      byUser.set(flow.user_code, flow);
      return oauth({ device_code: flow.device_code, user_code: flow.user_code, verification_uri: `${url}/login/device`, expires_in: 900, interval: 1 });
    }
    if (req.method === 'POST' && u.pathname === '/login/oauth/access_token') {
      if (body.grant_type !== 'urn:ietf:params:oauth:grant-type:device_code') return oauth({ error: 'unsupported_grant_type' });
      const flow = flows.get(body.device_code);
      if (!flow || flow.client_id !== body.client_id) return oauth({ error: 'incorrect_device_code' });
      if (flow.exp < Date.now()) return oauth({ error: 'expired_token' });
      if (flow.state === 'denied') return oauth({ error: 'access_denied' });
      if (flow.state !== 'ok') return oauth({ error: 'authorization_pending' });
      flows.delete(flow.device_code);
      byUser.delete(flow.user_code);
      return oauth({ access_token: issueToken({ id: flow.id, clientId: flow.client_id }), token_type: 'bearer', scope: '' });
    }
    if (u.pathname === '/login/device') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<!doctype html><title>Mock GitHub</title><p>Mock GitHub device page.</p>');
    }
    const app = /^\/applications\/([^/]+)\/token$/.exec(u.pathname);
    if (app && (req.method === 'POST' || req.method === 'DELETE')) {
      const cid = decodeURIComponent(app[1]);
      const basic = /^Basic (.+)$/.exec(auth)?.[1];
      const creds = basic ? Buffer.from(basic, 'base64').toString() : '';
      if (cid !== clientId || creds !== `${clientId}:${clientSecret}`) return send(404, { message: 'Not Found' });
      const t = tokens.get(body.access_token);
      if (!t || t.revoked || t.clientId !== cid) return send(404, { message: 'Not Found' });
      if (req.method === 'DELETE') {
        t.revoked = true;
        return send(204, null);
      }
      return send(200, { id: 1, token: body.access_token, app: { client_id: cid, name: 'Snug', url: 'http://x' }, user: { id: t.id, login: 'hidden' }, scopes: [] });
    }
    if (req.method === 'GET' && u.pathname === '/user') {
      const t = bearer && tokens.get(bearer);
      if (!t || t.revoked) return send(401, { message: 'Bad credentials' });
      return send(200, { id: t.id, login: 'hidden' });
    }
    const turn = /^\/turn\/([^/]+)\/credentials\/generate$/.exec(u.pathname);
    if (turn && req.method === 'POST') {
      if (bearer !== turnToken) return send(401, { success: false });
      return send(201, { iceServers: { urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:3478?transport=tcp', 'turns:turn.cloudflare.com:5349?transport=tcp'], username: 'mock-user', credential: 'mock-cred' } });
    }
    return send(404, { message: 'Not Found' });
  });

  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    clientId,
    clientSecret,
    calls,
    issueToken,
    authorize(userCode, { id }) {
      const f = byUser.get(userCode);
      if (!f) throw new Error(`mock github: unknown user code ${userCode}`);
      f.state = 'ok';
      f.id = id;
    },
    deny(userCode) {
      const f = byUser.get(userCode);
      if (!f) throw new Error(`mock github: unknown user code ${userCode}`);
      f.state = 'denied';
    },
    close: () => new Promise((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    }),
  };
}
