// The mandatory update page (update.html): one button, then progress, checking, installing.
// window.snugUpdate exists only on this exact page (preload.js; main.js checks the sender again).
const $ = (id) => document.getElementById(id);
const mb = (n) => (n / 1048576).toFixed(n >= 10 * 1048576 ? 0 : 1);
const busy = new Set(["downloading", "verifying", "installing"]);

function render(s) {
  if (!s) return;
  $("title").textContent = s.version ? `Snug ${s.version} is ready` : "A new Snug is ready";
  $("lead").textContent = s.phase === "manual" ? s.message : `This update is required. You have Snug ${s.current}.`;
  $("bar").hidden = !busy.has(s.phase) && s.phase !== "installed";
  const p = $("progress");
  if (s.phase === "downloading" && s.total) { p.max = s.total; p.value = s.received; } else if (s.phase !== "downloading") p.removeAttribute("value");
  $("status").textContent = s.phase === "downloading" ? `Downloading… ${mb(s.received)} of ${mb(s.total)} MB`
    : s.phase === "verifying" ? "Checking the download…"
      : s.phase === "installing" ? "Installing…"
        : s.phase === "installed" ? "Installed. Snug is restarting." : "";
  $("error").hidden = s.phase !== "error";
  $("error").textContent = s.phase === "error" ? s.message || "The update didn’t work." : "";
  const go = $("go");
  go.hidden = busy.has(s.phase) || s.phase === "installed" || s.phase === "manual";
  go.disabled = false;
  go.textContent = s.phase === "error" ? "Try again" : "Update";
  document.body.dataset.phase = s.phase;
}

$("update").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("go").disabled = true;
  render(await window.snugUpdate.start());
});
window.snugUpdate.onProgress(render);
window.snugUpdate.info().then(render);
