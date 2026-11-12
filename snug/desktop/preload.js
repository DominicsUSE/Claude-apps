// Bridge for the first-run setup page only. The Snug page itself (local or on
// someone else's server) gets nothing from here.
const { contextBridge, ipcRenderer } = require("electron");

if (location.protocol === "file:") {
  contextBridge.exposeInMainWorld("snugDesktop", {
    config: () => ipcRenderer.invoke("config:get"),
    save: (cfg) => ipcRenderer.invoke("config:save", cfg),
  });
}
