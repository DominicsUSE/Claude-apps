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
const exporting = require("./vaultexport.js").maybeRun(app); // v0.10 C: `--export-vault` from the uninstaller (desktop/vaultexport.js)

const pinned = require("./pinned.js"); // join mode runs the app's own bundled client at the host's address
const PORT = 47821;
const SETUP = pathToFileURL(path.join(__dirname, "setup.html")).toString();
const FALLBACK = pathToFileURL(path.join(__dirname, "fallback.html")).toString(); // the join server's version doesn't fit (desktop/pinned.js)
const APP_DIR = path.join(__dirname, "snug"); // the bundled Snug (desktop/build.js copyApp)
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
// The invitation in a pasted "Join a Snug" link (https://host/join/<code>), or null. The address saved is
// still the origin (validUrl); the invitation is opened once, after setup (snug:// links, below).
function joinCodeIn(input) {
  try {
    const raw = String(input || "").trim();
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const m = /^\/join\/([\w-]{6,40})\/?$/.exec(u.pathname);
    return m ? m[1] : null;
  } catch { return null; }
}

let win = null;
let server = null;      // the running in-app server, in host mode
let origin = null;      // the Snug address the window is allowed to show
let config = null;
let pinnedOn = false;   // join mode: the window runs the app's own client at origin (desktop/pinned.js)
let ownPage = false;    // join mode: the window runs the join server's own page (its version doesn't fit)
let fallbackInfo = null; // what the fallback page says

// Join mode's own session: cookies, storage and the bundled-client handler stay apart from host mode's and
// from the server's own page (which runs in the default session and so never sees the pinned client's keys).
let joinSes = null;
const joinSession = () => (joinSes ||= session.fromPartition(pinned.PARTITION));
// A plain-http join address on the network (not this computer) isn't a secure context, so the page would have
// no WebCrypto and no encryption. The app's own code runs there, so that one origin is treated as secure. Read
// before the app is ready, as the switch must be; choosing another such address restarts the app (config:save).
const startConfig = readConfig();
const insecureOrigin = pinned.insecureOrigin(startConfig?.mode === "join" ? startConfig.url : null);
if (insecureOrigin) app.commandLine.appendSwitch("unsafely-treat-insecure-origin-as-secure", insecureOrigin);

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return null;
}

// p2p: the Snug registry and GitHub sign-in (snug/server/peer.js). Empty means P2P is off.
const DEFAULT_REGISTRY_URL = "https://snug-registry.snugapp.workers.dev";
const DEFAULT_GITHUB_CLIENT_ID = "Ov23liULMWaI5WTLL6vO";
// Env overrides only for an unpackaged app or with --dev-registry (S20), and only https or this machine.
function p2pConfig() {
  const dev = !app.isPackaged || process.argv.includes("--dev-registry");
  const pick = (env, def) => (dev && process.env[env]) || def;
  const okUrl = (u) => {
    try { const x = new URL(u); return x.protocol === "https:" || (x.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(x.hostname)) ? x.origin : null; } catch { return null; }
  };
  // SNUG_P2P=off only turns P2P off (local-only mode), so it is honoured in packaged builds too.
  const off = process.env.SNUG_P2P === "off";
  return {
    registryUrl: off ? null : okUrl(pick("SNUG_REGISTRY_URL", DEFAULT_REGISTRY_URL)),
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
// The encryption storage key (js/e2ee/store.js) is derived from a secret kept here, wrapped by the OS key
// store, and handed only to the app's own page (preload.js snugApp.e2eeStoreKey, checked again below). With no
// key store (Linux basic_text) there is no secret, and the page keeps the 0.12.0 behaviour and says so in
// Settings. SNUG_KEYSTORE=off|test is for the desktop test and only honoured when running from source: "off"
// is a computer without a key store, "test" a stand-in for one (not protection) on machines that have none.
const devKeyStore = app.isPackaged ? null : process.env.SNUG_KEYSTORE;
const e2eeKeyStore = devKeyStore === "off" ? { name: "safeStorage", available: () => false }
  : devKeyStore === "test" ? {
    name: "test", available: () => true,
    encrypt: (str) => Buffer.from(str).map((b) => b ^ 0x5a).toString("base64"),
    decrypt: (b64) => Buffer.from(b64, "base64").map((b) => b ^ 0x5a).toString(),
  } : { name: "safeStorage", ...keyStore };
const e2eeStoreFile = () => path.join(app.getPath("userData"), "e2ee-store.json");
// { protected: true, key } or { protected: false, why: "unavailable" | "locked" }. "locked": a secret was
// kept but the key store can't give it back now (it changed, or this folder was copied from another computer).
function e2eeStoreSecret() {
  let file = null;
  try { file = JSON.parse(fs.readFileSync(e2eeStoreFile(), "utf8")); } catch { /* none yet */ }
  if (file) {
    if (file.v !== 1 || file.enc !== e2eeKeyStore.name || !e2eeKeyStore.available()) return { protected: false, why: "locked" };
    try {
      const key = e2eeKeyStore.decrypt(String(file.key || ""));
      if (/^[A-Za-z0-9_-]{43}$/.test(key)) return { protected: true, key };
    } catch { /* the key store refused */ }
    return { protected: false, why: "locked" };
  }
  if (!e2eeKeyStore.available()) return { protected: false, why: "unavailable" };
  const key = require("crypto").randomBytes(32).toString("base64url");
  try {
    fs.mkdirSync(path.dirname(e2eeStoreFile()), { recursive: true });
    const tmp = `${e2eeStoreFile()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, enc: e2eeKeyStore.name, key: e2eeKeyStore.encrypt(key) }), { mode: 0o600 });
    fs.renameSync(tmp, e2eeStoreFile());
  } catch { return { protected: false, why: "unavailable" }; }
  return { protected: true, key };
}
// "Remove this computer's keys" while locked (js/e2ee/manager.js forgetLockedKeys): a kept secret that this
// working key store can't open is put aside as e2ee-store.json.locked, so the keys made next get a new,
// protected secret instead of none. A key store that is only unavailable now (or a file from a newer version)
// changes nothing. Another account on this computer sealed under the old secret was locked already and stays so.
function e2eeStoreReset() {
  let file = null;
  try { file = JSON.parse(fs.readFileSync(e2eeStoreFile(), "utf8")); } catch { return false; }
  if (file?.v !== 1 || !e2eeKeyStore.available() || e2eeStoreSecret().protected) return false;
  try { fs.renameSync(e2eeStoreFile(), `${e2eeStoreFile()}.locked`); return true; } catch { return false; }
}
// A per-launch secret in an httpOnly cookie lets this window sign back in after signing out (F5).
const resumeSecret = require("crypto").randomBytes(32).toString("base64url");

async function startHost(lan) {
  const { startServer } = await import(pathToFileURL(path.join(__dirname, "snug", "server", "index.js")).toString());
  const { net } = require("electron");
  const opts = {
    host: lan ? "0.0.0.0" : "127.0.0.1", dataDir: path.join(app.getPath("userData"), "data"), quiet: true,
    // sec-desktop D5/D9: every security switch is set here, so a variable in this computer's environment
    // (SNUG_SECURE, SNUG_TRUST_PROXY, SNUG_ORIGINS, SNUG_HOSTS, SNUG_PUSH_ALLOW_LOCAL) never changes them.
    // hosts: [] makes the server answer only to IP addresses and localhost, in LAN mode too: a web page
    // on a name it controls, re-pointed at this computer (DNS rebinding), gets 421.
    secure: false, trustProxy: false, extraOrigins: [], hosts: [], pushAllowLocal: false, linkAllowLocal: false,
    // sec-desktop D10: GitHub sign-in answers only this window (its per-launch cookie), not any program on this PC.
    ghWindowOnly: true,
    // End-to-end encryption for direct messages and groups is offered here (SNUG_E2EE in the environment doesn't change it).
    e2ee: true,
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
  pinnedOn = false;
  ownPage = false;
  if (joinSes) pinned.unpin(joinSes);
  config = error ? null : readConfig();
  if (!config) {
    await win.loadURL(gated(error ? `${SETUP}?error=${encodeURIComponent(error)}` : SETUP));
    buildMenu();
    return;
  }
  if (config.mode === "join") return openJoin();
  try {
    origin = await startHost(config.lan);
  } catch (e) {
    return open(`Snug couldn’t start on this computer. ${e.message}`);
  }
  buildMenu();
  await useSession(session.defaultSession);
  await win.loadURL(gated(origin)).catch(() => {}); // an update that is installing, or must come first, shows its page instead (automatic updates, below)
  return undefined;
}

// Join mode: check the server's version, then run the app's own client at its address (pinned), or say why
// not (the fallback page), or open the server's own page if the person chose that for this server and version.
let rulesP = null;
async function openJoin() {
  const url = config.url;
  const unreachable = () => open(`Couldn’t reach ${url}. Check the address and your connection.`);
  const rules = await (rulesP ||= pinned.loadRules(APP_DIR));
  const v = await pinned.checkVersion(joinSession(), url, rules);
  if (v.state === "unreachable") return unreachable();
  origin = url;
  buildMenu();
  if (v.state === "ok") {
    pinned.pin(joinSession(), url, { net: require("electron").net, appDir: APP_DIR, rules });
    pinnedOn = true;
    await useSession(joinSession());
    try { await win.loadURL(gated(url)); } catch { return unreachable(); }
    return undefined;
  }
  fallbackInfo = { state: v.state, host: url, server: v.server?.version || null, app: app.getVersion() };
  if (ownPageChosen(url) === ownPageKey(v)) return openOwnPage({ note: false });
  fallbackInfo.key = ownPageKey(v);
  await win.loadURL(gated(FALLBACK));
  return undefined;
}
// The person's choice to use a server's own page is kept per server and version (desktop.json ownPage).
const ownPageKey = (v) => `${v.state} ${v.server?.version || "?"}`;
const ownPageChosen = (url) => { const m = rawConfig().ownPage; return m && typeof m === "object" && typeof m[url] === "string" ? m[url] : null; };
async function openOwnPage({ note }) {
  const url = config?.mode === "join" ? config.url : null;
  if (!url) return;
  origin = url;
  ownPage = true;
  await useSession(session.defaultSession);
  win.setTitle(`Snug${pinned.OWN_PAGE_SUFFIX}`);
  try { await win.loadURL(gated(url)); } catch { open(`Couldn’t reach ${url}. Check the address and your connection.`); return; }
  if (note) {
    const where = new URL(url).host;
    dialog.showMessageBox(win, { type: "info", message: `This window runs code from ${where}. Encrypted conversations here depend on trusting it.`, detail: pinned.OWN_PAGE_NOTE(where) }).catch(() => {});
  }
}
// The window's session can't change, so a window on another session is replaced by one on the right one
// (in the same place, as visible as it was).
async function useSession(ses) {
  if (!win || win.isDestroyed() || win.webContents.session === ses) return;
  const old = win;
  createWindow({ ses, bounds: old.getNormalBounds(), maximized: old.isMaximized(), hidden: !old.isVisible() || old.isMinimized(), load: false });
  old.destroy();
}

// sec-desktop: at most 5 links to the browser per 10 seconds, so a hostile join server can't flood it.
let externalTimes = [];
const external = (url) => {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url) || url.length > 4096) return;
  const t = Date.now();
  externalTimes = externalTimes.filter((x) => t - x < 10_000);
  if (externalTimes.length >= 5) return;
  externalTimes.push(t);
  shell.openExternal(url).catch(() => {});
};
const fromSnug = (url) => { try { return !!origin && new URL(url).origin === origin; } catch { return false; } };

// ses: the window's session (join mode's own partition when pinned, the default one otherwise); a window that
// replaces another (useSession) takes its place and doesn't load anything itself.
function createWindow({ ses = session.defaultSession, bounds, maximized, hidden = false, load = true } = {}) {
  const place = bounds ? { bounds, maximized } : savedPlace(); // where the window was last time, if that is still on a screen (desktop shell, below)
  globalThis.snugStartColor = shellPrefs().themeColor; // the theme's colour from last time (desktop shell, below)
  const w = win = new BrowserWindow({
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
      session: ses,
    },
  });
  w.once("ready-to-show", () => {
    if (hidden) return; // it replaces a window waiting in the tray or the taskbar
    // Started at login, "Start minimised", or back from an update that found it so: stay in the tray (or the
    // taskbar, with no tray, or when it was minimised there). maximize() would show the window, so a hidden
    // one is maximised when it is first shown.
    if (startHidden) {
      startHidden = false;
      if (!tray || startMinimized) { startMinimized = false; if (place.maximized) w.maximize(); w.minimize(); } else if (place.maximized) w.once("show", () => w.maximize());
      return;
    }
    if (startInactive) { startInactive = false; w.showInactive(); if (place.maximized) w.maximize(); return; } // back from an update: the keyboard stays where it was
    if (place.maximized) w.maximize();
    w.show();
  });
  // When the window last stopped being in front (automatic updates, below).
  blurredAt = Date.now();
  w.on("blur", () => { blurredAt = Date.now(); });
  w.on("focus", () => { blurredAt = 0; });
  // The join server's own page (not the app's code) says so in the window's title.
  w.on("page-title-updated", (ev, title) => {
    if (!ownPage || !fromSnug(w.webContents.getURL())) return;
    ev.preventDefault();
    w.setTitle(`${title}${pinned.OWN_PAGE_SUFFIX}`);
  });
  shellWindow(w); // window size and place, minimise to tray, flash on mention (desktop shell, below)
  // Links in messages open in the default browser, never inside the app.
  w.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: "deny" }; });
  w.webContents.on("will-navigate", (ev, url) => {
    // Pinned join mode: at the host's address the window shows only the app's own page (or a download),
    // never another /api/ answer as a page (desktop/pinned.js navAllowed). Refused, not sent to the browser.
    if (pinnedOn && fromSnug(url) && w.webContents.session === joinSes && !pinned.navAllowed(url, origin)) { ev.preventDefault(); return; }
    if (fromSnug(url) || url.startsWith(SETUP) || url.startsWith(FALLBACK)) return;
    ev.preventDefault();
    external(url);
  });
  // sec-desktop D1: a server-side redirect never shows up in will-navigate. The window may only be
  // redirected within the Snug address (a join server answering 302 to another site, or to file://, is stopped).
  w.webContents.on("will-redirect", (ev, url) => {
    if (ev.isMainFrame === false) return; // a frame inside the page: the page's own CSP decides
    if (fromSnug(url) || url.startsWith(SETUP) || url.startsWith(FALLBACK)) return;
    ev.preventDefault();
    external(url);
  });
  w.on("closed", () => { if (win === w) win = null; });
  keepInTray(w); // closing hides to the tray (see "Running in the tray" below)
  if (load) open();
}

// Snug may use the microphone and camera (voice rooms), share a screen and
// show notifications. Nothing else, and only for the Snug address the window
// was opened on. The microphone and the camera each need the person's say-so
// when the server is someone else's (join mode): asked once per address and
// device, each time the app runs (sec-desktop D6: the microphone used to be
// granted without asking). The server this app runs itself (host mode) is
// trusted like the app.
const mediaOk = new Set();      // "origin audio" / "origin video" allowed this run
const mediaAsking = new Map();  // the same key -> the question on screen
const MEDIA_WORDS = { audio: ["microphone", "Allow microphone", "Snug only uses it while you are in a call or a voice room."], video: ["camera", "Allow camera", "Snug only shares it while you have it turned on in a voice room."] };
globalThis.snugMediaAsked = []; // for the desktop test
function askMedia(o, kind) {
  const key = `${o} ${kind}`;
  if (config?.mode === "host" || mediaOk.has(key)) return Promise.resolve(true);
  if (!mediaAsking.has(key)) {
    const [what, allow, why] = MEDIA_WORDS[kind];
    globalThis.snugMediaAsked.push(key);
    const q = dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
      type: "question",
      buttons: [allow, "Don’t allow"],
      defaultId: 1,
      cancelId: 1,
      message: `Let this Snug use your ${what}?`,
      detail: `${o} wants to use your ${what}. ${why}`,
    }).then(({ response }) => {
      if (response === 0) mediaOk.add(key);
      return response === 0;
    }, () => false).finally(() => mediaAsking.delete(key));
    mediaAsking.set(key, q);
  }
  return mediaAsking.get(key);
}
// Each kind asked in turn (never two dialogs at once); every one must be allowed.
async function askMediaAll(o, kinds) {
  for (const k of kinds) if (!(await askMedia(o, k))) return false;
  return true;
}
function permissions() {
  // display-capture: newer Electron asks it before getDisplayMedia reaches the picker below (Electron 45).
  const allowed = new Set(["media", "display-capture", "notifications", "clipboard-sanitized-write", "fullscreen"]);
  // sec-desktop: only the main window's page, never another webContents (a picker, a future window).
  const ours = (wc) => !!wc && !!win && !win.isDestroyed() && wc === win.webContents;
  // Both sessions the window can have: the default one, and join mode's own partition (pinned).
  for (const ses of [session.defaultSession, joinSession()]) sessionPermissions(ses, allowed, ours);
}
function sessionPermissions(ses, allowed, ours) {
  ses.setPermissionRequestHandler((wc, permission, done, details) => {
    const url = details.requestingUrl || wc.getURL();
    if (!allowed.has(permission) || !ours(wc) || !fromSnug(url)) return done(false);
    if (permission === "media") {
      const kinds = ["audio", "video"].filter((k) => (details.mediaTypes || []).includes(k));
      if (!kinds.length) return done(false);
      askMediaAll(new URL(url).origin, kinds).then(done, () => done(false));
      return undefined;
    }
    return done(true);
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    if (!allowed.has(permission) || (wc && !ours(wc)) || !fromSnug(requestingOrigin)) return false;
    if (permission === "media") {
      const kind = details?.mediaType === "video" ? "video" : details?.mediaType === "audio" ? "audio" : null;
      if (!kind) return config?.mode === "host" || [...mediaOk].some((k) => k.startsWith(`${new URL(requestingOrigin).origin} `));
      return config?.mode === "host" || mediaOk.has(`${new URL(requestingOrigin).origin} ${kind}`);
    }
    return true;
  });
  screenSharing(ses);
}

// ---------- Screen sharing ----------
// The page asks with getDisplayMedia; the app answers with a small picker of
// screens and windows (on recent macOS, the system's own picker). Only the
// Snug page may ask. System sound comes along where Electron can capture it
// (Windows).
function screenSharing(ses) {
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
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
  // The system's own picker is asked for on macOS only (it is the only system that has one here).
  }, { useSystemPicker: isMac });
}

// A plain window listing what can be shared, with thumbnails (picker.html, picker.js). Choosing one
// shares it; closing the window or Cancel shares nothing. The page's only bridge is the list itself
// (preload.js snugPicker, answered here for this picker only); it has no network and reports the
// choice through its title. Its policy runs only its own script file (no inline script).
const PICKER = pathToFileURL(path.join(__dirname, "picker.html")).toString();
let picking = null; // { wc, items } while a picker is open
ipcMain.on("picker:page", (e) => { e.returnValue = String(e.senderFrame?.url || "").startsWith("file:") ? PICKER : null; });
ipcMain.handle("picker:list", (e) => (picking && e.sender === picking.wc && e.senderFrame?.url === PICKER ? picking.items : null));
function pickSource(sources) {
  if (!sources.length || !win) return Promise.resolve(null);
  const screens = sources.filter((s) => s.id.startsWith("screen:"));
  const windows = sources.filter((s) => !s.id.startsWith("screen:") && !s.thumbnail.isEmpty()).slice(0, 30);
  const list = [...screens, ...windows];
  const item = (s) => ({
    i: list.indexOf(s), thumb: `data:image/jpeg;base64,${s.thumbnail.toJPEG(70).toString("base64")}`,
    name: String(screens.length === 1 && s.id.startsWith("screen:") ? "Entire screen" : s.name).slice(0, 200),
  });
  const items = { screens: screens.map(item), windows: windows.map(item) };
  return new Promise((resolve) => {
    const picker = new BrowserWindow({
      parent: win, modal: true, width: 760, height: 560, minWidth: 420, minHeight: 360,
      title: "Share your screen", autoHideMenuBar: true, show: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#141516" : "#FBFAF8",
      webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const mine = { wc: picker.webContents, items };
    picking = mine;
    let done = false;
    const finish = (source) => {
      if (done) return;
      done = true;
      if (picking === mine) picking = null;
      resolve(source);
      if (!picker.isDestroyed()) picker.close();
    };
    picker.webContents.on("will-navigate", (e) => e.preventDefault());
    picker.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    picker.webContents.on("page-title-updated", (e, title) => {
      if (title === "cancel") finish(null);
      else if (title.startsWith("pick:")) finish(list[Number(title.slice(5))] || null);
    });
    picker.on("closed", () => finish(null));
    picker.once("ready-to-show", () => picker.show());
    picker.loadURL(PICKER).catch(() => finish(null));
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
          dialog.showMessageBox(win, { type: "info", message: "Address copied", detail: `${address}\n\nPeople on the same network can open it in a browser, or choose “Join a Snug” in their own Snug app. Voice needs a secure (https) address, so over this address they can write but not talk.\n\nThis address isn’t encrypted: anyone on this network could read what is sent over it, passwords included. Use it only on a network you trust, like your home Wi-Fi.` });
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
// sec-desktop: any webContents (the window, the screen picker, anything later) gets no <webview> and no
// new windows of its own; the window's own handlers above add the narrower rules.
app.on("web-contents-created", (_e, wc) => {
  wc.on("will-attach-webview", (ev) => ev.preventDefault());
  wc.setWindowOpenHandler(({ url }) => { external(url); return { action: "deny" }; });
});
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
    // A whole invitation link: the page opens it once it is up (it says "deeplink:ready").
    const code = joinCodeIn(cfg.url);
    const link = code ? `snug://join/${code}` : null;
    if (link) pendingLink = link;
    // A plain-http address on the network needs the secure-origin switch for it (above), set only at startup.
    const needs = pinned.insecureOrigin(url);
    if (needs && needs !== insecureOrigin) {
      setImmediate(() => { quitting = true; app.relaunch(link ? { args: [...process.argv.slice(1), link] } : undefined); app.quit(); });
      return {};
    }
  } else return { error: "Choose one of the two." };
  setImmediate(() => open());
  return {};
});

// The setup page's Privacy link: the privacy page (snug/js/views/privacy.js) as this app's own server serves it,
// from a short-lived copy with nothing in it (a temporary folder, this computer only), in a window of its own
// on a session that keeps nothing. Closing the window stops that server and removes the folder.
let privacyWin = null;
async function openPrivacy() {
  if (privacyWin && !privacyWin.isDestroyed()) { privacyWin.show(); privacyWin.focus(); return; }
  const { startServer } = await import(pathToFileURL(path.join(__dirname, "snug", "server", "index.js")).toString());
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "snug-privacy-"));
  let srv;
  try {
    srv = await startServer({
      host: "127.0.0.1", port: 0, dataDir, quiet: true,
      secure: false, trustProxy: false, extraOrigins: [], hosts: [], pushAllowLocal: false, linkAllowLocal: false, ghWindowOnly: true, e2ee: true,
      ...p2pConfig(), fetch: require("electron").net.fetch.bind(require("electron").net), // the same mode as Snug on this computer, so the page describes it
    });
  } catch (e) { fs.rmSync(dataDir, { recursive: true, force: true }); throw e; }
  const at = `http://127.0.0.1:${srv.port}`;
  const ses = session.fromPartition("snug-privacy"); // no "persist:": nothing is kept
  ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  const w = privacyWin = new BrowserWindow({
    width: 760, height: 860, minWidth: 380, minHeight: 480, title: "Privacy at Snug", autoHideMenuBar: true,
    icon: path.join(__dirname, "snug", "icon.png"), backgroundColor: nativeTheme.shouldUseDarkColors ? "#0E0F10" : "#E9E6E1",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, session: ses },
  });
  const isPage = (url) => { try { const u = new URL(url); return u.origin === at && /^\/privacy\/?$/.test(u.pathname); } catch { return false; } };
  // Only the privacy page: links elsewhere open in the browser; "Back to Snug" closes the window.
  w.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: "deny" }; });
  w.webContents.on("will-navigate", (ev, url) => { if (isPage(url)) return; ev.preventDefault(); if (new URL(url).origin === at) w.close(); else external(url); });
  w.webContents.on("did-navigate-in-page", (_ev, url) => { if (!isPage(url)) w.close(); });
  w.on("closed", () => {
    if (privacyWin === w) privacyWin = null;
    srv.close().catch(() => {}).finally(() => fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  });
  await w.loadURL(`${at}/privacy`);
}
ipcMain.handle("setup:privacy", (e) => (e.senderFrame.url.startsWith(SETUP) ? openPrivacy().then(() => true, () => false) : null));

// One window and one database: opening Snug again brings the running one to the front.
if (exporting) { /* --export-vault: desktop/vaultexport.js does the work and exits */ } else if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", (_e, argv) => {
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
    deepLinkFrom(argv); // snug://join/... or snug://open/... (desktop shell, below)
  });
  app.whenReady().then(() => {
    permissions();
    shellReady(); // snug:// links, idle and lock, the update check (desktop shell, below)
    // Join mode starts on its own session, so the usual (pinned) case needs no second window.
    const windowSession = () => (readConfig()?.mode === "join" ? joinSession() : session.defaultSession);
    createWindow({ ses: windowSession() });
    app.on("activate", () => { if (!win) createWindow({ ses: windowSession() }); });
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

// ---------- Desktop shell: settings, window place, badge, global voice keys, idle, snug:// links, automatic updates ----------
// Settings live in desktop.json next to keepRunning. Everything the Snug page
// sends is checked here again; only the Snug page (fromSnug) may ask.
const { screen, powerMonitor } = require("electron");
const SHELL_DEFAULTS = { openAtLogin: false, startMinimized: false, minimizeToTray: false, hardwareAcceleration: true }; // an old updateCheck is ignored: updates install themselves
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
// Back from an update that installed itself (automatic updates, below): the window comes back the way it was.
// Read once; a note older than ten minutes is from some other start and is ignored.
let startInactive = false;
let startMinimized = false;
let blurredAt = 0;
try {
  const f = path.join(app.getPath("userData"), "update-relaunch.json");
  const note = JSON.parse(fs.readFileSync(f, "utf8"));
  fs.rmSync(f, { force: true });
  if (Date.now() - note.at < 600_000) {
    if (note.mode === "hidden" || note.mode === "minimized") { startHidden = true; startMinimized = note.mode === "minimized"; } else if (note.mode === "inactive") startInactive = true;
  }
} catch { /* an ordinary start */ }

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
let restartAsked = 0;
ipcMain.on("app:restart", (e) => {
  if (!fromSnug(e.senderFrame.url)) return;
  // sec-desktop: a page can't restart-loop the app (the setting it applies takes one restart).
  if (Date.now() - restartAsked < 60_000) return;
  restartAsked = Date.now();
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
  if (on !== true) { releaseVoiceKeys(); voiceFrom = null; if (upd.state === "required") showUpdatePage(); if (upd.state === "quiet" && upd.phase === "required") startUpdate(); installWhenQuiet(); return {}; }
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

// ---------- Automatic updates (desktop/updater.js) ----------
// Nobody downloads a new Snug by hand. A little after starting and every hour: one request for the newest
// GitHub release, one for the registry's minimum version. A newer release with this computer's file and its
// checksum file is downloaded quietly while Snug stays in use, checked (size, sha256, and the signature once a
// key is pinned), and then installs itself at a moment that interrupts nothing: never during a call or a
// data-file transfer; when the window is hidden, minimised or not in front, when the computer has been idle
// for a minute, or when Snug has only just been opened. Snug comes back the way it was (hidden stays hidden).
// A download that was never installed because Snug was closed first is used at the next start.
// The update page (update.html) shows only while installing, when the registry's minimum version rules this
// version out (then the download shows there, and starts by itself), or when a person is needed (Snug can't
// write to its folder, the install failed). Only update.html may drive it (its exact file:// URL, checked on
// every message). SNUG_UPDATE_CHECK=0 turns the check off (development, tests).
const UPDATE_PAGE = pathToFileURL(path.join(__dirname, "update.html")).toString();
const { createUpdater, updaterEnvFor, semverCmp, quietWindow } = require("./updater.js");
const BUSY = new Set(["downloading", "verifying", "installing"]);
// state: none | quiet (downloading or waiting in the background) | required (the update page is up).
// phase: ready | required | downloading | verifying | waiting (verified, waiting for a quiet moment) |
//        installing | installed | manual | error.
const upd = { state: "none", info: null, phase: "ready", received: 0, total: 0, message: null, file: null, dl: false }; // dl: the error is a failed download (tried again by itself), not a failed install
const UPDATE_RETRY_MS = 10 * 60_000;
let shellStartedAt = Date.now();
let updater = null;
globalThis.snugUpdateLog = []; // phases, for the desktop test
// sec-desktop D9: an installed app ignores the updater's test variables (SNUG_UPDATE_URL, SNUG_UPDATE_CHECK,
// SNUG_UPDATE_KIND, ...) unless it was started with --dev-update, so a variable planted in this computer's
// environment can't turn the updates off or point them somewhere else.
const devUpdate = !app.isPackaged || process.argv.includes("--dev-update");
const updaterEnv = () => updaterEnvFor(process.env, devUpdate);
function getUpdater() {
  updater ||= createUpdater({
    env: updaterEnv(),
    current: app.getVersion(), registryUrl: p2pConfig().registryUrl, tempDir: app.getPath("temp"),
    exePath: app.getPath("exe"), pid: process.pid,
    quit: () => { quitting = true; app.quit(); },
    log: (...a) => console.warn("[snug]", ...a),
  });
  return updater;
}
function gated(url) { return upd.state === "required" ? UPDATE_PAGE : url; }
const publicUpdate = () => ({ version: upd.info?.version || null, current: app.getVersion(), phase: upd.phase, received: upd.received, total: upd.total, message: upd.message });
function setUpdate(patch) {
  const before = upd.phase;
  Object.assign(upd, patch);
  if (upd.phase !== before) { globalThis.snugUpdateLog.push(upd.phase); if (globalThis.snugUpdateLog.length > 50) globalThis.snugUpdateLog.shift(); }
  if (win && !win.isDestroyed() && win.webContents.getURL() === UPDATE_PAGE) win.webContents.send("update:progress", publicUpdate());
}
// Not in the middle of a call: the page says when it is in voice (voicekeys:active); the update page
// comes up when the call ends (review 0.10 #9).
const inCall = () => !!(voiceFrom && !voiceFrom.isDestroyed());
function showUpdatePage() {
  if (inCall()) return;
  if (win && !win.isDestroyed() && win.webContents.getURL() !== UPDATE_PAGE) win.loadURL(UPDATE_PAGE).catch(() => {});
}
globalThis.snugUpdateShown = () => !!(win && !win.isDestroyed() && win.webContents.getURL() === UPDATE_PAGE); // for the desktop test
async function checkUpdate() {
  if (updaterEnv().SNUG_UPDATE_CHECK === "0") return null;
  // Running from source is not a release: only the installed app asks (or a test's own address).
  if (!app.isPackaged && !process.env.SNUG_UPDATE_URL) return null;
  if (BUSY.has(upd.phase)) return publicUpdate();
  let r;
  if (!cleaned) { cleaned = true; try { getUpdater().cleanup(); } catch { /* best effort */ } }
  try { r = await getUpdater().check(); } catch { return null; }
  // Once found it stays found: offline or an odd reply never lifts it.
  if (r.state !== "required") return upd.state !== "none" ? publicUpdate() : null;
  if (BUSY.has(upd.phase)) return publicUpdate();
  if (upd.info?.version !== r.version) { upd.file = null; setUpdate({ info: r, phase: "required", received: 0, total: r.asset.size, message: null }); } else upd.info = r;
  // The registry's minimum is above this version: it may not be used meanwhile.
  const forced = !!r.min && semverCmp(r.min, app.getVersion()) > 0;
  if (forced) upd.state = "required";
  else if (upd.state === "none") upd.state = "quiet";
  // The last try couldn't put the new version in place: say so instead of trying again in a loop.
  if (getUpdater().takeFailure()) { upd.state = "required"; upd.dl = false; setUpdate({ phase: "error", message: UPDATE_ERRORS.install }); needsPerson(); }
  if (upd.state === "required") showUpdatePage();
  // A download that failed is tried again at each check; an install that failed waits for "Try again".
  if (retryable()) startUpdate();
  else if (upd.phase === "waiting") installWhenQuiet();
  return publicUpdate();
}
const UPDATE_ERRORS = {
  checksum: "The download didn’t match its checksum, so Snug didn’t install it. Try again.",
  size: "The download wasn’t the size it should be, so Snug didn’t install it. Try again.",
  network: "Snug couldn’t download the update. Check your connection and try again.",
  space: "There isn’t enough space on this computer for the update. Free some space and try again.",
  write: "Snug couldn’t save the update on this computer. Try again.",
  install: "Snug couldn’t install the update. Try again, or download Snug from GitHub.",
};
let cleaned = false;
let retryT = null;
const retryable = () => upd.phase === "required" || (upd.phase === "error" && upd.dl);
function retryLater(ms) {
  clearTimeout(retryT);
  retryT = setTimeout(() => { retryT = null; if (retryable()) startUpdate(); }, ms);
  retryT.unref?.();
}
// The update page needs a person (the install failed, or Snug can't write to its folder) and Snug can't be
// used meanwhile: a window waiting in the tray comes up, without taking the keyboard.
function needsPerson() {
  if (!win || win.isDestroyed()) return;
  try { fs.rmSync(relaunchFile(), { force: true }); } catch { /* no note */ } // nothing restarts: the next start is an ordinary one
  if (!win.isVisible()) win.showInactive(); else if (win.isMinimized()) win.restore();
  try { win.flashFrame(true); } catch { /* not on every system */ }
}
async function startUpdate() {
  if (upd.state === "none" || !upd.info || BUSY.has(upd.phase) || upd.phase === "installed") return;
  upd.dl = false;
  // A verified download is already here (the install is what failed, or is still waiting).
  if (upd.file && fs.existsSync(upd.file)) { setUpdate({ phase: "waiting", message: null }); installWhenQuiet(); return; }
  // Quietly, a call keeps the whole connection: the download starts when it has ended.
  if (upd.state === "quiet" && inCall()) { retryLater(60_000); return; }
  const info = upd.info;
  setUpdate({ phase: "downloading", received: 0, total: info.asset.size, message: null });
  try {
    const file = await getUpdater().download(info, (p) => setUpdate(p.verifying ? { phase: "verifying", received: p.received } : { received: p.received, total: p.total }));
    globalThis.snugUpdateLog.push("verified");
    upd.file = file;
    setUpdate({ phase: "waiting" });
    installWhenQuiet();
  } catch (e) {
    console.warn("[snug] update failed:", e.code, e.message);
    upd.dl = true;
    setUpdate({ phase: "error", message: UPDATE_ERRORS[e.code] || UPDATE_ERRORS.network });
    retryLater(UPDATE_RETRY_MS);
  }
}
// Would a restart right now interrupt anything?
function quietMoment() {
  if (inCall()) return false;
  // This computer's server: a data-file transfer, or anyone (people who joined over the network too) in a
  // voice room or a call on it.
  try { if (server?.vaultBusy?.() || server?.voiceBusy?.()) return false; } catch { /* no server here */ }
  if (upd.state === "required") return true; // the update page is already in the way
  if (typeof globalThis.snugUpdateQuiet === "boolean") return globalThis.snugUpdateQuiet; // the desktop test decides
  const q = updaterEnv().SNUG_UPDATE_QUIET; // and how it starts out (honoured like the other test variables: --dev-update)
  if (q === "0" || q === "1") return q === "1";
  return quietWindow({
    gone: !win || win.isDestroyed(), hidden: !!win && !win.isDestroyed() && (!win.isVisible() || win.isMinimized()),
    audible: !!win && !win.isDestroyed() && win.webContents.isCurrentlyAudible(),
    awayMs: win && !win.isDestroyed() && !win.isFocused() && blurredAt ? Date.now() - blurredAt : 0, openMs: Date.now() - shellStartedAt,
    idleS: (() => { try { return powerMonitor.getSystemIdleTime(); } catch { return 0; } })(),
  });
}
// How Snug comes back after the update: hidden stays hidden, a window that wasn't in front doesn't take the
// keyboard (read once at the next start: relaunchMode, above).
const relaunchFile = () => path.join(app.getPath("userData"), "update-relaunch.json");
function rememberWindow() {
  const mode = !win || win.isDestroyed() || !win.isVisible() ? "hidden" : win.isMinimized() ? "minimized" : win.isFocused() ? "shown" : "inactive";
  try { fs.writeFileSync(relaunchFile(), JSON.stringify({ mode, at: Date.now() })); } catch { /* it opens the usual way */ }
  return mode;
}
let quietT = null;
function installWhenQuiet() {
  if (upd.phase !== "waiting") { clearInterval(quietT); quietT = null; return; }
  if (!quietMoment()) {
    quietT ||= setInterval(installWhenQuiet, 5_000);
    quietT.unref?.();
    return;
  }
  clearInterval(quietT); quietT = null;
  installUpdate();
}
async function installUpdate() {
  if (upd.phase !== "waiting" || !upd.file) return;
  // It may have waited hours in the temp folder: its size and checksum are checked once more, now.
  setUpdate({ phase: "verifying" });
  if (!(await getUpdater().recheck(upd.file).catch(() => false))) {
    console.warn("[snug] update: the download changed while it waited; fetching it again");
    try { fs.rmSync(upd.file, { force: true }); } catch { /* gone already */ }
    upd.file = null;
    setUpdate({ phase: "required" });
    startUpdate();
    return;
  }
  if (!quietMoment()) { setUpdate({ phase: "waiting" }); installWhenQuiet(); return; } // a call began meanwhile
  const mode = rememberWindow();
  upd.state = "required"; // the window shows the update page from here on
  setUpdate({ phase: "installing", message: null });
  showUpdatePage();
  try {
    const r = await getUpdater().install(upd.file, upd.info, { background: mode !== "shown" });
    if (r?.manual) { setUpdate({ phase: "manual", message: r.message }); needsPerson(); }
    else if (r?.dry) setUpdate({ phase: "installed" }); // SNUG_UPDATE_DRY_INSTALL: recorded, nothing spawned
    // Otherwise the helper or the installer takes over and the app is quitting.
  } catch (e) {
    console.warn("[snug] update failed:", e.code, e.message);
    if (!fs.existsSync(upd.file)) upd.file = null;
    upd.dl = false;
    setUpdate({ phase: "error", message: UPDATE_ERRORS[e.code] || UPDATE_ERRORS.install });
    needsPerson();
  }
}
globalThis.snugCheckUpdate = checkUpdate; // for the desktop test
globalThis.snugUpdateState = publicUpdate;
const fromUpdatePage = (e) => e.senderFrame?.url === UPDATE_PAGE;
// The preload asks which page carries the bridge (file:// pages only).
ipcMain.on("update:page", (e) => { e.returnValue = String(e.senderFrame?.url || "").startsWith("file:") ? UPDATE_PAGE : null; });
// sec-desktop: and the setup page's exact address, so snugDesktop goes to that page only, not any file:// page.
ipcMain.on("fallback:page", (e) => { e.returnValue = String(e.senderFrame?.url || "").startsWith("file:") ? FALLBACK : null; });
// Whether the Snug page runs the app's own code: the in-app server's page (host mode) or the pinned client
// (join mode), in the main window only. The server's own page never is. (js/e2ee/manager.js deviceKind)
function builtInPage(e) {
  const main = !!win && !win.isDestroyed() && e.sender === win.webContents;
  const ses = e.sender.session;
  return main && fromSnug(e.senderFrame?.url || "") && !ownPage
    && ((config?.mode === "host" && ses === session.defaultSession) || (pinnedOn && ses === joinSes));
}
ipcMain.on("page:builtin", (e) => { e.returnValue = builtInPage(e); });
// The encryption storage key's secret (above): the app's own page only, never a server's own page.
ipcMain.handle("e2ee:storekey", (e) => (builtInPage(e) ? e2eeStoreSecret() : null));
ipcMain.handle("e2ee:storekey:reset", (e) => (builtInPage(e) ? e2eeStoreReset() : false));
// The fallback page (fallback.html): what to say, the server's own page, an app update, or another server.
const fromFallback = (e) => String(e.senderFrame?.url || "").split(/[?#]/)[0] === FALLBACK;
ipcMain.handle("fallback:info", (e) => (fromFallback(e) && fallbackInfo ? { ...pinned.fallbackText(fallbackInfo), host: new URL(fallbackInfo.host).host, note: pinned.OWN_PAGE_NOTE(new URL(fallbackInfo.host).host) } : null));
ipcMain.handle("fallback:own", async (e) => {
  if (!fromFallback(e) || !fallbackInfo || config?.mode !== "join") return false;
  const raw = rawConfig();
  const chosen = raw.ownPage && typeof raw.ownPage === "object" ? raw.ownPage : {};
  saveTrayPrefs({ ownPage: { ...chosen, [fallbackInfo.host]: fallbackInfo.key } });
  setImmediate(() => openOwnPage({ note: true }));
  return true;
});
ipcMain.handle("fallback:update", async (e) => {
  if (!fromFallback(e)) return null;
  const r = await checkUpdate().catch(() => null);
  return r ? { version: r.version, phase: r.phase } : { version: null };
});
ipcMain.on("fallback:change", (e) => {
  if (!fromFallback(e)) return;
  try { fs.writeFileSync(configPath(), JSON.stringify(trayPrefs(), null, 2)); } catch { /* already gone */ }
  open();
});
ipcMain.on("setup:page", (e) => { e.returnValue = String(e.senderFrame?.url || "").startsWith("file:") ? SETUP : null; });
ipcMain.handle("update:info", (e) => (fromUpdatePage(e) ? publicUpdate() : null));
// "Try again" on the update page.
ipcMain.handle("update:start", (e) => {
  if (!fromUpdatePage(e)) return null;
  if (upd.phase === "error" || upd.phase === "required") startUpdate();
  return publicUpdate();
});

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
  // Just after starting, then every hour. Nothing else polls.
  // (SNUG_UPDATE_CHECK=manual, with --dev-update: the desktop test calls the check itself.)
  shellStartedAt = Date.now();
  if (updaterEnv().SNUG_UPDATE_CHECK !== "manual") {
    setTimeout(() => { checkUpdate(); }, 3_000).unref?.();
    setInterval(() => { checkUpdate(); }, 3_600_000).unref?.();
  }
  const p = shellPrefs();
  if (p.openAtLogin) applyLoginItem(true);
}
// ---------- end desktop shell ----------
