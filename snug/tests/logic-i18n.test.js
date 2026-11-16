// Localization (js/lib/i18n.js, js/locales/*.js): the Lithuanian table matches
// the English one key for key and placeholder for placeholder, plural forms
// follow Intl.PluralRules, t() falls back to English, and English stays the
// exact text the rest of the tests (and people) already read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import en from '../js/locales/en.js';
import lt from '../js/locales/lt.js';
import {
  t, setLocale, locale, LANGUAGES, matchLanguage, resolveLanguage, defineLocale, onLocale, fmtNumber, fmtDate, intlLocale,
} from '../js/lib/i18n.js';
import { inviteWhy, INVITE_WHY, signupProblems } from '../js/lib/onboarding.js';
import { fmtDay, fmtWhen } from '../js/lib/util.js';
import { cleanPrefs, PREF_DEFAULTS } from '../js/lib/account.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const VAR = /\{(\w+)\}/g;
const varsOf = (s) => new Set([...String(s).matchAll(VAR)].map((m) => m[1]));
const isPlural = (v) => v && typeof v === 'object';
const strings = (v) => (isPlural(v) ? Object.values(v) : [v]);
test.afterEach(() => setLocale('en'));

test('the language list names each language in its own words', () => {
  assert.deepEqual(LANGUAGES.map((l) => [l.code, l.name]), [['en', 'English'], ['lt', 'Lietuvių']]);
  assert.equal(locale(), 'en', 'English until something says otherwise');
});

test('every Lithuanian key exists in English, the source of truth', () => {
  const extra = Object.keys(lt).filter((k) => !(k in en));
  assert.deepEqual(extra, []);
});

test('no empty strings, and every value is a string or a plural object of strings', () => {
  for (const [name, table] of [['en', en], ['lt', lt]]) {
    for (const [k, v] of Object.entries(table)) {
      for (const s of strings(v)) {
        assert.equal(typeof s, 'string', `${name} ${k}`);
        assert.ok(s.trim().length > 0, `${name} ${k} is empty`);
      }
    }
  }
});

test('placeholders match: every {var} in English is in the Lithuanian and the other way round', () => {
  for (const [k, v] of Object.entries(lt)) {
    const want = varsOf(strings(en[k]).join(' '));
    assert.equal(isPlural(v), isPlural(en[k]), `${k}: plural in one language only`);
    for (const s of strings(v)) assert.deepEqual(varsOf(s), want, `${k}: “${s}”`);
  }
  // English plural forms carry the same placeholders in each form, too.
  for (const [k, v] of Object.entries(en)) {
    if (!isPlural(v)) continue;
    const want = varsOf(v.other);
    for (const s of Object.values(v)) assert.deepEqual(varsOf(s), want, `en ${k}: “${s}”`);
  }
});

test('plural objects have exactly the categories Intl.PluralRules gives each language', () => {
  const cats = (code) => new Intl.PluralRules(code).resolvedOptions().pluralCategories.slice().sort();
  assert.deepEqual(cats('lt'), ['few', 'many', 'one', 'other'], 'Lithuanian has one, few, many and other');
  for (const [code, table] of [['en', en], ['lt', lt]]) {
    for (const [k, v] of Object.entries(table)) if (isPlural(v)) assert.deepEqual(Object.keys(v).sort(), cats(code), `${code} ${k}`);
  }
  assert.ok(Object.values(lt).some(isPlural), 'there is at least one plural to check');
});

test('t(): interpolation, plurals by count, and Lithuanian forms for 1, 2, 10, 21 and 1.5', () => {
  assert.equal(t('house.members', { count: 1 }), '1 member');
  assert.equal(t('house.members', { count: 4 }), '4 members');
  setLocale('lt');
  assert.equal(locale(), 'lt');
  assert.equal(t('house.members', { count: 1 }), '1 narys');
  assert.equal(t('house.members', { count: 2 }), '2 nariai');
  assert.equal(t('house.members', { count: 10 }), '10 narių');
  assert.equal(t('house.members', { count: 21 }), '21 narys');
  assert.equal(t('house.members', { count: 1.5 }), '1.5 nario');
  assert.equal(t('auth.invitedBy', { name: 'Ines', house: 'Kiln & Co.' }), lt['auth.invitedBy'].replace('{name}', 'Ines').replace('{house}', 'Kiln & Co.'));
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
  const heard = [];
  const off = onLocale((c) => heard.push(c));
  setLocale('lt'); setLocale('lt'); setLocale('en');
  off();
  setLocale('lt');
  assert.deepEqual(heard, ['lt', 'en']);
});

test('choosing a language: the browser list, then English; an explicit choice wins', () => {
  assert.equal(matchLanguage(['lt-LT', 'en-US']), 'lt');
  assert.equal(matchLanguage(['de-DE', 'LT']), 'lt', 'the first language Snug has, any case');
  assert.equal(matchLanguage(['de-DE', 'fr']), 'en');
  assert.equal(matchLanguage([]), 'en');
  assert.equal(matchLanguage(undefined), 'en');
  assert.equal(resolveLanguage('auto', ['lt-LT']), 'lt');
  assert.equal(resolveLanguage('en', ['lt-LT']), 'en');
  assert.equal(resolveLanguage('lt', ['en-US']), 'lt');
  assert.equal(resolveLanguage('klingon', ['en-US']), 'en');
});

test('dates and numbers follow the language; English keeps the browser’s own English', () => {
  const ts = Date.UTC(2026, 0, 15, 12, 0);
  setLocale('lt');
  assert.equal(intlLocale(), 'lt');
  assert.equal(fmtNumber(1234.5), new Intl.NumberFormat('lt').format(1234.5));
  assert.equal(fmtDate(ts, { month: 'long', timeZone: 'UTC' }), new Intl.DateTimeFormat('lt', { month: 'long', timeZone: 'UTC' }).format(ts));
  const now = Date.now();
  assert.equal(fmtDay(now, now), 'Šiandien');
  assert.equal(fmtDay(now - 86_400_000, now), 'Vakar');
  assert.match(fmtWhen(now - 86_400_000, now), /^Vakar /);
  setLocale('en');
  assert.match(intlLocale() || 'en', /^en\b/i);
  assert.equal(fmtDay(now, now), 'Today');
  assert.equal(fmtDay(now - 86_400_000, now), 'Yesterday');
});

test('English is byte-for-byte what it was: invitation reasons and sign-up problems', () => {
  assert.equal(inviteWhy('expired'), 'This invitation has expired. Ask the person who sent it for a new link.');
  assert.equal(inviteWhy('nonsense'), INVITE_WHY.unknown);
  assert.equal(signupProblems({}).handle, 'Pick a username.');
  assert.equal(signupProblems({ handle: 'ab', name: 'A', password: 'short' }).password, 'Passwords need at least 8 characters. That’s 5.');
  setLocale('lt');
  assert.equal(inviteWhy('expired'), lt['invite.why.expired']);
  assert.notEqual(signupProblems({}).handle, 'Pick a username.');
  assert.equal(INVITE_WHY.expired, 'This invitation has expired. Ask the person who sent it for a new link.', 'the server’s copy stays English');
});

test('the language preference follows the account: auto, en or lt, nothing else', () => {
  assert.equal(PREF_DEFAULTS.lang, 'auto');
  assert.deepEqual(cleanPrefs({ lang: 'lt' }), { lang: 'lt' });
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

test('the Lithuanian file says it needs a native speaker’s review, and uses Lithuanian letters', () => {
  const src = readFileSync(join(root, 'js', 'locales', 'lt.js'), 'utf8');
  assert.match(src.slice(0, 600), /native speaker/i);
  assert.match(Object.values(lt).flatMap(strings).join(' '), /[ąčęėįšųūž]/);
  const same = Object.keys(lt).filter((k) => !isPlural(lt[k]) && lt[k] === en[k] && /[a-z]{4}/i.test(lt[k]));
  assert.ok(same.length <= 3, `left in English: ${same.join(', ')}`);
});
