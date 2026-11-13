// Text and messages on the real server (server/chat.js, server/media.js):
// reactions with skin tones and ZWJ sequences, @everyone from someone without
// the right, message links (msg.peek), spoiler and alt text on attachments,
// byte sniffing for uploads, /roll, silent messages and reply mentions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';
import { previewLinks, isMessageLink } from '../server/linkpreview.js';
import { uploadType, fileKind } from '../server/media.js';

const dir = mkdtempSync(join(tmpdir(), 'snug-chat-'));
let srv, base;
test.before(async () => { srv = await startServer({ port: 0, dataDir: dir, quiet: true, pushAllowLocal: true }); base = `http://127.0.0.1:${srv.port}`; });
test.beforeEach(() => srv.resetLimits());
test.after(async () => { await srv.close(); rmSync(dir, { recursive: true, force: true }); });

const post = (path, body, cookie) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const upload = (cookie, conv, type, bytes, name = 'file') => fetch(`${base}/api/files?conv=${encodeURIComponent(conv)}`, {
  method: 'POST', headers: { cookie, origin: base, 'content-type': type, 'x-file-name': name }, body: bytes,
});
let n = 0;
const mid = () => `m_chat${String(++n).padStart(6, '0')}x`;
let hn = 0;
const handle = (p) => `${p}${++hn}`;
const settle = () => new Promise((r) => setTimeout(r, 60));

class Client {
  static async make(h, name = h) {
    const res = await post('/api/register', { handle: h, name, password: 'a long password' });
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
        if (m.t === 'hello') { this.hello = m.d; resolve(this); } else if (m.t === 'ack') this.acks.get(m.id)?.(m); else if (m.t === 'ev') { this.events.push(m); this.waiter?.(); }
      });
    });
  }
  op(op, d = {}) { const id = ++this.seq; this.ws.send(JSON.stringify({ t: 'op', id, op, d })); return new Promise((r) => this.acks.set(id, r)); }
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
  shut() { return new Promise((r) => { this.ws.on('close', r); this.ws.close(); }); }
}

// An owner, a member with only 'post', and a moderator; one text room.
async function house(p) {
  const ow = await Client.make(handle(`${p}o`), `Owen ${p}`);
  const mm = await Client.make(handle(`${p}m`), `Milo ${p}`);
  const md = await Client.make(handle(`${p}d`), `Mona ${p}`);
  const made = await ow.ok('house.create', { name: `Chat ${p}`, hue: 35 });
  const h = await ow.next('house', (d) => d.house.id === made.house);
  const [, modRole] = h.house.roles.map((r) => r.id);
  await ow.ok('role.update', { house: made.house, role: modRole, name: 'Mod', perms: ['post', 'invite', 'announce', 'moderate', 'timeout'] });
  const { id: plainRole } = await ow.ok('role.create', { house: made.house });
  await ow.ok('role.update', { house: made.house, role: plainRole, name: 'Newcomer', perms: ['post', 'react'] }); // react: its own permission (server/community.js)
  await ow.ok('house.update', { house: made.house, joinRole: plainRole });
  for (const c of [mm, md]) { const { code } = await ow.ok('invite.create', { house: made.house }); await c.ok('invite.accept', { code }); }
  await ow.ok('member.role', { house: made.house, user: md.id, role: modRole });
  return { ow, mm, md, house: made.house, room: made.room, close: async () => { for (const c of [ow, mm, md]) await c.shut(); } };
}

test('reactions: skin-toned, ZWJ families, subdivision flags and long sequences are accepted; text is not', async () => {
  const s = await house('rx');
  const id = mid();
  await s.ow.ok('msg.send', { conv: s.room, id, text: 'react to me' });
  for (const e of ['👋🏽', '👨‍👩‍👧‍👦', '👩🏻‍❤️‍💋‍👨🏼', '🧑🏿‍🤝‍🧑🏻', '🏴󠁧󠁢󠁥󠁮󠁧󠁿', '👨🏻‍👩🏻‍👧🏻‍👦🏻']) {
    await s.mm.ok('react', { conv: s.room, id, emoji: e, on: true });
    const ev = await s.ow.next('react', (d) => d.id === id && d.reactions[e]);
    assert.deepEqual(ev.reactions[e], [s.mm.id], e);
  }
  for (const bad of ['abc', '👋 hi', '<b>', '👋'.repeat(17)]) assert.match(await s.mm.refused('react', { conv: s.room, id, emoji: bad, on: true }), /emoji only/, bad);
  await s.close();
});

test('@everyone from someone who may not post notices is stored as noPing and pings nobody; a moderator’s does', async () => {
  const s = await house('ev');
  const a = mid();
  await s.mm.ok('msg.send', { conv: s.room, id: a, text: 'hey @everyone look' });
  const seen = await s.ow.next('msg', (d) => d.m.id === a);
  assert.equal(seen.m.noPing, true, 'the event carries the flag');
  const row = srv.M.msg(a);
  assert.equal(row.noping, 1);
  assert.equal(!!srv.M.forMeExtra?.(s.ow.id, row, srv.M.where(s.room)), false, 'no mention for others');
  const b = mid();
  await s.md.ok('msg.send', { conv: s.room, id: b, text: '@here kiln is on' });
  const ok = await s.ow.next('msg', (d) => d.m.id === b);
  assert.equal(ok.m.noPing, undefined);
  // An edit that adds it is held to the same rule.
  const c = mid();
  await s.mm.ok('msg.send', { conv: s.room, id: c, text: 'plain' });
  await s.mm.ok('msg.edit', { conv: s.room, id: c, text: 'plain @everyone' });
  assert.equal(srv.M.msg(c).noping, 1);
  await s.close();
});

test('msg.peek: a reader gets the message; a non-member, a hidden room, a wrong conversation and a missing id get the same refusal', async () => {
  const s = await house('pk');
  const out = await Client.make(handle('pkx'), 'Outsider');
  const id = mid();
  await s.ow.ok('msg.send', { conv: s.room, id, text: 'link me' });
  const got = await s.mm.ok('msg.peek', { conv: s.room, id });
  assert.equal(got.m.text, 'link me');
  assert.equal(got.user.id, s.ow.id);
  const errs = [];
  errs.push(await out.refused('msg.peek', { conv: s.room, id }));
  errs.push(await s.mm.refused('msg.peek', { conv: s.room, id: 'm_doesnotexist01' }));
  const { id: dm } = await s.ow.ok('dm.open', { users: [s.md.id] });
  errs.push(await s.mm.refused('msg.peek', { conv: dm, id }));
  // A private room, and an open room hidden from everyone by an override.
  const { id: back } = await s.ow.ok('room.create', { house: s.house, name: 'Backroom', kind: 'text', private: true });
  const secret = mid();
  await s.ow.ok('msg.send', { conv: back, id: secret, text: 'pineapple' });
  errs.push(await s.mm.refused('msg.peek', { conv: back, id: secret }));
  const { id: hid } = await s.ow.ok('room.create', { house: s.house, name: 'Hidden', kind: 'text' });
  const hm = mid();
  await s.ow.ok('msg.send', { conv: hid, id: hm, text: 'hidden words' });
  assert.equal((await s.mm.ok('msg.peek', { conv: hid, id: hm })).m.text, 'hidden words');
  await s.ow.ok('room.override', { room: hid, type: 'everyone', target: '*', deny: ['view'] });
  errs.push(await s.mm.refused('msg.peek', { conv: hid, id: hm }));
  assert.equal(new Set(errs).size, 1, `one answer for all: ${[...new Set(errs)].join(' / ')}`);
  assert.equal(errs[0], 'You can’t see that message.');
  // Rate limited: 30, then 2 a second.
  srv.resetLimits();
  let refused = 0;
  for (let i = 0; i < 34; i++) if (!(await s.mm.op('msg.peek', { conv: s.room, id })).ok) refused++;
  assert.ok(refused >= 2, `some refused (${refused})`);
  // Message links are never fetched for a preview.
  assert.equal(isMessageLink(`${base}/m/${s.room}/${id}`), true);
  assert.deepEqual(previewLinks(`see ${base}/m/${s.room}/${id} and https://example.com/a`), ['https://example.com/a']);
  await out.shut();
  await s.close();
});

test('spoiler and alt text: checked, cleaned, filtered, stored, forwarded; spoiler links get no preview; spoiler GIFs are not favourites', async () => {
  const s = await house('sp');
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
  const up = async () => (await (await upload(s.mm.cookie, s.room, 'image/png', png, 'pot.png')).json()).id;
  let f = await up();
  assert.match(await s.mm.refused('msg.send', { conv: s.room, id: mid(), text: '', files: [{ id: f, spoiler: 'yes' }] }), /Spoiler is yes or no/);
  assert.match(await s.mm.refused('msg.send', { conv: s.room, id: mid(), text: '', files: [{ id: f, alt: 5 }] }), /description is text/);
  assert.match(await s.mm.refused('msg.send', { conv: s.room, id: mid(), text: '', files: [{ id: f, alt: 'x'.repeat(1025) }] }), /at most 1024/);
  await s.ow.ok('automod.set', { house: s.house, words: ['badword'], action: 'block' });
  assert.match(await s.mm.refused('msg.send', { conv: s.room, id: mid(), text: 'clean', files: [{ id: f, alt: 'a badword here' }] }), /word this house doesn’t allow/);
  await s.ow.ok('automod.set', { house: s.house, words: [] });
  const id = mid();
  const sent = await s.mm.ok('msg.send', { conv: s.room, id, text: '', files: [{ id: f, w: 4, h: 3, spoiler: true, alt: '  A blue\u0007 pot,\nglazed  ' }] });
  assert.deepEqual([sent.m.files[0].spoiler, sent.m.files[0].alt], [true, 'A blue pot, glazed']);
  const ev = await s.ow.next('msg', (d) => d.m.id === id);
  assert.deepEqual([ev.m.files[0].spoiler, ev.m.files[0].alt], [true, 'A blue pot, glazed'], 'everyone hears it at once');
  assert.equal(JSON.parse(srv.M.msg(id).files)[0].alt, 'A blue pot, glazed');
  // Forwarding keeps both.
  const { id: dm } = await s.mm.ok('dm.open', { users: [s.ow.id] });
  const fw = await s.mm.ok('msg.forward', { conv: s.room, id, to: dm, newId: mid() });
  assert.deepEqual([fw.m.files[0].spoiler, fw.m.files[0].alt], [true, 'A blue pot, glazed']);
  // A spoiler GIF can't be saved and isn't "recent".
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64, 7)]);
  const g = (await (await upload(s.mm.cookie, s.room, 'image/gif', gif, 'secret.gif')).json()).id;
  await s.mm.ok('msg.send', { conv: s.room, id: mid(), text: '', files: [{ id: g, spoiler: true }] });
  assert.match(await s.ow.refused('gif.fav', { file: g, on: true }), /spoiler/i);
  assert.equal((await s.ow.ok('gif.recent')).gifs.some((x) => x.id === g), false);
  // Links inside ||spoilers|| get no preview.
  assert.deepEqual(previewLinks('look ||https://example.com/ending|| and https://example.com/open'), ['https://example.com/open']);
  f = await up();
  await s.mm.ok('msg.send', { conv: s.room, id: mid(), text: 'no alt', files: [{ id: f, alt: '   ' }] });
  // The first reply in a new thread keeps them too.
  const th = `t:${id}`;
  const tf = (await (await upload(s.mm.cookie, th, 'image/png', png, 'reply.png')).json()).id;
  const tr = await s.mm.ok('msg.send', { conv: th, id: mid(), text: '', files: [{ id: tf, spoiler: true, alt: 'in a thread' }] });
  assert.deepEqual([tr.m.files[0].spoiler, tr.m.files[0].alt], [true, 'in a thread']);
  await s.close();
});

test('uploads are typed by their bytes: an HTML page named .png is just bytes, real video plays, SVG always downloads', async () => {
  const s = await house('up');
  const html = Buffer.from('<!doctype html><script>alert(1)</script>');
  const bad = await (await upload(s.mm.cookie, s.room, 'image/png', html, 'cat.png')).json();
  assert.equal(bad.kind, 'file');
  assert.equal(srv.db.get('SELECT type FROM files WHERE id = ?', bad.id).type, 'application/octet-stream');
  const res = await fetch(`${base}/api/files/${bad.id}`, { headers: { cookie: s.ow.cookie } });
  assert.match(res.headers.get('content-disposition'), /^attachment/);
  await res.arrayBuffer();
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(200, 1)]);
  const v = await (await upload(s.mm.cookie, s.room, 'video/webm', webm, 'clip.webm')).json();
  assert.equal(v.kind, 'video');
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(200, 1)]);
  const m = await (await upload(s.mm.cookie, s.room, 'video/mp4', mp4, 'clip.mp4')).json();
  assert.equal(m.kind, 'video');
  const sent = await s.mm.ok('msg.send', { conv: s.room, id: mid(), text: '', files: [{ id: m.id, w: 640, h: 360, duration: 4.25 }] });
  assert.deepEqual([sent.m.files[0].kind, sent.m.files[0].w, sent.m.files[0].h, sent.m.files[0].duration], ['video', 640, 360, 4.3]);
  const ranged = await fetch(`${base}/api/files/${m.id}`, { headers: { cookie: s.ow.cookie, range: 'bytes=0-9' } });
  assert.equal(ranged.status, 206);
  assert.match(ranged.headers.get('content-disposition'), /^inline/);
  await ranged.arrayBuffer();
  assert.equal((await (await upload(s.mm.cookie, s.room, 'video/mp4', html, 'fake.mp4')).json()).kind, 'file');
  const svg = await (await upload(s.mm.cookie, s.room, 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'logo.svg')).json();
  assert.equal(svg.kind, 'file');
  const sv = await fetch(`${base}/api/files/${svg.id}`, { headers: { cookie: s.ow.cookie } });
  assert.equal(sv.headers.get('content-type'), 'application/octet-stream');
  assert.match(sv.headers.get('content-disposition'), /^attachment/);
  await sv.arrayBuffer();
  // An mp3 is a sound file, not a voice message, unless the recorder says so.
  const mp3 = await (await upload(s.mm.cookie, s.room, 'audio/mpeg', Buffer.concat([Buffer.from('ID3'), Buffer.alloc(100, 1)]), 'song.mp3')).json();
  const a1 = await s.mm.ok('msg.send', { conv: s.room, id: mid(), text: '', files: [{ id: mp3.id, voice: 'yes' }] });
  assert.deepEqual([a1.m.files[0].kind, a1.m.files[0].voice], ['audio', undefined]);
  // Unit: claimed types and real bytes.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  assert.equal(uploadType('image/jpeg', jpeg), 'image/jpeg');
  assert.equal(uploadType('image/png', jpeg), 'application/octet-stream');
  assert.equal(uploadType('image/bmp', jpeg), 'application/octet-stream');
  assert.equal(uploadType('text/plain', Buffer.from('hello')), 'text/plain');
  assert.equal(fileKind('image/svg+xml'), 'file');
  assert.equal(fileKind('video/webm'), 'video');
  await s.close();
});

test('/roll: the server rolls from the spec alone, writes a message that can’t be edited, and respects slowmode, timeouts and limits', async () => {
  const s = await house('rl');
  const id = mid();
  const r = await s.mm.ok('cmd.roll', { conv: s.room, id, spec: '3d6', result: 18, text: 'rolled 3d6: 6 + 6 + 6 = 18' });
  const { roll } = r.m.cmd;
  assert.equal(roll.rolls.length, 3);
  assert.ok(roll.rolls.every((x) => Number.isInteger(x) && x >= 1 && x <= 6));
  assert.equal(roll.total, roll.rolls.reduce((a, b) => a + b, 0));
  assert.equal(r.m.text, `rolled 3d6: ${roll.rolls.join(' + ')} = ${roll.total}`);
  const ev = await s.ow.next('msg', (d) => d.m.id === id);
  assert.deepEqual(ev.m.cmd, r.m.cmd, 'everyone sees the same result');
  assert.match(await s.mm.refused('msg.edit', { conv: s.room, id, text: 'rolled 3d6: 18' }), /can’t be edited/);
  // A typed look-alike is just a message.
  const fake = await s.mm.ok('msg.send', { conv: s.room, id: mid(), text: 'rolled 1d20: 20', cmd: { roll: { n: 1, sides: 20, rolls: [20], total: 20 } } });
  assert.equal(fake.m.cmd, undefined);
  for (const bad of ['0d6', '21d6', 'd1', '2d1001', 'abc', '2d6+1', 7]) await s.mm.refused('cmd.roll', { conv: s.room, id: mid(), spec: bad });
  assert.match((await s.mm.ok('cmd.roll', { conv: s.room, id: mid() })).m.text, /^rolled 1d6: [1-6]$/);
  // Rate limit: 5, then one every 3 seconds.
  srv.resetLimits();
  let refused = 0;
  for (let i = 0; i < 7; i++) if (!(await s.mm.op('cmd.roll', { conv: s.room, id: mid(), spec: 'd20' })).ok) refused++;
  assert.ok(refused >= 2, `rolls beyond five are refused (${refused})`);
  srv.resetLimits();
  // Slowmode.
  await s.ow.ok('room.slowmode', { room: s.room, seconds: 5 });
  assert.match(await s.mm.refused('cmd.roll', { conv: s.room, id: mid(), spec: 'd20' }), /Slowmode/);
  await s.ow.ok('room.slowmode', { room: s.room, seconds: 0 });
  // Timeout.
  await s.md.ok('mod.timeout', { house: s.house, user: s.mm.id, ms: 60_000 });
  assert.match(await s.mm.refused('cmd.roll', { conv: s.room, id: mid(), spec: 'd20' }), /timed out/);
  await s.md.ok('mod.timeout', { house: s.house, user: s.mm.id, ms: 0 });
  // Somewhere you can't write.
  const out = await Client.make(handle('rlx'), 'Out');
  assert.match(await out.refused('cmd.roll', { conv: s.room, id: mid() }), /access/);
  await out.shut();
  await s.close();
});

test('silent messages send no push; replyPing: false doesn’t notify the author replied to, an @mention in it still does', async () => {
  const got = [];
  const mock = createServer(async (req, res) => { for await (const c of req) void c; got.push(req.url); res.writeHead(201); res.end(); });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const push = `http://127.0.0.1:${mock.address().port}`;
  try {
    const s = await house('si');
    const C = await import('node:crypto');
    const ua = C.createECDH('prime256v1'); ua.generateKeys();
    const sub = { endpoint: `${push}/ow`, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: C.randomBytes(16).toString('base64url') } };
    assert.equal((await post('/api/push/subscribe', sub, s.ow.cookie)).status, 201);
    const { id: dm } = await s.mm.ok('dm.open', { users: [s.ow.id] });
    const root = mid();
    await s.ow.ok('msg.send', { conv: s.room, id: root, text: 'my pot' });
    await s.ow.shut();
    for (let i = 0; i < 50 && srv.hub.connected(s.ow.id); i++) await settle();
    const wait = async (count) => { for (let i = 0; i < 40 && got.length < count; i++) await settle(); await settle(); };

    const quiet = await s.mm.ok('msg.send', { conv: dm, id: mid(), text: '@silent just so you know' });
    assert.deepEqual([quiet.m.silent, quiet.m.text], [true, 'just so you know']);
    await s.mm.ok('msg.send', { conv: dm, id: mid(), text: 'also quiet', silent: true });
    await wait(1);
    assert.equal(got.length, 0, 'silent messages push nothing');
    assert.equal(srv.M.msg(quiet.m.id).silent, 1);
    await s.mm.ok('msg.send', { conv: dm, id: mid(), text: 'loud' });
    await wait(1);
    assert.equal(got.length, 1, 'a normal one does');

    const r1 = await s.mm.ok('msg.send', { conv: s.room, id: mid(), text: 'nice pot', replyTo: root, replyPing: false });
    assert.equal(r1.m.replyPing, false);
    await wait(2);
    assert.equal(got.length, 1, 'a reply with the mention off pushes nothing');
    const h = srv.M.userRow(s.ow.id).handle;
    await s.mm.ok('msg.send', { conv: s.room, id: mid(), text: `@${h} nice pot`, replyTo: root, replyPing: false });
    await wait(2);
    assert.equal(got.length, 2, 'an explicit @mention still does');
    await s.mm.ok('msg.send', { conv: s.room, id: mid(), text: 'a normal reply', replyTo: root });
    await wait(3);
    assert.equal(got.length, 3, 'and a normal reply does');
    assert.match(await s.mm.refused('msg.send', { conv: s.room, id: mid(), text: 'x', silent: 'yes' }), /Silent is yes or no/);
    assert.match(await s.mm.refused('msg.send', { conv: s.room, id: mid(), text: 'x', replyPing: 0 }), /on or off/);
    await s.mm.shut(); await s.md.shut();
  } finally { mock.close(); }
});

test('reactions: invisible ones (tag characters alone, joiners, selectors, bare digits) are refused', async () => {
  const s = await house('rv');
  const id = mid();
  await s.ow.ok('msg.send', { conv: s.room, id, text: 'react to me' });
  for (const bad of ['\u{E0067}\u{E0062}\u{E007F}', '‍', '️', '‍️', '5', '👍\u{E0067}', '\u{E0020}'.repeat(10)]) {
    assert.match(await s.mm.refused('react', { conv: s.room, id, emoji: bad, on: true }), /emoji only/, JSON.stringify(bad));
  }
  for (const e of ['🏴󠁧󠁢󠁳󠁣󠁴󠁿', '1️⃣', '🇫🇷']) await s.mm.ok('react', { conv: s.room, id, emoji: e, on: true });
  await s.close();
});
