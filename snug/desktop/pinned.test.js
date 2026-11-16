// Unit tests for the pinned join mode (desktop/pinned.js), under plain Node:
//   node --test pinned.test.js
// The Electron side (a real window at a host's address) is in test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Writable } = require("stream");
const { EventEmitter } = require("events");
const { pathToFileURL } = require("url");
const P = require("./pinned.js");

const APP = path.join(__dirname, ".."); // the source tree: the same files build.js copies into desktop/snug
let rules;
test.before(async () => { rules = await P.loadRules(APP); });

test("insecureOrigin: only a plain-http address that isn't this computer is marked secure", () => {
  assert.equal(P.insecureOrigin("http://192.168.1.20:47821/some/path"), "http://192.168.1.20:47821");
  assert.equal(P.insecureOrigin("http://snug.lan"), "http://snug.lan");
  for (const url of ["https://snug.example.com", "http://127.0.0.1:47821", "http://127.4.5.6", "http://localhost:3000", "http://[::1]:80", "not an address", null]) {
    assert.equal(P.insecureOrigin(url), null, String(url));
  }
});

test("verdict: the bundled client and the host's server must fit both ways (js/lib/proto.js)", () => {
  const client = { proto: 12, minServer: 12 };
  assert.deepEqual(P.verdict(client, null), { state: "old", server: null }, "no /api/version: 0.11 or earlier");
  assert.equal(P.verdict(client, { proto: 12, minClient: 12 }).state, "ok");
  assert.equal(P.verdict(client, { proto: 14, minClient: 12 }).state, "ok", "a newer server that still accepts this client");
  assert.equal(P.verdict(client, { proto: 13, minClient: 13 }).state, "app-old");
  assert.equal(P.verdict(client, { proto: 11, minClient: 11 }).state, "old");
  assert.equal(rules.client.proto >= 12 && rules.client.minServer >= 12, true, "versions come from the bundle");
  assert.equal(P.readVersion("<html>"), null);
  assert.equal(P.readVersion({ version: "0.12.0" }), null, "no proto: not a Snug version answer");
  assert.deepEqual(P.readVersion({ version: "0.12.0", proto: 12, minClient: 12, e2ee: 1 }), { version: "0.12.0", proto: 12, minClient: 12, e2ee: true });
});

test("bundled: the page's own files come from the app, with exactly the headers the server sends", async (t) => {
  const { startServer } = await import(pathToFileURL(path.join(APP, "server", "index.js")).toString());
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "snug-pinned-"));
  const srv = await startServer({ port: 0, dataDir, quiet: true });
  t.after(async () => { await srv.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const host = `http://127.0.0.1:${srv.port}`;
  const ctx = { origin: host, appDir: APP, rules };
  const get = (p, init) => P.bundled(new Request(host + p, init), ctx);
  const same = ["content-type", "content-security-policy", "content-security-policy-report-only", "cache-control", "x-frame-options", "cross-origin-resource-policy", "referrer-policy", "permissions-policy", "service-worker-allowed"];
  for (const p of ["/", "/join/abc123", "/m/c1/m2", "/settings", "/js/app.js", "/css/base.css", "/brand/favicon.svg", "/sw.js"]) {
    const mine = await get(p);
    const theirs = await fetch(host + p);
    assert.equal(mine.status, theirs.status, p);
    for (const h of same) assert.equal(mine.headers.get(h), theirs.headers.get(h), `${p} ${h}`);
    assert.equal(await mine.text(), await theirs.text(), `${p} body`);
  }
  // https adds upgrade-insecure-requests to the page's policy, as the server does behind https.
  const secure = await P.bundled(new Request("https://snug.example.com/"), { ...ctx, origin: "https://snug.example.com" });
  assert.match(secure.headers.get("content-security-policy"), /; upgrade-insecure-requests$/);
  // Not the app's files: these go to the host.
  assert.equal(await get("/api/me"), null);
  assert.equal(await get("/api/version"), null);
  assert.equal(await get("/", { method: "POST", body: "x" }), null);
  assert.equal(await P.bundled(new Request("http://elsewhere.example/js/app.js"), ctx), null, "another origin");
  // Never a file outside the public folders, however the path is written.
  for (const p of ["/../server/index.js", "/server/index.js", "/js/../server/db.js", "/%2e%2e/package.json", "/docs/missing.png"]) {
    const r = await get(p);
    assert.equal(r.status, 404, p);
  }
  const head = await get("/", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
});

// A stand-in for Electron's net.request: a writable request that reports what it was asked to do.
class FakeRequest extends Writable {
  constructor(opts) { super(); this.opts = opts; this.headers = {}; this.chunks = []; this.aborted = false; }
  setHeader(k, v) { if (k.toLowerCase() === "host") throw new Error("not allowed"); this.headers[k.toLowerCase()] = v; }
  _write(chunk, _enc, cb) { this.chunks.push(Buffer.from(chunk)); cb(); }
  abort() { this.aborted = true; }
}
function fakeNet(script) {
  const made = [];
  return {
    made,
    request(opts) {
      const r = new FakeRequest(opts);
      made.push(r);
      r.on("finish", () => setImmediate(() => script(r)));
      return r;
    },
  };
}
const respond = (status, headers, text = "") => {
  const res = require("stream").Readable.from(text ? [Buffer.from(text)] : []);
  return Object.assign(res, { statusCode: status, statusMessage: "", headers });
};

test("passThrough: the page's requests reach the host on the window's session, with Origin, and redirects come back to the page", async () => {
  const origin = "http://snug.lan:47821";
  const net = fakeNet((r) => {
    if (r.opts.url.endsWith("/api/go")) return r.emit("redirect", 302, "GET", "https://elsewhere.example/landed", {});
    if (r.opts.url.endsWith("/api/fail")) return r.emit("error", new Error("net::ERR_CONNECTION_REFUSED"));
    return r.emit("response", respond(200, { "content-type": "application/json", "set-cookie": ["a=1", "b=2"] }, JSON.stringify({ got: Buffer.concat(r.chunks).length })));
  });
  const ses = { id: "join session" };
  const post = await P.passThrough(net, ses, new Request(`${origin}/api/login`, { method: "POST", headers: { "content-type": "application/json", host: "x" }, body: "z".repeat(70000), duplex: "half" }), origin);
  const sent = net.made[0];
  assert.equal(sent.opts.session, ses, "the join partition's session: its cookies, not the default session's");
  assert.equal(sent.opts.redirect, "manual");
  assert.equal(sent.opts.bypassCustomProtocolHandlers, true, "never back into this handler");
  assert.equal(sent.headers.origin, origin, "the host's Origin check sees its own address");
  assert.equal(sent.headers["content-type"], "application/json");
  assert.deepEqual(await post.json(), { got: 70000 }, "the whole body arrived");
  assert.equal(post.headers.get("set-cookie"), "a=1, b=2");

  const get = await P.passThrough(net, ses, new Request(`${origin}/api/me`), origin);
  assert.equal(net.made[1].headers.origin, undefined, "a plain read carries no Origin of ours");
  assert.equal(get.status, 200);

  const go = await P.passThrough(net, ses, new Request(`${origin}/api/go`), origin);
  assert.equal(go.status, 302);
  assert.equal(go.headers.get("location"), "https://elsewhere.example/landed", "the page follows it (and will-redirect sees it)");
  assert.equal(net.made[2].aborted, true, "main never follows it itself");

  await assert.rejects(P.passThrough(net, ses, new Request(`${origin}/api/fail`), origin), /REFUSED/, "a network failure is a failure in the page too");
});

test("passThrough (pinned): the host's /api answers can't become a page, a script or a worker at the host's origin", async () => {
  const origin = "http://snug.lan:47821";
  const net = fakeNet((r) => r.emit("response", respond(200, {
    "content-type": "text/html", "content-security-policy": "default-src *", "x-content-type-options": "bogus",
    "service-worker-allowed": "/", "x-other": "kept",
  }, "<script>steal()</script>")));
  const ses = { id: "join session" };
  // A fetch from the bundled page (Sec-Fetch-Dest: empty) gets the body, with the host's say over sniffing and policy taken away.
  const ok = await P.passThrough(net, ses, new Request(`${origin}/api/files/f_1`, { headers: { "sec-fetch-dest": "empty" } }), origin);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
  assert.equal(ok.headers.get("content-security-policy"), "sandbox; default-src 'none'");
  assert.equal(ok.headers.get("service-worker-allowed"), null);
  assert.equal(ok.headers.get("x-other"), "kept");
  assert.equal(await ok.text(), "<script>steal()</script>", "the body itself is the page's business");
  const sent = net.made.length;
  // Loaded as a document, a frame, a script or a worker: refused here, never asked of the host.
  for (const dest of ["document", "iframe", "frame", "script", "worker", "sharedworker", "serviceworker"]) {
    const r = await P.passThrough(net, ses, new Request(`${origin}/api/files/f_1`, { headers: { "sec-fetch-dest": dest } }), origin);
    assert.equal(r.status, 403, dest);
    assert.equal(r.headers.get("content-security-policy"), "sandbox; default-src 'none'", dest);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff", dest);
  }
  assert.equal(net.made.length, sent, "none of them reached the host");
  // Images and media still load (the page shows pictures from /api/files).
  for (const dest of ["image", "video", "audio"]) assert.equal((await P.passThrough(net, ses, new Request(`${origin}/api/files/f_1`, { headers: { "sec-fetch-dest": dest } }), origin)).status, 200, dest);
  // A redirect answer carries the same headers.
  const red = await P.passThrough(fakeNet((r) => r.emit("redirect", 302, "GET", `${origin}/x`, {})), ses, new Request(`${origin}/api/go`), origin);
  assert.equal(red.headers.get("content-security-policy"), "sandbox; default-src 'none'");
});

test("pin: one handler for the join address's scheme, replaced when the address changes", async () => {
  const handled = new Map();
  const ses = { protocol: { handle: (s, fn) => handled.set(s, fn), unhandle: (s) => handled.delete(s), isProtocolHandled: (s) => handled.has(s) }, fetch: async () => new Response("other site") };
  P.pin(ses, "http://snug.lan:47821", { net: null, appDir: APP, rules });
  assert.deepEqual([...handled.keys()], ["http"]);
  const page = await handled.get("http")(new Request("http://snug.lan:47821/"));
  assert.match(await page.text(), /<html/i);
  assert.equal(await (await handled.get("http")(new Request("http://elsewhere.example/x.png"))).text(), "other site");
  P.pin(ses, "https://snug.example.com", { net: null, appDir: APP, rules });
  assert.deepEqual([...handled.keys()], ["https"]);
  P.unpin(ses);
  assert.equal(handled.size, 0);
});

test("fallbackText: says which versions don't fit, never silently", () => {
  const old = P.fallbackText({ state: "old", host: "http://snug.lan:47821", server: null, app: "0.12.0" });
  assert.equal(old.lead, "snug.lan:47821 runs an older Snug (0.11 or earlier); this app has 0.12.0. The app runs its own built-in code, which needs a newer server.");
  assert.match(P.fallbackText({ state: "old", host: "https://a.example", server: "0.11.1", app: "0.12.0" }).lead, /^a\.example runs Snug 0\.11\.1; this app has 0\.12\.0\./);
  assert.match(P.fallbackText({ state: "app-old", host: "https://a.example", server: "0.13.0", app: "0.12.0" }).title, /newer app/);
  assert.match(P.OWN_PAGE_NOTE("a.example"), /runs code from a\.example/);
});
