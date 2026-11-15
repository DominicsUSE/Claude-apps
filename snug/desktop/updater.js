// Snug's mandatory updater (desktop app). No Electron import: main.js passes in
// what it needs, so this file unit-tests under plain Node (updater.test.js).
//
//   check()     the newest snug-v<x.y.z> GitHub release (+ the registry's minimum version) → required or none
//   download()  the platform's asset, size and sha256 checked against the release's
//               SHA256SUMS-<platform>.txt (and, once a key is pinned below, that file's Ed25519
//               signature); only then is it renamed from .part to its name
//   install()   portable: a helper .cmd swaps the exe once this process is gone
//               installer: the new NSIS installer, silent, replaces the install in place
//               dmg: hdiutil + ditto into a temp copy, then a helper .sh swaps the .app
// The old version is never touched before the new one is verified on disk.
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");

// sec-desktop D11: the list, not /releases/latest: other apps publish releases in this repository too, and
// whichever was made last would be "latest". Only snug-v<x.y.z> tags count (check() below).
const RELEASES_LIST = "https://api.github.com/repos/DominicsUSE/Claude-apps/releases?per_page=30";
const SNUG_TAG = /^snug-v(\d+\.\d+\.\d+)$/;
// sec-desktop D3: the Ed25519 public keys (base64 of the raw 32 bytes) whose signature on
// SHA256SUMS-<platform>.txt an update must carry. Empty: checksums only, as before. Once a key is here,
// an update without a valid signature by one of them is never offered or installed, whoever could write
// the GitHub release. To make a key: `node desktop/sign-sums.js --new-key snug-update-key.pem` (see there).
// To rotate: add the new key here one release before the signing secret changes, then drop the old one.
const UPDATE_PUBKEYS = [];
const MAX_SIG = 1024;
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");
const MAX_JSON = 1_000_000;
const MAX_NOTICES = 64 * 1024;
const MAX_SUMS = 64 * 1024;
const MAX_ASSET = 400 * 1024 * 1024;
const GH_HOSTS = new Set(["github.com", "api.github.com", "objects.githubusercontent.com"]);
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

// ---------- pure helpers ----------
function semver(s) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(s || ""));
  return m ? m.slice(1, 4).map(Number) : null;
}
// -1, 0 or 1; anything unparsable sorts lowest.
function semverCmp(a, b) {
  const x = semver(a), y = semver(b);
  if (!x || !y) return !x && !y ? 0 : x ? 1 : -1;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}
function needsUpdate({ current, latest, min }) {
  if (!semver(current) || !semver(latest)) return false;
  if (semverCmp(latest, current) > 0) return true;
  return !!semver(min) && semverCmp(min, current) > 0 && semverCmp(latest, min) >= 0;
}
const SUMS = { portable: "SHA256SUMS-windows.txt", installer: "SHA256SUMS-windows.txt", dmg: "SHA256SUMS-mac.txt" };
const SIG = (sumsName) => `${sumsName}.sig`;
const assetName = (kind, v) => ({ portable: `Snug-${v}-portable.exe`, installer: `Snug-Setup-${v}.exe`, dmg: `Snug-${v}-mac.dmg` }[kind] || null);
// The kind's asset, its platform's checksum file (and that file's signature, when there is one) in a
// release, or null. Only a published snug-v<x.y.z> release counts (sec-desktop D11): not a draft, not a
// prerelease, not another app's tag.
function pickAssets(release, kind) {
  const m = SNUG_TAG.exec(typeof release?.tag_name === "string" ? release.tag_name : "");
  if (!m || release.draft || release.prerelease || !SUMS[kind] || !Array.isArray(release.assets)) return null;
  const version = m[1];
  const find = (n) => release.assets.find((a) => a && a.name === n && typeof a.browser_download_url === "string");
  const a = find(assetName(kind, version));
  const s = find(SUMS[kind]);
  const g = find(SIG(SUMS[kind]));
  if (!a || !s || !Number.isSafeInteger(a.size) || a.size <= 0 || a.size > MAX_ASSET) return null;
  return {
    version, asset: { name: a.name, size: a.size, url: a.browser_download_url }, sums: { name: s.name, url: s.browser_download_url },
    ...(g ? { sig: { name: g.name, url: g.browser_download_url } } : {}),
  };
}
// The newest release in a GitHub reply (a list, or one release) that has this computer's files.
function pickRelease(reply, kind) {
  let best = null;
  for (const r of Array.isArray(reply) ? reply : [reply]) {
    const p = pickAssets(r, kind);
    if (p && (!best || semverCmp(p.version, best.version) > 0)) best = p;
  }
  return best;
}
// Is `sig` (base64 text) a valid Ed25519 signature of these exact bytes by one of `keys`?
function verifySums(bytes, sig, keys) {
  const raw = Buffer.from(String(sig || "").trim(), "base64");
  if (raw.length !== 64) return false;
  for (const k of keys || []) {
    try {
      const pub = Buffer.from(String(k), "base64");
      if (pub.length !== 32) continue;
      const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI, pub]), format: "der", type: "spki" });
      if (crypto.verify(null, bytes, key, raw)) return true;
    } catch { /* a malformed key never verifies */ }
  }
  return false;
}
// sec-desktop D9: what an installed app takes from its environment. Without --dev-update (or running from
// source) only the two variables Windows itself sets for it: none of the SNUG_UPDATE_* test switches.
function updaterEnvFor(env, dev) {
  if (dev) return env;
  const out = {};
  for (const k of ["PORTABLE_EXECUTABLE_FILE", "ComSpec"]) if (typeof env[k] === "string") out[k] = env[k];
  return out;
}
// `sha256sum` output: "<64 hex>  <name>" (or " *<name>" in binary mode). Map name → lowercase hex.
function parseSums(text) {
  const out = new Map();
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim());
    if (m) out.set(m[2].trim(), m[1].toLowerCase());
  }
  return out;
}
function kindOf(platform, env) {
  if (env.SNUG_UPDATE_KIND && env.SNUG_UPDATE_URL && ["portable", "installer", "dmg", "none"].includes(env.SNUG_UPDATE_KIND)) return env.SNUG_UPDATE_KIND;
  if (platform === "win32") return env.PORTABLE_EXECUTABLE_FILE ? "portable" : "installer";
  if (platform === "darwin") return "dmg";
  return "none";
}
function allowedUrl(raw, testMode) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.username || u.password) return false;
  if (u.protocol === "https:" && (GH_HOSTS.has(u.hostname) || u.hostname.endsWith(".githubusercontent.com"))) return true;
  return !!testMode && u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname);
}

// cmd.exe: inside double quotes only % (and the quote itself, which Windows paths can't hold) matters.
const cq = (p) => `"${String(p).replace(/%/g, "%%")}"`;
const sq = (p) => `'${String(p).replace(/'/g, "'\\''")}'`;
// The helper scripts. Each copies (or moves) the new version into place before anything of the old one goes.
function swapScript(kind, o) {
  if (kind === "portable") {
    // o: { pid, newFile, target, final }
    const pid = Number(o.pid) | 0;
    const same = path.win32.normalize(o.final).toLowerCase() === path.win32.normalize(o.target).toLowerCase();
    const tmp = `${o.final}.tmp`;
    const sleep = "ping -n 2 127.0.0.1 >nul";
    const lines = [
      "@echo off",
      // cmd.exe reads a batch file in the OEM code page: from here on it reads the rest as UTF-8, so paths
      // with letters like é or ü (user names under %TEMP%) aren't mangled (review 0.10 #3).
      "chcp 65001 >nul",
      "setlocal",
      "rem Snug update: waits for the old Snug to close, then swaps in the new exe.",
      "set N=0",
      ":wait",
      `tasklist /FI "PID eq ${pid}" /NH 2>nul | find " ${pid} " >nul`,
      "if errorlevel 1 goto copy",
      "set /a N+=1",
      "if %N% geq 120 goto copy",
      sleep,
      "goto wait",
      ":copy",
      `copy /Y ${cq(o.newFile)} ${cq(tmp)} >nul`,
      "if errorlevel 1 goto old",
      "set N=0",
      ":move",
      `move /Y ${cq(tmp)} ${cq(o.final)} >nul`,
      "if not errorlevel 1 goto placed",
      "set /a N+=1",
      "if %N% geq 30 goto failed",
      sleep,
      "goto move",
      ":placed",
    ];
    if (!same) {
      // The new exe has its own name: the old one goes only now, and a locked one is retried, then left.
      lines.push("set N=0", ":del", `del /F /Q ${cq(o.target)} >nul 2>&1`, `if not exist ${cq(o.target)} goto start`,
        "set /a N+=1", "if %N% geq 30 goto start", sleep, "goto del");
    }
    lines.push(
      ":start",
      `del /F /Q ${cq(o.newFile)} >nul 2>&1`,
      `start "" ${cq(o.final)}`,
      "goto end",
      ":failed",
      `del /F /Q ${cq(tmp)} >nul 2>&1`,
      ":old",
      ...(o.marker ? [`echo failed>${cq(o.marker)}`] : []), // the next start says the update couldn't be installed
      `if exist ${cq(o.target)} start "" ${cq(o.target)}`,
      ":end",
      '(goto) 2>nul & del "%~f0"',
    );
    return `${lines.join("\r\n")}\r\n`;
  }
  if (kind === "dmg") {
    // o: { pid, curApp, newApp, oldApp }
    return [
      "#!/bin/sh",
      "# Snug update: waits for the old Snug to quit, then swaps in the new Snug.app.",
      `PID=${Number(o.pid) | 0}`,
      `CUR=${sq(o.curApp)}`,
      `NEW=${sq(o.newApp)}`,
      `OLD=${sq(o.oldApp)}`,
      "i=0",
      'while kill -0 "$PID" 2>/dev/null; do i=$((i+1)); [ "$i" -ge 120 ] && break; sleep 1; done',
      // Only ever replace Snug itself: the bundle being replaced must have the new one's bundle id.
      'BID() { /usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$1/Contents/Info.plist" 2>/dev/null; }',
      'ID=$(BID "$NEW")',
      'if [ -z "$ID" ] || [ "$(BID "$CUR")" != "$ID" ]; then rm -f "$0"; exit 1; fi',
      'if ! mv "$CUR" "$OLD"; then open "$CUR"; exit 1; fi',
      'if ditto "$NEW" "$CUR"; then',
      '  rm -rf "$OLD" "$NEW"',
      "else",
      '  rm -rf "$CUR"; mv "$OLD" "$CUR"',
      "fi",
      'open "$CUR"',
      'rm -f "$0"',
      "",
    ].join("\n");
  }
  throw new Error(`no swap script for ${kind}`);
}

const err = (code, message) => Object.assign(new Error(message), { code });

// ---------- the updater ----------
function createUpdater(o) {
  const env = o.env || process.env;
  const platform = o.platform || process.platform;
  const testMode = !!env.SNUG_UPDATE_URL;
  const kind = kindOf(platform, env);
  const tempDir = o.tempDir || require("os").tmpdir();
  const log = o.log || (() => {});
  const updateUrl = env.SNUG_UPDATE_URL || RELEASES_LIST;
  const keys = Array.isArray(o.pubkeys) ? o.pubkeys : UPDATE_PUBKEYS;
  const noticesUrl = (testMode && env.SNUG_NOTICES_URL) || (o.registryUrl ? `${o.registryUrl.replace(/\/$/, "")}/v1/notices` : null);

  // One GET, redirects followed by hand (each hop re-checked when `check` is set), body capped.
  function get(url, { timeout = 10_000, maxBytes = MAX_JSON, check = null, onResponse = null, hops = 0 } = {}) {
    return new Promise((resolve, reject) => {
      if (check && !check(url)) return reject(err("network", `Refused to download from ${safeHost(url)}.`));
      let u;
      try { u = new URL(url); } catch { return reject(err("network", "Bad address.")); }
      const mod = u.protocol === "https:" ? https : u.protocol === "http:" ? http : null;
      if (!mod) return reject(err("network", "Bad address."));
      let responded = false;
      const req = mod.get(u, { headers: { accept: "application/vnd.github+json, application/octet-stream;q=0.9, */*;q=0.8", "user-agent": "Snug-desktop" }, timeout }, (res) => {
        responded = true;
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (hops >= 5) return reject(err("network", "Too many redirects."));
          let next;
          try { next = new URL(res.headers.location, u).href; } catch { return reject(err("network", "Bad redirect.")); }
          return get(next, { timeout, maxBytes, check, onResponse, hops: hops + 1 }).then(resolve, reject);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(err("network", `The server answered ${res.statusCode}.`)); }
        if (onResponse) return onResponse(res, req).then(resolve, reject);
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size > maxBytes) { req.destroy(); reject(err("size", "The reply is too large.")); return; }
          chunks.push(c);
        });
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", (e) => reject(err("network", e.message)));
        res.on("close", () => { if (!res.complete) reject(err("network", "The reply was cut off.")); });
        return undefined;
      });
      req.on("timeout", () => req.destroy(err("network", "Timed out.")));
      // Once a reply has started, its own handlers report the outcome.
      req.on("error", (e) => { if (!responded) reject(e.code === "network" || e.code === "size" ? e : err("network", e.message)); });
      return undefined;
    });
  }
  const safeHost = (url) => { try { return new URL(url).host; } catch { return "an unknown address"; } };
  const allowed = (url) => allowedUrl(url, testMode);

  async function minVersion() {
    if (!noticesUrl) return null;
    try {
      const n = JSON.parse((await get(noticesUrl, { timeout: 5_000, maxBytes: MAX_NOTICES })).toString("utf8"));
      return typeof n?.min === "string" && semver(n.min) ? n.min : null;
    } catch (e) { log("updater", "notices", e.message); return null; } // registry offline: no minimum
  }

  // The release's checksum file, exactly as published, after its signature is checked (when keys are pinned).
  async function signedSums(info) {
    const bytes = await get(info.sums.url, { maxBytes: MAX_SUMS, check: allowed });
    if (!keys.length) return bytes;
    if (!info.sig?.url) throw err("checksum", "The release has no signature for its checksums.");
    const sig = await get(info.sig.url, { maxBytes: MAX_SIG, check: allowed });
    if (!verifySums(bytes, sig.toString("utf8"), keys)) throw err("checksum", "The release's checksums aren't signed by Snug.");
    return bytes;
  }

  // { state: 'required', version, asset, sums, min } or { state: 'none' } (also offline or odd replies).
  async function check() {
    if (kind === "none" || env.SNUG_UPDATE_CHECK === "0") return { state: "none" };
    const [release, min] = await Promise.all([
      get(updateUrl).then((b) => JSON.parse(b.toString("utf8"))).catch((e) => { log("updater", "check", e.message); return null; }),
      minVersion(),
    ]);
    const picked = release && pickRelease(release, kind);
    if (!picked) return { state: "none", min };
    if (!needsUpdate({ current: o.current, latest: picked.version, min })) return { state: "none", min };
    // sec-desktop D3: with a pinned key, a release that isn't signed never blocks the app with an update
    // it could not install (someone who can only write releases can't lock everyone out either).
    if (keys.length) {
      try { await signedSums(picked); } catch (e) { log("updater", "signature", e.message); return { state: "none", min }; }
    }
    return { state: "required", min, ...picked };
  }

  // Downloads and verifies; resolves with the verified file's path. Errors carry code checksum | size | network.
  async function download(info, onProgress = () => {}) {
    const dir = path.join(tempDir, `snug-update-${info.version}`);
    fs.mkdirSync(dir, { recursive: true });
    const name = path.basename(info.asset.name);
    const final = path.join(dir, name);
    const part = `${final}.part`;
    const sums = parseSums((await signedSums(info)).toString("utf8"));
    const want = sums.get(name);
    if (!want) throw err("checksum", "The release has no checksum for this file.");
    const limit = Math.min(info.asset.size, MAX_ASSET);
    try { fs.rmSync(part, { force: true }); } catch { /* not there */ }
    let got = 0;
    let last = 0;
    const hash = crypto.createHash("sha256");
    try {
      await get(info.asset.url, {
        timeout: 30_000,
        check: allowed,
        onResponse: (res, req) => new Promise((resolve, reject) => {
          const out = fs.createWriteStream(part);
          let failed = null;
          const fail = (e) => { if (failed) return; failed = e; req.destroy(); out.destroy(); };
          out.on("error", (e) => fail(e.code === "ENOSPC" ? err("space", e.message) : err("write", e.message)));
          res.on("data", (c) => {
            if (failed) return;
            got += c.length;
            if (got > limit) { fail(err("size", "The download is larger than the release says.")); return; }
            hash.update(c);
            if (!out.write(c)) { res.pause(); out.once("drain", () => res.resume()); }
            const t = Date.now();
            if (t - last >= 100) { last = t; onProgress({ received: got, total: info.asset.size }); }
          });
          res.on("error", (e) => fail(err("network", e.message)));
          res.on("aborted", () => fail(err("network", "The download was cut off.")));
          res.on("close", () => { if (!res.complete) fail(err("network", "The download was cut off.")); });
          res.on("end", () => { if (!failed) out.end(); });
          out.on("close", () => (failed ? reject(failed) : resolve()));
        }),
      });
      onProgress({ received: got, total: info.asset.size, verifying: true });
      if (got !== info.asset.size) throw err("size", "The download is not the size the release says.");
      if (hash.digest("hex") !== want) throw err("checksum", "The download doesn’t match its checksum.");
      fs.renameSync(part, final);
      return final;
    } catch (e) {
      try { fs.rmSync(part, { force: true }); } catch { /* already gone */ }
      throw ["checksum", "size", "network", "space", "write"].includes(e.code) ? e : err("network", e.message);
    }
  }

  const dry = () => env.SNUG_UPDATE_DRY_INSTALL === "1";
  function record(entry) { globalThis.snugUpdateInstalled = entry; return { ok: true, dry: true }; }
  function launch(cmd, args) {
    const child = (o.spawn || require("child_process").spawn)(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on?.("error", (e) => log("updater", "spawn", e.message));
    child.unref?.();
  }
  const run = (cmd, args) => new Promise((resolve, reject) => {
    (o.execFile || require("child_process").execFile)(cmd, args, { timeout: 120_000 }, (e, stdout) => (e ? reject(e) : resolve(String(stdout || ""))));
  });

  const marker = path.join(tempDir, "snug-update-failed.txt");
  const CANT_WRITE = "Snug can’t replace itself in this folder. Move Snug to a folder you can change, like Downloads, or download the new version from GitHub.";
  // Can the portable exe's folder be written to? (Program Files, a read-only share: no.)
  const canWrite = o.canWrite || ((dir) => {
    if (process.platform !== "win32") return true; // a Windows path, tested elsewhere
    const probe = path.win32.join(dir, `.snug-update-${process.pid}.tmp`);
    try { fs.writeFileSync(probe, ""); fs.rmSync(probe, { force: true }); return true; } catch { return false; }
  });
  // The swap script left a marker: the last update couldn't be installed. Read once.
  function takeFailure() {
    try { if (!fs.existsSync(marker)) return false; fs.rmSync(marker, { force: true }); return true; } catch { return false; }
  }
  // Downloads of this version or older (and leftover swap scripts) go at start (review 0.10 #6).
  function cleanup() {
    let names = [];
    try { names = fs.readdirSync(tempDir); } catch { return; }
    for (const n of names) {
      const m = /^snug-update-(\d+\.\d+\.\d+)$/.exec(n);
      const stale = (m && semver(m[1]) && semverCmp(m[1], o.current) <= 0) || n === "snug-swap.cmd" || n === "snug-swap.sh" || /^snug-swap-[A-Za-z0-9]{6}$/.test(n);
      if (stale) { try { fs.rmSync(path.join(tempDir, n), { recursive: true, force: true }); } catch { /* in use */ } }
    }
  }

  // sec-integrate: the swap script goes in a fresh private folder (mkdtemp, 0700) and is created exclusively,
  // so nothing else on this computer can plant or swap a script under a known name in the temp folder
  // between the write and the run.
  function swapFile(name, script, mode = 0o600) {
    const dir = fs.mkdtempSync(path.join(tempDir, "snug-swap-"));
    const at = path.join(dir, name);
    fs.writeFileSync(at, script, { flag: "wx", mode });
    return at;
  }
  // file: the verified download. Resolves { ok } (the app is quitting), or { manual, message } (can't swap here).
  async function install(file, info) {
    if (!fs.existsSync(file)) throw err("network", "The download is gone. Try again.");
    if (kind === "portable") {
      const target = env.PORTABLE_EXECUTABLE_FILE || o.exePath;
      const dir = path.win32.dirname(target);
      const oldName = path.win32.basename(target);
      const final = /^Snug-\d+\.\d+\.\d+-portable\.exe$/i.test(oldName) ? path.win32.join(dir, `Snug-${info.version}-portable.exe`) : target;
      if (!dry() && !canWrite(dir)) return { manual: true, message: CANT_WRITE };
      const script = swapScript("portable", { pid: o.pid ?? process.pid, newFile: file, target, final, marker });
      const at = swapFile("snug-swap.cmd", script);
      if (dry()) return record({ kind, file, script, final });
      launch(env.ComSpec || "cmd.exe", ["/d", "/c", at]);
      o.quit?.();
      return { ok: true };
    }
    if (kind === "installer") {
      const args = ["/S", "--updated", "--force-run"];
      if (dry()) return record({ kind, file, script: [file, ...args].join(" ") });
      launch(file, args);
      o.quit?.();
      return { ok: true };
    }
    if (kind === "dmg") {
      const exe = o.exePath || "";
      // The bundle that holds the executable (not the first ".app" in the path: security review 0.10 #5).
      const m = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(exe);
      const curApp = m ? m[1] : null;
      const work = path.dirname(file);
      let writable = false;
      try { if (curApp) { fs.accessSync(path.dirname(curApp), fs.constants.W_OK); writable = true; } } catch { writable = false; }
      if (!curApp || curApp.startsWith("/Volumes/") || curApp.includes("/AppTranslocation/") || !writable) {
        if (!dry()) launch("open", [file]);
        else record({ kind, file, script: null, manual: true });
        return { manual: true, message: "Drag Snug to Applications, then open it from there." };
      }
      const mnt = path.join(work, "mnt");
      const newApp = path.join(work, "Snug.app");
      if (!dry()) {
        fs.rmSync(newApp, { recursive: true, force: true });
        fs.mkdirSync(mnt, { recursive: true });
        const step = (p) => p.catch((e) => { throw err("install", e.message); });
        await step(run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mnt, file]));
        try { await step(run("ditto", [path.join(mnt, "Snug.app"), newApp])); } finally {
          await run("hdiutil", ["detach", mnt]).catch(() => run("hdiutil", ["detach", "-force", mnt]).catch(() => {}));
        }
        const v = (await run("plutil", ["-extract", "CFBundleShortVersionString", "raw", path.join(newApp, "Contents", "Info.plist")]).catch(() => "")).trim();
        if (v !== info.version) throw err("checksum", `The downloaded Snug says it is ${v || "no version"}, not ${info.version}.`);
      }
      const script = swapScript("dmg", { pid: o.pid ?? process.pid, curApp, newApp, oldApp: path.join(work, `old-${Date.now()}.app`) });
      const at = swapFile("snug-swap.sh", script, 0o700);
      if (dry()) return record({ kind, file, script });
      launch("/bin/sh", [at]);
      o.quit?.();
      return { ok: true };
    }
    throw err("network", "This computer has no automatic updates.");
  }

  return { kind, testMode, check, download, install, cleanup, takeFailure };
}

module.exports = { createUpdater, semverCmp, needsUpdate, pickAssets, pickRelease, parseSums, swapScript, allowedUrl, kindOf, assetName, verifySums, updaterEnvFor, UPDATE_PUBKEYS, RELEASES_LIST };
