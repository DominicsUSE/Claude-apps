// The first-run choice: run Snug here, or join one that runs elsewhere.
const $ = (id) => document.getElementById(id);
let mode = "host";

function show(next) {
  mode = next;
  $("pick-host").setAttribute("aria-pressed", String(mode === "host"));
  $("pick-join").setAttribute("aria-pressed", String(mode === "join"));
  $("host").hidden = mode !== "host";
  $("join").hidden = mode !== "join";
  $("error").hidden = true;
  if (mode === "join") $("url").focus();
}
function fail(text) {
  $("error").textContent = text;
  $("error").hidden = false;
  $("go").disabled = false;
}

$("pick-host").addEventListener("click", () => show("host"));
$("pick-join").addEventListener("click", () => show("join"));
$("lan").addEventListener("click", () => {
  const on = $("lan").getAttribute("aria-checked") !== "true";
  $("lan").setAttribute("aria-checked", String(on));
});

$("setup").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("error").hidden = true;
  if (mode === "join" && !$("url").value.trim()) return fail("Type the address of the Snug you want to join.");
  $("go").disabled = true;
  const cfg = mode === "host" ? { mode, lan: $("lan").getAttribute("aria-checked") === "true" } : { mode, url: $("url").value };
  const r = await window.snugDesktop.save(cfg);
  if (r && r.error) fail(r.error);
});

// Arriving here because something went wrong says so.
const error = new URLSearchParams(location.search).get("error");
if (error) fail(error);
window.snugDesktop.config().then((r) => {
  if (r && !r.lan) $("lan-hint").textContent = "This computer isn’t on a network right now, so there is nobody to let in yet.";
});
