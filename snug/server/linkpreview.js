// Link previews: fetching a page or a picture someone linked, safely.
//
// The server fetches addresses people type, so every fetch is treated as an
// attack on the network it runs in (server-side request forgery):
// - http and https only, no user:password@, ports 80, 443, 8080 and 8443 only;
// - the host name is resolved here, and every address it resolves to must be
//   public: loopback, private, link-local (169.254.x.x, the cloud metadata
//   address), carrier-grade NAT, multicast, documentation and reserved ranges
//   are refused, for IPv4 and IPv6, including IPv4 hidden inside IPv6;
// - the connection goes to the address that was checked (the lookup is
//   pinned), so a second DNS answer can't swap in a private one;
// - redirects are followed by hand, at most three, and each one is checked
//   again from the start;
// - every fetch has a time limit and a size limit, and stops reading at it.
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';

export const PORTS = new Set(['', '80', '443', '8080', '8443']);

// IPv4 ranges that are not the public internet: [first octets as a number, prefix length].
const V4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([a, bits]) => [v4num(a), bits]);

function v4num(a) {
  const p = a.split('.').map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

export function v4Blocked(a) {
  if (isIP(a) !== 4) return true;
  const n = v4num(a);
  return V4_BLOCKED.some(([base, bits]) => (bits === 0 ? true : ((n >>> (32 - bits)) === (base >>> (32 - bits)))));
}

// An IPv6 address as eight 16-bit numbers, or null.
function v6parts(a) {
  let s = a.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    if (isIP(v4[1]) !== 4) return null;
    const n = v4num(v4[1]);
    s = `${s.slice(0, -v4[1].length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  if (!/^[0-9a-f:]+$/.test(s)) return null;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const hex = (x) => (x ? x.split(':') : []);
  const head = hex(halves[0]), back = halves.length === 2 ? hex(halves[1]) : [];
  if ([...head, ...back].some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return null;
  const fill = 8 - head.length - back.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const all = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...back].map((x) => parseInt(x, 16));
  return all.length === 8 ? all : null;
}

export function v6Blocked(a) {
  const p = v6parts(a);
  if (!p) return true;
  const embedded = () => `${p[6] >> 8}.${p[6] & 255}.${p[7] >> 8}.${p[7] & 255}`;
  if (p.every((x) => x === 0)) return true;                                  // ::
  if (p.slice(0, 7).every((x) => x === 0) && p[7] === 1) return true;        // ::1
  if (p.slice(0, 5).every((x) => x === 0) && p[5] === 0xffff) return v4Blocked(embedded()); // ::ffff:a.b.c.d
  if (p.slice(0, 6).every((x) => x === 0)) return true;                      // ::a.b.c.d (deprecated)
  if (p[0] === 0x64 && p[1] === 0xff9b) return v4Blocked(embedded());        // NAT64
  if ((p[0] & 0xfe00) === 0xfc00) return true;                               // fc00::/7 unique local
  if ((p[0] & 0xffc0) === 0xfe80) return true;                               // fe80::/10 link-local
  if ((p[0] & 0xffc0) === 0xfec0) return true;                               // fec0::/10 site-local
  if ((p[0] & 0xff00) === 0xff00) return true;                               // multicast
  if (p[0] === 0x2001 && p[1] === 0x0db8) return true;                       // documentation
  if (p[0] === 0x2002) return true;                                          // 6to4: may wrap anything
  if (p[0] === 0x2001 && p[1] === 0) return true;                            // Teredo
  if (p[0] === 0x0100 && p.slice(1, 4).every((x) => x === 0)) return true;   // discard prefix
  return false;
}

export const addressBlocked = (a) => (isIP(a) === 4 ? v4Blocked(a) : isIP(a) === 6 ? v6Blocked(a) : true);

// A link someone typed, checked before anything is resolved. Null if refused.
// `anyPort` is for tests only, with a local stand-in site on a random port.
export function checkUrl(raw, { anyPort = false } = {}) {
  let u;
  try { u = new URL(String(raw)); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (!anyPort && !PORTS.has(u.port)) return null;
  if (!u.hostname || u.hostname.length > 253) return null;
  u.hash = '';
  return u;
}

// Resolve a host and keep only an address that is public. `allowLoopback` is
// for tests (a local stand-in site); it lets 127.0.0.1 through and nothing else.
export async function resolvePublic(hostname, { allowLoopback = false, lookup = dnsLookup } = {}) {
  const host = hostname.replace(/^\[|\]$/g, '');
  let addrs;
  if (isIP(host)) addrs = [{ address: host, family: isIP(host) }];
  else {
    try { addrs = await lookup(host, { all: true, verbatim: true }); } catch { return null; }
  }
  if (!addrs?.length) return null;
  const ok = (a) => !addressBlocked(a.address) || (allowLoopback && a.address === '127.0.0.1');
  // Every answer must be public: a name that also points inside is refused outright.
  if (!addrs.every(ok)) return null;
  return addrs[0];
}

class FetchError extends Error {}

// One request to an address that was already checked. Resolves with
// { status, headers, body (Buffer), url }; never follows redirects itself.
function requestOnce(u, addr, { timeoutMs, maxBytes, accept, signal }) {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: 'GET',
      headers: { 'User-Agent': 'SnugLinkPreview/1.0 (+link previews)', Accept: accept, 'Accept-Encoding': 'identity' },
      // Pinned: the socket connects to the address checked above, whatever DNS says now.
      lookup: (_h, opts, cb) => (opts?.all ? cb(null, [{ address: addr.address, family: addr.family }]) : cb(null, addr.address, addr.family)),
      timeout: timeoutMs,
      signal,
    }, (res) => {
      const status = res.statusCode;
      if (status >= 300 && status < 400) { res.resume(); resolve({ status, headers: res.headers, body: Buffer.alloc(0) }); return; }
      const len = Number(res.headers['content-length']);
      if (Number.isFinite(len) && len > maxBytes && !res.headers['content-type']?.startsWith('text/html')) { req.destroy(); reject(new FetchError('too big')); return; }
      const chunks = [];
      let size = 0, cut = false;
      res.on('data', (c) => {
        if (cut) return;
        size += c.length;
        if (size > maxBytes) {
          // A page is read only as far as the limit (its head is what matters);
          // anything else over the limit is not used at all.
          cut = true;
          if (String(res.headers['content-type'] || '').startsWith('text/html')) { chunks.push(c.subarray(0, c.length - (size - maxBytes))); resolve({ status, headers: res.headers, body: Buffer.concat(chunks), cut: true }); }
          else reject(new FetchError('too big'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => { if (!cut) resolve({ status, headers: res.headers, body: Buffer.concat(chunks) }); });
      res.on('error', (e) => { if (!cut) reject(e); });
    });
    req.on('timeout', () => req.destroy(new FetchError('timeout')));
    req.on('error', reject);
    req.end();
  });
}

// Fetch a link with all the checks above. Resolves with { status, type, body, url }
// or rejects. Whole-fetch time limit, redirects included.
export async function safeFetch(raw, { maxBytes = 1024 * 1024, timeoutMs = 5000, accept = '*/*', allowLoopback = false, lookup } = {}) {
  let u = checkUrl(raw, { anyPort: allowLoopback });
  if (!u) throw new FetchError('refused');
  const deadline = Date.now() + timeoutMs;
  for (let hop = 0; hop <= 3; hop++) {
    const addr = await resolvePublic(u.hostname, { allowLoopback, lookup });
    if (!addr) throw new FetchError('refused');
    const left = deadline - Date.now();
    if (left <= 0) throw new FetchError('timeout');
    // The whole fetch stops at the deadline, however slowly the other end drips.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new FetchError('timeout')), left);
    let res;
    try { res = await requestOnce(u, addr, { timeoutMs: left, maxBytes, accept, signal: ac.signal }); } finally { clearTimeout(timer); }
    if (res.status >= 300 && res.status < 400) {
      let next = null;
      try { next = res.headers.location && checkUrl(new URL(res.headers.location, u).href, { anyPort: allowLoopback }); } catch { next = null; }
      if (!next) throw new FetchError('refused');
      u = next;
      continue;
    }
    const type = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    return { status: res.status, type, body: res.body, url: u.href };
  }
  throw new FetchError('too many redirects');
}

// ---------- Reading a page ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8}|#39);/gi, (all, e) => {
    const k = e.toLowerCase();
    if (k.startsWith('#x')) { const n = parseInt(k.slice(2), 16); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
    if (k.startsWith('#')) { const n = Number(k.slice(1)); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
    return ENT[k] ?? all;
  });
}
const clean = (s, max) => {
  const t = decodeEntities(s || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

// Title, description, site name, image and colour from a page's head: Open
// Graph first, then Twitter cards, then plain <title> and description.
export function readMeta(html, pageUrl) {
  const head = String(html).slice(0, 512 * 1024);
  const metas = {};
  for (const m of head.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = {};
    for (const a of m[1].matchAll(/([a-zA-Z:_-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) attrs[a[1].toLowerCase()] = a[3] ?? a[4] ?? a[5] ?? '';
    const key = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    if (key && attrs.content != null && !(key in metas)) metas[key] = attrs.content;
  }
  const title = metas['og:title'] || metas['twitter:title'] || (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? '');
  const description = metas['og:description'] || metas['twitter:description'] || metas.description || '';
  const site = metas['og:site_name'] || '';
  let image = metas['og:image:secure_url'] || metas['og:image'] || metas['og:image:url'] || metas['twitter:image'] || metas['twitter:image:src'] || '';
  try { image = image ? new URL(decodeEntities(image), pageUrl).href : ''; } catch { image = ''; }
  const color = /^#[0-9a-f]{6}$/i.test(metas['theme-color'] || '') ? metas['theme-color'].toLowerCase() : undefined;
  return { title: clean(title, 256), description: clean(description, 350), site: clean(site, 64), image, color };
}

// Links in a message that should get a preview: http(s) only, at most three,
// each once. A link written as <https://...> asks for no preview.
export function previewLinks(text, max = 3, { anyPort = false } = {}) {
  const out = [];
  const src = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  for (const m of src.matchAll(/(<)?(https?:\/\/[^\s<>]+[^\s<>.,;:!?)\]'"])(>)?/g)) {
    if (m[1] && m[3]) continue;
    const before = src.slice(Math.max(0, m.index - 2), m.index);
    if (before.endsWith('](')) continue; // masked link: [text](url) shows no preview of its own
    if (!checkUrl(m[2], { anyPort })) continue;
    if (!out.includes(m[2])) out.push(m[2]);
    if (out.length >= max) break;
  }
  return out;
}
