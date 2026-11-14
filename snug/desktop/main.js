// Snug for Windows (and Mac, Linux): a desktop window around Snug.
//
// The app can work two ways, chosen on first run and changeable from the menu:
//   host  The Snug server runs inside this app, with its database in this
//         computer's app-data folder. Optionally other people on the same
//         network can join it from their browser or their own Snug app.
//   join  The window opens a Snug server that runs somewhere else.
const { app, BrowserWindow, Menu, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, nativeTheme, session, shell } = require("electron");
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

// p2p: the Snug registry and GitHub sign-in (snug/server/peer.js). Empty until deployed: empty means P2P is off.
const DEFAULT_REGISTRY_URL = "";
const DEFAULT_GITHUB_CLIENT_ID = "";
// Env overrides only for an unpackaged app or with --dev-registry (S20), and only https or this machine.
function p2pConfig() {
  const dev = !app.isPackaged || process.argv.includes("--dev-registry");
  const pick = (env, def) => (dev && process.env[env]) || def;
  const okUrl = (u) => {
    try { const x = new URL(u); return x.protocol === "https:" || (x.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(x.hostname)) ? x.origin : null; } catch { return null; }
  };
  return {
    registryUrl: okUrl(pick("SNUG_REGISTRY_URL", DEFAULT_REGISTRY_URL)),
    githubClientId: pick("SNUG_GITHUB_CLIENT_ID", DEFAULT_GITHUB_CLIENT_ID) || null,
    githubBase: okUrl(pick("SNUG_GITHUB_URL", "https://github.com")) || "https://github.com",
  };
}
// The device keys are wrapped with the OS key store, checked each time it is used (F13).
const keyStore = {
  available: () => {
    const { safeStorage } = require("electron");
    try { return safeStorage.isEncryptionAvailable() && (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"); } catch { return false; }
  },
  encrypt: (str) => require("electron").safeStorage.encryptString(str).toString("base64"),
  decrypt: (b64) => require("electron").safeStorage.decryptString(Buffer.from(b64, "base64")),
};
// A per-launch secret in an httpOnly cookie lets this window sign back in after signing out (F5).
const resumeSecret = require("crypto").randomBytes(32).toString("base64url");

async function startHost(lan) {
  const { startServer } = await import(pathToFileURL(path.join(__dirname, "snug", "server", "index.js")).toString());
  const { net } = require("electron");
  const opts = {
    host: lan ? "0.0.0.0" : "127.0.0.1", dataDir: path.join(app.getPath("userData"), "data"), quiet: true,
    ...p2pConfig(), keyStore, fetch: net.fetch.bind(net), resumeSecret, // p2p
  };
  // The same address every launch keeps you signed in; fall back to any free port if it is taken.
  try { server = await startServer({ ...opts, port: PORT }); } catch (e) {
    if (e.code !== "EADDRINUSE") throw e;
    server = await startServer({ ...opts, port: 0 });
  }
  globalThis.snugHostForTest = () => server; // p2p: the desktop test reaches the in-app server's peer module
  // p2p: the resume cookie for this server's origin, on the window's session.
  try { await session.defaultSession.cookies.set({ url: `http://127.0.0.1:${server.port}`, name: "snug_resume", value: resumeSecret, httpOnly: true, sameSite: "strict" }); } catch { /* resume just won't be offered */ }
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
  const place = savedPlace(); // where the window was last time, if that is still on a screen (desktop shell, below)
  globalThis.snugStartColor = shellPrefs().themeColor; // the theme's colour from last time (desktop shell, below)
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    ...place.bounds,
    minWidth: 380,
    minHeight: 560,
    title: "Snug",
    icon: path.join(__dirname, "snug", "icon.png"),
    backgroundColor: shellPrefs().themeColor || (nativeTheme.shouldUseDarkColors ? "#0E0F10" : "#E9E6E1"),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once("ready-to-show", () => {
    if (place.maximized) win.maximize();
    // Started at login, or "Start minimised": stay in the tray (or the taskbar, with no tray).
    if (startHidden) { startHidden = false; if (!tray) win.minimize(); return; }
    win.show();
  });
  shellWindow(win); // window size and place, minimise to tray, flash on mention (desktop shell, below)
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
      { role: "togglefullscreen" }, { type: "separator" },
      // Streamer mode (snug/js/views/account.js): hides usernames, codes and notification text.
      { label: "Streamer mode", accelerator: "CmdOrCtrl+Shift+S", click: () => { win?.webContents.executeJavaScript("window.snug?.toggleStreamer?.()").catch(() => {}); } },
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

// ---------- push to talk while Snug isn't in front ----------
// The Snug page asks for one key (an Electron accelerator built from a plain
// key, js/views/voiceopts.js) while it is in a call in push-to-talk mode, and
// null to let it go. The system reports presses only (and repeats while the
// key is held), so the page keeps the microphone open while presses keep
// coming. Only single keys from a fixed list are accepted: never a shortcut
// another app or the system could depend on.
const PTT_KEY = /^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|num[0-9]|Space|Capslock|Scrolllock|Pause|Insert|Home|End|PageUp|PageDown|[`\-=[\]\;',./])$/;
let pttKey = null;
let pttFrom = null;
globalThis.snugPushToTalk = () => pttKey; // for the desktop test
function releasePtt() {
  if (pttKey) { try { globalShortcut.unregister(pttKey); } catch { /* already gone */ } }
  pttKey = null;
  pttFrom = null;
}
ipcMain.handle("ptt:set", (e, key) => {
  if (!fromSnug(e.senderFrame.url)) return false;
  if (key != null && (typeof key !== "string" || !PTT_KEY.test(key))) return false;
  releasePtt();
  if (key == null) return true;
  let ok = false;
  try { ok = globalShortcut.register(key, () => { if (pttFrom && !pttFrom.isDestroyed()) pttFrom.send("ptt:press"); }); } catch { ok = false; }
  if (ok) { pttKey = key; pttFrom = e.sender; e.sender.once("destroyed", releasePtt); }
  return ok;
});
app.on("will-quit", () => { try { globalShortcut.unregisterAll(); } catch { /* quitting */ } });
// ---------- end push to talk ----------
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
  app.on("second-instance", (_e, argv) => {
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
    deepLinkFrom(argv); // snug://join/... or snug://open/... (desktop shell, below)
  });
  app.whenReady().then(() => {
    permissions();
    shellReady(); // snug:// links, idle and lock, the update check (desktop shell, below)
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

// ---------- Desktop shell: settings, window place, badge, global voice keys, idle, snug:// links, updates ----------
// Settings live in desktop.json next to keepRunning. Everything the Snug page
// sends is checked here again; only the Snug page (fromSnug) may ask.
const { screen, powerMonitor } = require("electron");
const SHELL_DEFAULTS = { openAtLogin: false, startMinimized: false, minimizeToTray: false, hardwareAcceleration: true, updateCheck: true };
const HEX = /^#[0-9a-fA-F]{6}$/;
function rawConfig() { try { return JSON.parse(fs.readFileSync(configPath(), "utf8")) || {}; } catch { return {}; } }
function shellPrefs() {
  const raw = rawConfig();
  const out = { ...SHELL_DEFAULTS };
  for (const k of Object.keys(SHELL_DEFAULTS)) if (typeof raw[k] === "boolean") out[k] = raw[k];
  out.voiceKeys = { mute: validAccel(raw.voiceKeys?.mute) ? raw.voiceKeys.mute : null, deafen: validAccel(raw.voiceKeys?.deafen) ? raw.voiceKeys.deafen : null };
  out.themeColor = HEX.test(raw.themeColor || "") ? raw.themeColor : null;
  return out;
}
const publicPrefs = () => { const p = shellPrefs(); delete p.themeColor; return p; };

// Hardware acceleration can only change before the app is ready: it applies on the next start.
if (rawConfig().hardwareAcceleration === false) app.disableHardwareAcceleration();
// Opened at login with --hidden, or "Start minimised": the window waits in the tray.
let startHidden = process.argv.includes("--hidden") || rawConfig().startMinimized === true;

function applyLoginItem(on) {
  globalThis.snugLoginItem = !!on; // for the desktop test (Linux has no login items)
  try { app.setLoginItemSettings({ openAtLogin: !!on, args: ["--hidden"] }); } catch { /* not on every system */ }
}

ipcMain.handle("desktop:get", (e) => (fromSnug(e.senderFrame.url) ? publicPrefs() : null));
ipcMain.handle("desktop:set", (e, patch) => {
  if (!fromSnug(e.senderFrame.url)) return { error: "Not allowed." };
  if (!patch || typeof patch !== "object") return { error: "Nothing to change." };
  const next = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in SHELL_DEFAULTS)) return { error: `${k} isn’t a desktop setting.` };
    if (typeof v !== "boolean") return { error: `${k} is on or off.` };
    next[k] = v;
  }
  saveTrayPrefs(next);
  if ("openAtLogin" in next) applyLoginItem(next.openAtLogin);
  buildShellMenu();
  return { settings: publicPrefs() };
});
ipcMain.on("app:restart", (e) => {
  if (!fromSnug(e.senderFrame.url)) return;
  app.relaunch();
  app.quit();
});

// ---------- Window size and place ----------
// Saved a moment after it changes; restored only if it still meets a screen.
function savedPlace() {
  const raw = rawConfig();
  const b = raw.bounds;
  const ok = b && [b.x, b.y, b.width, b.height].every(Number.isFinite) && b.width >= 380 && b.height >= 560;
  if (!ok) return { bounds: {}, maximized: raw.maximized === true };
  let areas = [];
  try { areas = screen.getAllDisplays().map((d) => d.workArea); } catch { /* before ready */ }
  // At least 64 by 64 pixels of the window on some screen's work area.
  const meets = areas.some((a) => Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x) >= 64 && Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y) >= 64);
  globalThis.snugPlaceRestored = meets; // for the desktop test
  if (!meets) return { bounds: { width: Math.round(b.width), height: Math.round(b.height), center: true }, maximized: raw.maximized === true };
  return { bounds: { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }, maximized: raw.maximized === true };
}
function shellWindow(w) {
  let timer = null;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (w.isDestroyed() || w.isMinimized() || w.isFullScreen()) return;
      const maximized = w.isMaximized();
      saveTrayPrefs(maximized ? { maximized } : { maximized, bounds: w.getNormalBounds() });
    }, 400);
  };
  for (const ev of ["resize", "move", "maximize", "unmaximize"]) w.on(ev, save);
  w.on("close", () => { if (!w.isDestroyed() && !w.isMinimized()) saveTrayPrefs({ maximized: w.isMaximized(), bounds: w.getNormalBounds() }); });
  // Minimise to the tray: the window hides; the tray brings it back.
  w.on("minimize", (e) => {
    if (!shellPrefs().minimizeToTray || !tray) return;
    e.preventDefault();
    w.hide();
  });
  w.on("focus", () => { try { w.flashFrame(false); } catch { /* not on every system */ } });
}

// ---------- The window's colour follows the Snug theme ----------
ipcMain.handle("theme:color", (e, hex) => {
  if (!fromSnug(e.senderFrame.url) || typeof hex !== "string" || !HEX.test(hex)) return false;
  if (win && !win.isDestroyed()) win.setBackgroundColor(hex);
  if (rawConfig().themeColor !== hex) saveTrayPrefs({ themeColor: hex });
  return true;
});

// ---------- The unread number on the icon, and a flash for a new mention ----------
// macOS and Linux: the app's badge count. Windows: an overlay drawn here from
// the number (no image files), described as "n unread". The tray tooltip says
// it too. A higher number while the window isn't focused flashes it.
globalThis.snugBadgeLog = [];
globalThis.snugFlashLog = [];
let badgeNow = 0;
const DIGITS = { 0: "111101101101111", 1: "010110010010111", 2: "111001111100111", 3: "111001111001111", 4: "101101111001001", 5: "111100111001111", 6: "111100111101111", 7: "111001001001001", 8: "111101111101111", 9: "111101111001111", "+": "000010111010000" };
function badgeImage(n) {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  const put = (x, y, [r, g, b, a]) => { if (x < 0 || y < 0 || x >= size || y >= size) return; const i = (y * size + x) * 4; buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = a; };
  // A violet disc (Brand Violet, the dark --brand #8656F0: the count is for
  // you) with white digits (4.56:1).
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const dx = x - 7.5, dy = y - 7.5; if (dx * dx + dy * dy <= 56) put(x, y, [0x86, 0x56, 0xF0, 255]); }
  const text = n > 9 ? "9+" : String(n);
  const w = text.length * 4 - 1;
  let x0 = Math.floor((size - w) / 2);
  for (const ch of text) {
    const g = DIGITS[ch];
    for (let i = 0; i < 15; i++) if (g[i] === "1") put(x0 + (i % 3), 5 + Math.floor(i / 3), [0xFF, 0xFF, 0xFF, 255]);
    x0 += 4;
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}
ipcMain.on("badge:set", (e, raw) => {
  if (!fromSnug(e.senderFrame.url)) return;
  const n = Number.isInteger(raw) ? Math.max(0, Math.min(999, raw)) : 0;
  const before = badgeNow;
  badgeNow = n;
  let method = "count";
  if (process.platform === "win32") {
    method = "overlay";
    try { win?.setOverlayIcon(n ? badgeImage(n) : null, n ? `${n} unread` : ""); } catch { /* no taskbar */ }
  } else {
    try { app.setBadgeCount(n); } catch { /* not on every system */ }
  }
  globalThis.snugBadgeLog.push({ n, method });
  if (globalThis.snugBadgeLog.length > 50) globalThis.snugBadgeLog.shift();
  try { tray?.setToolTip(n ? `Snug: ${n} for you` : "Snug"); } catch { /* tray gone */ }
  if (n > before && win && !win.isDestroyed() && !win.isFocused()) {
    try { win.flashFrame(true); } catch { /* not on every system */ }
    globalThis.snugFlashLog.push(n);
    if (globalThis.snugFlashLog.length > 50) globalThis.snugFlashLog.shift();
  }
});
globalThis.snugBadgeImage = (n) => badgeImage(n).toBitmap().length; // for the desktop test: drawn at run time

// ---------- Global mute and deafen keys while in voice ----------
// The page saves two accelerators (one or two modifiers and one key) and says
// when it is in voice; only then are they registered. A press goes to the
// Snug page, which toggles mute or deafen. Taken keys and clashes are reported.
const ACCEL_MODS = new Set(["CommandOrControl", "Control", "Ctrl", "Command", "Cmd", "Alt", "Option", "Shift", "Super", "Meta"]);
const ACCEL_KEY = /^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|num[0-9]|[`\-=[\];',./\\])$/;
function validAccel(acc) {
  if (typeof acc !== "string" || acc.length > 60) return false;
  const parts = acc.split("+");
  const key = parts.pop();
  if (!ACCEL_KEY.test(key || "") || parts.length < 1 || parts.length > 2 || new Set(parts).size !== parts.length) return false;
  if (!parts.every((p) => ACCEL_MODS.has(p))) return false;
  // A global shortcut takes the key from every other app: with one modifier,
  // only F-keys and the number pad (never Ctrl+C or Shift+/), and never Alt+F4.
  if (parts.length === 1 && !/^(?:F\d{1,2}|num\d)$/.test(key)) return false;
  if (key === "F4" && parts.some((p) => p === "Alt" || p === "Option")) return false;
  return true;
}
let voiceKeysOn = new Map(); // which -> accelerator registered now
let voiceFrom = null;
globalThis.snugVoiceKeys = () => Object.fromEntries(voiceKeysOn);
function releaseVoiceKeys() {
  for (const acc of voiceKeysOn.values()) { try { globalShortcut.unregister(acc); } catch { /* gone */ } }
  voiceKeysOn = new Map();
}
function registerVoiceKeys(sender) {
  releaseVoiceKeys();
  voiceFrom = sender;
  const keys = shellPrefs().voiceKeys;
  const out = { mute: null, deafen: null };
  for (const which of ["mute", "deafen"]) {
    const acc = keys[which];
    if (!acc) continue;
    if (acc === pttKey) { out[which] = "That’s your push-to-talk key."; continue; }
    let ok = false;
    try { ok = globalShortcut.register(acc, () => { if (voiceFrom && !voiceFrom.isDestroyed()) voiceFrom.send("voice:toggle", which); }); } catch { ok = false; }
    if (ok) { voiceKeysOn.set(which, acc); out[which] = true; } else out[which] = "Another app is using that shortcut.";
  }
  return out;
}
ipcMain.handle("voicekeys:set", (e, keys) => {
  if (!fromSnug(e.senderFrame.url) || !keys || typeof keys !== "object") return { ok: false, errors: { mute: "Not allowed." } };
  const want = { mute: keys.mute ?? null, deafen: keys.deafen ?? null };
  const errors = {};
  for (const which of ["mute", "deafen"]) if (want[which] !== null && !validAccel(want[which])) errors[which] = "Use two of Ctrl, Alt, Shift with one key, or one with an F key.";
  if (want.mute && want.mute === want.deafen) errors.deafen = "Mute and deafen need different shortcuts.";
  if (Object.keys(errors).length) return { ok: false, errors };
  saveTrayPrefs({ voiceKeys: want });
  // In voice now: swap them at once, and report anything taken.
  const live = voiceKeysOn.size > 0 || voiceFrom;
  const result = live && voiceFrom && !voiceFrom.isDestroyed() ? registerVoiceKeys(voiceFrom) : {};
  for (const which of ["mute", "deafen"]) if (typeof result[which] === "string") errors[which] = result[which];
  return { ok: true, keys: want, errors };
});
ipcMain.handle("voicekeys:active", (e, on) => {
  if (!fromSnug(e.senderFrame.url)) return null;
  if (on !== true) { releaseVoiceKeys(); voiceFrom = null; return {}; }
  e.sender.once("destroyed", () => { releaseVoiceKeys(); voiceFrom = null; });
  return registerVoiceKeys(e.sender);
});

// ---------- The computer idle, locked or asleep ----------
let idleSaid = false;
function tellIdle(state) {
  if (!win || win.isDestroyed() || !fromSnug(win.webContents.getURL())) return;
  win.webContents.send("system:idle", state);
}
globalThis.snugTellIdle = tellIdle; // for the desktop test
function watchIdle() {
  for (const [ev, state] of [["lock-screen", "locked"], ["unlock-screen", "unlocked"], ["suspend", "suspend"], ["resume", "resume"]]) {
    try { powerMonitor.on(ev, () => tellIdle(state)); } catch { /* not on every system */ }
  }
  // p2p: after sleep or a locked screen, reconnect to the registry at once (F12).
  for (const ev of ["resume", "unlock-screen"]) { try { powerMonitor.on(ev, () => server?.peer?.wake()); } catch { /* not on every system */ } }
  const t = setInterval(() => {
    let secs = 0;
    try { secs = powerMonitor.getSystemIdleTime(); } catch { return; }
    // Five minutes without input anywhere is idle; any input again is active.
    if (secs >= 300 && !idleSaid) { idleSaid = true; tellIdle("idle"); } else if (secs < 300 && idleSaid) { idleSaid = false; tellIdle("active"); }
  }, 30_000);
  t.unref?.();
}

// ---------- snug:// links ----------
// Only snug://join/<code> and snug://open/<place>[/<message>]; the page checks again.
function parseLink(raw) {
  if (typeof raw !== "string" || raw.length > 300) return null;
  const m = /^snug:\/\/([a-z]+)\/([^?#]*)$/i.exec(raw.trim());
  if (!m) return null;
  const kind = m[1].toLowerCase();
  const parts = m[2].replace(/\/$/, "").split("/");
  if (parts.some((p) => p === "")) return null;
  if (kind === "join" && parts.length === 1 && /^[\w-]{6,40}$/.test(parts[0])) return `snug://join/${parts[0]}`;
  if (kind === "open" && parts.length <= 2 && /^[\w:.-]{1,80}$/.test(parts[0]) && (parts.length === 1 || /^[\w.-]{1,80}$/.test(parts[1]))) return `snug://open/${parts.join("/")}`;
  return null;
}
globalThis.snugParseLink = parseLink; // for the desktop test
let pendingLink = null;
let linkReady = null; // the Snug page's webContents once it listens
globalThis.snugLinks = [];
function deliverLink() {
  if (!pendingLink || !linkReady || linkReady.isDestroyed() || !fromSnug(linkReady.getURL())) return;
  linkReady.send("deeplink", pendingLink);
  globalThis.snugLinks.push(pendingLink);
  pendingLink = null;
}
function deepLinkFrom(argv) {
  const raw = (argv || []).find((a) => typeof a === "string" && a.toLowerCase().startsWith("snug://"));
  if (!raw) return;
  const link = parseLink(raw);
  if (!link) return;
  pendingLink = link;
  deliverLink();
}
ipcMain.on("deeplink:ready", (e) => {
  if (!fromSnug(e.senderFrame.url)) return;
  linkReady = e.sender;
  deliverLink();
});
app.on("open-url", (e, url) => { e.preventDefault(); deepLinkFrom([url]); if (win) showWindow(); });

// ---------- A newer Snug ----------
// Once a day at most: the latest release from the project's GitHub page, at a
// fixed address (an environment variable may point elsewhere, for tests only),
// 10 seconds and 1 MB at most. Nothing is downloaded; the page shows a strip
// and opens the release page in the browser. Off in Settings, or with SNUG_UPDATE_CHECK=0.
const UPDATE_URL = process.env.SNUG_UPDATE_URL || "https://api.github.com/repos/DominicsUSE/Claude-apps/releases/latest";
const RELEASES = "https://github.com/DominicsUSE/Claude-apps/releases";
let updateInfo = null;
const semver = (s) => { const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(s || "")); return m ? m.slice(1, 4).map(Number) : null; };
const newer = (a, b) => { for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; } return false; };
async function checkUpdate() {
  if (process.env.SNUG_UPDATE_CHECK === "0" || !shellPrefs().updateCheck) return null;
  // Running from source is not a release: only the installed app asks (or a test's own address).
  if (!app.isPackaged && !process.env.SNUG_UPDATE_URL) return null;
  try {
    const res = await fetch(UPDATE_URL, { headers: { accept: "application/vnd.github+json", "user-agent": "Snug-desktop" }, signal: AbortSignal.timeout(10_000), redirect: "follow" });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1_000_000) { reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const latest = semver(data.tag_name || data.name);
    const mine = semver(app.getVersion());
    if (!latest || !mine || !newer(latest, mine)) return null;
    let page = RELEASES;
    try { const u = new URL(data.html_url); if (u.protocol === "https:" && u.hostname === "github.com") page = u.href; } catch { /* keep the releases page */ }
    updateInfo = { version: latest.join("."), url: page };
    buildShellMenu();
    if (win && !win.isDestroyed() && fromSnug(win.webContents.getURL())) win.webContents.send("update:available", { version: updateInfo.version });
    return updateInfo;
  } catch { return null; } // offline, slow or odd: say nothing
}
globalThis.snugCheckUpdate = checkUpdate; // for the desktop test
globalThis.snugUpdateInfo = () => updateInfo;
ipcMain.on("update:open", (e) => { if (fromSnug(e.senderFrame.url) && updateInfo) shell.openExternal(updateInfo.url); });

// ---------- The Snug menu mirrors these settings ----------
const baseBuildMenu = buildMenu;
function buildShellMenu() {
  baseBuildMenu();
  const menu = Menu.getApplicationMenu();
  const snugMenu = menu?.items.find((i) => i.label === "Snug");
  if (!snugMenu) return;
  const p = shellPrefs();
  const items = [
    { type: "separator" },
    { label: "Open Snug at login", type: "checkbox", checked: p.openAtLogin, click: (it) => { saveTrayPrefs({ openAtLogin: it.checked }); applyLoginItem(it.checked); } },
    { label: "Start minimised", type: "checkbox", checked: p.startMinimized, click: (it) => saveTrayPrefs({ startMinimized: it.checked }) },
    { label: "Minimise to the tray", type: "checkbox", checked: p.minimizeToTray, click: (it) => saveTrayPrefs({ minimizeToTray: it.checked }) },
    { label: "Check for a newer Snug", type: "checkbox", checked: p.updateCheck, click: (it) => { saveTrayPrefs({ updateCheck: it.checked }); if (it.checked) checkUpdate(); } },
    ...(updateInfo ? [{ label: `Get Snug ${updateInfo.version}…`, click: () => shell.openExternal(updateInfo.url) }] : []),
  ];
  // Rebuild the whole menu with these before Quit.
  const template = menu.items.map((top) => {
    const sub = top.submenu ? top.submenu.items.map((i) => i) : null;
    if (top !== snugMenu || !sub) return top;
    const quitAt = sub.findIndex((i) => i.role === "quit");
    const before = sub.slice(0, Math.max(0, quitAt - 1));
    return { label: top.label, submenu: [...before, ...items, { type: "separator" }, ...sub.slice(quitAt)] };
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
buildMenu = buildShellMenu; // eslint-disable-line no-func-assign

function shellReady() {
  // snug:// opens this app: the installed app registers itself. Running from
  // source leaves the computer's handlers alone unless SNUG_PROTOCOL=1.
  if (app.isPackaged || process.env.SNUG_PROTOCOL === "1") {
    try {
      if (process.defaultApp && process.argv[1]) app.setAsDefaultProtocolClient("snug", process.execPath, [path.resolve(process.argv[1])]);
      else app.setAsDefaultProtocolClient("snug");
    } catch { /* not on every system */ }
  }
  deepLinkFrom(process.argv);
  watchIdle();
  // A little after starting, then once a day.
  setTimeout(() => { checkUpdate(); }, 8_000).unref?.();
  setInterval(() => { checkUpdate(); }, 86_400_000).unref?.();
  const p = shellPrefs();
  if (p.openAtLogin) applyLoginItem(true);
}
// ---------- end desktop shell ----------
