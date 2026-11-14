// Bridges. The first-run setup page gets snugDesktop (read and save where Snug
// runs). The Snug page itself (local or on someone else's server) gets only
// snugApp, below: nothing that reads files, settings or the network.
const { contextBridge, ipcRenderer } = require("electron");

if (location.protocol === "file:") {
  contextBridge.exposeInMainWorld("snugDesktop", {
    config: () => ipcRenderer.invoke("config:get"),
    save: (cfg) => ipcRenderer.invoke("config:save", cfg),
  });
}

// The Snug page (http or https) gets a few small things, checked again in
// main.js: whether the window is hidden in the tray, bringing it back when a
// notification is clicked, and reading or changing "Keep Snug running when
// the window is closed".
if (location.protocol === "http:" || location.protocol === "https:") {
  let hidden = false;
  ipcRenderer.on("window:visibility", (_e, h) => { hidden = h === true; });
  contextBridge.exposeInMainWorld("snugApp", {
    desktop: true,
    hidden: () => hidden,
    show: () => ipcRenderer.send("window:show"),
    getKeepRunning: () => ipcRenderer.invoke("keep:get"),
    setKeepRunning: (on) => ipcRenderer.invoke("keep:set", on === true),
    // Someone is calling: the app brings its window up (from the tray too) and
    // shows a system notification. Only short text crosses.
    incomingCall: (info) => ipcRenderer.send("call:incoming", {
      dm: String(info?.dm || "").slice(0, 80),
      title: String(info?.title || "").slice(0, 120),
      body: String(info?.body || "").slice(0, 160),
    }),
    // That ring is over: its notification goes.
    callOver: (info) => ipcRenderer.send("call:over", { dm: String(info?.dm || "").slice(0, 80) }),
    // Push to talk while another app is in front: one plain key, or null to let it go.
    setPushToTalk: (key) => ipcRenderer.invoke("ptt:set", key == null ? null : String(key).slice(0, 16)),
    onPushToTalk: (fn) => { if (typeof fn === "function") ipcRenderer.on("ptt:press", () => fn()); },
    // ---------- Desktop shell (desktop/main.js checks everything again) ----------
    // The unread number on the icon: a whole number, 0 to 999.
    setBadge: (n) => ipcRenderer.send("badge:set", Math.max(0, Math.min(999, Math.floor(Number(n)) || 0))),
    // The window's colour behind the page, following the Snug theme: #rrggbb only.
    setThemeColor: (hex) => ipcRenderer.invoke("theme:color", typeof hex === "string" && hex.length <= 16 ? hex.trim() : ""),
    // Desktop settings: open at login, start minimised, minimise to tray, hardware acceleration, update check.
    getDesktopSettings: () => ipcRenderer.invoke("desktop:get"),
    setDesktopSettings: (patch) => {
      const clean = {};
      for (const [k, v] of Object.entries(patch && typeof patch === "object" ? patch : {}).slice(0, 10)) clean[String(k).slice(0, 40)] = v === true;
      return ipcRenderer.invoke("desktop:set", clean);
    },
    restart: () => ipcRenderer.send("app:restart"),
    // Global mute and deafen keys: saved here, held only while in voice.
    setVoiceKeys: (keys) => ipcRenderer.invoke("voicekeys:set", {
      mute: typeof keys?.mute === "string" ? keys.mute.slice(0, 60) : null,
      deafen: typeof keys?.deafen === "string" ? keys.deafen.slice(0, 60) : null,
    }),
    voiceActive: (on) => ipcRenderer.invoke("voicekeys:active", on === true),
    onVoiceToggle: (fn) => { if (typeof fn === "function") ipcRenderer.on("voice:toggle", (_e, which) => fn(which === "deafen" ? "deafen" : "mute")); },
    // The computer going idle, locking, sleeping, and coming back.
    onSystemIdle: (fn) => {
      if (typeof fn !== "function") return;
      ipcRenderer.on("system:idle", (_e, s) => { if (["idle", "active", "locked", "unlocked", "suspend", "resume"].includes(s)) fn(s); });
    },
    // snug:// links opened while Snug runs (or that started it).
    onDeepLink: (fn) => {
      if (typeof fn !== "function") return;
      ipcRenderer.on("deeplink", (_e, raw) => fn(String(raw || "").slice(0, 300)));
      ipcRenderer.send("deeplink:ready");
    },
    // A newer Snug is out: its version, and opening its page in the browser.
    onUpdate: (fn) => { if (typeof fn === "function") ipcRenderer.on("update:available", (_e, info) => fn({ version: String(info?.version || "").slice(0, 20) })); },
    openUpdate: () => ipcRenderer.send("update:open"),
  });
}
