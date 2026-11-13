// Runs before the first paint (a plain script, not a module), so the saved
// theme never flashes. Kept in its own file so the page needs no inline script.
try {
  var p = JSON.parse(localStorage.getItem('snug.prefs')) || {};
  var r = document.documentElement;
  if (p.theme && p.theme !== 'system') r.setAttribute('data-theme', p.theme);
  if (p.density && p.density !== 'regular') r.setAttribute('data-density', p.density);
  if (p.text && p.text !== 'm') r.setAttribute('data-text', p.text);
  if (p.contrast && p.contrast !== 'system') r.setAttribute('data-contrast', p.contrast);
  // Account appearance settings (js/account.js), so the first paint is already right.
  if (p.fontScale && p.fontScale !== 16) r.style.fontSize = p.fontScale + 'px';
  if (p.zoom && p.zoom !== 100) r.style.zoom = p.zoom + '%';
  if (p.display === 'compact') r.setAttribute('data-display', 'compact');
  if (p.font === 'hyperlegible') r.setAttribute('data-font', 'hyperlegible');
  if (p.tone && p.tone !== 'coral') r.setAttribute('data-tone', p.tone);
} catch (e) { /* storage blocked: defaults apply */ }
