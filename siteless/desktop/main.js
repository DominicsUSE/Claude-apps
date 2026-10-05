// Siteless for Windows (and Mac): a desktop window around the Siteless page.
// The page is served from the siteless:// scheme, which gives it its own origin (so saved
// places and leads persist) and lets Google, OpenStreetMap and PageSpeed answer it directly.
// Google Maps, directions, websites, email and phone links open in the computer's default apps.
const { app, BrowserWindow, ipcMain, Menu, nativeTheme, net, protocol, session, shell } = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");

const APP_DIR = path.join(__dirname, "app");
const START = "siteless://app/index.html";
const isMac = process.platform === "darwin";

protocol.registerSchemesAsPrivileged([
  { scheme: "siteless", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

// The app only has two files, so serve exactly those: no path from a URL ever reaches the disk.
const FILES = { "/": "index.html", "/index.html": "index.html", "/icon.png": "icon.png" };
function handle(req) {
  const url = new URL(req.url);
  const name = url.host === "app" && Object.hasOwn(FILES, url.pathname) ? FILES[url.pathname] : null;
  if (!name) return new Response("Not found", { status: 404 });
  return net.fetch(pathToFileURL(path.join(APP_DIR, name)).toString());
}

const external = (url) => { if (/^(https?|mailto|tel|sms):/i.test(url)) shell.openExternal(url); };

let win = null;
function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Siteless",
    icon: path.join(APP_DIR, "icon.png"),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0b1017" : "#e9ecf0",
    autoHideMenuBar: true,
    ...(isMac ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 13 } } : {}),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once("ready-to-show", () => win.show());
  // new windows (Google Maps, routes, websites) open in the default browser
  win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (ev, url) => {
    if (!url.startsWith("siteless://")) { ev.preventDefault(); external(url); }
  });
  // tell the page the computer's light or dark theme, now and whenever it changes
  const sendTheme = () => { if (win && !win.isDestroyed()) win.webContents.send("theme", nativeTheme.shouldUseDarkColors ? "dark" : "light"); };
  win.webContents.on("dom-ready", sendTheme);
  nativeTheme.on("updated", sendTheme);
  win.on("closed", () => { nativeTheme.removeListener("updated", sendTheme); win = null; });
  win.loadURL(START);
}

function buildMenu() {
  const help = {
    role: "help",
    submenu: [
      { label: "Get a Google Maps API key", click: () => shell.openExternal("https://console.cloud.google.com/apis/credentials") },
      { label: "Google Maps Platform pricing", click: () => shell.openExternal("https://developers.google.com/maps/billing-and-pricing/pricing") },
      { type: "separator" },
      { label: "Siteless on GitHub", click: () => shell.openExternal("https://github.com/DominicsUSE/Claude-apps") },
    ],
  };
  const view = {
    label: "View",
    submenu: [
      { role: "reload" }, { type: "separator" },
      { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" },
      { role: "togglefullscreen" },
    ],
  };
  const template = isMac
    ? [{ role: "appMenu" }, { role: "fileMenu" }, { role: "editMenu" }, view, { role: "windowMenu" }, help]
    : [{ role: "fileMenu" }, { role: "editMenu" }, view, help];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// one window: opening Siteless again brings the running one to the front and the new copy quits
const firstCopy = app.requestSingleInstanceLock();
if (!firstCopy) app.quit();
app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });

// OpenStreetMap's Overpass servers turn away requests that come from a web page with an unknown
// origin, and ask apps to say who they are. So the app sends these requests itself, from here,
// with its own name, and hands the answer to the page. Only these servers can be asked.
const OVERPASS = new Set(["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]);
const pending = new Map();   // request id -> AbortController
async function overpass(e, id, url, body) {
  if (!OVERPASS.has(url) || typeof body !== "string" || body.length > 100000) return { status: 400, text: "" };
  const ctl = new AbortController();
  pending.set(id, ctl);
  try {
    const res = await net.fetch(url, {
      method: "POST", body, signal: ctl.signal,
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": `Siteless/${app.getVersion()} (Windows desktop app; https://github.com/DominicsUSE/Claude-apps)` },
    });
    return { status: res.status, text: await res.text() };
  } catch (err) {
    return { status: 0, text: "", aborted: ctl.signal.aborted };
  } finally { pending.delete(id); }
}

// "Does this place really have no website?" (see verify.js). Pages are fetched like a normal browser
// would, read up to 2 MB, and given up on after the timeout.
const { findWebsite } = require("./verify");
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
async function getPage(url, { timeout = 8000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await net.fetch(url, { signal: ctl.signal, headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en;q=0.9,*;q=0.5", Accept: "text/html,*/*;q=0.8" } });
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: res.ok, status: res.status, url: res.url, text: buf.subarray(0, 2e6).toString("utf8") };
  } finally { clearTimeout(t); }
}
async function findSite(e, place) {
  if (!place || typeof place.name !== "string" || place.name.length > 200) return { url: null, searched: false };
  const clean = k => (typeof place[k] === "string" ? place[k].slice(0, 120) : "");
  try { return await findWebsite({ name: clean("name"), city: clean("city"), street: clean("street"), area: clean("area"), phone: clean("phone"), tld: /^[a-z]{2,3}$/.test(place.tld) ? place.tld : "" }, getPage); }
  catch (err) { return { url: null, searched: false }; }
}

app.setName("Siteless");
if (process.platform === "win32") app.setAppUserModelId("com.siteless.app");
if (firstCopy) app.whenReady().then(() => {
  protocol.handle("siteless", handle);
  ipcMain.handle("overpass", overpass);
  ipcMain.handle("find-website", findSite);
  ipcMain.on("overpass-cancel", (e, id) => { const c = pending.get(id); if (c) c.abort(); });
  // only the app's own page may use location and the clipboard; embedded Google maps get nothing
  session.defaultSession.setPermissionRequestHandler((wc, permission, done, details) => {
    const ours = String(details.requestingUrl || "").startsWith("siteless://");
    done(ours && ["clipboard-sanitized-write", "fullscreen"].includes(permission));
  });
  buildMenu();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (!isMac) app.quit(); });
