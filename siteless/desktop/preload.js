// Tell the page it runs inside the desktop app: it adjusts its Google key instructions
// (an app has no website address to allow) and, on a Mac, leaves room for the window buttons.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sitelessApp", { platform: process.platform });
window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.classList.add("desktop-app");
  if (process.platform === "darwin") document.documentElement.classList.add("desktop-mac");
});

// follow the computer's light or dark theme (sent by the app whenever it changes)
ipcRenderer.on("theme", (e, theme) => {
  document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
  window.dispatchEvent(new Event("siteless-theme"));
});
