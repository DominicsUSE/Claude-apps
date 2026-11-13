// Snug's server: static files, accounts, file uploads and the real-time hub.
// Start it with `npm start`. Configuration comes from environment variables;
// see the README.
import { createServer } from 'node:http';
import { writeFile, mkdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, normalize, extname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createModel, newId } from './model.js';
import { createHub, ringMsFrom, voiceGraceFrom } from './hub.js';
import { AUDIO_TYPES, VIDEO_TYPES, uploadType, fileKind, parseRange, createMediaHttp } from './media.js'; // voice messages, GIFs, video
import { createEmojiHttp, emojiReads } from './emoji.js'; // custom emoji per house
import { createMessagingHttp } from './messaging.js'; // sticker uploads and images; link previews and the scheduler are configured below
import { createVoiceOptsHttp, iceConfig } from './voiceopts.js'; // soundboard uploads and sound files; STUN and TURN (short-lived TURN credentials)
import { createPush } from './push.js'; // notifications when Snug is closed (Web Push)
import { createPlacesHttp } from './places.js'; // webhook deliveries: POST /api/hooks/<id>/<token>
import { createAccountHttp } from './account.js'; // two-factor sign-in, export, deactivate, delete, banners
import { createAppearanceHttp } from './appearance.js'; // profile pictures: POST /api/files?avatar, GET /api/avatars/<file>
import { createCommunityHttp } from './community.js'; // house pictures, event covers, invitation previews with custom links
import { HUES } from '../js/lib/util.js';
import {
  hashPassword, checkPassword, burnPasswordCheck, createSession, sessionUser, endSession, endAllSessions,
  readCookie, sessionCookie, COOKIE, limiter, safeDecode,
} from './auth.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = ['index.html', 'css/', 'js/', 'fonts/', 'vendor/', 'docs/', 'brand/', 'sw.js'];
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};
// Uploaded images shown inline. Anything else downloads.
// SVG is not among them: it can carry script and links, so it always downloads.
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
// Voice messages, sound files and videos play inline too (their type is checked
// against the bytes at upload), and so do GIFs the server fetched as video.
for (const t of [...AUDIO_TYPES, ...VIDEO_TYPES]) INLINE.add(t);
const MAX_FILE = 10 * 1024 * 1024;
const HANDLE = /^[a-z0-9](?:[a-z0-9_.-]{0,22}[a-z0-9])?$/;

const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "media-src 'self' blob:", "connect-src 'self'", "font-src 'self'", "object-src 'none'", "base-uri 'none'",
  "frame-ancestors 'none'", "form-action 'self'",
].join('; ');

export async function startServer({
  port = Number(process.env.PORT) || 8787,
  host = process.env.HOST || '127.0.0.1',
  dataDir = process.env.SNUG_DATA || join(ROOT, 'data'),
  secure = process.env.SNUG_SECURE === '1',
  trustProxy = process.env.SNUG_TRUST_PROXY === '1',
  extraOrigins = (process.env.SNUG_ORIGINS || '').split(',').filter(Boolean),
  quiet = false,
  // Tests only: let push subscriptions point at a mock push service on http://127.0.0.1.
  pushAllowLocal = process.env.SNUG_PUSH_ALLOW_LOCAL === '1',
  // How long a call rings before it counts as missed. Tests shorten it.
  ringMs = ringMsFrom(),
  // How long a dropped connection's voice slot is held. Tests shorten it.
  voiceGraceMs = voiceGraceFrom(),
  // Where STUN and TURN settings come from (SNUG_STUN, SNUG_TURN_*). Tests pass their own.
  iceEnv = process.env,
  // Link previews (server/messaging.js). SNUG_LINK_PREVIEWS=0 turns them off.
  linkPreviews = process.env.SNUG_LINK_PREVIEWS !== '0',
  // Tests only: let previews fetch a local stand-in site on 127.0.0.1 (every other private address stays refused).
  linkAllowLocal = false,
} = {}) {
  const db = openDb(dataDir === ':memory:' ? ':memory:' : join(dataDir, 'snug.db'));
  const filesDir = join(dataDir === ':memory:' ? join(ROOT, 'data', 'test-files') : dataDir, 'files');
  await mkdir(filesDir, { recursive: true, mode: 0o700 });
  const M = createModel(db);
  const log = quiet ? () => {} : (...a) => console.log(new Date().toISOString(), ...a);

  // STUN, and TURN with a static login or (SNUG_TURN_SECRET) short-lived credentials per person (server/voiceopts.js).
  const ice = iceConfig(iceEnv);

  const authLimit = limiter({ capacity: 10, perSecond: 10 / 900 });   // 10 tries per 15 minutes
  const uploadLimit = limiter({ capacity: 20, perSecond: 0.2 });
  const ipOf = (req) => (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress;
  // The page's own origin, plus any configured ones. Used for sockets and state-changing requests.
  const origins = (req) => {
    const proto = secure || (trustProxy && req.headers['x-forwarded-proto'] === 'https') ? 'https' : 'http';
    return [`${proto}://${req.headers.host}`, ...extraOrigins];
  };

  const server = createServer(handle);
  const hub = createHub({ db, M, server, origins, ice, log, ringMs, voiceGraceMs });
  // --- push notifications (server/push.js) ---
  // A new message that needs someone with no Snug open anywhere goes to their devices.
  const push = createPush({ db, M, hub, origins, log, allowLocal: pushAllowLocal });
  const pushBaseSend = hub.ops['msg.send'];
  hub.ops['msg.send'] = (c, d) => {
    const fresh = typeof d.id === 'string' && !M.msg(d.id);
    const r = pushBaseSend(c, d);
    if (fresh && r?.m?.id) push.onMessage(r.m.conv || d.conv, r.m.id).catch((e) => log('push', e));
    return r;
  };
  // Calls: someone with nothing open hears "Name is calling"; a missed call
  // record goes out like any other message that needs them.
  hub.hooks.ring = (user, ring) => push.onRing(user, ring).catch((e) => log('push', e));
  hub.hooks.ringStop = (user, ring) => push.onRingStop(user, ring).catch((e) => log('push', e));
  hub.hooks.message = (conv, id) => push.onMessage(conv, id).catch((e) => log('push', e));
  hub.hooks.note = (user, note) => push.onNote(user, note).catch((e) => log('push', e)); // event reminders (server/community.js)
  // --- end push notifications ---

  // Deleted messages can be restored for ten minutes; after that their content is gone for good.
  const sweep = setInterval(() => {
    db.run("UPDATE messages SET text = '', fold = '', files = NULL WHERE deleted IS NOT NULL AND deleted < ? AND text != ''", Date.now() - 11 * 60_000);
    db.run('DELETE FROM sessions WHERE expires < ?', Date.now());
    push.prune(); // devices whose sign-in expired stop getting notifications
  }, 60_000);

  function headers(res, extra = {}) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    // Camera and screen capture for video in voice rooms; same origin only.
    res.setHeader('Permissions-Policy', 'microphone=(self), camera=(self), display-capture=(self), fullscreen=(self), geolocation=()');
    for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  }
  function sendJson(res, status, body, extra = {}) {
    headers(res, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.writeHead(status);
    res.end(JSON.stringify(body));
  }
  const error = (res, status, message) => sendJson(res, status, { error: message });

  async function body(req, max = 16 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > max) throw Object.assign(new Error('too big'), { status: 413 });
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }
  async function jsonBody(req) {
    if (!String(req.headers['content-type']).startsWith('application/json')) throw Object.assign(new Error('json only'), { status: 415 });
    try { return JSON.parse(await body(req)); } catch (e) { if (e.status) throw e; throw Object.assign(new Error('bad json'), { status: 400 }); }
  }
  const userOf = (req) => sessionUser(db, readCookie(req.headers.cookie, COOKIE));
  // GIF routes (/api/gifs...): picker lists, the optional search provider, and copies.
  const mediaHttp = createMediaHttp({ db, M, filesDir, sendJson, error, jsonBody, headers });
  // Custom emoji: uploads at POST /api/files?emoji=<house>, and who may fetch an emoji image.
  const emojiHttp = createEmojiHttp({ db, M, filesDir, sendJson, error, body, uploadLimit });
  const emojiR = emojiReads(db, M);
  // Messaging (server/messaging.js): sticker uploads at POST /api/files?sticker=<house>, sticker images, and
  // the background work: link previews and the scheduler (scheduled messages, polls closing).
  const messagingHttp = createMessagingHttp({ db, M, filesDir, sendJson, error, body, headers, uploadLimit });
  // Soundboard (server/voiceopts.js): uploads at POST /api/files?sound=<house>, files at GET /api/sounds/<file>.
  const voiceOptsHttp = createVoiceOptsHttp({ db, M, filesDir, sendJson, error, body, headers, uploadLimit });
  hub.messaging?.configure({ filesDir, previews: linkPreviews, allowLoopback: linkAllowLocal });
  const placesHttp = createPlacesHttp({ db, M, hub, sendJson, error, jsonBody, ipOf }); // webhooks (server/places.js)
  const accountHttp = createAccountHttp({ db, M, hub, filesDir, sendJson, error, jsonBody, body, headers, ipOf, secure, authLimit, uploadLimit, log }); // server/account.js
  const appearanceHttp = createAppearanceHttp({ db, M, hub, filesDir, sendJson, error, body, headers, uploadLimit }); // server/appearance.js
  const communityHttp = createCommunityHttp({ db, M, hub, filesDir, sendJson, error, body, headers, uploadLimit, userOf: (req) => userOf(req) }); // server/community.js

  async function handle(req, res) {
    let url, path;
    try { url = new URL(req.url, 'http://x'); path = decodeURIComponent(url.pathname); } catch { return error(res, 400, 'That address isn’t valid.'); }
    try {
      if (path.startsWith('/api/')) return await api(req, res, path, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return error(res, 405, 'Method not allowed');
      return await staticFile(res, path);
    } catch (e) {
      if (e.status) return error(res, e.status, e.status === 413 ? 'That’s too large.' : 'That request isn’t valid.');
      log('error', req.method, path, e);
      return error(res, 500, 'Something went wrong on the server.');
    }
  }

  async function staticFile(res, path) {
    // /join/<code> and every other app path load the app itself.
    // Web addresses always use forward slashes, whatever this machine's file paths look like.
    // /m/<conversation>/<message> is a message link (js/app.js opens it after sign-in).
    let rel = path === '/' || path.startsWith('/join/') || path.startsWith('/m/') ? 'index.html' : posix.normalize(path.replace(/\\/g, '/')).replace(/^\/+/, '');
    if (rel.includes('..') || !PUBLIC.some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p))) {
      if (extname(rel)) return error(res, 404, 'Not found');
      rel = 'index.html';
    }
    const file = join(ROOT, rel);
    let info;
    try { info = await stat(file); } catch { return error(res, 404, 'Not found'); }
    if (!info.isFile()) return error(res, 404, 'Not found');
    headers(res, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ...(rel === 'index.html' ? { 'Content-Security-Policy': CSP, 'X-Frame-Options': 'DENY' } : {}),
      ...(rel === 'sw.js' ? { 'Service-Worker-Allowed': '/' } : {}), // push notifications
    });
    res.writeHead(200);
    createReadStream(file).pipe(res);
    return undefined;
  }

  async function api(req, res, path, url) {
    const post = req.method === 'POST';
    // Cross-site requests can carry cookies; refuse any state change that did not come from Snug itself.
    if (post && req.headers.origin && !origins(req).includes(req.headers.origin)) return error(res, 403, 'Cross-site request refused.');

    if (post && path === '/api/register') {
      if (!authLimit.take(`reg:${ipOf(req)}`)) return error(res, 429, 'Too many attempts. Wait a few minutes and try again.');
      const d = await jsonBody(req);
      const handleV = String(d.handle || '').trim().toLowerCase().replace(/^@/, '');
      const name = String(d.name || '').trim().replace(/[\u0000-\u001f\u007f]/g, '');
      const password = String(d.password || '');
      if (!HANDLE.test(handleV)) return error(res, 400, 'Usernames are 2 to 24 letters, numbers, dots, dashes or underscores, starting and ending with a letter or number.');
      if (!name || name.length > 40) return error(res, 400, 'Your name can be 1 to 40 characters.');
      if (password.length < 8 || password.length > 200) return error(res, 400, 'Passwords need at least 8 characters.');
      if (db.get('SELECT 1 FROM users WHERE handle = ?', handleV)) return error(res, 409, `@${handleV} is taken. Try another username.`);
      if (M.handleHeld?.(handleV)) return error(res, 409, `@${handleV} is taken. Try another username.`); // given up in the last 7 days (server/inbox.js)
      const id = newId('u');
      const hue = HUES[Math.floor(Math.random() * HUES.length)][0];
      db.run('INSERT INTO users (id, handle, name, pass, hue, created) VALUES (?, ?, ?, ?, ?, ?)', id, handleV, name, hashPassword(password), hue, Date.now());
      const token = createSession(db, id, accountHttp.agentOf(req));
      log('register', handleV);
      return sendJson(res, 201, { user: M.userView(M.userRow(id), 'around') }, { 'Set-Cookie': sessionCookie(token, { secure }) });
    }

    if (post && path === '/api/login') {
      const d = await jsonBody(req);
      const handleV = String(d.handle || '').trim().toLowerCase().replace(/^@/, '');
      const password = String(d.password || '');
      if (!authLimit.take(`login:${ipOf(req)}`) || !authLimit.take(`login:${handleV}`)) return error(res, 429, 'Too many attempts. Wait a few minutes and try again.');
      const row = db.get('SELECT * FROM users WHERE handle = ?', handleV);
      const ok = row ? checkPassword(password, row.pass) : burnPasswordCheck(password);
      if (!ok) return error(res, 401, 'That username and password don’t match.');
      // Two-factor sign-in asks for a code before any session exists (server/account.js).
      const gate = accountHttp.loginGate(row);
      if (gate) return sendJson(res, 200, gate);
      const token = createSession(db, row.id, accountHttp.agentOf(req));
      return sendJson(res, 200, { user: M.userView(row, row.presence, true) }, { 'Set-Cookie': sessionCookie(token, { secure }) });
    }

    if (post && path === '/api/logout') {
      endSession(db, readCookie(req.headers.cookie, COOKIE));
      push.prune();
      return sendJson(res, 200, {}, { 'Set-Cookie': sessionCookie('', { secure, clear: true }) });
    }

    // House pictures an invitation may show, and invitation previews with custom links (server/community.js).
    if (await communityHttp.open(req, res, path, url)) return undefined;
    // Invitation previews are public, so a link can show what you are joining before you sign in.
    const invite = /^\/api\/invite\/([\w-]{6,40})$/.exec(path);
    if (req.method === 'GET' && invite) {
      const inv = db.get('SELECT * FROM invites WHERE code = ?', invite[1]);
      if (!inv || inv.expires < Date.now() || inv.revoked || (inv.max_uses && inv.uses >= inv.max_uses)) return error(res, 404, 'That invitation has expired. Ask for a new link.');
      const h = db.get('SELECT name, mark, hue, about FROM houses WHERE id = ?', inv.house);
      const count = db.get('SELECT COUNT(*) n FROM members WHERE house = ?', inv.house).n;
      const by = db.get('SELECT name FROM users WHERE id = ?', inv.by)?.name;
      return sendJson(res, 200, { house: { ...h, members: count }, by });
    }

    // Webhooks carry their own secret instead of a session (server/places.js).
    if (await placesHttp(req, res, path)) return undefined;
    if (await accountHttp.open(req, res, path)) return undefined; // POST /api/login/totp

    const user = userOf(req);
    if (!user) return error(res, 401, 'Sign in first.');
    if (await accountHttp.authed(req, res, path, url, user)) return undefined; // export, deactivate, delete, banners
    if (await appearanceHttp(req, res, path, url, user)) return undefined; // profile pictures (server/appearance.js)
    if (await communityHttp.authed(req, res, path, url, user)) return undefined; // house pictures and event covers (server/community.js)

    if (req.method === 'GET' && path === '/api/me') {
      const row = M.userRow(user);
      return sendJson(res, 200, { user: M.userView(row, row.presence, true), ice: hub.iceFor(user) });
    }
    if (post && path === '/api/logout-all') {
      const token = readCookie(req.headers.cookie, COOKIE);
      endAllSessions(db, user);
      hub.endSessions(user);
      push.prune(); // a lost phone stops getting notifications too
      return sendJson(res, 200, {}, { 'Set-Cookie': sessionCookie(token, { secure, clear: true }) });
    }
    if (post && path === '/api/password') {
      if (!authLimit.take(`pw:${user}`)) return error(res, 429, 'Too many attempts. Wait a few minutes and try again.');
      const d = await jsonBody(req);
      const row = M.userRow(user);
      if (!checkPassword(String(d.current || ''), row.pass)) return error(res, 401, 'Your current password isn’t right.');
      const next = String(d.next || '');
      if (next.length < 8 || next.length > 200) return error(res, 400, 'Passwords need at least 8 characters.');
      // With two-factor sign-in on, a new password needs a code too (server/account.js).
      if (accountHttp.totpOn(user) && !accountHttp.verifySecond(user, String(d.code || ''))) return error(res, 401, 'Type a code from your authenticator app, or a backup code.');
      db.run('UPDATE users SET pass = ? WHERE id = ?', hashPassword(next), user);
      // Every other device has to sign in again with the new password.
      endAllSessions(db, user);
      hub.endSessions(user);
      push.prune(); // this device re-sends its subscription when it reconnects
      const fresh = createSession(db, user, accountHttp.agentOf(req));
      return sendJson(res, 200, {}, { 'Set-Cookie': sessionCookie(fresh, { secure }) });
    }

    if (await messagingHttp(req, res, path, url, user)) return undefined; // POST /api/files?sticker=<house>, GET /api/stickers/<file>
    if (await voiceOptsHttp(req, res, path, url, user)) return undefined; // POST /api/files?sound=<house>, GET /api/sounds/<file>
    if (await emojiHttp(req, res, path, url, user)) return undefined; // POST /api/files?emoji=<house>
    if (post && path === '/api/files') {
      if (!uploadLimit.take(user)) return error(res, 429, 'Too many uploads at once. Wait a moment.');
      const conv = url.searchParams.get('conv') || '';
      const gate = M.postGate(user, conv.startsWith('t:') && !M.thread(conv) ? (M.liveMsg(conv.slice(2))?.conv || '') : conv);
      if (!gate.ok) return error(res, 403, gate.why);
      const size = Number(req.headers['content-length']);
      if (!size || size > MAX_FILE) return error(res, 413, 'Files can be up to 10 MB.');
      const name = (safeDecode(String(req.headers['x-file-name'] || 'file')).replace(/[\u0000-\u001f\u007f/\\]/g, '').trim() || 'file').slice(0, 120);
      const data = await body(req, MAX_FILE);
      // Codec parameters are dropped; audio and video keep their type only if the bytes agree.
      const type = uploadType(req.headers['content-type'], data);
      const id = newId('f');
      await writeFile(join(filesDir, id), data, { mode: 0o600 });
      db.run('INSERT INTO files (id, owner, conv, name, type, size, created) VALUES (?, ?, ?, ?, ?, ?, ?)', id, user, conv, name, type, data.length, Date.now());
      return sendJson(res, 201, { id, name, size: data.length, kind: fileKind(type) });
    }

    const file = /^\/api\/files\/(f_[a-z0-9]{8,40})$/.exec(path);
    if (req.method === 'GET' && file) {
      const row = db.get('SELECT * FROM files WHERE id = ?', file[1]);
      // You can fetch a file only if you can read the conversation it was shared in.
      const conv = row && (row.conv.startsWith('t:') && !M.thread(row.conv) ? M.liveMsg(row.conv.slice(2))?.conv : row.conv);
      // Custom emoji images: their house, and readers of conversations they were used in (server/emoji.js).
      if (!row || (!(conv && M.canRead(user, conv)) && !emojiR.fileReadable(user, row))) return error(res, 404, 'Not found');
      const inline = INLINE.has(row.type);
      // Range requests (206), so a voice message can seek.
      const range = parseRange(req.headers.range, row.size);
      if (range === 'bad') { headers(res, { 'Content-Range': `bytes */${row.size}` }); res.writeHead(416); res.end(); return undefined; }
      headers(res, {
        'Content-Type': inline ? row.type : 'application/octet-stream',
        'Content-Length': String(range ? range.end - range.start + 1 : row.size),
        'Accept-Ranges': 'bytes',
        ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${row.size}` } : {}),
        'Cache-Control': 'private, max-age=86400',
        // Even an image opened on its own can never run script.
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.name)}`,
      });
      res.writeHead(range ? 206 : 200);
      createReadStream(join(filesDir, row.id), range || {}).pipe(res);
      return undefined;
    }

    if (await mediaHttp(req, res, path, url, user)) return undefined;
    if (await push.http(req, res, path, user, { sendJson, error, jsonBody })) return undefined; // /api/push/*

    return error(res, 404, 'Not found');
  }

  await new Promise((r) => server.listen(port, host, r));
  const address = server.address();
  log(`Snug is running at http://${address.address}:${address.port}`);
  return {
    port: address.port, db, M, hub, server,
    push, // push notifications: tests read push.stats and push.publicKey
    // For tests: forget every rate limit, the socket ones and the sign-in ones.
    resetLimits: () => { hub.resetLimits(); authLimit.reset(); uploadLimit.reset(); mediaHttp.reset(); accountHttp.reset(); },
    close: () => new Promise((r) => { clearInterval(sweep); hub.close(); server.close(() => { db.close(); r(); }); server.closeAllConnections?.(); }),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  startServer().catch((e) => { console.error(e); process.exit(1); });
}
