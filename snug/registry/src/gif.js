// GIF search for desktop PCs (0.12), so a person's address never reaches a GIF site.
//
//   POST /v1/gif/token   signed by the account key (Hub, below): a token good for an hour.
//   GET  /v1/gif/search  ?q=  Authorization: Bearer <token>   (Worker, stateless)
//   GET  /v1/gif/file    ?u=&s=  the same token; `s` is our signature over `u`, so only addresses a
//                        search of ours returned are ever fetched                   (Worker, stateless)
//
// Search and file traffic stays in the Worker and never queues behind the Hub. Tokens are HMACs the
// Worker checks without state; the Hub caps how many each account and everyone together get a day.
// Requests per token are also counted in the Worker's memory, which is per instance and so best-effort:
// the daily token caps are the hard limit. Searches are cached for an hour and files for a day (Cache API).
//
// Settings: GIF_PROVIDERS (vars; "openverse" by default, "commons" opt-in, "tenor" needs the
// TENOR_KEY secret, "off" turns the routes off); GIF_CONTACT (vars) goes into the User-Agent as
// Wikimedia asks; GIF_TOKEN_SECRET (secret) optional, otherwise derived from GH_HMAC_SECRET.
// OPENVERSE_CLIENT_ID + OPENVERSE_CLIENT_SECRET (secrets, 0.14): a registered Openverse application. Openverse
// limits anonymous calls per address, and every Cloudflare Worker reaches it from one shared address
// (cross-zone subrequests carry CF-Connecting-IP 2a06:98c0:3600::103), so without these, anonymous Openverse
// search from a deployed registry is refused almost always. With them the registry asks with its own token
// (OAuth2 client credentials, Openverse's /v1/auth_tokens/token/), limited per application instead.
// A source that refuses or fails hands over to the next one in GIF_PROVIDERS (0.14).
import { hmacHex } from './crypto.js';
import { fail } from './common.js';
import { DAY } from './limits.js';

export const GIF_TTL = 3600; // seconds
const MAX_GIF = 10 * 1024 * 1024;
const TENOR_HOSTS = ['media.tenor.com', 'media1.tenor.com', 'c.tenor.com', 'media.tenor.co'];
const COMMONS_HOSTS = ['upload.wikimedia.org'];
export const GIF_LIMITS = { tokenDay: [48, DAY], tokenAllDay: [20000, DAY], searchHour: 120, fileHour: 1200 };

export function gifSources(env) {
  const raw = String(env.GIF_PROVIDERS ?? 'openverse').toLowerCase();
  if (raw === 'off' || raw === 'none') return [];
  return [...new Set(raw.split(',').map((s) => s.trim()))].filter((s) => s === 'openverse' || s === 'commons' || (s === 'tenor' && env.TENOR_KEY));
}
async function tokenKey(env) {
  if (typeof env.GIF_TOKEN_SECRET === 'string' && env.GIF_TOKEN_SECRET.length >= 16) return env.GIF_TOKEN_SECRET;
  const s = env.GH_HMAC_SECRET;
  if (typeof s !== 'string' || s.length < 16) return null;
  return hmacHex(s, 'gif-token-key'); // never the GitHub hash key itself
}
export async function makeGifToken(env, uid, now) {
  const key = await tokenKey(env);
  if (!key) fail('config_error');
  const exp = now + GIF_TTL * 1000;
  return `${uid}.${exp}.${await hmacHex(key, `gif\n${uid}\n${exp}`)}`;
}
async function checkToken(env, req, now) {
  const m = /^Bearer ([a-z2-7]{16})\.(\d{13})\.([0-9a-f]{64})$/.exec(req.headers.get('authorization') || '');
  if (!m || Number(m[2]) < now) return null;
  const key = await tokenKey(env);
  if (!key || (await hmacHex(key, `gif\n${m[1]}\n${m[2]}`)) !== m[3]) return null;
  return m[0];
}
const signUrl = async (env, u) => hmacHex(await tokenKey(env), `gif-file\n${u}`);

// Hub mixin: the signed token route.
export const GifMixin = {
  async gifToken(b, ip) {
    if (!gifSources(this.env).length) fail('not_found');
    this.ipLimit('ipTurn', ip);
    const L = { ...GIF_LIMITS, ...(this.L.gifTokenDay ? { tokenDay: this.L.gifTokenDay } : {}), ...(this.L.gifTokenAllDay ? { tokenAllDay: this.L.gifTokenAllDay } : {}) };
    const uid = await this.signedP(b, 'gif-token', { mutating: false, maxP: 64 }, (acc) => {
      this.refuseBanned(acc.uid);
      if (!this.budgets.take(acc.uid, 'gifToken', L.tokenDay)) fail('rate_limited', { retryAfter: this.retryAfter(DAY) });
      if (!this.budgets.take('*', 'gifTokenAll', L.tokenAllDay)) fail('rate_limited', { retryAfter: this.retryAfter(DAY) });
      return acc.uid;
    });
    return { token: await makeGifToken(this.env, uid, this.now()), ttl: GIF_TTL, sources: gifSources(this.env) };
  },
};

// ---------- the Worker side ----------
const counts = new Map(); // `${kind}|${token}` -> { n, until }   (this instance only)
function counted(kind, token, max, now) {
  const k = `${kind}|${token}`;
  let c = counts.get(k);
  if (!c || c.until <= now) { c = { n: 0, until: now + 3600_000 }; counts.set(k, c); }
  if (counts.size > 20000) counts.delete(counts.keys().next().value);
  return ++c.n <= max;
}
const strip = (s, max = 120) => String(s ?? '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
  .replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩​-‏﻿]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const https = (raw) => { try { const u = new URL(String(raw)); return u.protocol === 'https:' && !u.username ? u.href.slice(0, 1000) : null; } catch { return null; } };
const dim = (v) => (Number.isInteger(v) && v > 0 && v <= 8000 ? v : undefined);
function licence(l, v) {
  l = String(l || '').toLowerCase();
  if (l === 'cc0') return 'CC0';
  if (l === 'pdm') return 'Public domain';
  return /^[a-z-]{2,12}$/.test(l) ? `CC ${l.toUpperCase()}${/^[\d.]{1,5}$/.test(String(v || '')) ? ` ${v}` : ''}` : '';
}
const credit = (author, lic, source, link) => {
  const a = strip(author, 80) || 'Unknown author';
  return { text: [a, strip(lic, 40), `via ${source}`].filter(Boolean).join(', '), author: a, licence: strip(lic, 40), source, ...(https(link) ? { link: https(link) } : {}) };
};
const onHosts = (raw, hosts, test) => { try { const u = new URL(raw); return test ? u.host === test : u.protocol === 'https:' && hosts.includes(u.host); } catch { return false; } };
const hostOf = (b) => { try { return new URL(b).host; } catch { return ''; } };

// The registry's Openverse token (OPENVERSE_CLIENT_ID/SECRET), kept in this Worker instance's memory until a
// minute before it runs out. null when there are no credentials or Openverse won't give one (then the call
// goes out anonymously, as before, and a refusal hands over to the next source).
export const SOURCE_LABELS = { openverse: 'Openverse', commons: 'Wikimedia Commons', tenor: 'Tenor' };
const ovTokens = new Map(); // `${base}\n${clientId}` -> { t, exp } | { failUntil } | { p: Promise }
async function openverseToken(env, ov, ua, nowMs) {
  const id = env.OPENVERSE_CLIENT_ID, secret = env.OPENVERSE_CLIENT_SECRET;
  if (typeof id !== 'string' || !id || typeof secret !== 'string' || !secret) return null;
  const k = `${ov}\n${id}`;
  const c = ovTokens.get(k);
  if (c?.t && c.exp > nowMs) return c.t;
  if (c?.failUntil > nowMs) return null;
  if (c?.p) return c.p;
  const p = (async () => {
    try {
      const r = await (env.__fetch || fetch)(`${ov}/v1/auth_tokens/token/`, {
        method: 'POST', redirect: 'manual',
        headers: { 'User-Agent': ua, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }).toString(),
      });
      const d = r.ok ? await r.json() : null;
      if (typeof d?.access_token !== 'string' || !/^[\w.~+/=-]{8,512}$/.test(d.access_token)) throw new Error('no token');
      const life = Math.min(Math.max(Number(d.expires_in) || 3600, 120), 30 * DAY / 1000);
      ovTokens.set(k, { t: d.access_token, exp: nowMs + (life - 60) * 1000 });
      return d.access_token;
    } catch {
      ovTokens.set(k, { failUntil: nowMs + 60_000 }); // ask again in a minute, not on every search
      return null;
    }
  })();
  ovTokens.set(k, { p });
  return p;
}

function providers(env, nowMs = Date.now()) {
  const ua = `Snug-registry/0.12 (GIF search for Snug desktop${env.GIF_CONTACT ? `; ${String(env.GIF_CONTACT).replace(/[^\w@.:/+~%#?&=-]/g, '').slice(0, 120)}` : ''})`;
  const get = (url, extra = {}) => (env.__fetch || fetch)(url, { headers: { 'User-Agent': ua, Accept: 'application/json', ...extra }, redirect: 'manual' });
  const ov = String(env.GIF_OPENVERSE_BASE || 'https://api.openverse.org').replace(/\/+$/, '');
  // The Openverse token goes to Openverse's own host only, never to a site an image is on.
  const ovAuth = async () => { const t = await openverseToken(env, ov, ua, nowMs); return t ? { Authorization: `Bearer ${t}` } : {}; };
  const cm = String(env.GIF_COMMONS_BASE || 'https://commons.wikimedia.org').replace(/\/+$/, '');
  const tn = String(env.GIF_TENOR_BASE || 'https://tenor.googleapis.com').replace(/\/+$/, '');
  const testOv = env.GIF_OPENVERSE_BASE ? hostOf(ov) : null, testCm = env.GIF_COMMONS_BASE ? hostOf(cm) : null, testTn = env.GIF_TENOR_BASE ? hostOf(tn) : null;
  return {
    ua,
    // Headers for fetching a file: the Openverse token for Openverse's own thumbnails, nothing for anyone else.
    async fileHeaders(u) { return hostOf(u) && hostOf(u) === hostOf(ov) ? ovAuth() : {}; },
    async openverse(q) {
      const auth = await ovAuth();
      const r = await get(`${ov}/v1/images/?${new URLSearchParams({ q, extension: 'gif', mature: 'false', page_size: '20' })}`, auth);
      if (r.status === 401 && auth.Authorization) ovTokens.delete(`${ov}\n${env.OPENVERSE_CLIENT_ID}`); // a fresh one next time
      if (!r.ok) throw Object.assign(new Error('provider'), { status: r.status });
      const d = await r.json();
      return (Array.isArray(d?.results) ? d.results : []).filter((g) => g && g.mature !== true).map((g) => {
        const url = testOv ? String(g.url || '') : https(g.url);
        const preview = (testOv ? String(g.thumbnail || '') : https(g.thumbnail)) || url;
        return url && preview ? { id: String(g.id || '').slice(0, 64), title: strip(g.title || 'GIF'), url, preview, w: dim(g.width), h: dim(g.height), credit: credit(g.creator, licence(g.license, g.license_version), 'Openverse', g.foreign_landing_url) } : null;
      }).filter(Boolean);
    },
    async commons(q) {
      const r = await get(`${cm}/w/api.php?${new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', generator: 'search', gsrnamespace: '6', gsrlimit: '24', gsrsearch: `filemime:image/gif ${q}`, prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '240', iiextmetadatafilter: 'LicenseShortName|Artist|ObjectName' })}`);
      if (!r.ok) throw Object.assign(new Error('provider'), { status: r.status });
      const d = await r.json();
      const pages = Array.isArray(d?.query?.pages) ? d.query.pages : Object.values(d?.query?.pages || {});
      return pages.map((p) => {
        const ii = p?.imageinfo?.[0];
        if (!ii || ii.mime !== 'image/gif' || !(ii.size > 0 && ii.size <= MAX_GIF) || !onHosts(ii.url, COMMONS_HOSTS, testCm)) return null;
        const md = ii.extmetadata || {};
        const thumb = ii.thumburl && onHosts(ii.thumburl, COMMONS_HOSTS, testCm) ? ii.thumburl : ii.url;
        return { id: String(p.pageid || ''), title: strip(md.ObjectName?.value || String(p.title || '').replace(/^File:/, '')) || 'Animation', url: ii.url, preview: thumb, w: dim(ii.width), h: dim(ii.height), credit: credit(md.Artist?.value, md.LicenseShortName?.value, 'Wikimedia Commons', ii.descriptionurl) };
      }).filter(Boolean);
    },
    async tenor(q) {
      const r = await get(`${tn}/v2/search?${new URLSearchParams({ q, key: env.TENOR_KEY, client_key: 'snug', limit: '24', media_filter: 'gif,tinygif,mediumgif,mp4', contentfilter: 'medium' })}`);
      if (!r.ok) throw Object.assign(new Error('provider'), { status: r.status });
      const d = await r.json();
      return (Array.isArray(d?.results) ? d.results : []).map((g) => {
        const f = g?.media_formats || {};
        const send = f.mediumgif || f.gif || f.tinygif || f.mp4;
        const prev = f.tinygif || f.mediumgif || f.gif;
        if (!send?.url || !prev?.url || !onHosts(send.url, TENOR_HOSTS, testTn) || !onHosts(prev.url, TENOR_HOSTS, testTn)) return null;
        const [w, h] = Array.isArray(send.dims) ? send.dims : [];
        return { id: String(g.id || ''), title: strip(g.content_description || 'GIF'), url: send.url, preview: prev.url, w: dim(w), h: dim(h) };
      }).filter(Boolean);
    },
  };
}

// What a GIF file really is, from its first bytes: GIF, WebP or MP4 only.
function gifType(b) {
  const s = (a, z) => String.fromCharCode(...b.subarray(a, z));
  if (b.length >= 6 && (s(0, 6) === 'GIF87a' || s(0, 6) === 'GIF89a')) return 'image/gif';
  if (b.length >= 12 && s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 12 && s(4, 8) === 'ftyp') return 'video/mp4';
  return null;
}

const cacheOf = () => globalThis.caches?.default || null;

// Handles /v1/gif/search and /v1/gif/file; null for any other path. `reply(status, obj)` makes a JSON response.
export async function gifWorker(req, env, ctx, reply, now) {
  const url = new URL(req.url);
  if (url.pathname !== '/v1/gif/search' && url.pathname !== '/v1/gif/file') return null;
  if (req.method !== 'GET') return reply(405, { error: 'bad_request', message: 'bad_request' });
  const sources = gifSources(env);
  if (!sources.length) return reply(404, { error: 'not_found', message: 'not_found' });
  const token = await checkToken(env, req, now);
  if (!token) return reply(401, { error: 'bad_token', message: 'GIF search needs a fresh token.' });
  const cache = cacheOf();

  // Tests (the shim only) may lower the per-token counts.
  const T = typeof env.TEST_CLOCK === 'function' && env.TEST_LIMITS ? env.TEST_LIMITS : {};
  if (url.pathname === '/v1/gif/search') {
    if (!counted('s', token, T.gifSearchHour || GIF_LIMITS.searchHour, now)) return reply(429, { error: 'rate_limited', message: 'Too many GIF searches. Wait a while.' });
    const q = String(url.searchParams.get('q') || '').trim().slice(0, 100);
    const asked = sources.includes(url.searchParams.get('source')) ? url.searchParams.get('source') : null;
    if (!q) return reply(200, { results: [], source: asked || sources[0] });
    // The source asked for by name, only; otherwise each configured source in turn until one answers.
    const P = providers(env, now);
    let list = null, src = null;
    const failed = []; // { s, status }
    for (const s of asked ? [asked] : sources) {
      const key = new Request(`https://gif-cache.snug/search/${s}?q=${encodeURIComponent(q.toLowerCase())}`);
      const hit = cache && (await cache.match(key));
      if (hit) { list = await hit.json(); src = s; break; }
      try { list = await P[s](q); } catch (e) {
        failed.push({ s, status: e.status || 0 });
        // Which GIF site refused and how (no query, no address), for `wrangler tail`.
        if (typeof env.TEST_CLOCK !== 'function') console.warn('registry: gif source', s, e.status || 'unreachable');
        continue;
      }
      src = s;
      if (cache) ctx?.waitUntil?.(cache.put(key, new Response(JSON.stringify(list), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' } })));
      break;
    }
    if (!src) {
      const names = failed.map((f) => SOURCE_LABELS[f.s] || f.s).join(' and ');
      const limited = failed.every((f) => f.status === 429);
      return reply(limited ? 429 : 502, limited
        ? { error: 'rate_limited', message: `${names} ${failed.length > 1 ? 'are' : 'is'} turning away GIF searches from the Snug registry right now. Try again later.` }
        : { error: 'unavailable', message: `GIF search isn’t answering right now: ${names} didn’t answer the Snug registry. Try again later.` });
    }
    const file = async (u) => `/v1/gif/file?${new URLSearchParams({ u, s: await signUrl(env, u) })}`;
    const results = await Promise.all(list.map(async (g) => ({ ...g, url: await file(g.url), preview: await file(g.preview), source: src })));
    return reply(200, { results, source: src });
  }

  // /v1/gif/file
  if (!counted('f', token, T.gifFileHour || GIF_LIMITS.fileHour, now)) return reply(429, { error: 'rate_limited', message: 'Too many GIFs. Wait a while.' });
  const u = String(url.searchParams.get('u') || '');
  const s = String(url.searchParams.get('s') || '');
  if (!/^[0-9a-f]{64}$/.test(s) || s !== (await signUrl(env, u))) return reply(403, { error: 'bad_request', message: 'Not an address from a search.' });
  const key = new Request(`https://gif-cache.snug/file/${s}`);
  const hit = cache && (await cache.match(key));
  if (hit) return hit;
  let r;
  const P = providers(env, now);
  try { r = await (env.__fetch || fetch)(u, { redirect: 'manual', headers: { 'User-Agent': P.ua, ...(await P.fileHeaders(u)) } }); } catch { return reply(502, { error: 'unavailable', message: 'The GIF couldn’t be fetched.' }); }
  if (r.status !== 200 || !r.body) return reply(502, { error: 'unavailable', message: 'The GIF couldn’t be fetched.' });
  if (Number(r.headers.get('content-length')) > MAX_GIF) return reply(413, { error: 'bad_request', message: 'That GIF is over 10 MB.' });
  const reader = r.body.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > MAX_GIF) { try { await reader.cancel(); } catch { /* gone */ } return reply(413, { error: 'bad_request', message: 'That GIF is over 10 MB.' }); }
    parts.push(value);
  }
  const buf = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.byteLength; }
  const type = gifType(buf);
  if (!type) return reply(415, { error: 'bad_request', message: 'That isn’t a GIF.' });
  const res = new Response(buf, { status: 200, headers: { 'content-type': type, 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" } });
  if (cache) ctx?.waitUntil?.(cache.put(key, res.clone()));
  return res;
}
