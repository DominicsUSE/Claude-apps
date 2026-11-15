// `--export-vault` (desktop/vaultexport.js): what the Windows uninstaller runs. No Electron needed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { maybeRun, exportTo, freeName } = require("./vaultexport.js");

function setup(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "snug-export-"));
  const userData = path.join(root, "userData");
  const desktop = path.join(root, "Desktop");
  fs.mkdirSync(path.join(userData, "data", "vault", "backups"), { recursive: true });
  fs.mkdirSync(desktop, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(userData, "data", "vault", name), body);
  return { userData, desktop };
}
function fakeApp(paths) {
  const app = { code: null, whenReady: () => Promise.resolve(), getPath: (n) => (n === "userData" ? paths.userData : paths.desktop), exit: (c) => { app.code = c; } };
  return app;
}
const settle = () => new Promise((r) => setTimeout(r, 20));

test("without the flag nothing happens and the app starts as usual", () => {
  const app = fakeApp(setup());
  assert.equal(maybeRun(app, ["snug.exe"]), false);
  assert.equal(app.code, null);
});

test("--export-vault copies each account's data file to the Desktop and exits 0; keys and backups stay", async () => {
  const p = setup({ "abcdefghijklmnop.snugvault": "SNUGVLT1 one", "qrstuvwxyz234567.snugvault": "SNUGVLT1 two", "abcdefghijklmnop.key": "secret", "notes.txt": "x" });
  fs.writeFileSync(freeName(p.desktop), "already here"); // a file of that name is already on the Desktop
  const app = fakeApp(p);
  assert.equal(maybeRun(app, ["snug.exe", "--export-vault"]), true);
  await settle();
  assert.equal(app.code, 0);
  const out = fs.readdirSync(p.desktop).sort();
  assert.equal(out.length, 3, out.join(", "));
  assert.ok(out.every((n) => /^Snug data \d{4}-\d{2}-\d{2}( \(\d\))?\.snugvault$/.test(n)));
  const bodies = out.map((n) => fs.readFileSync(path.join(p.desktop, n), "utf8")).sort();
  assert.deepEqual(bodies, ["SNUGVLT1 one", "SNUGVLT1 two", "already here"], "nothing overwritten; the key file never copied");
  assert.ok(fs.existsSync(path.join(p.userData, "data", "vault", "abcdefghijklmnop.snugvault")), "AppData keeps its copy");
});

test("no data file: exit 2, nothing written", async () => {
  const p = setup({ "abcdefghijklmnop.key": "secret" });
  const app = fakeApp(p);
  assert.equal(maybeRun(app, ["snug.exe", "--export-vault"]), true);
  await settle();
  assert.equal(app.code, 2);
  assert.deepEqual(fs.readdirSync(p.desktop), []);
  assert.deepEqual(exportTo(path.join(p.userData, "nope"), p.desktop), []);
});

test("the installer script asks before uninstalling, never on silent runs or updates, and runs the export flag", () => {
  const nsh = fs.readFileSync(path.join(__dirname, "installer.nsh"), "utf8");
  assert.match(nsh, /!macro customUnInit[\s\S]*!macroend/);
  assert.match(nsh, /\$\{IfNot\} \$\{Silent\}/);
  assert.match(nsh, /\$\{AndIfNot\} \$\{isUpdated\}/);
  assert.match(nsh, /Save your Snug data file first\?/);
  assert.match(nsh, /ExecWait '"\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}" --export-vault'/);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
  assert.ok(pkg.build.files.includes("vaultexport.js"), "packaged");
  assert.equal(pkg.build.nsis.include, "build/installer.nsh");
  assert.equal(pkg.build.nsis.deleteAppDataOnUninstall ?? false, false);
  const main = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  assert.match(main, /require\("\.\/vaultexport\.js"\)\.maybeRun\(app\)/);
  assert.match(fs.readFileSync(path.join(__dirname, "build.js"), "utf8"), /installer\.nsh/);
});
