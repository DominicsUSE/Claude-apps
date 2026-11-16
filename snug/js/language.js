// The language on screen (Settings > Appearance > Language). The choice is the
// synced setting S.prefs.lang ('auto' follows the browser; js/lib/account.js
// PREF_RULES), so it follows the account to every device. The last choice is
// also kept on this device (snug.lang), so the sign-in screen speaks it before
// anyone signs in, and after signing out.
import { S, emit, subscribe } from './store.js';
import { setLocale, resolveLanguage } from './lib/i18n.js';

const KEY = 'snug.lang';
const CHOICES = ['auto', 'en', 'lt'];
const valid = (v) => (CHOICES.includes(v) ? v : null);

export function deviceLanguage() {
  try { return valid(localStorage.getItem(KEY)); } catch { return null; }
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

// The select on Settings > Appearance. Everything re-renders with the new words, no reload.
export function setLanguage(pref) {
  if (!valid(pref)) return;
  S.prefs.lang = pref;
  rememberLanguage(pref);
  applyLanguage();
  emit();
}

// A change from another device or from the server's copy (js/account.js
// adopts it into S.prefs) is applied on the next change notification; it runs
// before the views draw, since this module subscribes before they mount.
applyLanguage();
subscribe(applyLanguage);
// The browser's own language list changing matters while the choice is "Match my browser".
try { addEventListener('languagechange', () => { applyLanguage(); emit(); }); } catch { /* not a browser */ }
