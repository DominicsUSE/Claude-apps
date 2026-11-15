// Snug's server: static files, accounts, file uploads and the real-time hub.
// Start it with `npm start`. Configuration comes from environment variables;
// see the README.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { writeFile, mkdir, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join, normalize, extname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createExpiry } from './expiry.js'; // 0.12: disappearing messages
import { createShell } from './shell.js'; // 0.12: ETag, gzip and the offline app shell list
import { createModel, newId } from './model.js';
import { createHub, ringMsFrom, voiceGraceFrom } from './hub.js';
import { AUDIO_TYPES, VIDEO_TYPES, uploadType, fileKind, parseRange, createMediaHttp, createFileSweep } from './media.js'; // sec-authz: createFileSweep // voice messages, GIFs, video
import { createEmojiHttp, emojiReads } from './emoji.js'; // custom emoji per house
import { createMessagingHttp } from './messaging.js'; // sticker uploads and images; link previews and the scheduler are configured below
import { createVoiceOptsHttp, iceConfig } from './voiceopts.js'; // soundboard uploads and sound files; STUN and TURN (short-lived TURN credentials)
import { createPush } from './push.js'; // notifications when Snug is closed (Web Push)
import { createPlacesHttp } from './places.js'; // webhook deliveries: POST /api/hooks/<id>/<token>
import { createAccountHttp } from './account.js'; // two-factor sign-in, export, deactivate, delete, banners
import { createAppearanceHttp } from './appearance.js'; // profile pictures: POST /api/files?avatar, GET /api/avatars/<file>
import { createCommunityHttp } from './community.js'; // house pictures, event covers, invitation previews with custom links
import { HUES, cleanFileName } from '../js/lib/util.js'; // sec-authz: cleanFileName
import { createPeer } from './peer.js'; // p2p: friends, DMs, profiles and calls with people on other PCs
import { createGroups } from './peergroups.js'; // v0.10 B: groups across PCs
import { createGhAuth } from './ghauth.js'; // p2p: Sign in with GitHub and the Snug username
import { createNotices } from './notices.js'; // v0.10 A: registry notices, bans and admin
import { createVault } from './vault.js'; // v0.10 C: the account's data file
import { restoreIfDamaged, scheduleSnapshots } from './dbbackup.js'; // sec-registry REG-L6: database snapshots
import {
  sessionUser, endAllSessions, readCookie, sessionCookie, COOKIE, limiter, safeDecode,
  clientIp, ipKey, secureCookies, // sec-auth
  loadDataKey, // sec-registry REG-L6: the snapshot key
} from './auth.js';
import { createSeclog, redactLog, redact, sendFile } from './seclog.js'; // sec-web: security events, log redaction, safe file sends

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// The version this server runs (package.json), for the page's Settings > Connection and /api/me.
const VERSION = (() => { try { return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version; } catch { return 'unknown'; } })();
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
  "worker-src 'self'", "manifest-src 'self'", "frame-src 'none'", // sec-web: no workers, manifests or frames from anywhere else
].join('; ');
// sec-web W6: every other response (API JSON, errors, scripts, styles) gets a
// policy that allows nothing, so nothing served here can be framed or run as a
// page; brand SVGs may style themselves but never run script; the service
// worker may fetch from this origin only.
const BASE_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'";
const WORKER_CSP = "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const HSTS = 'max-age=31536000; includeSubDomains';
// sec-web: a stricter page policy in report-only mode (no inline styles, Trusted
// Types for script sinks). Nothing is blocked by it; what it would block is
// reported to /api/csp-report and kept as a security event, so an injection
// attempt (or a page change that would break under it) shows up.
const CSP_STRICT = `${CSP.replace("style-src 'self' 'unsafe-inline'", "style-src 'self'")}; require-trusted-types-for 'script'; report-uri /api/csp-report`; // report-uri: sent at once by every browser (report-to batches for up to a minute)
// sec-web W2: names a loopback server always answers to. An address typed as an
// IP is always fine too: a DNS rebinding attack needs a name it controls.
const LOCAL_NAMES = ['localhost'];
const isLoopbackBind = (h) => h === 'localhost' || h === '::1' || /^127\./.test(h);

export async function startServer({
  port = Number(process.env.PORT) || 8787,
  host = process.env.HOST || '127.0.0.1',
  dataDir = process.env.SNUG_DATA || join(ROOT, 'data'),
  secure = process.env.SNUG_SECURE === '1',
  // sec-auth: the number of proxies in front (1 = one); X-Forwarded-For is read from the right, and only from a private peer.
  trustProxy = /^[1-9]$/.test(process.env.SNUG_TRUST_PROXY || '') ? Number(process.env.SNUG_TRUST_PROXY) : false,
  extraOrigins = (process.env.SNUG_ORIGINS || '').split(',').filter(Boolean),
  // sec-web W2: the host names this server answers to (SNUG_HOSTS=snug.example.org,chat.example.org).
  // A server bound to loopback always checks the Host header (localhost, IPs, SNUG_ORIGINS
  // hosts, these); one bound to a public or wildcard address checks it once this is set.
  hosts = process.env.SNUG_HOSTS ? process.env.SNUG_HOSTS.split(',').map((x) => x.trim()).filter(Boolean) : null,
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
  // p2p (server/peer.js): the registry, GitHub sign-in, the device key wrapper and link tuning.
  registryUrl = process.env.SNUG_REGISTRY_URL || null,
  githubClientId = process.env.SNUG_GITHUB_CLIENT_ID || null,
  githubBase = process.env.SNUG_GITHUB_URL || 'https://github.com',
  keyStore = null,
  fetch: fetchFn = globalThis.fetch,
  resumeSecret = null,
  // sec-desktop D10: the desktop app sets this: GitHub sign-in answers only its window (the resume cookie).
  ghWindowOnly = false,
  peerIdleMs = 120_000, peerDialMs = 8000, peerCacheMB = 1024, peerDirect = true, peerMaxLinks,
} = {}) {
  // sec-registry REG-L6: a damaged snug.db is replaced by the newest good encrypted snapshot before opening.
  // sec-integrate: the data key is loaded once (two-factor secrets, backup codes, snapshots). One that couldn't
  // be read is a throwaway: no snapshot is written or restored with it.
  const bootLog = quiet ? () => {} : redactLog((...a) => console.log(new Date().toISOString(), ...a));
  const dataKey = dataDir === ':memory:' ? null : loadDataKey({ dataDir, keyStore, log: bootLog });
  const dbKey = dataKey && !dataKey.unusable ? dataKey : null;
  if (dbKey) restoreIfDamaged({ dataDir, dataKey: dbKey, log: bootLog });
  const db = openDb(dataDir === ':memory:' ? ':memory:' : join(dataDir, 'snug.db'));
  const filesDir = join(dataDir === ':memory:' ? join(ROOT, 'data', 'test-files') : dataDir, 'files');
  await mkdir(filesDir, { recursive: true, mode: 0o700 });
  const M = createModel(db);
  // sec-web W5: every log line is redacted (webhook tokens, cookies, keys) and kept on one line.
  const log = bootLog;

  // STUN, and TURN with a static login or (SNUG_TURN_SECRET) short-lived credentials per person (server/voiceopts.js).
  const ice = iceConfig(iceEnv);

  const authLimit = limiter({ capacity: 10, perSecond: 10 / 900 });   // 10 tries per 15 minutes
  const uploadLimit = limiter({ capacity: 20, perSecond: 0.2 });
  // sec-web: reads anyone can make without signing in (invitation previews), per address.
  const openLimit = limiter({ capacity: 300, perSecond: 5 });
  const inviteLimit = limiter({ capacity: 60, perSecond: 1 });
  const cspLimit = limiter({ capacity: 30, perSecond: 0.5 });
  const ipOf = (req) => ipKey(clientIp(req, trustProxy)); // sec-auth: the proxy's own entry, IPv4-mapped as IPv4, IPv6 per /64
  // sec-web W4: security events and the suspicious-activity detectors (server/seclog.js).
  const sec = createSeclog({ db, log, ipOf: (req) => clientIp(req, trustProxy) });
  // sec-web W2: the Host header must name this server, or a page on a name the
  // attacker controls (re-pointed at 127.0.0.1) would pass every Origin check.
  const hostNames = new Set([...LOCAL_NAMES, ...(hosts || []).map((h) => h.toLowerCase().replace(/:\d+$/, '')),
    ...extraOrigins.map((o) => { try { return new URL(o).hostname.toLowerCase(); } catch { return null; } }).filter(Boolean)]);
  const strictHosts = isLoopbackBind(host) || hosts !== null;
  function hostOk(req) {
    if (!strictHosts) return true;
    const h = String(req.headers.host || '');
    if (!h) return false;
    let name;
    try { name = new URL(`http://${h}`).hostname.toLowerCase(); } catch { return false; }
    return isIP(name.replace(/^\[|\]$/g, '')) !== 0 || hostNames.has(name);
  }
  const httpsReq = (req) => secure || (trustProxy && req.headers['x-forwarded-proto'] === 'https');
  // The page's own origin, plus any configured ones. Used for sockets and state-changing requests.
  // sec-web W2: under a Host this server doesn't answer to, only the configured ones.
  const origins = (req) => {
    if (!hostOk(req)) return [...extraOrigins];
    return [`${httpsReq(req) ? 'https' : 'http'}://${req.headers.host}`, ...extraOrigins];
  };

  // keepAliveTimeout: well past any client's idle reuse, so a reused socket is never closed under a request.
  // sec-web: slow-header and slow-body clients are cut off sooner (Node's defaults are 60 s and 300 s);
  // an idle keep-alive socket is not affected by headersTimeout.
  const server = createServer({ keepAliveTimeout: 65_000, headersTimeout: 20_000, requestTimeout: 120_000, maxHeaderSize: 16 * 1024 }, handle);
  const hub = createHub({ db, M, server, origins, ice, log, ringMs, voiceGraceMs, ipOf }); // sec-authz: ipOf for the socket rate limit
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

  // 0.12: the page's heartbeat. It asks every few seconds; a connection that
  // stops answering is dropped and opened again (js/server.js), and the round
  // trip and the server's version show on Settings > Connection.
  hub.addLimits({ ping: limiter({ capacity: 20, perSecond: 1 }) });
  hub.ops.ping = () => ({ now: Date.now(), version: VERSION });

  // 0.12: disappearing messages, before the peer module wraps the ops (server/expiry.js).
  const expiry = createExpiry({ db, M, hub, ops: hub.ops });

  // p2p: the peer module wraps the ops last, after push (server/peer.js).
  const peer = createPeer({
    db, M, hub, ops: hub.ops, filesDir, log,
    opts: { dataDir, registryUrl, githubClientId, githubBase, keyStore, fetch: fetchFn, resumeSecret, peerIdleMs, peerDialMs, peerCacheMB, peerDirect, peerMaxLinks },
  });
  // v0.10 B: groups across PCs (server/peergroups.js)
  createGroups({ db, M, hub, ops: hub.ops, peer, log });

  // Deleted messages can be restored for ten minutes; after that their content is gone for good.
  const sweepFiles = createFileSweep({ db, filesDir, log }); // sec-authz: deleted attachments and never-sent uploads (server/media.js)
  const sweep = setInterval(() => {
    try { expiry.sweep(); } catch (e) { log('error', 'expiry sweep', e); } // 0.12: disappearing messages, before their files go
    try { sweepFiles(); } catch (e) { log('error', 'file sweep', e); } // sec-authz: before the files column is cleared below
    sec.prune(); // sec-web W4: security events past 90 days, and past 500 per account
    db.run("UPDATE messages SET text = '', fold = '', files = NULL WHERE deleted IS NOT NULL AND deleted < ? AND text != ''", Date.now() - 11 * 60_000);
    db.run('DELETE FROM sessions WHERE expires < ?', Date.now());
    push.prune(); // devices whose sign-in expired stop getting notifications
    peer.housekeep(); // p2p: outbox rows past 30 days, old knock ids
  }, 60_000);

  function headers(res, extra = {}) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    // Camera and screen capture for video in voice rooms; same origin only.
    res.setHeader('Permissions-Policy', 'microphone=(self), camera=(self), display-capture=(self), fullscreen=(self), geolocation=()');
    if (secure) res.setHeader('Strict-Transport-Security', HSTS); // sec-auth AUTH-11
    // sec-web W6: no other origin may embed or frame anything served here, and
    // nothing is a page unless it says so (callers pass their own policy).
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', BASE_CSP);
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
  const accountHttp = createAccountHttp({ db, M, hub, filesDir, sendJson, error, jsonBody, body, headers, ipOf, secure, authLimit, uploadLimit, log, dataDir, keyStore, dataKey, desktop: !!resumeSecret }); // server/account.js; sec-auth: the data key, sign-up, sign-in, sign-out, new password
  const appearanceHttp = createAppearanceHttp({ db, M, hub, filesDir, sendJson, error, body, headers, uploadLimit }); // server/appearance.js
  const communityHttp = createCommunityHttp({ db, M, hub, filesDir, sendJson, error, body, headers, uploadLimit, userOf: (req) => userOf(req) }); // server/community.js
  // p2p: GitHub sign-in, the username picker and the owner's account rules (server/ghauth.js).
  const gh = createGhAuth({ db, M, hub, peer, opts: { registryUrl, githubClientId, githubBase, fetch: fetchFn, resumeSecret, trustProxy, ghWindowOnly /* sec-desktop */ }, secure, log, agentOf: accountHttp.agentOf, userOf });
  // v0.10 A: registry notices, bans and admin (server/notices.js)
  const notices = createNotices({ db, M, hub, peer, log });

  // v0.10 C: the data file (server/vault.js). Last, so its op wrapper sees every other op.
  // sec-registry REG-L6: an encrypted, checked snapshot of snug.db a day (7 kept, in <data>/backups).
  const dbSnapshots = dbKey ? scheduleSnapshots({ raw: db.raw, dataDir, dataKey: dbKey, log }) : null;
  const vault = createVault({ db, M, hub, peer, dataDir, filesDir, keyStore, log, http: { sendJson, error, body, headers } });

  async function handle(req, res) {
    if (!secure && trustProxy && req.headers['x-forwarded-proto'] === 'https') {
      secureCookies(res); // sec-auth AUTH-11: Secure __Host- session cookie behind an HTTPS proxy
      res.setHeader('Strict-Transport-Security', HSTS); // sec-web W6
    }
    // sec-web W2: a Host this server doesn't answer to (DNS rebinding) is refused outright.
    if (!hostOk(req)) {
      sec.record('host.refused', { req, detail: { host: String(req.headers.host || '').slice(0, 100) } });
      return error(res, 421, 'This server doesn’t answer to that name.');
    }
    // sec-web W4: every rate-limited request, from any module, is a security event.
    res.once('finish', () => { if (res.statusCode === 429) sec.record('ratelimit.hit', { req, detail: { path: redact(String(req.url).split('?')[0], 100) } }); });
    let url, path;
    try { url = new URL(req.url, 'http://x'); path = decodeURIComponent(url.pathname); } catch { return error(res, 400, 'That address isn’t valid.'); }
    try {
      if (path.startsWith('/api/')) return await api(req, res, path, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return error(res, 405, 'Method not allowed');
      return await staticFile(res, path, httpsReq(req), req);
    } catch (e) {
      if (e.status) return error(res, e.status, e.status === 413 ? 'That’s too large.' : 'That request isn’t valid.');
      log('error', req.method, path, e); // sec-web W5: redacted by log() (webhook tokens, control characters)
      if (res.headersSent) { res.destroy(); return undefined; }
      return error(res, 500, 'Something went wrong on the server.');
    }
  }

  // 0.12: ETags, gzip, and the list of the app's files for sw.js (server/shell.js).
  const shell = createShell({ root: ROOT, dirs: PUBLIC.filter((p) => p.endsWith('/') && p !== 'docs/') });
  async function staticFile(res, path, https = false, req = null) {
    if (path === '/shell.json') {
      headers(res, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.writeHead(200);
      res.end(JSON.stringify(shell.shellList()));
      return undefined;
    }
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
    const extra = {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ...(rel === 'index.html' ? {
        'Content-Security-Policy': https ? `${CSP}; upgrade-insecure-requests` : CSP,
        'Content-Security-Policy-Report-Only': CSP_STRICT, // sec-web
      } : {}),
      ...(extname(file) === '.svg' ? { 'Content-Security-Policy': SVG_CSP } : {}), // sec-web W6
      ...(rel === 'sw.js' ? { 'Service-Worker-Allowed': '/', 'Content-Security-Policy': WORKER_CSP } : {}), // push notifications
    };
    if (req && await shell.send(req, res, file, info, headers, extra)) return undefined; // 304, or gzipped
    if (!req) headers(res, extra);
    await sendFile(res, file); // sec-web W1: a file gone since the stat is a 404, not a crash
    return undefined;
  }

  async function api(req, res, path, url) {
    const post = req.method === 'POST';
    // Cross-site requests can carry cookies; refuse any state change that did not come from Snug itself.
    // sec-web: with no Origin, a browser's Sec-Fetch-Site saying another site is refused too.
    if (post && (req.headers.origin ? !origins(req).includes(req.headers.origin) : ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site']))) {
      sec.record('origin.refused', { req, detail: { origin: String(req.headers.origin || req.headers['sec-fetch-site']).slice(0, 100), path: redact(path, 100) } });
      return error(res, 403, 'Cross-site request refused.');
    }
    // sec-web: reads that need no sign-in, per address (a session cookie skips the general one).
    // sec-integrate: a live session skips it, not just any cookie by that name (a made-up one used to).
    if (!post && !userOf(req) && !openLimit.take(ipOf(req))) return error(res, 429, 'Too many requests. Wait a moment.');
    // sec-web: signing out drops the browser's cached copies of private files.
    if (post && path === '/api/logout') res.setHeader('Clear-Site-Data', '"cache"');

    // sec-auth: sign-up, sign-in and sign-out moved to server/account.js (accountHttp.open below), with the
    // per-account lockouts, password rules, audit trail and async password hashing.
    if (post && (path === '/api/register' || path === '/api/login' || path === '/api/logout')) { await accountHttp.open(req, res, path); return undefined; }

    // sec-web: content-policy violation reports from the page (report-uri and the Reporting API).
    if (post && path === '/api/csp-report') {
      if (!cspLimit.take(ipOf(req))) return error(res, 429, 'Too many reports.');
      let list = [];
      try { const d = JSON.parse(await body(req, 8 * 1024)); list = Array.isArray(d) ? d.map((r) => r?.body).filter(Boolean) : [d?.['csp-report']].filter(Boolean); } catch { /* ignored */ }
      for (const r of list.slice(0, 5)) {
        const blocked = String(r['blocked-uri'] ?? r.blockedURL ?? '');
        sec.record('csp.violation', { req, detail: {
          directive: String(r['effective-directive'] ?? r.effectiveDirective ?? r['violated-directive'] ?? '').slice(0, 40),
          blocked: /^[a-z-]+$/.test(blocked) ? blocked : (() => { try { return new URL(blocked).origin; } catch { return blocked.slice(0, 20); } })(),
          page: (() => { try { return new URL(String(r['document-uri'] ?? r.documentURL ?? '')).pathname.slice(0, 60); } catch { return ''; } })(),
          mode: String(r.disposition || 'enforce').slice(0, 10),
        } });
      }
      headers(res, { 'Cache-Control': 'no-store' }); res.writeHead(204); res.end(); return undefined;
    }
    // House pictures an invitation may show, and invitation previews with custom links (server/community.js).
    if (await communityHttp.open(req, res, path, url)) return undefined;
    // Invitation previews are public, so a link can show what you are joining before you sign in.
    const invite = /^\/api\/invite\/([\w-]{6,40})$/.exec(path);
    if (req.method === 'GET' && invite) {
      if (!inviteLimit.take(ipOf(req))) return error(res, 429, 'Too many requests. Wait a moment.'); // sec-web: no guessing invitation codes
      const inv = db.get('SELECT * FROM invites WHERE code = ?', invite[1]);
      if (!inv || inv.expires < Date.now() || inv.revoked || (inv.max_uses && inv.uses >= inv.max_uses)) return error(res, 404, 'That invitation has expired. Ask for a new link.');
      const h = db.get('SELECT name, mark, hue, about FROM houses WHERE id = ?', inv.house);
      const count = db.get('SELECT COUNT(*) n FROM members WHERE house = ?', inv.house).n;
      const by = db.get('SELECT name FROM users WHERE id = ?', inv.by)?.name;
      return sendJson(res, 200, { house: { ...h, members: count }, by });
    }

    if (await gh.open(req, res, path, url)) return undefined; // p2p: /api/gh/* (server/ghauth.js)
    // Webhooks carry their own secret instead of a session (server/places.js).
    if (await placesHttp(req, res, path)) return undefined;
    if (await accountHttp.open(req, res, path)) return undefined; // POST /api/login/totp

    const user = userOf(req);
    if (!user) return error(res, 401, 'Sign in first.');
    if (await gh.authed(req, res, path, user)) return undefined; // p2p: no password for GitHub accounts; sliding sign-in on /api/me
    if (await accountHttp.authed(req, res, path, url, user)) return undefined; // export, deactivate, delete, banners
    if (await appearanceHttp(req, res, path, url, user)) return undefined; // profile pictures (server/appearance.js)
    if (await communityHttp.authed(req, res, path, url, user)) return undefined; // house pictures and event covers (server/community.js)
    // v0.10 C: /api/vault/*
    if (await vault.http(req, res, path, url, user)) return undefined; // the data file: download and import (server/vault.js)

    // sec-web W4: the account's recent security activity (sign-ins, account changes, alerts), owner only.
    if (req.method === 'GET' && path === '/api/account/security-events') return sendJson(res, 200, { events: sec.list(user, url.searchParams.get('limit')) });
    if (req.method === 'GET' && path === '/api/me') {
      const row = M.userRow(user);
      return sendJson(res, 200, { user: M.userView(row, row.presence, true), ice: hub.iceFor(user), p2p: peer.statusFor(user), version: VERSION }); // p2p; version: 0.12
    }
    if (post && path === '/api/logout-all') {
      const token = readCookie(req.headers.cookie, COOKIE);
      endAllSessions(db, user);
      hub.endSessions(user);
      accountHttp.audit?.('logout-all', req, user); // sec-auth
      push.prune(); // a lost phone stops getting notifications too
      return sendJson(res, 200, {}, { 'Set-Cookie': sessionCookie(token, { secure, clear: true }), 'Clear-Site-Data': '"cache"' }); // sec-web: Clear-Site-Data
    }
    // sec-auth: POST /api/password is handled in server/account.js (accountHttp.authed above).

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
      const name = cleanFileName(safeDecode(String(req.headers['x-file-name'] || 'file'))); // sec-authz: no bidi or zero-width characters (js/lib/util.js)
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
      let row = db.get('SELECT * FROM files WHERE id = ?', file[1]);
      // You can fetch a file only if you can read the conversation it was shared in.
      const conv = row && (row.conv.startsWith('t:') && !M.thread(row.conv) ? M.liveMsg(row.conv.slice(2))?.conv : row.conv);
      // Custom emoji images: their house, and readers of conversations they were used in (server/emoji.js).
      if (!row || (!(conv && M.canRead(user, conv)) && !emojiR.fileReadable(user, row))) return error(res, 404, 'Not found');
      // p2p: a friend's attachment not fetched yet comes from their PC first (or 404 {offline} while they're away).
      if (peer.missing(row)) { if (await peer.serveMissing(req, res, row, user)) return undefined; row = db.get('SELECT * FROM files WHERE id = ?', row.id); }
      // Uploaded SVG always downloads (it can carry script); the sample house's own pictures, written by
      // server/seed.js and marked meta.seed, show inline, still under the sandbox policy below.
      const inline = INLINE.has(row.type) || (row.type === 'image/svg+xml' && (() => { try { return JSON.parse(row.meta || '{}')?.seed === 1; } catch { return false; } })());
      // Range requests (206), so a voice message can seek.
      const range = parseRange(req.headers.range, row.size);
      if (range === 'bad') { headers(res, { 'Content-Range': `bytes */${row.size}` }); res.writeHead(416); res.end(); return undefined; }
      headers(res, {
        'Content-Type': inline ? row.type : 'application/octet-stream',
        'Content-Length': String(range ? range.end - range.start + 1 : row.size),
        'Accept-Ranges': 'bytes',
        ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${row.size}` } : {}),
        // sec-web: never kept in the browser's cache, so a shared computer keeps no copy after sign-out.
        'Cache-Control': 'private, no-store',
        // Even an image opened on its own can never run script.
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; sandbox",
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.name)}`,
      });
      // sec-web W1: opened before the status goes out; bytes gone (deleted mid-download, a restore
      // without the files folder) give 404 instead of an unhandled stream error that ends the process.
      await sendFile(res, join(filesDir, row.id), { status: range ? 206 : 200, range, onMissing: () => sec.record('file.missing', { req, detail: { file: row.id } }) });
      return undefined;
    }

    if (await mediaHttp(req, res, path, url, user)) return undefined;
    if (await push.http(req, res, path, user, { sendJson, error, jsonBody })) return undefined; // /api/push/*

    return error(res, 404, 'Not found');
  }

  await new Promise((r) => server.listen(port, host, r));
  const address = server.address();
  log(`Snug is running at http://${address.address}:${address.port}`);
  if (!strictHosts) log('warning: listening beyond this machine with no SNUG_HOSTS set, so any Host header is accepted. Set SNUG_HOSTS to the names this server answers to (protects against DNS rebinding).'); // sec-web W2
  return {
    port: address.port, db, M, hub, server,
    seclog: sec, // sec-web W4: tests run the security-event sweep and read events
    sweepFiles, // sec-authz: tests run the attachment sweep with their own clock
    expiry, // 0.12: tests run the disappearing-messages sweep with their own clock
    peer, // p2p: srv.peer.stats() for tests, srv.peer.wake() for desktop main
    vaultBusy: () => vault.busy?.() === true, // desktop main: no update restart during a data-file transfer
    voiceBusy: () => hub.voiceBusy(), // ... or while anyone is in a voice room or a call on this server
    push, // push notifications: tests read push.stats and push.publicKey
    // v0.10 A/C: srv.notices, srv.vault
    notices, // v0.10 A: announcements, bans, admin rights (server/notices.js)
    vault, // v0.10 C: the data file (server/vault.js)
    dbSnapshots, // sec-registry REG-L6: dbSnapshots?.now() writes a snapshot (tests)
    // For tests: forget every rate limit, the socket ones and the sign-in ones.
    resetLimits: () => { hub.resetLimits(); authLimit.reset(); uploadLimit.reset(); mediaHttp.reset(); accountHttp.reset(); openLimit.reset(); inviteLimit.reset(); cspLimit.reset(); sec.reset(); }, // sec-web: openLimit, inviteLimit, cspLimit, sec
    close: () => new Promise((r) => { vault.flush(); vault.close(); dbSnapshots?.stop(); clearInterval(sweep); gh.close(); notices.close(); peer.close(); hub.close(); server.close(() => { db.close(); r(); }); server.closeAllConnections?.(); }),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  startServer().catch((e) => { console.error(e); process.exit(1); });
}
