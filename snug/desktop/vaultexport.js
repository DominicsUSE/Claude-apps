// `Snug --export-vault` (design 0.10 section 3.5): the Windows uninstaller runs this when someone says
// "Yes, save my data file first". No window, no server, no single-instance lock: copy each account's sealed
// data file (already current: Snug writes it on every change and on quit) to the Desktop, then exit.
// Exit code 0 when at least one file was copied, 2 when there was none.
const fs = require("fs");
const path = require("path");

const FILE = /^[a-z2-7]{16}\.snugvault$/;
const pad = (n) => String(n).padStart(2, "0");

// The files to copy: <userData>/data/vault/<uid>.snugvault, nothing else.
function vaultFiles(userData) {
  const dir = path.join(userData, "data", "vault");
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => FILE.test(n)).map((n) => path.join(dir, n)).filter((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
}

// "Snug data 2026-11-14.snugvault", then "… (2)", "… (3)" so nothing on the Desktop is overwritten.
function freeName(dir, now = new Date()) {
  const base = `Snug data ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  let name = `${base}.snugvault`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${base} (${i}).snugvault`;
  return path.join(dir, name);
}

function exportTo(userData, desktop, now = new Date()) {
  const copied = [];
  for (const f of vaultFiles(userData)) {
    try {
      const to = freeName(desktop, now);
      fs.copyFileSync(f, to, fs.constants.COPYFILE_EXCL);
      copied.push(to);
    } catch { /* one file failing doesn't stop the others */ }
  }
  return copied;
}

function maybeRun(app, argv = process.argv) {
  if (!argv.includes("--export-vault")) return false;
  Promise.resolve(app.whenReady()).then(() => {
    let copied = [];
    try { copied = exportTo(app.getPath("userData"), app.getPath("desktop")); } catch { copied = []; }
    app.exit(copied.length ? 0 : 2);
  }, () => app.exit(2));
  return true;
}

module.exports = { maybeRun, exportTo, vaultFiles, freeName };
