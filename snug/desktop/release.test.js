// release.sh against a fake `gh` on PATH (state in a folder, every call logged).
//   node --test release.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const VERSION = require("./package.json").version;
const TAG = `snug-v${VERSION}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "snug-release-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// The fake gh: release view / create / upload / download / edit, enough for release.sh.
const FAKE_GH = `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const dir = process.env.FAKE_GH_DIR;
const statePath = path.join(dir, "state.json");
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { releases: {} };
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "log.txt"), JSON.stringify(argv) + "\\n");
const [group, cmd, tag, ...rest] = argv;
const opt = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
const die = (m) => { process.stderr.write(m + "\\n"); process.exit(1); };
if (group !== "release") die("unknown command");
const rel = state.releases[tag];
const store = (name) => path.join(dir, "assets", tag, name);
if (cmd === "view") {
  // The race: another workflow creates the release right after our first look.
  if (!rel && process.env.FAKE_GH_RACE === "1" && !state.raced) {
    state.raced = true;
    state.releases[tag] = { latest: false, target: "other", assets: {} };
    save();
    die("release not found");
  }
  if (!rel) die("release not found");
  if (rest.includes("--json")) { for (const n of Object.keys(rel.assets)) process.stdout.write(n + "\\n"); }
  else process.stdout.write("title:\\t" + tag + "\\n");
} else if (cmd === "create") {
  if (rel) die("a release with the same tag name already exists");
  state.releases[tag] = { latest: rest.includes("--latest"), target: opt("--target"), title: opt("--title"), notes: opt("--notes"), assets: {} };
  save();
} else if (cmd === "upload") {
  if (!rel) die("release not found");
  if (rest.includes("--clobber")) die("test: --clobber is never allowed");
  for (const f of rest.filter((a) => !a.startsWith("--"))) {
    const name = path.basename(f);
    if (rel.assets[name]) die("asset under the same name already exists: " + name);
    fs.mkdirSync(path.dirname(store(name)), { recursive: true });
    fs.copyFileSync(f, store(name));
    rel.assets[name] = true;
  }
  save();
} else if (cmd === "download") {
  if (!rel) die("release not found");
  const name = opt("-p");
  if (!rel.assets[name]) die("no asset matches " + name);
  fs.copyFileSync(store(name), path.join(opt("-D"), name));
} else if (cmd === "edit") {
  if (!rel) die("release not found");
  if (rest.includes("--latest")) { for (const r of Object.values(state.releases)) r.latest = false; rel.latest = true; }
  save();
} else die("unknown release command " + cmd);
`;

function setup(name) {
  const root = path.join(tmp, name);
  const bin = path.join(root, "bin");
  const ghDir = path.join(root, "gh");
  const dist = path.join(root, "dist");
  for (const d of [bin, ghDir, dist]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(bin, "gh"), FAKE_GH, { mode: 0o755 });
  const make = (file, bytes = crypto.randomBytes(5000)) => { const p = path.join(dist, file); fs.writeFileSync(p, bytes); return p; };
  const state = () => JSON.parse(fs.readFileSync(path.join(ghDir, "state.json"), "utf8"));
  const seed = (s) => {
    fs.writeFileSync(path.join(ghDir, "state.json"), JSON.stringify(s));
    for (const [tag, r] of Object.entries(s.releases)) for (const [n, content] of Object.entries(r.assets)) {
      fs.mkdirSync(path.join(ghDir, "assets", tag), { recursive: true });
      fs.writeFileSync(path.join(ghDir, "assets", tag, n), typeof content === "string" ? content : "x");
      r.assets[n] = true;
    }
    fs.writeFileSync(path.join(ghDir, "state.json"), JSON.stringify(s));
  };
  const run = (platform, files, extraEnv = {}) => spawnSync("bash", [path.join(__dirname, "release.sh"), platform, ...files], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_GH_DIR: ghDir, GITHUB_SHA: "abc123", GH_TOKEN: "fake", ...extraEnv },
  });
  const log = () => (fs.existsSync(path.join(ghDir, "log.txt")) ? fs.readFileSync(path.join(ghDir, "log.txt"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  const published = (n) => fs.readFileSync(path.join(ghDir, "assets", TAG, n));
  return { make, state, seed, run, log, published, dist };
}
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const winFiles = (s) => [s.make(`Snug-Setup-${VERSION}.exe`), s.make(`Snug-${VERSION}-portable.exe`)];

test("no release yet: created at this commit, marked latest, files and checksums uploaded", () => {
  const s = setup("fresh");
  const files = winFiles(s);
  const r = s.run("windows", files);
  assert.equal(r.status, 0, r.stderr);
  const rel = s.state().releases[TAG];
  assert.equal(rel.target, "abc123");
  assert.equal(rel.latest, true);
  assert.equal(rel.title, `Snug ${VERSION}`);
  assert.match(rel.notes, /More info\*\*, then \*\*Run anyway/);
  assert.deepEqual(Object.keys(rel.assets).sort(), [`Snug-${VERSION}-portable.exe`, `Snug-Setup-${VERSION}.exe`, "SHA256SUMS-windows.txt"].sort());
  const sums = s.published("SHA256SUMS-windows.txt").toString();
  for (const f of files) assert.ok(sums.includes(`${sha(fs.readFileSync(f))}  ${path.basename(f)}\n`), `sums has ${path.basename(f)}`);
  assert.equal(sums.trim().split("\n").length, 2);
  const calls = s.log();
  assert.ok(calls.some((c) => c[1] === "create" && c.includes("--latest") && c.includes("--target")));
  const uploads = calls.filter((c) => c[1] === "upload").map((c) => path.basename(c[3]));
  assert.equal(uploads.at(-1), "SHA256SUMS-windows.txt", "the checksum file goes last");
  assert.deepEqual(calls.at(-1).slice(0, 4), ["release", "edit", TAG, "--latest"]);
  assert.ok(!calls.some((c) => c.includes("--clobber")), "never --clobber");
});

test("a release without this platform's files (the Mac workflow made it): nothing is created, only ours are added", () => {
  const s = setup("other-platform");
  s.seed({ releases: { [TAG]: { latest: false, target: "mac", assets: { [`Snug-${VERSION}-mac.dmg`]: "dmg", "SHA256SUMS-mac.txt": "sums" } } } });
  const r = s.run("windows", winFiles(s));
  assert.equal(r.status, 0, r.stderr);
  const calls = s.log();
  assert.ok(!calls.some((c) => c[1] === "create"), "no second create");
  const rel = s.state().releases[TAG];
  assert.equal(rel.target, "mac", "the release is the existing one");
  assert.equal(rel.latest, true, "marked latest at the end");
  assert.equal(Object.keys(rel.assets).length, 5);
  assert.equal(s.published("SHA256SUMS-mac.txt").toString(), "sums", "the other platform's checksum file is untouched");
});

test("files already published are kept, and the checksum file describes the published copies", () => {
  const s = setup("already");
  const publishedSetup = crypto.randomBytes(4000);
  s.seed({ releases: { [TAG]: { latest: true, target: "first", assets: { [`Snug-Setup-${VERSION}.exe`]: publishedSetup.toString("latin1") } } } });
  // The seed writes strings; write the real bytes over it.
  fs.writeFileSync(path.join(tmp, "already", "gh", "assets", TAG, `Snug-Setup-${VERSION}.exe`), publishedSetup);
  const files = winFiles(s); // a rebuild: different bytes for the same names
  const r = s.run("windows", files);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`Snug-Setup-${VERSION.replace(/\./g, "\\.")}\\.exe is already in`));
  const uploads = s.log().filter((c) => c[1] === "upload").map((c) => path.basename(c[3]));
  assert.deepEqual(uploads, [`Snug-${VERSION}-portable.exe`, "SHA256SUMS-windows.txt"]);
  assert.deepEqual(s.published(`Snug-Setup-${VERSION}.exe`), publishedSetup, "the published file never changes");
  const sums = s.published("SHA256SUMS-windows.txt").toString();
  assert.ok(sums.includes(`${sha(publishedSetup)}  Snug-Setup-${VERSION}.exe`), "hash of the published setup, not the rebuild");
  assert.ok(sums.includes(`${sha(fs.readFileSync(files[1]))}  Snug-${VERSION}-portable.exe`));

  // Everything there: a re-run uploads nothing and still succeeds.
  const again = s.run("windows", winFiles(s));
  assert.equal(again.status, 0, again.stderr);
  assert.equal(s.log().filter((c) => c[1] === "upload").length, 2, "no new uploads");
});

test("create race: the other workflow creates the release first; this one carries on with it", () => {
  const s = setup("race");
  const r = s.run("mac", [s.make(`Snug-${VERSION}-mac.dmg`)], { FAKE_GH_RACE: "1" });
  assert.equal(r.status, 0, r.stderr);
  const calls = s.log().map((c) => c[1]);
  assert.deepEqual(calls.slice(0, 3), ["view", "create", "view"], "view, create (fails), view again");
  const rel = s.state().releases[TAG];
  assert.equal(rel.target, "other", "the winner's release");
  assert.deepEqual(Object.keys(rel.assets).sort(), [`Snug-${VERSION}-mac.dmg`, "SHA256SUMS-mac.txt"].sort());
  assert.equal(rel.latest, true);
  assert.match(s.published("SHA256SUMS-mac.txt").toString(), new RegExp(`^[0-9a-f]{64}  Snug-${VERSION.replace(/\./g, "\\.")}-mac\\.dmg\\n$`));
});

test("bad calls fail: no platform, no files, a missing file", () => {
  const s = setup("bad");
  assert.equal(s.run("linux", [s.make("x")]).status, 2);
  assert.equal(s.run("windows", []).status, 2);
  const r = s.run("windows", [path.join(s.dist, "nope.exe")]);
  assert.notEqual(r.status, 0);
  assert.ok(!s.log().some((c) => c[1] === "upload"), "nothing uploaded");
});
