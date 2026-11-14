// Local registry for tests, e2e and development: the real Worker fetch handler and Hub DO, run in plain
// Node over registry/shim.js (node:sqlite), behind a Node http + ws server. No Cloudflare, no GitHub.
//
//   import { startLocalRegistry } from '../registry/dev.js';
//   const reg = await startLocalRegistry();                 // starts its own mock GitHub
//   reg.url, reg.github.authorize(code, {id}), await reg.clock.advance(72 * 3600e3), await reg.close()
//
// CLI: node registry/dev.js [port]   (prints the registry and mock GitHub URLs)
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import worker, { Hub } from './src/worker.js';
import { DEFAULT_LIMITS } from './src/limits.js';
import { createRuntime } from './shim.js';
import { startMockGithub } from './mock-github.js';

const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'proxy-connection', 'te', 'trailer', 'host', 'cf-connecting-ip']);

/** Per-IP limits x1000 and per-uid connect/auth caps x10: many test users share 127.0.0.1. */
export function relaxedLimits() {
  const out = {};
  for (const [k, [n, ms]] of Object.entries(DEFAULT_LIMITS)) {
    if (k.startsWith('ip')) out[k] = [n * 1000, ms];
    else if (k === 'authGlobal' || k === 'connect') out[k] = [n * 10, ms];
  }
  return out;
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > max) {
        reject(new Error('too big'));
        req.destroy();
      } else parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

/**
 * startLocalRegistry(opts) -> Promise<{url, port, close(), env, clock:{now(), advance(ms)}, github, runtime}>
 *   port=0            listen port (0 = free port), on 127.0.0.1
 *   env={}            extra/override Worker env (e.g. OWNER_GITHUB_IDS: '900001', TURN_KEY_ID ...)
 *   githubMock        an object from startMockGithub() to use (alias: github); default: start our own
 *   limits='relaxed'  'relaxed' (default; see relaxedLimits), 'production' (real limits) or an object of overrides
 *   trustClientIp     honour an incoming cf-connecting-ip header (tests that simulate many IPs)
 *   dbPath=':memory:' node:sqlite path
 */
export async function startLocalRegistry(opts = {}) {
  const { port = 0, env: userEnv = {}, limits = 'relaxed', trustClientIp = false, dbPath = ':memory:' } = opts;
  let github = opts.githubMock || opts.github || null;
  let ownGithub = false;
  if (!github && !userEnv.GITHUB_API) {
    github = await startMockGithub();
    ownGithub = true;
  }
  const env = {
    GH_HMAC_SECRET: 'dev-secret-not-for-production-0123456789',
    GITHUB_API: github ? github.url : undefined,
    GITHUB_CLIENT_ID: github?.clientId || 'Iv1.test',
    GH_CLIENT_SECRET: github?.clientSecret || 'test-secret',
    OWNER_GITHUB_IDS: '900001',
    RELAY_OFF_AT: '60000',
    ...userEnv,
  };
  if (limits === 'relaxed') env.TEST_LIMITS = { ...relaxedLimits(), ...(userEnv.TEST_LIMITS || {}) };
  else if (limits && typeof limits === 'object') env.TEST_LIMITS = limits;
  const rt = createRuntime({ env, Hub, dbPath });

  const toRequest = (req, body) => {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP.has(k) && v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    }
    const ip = (trustClientIp && req.headers['cf-connecting-ip']) || req.socket.remoteAddress || '';
    headers.set('cf-connecting-ip', String(ip).replace(/^::ffff:/, ''));
    return new Request(`http://127.0.0.1:${server.address().port}${req.url}`, {
      method: req.method, headers, body: body && body.length ? body : undefined,
    });
  };

  const server = http.createServer(async (req, res) => {
    try {
      const body = req.method === 'GET' || req.method === 'HEAD' ? null : await readBody(req, 1 << 20);
      const r = await worker.fetch(toRequest(req, body), rt.env, { waitUntil() {} });
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, { ...Object.fromEntries(r.headers), 'content-length': buf.length });
      res.end(buf);
    } catch {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"server_error"}');
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  server.on('upgrade', async (req, socket, head) => {
    try {
      const r = await worker.fetch(toRequest(req, null), rt.env, { waitUntil() {} });
      if (r.status === 101 && r.webSocket?.__shimClient) {
        wss.handleUpgrade(req, socket, head, (ws) => rt.bridge(r.webSocket.server, ws));
        return;
      }
      const buf = Buffer.from(await r.arrayBuffer());
      socket.end(`HTTP/1.1 ${r.status} ${http.STATUS_CODES[r.status] || ''}\r\ncontent-type: application/json\r\n`
        + `x-snug-now: ${r.headers.get('x-snug-now') || ''}\r\ncontent-length: ${buf.length}\r\nconnection: close\r\n\r\n${buf}`);
    } catch {
      socket.destroy();
    }
  });

  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  let closing = null;
  return {
    url,
    port: server.address().port,
    env: rt.env,
    clock: rt.clock,
    github,
    runtime: rt,
    close() {
      closing ||= (async () => {
        for (const c of wss.clients) c.terminate();
        rt.close();
        server.closeAllConnections?.();
        await new Promise((r) => server.close(() => r()));
        if (ownGithub) await github.close();
      })();
      return closing;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const reg = await startLocalRegistry({ port: Number(process.argv[2] || process.env.PORT || 8787) });
  console.log(`snug registry (local) on ${reg.url}`);
  console.log(`mock GitHub on ${reg.github.url}  (client id ${reg.github.clientId}; fake owner GitHub id 900001)`);
  const stop = () => reg.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
