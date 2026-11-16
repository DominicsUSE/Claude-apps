// Join mode, pinned: the app runs its own bundled Snug page at the host's address.
//
// Without this, joining a Snug someone else runs loads whatever JavaScript that
// server sends, so whoever runs it could change the page to read encrypted
// messages. Here the window uses its own session ("persist:snug-join"), and a
// protocol handler on that session answers the page's own files (index.html,
// js/, css/, ... : the same paths and headers as server/static.js) from the
// copy inside the app (desktop/snug), at the host's origin. Everything else
// (/api/*) goes on to the host through the same session, so its cookies, its
// Origin checks and the WebSocket (which the handler never sees) work unchanged:
// the host needs no CORS and no tokens.
//
// main.js passes in what it needs (the session, Electron's net), so the parts
// that make decisions unit-test under plain Node (pinned.test.js).
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { Readable, Writable } = require("stream");

const PARTITION = "persist:snug-join";
const LOOPBACK = (host) => host === "localhost" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);

// A plain-http join address that isn't this computer: the browser engine won't
// treat it as a secure context, so WebCrypto (and with it encryption) would be
// missing. main.js marks that one origin as secure at startup. The code is the
// app's own, so a network attacker can't change it; what crosses the network
// unencrypted stays readable as before (Settings says so).
function insecureOrigin(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" && !LOOPBACK(u.hostname) ? u.origin : null;
  } catch { return null; }
}

// The rules and versions come from the bundled app itself, so they always match the files served.
async function loadRules(appDir) {
  const load = (rel) => import(pathToFileURL(path.join(appDir, rel)).toString());
  const [stat, proto] = await Promise.all([load("server/static.js"), load("js/lib/proto.js")]);
  return {
    staticRel: stat.staticRel, staticHeaders: stat.staticHeaders, base: stat.BASE_HEADERS,
    client: { proto: proto.PROTO, minServer: proto.MIN_SERVER },
  };
}

// Whether the bundled client and the host's server fit (js/lib/proto.js), from GET /api/version.
// "old": the server is older than this app works with (0.11 and earlier have no /api/version);
// "app-old": the server needs a newer app.
function verdict(client, server) {
  if (!server) return { state: "old", server: null };
  if (Number(client.proto) < server.minClient) return { state: "app-old", server };
  if (server.proto < Number(client.minServer)) return { state: "old", server };
  return { state: "ok", server };
}
function readVersion(json) {
  if (!json || typeof json !== "object" || !Number.isFinite(Number(json.proto))) return null;
  return { version: String(json.version || "").slice(0, 20), proto: Number(json.proto), minClient: Number(json.minClient) || 0, e2ee: json.e2ee === 1 };
}
// "unreachable" when nothing answers at all (main.js goes back to setup with the reason, as before).
async function checkVersion(ses, origin, rules, timeoutMs = 10_000) {
  let res;
  try {
    res = await ses.fetch(`${origin}/api/version`, { bypassCustomProtocolHandlers: true, cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  } catch { return { state: "unreachable", server: null }; }
  let json = null;
  if (res.ok) { try { json = await res.json(); } catch { /* not Snug, or an older one */ } } else res.body?.cancel().catch(() => {});
  return verdict(rules.client, readVersion(json));
}

// The bundled file for a request, or null when it goes to the host.
async function bundled(req, { origin, appDir, rules }) {
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  const u = new URL(req.url);
  if (u.origin !== origin) return null;
  let p;
  try { p = decodeURIComponent(u.pathname); } catch { return null; } // the host answers a bad address
  if (p.startsWith("/api/")) return null;
  const rel = rules.staticRel(p);
  const notFound = () => new Response("Not found", { status: 404, headers: { ...rules.base, "Content-Type": "text/plain; charset=utf-8" } });
  if (!rel) return notFound();
  let body;
  try { body = await fs.promises.readFile(path.join(appDir, ...rel.split("/"))); } catch { return notFound(); }
  const headers = { ...rules.base, ...rules.staticHeaders(rel, u.protocol === "https:") };
  return new Response(req.method === "HEAD" ? null : body, { status: 200, headers });
}

// Everything else, to the host through the window's session (its cookies are sent and kept there).
// Like Electron's ses.fetch, plus two things it can't do: a redirect comes back to the page as a
// redirect (so the page follows it itself, and the window's will-redirect guard sees where it goes),
// and requests that change something carry Origin: <host>, which the host checks.
//
// The host's answers are data for the bundled page, never code at the host's origin: a request the
// browser makes to load a document, a frame, a script or a worker from /api is refused here without
// asking the host, and every answer that comes back is marked nosniff with a sandboxing policy (so
// even one that ends up shown as a page runs nothing), and can't widen a service worker's scope.
// Pictures, sound and video still load (Sec-Fetch-Dest image, audio, video), as do fetches (empty).
const NO_BODY = new Set([101, 204, 205, 304]);
const NEVER_CODE = new Set(["document", "iframe", "frame", "script", "worker", "sharedworker", "serviceworker"]);
const API_CSP = "sandbox; default-src 'none'";
function harden(headers) {
  headers.delete("service-worker-allowed");
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", API_CSP);
  return headers;
}
function passThrough(net, ses, req, origin) {
  const dest = String(req.headers.get("sec-fetch-dest") || "").toLowerCase();
  if (NEVER_CODE.has(dest)) {
    return Promise.resolve(new Response("Not here", { status: 403, headers: harden(new Headers({ "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" })) }));
  }
  return new Promise((resolve, reject) => {
    const cr = net.request({ session: ses, method: req.method, url: req.url, origin, credentials: "include", redirect: "manual", bypassCustomProtocolHandlers: true });
    for (const [k, v] of req.headers) { try { cr.setHeader(k, v); } catch { /* a header the network layer sets itself */ } }
    if (req.method !== "GET" && req.method !== "HEAD") cr.setHeader("Origin", origin);
    cr.on("redirect", (status, _method, url) => {
      cr.abort();
      resolve(new Response(null, { status, headers: harden(new Headers({ location: url, "cache-control": "no-store" })) }));
    });
    cr.on("response", (r) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(r.headers)) for (const v of [].concat(value)) headers.append(name, String(v));
      const body = NO_BODY.has(r.statusCode) || req.method === "HEAD" ? null : Readable.toWeb(r);
      resolve(new Response(body, { status: r.statusCode, statusText: r.statusMessage, headers: harden(headers) }));
    });
    cr.on("error", reject);
    if (req.body) req.body.pipeTo(Writable.toWeb(cr)).catch((e) => { cr.abort(); reject(e); });
    else cr.end();
  });
}

// Serve the bundled client at origin on this session (again: a new address replaces the old one).
function pin(ses, origin, { net, appDir, rules }) {
  unpin(ses);
  const scheme = new URL(origin).protocol.slice(0, -1);
  ses.protocol.handle(scheme, async (req) => {
    const own = await bundled(req, { origin, appDir, rules });
    if (own) return own;
    if (new URL(req.url).origin !== origin) return ses.fetch(req, { bypassCustomProtocolHandlers: true }); // another site (the page's CSP decides)
    return passThrough(net, ses, req, origin);
  });
}
function unpin(ses) {
  for (const scheme of ["http", "https"]) if (ses.protocol.isProtocolHandled(scheme)) ses.protocol.unhandle(scheme);
}

// What the fallback page says (fallback.html), from the version check.
function fallbackText({ state, host, server, app }) {
  const where = (() => { try { return new URL(host).host; } catch { return String(host); } })();
  if (state === "app-old") {
    return {
      title: "This Snug needs a newer app",
      lead: `${where} runs Snug ${server || "(a newer version)"}; this app has ${app}. Update the app to use its own built-in code with this server.`,
    };
  }
  return {
    title: "This Snug runs an older version",
    lead: `${where} runs ${server ? `Snug ${server}` : "an older Snug (0.11 or earlier)"}; this app has ${app}. The app runs its own built-in code, which needs a newer server.`,
  };
}
const OWN_PAGE_NOTE = (host) => `The server’s own page runs code from ${host}. Encrypted conversations there depend on trusting whoever runs it.`;
const OWN_PAGE_SUFFIX = " — server’s own page";

module.exports = { PARTITION, insecureOrigin, loadRules, verdict, readVersion, checkVersion, bundled, passThrough, pin, unpin, fallbackText, OWN_PAGE_NOTE, OWN_PAGE_SUFFIX };
