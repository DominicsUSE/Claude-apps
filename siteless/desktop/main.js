// Siteless for Windows (and Mac): a desktop window around the Siteless page.
// The page is served from the siteless:// scheme, which gives it its own origin (so saved
// places and leads persist) and lets Google, OpenStreetMap and PageSpeed answer it directly.
// Google Maps, directions, websites, email and phone links open in the computer's default apps.
const { app, BrowserWindow, Menu, nativeTheme, net, protocol, session, shell } = require("electron");
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

app.setName("Siteless");
if (process.platform === "win32") app.setAppUserModelId("com.siteless.app");
if (firstCopy) app.whenReady().then(() => {
  protocol.handle("siteless", handle);
  // only the app's own page may use location and the clipboard; embedded Google maps get nothing
  session.defaultSession.setPermissionRequestHandler((wc, permission, done, details) => {
    const ours = String(details.requestingUrl || "").startsWith("siteless://");
    done(ours && ["geolocation", "clipboard-sanitized-write", "fullscreen"].includes(permission));
  });
  buildMenu();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (!isMac) app.quit(); });
