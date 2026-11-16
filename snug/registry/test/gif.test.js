// 0.12 GIF search through the registry (src/gif.js): tokens minted by the Hub
// for signed requests and budgeted per account; search and files answered by
// the Worker against a local stand-in for Openverse; only signed file
// addresses fetched; no redirect followed; GIF bytes only; off switch; the
// routes 0.11 clients use are unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { start, DAY } from './helpers.js';

const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(100, 2)]);
let mock, here;
const seen = [];
test.before(async () => {
  mock = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push({ path: u.pathname, ua: req.headers['user-agent'] || '' });
    if (u.pathname === '/v1/images/') {
      res.setHeader('content-type', 'application/json');
      const item = (id, url) => ({ id, title: `Wave ${id}`, url: url || `${here}/m/${id}.gif`, thumbnail: `${here}/m/${id}-t.gif`, creator: 'Ada', license: 'by', license_version: '4.0', foreign_landing_url: `https://example.org/${id}`, width: 100, height: 80 });
      res.end(JSON.stringify({ results: [item('w1'), item('hop', `${here}/m/hop`), item('page', `${here}/m/page`), item('big', `${here}/m/big`), { ...item('adult'), mature: true }] }));
    } else if (u.pathname === '/m/hop') { res.writeHead(302, { location: `${here}/m/w1.gif` }); res.end(); }
    else if (u.pathname === '/m/page') { res.end('<html>no</html>'); }
    else if (u.pathname === '/m/big') { res.end(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(10 * 1024 * 1024 + 1)])); }
    else if (u.pathname.endsWith('.gif')) { res.setHeader('content-type', 'image/gif'); res.end(GIF); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  here = `http://127.0.0.1:${mock.address().port}`;
});
test.after(() => new Promise((r) => mock.close(r)));

const mint = (reg, u, p = '{}') => {
  const ts = reg.ts();
  return reg.call('/v1/gif/token', { uid: u.uid, ts, p, sig: u.k.sign(`snug-reg-v1\ngif-token\n${u.uid}\n${ts}\n${p}`) });
};
const get = (reg, path, token) => fetch(reg.url + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });

test('gif token: only for a signed request from an account, an hour long, a few a day each', async () => {
  const reg = await start({ env: { GIF_OPENVERSE_BASE: 'http://127.0.0.1:1', TEST_LIMITS: { gifTokenDay: [2, DAY] } } });
  try {
    const u = await reg.signUp(950001, 'giftoken');
    const t = await mint(reg, u);
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.match(t.body.token, new RegExp(`^${u.uid}\\.\\d{13}\\.[0-9a-f]{64}$`));
    assert.equal(t.body.ttl, 3600);
    assert.deepEqual(t.body.sources, ['openverse']);
    const ts = reg.ts();
    assert.equal((await reg.call('/v1/gif/token', { uid: u.uid, ts, p: '{}', sig: u.k.sign(`snug-reg-v1\ngif-token\n${u.uid}\n${ts}\n{"x":1}`) })).status, 401, 'a signature over something else');
    assert.equal((await mint(reg, u)).status, 200);
    const third = await mint(reg, u);
    assert.equal(third.status, 429, 'the daily budget');
    assert.ok(third.body.retryAfter > 0);
  } finally { await reg.close(); }
});

test('gif search and files: through the Worker with a token; signed addresses only; credits kept; providers never reached by the client', async () => {
  const reg = await start({ env: { GIF_OPENVERSE_BASE: here, GIF_CONTACT: 'https://chat.example.org' } });
  try {
    const u = await reg.signUp(950002, 'gifsearch');
    const { token } = (await mint(reg, u)).body;
    assert.equal((await get(reg, '/v1/gif/search?q=wave')).status, 401, 'no token');
    assert.equal((await get(reg, '/v1/gif/search?q=wave', token.replace(/.$/, (c) => (c === '0' ? '1' : '0')))).status, 401, 'a forged token');
    const before = reg.runtime?.stats?.doRequests;
    seen.length = 0;
    const r = await get(reg, '/v1/gif/search?q=wave', token);
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.source, 'openverse');
    assert.equal(d.results.some((g) => g.id === 'adult'), false, 'mature results dropped');
    const w1 = d.results.find((g) => g.id === 'w1');
    assert.match(w1.url, /^\/v1\/gif\/file\?u=.+&s=[0-9a-f]{64}$/);
    assert.match(w1.preview, /^\/v1\/gif\/file\?/);
    assert.equal(w1.credit.text, 'Ada, CC BY 4.0, via Openverse');
    assert.equal(w1.credit.link, 'https://example.org/w1');
    assert.match(seen[0].ua, /^Snug-registry\/0\.12 \(GIF search for Snug desktop; https:\/\/chat\.example\.org\)$/);
    if (before !== undefined) assert.equal(reg.runtime.stats.doRequests, before, 'search never touches the Hub');
    const f = await get(reg, w1.url, token);
    assert.equal(f.status, 200);
    assert.equal(f.headers.get('content-type'), 'image/gif');
    assert.ok(Buffer.from(await f.arrayBuffer()).equals(GIF));
    // A signed address with another target, a redirect, not a GIF, too big.
    const forged = w1.url.replace(/u=[^&]+/, `u=${encodeURIComponent(`${here}/m/other.gif`)}`);
    assert.equal((await get(reg, forged, token)).status, 403);
    assert.equal((await get(reg, d.results.find((g) => g.id === 'hop').url, token)).status, 502, 'no redirect followed');
    assert.equal((await get(reg, d.results.find((g) => g.id === 'page').url, token)).status, 415);
    assert.equal((await get(reg, d.results.find((g) => g.id === 'big').url, token)).status, 413);
    assert.equal((await get(reg, w1.url)).status, 401, 'files need the token too');
    // An hour later the token has run out.
    await reg.clock.advance(3600_000 + 1000);
    assert.equal((await get(reg, '/v1/gif/search?q=wave', token)).status, 401);
  } finally { await reg.close(); }
});

test('gif search: per-token limit; GIF_PROVIDERS=off turns every gif route off; older routes answer as before', async () => {
  const reg = await start({ env: { GIF_OPENVERSE_BASE: here, TEST_LIMITS: { gifSearchHour: 2 } } });
  try {
    const u = await reg.signUp(950003, 'giflimit');
    const { token } = (await mint(reg, u)).body;
    assert.equal((await get(reg, '/v1/gif/search?q=a', token)).status, 200);
    assert.equal((await get(reg, '/v1/gif/search?q=b', token)).status, 200);
    assert.equal((await get(reg, '/v1/gif/search?q=c', token)).status, 429);
    assert.equal((await fetch(`${reg.url}/v1/gif/search?q=a`, { method: 'POST' })).status, 405);
    assert.deepEqual((await reg.call('/v1/health')).body, { ok: true, v: 3 });
    assert.equal((await reg.call('/v1/nothing-here')).status, 404);
  } finally { await reg.close(); }
  const off = await start({ env: { GIF_PROVIDERS: 'off' } });
  try {
    const u = await off.signUp(950004, 'gifoff');
    assert.equal((await mint(off, u)).status, 404);
    assert.equal((await get(off, '/v1/gif/search?q=a', 'x')).status, 404);
  } finally { await off.close(); }
});

// 0.14 fix. Openverse throttles anonymous calls by address, and every Cloudflare Worker reaches it from one
// shared address (cross-zone subrequests carry CF-Connecting-IP 2a06:98c0:3600::103), so anonymous search
// from the live registry is refused. This stand-in does the same: 429 unless the registry's own token comes.
function strictOpenverse() {
  const s = { calls: [], tokenCalls: [] };
  s.server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const auth = req.headers.authorization || '';
    s.calls.push({ path: u.pathname, auth });
    if (u.pathname === '/v1/auth_tokens/token/' && req.method === 'POST') {
      let body = '';
      for await (const c of req) body += c;
      const b = Object.fromEntries(new URLSearchParams(body));
      s.tokenCalls.push({ type: req.headers['content-type'], body: b });
      if (b.grant_type !== 'client_credentials' || b.client_id !== 'ov-id' || b.client_secret !== 'ov-secret') { res.writeHead(401); return res.end('{}'); }
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ access_token: 'ov-token-1', token_type: 'Bearer', expires_in: 36000, scope: 'read write' }));
    }
    if (auth !== 'Bearer ov-token-1') { res.writeHead(429, { 'content-type': 'application/json' }); return res.end('{"detail":"Request was throttled."}'); }
    if (u.pathname === '/v1/images/') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ results: [{ id: 'k1', title: 'Kitten', url: `${here}/m/k1.gif`, thumbnail: `${s.base}/v1/images/k1/thumb/`, creator: 'Ada', license: 'by', license_version: '4.0', foreign_landing_url: 'https://example.org/k1', width: 100, height: 80 }] }));
    }
    if (u.pathname === '/v1/images/k1/thumb/') { res.setHeader('content-type', 'image/gif'); return res.end(GIF); }
    res.writeHead(404);
    return res.end();
  });
  return new Promise((r) => s.server.listen(0, '127.0.0.1', () => { s.base = `http://127.0.0.1:${s.server.address().port}`; r(s); }));
}
// A Wikimedia Commons stand-in that answers.
function commonsStandIn() {
  const s = { calls: 0 };
  s.server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/w/api.php') {
      s.calls++;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ query: { pages: [{ pageid: 77, title: 'File:Cat.gif', imageinfo: [{ url: `${s.base}/m/c.gif`, thumburl: `${s.base}/m/c-t.gif`, mime: 'image/gif', size: 106, width: 50, height: 40, descriptionurl: 'https://commons.wikimedia.org/wiki/File:Cat.gif', extmetadata: { Artist: { value: 'Bo' }, LicenseShortName: { value: 'CC0' } } }] }] } }));
    }
    if (u.pathname.endsWith('.gif')) { res.setHeader('content-type', 'image/gif'); return res.end(GIF); }
    res.writeHead(404);
    return res.end();
  });
  return new Promise((r) => s.server.listen(0, '127.0.0.1', () => { s.base = `http://127.0.0.1:${s.server.address().port}`; r(s); }));
}

test('gif search when Openverse turns anonymous calls away: the registry’s own Openverse token, sent only to Openverse', async () => {
  const ov = await strictOpenverse();
  const anon = await start({ env: { GIF_OPENVERSE_BASE: ov.base } });
  try {
    const u = await anon.signUp(950005, 'gifanon');
    const { token } = (await mint(anon, u)).body;
    const r = await get(anon, '/v1/gif/search?q=kitten', token);
    assert.equal(r.status, 429, 'no credentials: refused, as on the live registry');
    const d = await r.json();
    assert.equal(d.error, 'rate_limited');
    assert.match(d.message, /Openverse/, 'says which GIF site turned the registry away');
  } finally { await anon.close(); }

  const reg = await start({ env: { GIF_OPENVERSE_BASE: ov.base, OPENVERSE_CLIENT_ID: 'ov-id', OPENVERSE_CLIENT_SECRET: 'ov-secret' } });
  try {
    const u = await reg.signUp(950006, 'gifauth');
    const { token } = (await mint(reg, u)).body;
    ov.calls.length = 0;
    const r = await get(reg, '/v1/gif/search?q=kitten', token);
    assert.equal(r.status, 200);
    const d = await r.json();
    const k1 = d.results.find((g) => g.id === 'k1');
    assert.ok(k1, JSON.stringify(d));
    assert.equal(ov.tokenCalls.at(-1).type, 'application/x-www-form-urlencoded');
    assert.deepEqual(ov.tokenCalls.at(-1).body, { grant_type: 'client_credentials', client_id: 'ov-id', client_secret: 'ov-secret' });
    assert.equal((await get(reg, '/v1/gif/search?q=kitten2', token)).status, 200);
    assert.equal(ov.tokenCalls.length, 1, 'the Openverse token is kept, not asked for on every search');
    // The thumbnail is on Openverse's own host: fetched with the token. The GIF itself is elsewhere: never.
    const p = await get(reg, k1.preview, token);
    assert.equal(p.status, 200);
    assert.equal(ov.calls.find((c) => c.path === '/v1/images/k1/thumb/').auth, 'Bearer ov-token-1');
    seen.length = 0;
    assert.equal((await get(reg, k1.url, token)).status, 200);
    assert.ok(seen.some((s) => s.path === '/m/k1.gif'));
    assert.ok(ov.calls.every((c) => c.path.startsWith('/v1/')), 'only Openverse got the token');
  } finally { await reg.close(); ov.server.closeAllConnections(); ov.server.close(); }
});

test('gif search: a GIF site that refuses hands over to the next one configured; a clear message when none answers', async () => {
  const ov = await strictOpenverse();
  const cm = await commonsStandIn();
  const reg = await start({ env: { GIF_PROVIDERS: 'openverse,commons', GIF_OPENVERSE_BASE: ov.base, GIF_COMMONS_BASE: cm.base } });
  try {
    const u = await reg.signUp(950007, 'giffall');
    const { token } = (await mint(reg, u)).body;
    const r = await get(reg, '/v1/gif/search?q=cat', token);
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.source, 'commons', 'Openverse refused, so Commons answered');
    assert.equal(d.results[0].source, 'commons');
    assert.equal(d.results[0].credit.text, 'Bo, CC0, via Wikimedia Commons');
    // Asking for one source by name gets that source only.
    assert.equal((await get(reg, '/v1/gif/search?q=cat&source=openverse', token)).status, 429);
  } finally { await reg.close(); cm.server.closeAllConnections(); cm.server.close(); }
  const down = await start({ env: { GIF_PROVIDERS: 'openverse,commons', GIF_OPENVERSE_BASE: ov.base, GIF_COMMONS_BASE: 'http://127.0.0.1:1' } });
  try {
    const u = await down.signUp(950008, 'gifdown');
    const { token } = (await mint(down, u)).body;
    const r = await get(down, '/v1/gif/search?q=cat', token);
    assert.equal(r.status, 502, 'one refused, one unreachable');
    const d = await r.json();
    assert.equal(d.error, 'unavailable');
    assert.match(d.message, /Openverse/);
    assert.match(d.message, /Wikimedia Commons/);
  } finally { await down.close(); ov.server.closeAllConnections(); ov.server.close(); }
});
