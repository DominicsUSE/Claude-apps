// GIF search without a paid key (server/gifs.js, server/media.js): Openverse by
// default, Wikimedia Commons when chosen, Tenor only with a key, the registry on
// a desktop PC, or off; all against local stand-ins. Credits travel with the
// GIF, only addresses a search returned are fetched, and the User-Agent names
// Snug and never the person searching.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';
import { gifProviders, userAgent, licenceName, creditOf } from '../server/gifs.js';

const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(200, 1)]);

// One stand-in that answers as Openverse, Wikimedia Commons and a GIF host.
const seen = [];
let mock, here, openverseStatus = 200;
test.before(async () => {
  mock = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push({ path: u.pathname, q: u.searchParams, ua: req.headers['user-agent'] || '' });
    const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (u.pathname === '/v1/images/') {
      if (openverseStatus !== 200) { res.writeHead(openverseStatus); res.end('{}'); return; }
      const item = (id, extra = {}) => ({ id, title: `Cat ${id}`, url: `${here}/media/${id}.gif`, thumbnail: `${here}/media/${id}-thumb.gif`, creator: 'Ada <b>Lovelace</b>', license: 'by-sa', license_version: '4.0', foreign_landing_url: `https://example.org/${id}`, width: 220, height: 140, ...extra });
      json({ results: [item('ov1'), item('ov2', { mature: true }), item('hop', { url: `${here}/media/hop` }), item('page', { url: `${here}/media/page` }), item('huge', { url: `${here}/media/huge` })] });
    } else if (u.pathname === '/w/api.php') {
      json({ query: { pages: [
        { pageid: 11, title: 'File:Spinning wheel.gif', imageinfo: [{ url: `${here}/media/wheel.gif`, thumburl: `${here}/media/wheel-thumb.gif`, width: 300, height: 300, size: 2000, mime: 'image/gif', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Spinning_wheel.gif', extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' }, Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Someone">Someone</a>' }, AttributionRequired: { value: 'true' } } }] },
        { pageid: 12, title: 'File:Elsewhere.gif', imageinfo: [{ url: 'https://evil.example/x.gif', width: 1, height: 1, size: 10, mime: 'image/gif' }] },
        { pageid: 13, title: 'File:Picture.png', imageinfo: [{ url: `${here}/media/p.png`, width: 1, height: 1, size: 10, mime: 'image/png' }] },
      ] } });
    } else if (u.pathname === '/media/hop') { res.writeHead(302, { location: 'http://10.0.0.1/cat.gif' }); res.end(); }
    else if (u.pathname === '/media/page') { res.setHeader('content-type', 'image/gif'); res.end('<html>not a gif</html>'); }
    else if (u.pathname === '/media/huge') { res.setHeader('content-type', 'image/gif'); res.end(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(10 * 1024 * 1024 + 10)])); }
    else if (u.pathname.endsWith('.gif')) { res.setHeader('content-type', 'image/gif'); res.end(GIF); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  here = `http://127.0.0.1:${mock.address().port}`;
});
test.after(() => new Promise((r) => mock.close(r)));

async function withServer(env, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'snug-gifs-'));
  Object.assign(process.env, env);
  let s;
  try { s = await startServer({ port: 0, dataDir: dir, quiet: true }); } finally { for (const k of Object.keys(env)) delete process.env[k]; }
  const base = `http://127.0.0.1:${s.port}`;
  const post = (path, body, cookie) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const reg = await post('/api/register', { handle: 'gifperson', name: 'Gif Person', password: 'a long password' });
  const cookie = reg.headers.get('set-cookie').split(';')[0];
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`, { headers: { cookie, origin: base } });
  const acks = new Map(); let n = 0;
  await new Promise((r) => ws.on('message', (buf) => { const m = JSON.parse(buf); if (m.t === 'hello') r(); else if (m.t === 'ack') acks.get(m.id)?.(m); }));
  const op = (o, d) => { const i = ++n; ws.send(JSON.stringify({ t: 'op', id: i, op: o, d })); return new Promise((r) => acks.set(i, r)); };
  const { room } = (await op('house.create', { name: 'Gif House', hue: 30 })).d;
  const get = (path) => fetch(base + path, { headers: { cookie } });
  try { await fn({ s, base, cookie, op, room, get, post: (p, b) => post(p, b, cookie) }); } finally { ws.close(); await s.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('which sources: Openverse by default, the registry on a linked PC, Commons only when asked, Tenor only with a key, or off', () => {
  const ids = (env, o) => gifProviders(env, o).map((p) => p.id);
  assert.deepEqual(ids({}), ['openverse']);
  assert.deepEqual(ids({}, { reg: { base: 'https://reg.example', token: async () => ({}) } }), ['registry']);
  assert.deepEqual(ids({ SNUG_GIF_PROVIDER: 'off' }), []);
  assert.deepEqual(ids({ SNUG_GIF_PROVIDER: 'tenor' }), [], 'Tenor without a key is not offered');
  assert.deepEqual(ids({ SNUG_GIF_PROVIDER: 'tenor', SNUG_TENOR_KEY: 'k' }), ['tenor']);
  assert.deepEqual(ids({ SNUG_GIF_PROVIDER: 'openverse, commons, nonsense' }), ['openverse', 'commons']);
  assert.match(userAgent({}), /^Snug\/0\.12 \(self-hosted chat server\)$/);
  assert.equal(userAgent({ SNUG_GIF_CONTACT: 'https://chat.example.org/about <x>' }), 'Snug/0.12 (self-hosted chat server; https://chat.example.org/aboutx)');
  assert.equal(licenceName('by-sa', '4.0'), 'CC BY-SA 4.0');
  assert.equal(licenceName('cc0', '1.0'), 'CC0');
  assert.equal(licenceName('pdm', ''), 'Public domain');
  assert.deepEqual(creditOf({ author: '<a href="x">Someone</a>', licence: 'CC BY 4.0', source: 'Wikimedia Commons', link: 'javascript:alert(1)' }), { text: 'Someone, CC BY 4.0, via Wikimedia Commons' });
});

test('Openverse: keyless search through the server, with credits; previews and picks only from what a search returned', async () => {
  await withServer({ SNUG_GIF_PROVIDER: 'openverse', SNUG_OPENVERSE_BASE: here }, async ({ base, cookie, op, room, get, post }) => {
    const cfg = await (await get('/api/gifs/config')).json();
    assert.equal(cfg.search, true);
    assert.equal(cfg.sources[0].label, 'Openverse');
    assert.match(cfg.sources[0].note, /author and licence/);
    seen.length = 0;
    const found = await (await get('/api/gifs?q=cat')).json();
    const call = seen.find((x) => x.path === '/v1/images/');
    assert.equal(call.q.get('q'), 'cat');
    assert.equal(call.q.get('mature'), 'false');
    assert.equal(call.q.get('extension'), 'gif');
    assert.match(call.ua, /^Snug\/0\.12/);
    assert.doesNotMatch(call.ua, /gifperson|Gif Person/, 'nothing about the person searching');
    assert.equal(found.results.some((g) => g.id === 'ov2'), false, 'mature results are dropped');
    const r0 = found.results.find((g) => g.id === 'ov1');
    assert.deepEqual(r0.credit, { text: 'Ada Lovelace, CC BY-SA 4.0, via Openverse', link: 'https://example.org/ov1' });
    assert.match(r0.preview, /^\/api\/gifs\/media\?u=/);
    // Searched again within the hour: answered from the server's copy.
    await (await get('/api/gifs?q=CAT')).json();
    assert.equal(seen.filter((x) => x.path === '/v1/images/').length, 1);
    const prev = await get(r0.preview);
    assert.equal(prev.status, 200);
    assert.equal(prev.headers.get('content-type'), 'image/gif');
    await prev.arrayBuffer();
    assert.equal((await get(`/api/gifs/media?u=${encodeURIComponent(`${here}/media/other.gif`)}`)).status, 403, 'not from a search');
    // A pick: copied into Snug with its credit, which every message carrying it shows.
    const imp = await post('/api/gifs/import', { conv: room, url: r0.url, w: 220, h: 140, title: r0.title, credit: { text: 'forged' } });
    assert.equal(imp.status, 201);
    const f = await imp.json();
    assert.deepEqual(f.credit, r0.credit, 'the credit is the server’s, not what the browser sent');
    const sent = await op('msg.send', { conv: room, id: 'm_gifcredit000001', text: '', files: [{ id: f.id, w: 220, h: 140 }] });
    assert.equal(sent.ok, true, sent.error);
    assert.deepEqual(sent.d.m.files[0].credit, r0.credit);
    const copy = await (await post('/api/gifs/use', { conv: room, file: f.id })).json();
    assert.deepEqual(copy.credit, r0.credit, 'a copy keeps it');
    // Refusals.
    const refuse = async (url, status, why) => { const res = await post('/api/gifs/import', { conv: room, url }); assert.equal(res.status, status, url); assert.match((await res.json()).error, why); };
    await refuse(`${here}/media/never-searched.gif`, 403, /Search again/);
    await refuse(r0.preview, 403, /isn’t one Snug fetches/);
    await refuse(found.results.find((g) => g.id === 'hop').url, 422, /couldn’t be fetched/);
    await refuse(found.results.find((g) => g.id === 'page').url, 422, /isn’t a GIF/);
    await refuse(found.results.find((g) => g.id === 'huge').url, 422, /over 10 MB/);
    void base; void cookie;
  });
});

test('Openverse busy: its rate limit is said plainly; Wikimedia Commons works with its own credits and hosts', async () => {
  await withServer({ SNUG_GIF_PROVIDER: 'openverse,commons', SNUG_OPENVERSE_BASE: here, SNUG_COMMONS_BASE: here }, async ({ get, post, room }) => {
    const cfg = await (await get('/api/gifs/config')).json();
    assert.deepEqual(cfg.sources.map((x) => x.id), ['openverse', 'commons']);
    assert.match(cfg.sources[1].note, /no safe-search filter/);
    openverseStatus = 429;
    try {
      const busy = await get('/api/gifs?q=dog');
      assert.equal(busy.status, 429);
      assert.match((await busy.json()).error, /Openverse is getting too many searches/);
    } finally { openverseStatus = 200; }
    seen.length = 0;
    const found = await (await get('/api/gifs?q=wheel&source=commons')).json();
    assert.equal(found.source, 'commons');
    const call = seen.find((x) => x.path === '/w/api.php');
    assert.equal(call.q.get('gsrsearch'), 'filemime:image/gif wheel');
    assert.match(call.ua, /^Snug\/0\.12/);
    assert.equal(found.results.length, 1, 'off-host media and non-GIFs are dropped');
    assert.deepEqual(found.results[0].credit, { text: 'Someone, CC BY-SA 4.0, via Wikimedia Commons', link: 'https://commons.wikimedia.org/wiki/File:Spinning_wheel.gif' });
    const imp = await post('/api/gifs/import', { conv: room, url: found.results[0].url, title: found.results[0].title });
    assert.equal(imp.status, 201);
    assert.equal((await imp.json()).credit.text, 'Someone, CC BY-SA 4.0, via Wikimedia Commons');
  });
});

test('SNUG_GIF_PROVIDER=off: no Search tab, and the routes say search isn’t set up', async () => {
  await withServer({ SNUG_GIF_PROVIDER: 'off' }, async ({ get }) => {
    assert.deepEqual(await (await get('/api/gifs/config')).json(), { search: false, sources: [] });
    const r = await get('/api/gifs?q=cat');
    assert.equal(r.status, 404);
    assert.match((await r.json()).error, /isn’t set up/);
  });
});

test('through the registry: one token, a bearer header, and only the registry’s own signed file addresses', async () => {
  const calls = [];
  let tokens = 0;
  const fakeFetch = async (url, init = {}) => {
    calls.push({ url: String(url), auth: init.headers?.Authorization });
    const u = new URL(String(url));
    if (u.pathname === '/v1/gif/search') return new Response(JSON.stringify({ results: [{ id: 'r1', title: 'Wave', url: '/v1/gif/file?u=x&s=sig', preview: '/v1/gif/file?u=y&s=sig2', w: 10, h: 10, source: 'openverse', credit: { text: 'A, CC BY 4.0, via Openverse', author: 'A', licence: 'CC BY 4.0', source: 'Openverse', link: 'https://example.org/a' } }] }), { status: 200 });
    if (u.pathname === '/v1/gif/file') return new Response(GIF, { status: 200 });
    return new Response('{}', { status: 404 });
  };
  const [p] = gifProviders({}, { fetch: fakeFetch, reg: { base: 'https://reg.example', token: async () => { tokens++; return { token: 'tok-1', ttl: 3600, sources: ['openverse'] }; } } });
  assert.equal(p.id, 'registry');
  assert.match(p.note, /registry’s address, not yours/);
  const list = await p.search('wave');
  assert.equal(list[0].url, '/v1/gif/file?u=x&s=sig');
  assert.equal(list[0].credit.text, 'A, CC BY 4.0, via Openverse');
  const got = await p.fetch(list[0].url);
  assert.equal(got.type, 'image/gif');
  assert.equal(tokens, 1, 'the token is reused');
  assert.ok(calls.every((c) => c.auth === 'Bearer tok-1' && c.url.startsWith('https://reg.example/v1/gif/')));
  assert.match((await p.fetch('https://evil.example/x.gif')).err, /isn’t one Snug fetches/);
});

test('a desktop PC searches through the registry end to end: the GIF site only ever hears from the registry', async () => {
  const { startLocalRegistry } = await import('../registry/dev.js');
  const { startPc, signUp } = await import('./helpers/p2p.js');
  const registry = await startLocalRegistry({ env: { OWNER_GITHUB_IDS: '900001', GIF_OPENVERSE_BASE: here } });
  const A = await startPc(registry);
  try {
    const a = await signUp(A, registry, 7101, 'gifdesk');
    const get = (p) => fetch(A.base + p, { headers: { cookie: a.cookie } });
    const cfg = await (await get('/api/gifs/config')).json();
    assert.deepEqual(cfg.sources.map((x) => x.id), ['registry']);
    seen.length = 0;
    const found = await (await get('/api/gifs?q=cat')).json();
    const r0 = found.results.find((g) => g.id === 'ov1');
    assert.ok(r0, JSON.stringify(found));
    assert.equal(r0.credit.text, 'Ada Lovelace, CC BY-SA 4.0, via Openverse');
    const prev = await get(r0.preview);
    assert.equal(prev.status, 200);
    await prev.arrayBuffer();
    const dm = (await a.ok('house.create', { name: 'Desk', hue: 10 })).room;
    const imp = await fetch(`${A.base}/api/gifs/import`, { method: 'POST', headers: { cookie: a.cookie, origin: A.base, 'content-type': 'application/json' }, body: JSON.stringify({ conv: dm, url: r0.url, title: r0.title }) });
    assert.equal(imp.status, 201, await imp.clone().text());
    assert.equal((await imp.json()).credit.text, r0.credit.text);
    assert.ok(seen.length >= 3);
    assert.ok(seen.every((x) => x.ua.startsWith('Snug-registry/')), 'every request to the GIF site came from the registry');
    a.close();
  } finally { await A.close(); await registry.close(); }
});

// 0.14 fix: the 0.13 desktop app with a keypair account (no GitHub). The live registry's Openverse calls were
// refused (Openverse limits anonymous calls per address, and every Cloudflare Worker shares one), and the picker
// blamed this PC ("too many searches from this server"). Now it says which GIF site turned the registry away.
test('a keypair account on a desktop PC: GIF search through the registry, and a GIF site that refuses the registry is named', async () => {
  const { startLocalRegistry } = await import('../registry/dev.js');
  const { startPc, Client } = await import('./helpers/p2p.js');
  const registry = await startLocalRegistry({ env: { OWNER_GITHUB_IDS: '900001', GIF_OPENVERSE_BASE: here } });
  const A = await startPc(registry);
  try {
    const made = await fetch(`${A.base}/api/id/create`, { method: 'POST', headers: { origin: A.base, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'keygifs' }) });
    assert.equal(made.status, 200, await made.clone().text());
    const cookie = made.headers.get('set-cookie').split(';')[0];
    const me = (await made.json()).user;
    assert.equal(A.peer.identity.self().username, 'keygifs');
    const get = (p) => fetch(A.base + p, { headers: { cookie } });
    assert.deepEqual((await (await get('/api/gifs/config')).json()).sources.map((x) => x.id), ['registry']);

    openverseStatus = 429;
    const refused = await get('/api/gifs?q=kitten');
    assert.equal(refused.status, 429);
    const why = (await refused.json()).error;
    assert.match(why, /Openverse is turning away GIF searches from the Snug registry/);
    assert.doesNotMatch(why, /from this server/);

    openverseStatus = 200;
    const found = await (await get('/api/gifs?q=kitten')).json();
    const r0 = found.results.find((g) => g.id === 'ov1');
    assert.ok(r0, JSON.stringify(found));
    assert.equal(r0.credit.text, 'Ada Lovelace, CC BY-SA 4.0, via Openverse');
    const prev = await get(r0.preview);
    assert.equal(prev.status, 200);
    await prev.arrayBuffer();
    const c = new Client(A, cookie, me.id);
    await c.connect();
    const room = (await c.ok('house.create', { name: 'Keys', hue: 10 })).room;
    const imp = await fetch(`${A.base}/api/gifs/import`, { method: 'POST', headers: { cookie, origin: A.base, 'content-type': 'application/json' }, body: JSON.stringify({ conv: room, url: r0.url, title: r0.title }) });
    assert.equal(imp.status, 201, await imp.clone().text());
    await c.close();
  } finally { openverseStatus = 200; await A.close(); await registry.close(); }
});

// review-media 1: a GIF fetched and stored by the server counts against the uploader's quota.
test('a picked GIF is refused once the person is out of room', async () => {
  await withServer({ SNUG_GIF_PROVIDER: 'openverse', SNUG_OPENVERSE_BASE: here, SNUG_QUOTA_MB: '1' }, async ({ base, cookie, room, get, post }) => {
    const fill = await fetch(`${base}/api/files?conv=${room}`, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/octet-stream', 'x-file-name': 'fill.bin' }, body: Buffer.alloc(1024 * 1024 - 100) });
    assert.equal(fill.status, 201, await fill.clone().text());
    const r0 = (await (await get('/api/gifs?q=cat')).json()).results.find((g) => g.id === 'ov1');
    const imp = await post('/api/gifs/import', { conv: room, url: r0.url, title: r0.title });
    assert.equal(imp.status, 413);
    assert.match((await imp.json()).error, /room for your files/);
  });
});
