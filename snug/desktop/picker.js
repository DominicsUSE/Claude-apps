// The screen-share picker (main.js pickSource): what can be shared comes from main.js through
// window.snugPicker.list(); the choice goes back through the page's title ("pick:<i>" or "cancel").
// The page has no network and runs only this file.
const lists = document.getElementById("lists");
function section(title, items) {
  if (!items.length) return;
  const h = document.createElement("h2");
  h.textContent = title;
  const grid = document.createElement("div");
  grid.className = "grid";
  for (const s of items) {
    const b = document.createElement("button");
    b.dataset.i = String(s.i);
    const img = document.createElement("img");
    img.alt = "";
    if (typeof s.thumb === "string" && s.thumb.startsWith("data:image/jpeg;base64,")) img.src = s.thumb;
    const name = document.createElement("span");
    name.textContent = s.name;
    b.append(img, name);
    grid.append(b);
  }
  lists.append(h, grid);
}
document.addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; document.title = b.dataset.i != null ? `pick:${b.dataset.i}` : "cancel"; });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") document.title = "cancel"; });
(window.snugPicker?.list() || Promise.resolve(null)).then((l) => {
  if (!l) { document.title = "cancel"; return; }
  section("Screens", l.screens || []);
  section("Windows", l.windows || []);
  document.querySelector("button[data-i]")?.focus();
}, () => { document.title = "cancel"; });
