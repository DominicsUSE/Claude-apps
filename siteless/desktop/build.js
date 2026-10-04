// Builds the Siteless Windows app into dist/: an installer (Siteless-Setup-<version>.exe)
// and a portable exe that runs without installing.
//   npm install && node build.js              (run it on Windows; GitHub Actions does)
//   node build.js --page-only                 (just the app page, for `npm start`)
// The page is the same as siteless/index.html with Leaflet bundled in, so the app does not
// depend on a code CDN. It still needs the internet for maps, Google and OpenStreetMap.
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;

function appPage() {
  let html = fs.readFileSync(path.join(ROOT, "..", "index.html"), "utf8");
  const tags = [...html.matchAll(/<(?:link rel="stylesheet"|script) (?:href|src)="https:\/\/unpkg\.com\/[^"]+"[^>]*>(?:<\/script>)?/g)].map(m => m[0]);
  if (tags.length !== 4) throw new Error(`expected 4 Leaflet tags in index.html, found ${tags.length}`);
  for (const tag of tags) {
    const m = tag.match(/unpkg\.com\/((?:leaflet|leaflet\.markercluster))@[\d.]+(\/dist\/[^"]+)/);
    if (!m) throw new Error("unexpected library: " + tag);
    const code = fs.readFileSync(require.resolve(m[1] + m[2]), "utf8");
    html = html.replace(tag, () => (tag.startsWith("<script") ? `<script>${code}</script>` : `<style>${code}</style>`));
  }
  if (/unpkg\.com/.test(html)) throw new Error("a library is still loaded from the web");
  // web-app install links are for the website version only
  html = html.replace(/<link rel="(manifest|icon|apple-touch-icon)"[^>]*>\n?/g, "");
  fs.mkdirSync(path.join(ROOT, "app"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "app", "index.html"), html);
  fs.copyFileSync(path.join(ROOT, "..", "icons", "icon-512.png"), path.join(ROOT, "app", "icon.png"));
}

(async () => {
  appPage();
  if (process.argv.includes("--page-only")) return;
  fs.mkdirSync(path.join(ROOT, "build"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "..", "icons", "icon-512.png"), path.join(ROOT, "build", "icon.png"));
  const builder = require("electron-builder");
  const files = await builder.build({ projectDir: ROOT, win: [], publish: "never" });
  for (const f of files.filter(f => f.endsWith(".exe"))) console.log(`${f}  ${(fs.statSync(f).size / 1e6).toFixed(0)} MB`);
})().catch(e => { console.error(e); process.exit(1); });
