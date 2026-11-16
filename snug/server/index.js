// Snug's server: static files, accounts, file uploads and the real-time hub.
// Start it with `npm start`. Configuration comes from environment variables;
// see the README.
import { createServer } from 'node:http';
import { mkdir, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createExpiry } from './expiry.js'; // 0.12: disappearing messages
import { createShell } from './shell.js'; // 0.12: ETag, gzip and the offline app shell list
import { createModel, newId } from './model.js';
import { createHub, ringMsFrom, voiceGraceFrom } from './hub.js';
import { AUDIO_TYPES, VIDEO_TYPES, parseRange, createMediaHttp, createFileSweep } from './media.js'; // sec-authz: createFileSweep // voice messages, GIFs, video
import { createEmojiHttp, emojiReads } from './emoji.js'; // custom emoji per house
import { createMessagingHttp } from './messaging.js'; // sticker uploads and images; link previews and the scheduler are configured below
import { createVoiceOptsHttp, iceConfig } from './voiceopts.js'; // soundboard uploads and sound files; STUN and TURN (short-lived TURN credentials)
import { createPush } from './push.js'; // notifications when Snug is closed (Web Push)
import { createPlacesHttp } from './places.js'; // webhook deliveries: POST /api/hooks/<id>/<token>
import { createAccountHttp } from './account.js'; // two-factor sign-in, export, deactivate, delete, banners
import { createAppearanceHttp } from './appearance.js'; // profile pictures: POST /api/files?avatar, GET /api/avatars/<file>
import { createCommunityHttp } from './community.js'; // house pictures, event covers, invitation previews with custom links
import { createUploads } from './uploads.js'; // attachments: one-request and chunked uploads, limits, quotas, free disk
import { HUES } from '../js/lib/util.js';
import { createPeer } from './peer.js'; // p2p: friends, DMs, profiles and calls with people on other PCs
import { createGroups } from './peergroups.js'; // v0.10 B: groups across PCs
import { createGhAuth } from './ghauth.js'; // p2p: Sign in with GitHub and the Snug username
import { createPasskeys } from './passkeys.js'; // v0.12: passkey sign-in for password accounts
import { createRecovery } from './recovery.js'; // v0.12: "Forgot your password?" with a recovery key, no email
import { createKeyAuth } from './keyauth.js'; // v0.12: desktop accounts that need no GitHub account
import { createNotices } from './notices.js'; // v0.10 A: registry notices, bans and admin
import { createVault } from './vault.js'; // v0.10 C: the account's data file
import { restoreIfDamaged, scheduleSnapshots, KEEP as KEEP_SNAPSHOTS } from './dbbackup.js'; // sec-registry REG-L6: database snapshots
import {
  sessionUser, endAllSessions, readCookie, sessionCookie, COOKIE, limiter, safeDecode,
  clientIp, ipKey, secureCookies, // sec-auth
  loadDataKey, // sec-registry REG-L6: the snapshot key
} from './auth.js';
import { createSeclog, redactLog, redact, sendFile } from './seclog.js'; // sec-web: security events, log redaction, safe file sends
import { PROTO, MIN_CLIENT } from '../js/lib/proto.js'; // GET /api/version
import { staticRel, staticHeaders, BASE_HEADERS, PUBLIC } from './static.js'; // the app's own files and their headers, shared with the desktop app's join mode
import { createPrivacy, logDaysFrom, iceFacts } from './privacy.js'; // privacy: who sees you online, typing, friends' link previews, erasing, what is kept

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// Uploaded images shown inline. Anything else downloads.
// SVG is not among them: it can carry script and links, so it always downloads.
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
// Voice messages, sound files and videos play inline too (their type is checked
// against the bytes at upload), and so do GIFs the server fetched as video.
for (const t of [...AUDIO_TYPES, ...VIDEO_TYPES]) INLINE.add(t);
const HANDLE = /^[a-z0-9](?:[a-z0-9_.-]{0,22}[a-z0-9])?$/;

const HSTS = 'max-age=31536000; includeSubDomains';
// Snug's version: from package.json, or (in the desktop app, whose bundled copy has no version) the app's own one level up.
const VERSION = [join(ROOT, 'package.json'), join(ROOT, '..', 'package.json')]
  .map((f) => { try { return JSON.parse(readFileSync(f, 'utf8')).version; } catch { return null; } }).find(Boolean) || null;
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
  // v0.12: the passkey RP ID (server/webauthn.js passkeyPlace). Without it, the only SNUG_HOSTS name, or
  // "localhost" on a server that listens on this machine only. Changing it later breaks existing passkeys.
  rpId = process.env.SNUG_RP_ID || null,
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
  // privacy: days sign-in history and security events are kept (SNUG_LOG_DAYS, 1 to 365; 30 by default).
  logDays = logDaysFrom(process.env.SNUG_LOG_DAYS ?? 30),
  // p2p (server/peer.js): the registry, GitHub sign-in, the device key wrapper and link tuning.
  registryUrl = process.env.SNUG_REGISTRY_URL || null,
  githubClientId = process.env.SNUG_GITHUB_CLIENT_ID || null,
  githubBase = process.env.SNUG_GITHUB_URL || 'https://github.com',
  keyStore = null,
  fetch: fetchFn = globalThis.fetch,
  resumeSecret = null,
  // sec-desktop D10: the desktop app sets this: GitHub sign-in answers only its window (the resume cookie).
  ghWindowOnly = false,
  movePollMs = 3000, // v0.12: how often a new PC asks whether its pairing code was used (tests: shorter)
  peerIdleMs = 120_000, peerDialMs = 8000, peerCacheMB = 1024, peerDirect = true, peerMaxLinks,
  // End-to-end encryption for DMs and groups (server/e2ee.js). On by default since 0.12; the server's owner can
  // turn it off with SNUG_E2EE=off. Off stops offering setup; it never downgrades anything already encrypted.
  e2ee = !['0', 'off', 'false', 'no'].includes(String(process.env.SNUG_E2EE ?? 'on').trim().toLowerCase()),
  // Attachment limits in bytes (maxFile, chunk, quota, houseQuota, diskFloor) and a statfs stand-in; tests only.
  // Otherwise they come from SNUG_MAX_FILE_MB and friends (server/uploads.js).
  uploads: uploadOpts = {},
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
  const sec = createSeclog({ db, log, ipOf: (req) => clientIp(req, trustProxy), keepDays: logDays });
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
  const hub = createHub({ db, M, server, origins, ice, log, ringMs, voiceGraceMs, ipOf, e2ee }); // sec-authz: ipOf for the socket rate limit
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
  // privacy: last, so its typing rule covers friends on other PCs too (server/privacy.js).
  const privacy = createPrivacy({
    db, M, hub, ops: hub.ops, peer, filesDir, log,
    facts: { mode: peer.enabled ? 'desktop' : 'host', logDays, linkPreviews, ...iceFacts(ice), backupDays: dbKey ? KEEP_SNAPSHOTS : 0 },
  });
  M.eraseAuthored = privacy.eraseAuthored; // account deletion, when asked to erase (server/account.js)

  // Deleted messages can be restored for ten minutes; after that their content is gone for good.
  const sweepFiles = createFileSweep({ db, filesDir, log }); // sec-authz: deleted attachments and never-sent uploads (server/media.js)
  const sweep = setInterval(() => {
    try { expiry.sweep(); } catch (e) { log('error', 'expiry sweep', e); } // 0.12: disappearing messages, before their files go
    try { sweepFiles(); } catch (e) { log('error', 'file sweep', e); } // sec-authz: before the files column is cleared below
    try { uploads.sweep(); } catch (e) { log('error', 'upload sweep', e); } // uploads nobody finished within a day
    sec.prune(); // sec-web W4: security events past 90 days, and past 500 per account
    db.run("UPDATE messages SET text = '', fold = '', files = NULL WHERE deleted IS NOT NULL AND deleted < ? AND text != ''", Date.now() - 11 * 60_000);
    db.run('DELETE FROM sessions WHERE expires < ?', Date.now());
    push.prune(); // devices whose sign-in expired stop getting notifications
    peer.housekeep(); // p2p: outbox rows past 30 days, old knock ids
    hub.e2ee?.sweep(); // end-to-end encryption: expired device requests (server/e2ee.js)
  }, 60_000);

  function headers(res, extra = {}) {
    // The usual security headers (server/static.js BASE_HEADERS, shared with the desktop app's join mode).
    for (const [k, v] of Object.entries(BASE_HEADERS)) res.setHeader(k, v);
    if (secure) res.setHeader('Strict-Transport-Security', HSTS); // sec-auth AUTH-11
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
  // On a PC linked to a registry, GIF search goes through the registry, so a provider never sees this PC's address.
  const gifReg = peer.enabled ? { base: String(registryUrl).replace(/\/+$/, ''), token: () => peer.reg.gifToken() } : null;
  const mediaHttp = createMediaHttp({ db, M, filesDir, sendJson, error, jsonBody, headers, fetch: fetchFn, gifReg, room: (...a) => uploads.room(...a) }); // review-media 1: copies count against the quotas
  // Custom emoji: uploads at POST /api/files?emoji=<house>, and who may fetch an emoji image.
  const emojiHttp = createEmojiHttp({ db, M, filesDir, sendJson, error, body, uploadLimit });
  const emojiR = emojiReads(db, M);
  // Messaging (server/messaging.js): sticker uploads at POST /api/files?sticker=<house>, sticker images, and
  // the background work: link previews and the scheduler (scheduled messages, polls closing).
  const messagingHttp = createMessagingHttp({ db, M, filesDir, sendJson, error, body, headers, uploadLimit });
  // Soundboard (server/voiceopts.js): uploads at POST /api/files?sound=<house>, files at GET /api/sounds/<file>.
  const voiceOptsHttp = createVoiceOptsHttp({ db, M, filesDir, sendJson, error, body, headers, uploadLimit });
  hub.messaging?.configure({ filesDir, previews: linkPreviews, allowLoopback: linkAllowLocal, room: (...a) => uploads.room(...a) });
  hub.e2ee?.conv?.configure({ filesDir, room: (...a) => uploads.room(...a) }); // e2ee.file.copy (server/e2ee-conv.js), held to the quotas
  const placesHttp = createPlacesHttp({ db, M, hub, sendJson, error, jsonBody, ipOf }); // webhooks (server/places.js)
  const accountHttp = createAccountHttp({ db, M, hub, filesDir, sendJson, error, jsonBody, body, headers, ipOf, secure, authLimit, uploadLimit, log, dataDir, keyStore, dataKey, desktop: !!resumeSecret, logDays }); // server/account.js; sec-auth: the data key, sign-up, sign-in, sign-out, new password
  const passkeys = createPasskeys({ db, M, hub, account: accountHttp, sendJson, error, jsonBody, ipOf, authLimit, httpsReq, rpId, hosts, loopback: isLoopbackBind(host), desktop: !!resumeSecret, extraOrigins });
  const recovery = createRecovery({ db, M, hub, account: accountHttp, sendJson, error, jsonBody, ipOf, authLimit, log });
  const appearanceHttp = createAppearanceHttp({ db, M, hub, filesDir, sendJson, error, body, headers, uploadLimit }); // server/appearance.js
  const communityHttp = createCommunityHttp({ db, M, hub, filesDir, sendJson, error, body, headers, uploadLimit, userOf: (req) => userOf(req) }); // server/community.js
  // Attachments (server/uploads.js): SNUG_MAX_FILE_MB, SNUG_QUOTA_MB, SNUG_HOUSE_QUOTA_MB, SNUG_DISK_FLOOR_MB.
  const uploads = createUploads({ db, M, filesDir, sendJson, error, jsonBody, uploadLimit, encrypted: (conv) => !!hub.e2ee?.conv?.encrypted(conv), opts: uploadOpts, log });
  // p2p: GitHub sign-in, the username picker and the owner's account rules (server/ghauth.js).
  const gh = createGhAuth({ db, M, hub, peer, opts: { registryUrl, githubClientId, githubBase, fetch: fetchFn, resumeSecret, trustProxy, ghWindowOnly /* sec-desktop */ }, secure, log, agentOf: accountHttp.agentOf, userOf });
  // v0.12: keypair accounts, the recovery key and moving with a pairing code (server/keyauth.js).
  const keyAuth = createKeyAuth({ db, M, hub, peer, gh, opts: { registryUrl, ghWindowOnly, movePollMs }, secure, log, agentOf: accountHttp.agentOf });
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
    // Which file an address loads, and its headers: server/static.js (the desktop app's pinned join mode uses the same rules).
    const rel = staticRel(path);
    if (!rel) return error(res, 404, 'Not found');
    const file = join(ROOT, rel);
    let info;
    try { info = await stat(file); } catch { return error(res, 404, 'Not found'); }
    if (!info.isFile()) return error(res, 404, 'Not found');
    const extra = staticHeaders(rel, https);
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
    // Which Snug this is, for the desktop app's join mode (it runs its own bundled client and checks they fit). Public.
    if (req.method === 'GET' && path === '/api/version') return sendJson(res, 200, { version: VERSION, proto: PROTO, minClient: MIN_CLIENT, e2ee: e2ee ? 1 : 0 });
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

    // privacy: what this Snug keeps and for how long, for the privacy page (no sign-in needed).
    if (req.method === 'GET' && path === '/api/privacy') return sendJson(res, 200, privacy.about());
    if (await gh.open(req, res, path, url)) return undefined; // p2p: /api/gh/* (server/ghauth.js)
    if (await keyAuth.open(req, res, path, url)) return undefined; // v0.12: /api/id/* (server/keyauth.js)
    // Webhooks carry their own secret instead of a session (server/places.js).
    if (await placesHttp(req, res, path)) return undefined;
    if (await accountHttp.open(req, res, path)) return undefined; // POST /api/login/totp
    if (await passkeys.open(req, res, path)) return undefined; // v0.12: /api/passkey/{config,options,login}
    if (await recovery.open(req, res, path)) return undefined; // v0.12: /api/recover, /api/recover/finish

    const user = userOf(req);
    if (!user) return error(res, 401, 'Sign in first.');
    if (await gh.authed(req, res, path, user)) return undefined; // p2p: no password for GitHub accounts; sliding sign-in on /api/me
    if (await keyAuth.authed(req, res, path, user)) return undefined; // v0.12: the recovery key until it is saved
    if (await accountHttp.authed(req, res, path, url, user)) return undefined; // export, deactivate, delete, banners
    if (await passkeys.authed(req, res, path, user)) return undefined; // v0.12: Settings > Passkeys
    if (await recovery.authed(req, res, path, user)) return undefined; // v0.12: Settings > Recovery key
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
    // Attachments: one request streamed to disk, or chunked and resumable for big files (server/uploads.js).
    // Codec parameters are dropped; audio and video keep their type only if the bytes agree.
    if (post && path === '/api/files') return await uploads.single(req, res, url, user);
    if (await uploads.http(req, res, path, url, user)) return undefined;

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
    sweepUploads: (now) => uploads.sweep(now), // tests: abandoned chunked uploads
    expiry, // 0.12: tests run the disappearing-messages sweep with their own clock
    accountPrune: () => accountHttp.prune(), // privacy: tests run the sign-in history sweep now
    peer, // p2p: srv.peer.stats() for tests, srv.peer.wake() for desktop main
    vaultBusy: () => vault.busy?.() === true, // desktop main: no update restart during a data-file transfer
    voiceBusy: () => hub.voiceBusy(), // ... or while anyone is in a voice room or a call on this server
    push, // push notifications: tests read push.stats and push.publicKey
    // v0.10 A/C: srv.notices, srv.vault
    notices, // v0.10 A: announcements, bans, admin rights (server/notices.js)
    vault, // v0.10 C: the data file (server/vault.js)
    dbSnapshots, // sec-registry REG-L6: dbSnapshots?.now() writes a snapshot (tests)
    // For tests: forget every rate limit, the socket ones and the sign-in ones.
    resetLimits: () => { hub.resetLimits(); authLimit.reset(); uploadLimit.reset(); mediaHttp.reset(); accountHttp.reset(); passkeys.reset(); recovery.reset(); openLimit.reset(); inviteLimit.reset(); cspLimit.reset(); sec.reset(); }, // sec-web: openLimit, inviteLimit, cspLimit, sec
    close: () => new Promise((r) => { vault.flush(); vault.close(); dbSnapshots?.stop(); clearInterval(sweep); gh.close(); keyAuth.close(); notices.close(); peer.close(); hub.close(); server.close(() => { db.close(); r(); }); server.closeAllConnections?.(); }),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  startServer().catch((e) => { console.error(e); process.exit(1); });
}
