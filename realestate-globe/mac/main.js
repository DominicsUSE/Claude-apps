// Build Atlas for macOS: a native window around the map page.
// The page is served from the atlas:// scheme so it can reach nanobot at atlas://app/nanobot/...
// without CORS trouble; those requests are forwarded to nanobot's local API.
const { app, BrowserWindow, Menu, net, protocol, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const APP_DIR = path.join(__dirname, "app");

// ---- news: headlines about property, economies and seizures, refreshed every 10 minutes ----
const NEWS_EVERY_MS = 10 * 60 * 1000;
const NEWS_QUERIES = [
  "real estate market", "housing market", "property prices", "property investment",
  "construction boom", "foreign buyers property", "expropriation OR nationalization OR seize property",
  "sanctions economy", "economic growth GDP", "currency crisis inflation",
];
let news = { fetched: null, items: [] };
const newsFile = () => path.join(app.getPath("userData"), "news.json");
const unescape = (t) => t.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&").trim();
function parseRss(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const get = (tag) => { const r = m[1].match(new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)<\\/" + tag + ">")); return r ? unescape(r[1]) : ""; };
    const source = get("source");
    let title = get("title");
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3));
    items.push({ title, link: get("link"), source, published: new Date(get("pubDate") || Date.now()).toISOString() });
  }
  return items;
}
async function refreshNews() {
  const seen = new Set(), items = [];
  let failures = 0;
  for (const q of NEWS_QUERIES) {
    const url = "https://news.google.com/rss/search?q=" + encodeURIComponent(q + " when:2d") + "&hl=en-US&gl=US&ceid=US:en";
    try {
      const r = await net.fetch(url, { headers: { "User-Agent": "BuildAtlas/1.0" } });
      if (!r.ok) throw new Error(r.status);
      for (const it of parseRss(await r.text())) {
        const key = it.title.toLowerCase();
        if (!it.title || seen.has(key)) continue;
        seen.add(key); items.push(it);
      }
    } catch (e) { failures++; }
  }
  if (items.length) {
    news = { fetched: new Date().toISOString(), items: items.slice(0, 600) };
    try { fs.writeFileSync(newsFile(), JSON.stringify(news)); } catch (e) {}
  } else if (failures) {
    news = { ...news, error: "offline" };   // keep the last headlines we had
  }
}
function startNews() {
  try { news = JSON.parse(fs.readFileSync(newsFile(), "utf8")); } catch (e) {}
  refreshNews();
  setInterval(refreshNews, NEWS_EVERY_MS);
}

protocol.registerSchemesAsPrivileged([
  { scheme: "atlas", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

// Optional settings: ~/Library/Application Support/Build Atlas/config.json
//   { "nanobotUrl": "http://127.0.0.1:8900", "nanobotApiKey": "..." }
function settings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "config.json"), "utf8"));
  } catch (e) {
    return {};
  }
}

async function handle(req) {
  const url = new URL(req.url);
  if (url.pathname.startsWith("/nanobot/")) {
    const cfg = settings();
    const base = (cfg.nanobotUrl || process.env.NANOBOT_URL || "http://127.0.0.1:8900").replace(/\/$/, "");
    const route = url.pathname.slice("/nanobot".length);
    if (!["/health", "/v1/chat/completions"].includes(route)) return new Response("Not found", { status: 404 });
    const headers = { "Content-Type": req.headers.get("Content-Type") || "application/json" };
    const key = cfg.nanobotApiKey || process.env.NANOBOT_API_KEY;
    if (key) headers.Authorization = "Bearer " + key;
    try {
      const init = { method: req.method, headers };
      if (req.method === "POST") init.body = await req.arrayBuffer();
      return await net.fetch(base + route, init);
    } catch (e) {
      return new Response(JSON.stringify({ error: { message: "nanobot is not reachable at " + base } }), {
        status: 502, headers: { "Content-Type": "application/json" },
      });
    }
  }
  if (url.pathname === "/news.json") {
    return new Response(JSON.stringify(news), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }
  // static files from the app folder only
  const file = path.normalize(path.join(APP_DIR, decodeURIComponent(url.pathname)));
  if (!file.startsWith(APP_DIR)) return new Response("Forbidden", { status: 403 });
  return net.fetch(pathToFileURL(file).toString());
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Build Atlas",
    backgroundColor: "#04070e",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 14 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once("ready-to-show", () => win.show());
  // links leave the app and open in the default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (ev, url) => {
    if (!url.startsWith("atlas://")) { ev.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); }
  });
  win.loadURL("atlas://app/index.html");
}

function buildMenu() {
  const template = [
    { role: "appMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { type: "separator" },
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "Build Atlas on GitHub", click: () => shell.openExternal("https://github.com/DominicsUSE/Claude-apps/tree/main/realestate-globe") },
        { label: "Set up nanobot for AI answers", click: () => shell.openExternal("https://github.com/HKUDS/nanobot") },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.setName("Build Atlas");
app.whenReady().then(() => {
  protocol.handle("atlas", handle);
  startNews();
  buildMenu();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
