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

// a step that hangs must not hold up the run: say which step it was and stop
let step = "starting";
const say = s => { step = s; console.log(`  -- ${s}`); };
setTimeout(() => { console.error(`\nFAIL the live test hung during: ${step}`); process.exit(1); }, 25 * 60 * 1000).unref();

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

  say("map tiles");
  // real map tiles: different squares of the map must be different pictures (a "key required"
  // placeholder is the same picture everywhere)
  await win.reload();
  await win.waitForFunction(() => !!window.__siteless);
  await win.evaluate(() => window.__siteless.map.setView([51.5136, -0.1340], 15, { animate: false }));
  await win.waitForFunction(() => document.querySelectorAll("img.leaflet-tile-loaded").length >= 6, null, { timeout: 60000 }).catch(() => {});
  await sleep(1500);
  const tiles = await win.evaluate(async () => {
    const urls = [...document.querySelectorAll("img.leaflet-tile-loaded")].map(i => i.src).slice(0, 8);
    const out = [];
    for (const u of urls) {
      try {
        const b = new Uint8Array(await (await fetch(u)).arrayBuffer());
        let h = 0; for (const x of b) h = (h * 31 + x) >>> 0;
        out.push({ host: new URL(u).hostname, bytes: b.length, h });
      } catch (e) { out.push({ host: new URL(u).hostname, bytes: 0, h: "error", err: String(e) }); }
    }
    return out;
  });
  const distinct = new Set(tiles.map(t => t.h)).size;
  if (tiles.some(t => t.err)) console.log("     could not read a tile:", tiles.find(t => t.err).err);
  check(tiles.length >= 4 && !tiles.some(t => t.err) && distinct >= tiles.length - 1, `street map tiles are real map pictures (${tiles.length} tiles from ${[...new Set(tiles.map(t => t.host))].join(", ")}, ${distinct} different)`);
  await shot(win, "live-street-map");
  // the dark map, when the computer uses dark mode
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = "dark"; });
  await win.waitForFunction(() => document.querySelectorAll('img.leaflet-tile-loaded[src*="Dark_Gray"]').length >= 4, null, { timeout: 60000 }).catch(() => {});
  check(await count(win, 'img.leaflet-tile-loaded[src*="Dark_Gray"]') >= 4, `dark map tiles load in dark mode (${await count(win, 'img.leaflet-tile-loaded[src*="Dark_Gray"]')} tiles)`);
  await sleep(1000);
  await shot(win, "live-dark-map");
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = "light"; });

  say("location search");
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

  say("my location");
  // the "my location" button finds where the computer is (Windows location, or roughly from the connection)
  await win.evaluate(() => window.__siteless.map.setView([0, 0], 5, { animate: false }));
  await win.click("#btnLocate");
  await win.waitForFunction(() => { const c = window.__siteless.map.getCenter(); return Math.abs(c.lat) > 1 || Math.abs(c.lng) > 1; }, null, { timeout: 25000 }).catch(() => {});
  const here = await win.evaluate(() => ({ c: window.__siteless.map.getCenter(), z: window.__siteless.map.getZoom(), t: document.getElementById("toast").innerText }));
  check(Math.abs(here.c.lat) > 1 || Math.abs(here.c.lng) > 1, `"my location" moves the map to this computer (${here.c.lat.toFixed(2)}, ${here.c.lng.toFixed(2)}, zoom ${here.z}; "${here.t}")`);

  say("London scan");
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

  say("Google listing");
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

  say("eight-city scans");
  // many real scans: busy streets in eight cities on four continents, each must find places
  // and open a place's listing (at most two tries each, the free servers are shared)
  const CITIES = [["New York", 40.7223, -73.9878], ["Paris", 48.8530, 2.3499], ["Vilnius", 54.6810, 25.2830],
    ["Tokyo", 35.6938, 139.7034], ["Sydney", -33.8708, 151.2073], ["Chicago", 41.8919, -87.6278],
    ["Berlin", 52.5200, 13.4050], ["Mexico City", 19.4326, -99.1332]];
  let cityOk = 0;
  const cityLines = [];
  for (const [name, lat, lng] of CITIES) {
    let n = 0, secs = 0, msg = "";
    for (let attempt = 1; attempt <= 2 && !n; attempt++) {
      await win.evaluate(([la, ln]) => window.__siteless.map.setView([la, ln], 16, { animate: false }), [lat, lng]);
      await sleep(500);
      const before = await win.evaluate(() => window.__siteless.S.places.size);
      const s0 = Date.now();
      await win.click("#btnScan");
      const finished = await scanDone(win);
      secs = Math.round((Date.now() - s0) / 1000);
      n = (await win.evaluate(() => window.__siteless.S.places.size)) - before;
      msg = (await win.locator("#toast").innerText().catch(() => "")).trim();
      if (!finished) { await win.click("#btnStop").catch(() => {}); await scanDone(win, 30000); }
      if (!n && attempt < 2) { console.log(`     ${name}: no places on try ${attempt} ("${msg}"), trying again`); await sleep(15000); }
    }
    let opened = false;
    if (n && await count(win, "#list .item")) {
      await win.locator("#list .item").first().click();
      opened = await win.waitForSelector("#detailView:not([hidden]) iframe.embed", { timeout: 15000 }).then(() => true, () => false);
      await win.click("#btnBack").catch(() => {});
    }
    const line = `${name}: ${n} new places in ${secs} s${opened ? ", listing opens" : ""}`;
    console.log("     " + line);
    cityLines.push(line);
    if (n > 0 && opened) cityOk++;
  }
  check(cityOk === CITIES.length, `real scans in ${CITIES.length} cities find places and open them (${cityOk} of ${CITIES.length}): ${cityLines.join("; ")}`);
  await shot(win, "live-cities");

  say("keyword scan");
  // a keyword scan on real data
  await win.evaluate(() => window.__siteless.map.setView([40.7223, -73.9878], 16, { animate: false }));
  await win.fill("#kw", "pizza");
  await win.press("#kw", "Enter");
  await win.click("#btnScan");
  await scanDone(win);
  const kwFound = await win.evaluate(() => [...window.__siteless.S.places.values()].filter(p => p.kw === "pizza").length);
  check(kwFound > 0, `a keyword scan for "pizza" finds pizza places (${kwFound}; "${(await win.locator("#toast").innerText().catch(() => "")).trim()}")`);
  await win.click("#btnKwClear").catch(() => {});

  say("satellite");
  // real satellite imagery
  await win.click("#btnLayer");
  await win.waitForFunction(() => [...document.querySelectorAll("img.leaflet-tile-loaded")].some(i => /World_Imagery/.test(i.src)), null, { timeout: 60000 }).catch(() => {});
  check(await win.evaluate(() => [...document.querySelectorAll("img.leaflet-tile-loaded")].filter(i => /World_Imagery/.test(i.src)).length) > 0, "satellite imagery loads");
  await sleep(1500);
  await shot(win, "live-satellite");
  await win.click("#btnLayer");

  say("Google key check");
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
