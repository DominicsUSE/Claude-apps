// Account settings shared by the server and the browser: which appearance,
// accessibility and notification settings exist, what values each may take,
// and the small rules both sides apply (quiet hours, clearing a status,
// highlight words, @everyone). The server validates every change with
// cleanPrefs before it stores it, so a settings blob from a modified client
// can never hold anything this file does not describe.

// Settings that follow the person to every device (stored on the server).
// [kind, choices or range, default]
export const PREF_RULES = {
  theme: ['enum', ['system', 'dark', 'light', 'midnight'], 'system'],
  // The selection tone (selected text, the selected row's edge). Coral stays
  // the brand: it is the default. Cyan and neutral are offered; mint and rose
  // are still accepted from older Snugs and show as neutral (css/account.css).
  tone: ['enum', ['coral', 'cyan', 'mint', 'rose', 'neutral'], 'coral'],
  display: ['enum', ['cozy', 'compact'], 'cozy'],
  density: ['enum', ['snug', 'regular', 'roomy'], 'regular'],
  fontScale: ['int', [12, 20], 16],
  zoom: ['enum', [80, 90, 100, 110, 125, 150], 100],
  lineHeight: ['enum', ['tight', 'normal', 'loose'], 'normal'],
  saturation: ['int', [0, 100], 100],
  motion: ['enum', ['system', 'reduced'], 'system'],
  contrast: ['enum', ['system', 'standard', 'high'], 'system'],
  compactAvatars: ['bool', null, false],
  clock: ['enum', ['auto', '12', '24'], 'auto'],
  roleColors: ['bool', null, true],
  sidebarW: ['int', [200, 420], 264],
  font: ['enum', ['inter', 'hyperlegible'], 'inter'],
  underlineLinks: ['bool', null, false],
  focusAlways: ['bool', null, false],
  tts: ['bool', null, false],
  toasts: ['bool', null, true],
  embeds: ['bool', null, true],
  preview: ['bool', null, true],
  sound: ['enum', ['off', 'soft', 'bell', 'pop', 'drop'], 'soft'],
  mutedSounds: ['set', 300, {}],
  everyoneOff: ['set', 300, {}],
  quiet: ['quiet', null, { on: false, from: 1320, to: 420, tz: 0 }],
  keywords: ['words', [10, 40], []],
  streamer: ['bool', null, false],
  favCalls: ['bool', null, false],
  autoIdle: ['enum', [0, 5, 10, 15, 30, 60], 10],
};
export const PREF_DEFAULTS = Object.fromEntries(Object.entries(PREF_RULES).map(([k, r]) => [k, structuredClone(r[2])]));
export const MAX_PREFS_BYTES = 16 * 1024;

const PLACE_ID = /^[\w:.-]{1,80}$/;

// Check a patch of settings. Unknown names and bad values are refused with a
// sentence a person can read; null puts a setting back to its default.
export function cleanPrefs(patch, fail = (m) => { throw new Error(m); }) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('Those settings aren’t valid.');
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    const rule = PREF_RULES[k];
    if (!rule) fail(`“${String(k).slice(0, 40)}” isn’t a setting Snug knows.`);
    if (v === null) { out[k] = null; continue; }
    const [kind, spec] = rule;
    if (kind === 'enum') {
      if (!spec.includes(v)) fail(`That isn’t one of the choices for ${k}.`);
      out[k] = v;
    } else if (kind === 'int') {
      if (!Number.isInteger(v) || v < spec[0] || v > spec[1]) fail(`${k} goes from ${spec[0]} to ${spec[1]}.`);
      out[k] = v;
    } else if (kind === 'bool') {
      if (typeof v !== 'boolean') fail(`${k} is on or off.`);
      out[k] = v;
    } else if (kind === 'set') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) fail(`${k} isn’t valid.`);
      const keys = Object.keys(v).filter((id) => v[id] === true);
      if (keys.length > spec) fail(`${k} can hold up to ${spec} places.`);
      if (keys.some((id) => !PLACE_ID.test(id))) fail(`${k} has a place that isn’t valid.`);
      out[k] = Object.fromEntries(keys.map((id) => [id, true]));
    } else if (kind === 'quiet') {
      if (!v || typeof v !== 'object') fail('Quiet hours aren’t valid.');
      const mins = (x) => Number.isInteger(x) && x >= 0 && x < 1440;
      if (typeof v.on !== 'boolean' || !mins(v.from) || !mins(v.to)) fail('Quiet hours need a start and an end time.');
      if (!Number.isInteger(v.tz) || v.tz < -840 || v.tz > 840) fail('Quiet hours need your time zone.');
      // The named zone (e.g. Europe/Paris) follows daylight saving; tz is the
      // offset when it was saved, used if the zone is missing or unknown.
      if (v.zone !== undefined && !validZone(v.zone)) fail('Quiet hours need your time zone.');
      out[k] = { on: v.on, from: v.from, to: v.to, tz: v.tz, ...(v.zone !== undefined ? { zone: v.zone } : {}) };
    } else if (kind === 'words') {
      if (!Array.isArray(v)) fail('Highlight words are a list.');
      const words = [];
      for (const w of v) {
        if (typeof w !== 'string') fail('Highlight words are words.');
        const s = w.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
        if (!s) continue;
        if (s.length > spec[1]) fail(`Keep each highlight word to ${spec[1]} characters.`);
        if (!words.some((x) => x.toLowerCase() === s.toLowerCase())) words.push(s);
      }
      if (words.length > spec[0]) fail(`You can have up to ${spec[0]} highlight words.`);
      out[k] = words;
    }
  }
  return out;
}

// Merge a cleaned patch into stored settings (null drops back to the default).
export function mergePrefs(stored, patch) {
  const next = { ...stored };
  for (const [k, v] of Object.entries(patch)) { if (v === null) delete next[k]; else next[k] = v; }
  return next;
}

// A time zone name the platform knows (IANA, e.g. America/New_York).
const zones = new Map();
function zoneClock(zone) {
  if (!zones.has(zone)) {
    let f = null;
    try { f = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); } catch { f = null; }
    if (zones.size > 500) zones.clear();
    zones.set(zone, f);
  }
  return zones.get(zone);
}
export function validZone(zone) {
  return typeof zone === 'string' && /^[A-Za-z][\w+\-/]{0,63}$/.test(zone) && !!zoneClock(zone);
}
// Minutes after midnight in that zone at that moment, or null.
function zoneMinutes(zone, now) {
  const f = typeof zone === 'string' ? zoneClock(zone) : null;
  if (!f) return null;
  const parts = Object.fromEntries(f.formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  const h = Number(parts.hour) % 24, m = Number(parts.minute);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
}

// Quiet hours: is this moment inside them? from/to are minutes after
// midnight in the person's own time zone: the named zone when there is one
// (it follows daylight saving), else tz (Date#getTimezoneOffset() when saved).
export function inQuiet(q, now = Date.now()) {
  if (!q || !q.on || q.from === q.to) return false;
  const local = zoneMinutes(q.zone, now) ?? (((Math.floor(now / 60000) - q.tz) % 1440) + 1440) % 1440;
  return q.from < q.to ? local >= q.from && local < q.to : local >= q.from || local < q.to;
}

// When a custom status clears. `endOfDay` is the browser's own midnight.
export const CLEAR_AFTER = [['30m', '30 minutes'], ['1h', '1 hour'], ['4h', '4 hours'], ['today', 'Today'], ['never', 'Don’t clear']];
export function clearAt(choice, now = Date.now(), endOfDay = null) {
  const add = { '30m': 30 * 60000, '1h': 3600000, '4h': 4 * 3600000 }[choice];
  if (add) return now + add;
  if (choice === 'today') return endOfDay;
  return null;
}
export function endOfToday(now = new Date()) {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Does this message contain one of my highlight words (whole words, any case)?
export function hasKeyword(text, words) {
  if (!text || !words?.length) return false;
  const t = String(text).toLowerCase();
  return words.some((w) => new RegExp(`(^|[^\\p{L}\\p{N}_])${esc(w.toLowerCase())}(?![\\p{L}\\p{N}_])`, 'u').test(t));
}
// @everyone and @here, outside code. Only people who may post notices in a
// house can ping everyone; the server and the browser both check that.
export function everyonePing(text) {
  if (!text || !text.includes('@')) return null;
  const t = String(text).replace(/```[\s\S]*?```|`[^`\n]*`/g, ' ');
  const m = /(^|[^\w@])@(everyone|here)(?![\w])/.exec(t);
  return m ? m[2] : null;
}

// A readable name for the device a session came from, from its User-Agent.
export function deviceLabel(ua = '') {
  const s = String(ua);
  const app = /Electron\//.test(s) ? 'Snug desktop' : /Edg\//.test(s) ? 'Edge' : /Firefox\//.test(s) ? 'Firefox'
    : /Chrome\/|Chromium\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : /node|undici/i.test(s) ? 'Script' : 'Browser';
  const os = /Windows/.test(s) ? 'Windows' : /iPhone|iPad/.test(s) ? 'iPhone or iPad' : /Android/.test(s) ? 'Android'
    : /Mac OS X|Macintosh/.test(s) ? 'Mac' : /CrOS/.test(s) ? 'ChromeOS' : /Linux/.test(s) ? 'Linux' : '';
  return os ? `${app} on ${os}` : app;
}
