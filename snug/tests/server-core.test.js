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
