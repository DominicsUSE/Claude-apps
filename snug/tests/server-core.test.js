// Snug 0.12 core track: full-text search, disappearing messages, the sweep
// with a fake clock, static file validators and compression, and the ping op
// the connection diagnostics use. Real server, real sockets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';
import { openDb } from '../server/db.js';

const dir = mkdtempSync(join(tmpdir(), 'snug-core-'));
let srv, base;
test.before(async () => { srv = await startServer({ port: 0, dataDir: dir, quiet: true }); base = `http://127.0.0.1:${srv.port}`; });
test.beforeEach(() => srv.resetLimits());
test.after(async () => { await srv.close(); rmSync(dir, { recursive: true, force: true }); });

const post = (path, body, cookie) => fetch(base + path, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
});
let n = 0;
const mid = () => `m_core${String(++n).padStart(6, '0')}x`;

class Client {
  static async make(handle, name = handle) {
    const res = await post('/api/register', { handle, name, password: 'a long password' });
    assert.equal(res.status, 201, await res.clone().text());
    const c = new Client();
    c.cookie = res.headers.get('set-cookie').split(';')[0];
    c.id = (await res.json()).user.id;
    await c.connect();
    return c;
  }
  connect() {
    this.events = []; this.acks = new Map(); this.seq = 0;
    this.ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { cookie: this.cookie, origin: base } });
    return new Promise((resolve, reject) => {
      this.ws.on('error', reject);
      this.ws.on('message', (buf) => {
        const m = JSON.parse(buf);
        if (m.t === 'hello') { this.hello = m.d; resolve(this); }
        else if (m.t === 'ack') this.acks.get(m.id)?.(m);
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
  async next(ev, pred = () => true, ms = 1500) {
    const end = Date.now() + ms;
    for (;;) {
      const i = this.events.findIndex((e) => e.ev === ev && pred(e.d));
      if (i >= 0) return this.events.splice(i, 1)[0].d;
      if (Date.now() > end) throw new Error(`no "${ev}" event arrived`);
      await new Promise((r) => { this.waiter = r; setTimeout(r, 50); });
    }
  }
}

let ada, bo, cy, house, lounge, dm;
const send = async (c, conv, text) => { const id = mid(); await c.ok('msg.send', { conv, id, text }); return id; };
const ids = async (c, q) => (await c.ok('search', { q })).hits.map((h) => h.m.id);

test('setup: a house with two members, an outsider, and a direct conversation', async () => {
  ada = await Client.make('coreada', 'Ada Core');
  bo = await Client.make('corebo', 'Bo Core');
  cy = await Client.make('corecy', 'Cy Core');
  const made = await ada.ok('house.create', { name: 'Search House', hue: 35 });
  house = made.house; lounge = made.room;
  const { code } = await ada.ok('invite.create', { house });
  await bo.ok('invite.accept', { code });
  dm = (await ada.ok('dm.open', { users: [bo.id] })).id;
});

test('search: full-text index with ranking, prefixes, diacritics and permissions', async () => {
  assert.equal(srv.db.fts, true, 'this Node has SQLite FTS5 compiled in');
  const once = await send(ada, lounge, 'The kiln schedule for Thursday is posted on the board');
  const many = await send(ada, lounge, 'Kiln kiln kiln: the kiln is hot, do not open the kiln');
  const accent = await send(bo, lounge, 'Žąsis pabėgo iš kiemo');
  const inDm = await send(bo, dm, 'secret glazewords only for us');

  // Ranked by relevance: the message that is all about the kiln comes first.
  const kiln = await ids(ada, 'kiln');
  assert.deepEqual(kiln.slice(0, 2), [many, once]);
  // Prefix: the start of a word finds the whole word.
  assert.deepEqual(await ids(ada, 'thursd'), [once]);
  // Diacritics fold both ways.
  assert.deepEqual(await ids(ada, 'zasis'), [accent]);
  assert.deepEqual(await ids(ada, 'žąs'), [accent]);
  // Two words must both be there, in any order.
  assert.deepEqual(await ids(ada, 'board kiln'), [once]);
  // Permissions are unchanged: the outsider finds nothing, DMs only for their members.
  assert.deepEqual(await ids(cy, 'kiln'), []);
  assert.deepEqual(await ids(ada, 'glazewords'), [inDm]);
  assert.deepEqual(await ids(cy, 'glazewords'), []);
  // Operators still apply on top of the words.
  assert.deepEqual(await ids(ada, 'from:corebo kiln'), []);
  assert.deepEqual(await ids(ada, 'from:corebo zasis'), [accent]);
  // Query syntax is data: FTS operators and quotes in the box don't break or widen the search.
  for (const q of ['kiln OR secret', '"kiln', 'kiln*', 'NEAR(kiln board)', 'kiln -board', "100%' OR 1=1 --", '^kiln']) {
    srv.resetLimits(); // search has its own rate limit
    const r = await ada.op('search', { q });
    assert.equal(r.ok, true, `${q}: ${r.error}`);
  }
  assert.equal((await ids(cy, 'kiln OR secret')).length, 0);
});

test('search: edits re-index, deleted messages drop out, short words and symbols still match', async () => {
  const id = await send(ada, lounge, 'apricot glaze test tile');
  assert.deepEqual(await ids(ada, 'apricot'), [id]);
  await ada.ok('msg.edit', { conv: lounge, id, text: 'peach glaze test tile' });
  assert.deepEqual(await ids(ada, 'apricot'), []);
  assert.deepEqual(await ids(ada, 'peach'), [id]);
  await ada.ok('msg.delete', { conv: lounge, id });
  assert.deepEqual(await ids(ada, 'peach'), []);
  const sym = await send(ada, lounge, 'ok 🎉 v2 c#');
  assert.ok((await ids(ada, '🎉')).includes(sym), 'emoji (not words to the index) still match by substring');
  assert.ok((await ids(ada, 'c#')).includes(sym));
  assert.ok((await ids(ada, 'v2')).includes(sym));
});

test('search: a close match when nothing matches exactly, and the reply says so', async () => {
  const id = await send(ada, lounge, 'our tenmoku bowls came out lovely');
  let r = await ada.ok('search', { q: 'tenmoku' });
  assert.equal(r.close, undefined);
  r = await ada.ok('search', { q: 'tenmokku' }); // one letter too many
  assert.deepEqual(r.hits.map((h) => h.m.id), [id]);
  assert.equal(r.close, true);
  r = await ada.ok('search', { q: 'tenmuko' }); // two letters swapped
  assert.deepEqual(r.hits.map((h) => h.m.id), [id]);
  // A close match never reaches into conversations the searcher can't read.
  r = await cy.ok('search', { q: 'tenmokku' });
  assert.equal(r.hits.length, 0);
  assert.equal(r.close, undefined);
  // Nothing close at all: still no hits.
  assert.equal((await ada.ok('search', { q: 'xylophonic' })).hits.length, 0);
});

// review-media 2: close-match candidates are chosen among words the searcher could find, so words in
// conversations they can't read neither crowd out their own nor show up as a missing result.
test('search: close-match candidates come only from what the searcher can read', async () => {
  for (const c of 'abcdefgh') await send(ada, lounge, `vorpa${c}`);
  const own = (await cy.ok('house.create', { name: 'Cy Search', hue: 50 })).room;
  const mine = await send(cy, own, 'my vorpaz is here');
  const r = await cy.ok('search', { q: 'vorpaq' });
  assert.deepEqual(r.hits.map((h) => h.m.id), [mine], 'eight unreadable close words do not hide the readable one');
  assert.equal(r.close, true);
});

// review-media 2 (pass 2): the candidate scan has no row window, so words in conversations the searcher
// can't read can't push a readable close word out of it (a counting oracle once padded to the edge).
test('search: many unreadable words before a readable close word do not hide it', async () => {
  const A = 'abcdefghijklmnopqrstuvwxyz';
  const pad = Array.from({ length: 20500 }, (_, i) => `qa${A[Math.floor(i / 676) % 26]}${A[Math.floor(i / 26) % 26]}${A[i % 26]}${A[Math.floor(i / 17576) % 26]}`);
  srv.db.run("INSERT INTO messages (id, conv, author, ts, text, fold) VALUES ('m_corepad000001x', ?, ?, ?, '', ?)", lounge, ada.id, Date.now(), pad.join(' '));
  const own = (await cy.ok('house.create', { name: 'Cy Window', hue: 60 })).room;
  const mine = await send(cy, own, 'the qzzzzz is mine');
  const r = await cy.ok('search', { q: 'qzzzzy' });
  assert.deepEqual(r.hits.map((h) => h.m.id), [mine], '20500 unreadable q-words do not hide the readable one');
  assert.equal(r.close, true);
});

test('search: an existing database without the index is indexed when it opens', () => {
  const d = mkdtempSync(join(tmpdir(), 'snug-fts-'));
  try {
    const path = join(d, 'old.db');
    const db = openDb(path);
    db.run("INSERT INTO users (id, handle, name, pass, created) VALUES ('u_old', 'old', 'Old', 'x', 1)");
    db.run("INSERT INTO messages (id, conv, author, ts, text, fold) VALUES ('m_old1', 'r_x', 'u_old', 1, 'Raku firing', 'raku firing')");
    db.close();
    // Make it look like a 0.11 database: no index, no triggers.
    const raw = new DatabaseSync(path);
    for (const t of ['messages_fts_ai', 'messages_fts_ad', 'messages_fts_au']) raw.exec(`DROP TRIGGER IF EXISTS ${t}`);
    raw.exec('DROP TABLE IF EXISTS messages_fts');
    raw.close();
    const again = openDb(path);
    assert.equal(again.get("SELECT rowid FROM messages_fts WHERE messages_fts MATCH '\"raku\"*'")?.rowid > 0, true);
    again.close();
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('search: without FTS5 (SNUG_FTS=0 or an SQLite built without it) the substring scan still works', async () => {
  const { createModel } = await import('../server/model.js');
  const db = openDb(':memory:', { fts: false });
  assert.equal(db.fts, false);
  db.run("INSERT INTO users (id, handle, name, pass, created) VALUES ('u_a', 'a', 'A', 'x', 1)");
  db.run("INSERT INTO messages (id, conv, author, ts, text, fold) VALUES ('m_a1', 'r_x', 'u_a', 1, 'Raku firing', 'raku firing')");
  const M = createModel(db);
  M.readable = () => ['r_x'];
  assert.deepEqual(M.search('u_a', 'aku').map((h) => h.m.id), ['m_a1'], 'substring, as before');
  db.close();
});

// ---------- Disappearing messages ----------
const HOUR = 3_600_000, DAY = 24 * HOUR;
const upload = (cookie, conv, text, name) => fetch(`${base}/api/files?conv=${encodeURIComponent(conv)}`, {
  method: 'POST', headers: { cookie, origin: base, 'content-type': 'text/plain', 'x-file-name': name }, body: text,
});

test('disappearing: only the allowed timers, by the people allowed to set them, with a line saying so', async () => {
  // A direct conversation: either person.
  assert.match(await ada.refused('conv.ttl', { conv: dm, ttl: 5 * HOUR }), /off, 1 hour, 1 day, 7 days or 30 days/);
  assert.match(await cy.refused('conv.ttl', { conv: dm, ttl: DAY }), /access/);
  await bo.ok('conv.ttl', { conv: dm, ttl: DAY });
  const line = await ada.next('msg', (d) => d.conv === dm && d.m.dmLine?.act === 'ttl');
  assert.equal(line.m.dmLine.ttl, DAY);
  assert.equal(line.m.expires, undefined, 'the line about the timer stays');
  const view = await ada.next('dm', (d) => d.dm?.id === dm && d.dm.ttl === DAY);
  assert.equal(view.dm.ttl, DAY);
  // A room: only someone who may manage rooms.
  assert.match(await bo.refused('conv.ttl', { conv: lounge, ttl: HOUR }), /can’t/);
  await ada.ok('conv.ttl', { conv: lounge, ttl: HOUR });
  const h = await bo.next('house', (d) => d.house.id === house && d.rooms[lounge]?.ttl === HOUR);
  assert.equal(h.rooms[lounge].ttl, HOUR);
  await ada.ok('conv.ttl', { conv: lounge, ttl: 0 });
  await bo.next('house', (d) => d.house.id === house && !d.rooms[lounge]?.ttl);
  // Threads follow their conversation; they have no timer of their own.
  assert.match(await ada.refused('conv.ttl', { conv: `t:${mid()}`, ttl: HOUR }), /access|conversation/);
});

test('disappearing: new messages get an expiry; the sweep (fake clock) removes them, their files, edits and search hits; undo refuses', async () => {
  const before = await send(ada, lounge, 'not disappearing'); // the room has no timer
  const t0 = Date.now();
  const id = await send(ada, dm, 'vanishing ink message');
  const row = srv.db.get('SELECT ts, expires FROM messages WHERE id = ?', id);
  assert.equal(row.expires, row.ts + DAY);
  assert.equal(srv.db.get('SELECT expires FROM messages WHERE id = ?', before).expires, null);
  const got = await bo.next('msg', (d) => d.m.id === id);
  assert.equal(got.m.expires, row.expires, 'clients get the expiry, to hide it on time even offline');
  // A thread reply under it disappears on the same timer.
  const reply = mid();
  await bo.ok('msg.send', { conv: `t:${id}`, id: reply, text: 'thread reply ink' });
  assert.ok(srv.db.get('SELECT expires FROM messages WHERE id = ?', reply).expires > t0);
  // A file, an edit (history) and a reaction.
  const f = await (await upload(ada.cookie, dm, 'file body', 'ink.txt')).json();
  const withFile = mid();
  await ada.ok('msg.send', { conv: dm, id: withFile, text: 'ink file', files: [{ id: f.id }] });
  await ada.ok('msg.edit', { conv: dm, id, text: 'vanishing ink message, edited' });
  await bo.ok('react', { conv: dm, id, emoji: '👍', on: true });
  assert.deepEqual(await ids(ada, 'vanishing'), [id]);

  // Not yet: an hour later nothing is gone.
  srv.expiry.sweep(t0 + HOUR);
  srv.sweepFiles(t0 + HOUR);
  assert.equal(srv.db.get('SELECT deleted FROM messages WHERE id = ?', id).deleted, null);
  // A day later: gone right away, no undo window.
  const later = t0 + DAY + 60_000;
  srv.expiry.sweep(later);
  srv.sweepFiles(later);
  const gone = srv.db.get('SELECT * FROM messages WHERE id = ?', id);
  assert.ok(gone.deleted);
  assert.equal(gone.text, '');
  assert.equal(gone.fold, '');
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM msg_edits WHERE msg = ?', id).n, 0, 'earlier versions go too');
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM reactions WHERE msg = ?', id).n, 0);
  assert.equal(srv.db.get('SELECT text FROM messages WHERE id = ?', reply).text, '');
  assert.equal(srv.db.get('SELECT files FROM messages WHERE id = ?', withFile).files, null);
  assert.equal(srv.db.get('SELECT 1 FROM files WHERE id = ?', f.id), undefined, 'the attachment is removed');
  assert.equal((await fetch(`${base}/api/files/${f.id}`, { headers: { cookie: bo.cookie } })).status, 404);
  assert.deepEqual(await ids(ada, 'vanishing'), []);
  await bo.next('msg.del', (d) => d.id === id);
  assert.match(await ada.refused('msg.restore', { conv: dm, id }), /disappeared/);
  // History no longer has it.
  assert.equal((await ada.ok('history', { conv: dm })).msgs.some((m) => m.id === id), false);
  // The message before the timer was set stays.
  assert.equal(srv.db.get('SELECT deleted FROM messages WHERE id = ?', before).deleted, null);
  // Turning it off: new messages stay.
  await ada.ok('conv.ttl', { conv: dm, ttl: 0 });
  const keep = await send(ada, dm, 'this one stays');
  assert.equal(srv.db.get('SELECT expires FROM messages WHERE id = ?', keep).expires, null);
});

// review-media 3: a disappearing message's link-preview picture and its forum title and tags go too.
test('disappearing: link-preview files and forum titles and tags go with the message', async () => {
  const t0 = Date.now();
  const f = await (await upload(ada.cookie, lounge, 'preview bytes', 'preview.txt')).json();
  const id = await send(ada, lounge, 'see https://example.org/page');
  srv.db.run('UPDATE messages SET expires = ?, embeds = ? WHERE id = ?', t0 + HOUR, JSON.stringify([{ kind: 'link', url: 'https://example.org/page', host: 'example.org', title: 'Secret title', image: { id: f.id, w: 1, h: 1 } }]), id);
  srv.db.run("INSERT INTO forum_posts (msg, room, title, tags) VALUES (?, ?, 'Hidden forum title', '[\"private\"]')", id, lounge);
  const later = t0 + HOUR + 60_000;
  srv.expiry.sweep(later);
  const row = srv.db.get('SELECT text, embeds FROM messages WHERE id = ?', id);
  assert.equal(row.text, '');
  assert.doesNotMatch(row.embeds || '', /Secret title|example\.org/, 'the preview’s words go at once');
  assert.deepEqual({ ...srv.db.get('SELECT title, tags FROM forum_posts WHERE msg = ?', id) }, { title: '', tags: '[]' });
  srv.sweepFiles(later);
  assert.equal(srv.db.get('SELECT 1 FROM files WHERE id = ?', f.id), undefined, 'the preview’s picture is removed');
  assert.equal(srv.db.get('SELECT embeds FROM messages WHERE id = ?', id).embeds, null);
});

test('deleted messages: a preview’s picture is still removed once the undo window has passed', async () => {
  const f = await (await upload(ada.cookie, lounge, 'preview bytes 2', 'preview.txt')).json();
  const id = await send(ada, lounge, 'look https://example.org/two');
  srv.db.run('UPDATE messages SET deleted = ?, embeds = ? WHERE id = ?', Date.now() - 12 * 60_000, JSON.stringify([{ kind: 'link', url: 'https://example.org/two', host: 'example.org', title: 'Words', image: { id: f.id, w: 1, h: 1 } }]), id);
  for (let i = 0; i < 30; i++) srv.hub.messaging.tick(); // the background tick tidies deleted messages every 30th time
  assert.doesNotMatch(srv.db.get('SELECT embeds FROM messages WHERE id = ?', id).embeds || '', /Words|example\.org/);
  srv.sweepFiles(Date.now());
  assert.equal(srv.db.get('SELECT 1 FROM files WHERE id = ?', f.id), undefined, 'the preview’s picture is removed');
});

// review-media 3 (pass 2): previews removed or rebuilt on a live message don't leave their pictures behind.
const withPreview = async (text, title) => {
  const f = await (await upload(ada.cookie, lounge, `preview ${title}`, 'preview.txt')).json();
  srv.db.run('UPDATE files SET meta = ? WHERE id = ?', JSON.stringify({ embed: true, w: 1, h: 1 }), f.id);
  const id = await send(ada, lounge, text);
  srv.db.run('UPDATE messages SET embeds = ? WHERE id = ?', JSON.stringify([{ kind: 'link', url: 'https://example.org/p', host: 'example.org', title, image: { id: f.id, w: 1, h: 1 } }]), id);
  return { f, id };
};
const fileGone = (fid) => srv.db.get('SELECT 1 FROM files WHERE id = ?', fid) === undefined && !existsSync(join(dir, 'files', fid));
test('link previews: removing them removes the preview’s picture', async () => {
  const { f, id } = await withPreview('see https://example.org/p', 'Off');
  await ada.ok('msg.embeds', { conv: lounge, id, on: false });
  assert.equal(srv.db.get('SELECT embeds FROM messages WHERE id = ?', id).embeds, null);
  assert.ok(fileGone(f.id), 'the picture is removed with the preview');
});
test('link previews: an edit that rebuilds them removes the old picture', async () => {
  const { f, id } = await withPreview('see https://example.org/p', 'Edit');
  await ada.ok('msg.edit', { conv: lounge, id, text: 'see https://example.org/p again' });
  for (let i = 0; i < 50 && srv.db.get('SELECT embeds FROM messages WHERE id = ?', id).embeds; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(srv.db.get('SELECT embeds FROM messages WHERE id = ?', id).embeds, null, 'this server fetches no previews, so the rebuild has none');
  assert.ok(fileGone(f.id), 'the old picture is removed');
});
test('link previews: pictures orphaned by older builds are swept once', async () => {
  const f = await (await upload(ada.cookie, lounge, 'old preview', 'preview.txt')).json();
  srv.db.run('UPDATE files SET meta = ?, created = ? WHERE id = ?', JSON.stringify({ embed: true, w: 1, h: 1 }), Date.now() - 5 * DAY, f.id);
  const kept = await withPreview('kept https://example.org/p', 'Kept');
  srv.db.run('UPDATE files SET created = ? WHERE id = ?', Date.now() - 5 * DAY, kept.f.id);
  srv.db.run("DELETE FROM sweep_marks WHERE name = 'embeds'"); // as on the first start of this build
  for (let i = 0; i < 5; i++) srv.sweepFiles(Date.now());
  assert.ok(fileGone(f.id), 'a preview picture no message names is removed');
  assert.ok(srv.db.get('SELECT 1 FROM files WHERE id = ?', kept.f.id), 'one a message still shows stays');
});

test('disappearing: a database from before 0.12 gains the column and keeps its messages', () => {
  const d = mkdtempSync(join(tmpdir(), 'snug-ttl-'));
  try {
    const path = join(d, 'old.db');
    openDb(path).close();
    const raw = new DatabaseSync(path);
    raw.exec('DROP TRIGGER IF EXISTS messages_ttl_ai; DROP TABLE IF EXISTS conv_ttl; DROP INDEX IF EXISTS messages_expires; ALTER TABLE messages DROP COLUMN expires;');
    raw.close();
    const again = openDb(path);
    assert.ok(again.all('PRAGMA table_info(messages)').some((c) => c.name === 'expires'));
    again.close();
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---------- PWA: validators, compression, the shell list and the manifest ----------
import { request } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { readFileSync, existsSync, statSync } from 'node:fs';
const raw = (path, headers = {}) => new Promise((resolve, reject) => {
  const req = request(`${base}${path}`, { headers }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  req.on('error', reject);
  req.end();
});
const ROOT = new URL('../', import.meta.url);

test('static files: an ETag, 304 when unchanged, gzip when asked, never for API replies', async () => {
  const file = readFileSync(new URL('js/app.js', ROOT));
  const first = await raw('/js/app.js');
  assert.equal(first.status, 200);
  assert.ok(first.headers.etag, 'an ETag');
  assert.equal(first.headers['cache-control'], 'no-cache', 'still checked every time, so a new version shows at once');
  assert.deepEqual(first.body, file);
  const again = await raw('/js/app.js', { 'if-none-match': first.headers.etag });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);
  const zipped = await raw('/js/app.js', { 'accept-encoding': 'gzip, deflate, br' });
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  assert.match(zipped.headers.vary || '', /accept-encoding/i);
  assert.ok(zipped.body.length < file.length / 2);
  assert.deepEqual(gunzipSync(zipped.body), file);
  // The page itself too, with its security headers kept.
  const page = await raw('/', { 'accept-encoding': 'gzip' });
  assert.equal(page.headers['content-encoding'], 'gzip');
  assert.match(page.headers['content-security-policy'], /script-src 'self'/);
  // Fonts and images are already compressed: sent as they are.
  assert.equal((await raw('/fonts/inter-latin.woff2', { 'accept-encoding': 'gzip' })).headers['content-encoding'], undefined);
  // API replies are never compressed or validated here (they can hold secrets: BREACH).
  const api = await raw('/api/me', { 'accept-encoding': 'gzip' });
  assert.equal(api.headers['content-encoding'], undefined);
  assert.equal(api.headers.etag, undefined);
});

test('the app shell list: every file the app needs offline, versioned, and nothing private', async () => {
  const r = await fetch(`${base}/shell.json`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  const shell = await r.json();
  assert.match(shell.version, /^\d+\.\d+\.\d+-[a-z0-9]{8,}$/);
  for (const f of ['/', '/js/app.js', '/js/store.js', '/css/tokens.css', '/vendor/preact-htm.js', '/fonts/inter-latin.woff2', '/brand/manifest.json']) assert.ok(shell.files.includes(f), f);
  assert.equal(shell.files.some((f) => /^\/(api|ws|data|server|docs)\b/.test(f) || f.includes('..')), false);
  assert.equal(shell.files.includes('/sw.js'), false, 'the worker is never cached by itself');
  // pdf.js's character maps and standard fonts (about 2.5 MB) are fetched when a PDF needs one, not kept up front.
  assert.ok(shell.files.includes('/vendor/pdfjs/pdf.min.js'));
  assert.equal(shell.files.some((f) => f.startsWith('/vendor/pdfjs/cmaps/') || f.startsWith('/vendor/pdfjs/standard_fonts/')), false);
});

// PNG width and height from the IHDR chunk.
const pngSize = (buf) => [buf.readUInt32BE(16), buf.readUInt32BE(20)];
test('the web app manifest: installable on phones (id, scope, standalone, icons incl. maskable, screenshots, colours)', async () => {
  const r = await fetch(`${base}/brand/manifest.json`);
  assert.equal(r.status, 200);
  const m = await r.json();
  assert.equal(m.id, '/');
  assert.equal(m.scope, '/');
  assert.equal(m.start_url, '/');
  assert.equal(m.display, 'standalone');
  assert.equal(m.lang, 'en');
  assert.match(m.description, /calm place/i);
  for (const k of ['theme_color', 'background_color']) assert.match(m[k], /^#[0-9A-Fa-f]{6}$/, k);
  const pngs = m.icons.filter((i) => i.type === 'image/png');
  for (const want of ['192x192', '512x512']) assert.ok(pngs.some((i) => i.sizes === want && (i.purpose || 'any').includes('any')), `an ${want} icon`);
  assert.ok(pngs.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'), 'a maskable icon');
  for (const i of pngs) {
    const res = await fetch(base + i.src);
    assert.equal(res.status, 200, i.src);
    assert.deepEqual(pngSize(Buffer.from(await res.arrayBuffer())).join('x'), i.sizes, i.src);
  }
  assert.ok(m.screenshots.some((s) => s.form_factor === 'narrow'), 'a phone screenshot');
  assert.ok(m.screenshots.some((s) => s.form_factor === 'wide'), 'a wide screenshot');
  for (const s of m.screenshots) {
    const res = await fetch(base + s.src);
    assert.equal(res.status, 200, s.src);
    assert.equal(pngSize(Buffer.from(await res.arrayBuffer())).join('x'), s.sizes, s.src);
    assert.ok(s.label, 'screenshots say what they show');
  }
});

test('heartbeat: the ping op answers with the time and this server’s version; /api/me says the version too', async () => {
  const pkg = JSON.parse(readFileSync(new URL('package.json', ROOT)));
  const r = await ada.ok('ping');
  assert.equal(r.version, pkg.version);
  assert.ok(Math.abs(r.now - Date.now()) < 5000);
  const me = await (await fetch(`${base}/api/me`, { headers: { cookie: ada.cookie } })).json();
  assert.equal(me.version, pkg.version);
});
