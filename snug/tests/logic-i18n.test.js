// Words on screen (js/lib/i18n.js, js/locales/en.js): English only since 0.13
// (the Lithuanian translation and the Language picker are gone). Plural forms
// follow Intl.PluralRules, t() falls back to English, English stays the exact
// text the rest of the tests (and people) already read, and a 'lt' kept by
// 0.12.0 reads as English.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import en from '../js/locales/en.js';
import { existsSync } from 'node:fs';
import {
  t, setLocale, locale, LANGUAGES, matchLanguage, resolveLanguage, defineLocale, onLocale, fmtNumber, fmtDate, intlLocale,
} from '../js/lib/i18n.js';
import { inviteWhy, INVITE_WHY, signupProblems } from '../js/lib/onboarding.js';
import { fmtDay, fmtWhen } from '../js/lib/util.js';
import { cleanPrefs, upgradePrefs, PREF_DEFAULTS, PREF_RULES } from '../js/lib/account.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const VAR = /\{(\w+)\}/g;
const varsOf = (s) => new Set([...String(s).matchAll(VAR)].map((m) => m[1]));
const isPlural = (v) => v && typeof v === 'object';
const strings = (v) => (isPlural(v) ? Object.values(v) : [v]);
test.afterEach(() => setLocale('en'));

test('English is the only language, and the Lithuanian file is gone', () => {
  assert.deepEqual(LANGUAGES.map((l) => [l.code, l.name]), [['en', 'English']]);
  assert.equal(locale(), 'en', 'English until something says otherwise');
  assert.equal(existsSync(join(root, 'js', 'locales', 'lt.js')), false);
  assert.equal(setLocale('lt'), 'en', 'asking for Lithuanian gives English');
});

test('no empty strings, and every value is a string or a plural object of strings', () => {
  for (const [k, v] of Object.entries(en)) {
    for (const s of strings(v)) {
      assert.equal(typeof s, 'string', `en ${k}`);
      assert.ok(s.trim().length > 0, `en ${k} is empty`);
    }
  }
  // English plural forms carry the same placeholders in each form.
  for (const [k, v] of Object.entries(en)) {
    if (!isPlural(v)) continue;
    const want = varsOf(v.other);
    for (const s of Object.values(v)) assert.deepEqual(varsOf(s), want, `en ${k}: “${s}”`);
  }
});

test('t(): interpolation and plurals by count', () => {
  assert.equal(t('house.members', { count: 1 }), '1 member');
  assert.equal(t('house.members', { count: 4 }), '4 members');
  assert.equal(t('auth.invitedBy', { name: 'Ines' }).includes('{house}'), true, 'a missing value leaves its placeholder, so the gap shows');
});

test('t(): falls back to English for a missing or empty translation, and to the key when nobody has it', () => {
  defineLocale('xx', { 'common.cancel': 'Ksancel', 'common.save': '' });
  setLocale('xx');
  assert.equal(t('common.cancel'), 'Ksancel');
  assert.equal(t('common.save'), 'Save', 'empty: English');
  assert.equal(t('common.close'), 'Close', 'missing: English');
  assert.equal(t('no.such.key'), 'no.such.key');
  assert.equal(setLocale('zz'), 'en', 'an unknown language is English');
});

test('onLocale hears each change once, and setLocale to the same language says nothing', () => {
  defineLocale('xy', {});
  const heard = [];
  const off = onLocale((c) => heard.push(c));
  setLocale('xy'); setLocale('xy'); setLocale('en');
  off();
  setLocale('xy');
  assert.deepEqual(heard, ['xy', 'en']);
});

test('choosing a language: always English, whatever the browser or an old setting says', () => {
  assert.equal(matchLanguage(['lt-LT', 'en-US']), 'en');
  assert.equal(matchLanguage(['de-DE', 'fr']), 'en');
  assert.equal(matchLanguage([]), 'en');
  assert.equal(matchLanguage(undefined), 'en');
  assert.equal(resolveLanguage('auto', ['lt-LT']), 'en');
  assert.equal(resolveLanguage('lt', ['en-US']), 'en');
  assert.equal(resolveLanguage('klingon', ['en-US']), 'en');
});

test('dates and numbers: English keeps the browser’s own English', () => {
  const ts = Date.UTC(2026, 0, 15, 12, 0);
  assert.match(intlLocale() || 'en', /^en\b/i);
  assert.equal(fmtNumber(1234.5), new Intl.NumberFormat(intlLocale()).format(1234.5));
  assert.equal(fmtDate(ts, { month: 'long', timeZone: 'UTC' }), 'January');
  const now = Date.now();
  assert.equal(fmtDay(now, now), 'Today');
  assert.equal(fmtDay(now - 86_400_000, now), 'Yesterday');
});

test('English is byte-for-byte what it was: invitation reasons and sign-up problems', () => {
  assert.equal(inviteWhy('expired'), 'This invitation has expired. Ask the person who sent it for a new link.');
  assert.equal(inviteWhy('nonsense'), INVITE_WHY.unknown);
  assert.equal(signupProblems({}).handle, 'Pick a username.');
  assert.equal(signupProblems({ handle: 'ab', name: 'A', password: 'short' }).password, 'Passwords need at least 8 characters. That’s 5.');
});

test('the language preference: auto or en; a lt from 0.12.0 is accepted and kept as auto', () => {
  assert.equal(PREF_DEFAULTS.lang, 'auto');
  assert.deepEqual(cleanPrefs({ lang: 'en' }), { lang: 'en' });
  assert.deepEqual(cleanPrefs({ lang: 'lt' }), { lang: 'auto' }, 'a 0.12.0 client sending lt is not refused');
  assert.deepEqual(upgradePrefs({ lang: 'lt', theme: 'dark' }), { lang: 'auto', theme: 'dark' }, 'stored lt reads as auto');
  assert.ok(!PREF_RULES.lang[1].includes('lt'), 'lt is no longer offered');
  assert.throws(() => cleanPrefs({ lang: 'fr' }));
});

test('every t() key written in the app exists in English', () => {
  const files = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith('.js')) files.push(p);
    }
  };
  walk(join(root, 'js'));
  const missing = [];
  let used = 0;
  for (const f of files) {
    if (f.includes(`${join('js', 'locales')}`)) continue;
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\bt\(\s*'([a-z][\w-]*(?:\.[\w-]+)+)'/g)) {
      used++;
      if (!(m[1] in en)) missing.push(`${f.slice(root.length + 1)}: ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
  assert.ok(used > 100, `the app uses t() (${used} calls found)`);
});
