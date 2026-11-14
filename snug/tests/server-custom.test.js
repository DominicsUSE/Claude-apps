// Customisation on the real server (server/appearance.js, js/lib/account.js):
// profile pictures and who may load them, decorations, name styles, profile
// colours, accents, custom themes, shortcuts and sounds. Every rule is
// checked from a separate signed-in socket, never trusted from the client.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';

const dir = mkdtempSync(join(tmpdir(), 'snug-custom-'));
let srv, base;
test.before(async () => { srv = await startServer({ port: 0, dataDir: dir, quiet: true }); base = `http://127.0.0.1:${srv.port}`; });
test.beforeEach(() => srv.resetLimits());
test.after(async () => { await srv.close(); rmSync(dir, { recursive: true, force: true }); });

const post = (path, body, cookie) => fetch(base + path, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
});

// A real PNG of one colour, w x h.
export function png(w, h, rgb = [139, 92, 246]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

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
        if (m.t === 'hello') { this.hello = m.d; resolve(this); } else if (m.t === 'ack') this.acks.get(m.id)?.(m); else if (m.t === 'ev') this.events.push(m);
      });
    });
  }
  op(op, d = {}) { const id = ++this.seq; this.ws.send(JSON.stringify({ t: 'op', id, op, d })); return new Promise((r) => this.acks.set(id, r)); }
  async ok(op, d) { const a = await this.op(op, d); assert.equal(a.ok, true, `${op}: ${a.error}`); return a.d; }
  async refused(op, d) { const a = await this.op(op, d); assert.equal(a.ok, false, `${op} should be refused`); return a.error; }
  async next(ev, pred = () => true, ms = 2000) {
    const end = Date.now() + ms;
    for (;;) {
      const i = this.events.findIndex((e) => e.ev === ev && pred(e.d));
      if (i >= 0) return this.events.splice(i, 1)[0].d;
      if (Date.now() > end) throw new Error(`no "${ev}" event arrived`);
      await new Promise((r) => setTimeout(r, 30));
    }
  }
  upload(buf, type = 'image/png', q = 'avatar') {
    return fetch(`${base}/api/files?${q}`, { method: 'POST', headers: { 'content-type': type, origin: base, cookie: this.cookie }, body: buf });
  }
  get(path) { return fetch(base + path, { headers: { cookie: this.cookie } }); }
}

let ava, bo, cy, dee, house;

test('profile pictures: uploads are checked by their bytes, size and dimensions', async () => {
  ava = await Client.make('cu-ava', 'Ava');
  // A PNG name on bytes that aren't a picture.
  const fake = await ava.upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'.padEnd(400, ' ')), 'image/png');
  assert.equal(fake.status, 415);
  assert.match((await fake.json()).error, /PNG, JPEG, GIF or WebP/);
  // Over 2 MB.
  const big = await ava.upload(Buffer.alloc(2 * 1024 * 1024 + 10, 1), 'image/png');
  assert.equal(big.status, 413);
  // Too small, too big.
  assert.equal((await ava.upload(png(32, 32))).status, 422);
  assert.equal((await ava.upload(png(2100, 64))).status, 422);
  const ok = await ava.upload(png(128, 128));
  assert.equal(ok.status, 201);
  const f = await ok.json();
  assert.equal(f.type, 'image/png');
  assert.equal(f.w, 128);
  // Someone else's upload, or a message file, can't become your picture.
  bo = await Client.make('cu-bo', 'Bo');
  assert.match(await bo.refused('me.update', { avatar: f.id }), /Upload the picture first/);
  assert.match(await ava.refused('me.update', { avatar: 'f_notarealfile1' }), /Upload the picture first/);
  assert.match(await ava.refused('me.update', { avatar: '../../etc/passwd' }), /Upload the picture first/);
  await ava.ok('me.update', { avatar: f.id });
  const self = await ava.next('user', (d) => d.user.id === ava.id && d.user.img);
  assert.equal(self.user.img, `/api/avatars/${f.id}`);
  ava.avatarFile = f.id;
});

test('profile pictures: friends and housemates may load them; strangers and blocked people get the same 404', async () => {
  cy = await Client.make('cu-cy', 'Cy');
  dee = await Client.make('cu-dee', 'Dee');
  const path = `/api/avatars/${ava.avatarFile}`;
  assert.equal((await ava.get(path)).status, 200, 'the owner');
  assert.equal((await cy.get(path)).status, 404, 'a stranger');
  assert.equal((await fetch(base + path)).status, 401, 'nobody signed in');
  assert.equal((await cy.get('/api/avatars/f_doesnotexist00')).status, 404, 'missing looks the same as forbidden');
  // A friend.
  await bo.ok('friend.request', { user: ava.id });
  await ava.ok('friend.accept', { user: bo.id });
  const res = await bo.get(path);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.match(res.headers.get('content-security-policy'), /sandbox/);
  assert.match(res.headers.get('cache-control'), /private/);
  assert.equal(Buffer.from(await res.arrayBuffer()).subarray(1, 4).toString(), 'PNG');
  // Someone in a shared house, until the owner blocks them.
  ({ house } = await ava.ok('house.create', { name: 'Custom house', hue: 200 }));
  const { code } = await ava.ok('invite.create', { house });
  await dee.ok('invite.accept', { code });
  assert.equal((await dee.get(path)).status, 200, 'a housemate');
  await ava.ok('block.set', { user: dee.id, on: true });
  assert.equal((await dee.get(path)).status, 404, 'blocked by the owner');
  await ava.ok('block.set', { user: dee.id, on: false });
  // An old picture stops being served once it's replaced, and its file goes.
  const f2 = await (await ava.upload(png(96, 96, [88, 199, 165]))).json();
  await ava.ok('me.update', { avatar: f2.id });
  assert.equal((await bo.get(path)).status, 404, 'the old picture');
  assert.equal(srv.db.get('SELECT 1 x FROM files WHERE id = ?', ava.avatarFile), undefined, 'the old file row is removed');
  assert.equal((await bo.get(`/api/avatars/${f2.id}`)).status, 200);
  ava.avatarFile = f2.id;
});

test('profile pictures: clearing removes img for everyone; export includes it; deleting the account removes it', async () => {
  // Friends see the picture in their copy of the person.
  const before = await bo.next('user', (d) => d.user.id === ava.id && d.user.img === `/api/avatars/${ava.avatarFile}`);
  assert.ok(before);
  const exp = await (await ava.get('/api/account/export')).json();
  assert.deepEqual(exp.appearance.picture, { file: ava.avatarFile, type: 'image/png' });
  await ava.ok('me.update', { avatar: null });
  const after = await bo.next('user', (d) => d.user.id === ava.id && !d.user.img);
  assert.equal(after.user.img, undefined);
  assert.equal((await bo.get(`/api/avatars/${ava.avatarFile}`)).status, 404);
  // A person who deletes their account takes the picture with them.
  const eve = await Client.make('cu-eve', 'Eve');
  const f = await (await eve.upload(png(80, 80))).json();
  await eve.ok('me.update', { avatar: f.id, decoration: 'ring' });
  const del = await post('/api/account/delete', { password: 'a long password', confirm: 'cu-eve' }, eve.cookie);
  assert.equal(del.status, 200, await del.clone().text());
  const row = srv.db.get('SELECT avatar, decoration FROM users WHERE id = ?', eve.id);
  assert.equal(row.avatar, null);
  assert.equal(row.decoration, null);
  assert.equal(srv.db.get('SELECT 1 x FROM files WHERE id = ?', f.id), undefined);
  assert.equal(existsSync(join(dir, 'files', f.id)), false);
});

test('decorations, name styles and profile colours: fixed lists and readable colours only', async () => {
  assert.match(await ava.refused('me.update', { decoration: 'flames' }), /decorations/);
  assert.match(await ava.refused('me.update', { decoration: 'ring', decorationHue: 17 }), /decoration colours/);
  assert.match(await ava.refused('me.update', { decorationHue: '200' }), /decoration colours/);
  await ava.ok('me.update', { decoration: 'leaves', decorationHue: 142 });
  let seen = await bo.next('user', (d) => d.user.id === ava.id && d.user.decoration === 'leaves');
  assert.equal(seen.user.decorationHue, 142);

  assert.match(await ava.refused('me.update', { nameStyle: { font: 'comic' } }), /name fonts/);
  assert.match(await ava.refused('me.update', { nameStyle: { weight: 'black' } }), /name weights/);
  assert.match(await ava.refused('me.update', { nameStyle: { hue: 5 } }), /name colours/);
  assert.match(await ava.refused('me.update', { nameStyle: { font: 'mono', css: 'x' } }), /isn’t valid/);
  assert.match(await ava.refused('me.update', { nameStyle: 'font:serif' }), /isn’t valid/);
  await ava.ok('me.update', { nameStyle: { font: 'serif', weight: 'bold', hue: 318 } }); // Plum: retired, still accepted
  seen = await bo.next('user', (d) => d.user.id === ava.id && d.user.nameStyle);
  assert.deepEqual(seen.user.nameStyle, { font: 'serif', weight: 'bold', hue: 318 });

  // Mid grey: neither dark nor light text reaches 4.5:1 on it.
  assert.match(await ava.refused('me.update', { profileColors: ['#777777', '#202020'] }), /readable/);
  assert.match(await ava.refused('me.update', { profileColors: ['#2B4C7E'] }), /two hex/);
  assert.match(await ava.refused('me.update', { profileColors: ['red', '#202020'] }), /two hex/);
  assert.match(await ava.refused('me.update', { profileColors: ['#2B4C7E;background:url(x)', '#202020'] }), /two hex/);
  await ava.ok('me.update', { profileColors: ['#2b4c7e', '#F3E9D2'] });
  seen = await bo.next('user', (d) => d.user.id === ava.id && d.user.profileColors);
  assert.deepEqual(seen.user.profileColors, ['#2B4C7E', '#F3E9D2']);
  // Strangers don't get the styling with a hidden view, and the changes are rate limited.
  let limited = false;
  for (let i = 0; i < 30 && !limited; i++) {
    const a = await ava.op('me.update', { decorationHue: i % 2 ? 200 : 228 });
    if (!a.ok) { assert.match(a.error, /little fast/); limited = true; }
  }
  assert.ok(limited, 'profile styling is rate limited');
});

test('settings: accents must stay readable on every theme; custom themes are checked and capped at five', async () => {
  srv.resetLimits();
  assert.match(await ava.refused('prefs.set', { prefs: { accent: '#zzzzzz' } }), /hex colour/);
  assert.match(await ava.refused('prefs.set', { prefs: { accent: '#151617' } }), /can’t be made readable/);
  assert.match(await ava.refused('prefs.set', { prefs: { accent: '#FFFFFF' } }), /can’t be made readable/);
  assert.match(await ava.refused('prefs.set', { prefs: { accent: 'red' } }), /hex colour/);
  const r = await ava.ok('prefs.set', { prefs: { accent: '#3a7bd5' } });
  assert.equal(r.prefs.accent, '#3A7BD5');
  await ava.ok('prefs.set', { prefs: { accent: 'mint' } });
  // Snug's colour was coral before violet: an older client may still send it,
  // and a stored one reads back as violet.
  assert.equal((await ava.ok('prefs.set', { prefs: { accent: 'coral', tone: 'coral' } })).prefs.accent, 'violet');
  srv.db.run('UPDATE user_prefs SET prefs = ? WHERE user = ?', JSON.stringify({ accent: 'coral', tone: 'coral', theme: 'sepia' }), ava.id);
  assert.deepEqual(srv.M.prefsOf(ava.id), { accent: 'violet', tone: 'violet', theme: 'sepia' });
  const again = Object.assign(new Client(), { cookie: ava.cookie });
  await again.connect();
  assert.equal(again.hello.account.prefs.accent, 'violet', 'the snapshot carries the upgraded value');
  again.ws.close();
  await ava.ok('prefs.set', { prefs: { accent: 'mint', tone: null, theme: null } });

  const good = { id: 'night1', name: 'Night', base: 'dark', bg: '#1E2228', surface: '#252A31', text: '#E8ECF1', accent: '#7AA2F7' };
  // Unreadable: grey text on grey.
  assert.match(await ava.refused('prefs.set', { prefs: { customThemes: [{ ...good, text: '#3A3F46' }] } }), /isn’t readable/);
  // A light theme with dark backgrounds.
  assert.match(await ava.refused('prefs.set', { prefs: { customThemes: [{ ...good, base: 'light' }] } }), /isn’t readable/);
  // CSS where a colour goes, extra keys.
  assert.match(await ava.refused('prefs.set', { prefs: { customThemes: [{ ...good, bg: '#1E2228;}body{display:none' }] } }), /hex colours/);
  assert.match(await ava.refused('prefs.set', { prefs: { customThemes: [{ ...good, css: 'x' }] } }), /doesn’t know/);
  // A theme that isn't saved can't be used.
  assert.match(await ava.refused('prefs.set', { prefs: { theme: 'custom:night1' } }), /Save that theme/);
  const six = Array.from({ length: 6 }, (_, i) => ({ ...good, id: `night${i}`, name: `Night ${i}` }));
  assert.match(await ava.refused('prefs.set', { prefs: { customThemes: six } }), /up to 5 themes/);
  assert.match(await ava.refused('prefs.set', { prefs: { customThemes: [good, { ...good }] } }), /share an id/);
  await ava.ok('prefs.set', { prefs: { customThemes: [good], theme: 'custom:night1' } });
  const stored = JSON.parse(srv.db.get('SELECT prefs FROM user_prefs WHERE user = ?', ava.id).prefs);
  assert.equal(stored.theme, 'custom:night1');
  assert.deepEqual(stored.customThemes, [good]);
  // Removing the theme in use puts the theme back to the default.
  await ava.ok('prefs.set', { prefs: { customThemes: [] } });
  assert.equal(JSON.parse(srv.db.get('SELECT prefs FROM user_prefs WHERE user = ?', ava.id).prefs).theme, undefined);
  for (const t of ['ash', 'slate', 'moss', 'paper', 'sepia', 'contrast']) await ava.ok('prefs.set', { prefs: { theme: t } });
  assert.match(await ava.refused('prefs.set', { prefs: { theme: 'custom:../x' } }), /choices/);
});

test('settings: shortcuts, sounds and chat display are checked on the server', async () => {
  srv.resetLimits();
  assert.match(await ava.refused('prefs.set', { prefs: { keys: { launchMissiles: 'Mod+J' } } }), /isn’t a shortcut/);
  assert.match(await ava.refused('prefs.set', { prefs: { keys: { quick: 'Mod+Banana' } } }), /isn’t valid/);
  assert.match(await ava.refused('prefs.set', { prefs: { keys: { quick: 'J' } } }), /isn’t valid/);
  assert.match(await ava.refused('prefs.set', { prefs: { keys: { quick: 'Ctrl+W' } } }), /can’t be used/);
  assert.match(await ava.refused('prefs.set', { prefs: { keys: { quick: 'Mod+Shift+M' } } }), /share/);
  assert.match(await ava.refused('prefs.set', { prefs: { keys: 'quick=Mod+J' } }), /aren’t valid/);
  const r = await ava.ok('prefs.set', { prefs: { keys: { quick: 'ctrl+alt+j', mute: '' } } });
  assert.deepEqual(r.prefs.keys, { quick: 'Ctrl+Alt+J', mute: '' });
  assert.match(await ava.refused('prefs.set', { prefs: { sounds: { mention: 'airhorn' } } }), /Snug’s sounds/);
  assert.match(await ava.refused('prefs.set', { prefs: { sounds: { ring: 'bell' } } }), /aren’t valid/);
  assert.match(await ava.refused('prefs.set', { prefs: { soundVolume: 101 } }), /0 to 100/);
  const s = await ava.ok('prefs.set', { prefs: { sounds: { mention: 'bell', dm: 'wood' }, soundVolume: 40 } });
  assert.deepEqual(s.prefs.sounds, { message: 'soft', mention: 'bell', dm: 'wood' });
  assert.match(await ava.refused('prefs.set', { prefs: { gifAutoplay: 'sometimes' } }), /choices/);
  assert.match(await ava.refused('prefs.set', { prefs: { chatBg: 'url(x)' } }), /choices/);
  assert.match(await ava.refused('prefs.set', { prefs: { font: 'comic' } }), /choices/);
  await ava.ok('prefs.set', { prefs: { gifAutoplay: 'never', jumboEmoji: false, showTimes: 'hover', showReactions: false, font: 'serif', codeFont: 'system-mono', chatBg: 'arches' } });
});

test('me.update: all or nothing — a refused change keeps none of the styling, and the old picture', async () => {
  const fay = await Client.make('cu-fay', 'Fay');
  const f1 = await (await fay.upload(png(80, 80))).json();
  await fay.ok('me.update', { avatar: f1.id, decoration: 'leaves' });
  const f2 = await (await fay.upload(png(80, 80))).json();
  assert.match(await fay.refused('me.update', { decoration: 'ring', avatar: f2.id, name: '' }), /can’t be empty/);
  const row = srv.db.get('SELECT avatar, decoration, name FROM users WHERE id = ?', fay.id);
  assert.equal(row.decoration, 'leaves');
  assert.equal(row.avatar, f1.id);
  assert.equal(row.name, 'Fay');
  assert.ok(srv.db.get('SELECT 1 x FROM files WHERE id = ?', f1.id), 'the old picture is still there');
  assert.equal(existsSync(join(dir, 'files', f1.id)), true);
  // The same change without the bad name goes through, whole.
  await fay.ok('me.update', { decoration: 'ring', avatar: f2.id, name: 'Fay R' });
  assert.deepEqual({ ...srv.db.get('SELECT avatar, decoration, name FROM users WHERE id = ?', fay.id) }, { avatar: f2.id, decoration: 'ring', name: 'Fay R' });
});
