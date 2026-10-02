// Tell the page it runs inside the Mac app so it can leave room for the window buttons.
window.addEventListener("DOMContentLoaded", () => {
  if (process.platform === "darwin") document.documentElement.classList.add("desktop-mac");
});
