// Functional test for the desktop app, with OpenStreetMap and map tiles mocked.
// Runs the app from source, or the installed app when SITELESS_EXE points at Siteless.exe.
//   npm install && npm i --no-save playwright && node test.js
//   SITELESS_EXE="%LOCALAPPDATA%\Programs\Siteless\Siteless.exe" SHOTS=shots node test.js
//   (Linux without a screen: xvfb-run node test.js)
const { _electron: electron } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawn } = require("child_process");

const EXE = process.env.SITELESS_EXE || "";
const SHOTS = process.env.SHOTS || "";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+hc2rNAAAAABJRU5ErkJggg==", "base64");
const OSM = { elements: [
  { type: "node", id: 1, lat: 40.7225, lon: -73.988, tags: { amenity: "restaurant", name: "Nonna Rosa", "addr:city": "New York" } },
  { type: "node", id: 2, lat: 40.723, lon: -73.987, tags: { amenity: "cafe", name: "Little Cup", "contact:facebook": "https://facebook.com/littlecup" } },
] };
let failures = 0;
const results = [];
const check = (ok, msg) => { console.log((ok ? "  ok  " : "  FAIL ") + msg); results.push([ok, msg]); if (!ok) failures++; };
const shot = async (win, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await win.screenshot({ path: path.join(SHOTS, name + ".png") }); } };
const settle = win => win.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
const noOverflow = win => win.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.documentElement.scrollHeight <= innerHeight + 1);

function appArgs(userData, extra = []) {
  return [...(process.platform === "linux" ? ["--no-sandbox"] : []), `--user-data-dir=${userData}`, ...extra, ...(EXE ? [] : ["."])];
}
async function launch(userData, extra) {
  const app = await electron.launch({ executablePath: EXE || require("electron"), args: appArgs(userData, extra), cwd: __dirname, timeout: 90000 });
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
  console.log(EXE ? `testing the installed app: ${EXE}` : "testing the app from source");
  if (!EXE) {
    execFileSync(process.execPath, ["build.js", "--page-only"], { cwd: __dirname, stdio: "inherit" });
    const page = fs.readFileSync(path.join(__dirname, "app", "index.html"), "utf8");
    check(!/unpkg\.com/.test(page) && /L\.markerClusterGroup|MarkerClusterGroup/.test(page), "app page bundles Leaflet and the cluster plugin");
    check(!/rel="manifest"/.test(page), "app page drops the web install links");
  }

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "siteless-"));
  let { app, win } = await launch(userData);
  const errors = [];
  win.on("pageerror", e => errors.push(String(e)));
  check(win.url() === "siteless://app/index.html", "serves the page from siteless://");
  check(await win.title() === "Siteless", "window is titled Siteless");
  check(await win.evaluate(() => !!window.sitelessApp && document.documentElement.classList.contains("desktop-app")), "page knows it runs in the desktop app");
  check(await win.evaluate(() => typeof L !== "undefined" && typeof L.markerClusterGroup === "function"), "Leaflet works without the internet");
  if (EXE) check(await app.evaluate(({ app }) => app.isPackaged && app.getName() === "Siteless" && app.getVersion() === "1.0.0"), "runs as the packaged Siteless 1.0.0");

  await win.click("#btnScan");
  await win.waitForSelector("#list .item");
  check((await win.locator("#list .item").count()) === 2, "scans and lists places");
  await shot(win, "app-list");

  // the app's file server only hands out its own two files
  const codes = await win.evaluate(async () => {
    const out = {};
    for (const u of ["siteless://app/icon.png", "siteless://app/main.js", "siteless://app/../main.js", "siteless://app/%2e%2e/main.js",
      "siteless://app/..%5Cmain.js", "siteless://other/index.html", "siteless://app/app/index.html"]) {
      try { out[u] = (await fetch(u)).status; } catch (e) { out[u] = "error"; }
    }
    return out;
  });
  check(codes["siteless://app/icon.png"] === 200 && Object.entries(codes).filter(([u]) => !u.endsWith("icon.png")).every(([, c]) => c === 404 || c === "error"),
    "serves only its own files: " + JSON.stringify(codes));

  await win.click("#btnSettings");
  check(/Application restrictions/.test(await win.locator("#keyStep4").innerText()), "explains the key setup for an app");
  await shot(win, "app-settings");
  await win.click("dialog .dlg-head button");

  // keyboard: J opens the next place, Esc goes back
  await win.evaluate(() => document.activeElement && document.activeElement.blur());
  await win.keyboard.press("j");
  await win.waitForSelector("#detailView:not([hidden]) .d-head h2");
  check(/1 of 2/.test(await win.locator("#dPos").innerText()), "keyboard shortcut J opens the first place");
  await win.keyboard.press("Escape");
  await settle(win);
  check(await win.locator("#listView").isVisible(), "Esc goes back to the list");

  // CSV download is saved as a file
  const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), "siteless-dl-"));
  await app.evaluate(({ session }, dir) => {
    session.defaultSession.on("will-download", (e, item) => item.setSavePath(dir + (process.platform === "win32" ? "\\" : "/") + item.getFilename()));
  }, dlDir);
  await win.click("#btnCsv");
  let csvFile = "";
  for (let i = 0; i < 50 && !csvFile; i++) { await win.waitForTimeout(100); csvFile = fs.readdirSync(dlDir).find(f => f.endsWith(".csv")) || ""; }
  const csv = csvFile ? fs.readFileSync(path.join(dlDir, csvFile), "utf8") : "";
  check(/^﻿Name,Website status,/.test(csv) && /Nonna Rosa/.test(csv), `CSV download is saved as a spreadsheet file (${csvFile || "none"})`);

  // dark mode follows the system theme
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = "dark"; });
  await win.waitForTimeout(300);
  check(await win.evaluate(() => getComputedStyle(document.body).backgroundColor) === "rgb(11, 16, 23)", "switches to dark mode with the system theme");
  await shot(win, "app-dark");
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = "light"; });
  await win.waitForTimeout(300);
  check(await win.evaluate(() => getComputedStyle(document.body).backgroundColor) === "rgb(233, 236, 240)", "switches back to light mode");

  // the smallest window still fits
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 600));
  await win.waitForTimeout(500);
  const size = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize());
  check(size[0] === 900 && size[1] === 600 && await noOverflow(win) && await win.locator("#btnScan").isVisible(), `fits the smallest window (${size.join("x")})`);
  await shot(win, "app-small-window");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));

  // links leave the app: patch shell.openExternal in the main process to record them
  await app.evaluate(({ shell }) => { global.__opened = []; shell.openExternal = url => { global.__opened.push(url); return Promise.resolve(); }; });
  await win.locator("#list .item").first().click();
  await shot(win, "app-place");
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

  // opening Siteless again brings the running window back instead of a second copy
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  await win.waitForTimeout(500);
  const second = spawn(EXE || require("electron"), appArgs(userData), { cwd: __dirname, stdio: "ignore" });
  const exited = await new Promise(r => { const t = setTimeout(() => r(false), 30000); second.on("exit", () => { clearTimeout(t); r(true); }); });
  await win.waitForTimeout(500);
  const state = await app.evaluate(({ BrowserWindow }) => ({ n: BrowserWindow.getAllWindows().length, min: BrowserWindow.getAllWindows()[0].isMinimized() }));
  check(exited && state.n === 1 && !state.min, `opening it again brings back the same window (${JSON.stringify({ secondExited: exited, ...state })})`);
  if (!exited) second.kill();

  await app.close();
  ({ app, win } = await launch(userData));
  await win.waitForSelector("#list .item");
  check(/★ Saved/.test(await win.locator("#list").innerText()), "places and leads are still there after restarting");
  check(errors.length === 0, "no script errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  await app.close();

  // Windows display scaling (125% to 200% is common on laptops)
  for (const scale of [1.5, 2]) {
    ({ app, win } = await launch(userData, [`--force-device-scale-factor=${scale}`]));
    await win.waitForSelector("#list .item");
    const dpr = await win.evaluate(() => devicePixelRatio);
    check(dpr === scale && await noOverflow(win) && await win.locator("#btnScan").isVisible(), `works at ${scale * 100}% display scaling`);
    await shot(win, `app-scale-${scale * 100}`);
    await app.close();
  }

  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(dlDir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Desktop app (${EXE ? "installed" : "from source"})\n\n` +
      results.map(([ok, m]) => `- ${ok ? "✅" : "❌"} ${m}`).join("\n") + "\n");
  }
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
