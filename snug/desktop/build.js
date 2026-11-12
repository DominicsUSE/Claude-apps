// Builds the Snug desktop app into dist/: an installer (Snug-Setup-<version>.exe)
// and a portable exe that runs without installing.
//   npm install && node build.js      (run it on Windows; GitHub Actions does)
//   node build.js --files-only        (just copy the app files, for `npm start`)
//   node build.js --dir               (an unpacked app for this machine, for testing)
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
  // The server and page are ES modules; this marks the folder as such.
  fs.writeFileSync(path.join(APP, "package.json"), JSON.stringify({ type: "module", private: true }) + "\n");
  fs.mkdirSync(path.join(ROOT, "build"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "icon.png"), path.join(ROOT, "build", "icon.png"));
  // Windows wants a multi-size .ico so the 16-32px entries use the small-size drawing.
  fs.copyFileSync(path.join(ROOT, "icon.ico"), path.join(ROOT, "build", "icon.ico"));
  fs.copyFileSync(path.join(ROOT, "icon.png"), path.join(APP, "icon.png"));
}

(async () => {
  copyApp();
  if (process.argv.includes("--files-only")) return;
  const builder = require("electron-builder");
  const dir = process.argv.includes("--dir");
  const files = await builder.build({ projectDir: ROOT, publish: "never", ...(dir ? { dir: true } : { win: [] }) });
  for (const f of files.filter((f) => f.endsWith(".exe"))) console.log(`${f}  ${(fs.statSync(f).size / 1e6).toFixed(0)} MB`);
})().catch((e) => { console.error(e); process.exit(1); });
