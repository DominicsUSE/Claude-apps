// Builds "Build Atlas.app" for Apple Silicon and Intel Macs into dist/.
//   npm install && node build-mac.js            (works on macOS or Linux)
// Steps: make an offline copy of the page (d3 inlined, no web fonts), package it with
// Electron, ad-hoc sign it (codesign on a Mac, rcodesign elsewhere) and zip it.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { packager } = require("@electron/packager");

const ROOT = __dirname;
const DIST = path.join(ROOT, "dist");
const electronVersion = require("electron/package.json").version;

function offlinePage() {
  let html = fs.readFileSync(path.join(ROOT, "..", "index.html"), "utf8");
  const d3 = fs.readFileSync(path.join(ROOT, "node_modules", "d3", "dist", "d3.min.js"), "utf8");
  const tag = '<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script>';
  if (!html.includes(tag)) throw new Error("d3 script tag not found in index.html");
  html = html.replace(tag, () => "<script>" + d3 + "</script>");
  // the app uses the Mac's own San Francisco font; no web-font requests
  html = html.replace(/<link rel="preconnect"[^>]*>\n?/g, "").replace(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>\n?/g, "");
  fs.mkdirSync(path.join(ROOT, "app"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "app", "index.html"), html);
}

// The app's own text is English; drop Chromium's ~50 other UI translations to keep the download small.
function trimLocales(appPath) {
  const keep = new Set(["en.lproj", "en_GB.lproj", "Base.lproj"]);
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory() && e.name.endsWith(".lproj") && !keep.has(e.name)) fs.rmSync(p, { recursive: true });
      else if (e.isDirectory()) walk(p);
    }
  };
  walk(appPath);
}

function sign(appPath) {
  if (process.platform === "darwin") {
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
    return;
  }
  const rcodesign = process.env.RCODESIGN || "rcodesign";
  execFileSync(rcodesign, ["sign", appPath], { stdio: "inherit" });   // no certificate = ad-hoc signature
}

function zip(appPath, out) {
  if (fs.existsSync(out)) fs.rmSync(out);
  if (process.platform === "darwin") {
    execFileSync("ditto", ["-c", "-k", "--keepParent", appPath, out], { stdio: "inherit" });
  } else {
    // -y keeps the symlinks inside Electron's frameworks intact
    execFileSync("zip", ["-qry9", out, path.basename(appPath)], { cwd: path.dirname(appPath), stdio: "inherit" });
  }
}

(async () => {
  if (!fs.existsSync(path.join(ROOT, "icon.icns"))) execFileSync("python3", ["make_icon.py"], { cwd: ROOT, stdio: "inherit" });
  offlinePage();
  fs.mkdirSync(DIST, { recursive: true });
  const version = require("./package.json").version;
  for (const arch of (process.env.ARCHS || "arm64,x64").split(",")) {
    const [dir] = await packager({
      dir: ROOT,
      name: "Build Atlas",
      executableName: "Build Atlas",
      platform: "darwin",
      arch,
      electronVersion,
      icon: path.join(ROOT, "icon.icns"),
      appBundleId: "com.buildatlas.app",
      appCategoryType: "public.app-category.business",
      appVersion: version,
      appCopyright: "Map data: Natural Earth. Imagery: NASA Blue Marble.",
      darwinDarkModeSupport: true,
      out: path.join(DIST, "build"),
      overwrite: true,
      asar: true,
      prune: true,
      ignore: [/^\/dist($|\/)/, /^\/node_modules\/(?!$)/, /^\/build-mac\.js$/, /^\/make_icon\.py$/, /^\/icon\.png$/, /^\/README\.md$/],
    });
    const appPath = path.join(dir, "Build Atlas.app");
    trimLocales(appPath);
    sign(appPath);
    const label = arch === "arm64" ? "Apple-Silicon" : "Intel";
    const out = path.join(DIST, `Build-Atlas-${version}-mac-${label}.zip`);
    zip(appPath, out);
    console.log(`${out}  ${(fs.statSync(out).size / 1e6).toFixed(0)} MB`);
  }
})().catch(e => { console.error(e); process.exit(1); });
