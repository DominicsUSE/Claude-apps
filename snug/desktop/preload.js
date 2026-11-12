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
  });
}
