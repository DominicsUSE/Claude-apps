// The mandatory updater (updater.js) against a local HTTP stand-in for GitHub and the registry.
//   node --test updater.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const U = require("./updater.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "snug-updater-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// ---------- the stand-in ----------
const files = new Map(); // name -> Buffer
let release = null;
let list = null; // sec-desktop D11: the /releases list, when a test sets it
let notices = { min: null, ann: [] };
let noticesStatus = 200;
const hits = [];
const stub = http.createServer((req, res) => {
  hits.push(req.url);
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/list") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(list || [])); }
  if (u.pathname === "/latest") { res.writeHead(release ? 200 : 404, { "content-type": "application/json" }); return res.end(JSON.stringify(release || { message: "Not Found" })); }
  if (u.pathname === "/notices") { res.writeHead(noticesStatus, { "content-type": "application/json" }); return res.end(JSON.stringify(notices)); }
  if (u.pathname.startsWith("/dl/")) {
    const f = files.get(decodeURIComponent(u.pathname.slice(4)));
    if (!f) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": f.length });
    // In a few pieces, so progress has something to report.
    let i = 0;
    const step = Math.ceil(f.length / 8);
    const next = () => { if (i >= f.length) return res.end(); res.write(f.subarray(i, i + step)); i += step; setTimeout(next, 30); };
    return next();
  }
  if (u.pathname.startsWith("/hop/")) { res.writeHead(302, { location: `/dl/${u.pathname.slice(5)}` }); return res.end(); }
  if (u.pathname === "/evil") { res.writeHead(302, { location: "https://evil.example.com/Snug.exe" }); return res.end(); }
  if (u.pathname === "/cut") { res.writeHead(200, { "content-length": 1000 }); res.write(Buffer.alloc(100)); return setTimeout(() => res.destroy(), 20); }
  res.writeHead(404);
  return res.end();
});
let base;
test.before(async () => { await new Promise((r) => stub.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${stub.address().port}`; });
test.after(() => stub.close());

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const env = (extra = {}) => ({ SNUG_UPDATE_URL: `${base}/latest`, SNUG_NOTICES_URL: `${base}/notices`, ...extra });
function publish(version, { kind = "portable", sums = true, asset = true, bytes = crypto.randomBytes(300_000), sumsText = null, size = null, url = null } = {}) {
  const name = U.assetName(kind, version);
  const sumsName = kind === "dmg" ? "SHA256SUMS-mac.txt" : "SHA256SUMS-windows.txt";
  files.set(name, bytes);
  files.set(sumsName, Buffer.from(sumsText ?? `${sha(bytes)}  ${name}\n${"0".repeat(64)}  Other-file.exe\n`));
  release = {
    tag_name: `snug-v${version}`,
    assets: [
      ...(asset ? [{ name, size: size ?? bytes.length, browser_download_url: url ?? `${base}/dl/${name}` }] : []),
      ...(sums ? [{ name: sumsName, size: 10, browser_download_url: `${base}/dl/${sumsName}` }] : []),
      { name: "Snug-0.0.1-unrelated.zip", size: 3, browser_download_url: `${base}/dl/x` },
    ],
  };
  return { name, bytes };
}
const updater = (o = {}) => U.createUpdater({ current: "0.10.0", platform: "win32", tempDir: fs.mkdtempSync(path.join(tmp, "t-")), pid: 4321, ...o, env: env(o.env ?? { PORTABLE_EXECUTABLE_FILE: "D:\\Apps\\Snug-0.10.0-portable.exe" }) });

// ---------- pure parts ----------
test("semver compare and the decision matrix, minimum version included", () => {
  assert.equal(U.semverCmp("0.10.0", "0.9.9"), 1);
  assert.equal(U.semverCmp("snug-v1.2.3", "1.2.3"), 0);
  assert.equal(U.semverCmp("1.2.3", "1.10.0"), -1);
  assert.equal(U.semverCmp("junk", "1.0.0"), -1);
  const cases = [
    [{ current: "0.10.0", latest: "0.10.1", min: null }, true, "newer"],
    [{ current: "0.10.0", latest: "0.10.0", min: null }, false, "same"],
    [{ current: "0.10.1", latest: "0.10.0", min: null }, false, "older release"],
    [{ current: "0.10.0", latest: "0.11.0", min: "0.11.0" }, true, "below min, release reaches it"],
    [{ current: "0.10.0", latest: "0.10.0", min: "0.11.0" }, false, "below min, no release reaches it"],
    [{ current: "0.10.0", latest: "0.10.5", min: "0.11.0" }, true, "newer even though still below min"],
    [{ current: "0.11.0", latest: "0.11.0", min: "0.10.0" }, false, "above min, up to date"],
    [{ current: "0.10.0", latest: "nope", min: "0.11.0" }, false, "no parsable release"],
    [{ current: "0.10.0", latest: "0.10.0", min: "garbage" }, false, "bad min ignored"],
  ];
  for (const [arg, want, why] of cases) assert.equal(U.needsUpdate(arg), want, why);
});

test("assets: the kind's file and its platform checksum file, or nothing", () => {
  const rel = (names) => ({ tag_name: "snug-v1.2.3", assets: names.map((n) => ({ name: n, size: 10, browser_download_url: `https://github.com/x/${n}` })) });
  const all = ["Snug-Setup-1.2.3.exe", "Snug-1.2.3-portable.exe", "Snug-1.2.3-mac.dmg", "SHA256SUMS-windows.txt", "SHA256SUMS-mac.txt"];
  assert.equal(U.pickAssets(rel(all), "portable").asset.name, "Snug-1.2.3-portable.exe");
  assert.equal(U.pickAssets(rel(all), "installer").asset.name, "Snug-Setup-1.2.3.exe");
  assert.equal(U.pickAssets(rel(all), "installer").sums.name, "SHA256SUMS-windows.txt");
  assert.equal(U.pickAssets(rel(all), "dmg").sums.name, "SHA256SUMS-mac.txt");
  assert.equal(U.pickAssets(rel(all), "none"), null);
  assert.equal(U.pickAssets(rel(all.filter((n) => n !== "SHA256SUMS-mac.txt")), "dmg"), null, "no sums → nothing");
  assert.equal(U.pickAssets(rel(all.filter((n) => !n.endsWith("portable.exe"))), "portable"), null, "no asset → nothing");
  assert.equal(U.pickAssets(rel(["Snug-1.2.2-portable.exe", "SHA256SUMS-windows.txt"]), "portable"), null, "another version's file doesn't count");
  assert.equal(U.pickAssets({ tag_name: "snug-v1.2.3" }, "portable"), null);
  const sums = U.parseSums(`${"A".repeat(64)}  Snug-Setup-1.2.3.exe\r\n${"b".repeat(64)} *Snug-1.2.3-portable.exe\nnot a line\n${"c".repeat(63)}  short.exe\n`);
  assert.equal(sums.get("Snug-Setup-1.2.3.exe"), "a".repeat(64));
  assert.equal(sums.get("Snug-1.2.3-portable.exe"), "b".repeat(64));
  assert.equal(sums.size, 2);
});

test("kind: portable, installer, dmg, none; the override needs the test address too", () => {
  assert.equal(U.kindOf("win32", { PORTABLE_EXECUTABLE_FILE: "C:\\x\\Snug.exe" }), "portable");
  assert.equal(U.kindOf("win32", {}), "installer");
  assert.equal(U.kindOf("darwin", {}), "dmg");
  assert.equal(U.kindOf("linux", {}), "none");
  assert.equal(U.kindOf("linux", { SNUG_UPDATE_KIND: "portable" }), "none", "ignored without SNUG_UPDATE_URL");
  assert.equal(U.kindOf("linux", { SNUG_UPDATE_KIND: "portable", SNUG_UPDATE_URL: "http://127.0.0.1:1/x" }), "portable");
  assert.equal(U.kindOf("linux", { SNUG_UPDATE_KIND: "evil", SNUG_UPDATE_URL: "http://127.0.0.1:1/x" }), "none");
});

test("download hosts: GitHub over https only; the local stand-in only in test mode", () => {
  for (const ok of ["https://github.com/a", "https://api.github.com/a", "https://objects.githubusercontent.com/a", "https://release-assets.githubusercontent.com/a"]) assert.equal(U.allowedUrl(ok, false), true, ok);
  for (const bad of ["http://github.com/a", "https://github.com.evil.com/a", "https://evilgithubusercontent.com/a", "https://user:pw@github.com/a", "http://127.0.0.1:9/a", "file:///etc/passwd", "nonsense"]) assert.equal(U.allowedUrl(bad, false), false, bad);
  assert.equal(U.allowedUrl("http://127.0.0.1:9/a", true), true);
  assert.equal(U.allowedUrl("http://10.0.0.1/a", true), false);
});

// ---------- check ----------
test("check: required only with a newer release that has the file and its checksums", async () => {
  notices = { min: null, ann: [] };
  publish("0.10.1");
  const r = await updater().check();
  assert.equal(r.state, "required");
  assert.equal(r.version, "0.10.1");
  assert.equal(r.asset.name, "Snug-0.10.1-portable.exe");
  assert.equal((await updater({ env: { PORTABLE_EXECUTABLE_FILE: "C:\\Snug.exe" }, platform: "win32" }).check()).asset.name, "Snug-0.10.1-portable.exe");
  assert.equal((await updater({ env: {} }).check()).state, "none", "the installer kind needs the setup file");
  publish("0.10.1", { kind: "installer" });
  assert.equal((await updater({ env: {} }).check()).asset.name, "Snug-Setup-0.10.1.exe");
  publish("0.10.0");
  assert.equal((await updater().check()).state, "none", "same version");
  publish("0.10.1", { sums: false });
  assert.equal((await updater().check()).state, "none", "no checksum file yet");
  publish("0.10.1", { asset: false });
  assert.equal((await updater().check()).state, "none", "no file for this computer yet");
  publish("0.10.1");
  assert.equal((await updater({ platform: "linux", env: {} }).check()).state, "none", "linux never blocks");
  assert.equal((await updater({ env: { SNUG_UPDATE_KIND: "dmg" } }).check()).state, "none", "the mac has no dmg in this release");
  release = null;
  assert.equal((await updater().check()).state, "none", "no release at all");
  assert.equal((await U.createUpdater({ current: "0.10.0", platform: "win32", env: { SNUG_UPDATE_URL: "http://127.0.0.1:1/latest" } }).check()).state, "none", "offline");
});

test("check: the registry's minimum version; a failed notices fetch means no minimum", async () => {
  publish("0.10.0");
  notices = { min: "0.11.0", ann: [] };
  let r = await updater().check();
  assert.equal(r.state, "none", "below the minimum but no release reaches it: the app shows outdated, no block");
  assert.equal(r.min, "0.11.0");
  publish("0.11.0");
  r = await updater().check();
  assert.equal(r.state, "required");
  assert.equal(r.min, "0.11.0");
  noticesStatus = 500;
  r = await updater().check();
  assert.equal(r.state, "required");
  assert.equal(r.min, null);
  noticesStatus = 200;
  notices = { min: null, ann: [] };
  // Without the test address, SNUG_NOTICES_URL is ignored and the registry's /v1/notices is used.
  const u = U.createUpdater({ current: "0.10.0", platform: "linux", env: { SNUG_NOTICES_URL: `${base}/notices` }, registryUrl: base });
  assert.equal(u.kind, "none");
});

// ---------- download ----------
test("download: streams with progress, verifies size and sha256, then renames from .part", async () => {
  const { bytes } = publish("0.10.1", { bytes: crypto.randomBytes(1_200_000) });
  const u = updater();
  const info = await u.check();
  const seen = [];
  const file = await u.download(info, (p) => seen.push(p));
  assert.equal(path.basename(file), "Snug-0.10.1-portable.exe");
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(fs.existsSync(`${file}.part`), false);
  assert.ok(seen.length >= 2, "progress reported");
  assert.ok(seen.every((p) => p.total === bytes.length));
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i].received >= seen[i - 1].received, "never goes backwards");
  assert.deepEqual(seen.at(-1), { received: bytes.length, total: bytes.length, verifying: true });
  // Following a redirect on an allowed host works too.
  publish("0.10.2", { url: `${base}/hop/${U.assetName("portable", "0.10.2")}` });
  const i2 = await u.check();
  assert.ok(fs.existsSync(await u.download(i2)));
});

test("download: a wrong checksum or a wrong size is refused and the part deleted", async () => {
  const u = updater();
  publish("0.10.3", { sumsText: `${"0".repeat(64)}  ${U.assetName("portable", "0.10.3")}\n` });
  let info = await u.check();
  await assert.rejects(u.download(info), (e) => e.code === "checksum");
  const leftovers = () => fs.readdirSync(tmp, { recursive: true }).filter((f) => String(f).includes("0.10.3") && /\.exe(\.part)?$/.test(String(f)));
  assert.deepEqual(leftovers(), [], "neither the part nor a final file stays");

  publish("0.10.4", { sumsText: `${"0".repeat(64)}  Some-other-file.exe\n` });
  info = await u.check();
  await assert.rejects(u.download(info), (e) => e.code === "checksum", "no line for this file");

  const big = crypto.randomBytes(200_000);
  publish("0.10.5", { bytes: big, size: big.length + 10 });
  info = await u.check();
  await assert.rejects(u.download(info), (e) => e.code === "size", "shorter than the release says");
  publish("0.10.6", { bytes: big, size: big.length - 10 });
  info = await u.check();
  await assert.rejects(u.download(info), (e) => e.code === "size", "longer than the release says: aborted");
  const left = fs.readdirSync(tmp, { recursive: true }).filter((f) => /0\.10\.[56].*\.exe/.test(String(f)));
  assert.deepEqual(left, [], "no part left for the size failures");

  publish("0.10.7", { url: `${base}/cut` });
  info = await u.check();
  info.asset.size = 1000;
  await assert.rejects(u.download(info), (e) => e.code === "network" || e.code === "size", "a cut connection");
});

test("download: a redirect to a host that isn't GitHub is refused; so is the stand-in outside test mode", async () => {
  const u = updater();
  publish("0.10.8", { url: `${base}/evil` });
  const info = await u.check();
  await assert.rejects(u.download(info), (e) => e.code === "network" && /evil\.example\.com/.test(e.message));
  assert.ok(!hits.some((h) => h.includes("Snug.exe")), "never fetched from the other host");
  publish("0.10.9", { url: "http://example.com/Snug-0.10.9-portable.exe" });
  await assert.rejects(u.download(await u.check()), (e) => e.code === "network");
  // Outside test mode (no SNUG_UPDATE_URL) the same local addresses are refused.
  const prod = U.createUpdater({ current: "0.10.0", platform: "win32", tempDir: fs.mkdtempSync(path.join(tmp, "p-")), env: {} });
  publish("0.10.10");
  await assert.rejects(prod.download(U.pickAssets(release, "portable")), (e) => e.code === "network" && /Refused/.test(e.message));
});

// ---------- swap scripts and install ----------
const at = (s, needle) => { const i = s.indexOf(needle); assert.ok(i >= 0, `script has ${needle}`); return i; };
test("swap scripts never delete the old version before the new one is copied", () => {
  // Portable, versioned name: the new exe gets its own name; the old one goes only after it is in place.
  let s = U.swapScript("portable", { pid: 77, newFile: "C:\\Temp\\snug-update-0.11.0\\Snug-0.11.0-portable.exe", target: "D:\\Apps\\Snug-0.10.0-portable.exe", final: "D:\\Apps\\Snug-0.11.0-portable.exe" });
  const copy = at(s, 'copy /Y "C:\\Temp\\snug-update-0.11.0\\Snug-0.11.0-portable.exe" "D:\\Apps\\Snug-0.11.0-portable.exe.tmp"');
  const move = at(s, 'move /Y "D:\\Apps\\Snug-0.11.0-portable.exe.tmp" "D:\\Apps\\Snug-0.11.0-portable.exe"');
  const del = at(s, 'del /F /Q "D:\\Apps\\Snug-0.10.0-portable.exe"');
  assert.ok(at(s, 'PID eq 77') < copy && copy < move && move < del, "wait, copy, move, then delete the old");
  assert.ok(s.lastIndexOf('start "" "D:\\Apps\\Snug-0.10.0-portable.exe"') > del, "a failed copy starts the old one");
  assert.match(s, /\r\n/, "cmd line endings");
  // Portable, renamed by the person: the same file is replaced in place, never deleted.
  s = U.swapScript("portable", { pid: 77, newFile: "C:\\T\\n.exe", target: "D:\\My Snug.exe", final: "D:\\My Snug.exe" });
  assert.ok(!s.includes('del /F /Q "D:\\My Snug.exe"'), "the target itself is never deleted");
  assert.ok(at(s, 'copy /Y "C:\\T\\n.exe" "D:\\My Snug.exe.tmp"') < at(s, 'move /Y "D:\\My Snug.exe.tmp" "D:\\My Snug.exe"'));
  assert.ok(at(s, 'if exist "D:\\My Snug.exe" start "" "D:\\My Snug.exe"') > 0, "a failed swap starts the old one");
  // % in a path can't expand.
  assert.match(U.swapScript("portable", { pid: 1, newFile: "C:\\100%\\n.exe", target: "C:\\a.exe", final: "C:\\a.exe" }), /C:\\100%%\\n\.exe/);
  // Mac: the old app is moved aside (not deleted) and removed only after ditto put the new one in place.
  s = U.swapScript("dmg", { pid: 88, curApp: "/Applications/Snug.app", newApp: "/tmp/u/Snug.app", oldApp: "/tmp/u/old-1.app" });
  const mv = at(s, 'mv "$CUR" "$OLD"');
  const ditto = at(s, 'if ditto "$NEW" "$CUR"');
  const rm = at(s, 'rm -rf "$OLD" "$NEW"');
  assert.ok(at(s, 'kill -0 "$PID"') < mv && mv < ditto && ditto < rm);
  assert.ok(at(s, 'mv "$OLD" "$CUR"') > ditto, "a failed copy puts the old app back");
  assert.match(s, /^CUR='\/Applications\/Snug\.app'$/m);
  assert.match(U.swapScript("dmg", { pid: 1, curApp: "/A/It's.app", newApp: "/n", oldApp: "/o" }), /CUR='\/A\/It'\\''s\.app'/);
});

test("install (dry run): portable writes the swap script with the new name; installer runs silently", async () => {
  delete globalThis.snugUpdateInstalled;
  publish("0.11.0");
  const quits = [];
  let u = updater({ env: { SNUG_UPDATE_DRY_INSTALL: "1", PORTABLE_EXECUTABLE_FILE: "D:\\Apps\\Snug-0.10.0-portable.exe" }, quit: () => quits.push(1) });
  let info = await u.check();
  let file = await u.download(info);
  let r = await u.install(file, info);
  assert.deepEqual(r, { ok: true, dry: true });
  assert.equal(globalThis.snugUpdateInstalled.kind, "portable");
  assert.equal(globalThis.snugUpdateInstalled.file, file);
  assert.equal(globalThis.snugUpdateInstalled.final, "D:\\Apps\\Snug-0.11.0-portable.exe");
  assert.match(globalThis.snugUpdateInstalled.script, /PID eq 4321/);
  assert.equal(quits.length, 0, "a dry run doesn't quit");

  publish("0.11.0", { kind: "installer" });
  u = updater({ env: { SNUG_UPDATE_DRY_INSTALL: "1" } });
  info = await u.check();
  file = await u.download(info);
  await u.install(file, info);
  assert.equal(globalThis.snugUpdateInstalled.kind, "installer");
  assert.match(globalThis.snugUpdateInstalled.script, /Snug-Setup-0\.11\.0\.exe \/S --updated --force-run$/);
});

test("install (for real, spawn stubbed): portable spawns cmd detached and quits; installer spawns the setup", async () => {
  publish("0.11.1");
  const spawned = [];
  const quits = [];
  const spawn = (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return { on() {}, unref() {} }; };
  let u = updater({ env: { PORTABLE_EXECUTABLE_FILE: "D:\\Snug-0.10.0-portable.exe" }, spawn, quit: () => quits.push(1) });
  let info = await u.check();
  let file = await u.download(info);
  assert.deepEqual(await u.install(file, info), { ok: true });
  assert.match(spawned[0].cmd, /cmd/i);
  assert.equal(spawned[0].args.at(-1).endsWith("snug-swap.cmd"), true);
  // sec-integrate: the script lives in a fresh private folder, never at a fixed name in the temp folder.
  assert.match(path.basename(path.dirname(spawned[0].args.at(-1))), /^snug-swap-[A-Za-z0-9]{6}$/);
  assert.equal(spawned[0].opts.detached, true);
  assert.ok(fs.readFileSync(spawned[0].args.at(-1), "utf8").includes("Snug-0.11.1-portable.exe"));
  assert.equal(quits.length, 1);
  publish("0.11.1", { kind: "installer" });
  u = updater({ env: {}, spawn, quit: () => quits.push(1) });
  info = await u.check();
  file = await u.download(info);
  await u.install(file, info);
  assert.deepEqual(spawned[1].args, ["/S", "--updated", "--force-run"]);
  assert.equal(spawned[1].cmd, file);
  assert.equal(quits.length, 2);
});

test("install (mac, tools stubbed): hdiutil, ditto, detach, version check, then the helper; read-only or translocated → manual", async () => {
  publish("0.11.2", { kind: "dmg" });
  const apps = path.join(tmp, "Applications");
  fs.mkdirSync(path.join(apps, "Snug.app", "Contents", "MacOS"), { recursive: true });
  const calls = [];
  let plist = "0.11.2";
  const execFile = (cmd, args, _o, cb) => { calls.push([cmd, ...args]); setImmediate(() => cb(null, cmd === "plutil" ? `${plist}\n` : "")); };
  const spawned = [];
  const spawn = (cmd, args) => { spawned.push([cmd, ...args]); return { on() {}, unref() {} }; };
  const mk = (exePath) => updater({ platform: "darwin", env: {}, exePath, execFile, spawn, quit: () => {} });
  let u = mk(path.join(apps, "Snug.app", "Contents", "MacOS", "Snug"));
  assert.equal(u.kind, "dmg");
  let info = await u.check();
  let file = await u.download(info);
  assert.deepEqual(await u.install(file, info), { ok: true });
  assert.deepEqual(calls.map((c) => c.slice(0, 2)), [["hdiutil", "attach"], ["ditto", path.join(path.dirname(file), "mnt", "Snug.app")], ["hdiutil", "detach"], ["plutil", "-extract"]]);
  assert.ok(calls[0].includes("-readonly") && calls[0].includes("-nobrowse"));
  assert.deepEqual(spawned[0].slice(0, 1), ["/bin/sh"]);
  const script = fs.readFileSync(spawned[0][1], "utf8");
  assert.match(script, new RegExp(`CUR='${path.join(apps, "Snug.app").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`));

  // The copy in the dmg says another version: refused before anything is swapped.
  calls.length = 0; spawned.length = 0; plist = "0.9.0";
  u = mk(path.join(apps, "Snug.app", "Contents", "MacOS", "Snug"));
  info = await u.check();
  file = await u.download(info);
  await assert.rejects(u.install(file, info), (e) => e.code === "checksum");
  assert.equal(spawned.length, 0);

  // Running from the dmg itself or a translocated copy: open the dmg and ask for a drag.
  for (const exe of ["/Volumes/Snug 0.10.0/Snug.app/Contents/MacOS/Snug", "/private/var/folders/x/AppTranslocation/ABC/d/Snug.app/Contents/MacOS/Snug"]) {
    spawned.length = 0;
    u = mk(exe);
    info = await u.check();
    file = await u.download(info);
    const r = await u.install(file, info);
    assert.equal(r.manual, true);
    assert.match(r.message, /Drag Snug to Applications/);
    assert.deepEqual(spawned[0], ["open", file]);
  }
});

test("0.10 review fixes: UTF-8 batch, failure marker, read-only folder, inner .app bundle, bundle id check, cleanup", async () => {
  // Portable: the script switches cmd.exe to UTF-8 before any path, and leaves a marker when it falls back.
  const s = U.swapScript("portable", { pid: 7, newFile: "C:\\Users\\José\\AppData\\Local\\Temp\\n.exe", target: "C:\\Users\\José\\Snug.exe", final: "C:\\Users\\José\\Snug.exe", marker: "C:\\Users\\José\\AppData\\Local\\Temp\\snug-update-failed.txt" });
  assert.ok(at(s, "chcp 65001 >nul") < at(s, "José"), "UTF-8 before the first path");
  assert.ok(at(s, ":old") < at(s, 'echo failed>"C:\\Users\\José\\AppData\\Local\\Temp\\snug-update-failed.txt"'));
  assert.ok(Buffer.from(s, "utf8").subarray(0, 3).toString("hex") !== "efbbbf", "no BOM");
  // A folder Snug can't write to: no quitting, a plain message instead.
  publish("0.11.4");
  const quits = [];
  const spawn = () => ({ on() {}, unref() {} });
  let u = updater({ env: { PORTABLE_EXECUTABLE_FILE: "C:\\Program Files\\Snug\\Snug.exe" }, spawn, quit: () => quits.push(1), canWrite: () => false });
  let info = await u.check();
  let file = await u.download(info);
  const r = await u.install(file, info);
  assert.equal(r.manual, true);
  assert.match(r.message, /can’t replace itself in this folder/);
  assert.equal(quits.length, 0);
  // The marker is read once.
  const tdir = fs.mkdtempSync(path.join(tmp, "m-"));
  u = updater({ tempDir: tdir });
  assert.equal(u.takeFailure(), false);
  fs.writeFileSync(path.join(tdir, "snug-update-failed.txt"), "failed");
  assert.equal(u.takeFailure(), true);
  assert.equal(u.takeFailure(), false);
  // Cleanup: downloads of this version or older and leftover scripts go; a newer one stays.
  for (const d of ["snug-update-0.9.0", "snug-update-0.10.0", "snug-update-0.11.0"]) fs.mkdirSync(path.join(tdir, d));
  fs.writeFileSync(path.join(tdir, "snug-update-0.9.0", "Snug-Setup-0.9.0.exe"), "x");
  fs.writeFileSync(path.join(tdir, "snug-swap.cmd"), "x");
  fs.mkdirSync(path.join(tdir, "snug-swap-Ab12Cd")); // sec-integrate: a leftover private script folder
  fs.writeFileSync(path.join(tdir, "other.txt"), "x");
  u.cleanup();
  assert.deepEqual(fs.readdirSync(tdir).sort(), ["other.txt", "snug-update-0.11.0"]);
  // Mac: Snug inside another folder named *.app: only Snug.app is swapped, never the outer folder.
  publish("0.11.5", { kind: "dmg" });
  const outer = path.join(tmp, "Tools.app");
  fs.mkdirSync(path.join(outer, "Snug.app", "Contents", "MacOS"), { recursive: true });
  const spawned = [];
  u = updater({ platform: "darwin", env: {}, exePath: path.join(outer, "Snug.app", "Contents", "MacOS", "Snug"),
    execFile: (cmd, args, _o, cb) => setImmediate(() => cb(null, cmd === "plutil" ? "0.11.5\n" : "")), spawn: (c, a) => { spawned.push([c, ...a]); return { on() {}, unref() {} }; }, quit: () => {} });
  info = await u.check();
  file = await u.download(info);
  assert.deepEqual(await u.install(file, info), { ok: true });
  const sh = fs.readFileSync(spawned[0][1], "utf8");
  assert.match(sh, new RegExp(`^CUR='${path.join(outer, "Snug.app").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'$`, "m"));
  assert.ok(at(sh, 'if [ -z "$ID" ] || [ "$(BID "$CUR")" != "$ID" ]') < at(sh, 'mv "$CUR" "$OLD"'), "bundle id checked before anything moves");
});

// ---------- sec-desktop D3: signed checksums ----------
// A test key pair; the updater gets its public key the way UPDATE_PUBKEYS would hold it (raw 32 bytes, base64).
const signer = crypto.generateKeyPairSync("ed25519");
const pubB64 = signer.publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("base64");
const signSums = (text, key = signer.privateKey) => crypto.sign(null, Buffer.from(text), key).toString("base64");
// Publishes like publish(), plus SHA256SUMS-windows.txt.sig with `sig` as its content (none when null).
function publishSigned(version, { sig, sumsText, bytes = crypto.randomBytes(200_000) } = {}) {
  const name = U.assetName("portable", version);
  const text = sumsText ?? `${sha(bytes)}  ${name}\n`;
  const r = publish(version, { bytes, sumsText: text });
  if (sig !== null) {
    files.set("SHA256SUMS-windows.txt.sig", Buffer.from(sig === undefined ? signSums(text) : sig));
    release.assets.push({ name: "SHA256SUMS-windows.txt.sig", size: 88, browser_download_url: `${base}/dl/SHA256SUMS-windows.txt.sig` });
  }
  return { ...r, text };
}
const signed = (o = {}) => updater({ ...o, pubkeys: [pubB64] });

test("D3: with a pinned key, a validly signed release downloads", async () => {
  const { bytes } = publishSigned("0.11.1");
  const u = signed();
  const info = await u.check();
  assert.equal(info.state, "required");
  assert.equal(info.sig.name, "SHA256SUMS-windows.txt.sig");
  assert.deepEqual(fs.readFileSync(await u.download(info)), bytes);
});

test("D3: someone who can write the release but has no key: new asset + matching checksums, old signature → refused", async () => {
  // The real, signed checksum file for what Snug built...
  const real = `${sha(crypto.randomBytes(10))}  ${U.assetName("portable", "0.11.2")}\n`;
  const realSig = signSums(real);
  // ...and the attacker's asset with a checksum file that matches it, next to that signature.
  publishSigned("0.11.2", { sig: realSig });
  const u = signed();
  const info = U.pickAssets(release, "portable");
  await assert.rejects(u.download(info), (e) => e.code === "checksum");
  assert.equal((await u.check()).state, "none", "and it never blocks the app with an update it can't install");
  // Signed with another key: the same.
  publishSigned("0.11.3", { sig: undefined, sumsText: undefined });
  const other = crypto.generateKeyPairSync("ed25519");
  const text = files.get("SHA256SUMS-windows.txt").toString();
  files.set("SHA256SUMS-windows.txt.sig", Buffer.from(signSums(text, other.privateKey)));
  await assert.rejects(u.download(U.pickAssets(release, "portable")), (e) => e.code === "checksum");
  // Garbage in the signature file: the same.
  files.set("SHA256SUMS-windows.txt.sig", Buffer.from("not a signature"));
  await assert.rejects(u.download(U.pickAssets(release, "portable")), (e) => e.code === "checksum");
});

test("D3: with a pinned key, a release with no signature file is refused", async () => {
  publishSigned("0.11.4", { sig: null });
  const u = signed();
  await assert.rejects(u.download(U.pickAssets(release, "portable")), (e) => e.code === "checksum");
  assert.equal((await u.check()).state, "none");
});

test("D3: with no key pinned (today's builds), the unsigned flow still works; the shipped list is well formed", async () => {
  const { bytes } = publishSigned("0.11.5", { sig: null });
  const u = updater();
  const info = await u.check();
  assert.equal(info.state, "required");
  assert.deepEqual(fs.readFileSync(await u.download(info)), bytes);
  assert.ok(Array.isArray(U.UPDATE_PUBKEYS));
  for (const k of U.UPDATE_PUBKEYS) assert.equal(Buffer.from(k, "base64").length, 32, "each pinned key is 32 raw bytes, base64");
  assert.equal(U.verifySums(Buffer.from("x"), signSums("x"), [pubB64]), true);
  assert.equal(U.verifySums(Buffer.from("y"), signSums("x"), [pubB64]), false);
  assert.equal(U.verifySums(Buffer.from("x"), signSums("x"), ["bm90IGEga2V5"]), false, "a malformed key never verifies");
});

// ---------- sec-desktop D11: only snug-v releases, from the list ----------
test("D11: the updater reads the releases list and takes the newest snug-v release, never another app's", async () => {
  assert.match(U.RELEASES_LIST, /\/releases\?per_page=\d+$/, "not /releases/latest");
  publish("0.10.2");
  const snug = release;
  const foreign = (tag, extra = {}) => ({ ...snug, tag_name: tag, assets: snug.assets.map((a) => ({ ...a, name: a.name.replace("0.10.2", tag.replace(/^\D+/, "")) })), ...extra });
  list = [
    { tag_name: "siteless-v3.0.0", assets: [{ name: "Siteless-Setup-3.0.0.exe", size: 5, browser_download_url: `${base}/dl/x` }] },
    foreign("other-v9.9.9"),        // Snug-named files under another tag
    foreign("snug-v9.9.8", { prerelease: true }),
    foreign("snug-v9.9.7", { draft: true }),
    foreign("snug-v9.9.6-rc1"),
    snug,
  ];
  const u = updater({ env: { PORTABLE_EXECUTABLE_FILE: "D:\\Apps\\Snug-0.10.0-portable.exe", SNUG_UPDATE_URL: `${base}/list` } });
  const r = await u.check();
  assert.equal(r.state, "required");
  assert.equal(r.version, "0.10.2");
  assert.equal(U.pickAssets({ ...snug, tag_name: "evil-v0.10.2" }, "portable"), null, "a semver anywhere in the tag isn't enough");
  assert.equal(U.pickAssets({ ...snug, tag_name: undefined, name: "snug-v0.10.2" }, "portable"), null, "the tag, not the title");
  list = null;
});

// ---------- sec-desktop D9: an installed app ignores the test variables ----------
test("D9: without --dev-update the updater sees no SNUG_UPDATE_* variables", async () => {
  const planted = { SNUG_UPDATE_URL: `${base}/latest`, SNUG_UPDATE_CHECK: "0", SNUG_UPDATE_KIND: "portable", SNUG_UPDATE_DRY_INSTALL: "1", SNUG_NOTICES_URL: `${base}/notices`, PORTABLE_EXECUTABLE_FILE: "C:\\Snug.exe", ComSpec: "C:\\Windows\\system32\\cmd.exe" };
  assert.deepEqual(U.updaterEnvFor(planted, false), { PORTABLE_EXECUTABLE_FILE: "C:\\Snug.exe", ComSpec: "C:\\Windows\\system32\\cmd.exe" });
  assert.equal(U.updaterEnvFor(planted, true), planted, "running from source or with --dev-update: as given");
  const u = U.createUpdater({ current: "0.10.0", platform: "win32", env: U.updaterEnvFor(planted, false) });
  assert.equal(u.testMode, false, "no test mode: GitHub's address, GitHub hosts only");
  publish("0.10.1");
  const before = hits.length;
  await u.check().catch(() => {});
  assert.ok(!hits.slice(before).some((h) => h === "/latest"), "the planted address is never asked");
});
