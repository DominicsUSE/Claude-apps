// Smoke test for the desktop app: launches it with Electron (on any OS, a virtual display
// on Linux) with OpenStreetMap and map tiles mocked.
//   npm install && npm i --no-save playwright && node test.js
//   (Linux without a screen: xvfb-run node test.js)
const { _electron: electron } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+hc2rNAAAAABJRU5ErkJggg==", "base64");
const OSM = { elements: [
  { type: "node", id: 1, lat: 40.7225, lon: -73.988, tags: { amenity: "restaurant", name: "Nonna Rosa", "addr:city": "New York" } },
  { type: "node", id: 2, lat: 40.723, lon: -73.987, tags: { amenity: "cafe", name: "Little Cup", "contact:facebook": "https://facebook.com/littlecup" } },
] };
let failures = 0;
const check = (ok, msg) => { console.log((ok ? "  ok  " : "  FAIL ") + msg); if (!ok) failures++; };

async function launch(userData) {
  const args = [...(process.platform === "linux" ? ["--no-sandbox"] : []), `--user-data-dir=${userData}`, "."];
  const app = await electron.launch({ executablePath: require("electron"), args, cwd: __dirname });
  await app.context().route("**/*", route => {
    const u = new URL(route.request().url());
    if (u.protocol === "siteless:") return route.continue();
    if (/overpass/.test(u.hostname)) return route.fulfill({ json: OSM, headers: { "Access-Control-Allow-Origin": "*" } });
    if (u.hostname.endsWith("cartocdn.com")) return route.fulfill({ body: PNG, contentType: "image/png" });
    if (/google\.com$/.test(u.hostname)) return route.fulfill({ body: "<html><body>Google Maps (mock)</body></html>", contentType: "text/html" });
    return route.abort();
  });
  const win = await app.firstWindow();
  await win.waitForSelector("#btnScan");
  return { app, win };
}

(async () => {
  execFileSync(process.execPath, ["build.js", "--page-only"], { cwd: __dirname, stdio: "inherit" });
  const page = fs.readFileSync(path.join(__dirname, "app", "index.html"), "utf8");
  check(!/unpkg\.com/.test(page) && /L\.markerClusterGroup|MarkerClusterGroup/.test(page), "app page bundles Leaflet and the cluster plugin");
  check(!/rel="manifest"/.test(page), "app page drops the web install links");

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "siteless-"));
  let { app, win } = await launch(userData);
  const errors = [];
  win.on("pageerror", e => errors.push(String(e)));
  check(win.url() === "siteless://app/index.html", "serves the page from siteless://");
  check(await win.title() === "Siteless", "window is titled Siteless");
  check(await win.evaluate(() => !!window.sitelessApp && document.documentElement.classList.contains("desktop-app")), "page knows it runs in the desktop app");
  check(await win.evaluate(() => typeof L !== "undefined" && typeof L.markerClusterGroup === "function"), "Leaflet works offline");

  await win.click("#btnScan");
  await win.waitForSelector("#list .item");
  check((await win.locator("#list .item").count()) === 2, "scans and lists places");

  await win.click("#btnSettings");
  check(/Application restrictions/.test(await win.locator("#keyStep4").innerText()), "explains the key setup for an app");
  await win.click("dialog .dlg-head button");

  // links leave the app: patch shell.openExternal in the main process to record them
  await app.evaluate(({ shell }) => { global.__opened = []; shell.openExternal = url => { global.__opened.push(url); return Promise.resolve(); }; });
  await win.locator("#list .item").first().click();
  await win.click("#lnkMaps");
  await win.waitForTimeout(300);
  let opened = await app.evaluate(() => global.__opened);
  check(opened.length === 1 && /^https:\/\/www\.google\.com\/maps\/search\//.test(opened[0]) && app.windows().length === 1, "Open in Google Maps goes to the default browser");
  await win.click("#lnkMail", { noWaitAfter: true });
  await win.waitForTimeout(300);
  opened = await app.evaluate(() => global.__opened);
  check(/^mailto:/.test(opened[1] || "") && win.url() === "siteless://app/index.html", "email link opens the mail app and the window stays put");
  // the cancelled mailto navigation leaves Playwright waiting, so click from inside the page;
  // this also shows the page keeps working afterwards
  await win.evaluate(() => document.querySelector('[data-lead="saved"]').click());
  check(await win.evaluate(() => document.querySelector('[data-lead="saved"]').getAttribute("aria-pressed")) === "true", "page keeps working after a link opened outside");

  await app.close();
  ({ app, win } = await launch(userData));
  await win.waitForSelector("#list .item");
  check(/★ Saved/.test(await win.locator("#list").innerText()), "places and leads are still there after restarting");
  check(errors.length === 0, "no script errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  await app.close();
  fs.rmSync(userData, { recursive: true, force: true });
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
