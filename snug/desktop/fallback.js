// The fallback page (fallback.html): the join server's version doesn't fit this app's own built-in client
// (desktop/pinned.js). It says which versions, and offers an app update, the server's own page (its code,
// in a separate session, labelled in the title), or another server. Never chosen silently.
const $ = (id) => document.getElementById(id);
const api = window.snugFallback;

async function start() {
  const info = await api.info();
  if (!info) return;
  $("title").textContent = info.title;
  $("lead").textContent = info.lead;
  $("own-note").textContent = info.note;
}

$("update").addEventListener("click", async () => {
  const b = $("update");
  b.disabled = true;
  $("status").textContent = "Checking…";
  const r = await api.checkUpdate().catch(() => null);
  b.disabled = false;
  $("status").textContent = r?.version
    ? `Snug ${r.version} is on its way. Snug installs it and restarts by itself.`
    : "No newer Snug app was found. Ask whoever runs this server which version it needs.";
});
$("own").addEventListener("click", () => { $("own").disabled = true; api.ownPage(); });
$("change").addEventListener("click", () => api.change());
start();
