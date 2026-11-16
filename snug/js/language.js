// The language on screen. Snug speaks English only since 0.13 (the Lithuanian
// translation and Settings > Appearance > Language are gone). The synced
// setting S.prefs.lang ('auto' or 'en'; js/lib/account.js PREF_RULES) and the
// device copy (snug.lang) stay so 0.12.0 data loads: a 'lt' kept by 0.12.0
// reads as English and is forgotten on this device.
import { S, subscribe } from './store.js';
import { setLocale, resolveLanguage } from './lib/i18n.js';

const KEY = 'snug.lang';
const CHOICES = ['auto', 'en'];
const valid = (v) => (CHOICES.includes(v) ? v : null);

export function deviceLanguage() {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'lt') localStorage.removeItem(KEY); // 0.12.0's Lietuvių: English now
    return valid(v);
  } catch { return null; }
}
// Remember the choice on this device (the server's copy, or one made here).
export function rememberLanguage(pref) {
  if (!valid(pref)) return;
  try { localStorage.setItem(KEY, pref); } catch { /* storage blocked: the account still has it */ }
}
const browserLanguages = () => {
  try { return navigator.languages?.length ? navigator.languages : [navigator.language]; } catch { return []; }
};
// The device copy follows every change of the account's choice (made here, or
// adopted from the server by js/account.js), so it is the one to read. It also
// outlives signing out, which puts S.prefs back to the defaults.
export const languagePref = () => deviceLanguage() || valid(S.prefs.lang) || 'auto';

export function applyLanguage() {
  const code = setLocale(resolveLanguage(languagePref(), browserLanguages()));
  const root = document.documentElement;
  if (root.lang !== code) root.lang = code;
  return code;
}

// A change from another device or from the server's copy (js/account.js
// adopts it into S.prefs) is applied on the next change notification; it runs
// before the views draw, since this module subscribes before they mount.
applyLanguage();
subscribe(applyLanguage);
