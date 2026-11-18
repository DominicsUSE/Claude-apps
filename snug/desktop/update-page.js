// The update page (update.html). Snug updates itself: this page shows the download when the update must come
// first, then checking and installing. Its one button, "Try again", is there only after an error.
// window.snugUpdate exists only on this exact page (preload.js; main.js checks the sender again).
const $ = (id) => document.getElementById(id);
const mb = (n) => (n / 1048576).toFixed(n >= 10 * 1048576 ? 0 : 1);
const busy = new Set(["downloading", "verifying", "installing"]);

function render(s) {
  if (!s) return;
  $("title").textContent = s.version ? `Updating to Snug ${s.version}` : "Updating Snug";
  $("lead").textContent = s.phase === "manual" ? s.message : `Snug updates itself. You have Snug ${s.current}.`;
  const working = busy.has(s.phase) || s.phase === "required" || s.phase === "waiting";
  $("bar").hidden = !working && s.phase !== "installed";
  const p = $("progress");
  if (s.phase === "downloading" && s.total) { p.max = s.total; p.value = s.received; } else if (s.phase !== "downloading") p.removeAttribute("value");
  $("status").textContent = s.phase === "downloading" ? `Downloading… ${mb(s.received)} of ${mb(s.total)} MB`
    : s.phase === "verifying" ? "Checking the download…"
      : s.phase === "installing" ? "Installing…"
        : s.phase === "installed" ? "Installed. Snug is restarting."
          : s.phase === "waiting" ? "Ready. Snug installs it as soon as your data file has finished moving."
            : working ? "Starting…" : "";
  $("error").hidden = s.phase !== "error";
  $("error").textContent = s.phase === "error" ? s.message || "The update didn’t work." : "";
  const go = $("go");
  go.hidden = s.phase !== "error";
  go.disabled = false;
  document.body.dataset.phase = s.phase;
}

$("update").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("go").disabled = true;
  render(await window.snugUpdate.start());
});
window.snugUpdate.onProgress(render);
window.snugUpdate.info().then(render);
