// Keyboard shortcuts you can change, shared by the server (which checks the
// grammar of every saved combo) and the browser (js/app.js runs them; the
// Keyboard settings page edits them).
//
// A combo is written "Mod+Shift+K": modifiers first (Mod is Ctrl, or Cmd on a
// Mac, so a binding works on every device), then one key. Letters and digits
// are matched by their position on the keyboard (KeyboardEvent.code), so
// Shift or Alt changing the character doesn't break them.

// [id, label, group, default combo or '' for none, options]
// typing: also fires while writing in a text box; global: also with a dialog or
// settings open; voice: only in a call.
export const ACTIONS = [
  { id: 'quick', label: 'Jump to a place or person (quick switcher)', group: 'Getting around', def: 'Mod+K', typing: true, global: true },
  { id: 'search', label: 'Search messages', group: 'Getting around', def: 'Mod+Shift+F', typing: true, global: true },
  { id: 'shortcuts', label: 'Keyboard shortcuts sheet', group: 'Getting around', def: 'Mod+/', typing: true, global: true },
  { id: 'prevPlace', label: 'Previous place in the column', group: 'Getting around', def: 'Alt+ArrowUp', typing: true },
  { id: 'nextPlace', label: 'Next place in the column', group: 'Getting around', def: 'Alt+ArrowDown', typing: true },
  { id: 'prevUnread', label: 'Previous conversation with something new', group: 'Getting around', def: 'Alt+Shift+ArrowUp', typing: true },
  { id: 'nextUnread', label: 'Next conversation with something new', group: 'Getting around', def: 'Alt+Shift+ArrowDown', typing: true },
  { id: 'markRead', label: 'Mark this place read', group: 'Getting around', def: '' },
  { id: 'markHouseRead', label: 'Mark this whole house read', group: 'Getting around', def: 'Shift+Escape' },
  { id: 'streamer', label: 'Streamer mode on or off', group: 'Getting around', def: 'Mod+Shift+S', typing: true, global: true },
  { id: 'mute', label: 'Mute or unmute', group: 'Voice and calls', def: 'Mod+Shift+M', typing: true, global: true, voice: true },
  { id: 'deafen', label: 'Deafen or hear again', group: 'Voice and calls', def: 'Mod+Shift+D', typing: true, global: true, voice: true },
  // No default for the camera: a key pressed by mistake shouldn't turn it on.
  { id: 'camera', label: 'Camera on or off', group: 'Voice and calls', def: '', typing: true, global: true, voice: true },
  { id: 'hangup', label: 'Leave the voice room or hang up', group: 'Voice and calls', def: 'Mod+Shift+H', typing: true, global: true, voice: true },
  { id: 'answer', label: 'Answer a ringing call', group: 'Voice and calls', def: 'Mod+Shift+Enter', typing: true, global: true },
];
export const ACTION_IDS = ACTIONS.map((a) => a.id);
export const actionById = (id) => ACTIONS.find((a) => a.id === id);
export const MAX_KEYS = 40;

// Keys the browser or the system keeps for itself: a page can't (or shouldn't) take them.
export const RESERVED = {
  'Mod+W': 'closes the tab', 'Mod+T': 'opens a new tab', 'Mod+N': 'opens a new window', 'Mod+L': 'goes to the address bar',
  'Mod+Q': 'quits the browser', 'Mod+R': 'reloads the page', 'Mod+Shift+T': 'reopens a closed tab', 'Mod+Shift+N': 'opens a private window',
  'Mod+Shift+W': 'closes the window', 'Mod+Tab': 'switches tabs', 'Mod+Shift+Tab': 'switches tabs', 'Mod+F': 'finds in the page',
  'Mod+P': 'prints', 'Mod+C': 'copies', 'Mod+V': 'pastes', 'Mod+Shift+V': 'pastes as plain text', 'Mod+X': 'cuts', 'Mod+A': 'selects everything', 'Mod+Z': 'undoes',
  'Mod+Shift+Z': 'redoes', 'Alt+F4': 'closes the window', F5: 'reloads the page', F11: 'goes full screen', F12: 'opens developer tools',
  Escape: 'closes the top layer', Tab: 'moves the focus', 'Shift+Tab': 'moves the focus',
};
// Snug's own fixed keys (formatting in the message box and so on).
export const FIXED = {
  'Mod+B': 'Bold in the message box', 'Mod+I': 'Italic in the message box', 'Mod+U': 'Underline in the message box',
  'Mod+E': 'Code in the message box', 'Mod+Shift+X': 'Strikethrough in the message box', 'Alt+ArrowLeft': 'Back to where you were',
};

const NAMED = {
  arrowup: 'ArrowUp', up: 'ArrowUp', arrowdown: 'ArrowDown', down: 'ArrowDown', arrowleft: 'ArrowLeft', left: 'ArrowLeft',
  arrowright: 'ArrowRight', right: 'ArrowRight', enter: 'Enter', return: 'Enter', escape: 'Escape', esc: 'Escape', space: 'Space',
  tab: 'Tab', backspace: 'Backspace', delete: 'Delete', del: 'Delete', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
  insert: 'Insert',
};
const PUNCT = '/\\[],.;\'-=`';
const MODS = { mod: 'Mod', ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', option: 'Alt', opt: 'Alt', shift: 'Shift', meta: 'Meta', cmd: 'Meta', command: 'Meta', '⌘': 'Meta', super: 'Meta', win: 'Meta' };
const ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta'];

// "ctrl+shift+k" -> { mods: ['Ctrl', 'Shift'], key: 'K', combo: 'Ctrl+Shift+K' }, or null.
export function parseCombo(text) {
  if (typeof text !== 'string' || !text || text.length > 40) return null;
  const parts = text.split('+').map((p) => p.trim());
  if (parts.some((p) => !p)) return null;
  const keyRaw = parts.pop();
  const mods = new Set();
  for (const p of parts) {
    const m = MODS[p.toLowerCase()];
    if (!m || mods.has(m)) return null;
    mods.add(m);
  }
  let key;
  if (/^[a-z0-9]$/i.test(keyRaw)) key = keyRaw.toUpperCase();
  else if (keyRaw.length === 1 && PUNCT.includes(keyRaw)) key = keyRaw;
  else if (/^f([1-9]|1[0-2])$/i.test(keyRaw)) key = keyRaw.toUpperCase();
  else if (NAMED[keyRaw.toLowerCase()]) key = NAMED[keyRaw.toLowerCase()];
  else return null;
  if (mods.has('Mod') && (mods.has('Ctrl') || mods.has('Meta'))) return null;
  const list = ORDER.filter((m) => mods.has(m));
  // A plain key (or Shift and a key) would fire while typing; function keys and Escape are the exceptions.
  if (list.every((m) => m === 'Shift') && !(key === 'Escape' || /^F\d+$/.test(key))) return null;
  return { mods: list, key, combo: [...list, key].join('+') };
}
export const normCombo = (text) => parseCombo(text)?.combo || null;
// Ctrl (and Cmd) is Mod on one platform or the other: compare in Mod spelling.
const modForm = (c) => c.replace(/^(Ctrl|Meta)\+/, 'Mod+');
const reservedFor = (c) => RESERVED[modForm(c)];
const fixedFor = (c) => FIXED[modForm(c)];

// What a combo looks like on this device: ⌘ on a Mac, Ctrl elsewhere.
const LABEL = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc', Enter: 'Enter', Space: 'Space' };
export function comboKeys(combo, mac = false) {
  const p = parseCombo(combo);
  if (!p) return [];
  return [...p.mods.map((m) => (m === 'Mod' ? (mac ? '⌘' : 'Ctrl') : m === 'Meta' ? (mac ? '⌘' : 'Win') : m === 'Alt' && mac ? '⌥' : m)), LABEL[p.key] || p.key];
}
export const comboLabel = (combo, mac = false) => comboKeys(combo, mac).join(mac ? '' : '+');

// The key a keyboard event names, in combo spelling.
const CODE_PUNCT = { Slash: '/', Backslash: '\\', BracketLeft: '[', BracketRight: ']', Comma: ',', Period: '.', Semicolon: ';', Quote: '\'', Minus: '-', Equal: '=', Backquote: '`' };
export function eventKey(e) {
  const code = e.code || '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (CODE_PUNCT[code]) return CODE_PUNCT[code];
  const k = e.key || '';
  if (k === ' ' || k === 'Spacebar') return 'Space';
  if (k === 'Esc') return 'Escape';
  if (k.length === 1) return /[a-z]/i.test(k) ? k.toUpperCase() : k;
  return NAMED[k.toLowerCase()] || (/^F\d{1,2}$/.test(k) ? k : null);
}
// The combo a keyboard event makes (for recording), or null for a lone modifier.
export function eventCombo(e, mac = false) {
  const key = eventKey(e);
  if (!key || ['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  const mods = [];
  if (mac ? e.metaKey : e.ctrlKey) mods.push('Mod');
  if (mac ? e.ctrlKey : false) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (!mac && e.metaKey) mods.push('Meta');
  return [...ORDER.filter((m) => mods.includes(m)), key].join('+');
}
export function matches(e, combo, mac = false) {
  const p = typeof combo === 'string' ? parseCombo(combo) : combo;
  if (!p) return false;
  if (eventKey(e) !== p.key) return false;
  const want = new Set(p.mods);
  const ctrl = want.has('Ctrl') || (!mac && want.has('Mod'));
  const meta = want.has('Meta') || (mac && want.has('Mod'));
  return !!e.ctrlKey === ctrl && !!e.metaKey === meta && !!e.altKey === want.has('Alt') && !!e.shiftKey === want.has('Shift');
}

// The bindings in force: the defaults, with the person's changes on top
// ('' unbinds an action).
export function bindings(custom = {}) {
  const out = {};
  for (const a of ACTIONS) {
    const c = Object.prototype.hasOwnProperty.call(custom || {}, a.id) ? custom[a.id] : a.def;
    out[a.id] = c ? normCombo(c) || a.def : '';
  }
  return out;
}
// Which action this event runs, or null.
export function actionFor(e, custom, mac = false) {
  const b = bindings(custom);
  return ACTIONS.find((a) => b[a.id] && matches(e, b[a.id], mac))?.id || null;
}

// Why a combo can't go on an action: the browser keeps it, Snug uses it for
// something fixed, or another action has it. null when it's free.
export function conflictOf(combo, actionId, custom = {}) {
  const c = normCombo(combo);
  if (!c) return { kind: 'invalid', text: 'Use one or more of Ctrl, Alt and Shift with a key, or a function key.' };
  if (reservedFor(c)) return { kind: 'reserved', text: `The browser keeps ${modForm(c).replace('Mod', 'Ctrl')}: it ${reservedFor(c)}.` };
  if (fixedFor(c)) return { kind: 'fixed', text: `Snug already uses that: ${fixedFor(c)}.` };
  const b = bindings(custom);
  const other = ACTIONS.find((a) => a.id !== actionId && b[a.id] && modForm(b[a.id]) === modForm(c));
  if (other) return { kind: 'action', id: other.id, text: `That’s already “${other.label}”.` };
  return null;
}

// The setting as stored: known action ids, combos in canonical spelling, none
// reserved or shared. Throws a sentence a person can read.
export function cleanKeys(v, max = MAX_KEYS) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Shortcuts aren’t valid.');
  const entries = Object.entries(v);
  if (entries.length > max) throw new Error(`You can change up to ${max} shortcuts.`);
  const out = {};
  for (const [id, combo] of entries) {
    if (!ACTION_IDS.includes(id)) throw new Error(`“${String(id).slice(0, 40)}” isn’t a shortcut Snug knows.`);
    if (combo === '') { out[id] = ''; continue; }
    const c = normCombo(combo);
    if (!c) throw new Error(`That key combination for “${actionById(id).label}” isn’t valid.`);
    if (reservedFor(c) || fixedFor(c)) throw new Error(`${c} can’t be used for a shortcut.`);
    out[id] = c;
  }
  const b = bindings(out);
  const seen = new Map();
  for (const [id, c] of Object.entries(b)) {
    if (!c) continue;
    if (seen.has(modForm(c))) throw new Error(`Two shortcuts can’t share ${c}.`);
    seen.set(modForm(c), id);
  }
  return out;
}
