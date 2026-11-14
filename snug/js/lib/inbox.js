// Inbox, notifications and the desktop shell: the small rules both the
// server and the browser use. Pure functions, no state.
//
// - Timed mutes and "Focused for an hour": the client sends a choice from a
//   fixed list and the server works out the time. Anything else is refused.
// - Server unread counts merged with the ones the browser counts itself.
// - snug:// links, parsed strictly (the desktop app checks them again).

export const MUTE_FOR = ['15m', '1h', '8h', '24h', 'never'];
export const MUTE_LABEL = { '15m': 'For 15 minutes', '1h': 'For 1 hour', '8h': 'For 8 hours', '24h': 'For 24 hours', never: 'Until I turn it back on' };
export const PRESENCE_FOR = ['30m', '1h', '2h', '4h', '8h', 'today', 'never'];
export const PRESENCE_FOR_LABEL = { '30m': 'For 30 minutes', '1h': 'For 1 hour', '2h': 'For 2 hours', '4h': 'For 4 hours', '8h': 'For 8 hours', today: 'For today', never: 'Until I change it' };
const MS = { '15m': 15 * 60_000, '30m': 30 * 60_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '8h': 28_800_000, '24h': 86_400_000 };

// When a choice ends: a timestamp, or null for "never".
// "today" ends at the given end of the day (the client's own midnight, which
// the server accepts only if it is within the next 24 hours), else at now + 24h.
export function untilFor(choice, now = Date.now(), endOfDay = null) {
  if (choice === 'never' || choice == null) return null;
  if (choice === 'today') {
    if (Number.isInteger(endOfDay) && endOfDay > now && endOfDay <= now + 86_400_000) return endOfDay;
    return now + 86_400_000;
  }
  return Object.hasOwn(MS, choice) ? now + MS[choice] : undefined;
}

// Is a stored "until" still running? null means it never ends.
export const live = (until, now = Date.now()) => until == null || until > now;

// "14:30" today, or "Tue 14:30" further away. 24-hour unless asked otherwise.
export function untilText(until, now = Date.now(), h12 = false) {
  if (until == null) return '';
  const d = new Date(until);
  const hm = h12
    ? `${((d.getHours() + 11) % 12) + 1}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'am' : 'pm'}`
    : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const n = new Date(now);
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  if (sameDay) return hm;
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${hm}`;
}

// The browser counts what it has loaded; the server counts everything since
// the read point. Take the larger, with messages that arrived after the
// server counted (ts > upTo) added to the server's figure. A read point at or
// past upTo means the server's figure is old news.
export function mergeUnread(local, server, since, after = { count: 0, needs: 0 }) {
  if (!server || !(server.upTo > (since || 0))) return local;
  return {
    ...local,
    count: Math.max(local.count, (server.count || 0) + after.count),
    needs: Math.max(local.needs, (server.needs || 0) + after.needs),
  };
}

// snug://join/<code> and snug://open/<place>[/<message>]. Anything else: null.
const JOIN = /^[\w-]{6,40}$/;
const PLACE = /^[\w:.-]{1,80}$/;
const MSG = /^[\w.-]{1,80}$/;
export function parseDeepLink(raw) {
  if (typeof raw !== 'string' || raw.length > 300) return null;
  const m = /^snug:\/\/([a-z]+)\/([^?#]*)$/i.exec(raw.trim());
  if (!m) return null;
  const kind = m[1].toLowerCase();
  const parts = m[2].replace(/\/$/, '').split('/');
  if (parts.some((p) => p === '')) return null;
  if (kind === 'join' && parts.length === 1 && JOIN.test(parts[0])) return { kind: 'join', code: parts[0] };
  if (kind === 'open' && (parts.length === 1 || parts.length === 2) && PLACE.test(parts[0]) && (parts.length === 1 || MSG.test(parts[1]))) {
    return parts.length === 2 ? { kind: 'open', place: parts[0], msg: parts[1] } : { kind: 'open', place: parts[0] };
  }
  return null;
}

// Electron accelerators for the global mute and deafen keys: one or two
// modifiers and one key. A global shortcut takes the key from every other
// app, so with one modifier only F-keys and the number pad are allowed (never
// Ctrl+C or Shift+/), and Alt+F4 never. The desktop app checks again.
const MODS = ['CommandOrControl', 'Control', 'Ctrl', 'Command', 'Cmd', 'Alt', 'Option', 'Shift', 'Super', 'Meta'];
const KEY = /^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|num[0-9]|[`\-=[\];',./\\])$/;
export function validAccelerator(acc) {
  if (typeof acc !== 'string' || acc.length > 60) return false;
  const parts = acc.split('+');
  const key = parts.pop();
  if (!KEY.test(key || '')) return false;
  if (parts.length < 1 || parts.length > 2) return false;
  if (new Set(parts).size !== parts.length) return false;
  if (!parts.every((p) => MODS.includes(p))) return false;
  if (parts.length === 1 && !/^(?:F\d{1,2}|num\d)$/.test(key)) return false;
  if (key === 'F4' && parts.some((p) => p === 'Alt' || p === 'Option')) return false;
  return true;
}

// A keydown as an Electron accelerator ("Control+Shift+M"), or null.
export function acceleratorOf(e, isMac = false) {
  const mods = [];
  if (e.ctrlKey) mods.push(isMac ? 'Control' : 'CommandOrControl');
  if (e.metaKey) mods.push(isMac ? 'CommandOrControl' : 'Super');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  let k = e.code || '';
  if (/^Key[A-Z]$/.test(k)) k = k.slice(3);
  else if (/^Digit[0-9]$/.test(k)) k = k.slice(5);
  else if (/^F\d{1,2}$/.test(k)) { /* as is */ }
  else if (/^Numpad[0-9]$/.test(k)) k = `num${k.slice(6)}`;
  else k = { Space: 'Space', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\' }[k] || '';
  if (!k || !mods.length) return null;
  const acc = [...mods.slice(0, 2), k].join('+');
  return validAccelerator(acc) ? acc : null;
}
