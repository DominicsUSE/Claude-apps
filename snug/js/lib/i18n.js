// Words on screen. Snug ships English only (0.13 dropped the Lithuanian
// translation and the Language picker); the lookup stays so every screen
// reads its words from one table. Pure: no DOM and no state of the app, so the
// browser and Node (tests, the server's shared helpers) use it alike.
//
// - t('key', { name }) looks the key up in the active language, then in
//   English (the source of truth, js/locales/en.js), then gives the key back.
//   {name} placeholders are filled from vars; a missing value leaves the
//   placeholder, so the gap is visible instead of silent.
// - A value can be a plural object, { one, few, many, other }, picked with
//   Intl.PluralRules for vars.count in that language.
// - setLocale(code) / locale(); onLocale(f) hears changes (js/lib/util.js
//   rebuilds its date formats with it).
// - fmtNumber / fmtDate format with the active language through Intl.
import en from '../locales/en.js';

// Each language named in its own words, as people look for it.
export const LANGUAGES = [
  { code: 'en', name: 'English' },
];
const TABLES = { en };
let current = 'en';
const listeners = new Set();
const rules = new Map();
const pluralRules = (code) => {
  if (!rules.has(code)) rules.set(code, new Intl.PluralRules(code));
  return rules.get(code);
};

// A table for a language Snug doesn't ship (tests, or a language being written).
export function defineLocale(code, table) { TABLES[code] = table; }

export const locale = () => current;
// Switch the language; anything unknown is English. Returns the language in force.
export function setLocale(code) {
  const next = Object.hasOwn(TABLES, code) ? code : 'en';
  if (next === current) return current;
  current = next;
  for (const f of listeners) f(current);
  return current;
}
export function onLocale(f) { listeners.add(f); return () => listeners.delete(f); }

// The first language in a browser's list that Snug has (navigator.languages), else English.
export function matchLanguage(list) {
  for (const tag of Array.isArray(list) ? list : []) {
    const base = String(tag || '').toLowerCase().split(/[-_]/)[0];
    if (base && Object.hasOwn(TABLES, base) && LANGUAGES.some((l) => l.code === base)) return base;
  }
  return 'en';
}
// The setting ('auto', or a language code) and the browser's list: the language to use.
export function resolveLanguage(pref, list) {
  if (pref && pref !== 'auto' && LANGUAGES.some((l) => l.code === pref)) return pref;
  return matchLanguage(list);
}

const has = (table, key) => table && Object.hasOwn(table, key) && table[key] !== '' && table[key] != null;
const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(vars, k) && vars[k] != null ? String(vars[k]) : m)) : s);

export function t(key, vars) {
  let lang = current;
  let v = TABLES[current]?.[key];
  if (!has(TABLES[current], key)) { lang = 'en'; v = en[key]; }
  if (v == null) return key;
  if (typeof v === 'object') {
    const n = Number(vars?.count);
    const form = v[pluralRules(lang).select(Number.isFinite(n) ? n : 0)];
    v = form || v.other || en[key]?.other || key;
  }
  return fill(v, vars);
}

// The browser languages, where there is a browser (Node has navigator too, from 21).
const browserList = () => {
  try { return navigator.languages?.length ? navigator.languages : [navigator.language].filter(Boolean); } catch { return []; }
};
// The locale for Intl: the active language; for English, the browser's own
// English (en-GB keeps day-month dates) or plain 'en'.
export function intlLocale() {
  if (current !== 'en') return current;
  return browserList().find((l) => /^en\b/i.test(l)) || 'en';
}
export const fmtNumber = (n, opts) => new Intl.NumberFormat(intlLocale(), opts).format(n);
export const fmtDate = (ts, opts) => new Intl.DateTimeFormat(intlLocale(), opts).format(ts);
