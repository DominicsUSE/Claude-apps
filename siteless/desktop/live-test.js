// Live test: drives the app against the real internet (map tiles, OpenStreetMap, location search,
// satellite imagery, the embedded Google Maps listing and Google's key check). Nothing is mocked.
//   SITELESS_EXE="%LOCALAPPDATA%\Programs\Siteless\Siteless.exe" SHOTS=shots node live-test.js
//   (without SITELESS_EXE it runs the app from source)
const { _electron: electron } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");

const EXE = process.env.SITELESS_EXE || "";
const SHOTS = process.env.SHOTS || "";
let failures = 0;
const results = [];
const check = (ok, msg) => { console.log((ok ? "  ok  " : "  FAIL ") + msg); results.push([ok, msg]); if (!ok) failures++; };
const shot = async (win, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await win.screenshot({ path: path.join(SHOTS, name + ".png") }); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const pageState = win => win.evaluate(() => ({
  progress: document.getElementById("progress").hidden ? "" : document.getElementById("progText").textContent,
  toast: document.getElementById("toast").hidden ? "" : document.getElementById("toast").innerText,
  button: document.getElementById("btnScan").hidden ? "(hidden)" : document.getElementById("scanLabel").innerText,
}));
// waits for the scan to finish; if it never does, says what the page shows instead of giving up
async function scanDone(win, timeout = 150000) {
  const ok = await win.waitForFunction(() => document.getElementById("progress").hidden && !document.getElementById("btnScan").hidden, null, { timeout })
    .then(() => true, () => false);
  if (!ok) console.log(`     ${at()} scan still running after ${timeout / 1000} s: ${JSON.stringify(await pageState(win))}`);
  await win.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  return ok;
}
// the OpenStreetMap servers the app uses, read from the page itself
const SERVERS = JSON.parse(/const OVERPASS = (\[[^\]]*\])/.exec(fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8"))[1].replace(/'/g, '"').replace(/\s+/g, " "));
const isOsm = u => /\/api\/interpreter$/.test(u);
const count = (win, sel) => win.locator(sel).count();

(async () => {
  // first, from outside the app: can this computer reach each OpenStreetMap server, and how fast?
  console.log("OpenStreetMap servers, asked directly:");
  const tiny = "[out:json][timeout:20];node[amenity=cafe](51.512,-0.137,51.515,-0.132);out 3;";
  await Promise.all(SERVERS.map(async ep => {
    const s0 = Date.now();
    try {
      const res = await fetch(ep, { method: "POST", body: "data=" + encodeURIComponent(tiny), headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(40000) });
      const text = await res.text();
      console.log(`     ${new URL(ep).hostname}: HTTP ${res.status} in ${Date.now() - s0} ms, ${text.length} bytes, CORS ${res.headers.get("access-control-allow-origin")}`);
    } catch (e) { console.log(`     ${new URL(ep).hostname}: ${e.name} ${e.message} after ${Date.now() - s0} ms`); }
  }));

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "siteless-live-"));
  const args = [...(process.platform === "linux" ? ["--no-sandbox"] : []), `--user-data-dir=${userData}`, ...(EXE ? [] : ["."])];
  const app = await electron.launch({ executablePath: EXE || require("electron"), args, cwd: __dirname, timeout: 90000 });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", e => { console.log(`     ${at()} page error: ${e}`); errors.push(String(e)); });
  win.on("console", m => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) console.log(`     ${at()} console: ${m.text()}`); });
  // log every request to an OpenStreetMap server and how it ended
  win.on("request", r => { if (isOsm(r.url())) console.log(`     ${at()} app asks ${new URL(r.url()).hostname}`); });
  win.on("requestfinished", async r => {
    if (!isOsm(r.url())) return;
    const res = await r.response().catch(() => null);
    console.log(`     ${at()} ${new URL(r.url()).hostname} answered HTTP ${res ? res.status() : "?"}`);
  });
  win.on("requestfailed", r => { if (isOsm(r.url())) console.log(`     ${at()} ${new URL(r.url()).hostname} failed: ${(r.failure() || {}).errorText}`); });
  await win.waitForSelector("#btnScan");
  // the debug hook lets the test move the map precisely
  await win.goto("siteless://app/index.html?debug");
  await win.waitForFunction(() => !!window.__siteless);
  await app.evaluate(({ shell }) => { global.__opened = []; shell.openExternal = url => { global.__opened.push(url); return Promise.resolve(); }; });

  // real map tiles
  await win.waitForFunction(() => document.querySelectorAll("img.leaflet-tile-loaded").length >= 4, null, { timeout: 60000 }).catch(() => {});
  check(await count(win, "img.leaflet-tile-loaded") >= 4, `street map tiles load (${await count(win, "img.leaflet-tile-loaded")} tiles)`);

  // real location search (OpenStreetMap Nominatim)
  await win.fill("#q", "Vilnius, Lithuania");
  await win.press("#q", "Enter");
  await win.waitForFunction(() => {
    const box = document.getElementById("geoResults");
    const c = window.__siteless.map.getCenter();
    return (box && !box.hidden && box.querySelector("[data-geo]")) || Math.abs(c.lat - 54.69) < 0.5;
  }, null, { timeout: 30000 }).catch(() => {});
  if (await count(win, "#geoResults [data-geo]")) await win.click("#geoResults [data-geo]");
  await sleep(1500);
  const c1 = await win.evaluate(() => window.__siteless.map.getCenter());
  check(Math.abs(c1.lat - 54.69) < 0.5 && Math.abs(c1.lng - 25.28) < 0.6, `searching "Vilnius, Lithuania" moves the map there (${c1.lat.toFixed(3)}, ${c1.lng.toFixed(3)})`);

  // real OpenStreetMap scan of a busy neighbourhood (central London)
  await win.evaluate(() => window.__siteless.map.setView([51.5136, -0.1340], 16, { animate: false }));
  let places = 0, toast = "";
  let scanSecs = 0;
  for (let attempt = 1; attempt <= 3 && !places; attempt++) {
    console.log(`     ${at()} scan, attempt ${attempt}`);
    const s0 = Date.now();
    await win.click("#btnScan");
    const finished = await scanDone(win);
    scanSecs = Math.round((Date.now() - s0) / 1000);
    places = await win.evaluate(() => [...window.__siteless.S.places.values()].filter(p => p.src === "osm").length);
    toast = (await win.locator("#toast").innerText().catch(() => "")).trim();
    console.log(`     ${at()} attempt ${attempt} ${finished ? "finished" : "did not finish"} after ${scanSecs} s: ${places} places, "${toast}"`);
    if (!finished) { await win.click("#btnStop").catch(() => {}); await scanDone(win, 30000); }
    if (!places && attempt < 3) await sleep(20000);
  }
  const listed = await count(win, "#list .item");
  const pins = await count(win, ".leaflet-marker-icon");
  check(places > 20 && listed > 0 && pins > 0, `scans real OpenStreetMap data: ${places} places in ${scanSecs} s, ${listed} listed, ${pins} pins or groups ("${toast}")`);
  await win.waitForFunction(() => document.querySelectorAll("img.leaflet-tile-loaded").length >= 4, null, { timeout: 30000 }).catch(() => {});
  await shot(win, "live-map");

  // a real place: the embedded Google Maps listing loads
  if (listed) {
    await win.locator("#list .item").first().click();
    await win.waitForSelector("iframe.embed");
    let frame = null;
    for (let i = 0; i < 40 && !frame; i++) { await sleep(500); frame = win.frames().find(f => /google\.com\/maps/.test(f.url())); }
    let size = 0;
    if (frame) {
      await frame.waitForLoadState("load", { timeout: 30000 }).catch(() => {});
      size = await frame.evaluate(() => document.documentElement.outerHTML.length).catch(() => 0);
    }
    check(!!frame && size > 2000, `embedded Google Maps listing loads (${frame ? new URL(frame.url()).hostname : "no frame"}, ${size} bytes)`);
    await sleep(2500);
    await shot(win, "live-place");
    await win.click("#lnkMaps");
    await sleep(300);
    const opened = await app.evaluate(() => global.__opened);
    check(/^https:\/\/www\.google\.com\/maps\//.test(opened[0] || ""), `Open in Google Maps hands a Google Maps link to the default browser (${(opened[0] || "none").slice(0, 60)}…)`);
    await win.click("#btnBack");
  } else check(false, "embedded Google Maps listing loads (no places to open)");

  // real satellite imagery
  await win.click("#btnLayer");
  await win.waitForFunction(() => [...document.querySelectorAll("img.leaflet-tile-loaded")].some(i => /arcgisonline/.test(i.src)), null, { timeout: 60000 }).catch(() => {});
  check(await win.evaluate(() => [...document.querySelectorAll("img.leaflet-tile-loaded")].filter(i => /arcgisonline/.test(i.src)).length) > 0, "satellite imagery loads");
  await sleep(1500);
  await shot(win, "live-satellite");
  await win.click("#btnLayer");

  // real Google: an invalid key is rejected with a clear message, which proves the app reaches Google
  await win.click("#btnSettings");
  await win.fill("#keyInput", "AIzaSyInvalidKeyForSitelessTest000000000");
  await win.click("#btnKeySave");
  await win.waitForSelector("#keyStatus.err", { timeout: 30000 }).catch(() => {});
  const keyMsg = await win.locator("#keyStatus").innerText();
  check(/not valid/i.test(keyMsg), `reaches Google from the app; a wrong key gets a clear message ("${keyMsg}")`);
  await shot(win, "live-key-check");
  await win.click("dialog .dlg-head button");

  check(errors.length === 0, "no script errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  await app.close();
  fs.rmSync(userData, { recursive: true, force: true });
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, "\n### Live internet test (installed app)\n\n" +
      results.map(([ok, m]) => `- ${ok ? "✅" : "❌"} ${m}`).join("\n") + "\n");
  }
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
