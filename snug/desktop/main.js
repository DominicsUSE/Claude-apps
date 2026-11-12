// Snug for Windows (and Mac, Linux): a desktop window around Snug.
//
// The app can work two ways, chosen on first run and changeable from the menu:
//   host  The Snug server runs inside this app, with its database in this
//         computer's app-data folder. Optionally other people on the same
//         network can join it from their browser or their own Snug app.
//   join  The window opens a Snug server that runs somewhere else.
const { app, BrowserWindow, Menu, clipboard, desktopCapturer, dialog, ipcMain, nativeTheme, session, shell } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const PORT = 47821;
const SETUP = pathToFileURL(path.join(__dirname, "setup.html")).toString();
const isMac = process.platform === "darwin";

app.setAppUserModelId("com.snug.app");

// Settings live in a small file next to the database.
const configPath = () => path.join(app.getPath("userData"), "desktop.json");
function readConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    if (c.mode === "host") return { mode: "host", lan: c.lan === true };
    if (c.mode === "join" && validUrl(c.url)) return { mode: "join", url: validUrl(c.url) };
  } catch { /* first run, or an unreadable file: ask again */ }
  return null;
}
function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  // Tray preferences (keepRunning, trayTipShown) survive a change of where Snug runs.
  fs.writeFileSync(configPath(), JSON.stringify({ ...trayPrefs(), ...cfg }, null, 2));
}
// Only http and https addresses, reduced to their origin.
function validUrl(input) {
  try {
    const raw = String(input || "").trim();
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch { return null; }
}

let win = null;
let server = null;      // the running in-app server, in host mode
let origin = null;      // the Snug address the window is allowed to show
let config = null;

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return null;
}

async function startHost(lan) {
  const { startServer } = await import(pathToFileURL(path.join(__dirname, "snug", "server", "index.js")).toString());
  const opts = { host: lan ? "0.0.0.0" : "127.0.0.1", dataDir: path.join(app.getPath("userData"), "data"), quiet: true };
  // The same address every launch keeps you signed in; fall back to any free port if it is taken.
  try { server = await startServer({ ...opts, port: PORT }); } catch (e) {
    if (e.code !== "EADDRINUSE") throw e;
    server = await startServer({ ...opts, port: 0 });
  }
  return `http://127.0.0.1:${server.port}`;
}
async function stopHost() {
  if (!server) return;
  const s = server;
  server = null;
  await s.close().catch(() => {});
}

// Open Snug according to the saved choice, or the setup page if there is none.
async function open(error) {
  await stopHost();
  origin = null;
  config = error ? null : readConfig();
  if (!config) {
    await win.loadURL(error ? `${SETUP}?error=${encodeURIComponent(error)}` : SETUP);
    buildMenu();
    return;
  }
  try {
    origin = config.mode === "host" ? await startHost(config.lan) : config.url;
  } catch (e) {
    return open(`Snug couldn’t start on this computer. ${e.message}`);
  }
  buildMenu();
  try {
    await win.loadURL(origin);
  } catch {
    if (config.mode === "join") return open(`Couldn’t reach ${config.url}. Check the address and your connection.`);
  }
  return undefined;
}

const external = (url) => { if (/^https?:/i.test(url)) shell.openExternal(url); };
const fromSnug = (url) => { try { return !!origin && new URL(url).origin === origin; } catch { return false; } };

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 380,
    minHeight: 560,
    title: "Snug",
    icon: path.join(__dirname, "snug", "icon.png"),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1b2420" : "#fbfcfb",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once("ready-to-show", () => win.show());
  // Links in messages open in the default browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (ev, url) => {
    if (fromSnug(url) || url.startsWith(SETUP)) return;
    ev.preventDefault();
    external(url);
  });
  win.on("closed", () => { win = null; });
  keepInTray(win); // closing hides to the tray (see "Running in the tray" below)
  open();
}

// Snug may use the microphone and camera (voice rooms), share a screen and
// show notifications. Nothing else, and only for the Snug address the window
// was opened on. The camera needs the person's say-so when the server is
// someone else's (join mode): asked once per address, each time the app runs.
// The server this app runs itself (host mode) is trusted like the app.
const cameraOk = new Set();      // origins allowed the camera this run
const cameraAsking = new Map();  // origin -> the question on screen
function askCamera(o) {
  if (config?.mode === "host" || cameraOk.has(o)) return Promise.resolve(true);
  if (!cameraAsking.has(o)) {
    const q = dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
      type: "question",
      buttons: ["Allow camera", "Don’t allow"],
      defaultId: 1,
      cancelId: 1,
      message: "Let this Snug turn on your camera?",
      detail: `${o} wants to use your camera. Snug only shares it while you have it turned on in a voice room.`,
    }).then(({ response }) => {
      if (response === 0) cameraOk.add(o);
      return response === 0;
    }, () => false).finally(() => cameraAsking.delete(o));
    cameraAsking.set(o, q);
  }
  return cameraAsking.get(o);
}
function permissions() {
  const allowed = new Set(["media", "notifications", "clipboard-sanitized-write", "fullscreen"]);
  session.defaultSession.setPermissionRequestHandler((wc, permission, done, details) => {
    const url = details.requestingUrl || wc.getURL();
    if (!allowed.has(permission) || !fromSnug(url)) return done(false);
    if (permission === "media" && (details.mediaTypes || []).includes("video")) {
      askCamera(new URL(url).origin).then(done, () => done(false));
      return undefined;
    }
    return done(true);
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    if (!allowed.has(permission) || !fromSnug(requestingOrigin)) return false;
    if (permission === "media" && details?.mediaType === "video") {
      return config?.mode === "host" || cameraOk.has(new URL(requestingOrigin).origin);
    }
    return true;
  });
  screenSharing();
}

// ---------- Screen sharing ----------
// The page asks with getDisplayMedia; the app answers with a small picker of
// screens and windows (on recent macOS, the system's own picker). Only the
// Snug page may ask. System sound comes along where Electron can capture it
// (Windows).
function screenSharing() {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    let answered = false;
    const answer = (streams) => { if (answered) return; answered = true; try { callback(streams); } catch { /* the page went away */ } };
    if (!fromSnug(request.securityOrigin || request.frame?.url || "")) return answer({});
    try {
      // Screens and windows are listed apart, each with a time limit: listing
      // windows can stall on some Linux desktops, and screens alone still work.
      const list = (types, ms) => Promise.race([
        desktopCapturer.getSources({ types, thumbnailSize: { width: 320, height: 180 } }).catch(() => []),
        new Promise((resolve) => setTimeout(() => resolve([]), ms)),
      ]);
      const [screens, windows] = await Promise.all([list(["screen"], 8000), list(["window"], 4000)]);
      const source = await pickSource([...screens, ...windows]);
      if (!source) return answer({});
      answer({ video: source, ...(request.audioRequested && process.platform === "win32" ? { audio: "loopback" } : {}) });
    } catch {
      answer({});
    }
    return undefined;
  }, { useSystemPicker: true });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// A plain window listing what can be shared, with thumbnails. Choosing one
// shares it; closing the window or Cancel shares nothing. The page has no
// bridge and no network: it reports the choice through its title.
function pickSource(sources) {
  if (!sources.length || !win) return Promise.resolve(null);
  const screens = sources.filter((s) => s.id.startsWith("screen:"));
  const windows = sources.filter((s) => !s.id.startsWith("screen:") && !s.thumbnail.isEmpty()).slice(0, 30);
  const list = [...screens, ...windows];
  const item = (s, i) => `<button data-i="${i}"><img alt="" src="data:image/jpeg;base64,${s.thumbnail.toJPEG(70).toString("base64")}"><span>${esc(screens.length === 1 && s.id.startsWith("screen:") ? "Entire screen" : s.name)}</span></button>`;
  const page = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Share your screen</title><style>
:root { color-scheme: dark; --bg: #141516; --bg2: #212324; --line: #393B3D; --text: #F4F1ED; --text2: #B8B4AE; }
@media (prefers-color-scheme: light) { :root { color-scheme: light; --bg: #FBFAF8; --bg2: #ECE9E4; --line: #CFCAC3; --text: #1A1817; --text2: #57534E; } }
* { box-sizing: border-box; } body { margin: 0; padding: 20px 24px; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, sans-serif; }
h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 13px; color: var(--text2); font-weight: 600; margin: 20px 0 8px; } p { margin: 0; color: var(--text2); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
button[data-i] { display: grid; gap: 6px; padding: 8px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: var(--text); text-align: left; font: inherit; cursor: pointer; }
button[data-i]:hover { background: var(--bg2); }
button:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
img { width: 100%; aspect-ratio: 16 / 9; object-fit: contain; background: var(--bg2); border-radius: 6px; }
span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.foot { display: flex; justify-content: flex-end; margin-top: 20px; }
.cancel { height: 40px; padding: 0 16px; border-radius: 6px; border: 0; background: var(--bg2); color: var(--text); font: inherit; cursor: pointer; }
</style></head><body>
<h1>Share your screen</h1><p>Everyone in the voice room will see what you choose.</p>
${screens.length ? `<h2>Screens</h2><div class="grid">${screens.map((s) => item(s, list.indexOf(s))).join("")}</div>` : ""}
${windows.length ? `<h2>Windows</h2><div class="grid">${windows.map((s) => item(s, list.indexOf(s))).join("")}</div>` : ""}
<div class="foot"><button class="cancel">Cancel</button></div>
<script>
document.addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; document.title = b.dataset.i != null ? "pick:" + b.dataset.i : "cancel"; });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") document.title = "cancel"; });
document.querySelector("button[data-i]")?.focus();
</script></body></html>`;
  return new Promise((resolve) => {
    const picker = new BrowserWindow({
      parent: win, modal: true, width: 760, height: 560, minWidth: 420, minHeight: 360,
      title: "Share your screen", autoHideMenuBar: true, show: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#141516" : "#FBFAF8",
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    let done = false;
    const finish = (source) => { if (done) return; done = true; resolve(source); if (!picker.isDestroyed()) picker.close(); };
    picker.webContents.on("will-navigate", (e) => e.preventDefault());
    picker.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    picker.webContents.on("page-title-updated", (e, title) => {
      if (title === "cancel") finish(null);
      else if (title.startsWith("pick:")) finish(list[Number(title.slice(5))] || null);
    });
    picker.on("closed", () => finish(null));
    picker.once("ready-to-show", () => picker.show());
    picker.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`).catch(() => finish(null));
  });
}

function buildMenu() {
  const hosting = config?.mode === "host";
  const shared = hosting && config.lan && lanAddress() && server;
  const snug = {
    label: "Snug",
    submenu: [
      { label: "Change where Snug runs…", click: () => { try { fs.writeFileSync(configPath(), JSON.stringify(trayPrefs(), null, 2)); } catch { /* already gone */ } open(); } },
      ...(shared ? [{
        label: "Copy the address for other people",
        click: () => {
          const address = `http://${lanAddress()}:${server.port}`;
          clipboard.writeText(address);
          dialog.showMessageBox(win, { type: "info", message: "Address copied", detail: `${address}\n\nPeople on the same network can open it in a browser, or choose “Join a Snug” in their own Snug app. Voice needs a secure (https) address, so over this address they can write but not talk.` });
        },
      }] : []),
      ...(hosting ? [{ label: "Open the data folder", click: () => shell.openPath(path.join(app.getPath("userData"), "data")) }] : []),
      { label: "Keep Snug running when the window is closed", type: "checkbox", checked: trayPrefs().keepRunning, click: (item) => setKeepRunning(item.checked) },
      { type: "separator" },
      { role: "quit" },
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
  const template = isMac ? [{ role: "appMenu" }, snug, { role: "editMenu" }, view, { role: "windowMenu" }] : [snug, { role: "editMenu" }, view];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- Running in the tray (notifications agent) ----------
// Closing the window hides it and Snug keeps running in the system tray, so
// its socket stays open and notifications keep arriving (the page shows them
// with the Notification API while hidden). Quit from the tray or the menu
// stops the server cleanly (before-quit below). The setting lives in
// desktop.json as keepRunning (default on); the first close says where Snug went.
const { Tray, nativeImage, Notification: NativeNotification } = require("electron");
let tray = null;
let quitting = false;

function trayPrefs() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(configPath(), "utf8")) || {}; } catch { /* first run */ }
  return { keepRunning: raw.keepRunning !== false, trayTipShown: raw.trayTipShown === true };
}
function saveTrayPrefs(patch) {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(configPath(), "utf8")) || {}; } catch { /* first run */ }
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify({ ...raw, ...patch }, null, 2));
}

function showWindow() {
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function trayIcon() {
  const brand = path.join(__dirname, "snug", "brand");
  if (isMac) {
    // A template image: macOS draws it in the menu bar's own colour.
    const img = nativeImage.createFromPath(path.join(brand, "notify-badge.png")).resize({ width: 18, height: 18 });
    img.setTemplateImage(true);
    return img;
  }
  const size = process.platform === "win32" ? 16 : 22;
  return nativeImage.createFromPath(path.join(brand, "app-icon-192.png")).resize({ width: size, height: size });
}

function syncTray() {
  if (!trayPrefs().keepRunning) { tray?.destroy(); tray = null; globalThis.snugTrayMenu = null; return; }
  if (tray) return;
  try { tray = new Tray(trayIcon()); } catch { tray = null; return; }
  tray.setToolTip("Snug");
  const menu = Menu.buildFromTemplate([
    { label: "Open Snug", click: showWindow },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", showWindow);
  globalThis.snugTrayMenu = menu; // desktop/test.js presses Quit through this
}

function setKeepRunning(on) {
  saveTrayPrefs({ keepRunning: !!on });
  syncTray();
  buildMenu();
  return !!on;
}

function keepInTray(w) {
  syncTray();
  // The page asks this, not only document.visibilityState, before choosing a pop-up or a notification.
  const tell = (hidden) => { if (!w.isDestroyed()) w.webContents.send("window:visibility", hidden); };
  w.on("hide", () => tell(true));
  w.on("minimize", () => tell(true));
  w.on("show", () => tell(w.isMinimized()));
  w.on("restore", () => tell(false));
  w.on("close", (e) => {
    if (quitting || !trayPrefs().keepRunning) return;
    e.preventDefault();
    w.hide();
    if (!trayPrefs().trayTipShown) {
      saveTrayPrefs({ trayTipShown: true });
      if (NativeNotification.isSupported()) {
        const n = new NativeNotification({
          title: "Snug is still running",
          body: `It’s in the ${isMac ? "menu bar" : "system tray"}, so notifications keep arriving. To stop it, choose Quit there. You can change this in the Snug menu.`,
          silent: true,
        });
        n.on("click", showWindow);
        n.show();
      }
    }
  });
}

app.on("before-quit", () => { quitting = true; });
app.on("activate", () => { if (win && !win.isVisible()) showWindow(); });

// The Snug page's only bridge (preload.js, window.snugApp): show this window
// (a notification was clicked) and read or change the keep-running setting.
ipcMain.on("window:show", (e) => { if (fromSnug(e.senderFrame.url)) showWindow(); });
ipcMain.handle("keep:get", (e) => (fromSnug(e.senderFrame.url) ? trayPrefs().keepRunning : null));
// An incoming call: bring the window up, from the tray if it is there, flash
// it in the taskbar, and show a system notification that opens it. The page
// shows the incoming-call screen itself (Accept, Decline). The window comes
// up without taking the focus: a Space or Enter typed in another app must not
// land on Accept. When the ring stops (answered, declined, missed) the page
// says so and the notification goes. The last few are recorded in
// globalThis.snugCallNotes for the desktop test.
globalThis.snugCallNotes = [];
const callNotes = new Map(); // conversation -> its ring's notification
globalThis.snugCallNotesOpen = () => callNotes.size; // for the desktop test
function closeCallNote(dm) {
  const n = callNotes.get(dm);
  callNotes.delete(dm);
  if (n) { try { n.close(); } catch { /* already gone */ } }
  if (!callNotes.size) { try { win?.flashFrame(false); } catch { /* not on every system */ } }
}
ipcMain.on("call:incoming", (e, info) => {
  if (!fromSnug(e.senderFrame.url)) return;
  const dm = String(info?.dm || "").slice(0, 80);
  const title = String(info?.title || "Someone is calling").slice(0, 120);
  const body = String(info?.body || "").slice(0, 160);
  globalThis.snugCallNotes.push({ title, body });
  if (globalThis.snugCallNotes.length > 20) globalThis.snugCallNotes.shift();
  if (!win) createWindow();
  else if (!win.isVisible()) win.showInactive();
  try { win?.flashFrame(true); } catch { /* not on every system */ }
  if (NativeNotification.isSupported()) {
    closeCallNote(dm);
    const n = new NativeNotification({ title, body, silent: true, urgency: "critical" });
    n.on("click", () => { closeCallNote(dm); showWindow(); });
    // Keep the handle when the toast leaves the screen ("close" fires then on
    // Windows): the ring's end must still remove it from the notification centre.
    callNotes.set(dm, n);
    // At most a handful ring at once; never let the map grow.
    while (callNotes.size > 8) closeCallNote(callNotes.keys().next().value);
    n.show();
  }
});
ipcMain.on("call:over", (e, info) => {
  if (!fromSnug(e.senderFrame.url)) return;
  closeCallNote(String(info?.dm || "").slice(0, 80));
});
ipcMain.handle("keep:set", (e, on) => (fromSnug(e.senderFrame.url) ? setKeepRunning(on === true) : null));
// ---------- end running in the tray ----------

// The setup page asks for the current choice and saves a new one.
ipcMain.handle("config:get", (e) => (e.senderFrame.url.startsWith(SETUP) ? { config: readConfig(), lan: lanAddress() } : null));
ipcMain.handle("config:save", async (e, cfg) => {
  if (!e.senderFrame.url.startsWith(SETUP)) return { error: "Not allowed." };
  if (cfg?.mode === "host") writeConfig({ mode: "host", lan: cfg.lan === true });
  else if (cfg?.mode === "join") {
    const url = validUrl(cfg.url);
    if (!url) return { error: "That doesn’t look like an address. Try something like snug.example.com." };
    writeConfig({ mode: "join", url });
  } else return { error: "Choose one of the two." };
  setImmediate(() => open());
  return {};
});

// One window and one database: opening Snug again brings the running one to the front.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.whenReady().then(() => {
    permissions();
    createWindow();
    app.on("activate", () => { if (!win) createWindow(); });
  });
  app.on("window-all-closed", () => { if (!isMac) app.quit(); });
  // Close the database cleanly before the app goes.
  let closing = false;
  app.on("before-quit", (e) => {
    if (closing || !server) return;
    e.preventDefault();
    closing = true;
    stopHost().finally(() => app.quit());
  });
}
