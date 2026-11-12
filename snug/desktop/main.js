// Snug for Windows (and Mac, Linux): a desktop window around Snug.
//
// The app can work two ways, chosen on first run and changeable from the menu:
//   host  The Snug server runs inside this app, with its database in this
//         computer's app-data folder. Optionally other people on the same
//         network can join it from their browser or their own Snug app.
//   join  The window opens a Snug server that runs somewhere else.
const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, nativeTheme, session, shell } = require("electron");
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
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
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
  open();
}

// Snug may use the microphone (voice rooms) and show notifications. Nothing
// else, and only for the Snug address the window was opened on.
function permissions() {
  const allowed = new Set(["media", "notifications", "clipboard-sanitized-write"]);
  session.defaultSession.setPermissionRequestHandler((wc, permission, done, details) => {
    const video = permission === "media" && (details.mediaTypes || []).includes("video");
    done(allowed.has(permission) && !video && fromSnug(details.requestingUrl || wc.getURL()));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin) =>
    allowed.has(permission) && fromSnug(requestingOrigin));
}

function buildMenu() {
  const hosting = config?.mode === "host";
  const shared = hosting && config.lan && lanAddress() && server;
  const snug = {
    label: "Snug",
    submenu: [
      { label: "Change where Snug runs…", click: () => { try { fs.rmSync(configPath(), { force: true }); } catch { /* already gone */ } open(); } },
      ...(shared ? [{
        label: "Copy the address for other people",
        click: () => {
          const address = `http://${lanAddress()}:${server.port}`;
          clipboard.writeText(address);
          dialog.showMessageBox(win, { type: "info", message: "Address copied", detail: `${address}\n\nPeople on the same network can open it in a browser, or choose “Join a Snug” in their own Snug app. Voice needs a secure (https) address, so over this address they can write but not talk.` });
        },
      }] : []),
      ...(hosting ? [{ label: "Open the data folder", click: () => shell.openPath(path.join(app.getPath("userData"), "data")) }] : []),
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
