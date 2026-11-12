// Runs before the first paint (a plain script, not a module), so the saved
// theme never flashes. Kept in its own file so the page needs no inline script.
try {
  var p = JSON.parse(localStorage.getItem('snug.prefs')) || {};
  var r = document.documentElement;
  if (p.theme && p.theme !== 'system') r.setAttribute('data-theme', p.theme);
  if (p.density && p.density !== 'regular') r.setAttribute('data-density', p.density);
  if (p.text && p.text !== 'm') r.setAttribute('data-text', p.text);
  if (p.contrast && p.contrast !== 'system') r.setAttribute('data-contrast', p.contrast);
} catch (e) { /* storage blocked: defaults apply */ }
