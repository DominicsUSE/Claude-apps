// Tell the page it runs inside the desktop app: it adjusts its Google key instructions
// (an app has no website address to allow) and, on a Mac, leaves room for the window buttons.
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("sitelessApp", { platform: process.platform });
window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.classList.add("desktop-app");
  if (process.platform === "darwin") document.documentElement.classList.add("desktop-mac");
});
