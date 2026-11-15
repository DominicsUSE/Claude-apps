// Builds the Snug desktop app into dist/. On Windows: an installer (Snug-Setup-<version>.exe)
// and a portable exe that runs without installing. On a Mac: Snug-<version>-mac.dmg
// (universal: Apple silicon and Intel), ad-hoc signed.
//   npm install && node build.js      (run it on Windows or a Mac; GitHub Actions does)
//   node build.js --files-only        (just copy the app files, for `npm start`)
//   node build.js --dir               (an unpacked app for this machine, for testing)
//   node build.js --prepackaged <dir> (Windows: the installer and portable exe around an app that is already
//                                      packed, e.g. dist/win-unpacked after code signing; nothing in it changes)
// The app carries the whole of Snug: the page and the server. Nothing is fetched
// from the web at run time.
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const SNUG = path.join(ROOT, "..");
const APP = path.join(ROOT, "snug");

function copyApp() {
  fs.rmSync(APP, { recursive: true, force: true });
  fs.mkdirSync(APP, { recursive: true });
  for (const name of ["index.html", "sw.js", "brand", "css", "js", "fonts", "vendor", "server"]) {
    fs.cpSync(path.join(SNUG, name), path.join(APP, name), { recursive: true });
  }
  // The install page (Settings > Desktop app links to it), so people joining this PC's Snug from a browser
  // find it too. Only these two files: the rest of docs/ is the project's own reference.
  fs.mkdirSync(path.join(APP, "docs"), { recursive: true });
  for (const name of ["install.html", "install.css"]) fs.copyFileSync(path.join(SNUG, "docs", name), path.join(APP, "docs", name));
  // The server and page are ES modules; this marks the folder as such.
  fs.writeFileSync(path.join(APP, "package.json"), JSON.stringify({ type: "module", private: true }) + "\n");
  fs.mkdirSync(path.join(ROOT, "build"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "icon.png"), path.join(ROOT, "build", "icon.png"));
  // Windows wants a multi-size .ico so the 16-32px entries use the small-size drawing.
  fs.copyFileSync(path.join(ROOT, "icon.ico"), path.join(ROOT, "build", "icon.ico"));
  fs.copyFileSync(path.join(ROOT, "icon.png"), path.join(APP, "icon.png"));
  fs.copyFileSync(path.join(ROOT, "installer.nsh"), path.join(ROOT, "build", "installer.nsh")); // v0.10 C: the uninstall prompt (NSIS)
  fs.copyFileSync(path.join(ROOT, "entitlements.mac.plist"), path.join(ROOT, "build", "entitlements.mac.plist")); // sec-desktop D4: the hardened runtime's entitlements
}

(async () => {
  copyApp();
  if (process.argv.includes("--files-only")) return;
  const builder = require("electron-builder");
  const dir = process.argv.includes("--dir");
  const pre = process.argv.indexOf("--prepackaged");
  if (pre >= 0 && !process.argv[pre + 1]) throw new Error("usage: node build.js --prepackaged <dir>");
  const target = pre >= 0 ? { prepackaged: path.resolve(process.argv[pre + 1]), win: [] }
    : dir ? { dir: true } : process.platform === "darwin" ? { mac: [] } : { win: [] };
  const files = await builder.build({ projectDir: ROOT, publish: "never", ...target });
  for (const f of files.filter((f) => /\.(exe|dmg)$/.test(f))) console.log(`${f}  ${(fs.statSync(f).size / 1e6).toFixed(0)} MB`);
})().catch((e) => { console.error(e); process.exit(1); });
