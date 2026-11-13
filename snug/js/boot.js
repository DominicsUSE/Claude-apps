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
  // The look js/account.js applied last time on this device (custom theme and
  // accent colours, this-device-only settings). Only data-* attributes with
  // plain values, and colour properties as hex or rgb(), are accepted.
  var paint = JSON.parse(localStorage.getItem('snug.paint') || 'null');
  if (paint && paint.attrs) {
    for (var a in paint.attrs) if (/^data-[a-z-]+$/.test(a) && /^[\w-]{0,32}$/.test(paint.attrs[a])) r.setAttribute(a, paint.attrs[a]);
    for (var k in paint.props || {}) if (/^--[a-z0-9-]+$/.test(k) && /^(#[0-9a-fA-F]{3,8}|rgb\([0-9 .\/]+\))$/.test(paint.props[k])) r.style.setProperty(k, paint.props[k]);
    if (/^\d{1,2}px$/.test(paint.fontSize || '')) r.style.fontSize = paint.fontSize;
    if (/^\d{2,3}%$/.test(paint.zoom || '')) r.style.zoom = paint.zoom;
  }
} catch (e) { /* storage blocked: defaults apply */ }
