// Where GIF search comes from (server/media.js uses these). The browser never
// talks to a provider: the server searches, fetches previews and copies the
// GIF someone picks into Snug, so a provider sees the server's address and the
// words searched for, never the person's address.
//
// SNUG_GIF_PROVIDER picks the sources, in order (comma-separated):
//   openverse  openly licensed images through Openverse (keyless; the default on a host server)
//   commons    animations from Wikimedia Commons (keyless; no safe-search filter, so opt-in)
//   tenor      Tenor, only with SNUG_TENOR_KEY (a free Google Cloud key)
//   registry   through the Snug registry (the default for the desktop app), so a desktop
//              user's address never reaches a provider
//   off        no search at all
// SNUG_GIF_CONTACT (a URL or e-mail of whoever runs the server) is added to the
// User-Agent, as Wikimedia's User-Agent policy asks; nothing about the person searching is.
// SNUG_OPENVERSE_BASE, SNUG_COMMONS_BASE and SNUG_TENOR_BASE point a provider at a
// local stand-in in tests; then only that stand-in may serve media.
import { safeFetch } from './linkpreview.js';
import { sniff } from './media.js';

export const MAX_GIF = 10 * 1024 * 1024;
const VERSION = '0.12';
const TENOR_MEDIA_HOSTS = ['media.tenor.com', 'media1.tenor.com', 'c.tenor.com', 'media.tenor.co'];
const COMMONS_MEDIA_HOSTS = ['upload.wikimedia.org'];

export function userAgent(env = process.env) {
  const contact = String(env.SNUG_GIF_CONTACT || '').replace(/[^\w@.:/+~%#?&=-]/g, '').slice(0, 120);
  return `Snug/${VERSION} (self-hosted chat server${contact ? `; ${contact}` : ''})`;
}

const strip = (s, max = 120) => String(s ?? '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
  .replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩​-‏﻿]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const httpsLink = (raw) => { try { const u = new URL(String(raw)); return u.protocol === 'https:' && !u.username && !u.password ? u.href.slice(0, 500) : null; } catch { return null; } };
const dim = (v) => (Number.isInteger(v) && v > 0 && v <= 8000 ? v : undefined);

// "CC BY-SA 4.0", "CC0", "Public domain".
export function licenceName(license, version) {
  const l = String(license || '').toLowerCase();
  if (l === 'cc0') return 'CC0';
  if (l === 'pdm') return 'Public domain';
  if (!/^[a-z-]{2,12}$/.test(l)) return '';
  return `CC ${l.toUpperCase()}${version && /^[\d.]{1,5}$/.test(String(version)) ? ` ${version}` : ''}`;
}

// A credit line that goes with an openly licensed GIF wherever it is shown.
export function creditOf({ author, licence, source, link }) {
  const text = [strip(author, 80) || 'Unknown author', strip(licence, 40), source ? `via ${source}` : ''].filter(Boolean).join(', ');
  return { text: text.slice(0, 200), ...(httpsLink(link) ? { link: httpsLink(link) } : {}) };
}

const onHosts = (raw, { hosts, protocol }) => { try { const u = new URL(String(raw)); return u.protocol === protocol && hosts.includes(u.host) && !u.username && !u.password; } catch { return false; } };
// Fetches only from fixed media hosts, never following a redirect: Tenor and Commons.
async function hostDownload(raw, { hosts, protocol, fetchFn, ua }) {
  let u;
  try { u = new URL(String(raw)); } catch { return { err: 'That address isn’t one Snug fetches GIFs from.' }; }
  if (u.protocol !== protocol || !hosts.includes(u.host) || u.username || u.password) return { err: 'That address isn’t one Snug fetches GIFs from.' };
  let res;
  try { res = await fetchFn(u, { redirect: 'manual', headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(15000) }); } catch { return { err: 'The GIF couldn’t be fetched. Try another.' }; }
  if (res.status !== 200 || !res.body) return { err: 'The GIF couldn’t be fetched. Try another.' };
  if (Number(res.headers.get('content-length')) > MAX_GIF) return { err: 'That GIF is over 10 MB. Try another.' };
  const chunks = [];
  let size = 0;
  for await (const c of res.body) {
    size += c.length;
    if (size > MAX_GIF) return { err: 'That GIF is over 10 MB. Try another.' };
    chunks.push(c);
  }
  return typed(Buffer.concat(chunks));
}
// Fetches from any public host (Openverse lists images on many sites): every hop's address is checked
// (no private or local addresses, server/linkpreview.js), at most 10 MB.
async function publicDownload(raw, { allowLoopback }) {
  let r;
  try { r = await safeFetch(String(raw), { maxBytes: MAX_GIF, timeoutMs: 15000, accept: 'image/gif,image/webp,video/mp4;q=0.8,*/*;q=0.1', allowLoopback }); } catch (e) {
    return { err: /too big/.test(e.message) ? 'That GIF is over 10 MB. Try another.' : 'The GIF couldn’t be fetched. Try another.' };
  }
  if (r.status !== 200) return { err: 'The GIF couldn’t be fetched. Try another.' };
  return typed(r.body);
}
// Only what Snug can show, by its bytes.
function typed(data) {
  const real = sniff(data);
  const type = real === 'image/gif' || real === 'image/webp' ? real : real === 'mp4' ? 'video/mp4' : null;
  if (!type) return { err: 'That isn’t a GIF Snug can show.' };
  return { data, type };
}

async function getJson(url, { fetchFn, ua, headers = {} }) {
  const r = await fetchFn(url, { redirect: 'manual', headers: { 'User-Agent': ua, Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw Object.assign(new Error(String(r.status)), { status: r.status });
  return r.json();
}
const base = (env, k, d) => String(env[k] || d).replace(/\/+$/, '');
const isLocal = (b) => { try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(b).hostname); } catch { return false; } };

// ---------- the providers ----------
function tenor(env, { fetchFn, ua }) {
  const key = env.SNUG_TENOR_KEY; // read once at start, like every other setting
  if (!key) return null;
  const b = base(env, 'SNUG_TENOR_BASE', 'https://tenor.googleapis.com');
  const test = !!env.SNUG_TENOR_BASE;
  const media = { hosts: test ? [new URL(b).host] : TENOR_MEDIA_HOSTS, protocol: test ? new URL(b).protocol : 'https:', fetchFn, ua };
  return {
    id: 'tenor', label: 'Tenor', note: 'Search results from Tenor.', badge: 'Powered by Tenor',
    async search(q) {
      const data = await getJson(`${b}/v2/search?${new URLSearchParams({ q, key, client_key: 'snug', limit: '24', media_filter: 'gif,tinygif,mediumgif,mp4', contentfilter: 'medium' })}`, { fetchFn, ua });
      return (Array.isArray(data?.results) ? data.results : []).map((g) => {
        const f = g?.media_formats || {};
        const send = f.mediumgif || f.gif || f.tinygif || f.mp4;
        const prev = f.tinygif || f.mediumgif || f.gif;
        // Results whose media is off the provider's own hosts are dropped.
        if (!send?.url || !prev?.url || !onHosts(send.url, media) || !onHosts(prev.url, media)) return null;
        const [w, h] = Array.isArray(send.dims) ? send.dims : [];
        return { id: String(g.id || ''), title: strip(g.content_description || g.title || 'GIF'), url: send.url, preview: prev.url, w: dim(w), h: dim(h) };
      }).filter(Boolean);
    },
    fetch: (u) => hostDownload(u, media),
  };
}

function openverse(env, { fetchFn, ua }) {
  const b = base(env, 'SNUG_OPENVERSE_BASE', 'https://api.openverse.org');
  const allowLoopback = isLocal(b);
  return {
    id: 'openverse', label: 'Openverse', note: 'Openly licensed GIFs found through Openverse. Each one shows its author and licence.',
    async search(q) {
      // Anonymous use: 20 results a page and a few searches a minute; results are cached here for an hour.
      const data = await getJson(`${b}/v1/images/?${new URLSearchParams({ q, extension: 'gif', mature: 'false', page_size: '20' })}`, { fetchFn, ua });
      return (Array.isArray(data?.results) ? data.results : []).map((g) => {
        const url = httpsLink(g?.url) || (allowLoopback ? String(g?.url || '') : null);
        const preview = httpsLink(g?.thumbnail) || (allowLoopback ? String(g?.thumbnail || '') : null) || url;
        if (!url || !preview || g.mature === true) return null;
        return {
          id: String(g.id || '').slice(0, 64), title: strip(g.title || 'GIF'), url, preview, w: dim(g.width), h: dim(g.height),
          credit: creditOf({ author: g.creator, licence: licenceName(g.license, g.license_version), source: 'Openverse', link: g.foreign_landing_url }),
        };
      }).filter(Boolean);
    },
    fetch: (u) => publicDownload(u, { allowLoopback }),
  };
}

function commons(env, { fetchFn, ua }) {
  const b = base(env, 'SNUG_COMMONS_BASE', 'https://commons.wikimedia.org');
  const test = !!env.SNUG_COMMONS_BASE;
  const media = { hosts: test ? [new URL(b).host] : COMMONS_MEDIA_HOSTS, protocol: test ? new URL(b).protocol : 'https:', fetchFn, ua };
  return {
    id: 'commons', label: 'Wikimedia Commons', note: 'Animations from Wikimedia Commons: mostly diagrams and illustrations, not reaction GIFs. Commons has no safe-search filter. Each one shows its author and licence.',
    async search(q) {
      const params = new URLSearchParams({
        action: 'query', format: 'json', formatversion: '2', generator: 'search', gsrnamespace: '6', gsrlimit: '24',
        gsrsearch: `filemime:image/gif ${q}`, prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '240',
        iiextmetadatafilter: 'LicenseShortName|Artist|AttributionRequired|ObjectName',
      });
      const data = await getJson(`${b}/w/api.php?${params}`, { fetchFn, ua });
      const pages = Array.isArray(data?.query?.pages) ? data.query.pages : Object.values(data?.query?.pages || {});
      return pages.map((p) => {
        const ii = p?.imageinfo?.[0];
        if (!ii || ii.mime !== 'image/gif' || !(ii.size > 0 && ii.size <= MAX_GIF) || !onHosts(ii.url, media) || (ii.thumburl && !onHosts(ii.thumburl, media))) return null;
        const md = ii.extmetadata || {};
        const title = strip(md.ObjectName?.value || String(p.title || '').replace(/^File:/, '').replace(/\.gif$/i, ''));
        return {
          id: String(p.pageid || ''), title: title || 'Animation', url: ii.url, preview: ii.thumburl || ii.url, w: dim(ii.width), h: dim(ii.height),
          credit: creditOf({ author: md.Artist?.value, licence: md.LicenseShortName?.value, source: 'Wikimedia Commons', link: ii.descriptionurl }),
        };
      }).filter(Boolean);
    },
    fetch: (u) => hostDownload(u, media),
  };
}

// Through the Snug registry (registry/src/gif.js): a short-lived token from a signed call, then
// search and media from the registry, which talks to the providers.
function registry(env, { fetchFn, reg }) {
  if (!reg?.base || !reg.token) return null;
  let tok = null; // { t, exp, sources }
  const token = async () => {
    if (tok && tok.exp > Date.now() + 60_000) return tok;
    const r = await reg.token();
    if (!r?.token) throw Object.assign(new Error('no token'), { status: 404 });
    tok = { t: r.token, exp: Date.now() + Math.min(3600, Number(r.ttl) || 3600) * 1000, sources: r.sources || [] };
    return tok;
  };
  const grab = async (path) => {
    const t = await token();
    const r = await fetchFn(`${reg.base}${path}`, { redirect: 'manual', headers: { Authorization: `Bearer ${t.t}` }, signal: AbortSignal.timeout(15000) });
    if (r.status === 401) tok = null;
    return r;
  };
  const p = {
    id: 'registry', label: 'Snug registry', note: 'Search goes through the Snug registry, so GIF sites see the registry’s address, not yours. The registry sees what you search for.',
    sources: () => tok?.sources || [],
    async search(q) {
      const r = await grab(`/v1/gif/search?${new URLSearchParams({ q })}`);
      if (!r.ok) throw Object.assign(new Error(String(r.status)), { status: r.status });
      const d = await r.json();
      return (Array.isArray(d?.results) ? d.results : []).map((g) => {
        if (typeof g?.url !== 'string' || typeof g?.preview !== 'string') return null;
        return {
          id: String(g.id || '').slice(0, 64), title: strip(g.title || 'GIF'), url: g.url, preview: g.preview, w: dim(g.w), h: dim(g.h),
          ...(g.credit?.text ? { credit: creditOf({ author: g.credit.author ?? g.credit.text, licence: g.credit.licence, source: g.credit.source, link: g.credit.link }) } : {}),
          source: typeof g.source === 'string' ? g.source.slice(0, 20) : undefined,
        };
      }).filter(Boolean);
    },
    async fetch(u) {
      // Only the registry's own file route, with the signature it gave in the search results.
      if (typeof u !== 'string' || !u.startsWith('/v1/gif/file?')) return { err: 'That address isn’t one Snug fetches GIFs from.' };
      let r;
      try { r = await grab(u); } catch { return { err: 'The GIF couldn’t be fetched. Try another.' }; }
      if (r.status !== 200 || !r.body) return { err: 'The GIF couldn’t be fetched. Try another.' };
      const chunks = [];
      let size = 0;
      for await (const c of r.body) { size += c.length; if (size > MAX_GIF) return { err: 'That GIF is over 10 MB. Try another.' }; chunks.push(c); }
      return typed(Buffer.concat(chunks));
    },
  };
  return p;
}

const MAKERS = { tenor, openverse, commons, registry };

// The configured sources, in order. `reg` is { base, token() } on a desktop PC linked to a registry.
export function gifProviders(env = process.env, { fetch: fetchFn = globalThis.fetch, reg = null } = {}) {
  const ua = userAgent(env);
  const raw = String(env.SNUG_GIF_PROVIDER ?? '').trim().toLowerCase();
  if (raw === 'off' || raw === 'none') return [];
  const names = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [reg?.base ? 'registry' : 'openverse'];
  const out = [];
  for (const n of [...new Set(names)]) {
    const make = Object.hasOwn(MAKERS, n) ? MAKERS[n] : null;
    const p = make?.(env, { fetchFn, ua, reg });
    if (p) out.push(p);
  }
  return out;
}
