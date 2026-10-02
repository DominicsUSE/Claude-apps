// Broad international plate-format matrix against the real pipeline in ../index.html.
// Run: node plate-formats.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf-8');
const start = html.indexOf('/* ---------- plate text helpers');
const end = html.indexOf('/* ---------- OCR effort profiles ---------- */');
const src = html.slice(start, end) + '\nmodule.exports = { plateKey, plateCandidates, aggregateVotes, fixPlateChars };';
const sandbox = { module: { exports: {} } };
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'index.html(extracted)' });
const { plateCandidates, aggregateVotes, fixPlateChars } = sandbox.module.exports;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

function word(text, x0, conf) { const w = 14 * text.length; return { text, confidence: conf ?? 90, bbox: { x0, y0: 100, x1: x0 + w, y1: 130 } }; }
function line(words, y0, y1, conf) { return { words, bbox: { x0: words[0].bbox.x0, y0, x1: words[words.length - 1].bbox.x1, y1 }, text: words.map(w => w.text).join(' '), confidence: conf ?? 90 }; }
function gap(prevWord, px) { return prevWord.bbox.x1 + px; }

// Repeats a one-pass reading N times (as if OCR agreed across N passes) and aggregates.
function confirm(data, n = 4) {
  const passes = [];
  for (let i = 0; i < n; i++) passes.push(plateCandidates(data));
  return aggregateVotes(passes, { confirmN: 3, confirmScore: 55 });
}

const cases = [
  // [name, words-as-[text,gapAfterPx][], expectedPlate]
  ['UK single-line "AB12 CDE"', [['AB12', 40], ['CDE', 0]], 'AB12 CDE'],
  ['US single-word "7ABC123"', [['7ABC123', 0]], '7ABC123'],
  ['US hyphenated "ABC-1234" (OCR as one token)', [['ABC-1234', 0]], 'ABC1234'],
  ['German 3-segment "B MV 1234"', [['B', 45], ['MV', 45], ['1234', 0]], 'B MV 1234'],
  ['German 2-letter district "HH XY 99"', [['HH', 45], ['XY', 45], ['99', 0]], 'HH XY 99'],
  ['Lithuanian 3+3 "ABC 123"', [['ABC', 45], ['123', 0]], 'ABC 123'],
  ['Lithuanian glued "ABC123"', [['ABC123', 0]], 'ABC123'],
  ['Swedish 3+3 "ABC 123"', [['ABC', 45], ['123', 0]], 'ABC 123'],
  ['Hungarian 3+3 "ABC-123"', [['ABC-123', 0]], 'ABC123'],
  ['Luxembourg 2+4 "XY 3456"', [['XY', 45], ['3456', 0]], 'XY 3456'],
  ['Danish 2+5 "AB 12345"', [['AB', 45], ['12345', 0]], 'AB 12345'],
  ['Spanish 4+3 (digits-then-letters) "1234 BCF"', [['1234', 45], ['BCF', 0]], '1234 BCF'],
  ['Estonian 3+3 (digits-then-letters) "123 ABC"', [['123', 45], ['ABC', 0]], '123 ABC'],
  ['Latvian 2+4 "AB-1234"', [['AB-1234', 0]], 'AB1234'],
  ['Cypriot 3+3 "ABC 123"', [['ABC', 45], ['123', 0]], 'ABC 123'],
  ['Maltese 3+3 "ZZZ 999"', [['ZZZ', 45], ['999', 0]], 'ZZZ 999'],
  ['Greek 3+4 "AAA 1000"', [['AAA', 45], ['1000', 0]], 'AAA 1000'],
  ['Slovenian region+serial 2+2+3 "KR AB-123"', [['KR', 45], ['AB-123', 0]], 'KR AB123'],
  ['Slovak letter-digit-letter "AB123CD" (own family, not corrected)', [['AB123CD', 0]], 'AB123CD'],
  ['Croatian letter-digit-letter "AB 123-CD"', [['AB', 45], ['123-CD', 0]], 'AB 123CD'],
  ['Bulgarian letter-digit-letter "A1234BC"', [['A1234BC', 0]], 'A1234BC'],
  ['Romanian letter-digit-letter "AB123CDE"', [['AB123CDE', 0]], 'AB123CDE'],
  ['Portuguese letter-digit-letter "AA-00-AA"', [['AA-00-AA', 0]], 'AA00AA'],
  ['French 3-segment "AB-123-CD"', [['AB-123-CD', 0]], 'AB123CD'],
  ['Dutch "12-ABC-3"', [['12-ABC-3', 0]], '12ABC3'],
  ['Australian "ABC123"', [['ABC123', 0]], 'ABC123'],
  ['Brazilian Mercosul "ABC1D23"', [['ABC1D23', 0]], 'ABC1D23'],
  ['digits-only plate "1234567"', [['1234567', 0]], '1234567'],
  ['letters-only vanity plate "DRIVER"', [['DRIVER', 0]], 'DRIVER'],
  ['short 2-char plate "A1"', [['A1', 0]], 'A1'],
  ['long 3-segment "AB 1234 CD"', [['AB', 45], ['1234', 45], ['CD', 0]], 'AB 1234 CD'],
  ['tight kerning glued "AB12CDE" as one token', [['AB12CDE', 0]], 'AB12CDE'],
  ['four segments "A 1 2 3"', [['A', 45], ['1', 45], ['2', 45], ['3', 0]], 'A 1 2 3'],
];

for (const [name, words, expected] of cases) {
  const built = [];
  let x = 0;
  for (const [text, gapPx] of words) {
    const w = word(text, x);
    built.push(w);
    x = w.bbox.x1 + gapPx;
  }
  const data = { lines: [line(built, 0, 30)] };
  const result = confirm(data);
  check(name + ' -> confirmed', result.status === 'confirmed', JSON.stringify(result));
  check(name + ' -> value "' + expected + '"', result.value === expected, 'got ' + JSON.stringify(result.value));
}

// ---- Two-row plates (common on motorcycles, and some EU/older formats) ----
{
  const top = word('AB12', 0);
  const bottom = word('CDE', 0);
  const data = { lines: [line([top], 0, 30), line([bottom], 40, 70)] };
  const result = confirm(data);
  check('two-row "AB12 / CDE"', result.status === 'confirmed' && result.value === 'AB12 CDE', JSON.stringify(result));
}

// ---- Lower-case OCR output must still normalize correctly ----
{
  const w1 = { text: 'ab12', confidence: 90, bbox: { x0: 0, y0: 100, x1: 60, y1: 130 } };
  const w2 = { text: 'cde', confidence: 90, bbox: { x0: 100, y0: 100, x1: 140, y1: 130 } };
  const data = { lines: [line([w1, w2], 0, 30)] };
  const result = confirm(data);
  check('lowercase OCR normalizes to "AB12 CDE"', result.value === 'AB12 CDE', JSON.stringify(result));
}

// ---- Noisy single character stuck to a real plate shouldn't corrupt the read ----
{
  // simulates a stray reflection/sticker OCR'd as a junk single char near the plate
  const real = word('XY99ZZZ', 0);
  const junk = { text: '.', confidence: 20, bbox: { x0: 200, y0: 100, x1: 205, y1: 105 } };
  const data = { lines: [line([real], 0, 30), line([junk], 40, 46)] };
  const result = confirm(data);
  check('junk fragment does not corrupt a clean read', result.value === 'XY99ZZZ', JSON.stringify(result));
}

// ---- Conflicting reads across passes (simulating motion blur variance) should NOT confirm ----
{
  const passes = [
    plateCandidates({ lines: [line([word('AB12CDE', 0)], 0, 30)] }),
    plateCandidates({ lines: [line([word('AB12CDF', 0)], 0, 30)] }), // one char different each time
    plateCandidates({ lines: [line([word('AB13CDE', 0)], 0, 30)] }),
    plateCandidates({ lines: [line([word('AB12CD3', 0)], 0, 30)] }),
  ];
  const result = aggregateVotes(passes, { confirmN: 3, confirmScore: 55 });
  check('motion-blur variance does not falsely confirm', result.status !== 'confirmed', JSON.stringify(result));
}

// ---- Lithuania/Germany shape-aware OCR correction (fixPlateChars) end-to-end through a full
// OCR-pass simulation: a plate consistently misread with a classic O/0-family confusion in a
// position its letters-then-digits shape rules out must still confirm as the corrected reading. ----
{
  // Lithuanian "ABC123" with the trailing digit consistently OCR'd as letter 'O' instead of '0'.
  const result = confirm({ lines: [line([word('ABC1O3', 0)], 0, 30)] });
  check('Lithuanian O/0 confusion corrects to "ABC103"', result.status === 'confirmed' && result.value === 'ABC103', JSON.stringify(result));
}
{
  // German "M AB 1023" with the digit '0' consistently OCR'd as letter 'O'.
  const built = [word('M', 0)];
  built.push(word('AB', built[0].bbox.x1 + 45));
  built.push(word('1O23', built[1].bbox.x1 + 45));
  const result = confirm({ lines: [line(built, 0, 30)] });
  check('German O/0 confusion corrects to "M AB 1023"', result.status === 'confirmed' && result.value === 'M AB 1023', JSON.stringify(result));
}
{
  // Danish "AB 10345" with the digit '0' consistently OCR'd as letter 'O'.
  const built = [word('AB', 0)];
  built.push(word('1O345', built[0].bbox.x1 + 45));
  const result = confirm({ lines: [line(built, 0, 30)] });
  check('Danish O/0 confusion corrects to "AB 10345"', result.status === 'confirmed' && result.value === 'AB 10345', JSON.stringify(result));
}
{
  // Spanish "1254 BCF" (digits-then-letters) with the digit '5' consistently OCR'd as letter 'S'.
  const built = [word('12S4', 0)];
  built.push(word('BCF', built[0].bbox.x1 + 45));
  const result = confirm({ lines: [line(built, 0, 30)] });
  check('Spanish S/5 confusion corrects to "1254 BCF"', result.status === 'confirmed' && result.value === '1254 BCF', JSON.stringify(result));
}
{
  // Estonian "105 ABC" (digits-then-letters) with the digit '0' consistently OCR'd as letter 'O'.
  const built = [word('1O5', 0)];
  built.push(word('ABC', built[0].bbox.x1 + 45));
  const result = confirm({ lines: [line(built, 0, 30)] });
  check('Estonian O/0 confusion corrects to "105 ABC"', result.status === 'confirmed' && result.value === '105 ABC', JSON.stringify(result));
}
{
  // Greek "AAA 1008" (letters-then-digits) with the trailing digit '8' consistently OCR'd as letter 'B'.
  const built = [word('AAA', 0)];
  built.push(word('100B', built[0].bbox.x1 + 45));
  const result = confirm({ lines: [line(built, 0, 30)] });
  check('Greek B/8 confusion corrects to "AAA 1008"', result.status === 'confirmed' && result.value === 'AAA 1008', JSON.stringify(result));
}

// ---- fixPlateChars unit cases (direct, not through a full OCR-pass simulation) ----
const fixCases = [
  ['already-valid Lithuanian shape is unchanged', 'ABC123', 'ABC123'],
  ['already-valid German shape (with spaces) is unchanged', 'B MV 1234', 'B MV 1234'],
  ['trailing O corrected to 0 in a digit position', 'ABC1O3', 'ABC103'],
  ['S corrected to 5 in a digit position, spaces preserved', 'B MV 12S4', 'B MV 1254'],
  ['already-valid Danish shape (2 letters + 5 digits) is unchanged', 'AB 12345', 'AB 12345'],
  ['Danish O corrected to 0 in a digit position', 'AB 1O345', 'AB 10345'],
  ['already-valid Spanish shape (digits-then-letters) is unchanged', '1234 BCF', '1234 BCF'],
  ['Spanish S corrected to 5 in a digit position (mirror-image orientation)', '12S4 BCF', '1254 BCF'],
  ['already-valid Estonian shape (digits-then-letters, 3+3) is unchanged', '123 ABC', '123 ABC'],
  ['Estonian O corrected to 0 in a digit position', '1O5 ABC', '105 ABC'],
  ['already-valid Latvian shape (2+4) is unchanged', 'AB1234', 'AB1234'],
  ['already-valid Cypriot/Lithuanian-shape (3+3) is unchanged', 'ABC123', 'ABC123'],
  ['already-valid Greek shape (3+4) is unchanged', 'AAA 1000', 'AAA 1000'],
  ['Greek B corrected to 8 in a digit position', 'AAA 100B', 'AAA 1008'],
  ['already-valid Slovenian merged shape (4+3) is unchanged', 'KR AB123', 'KR AB123'],
  ['UK letters-digits-letters shape has no valid split - unchanged', 'AB12CDE', 'AB12CDE'],
  ['French letters-digits-letters shape has no valid split - unchanged', 'AB126FD', 'AB126FD'],
  ['Slovak/Croatian letter-digit-letter shape has no valid split - unchanged', 'AB123CD', 'AB123CD'],
  ['Romanian letter-digit-letter shape has no valid split - unchanged', 'AB123CDE', 'AB123CDE'],
  ['Portuguese letter-digit-letter shape has no valid split - unchanged', 'AA00AA', 'AA00AA'],
  ['too short for any shape - unchanged', 'A1', 'A1'],
  ['too long for any shape - unchanged', 'ABCDEFGHIJ', 'ABCDEFGHIJ'],
  ['empty string - unchanged', '', ''],
];
for (const [name, input, expected] of fixCases) {
  const got = fixPlateChars(input);
  check('fixPlateChars: ' + name, got === expected, 'input=' + JSON.stringify(input) + ' got=' + JSON.stringify(got) + ' expected=' + JSON.stringify(expected));
}
check('fixPlateChars is idempotent on its own output', fixPlateChars(fixPlateChars('ABC1O3')) === fixPlateChars('ABC1O3'));

// ---- fixPlateChars fuzz: 50,000 randomized strings, must never throw, must preserve length
// and non-alphanumeric characters exactly, and must be a stable fixed point (re-applying its
// own output never changes it further) ----
{
  const SEED = 20261002;
  function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const rand = mulberry32(SEED);
  function randInt(min, max) { return Math.floor(rand() * (max - min + 1)) + min; }
  const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -';
  let fuzzPass = 0, fuzzFail = 0;
  const N = 50000;
  for (let i = 0; i < N; i++) {
    const len = randInt(0, 11);
    let input = '';
    for (let j = 0; j < len; j++) input += CHARS[randInt(0, CHARS.length - 1)];
    let out;
    try { out = fixPlateChars(input); }
    catch (e) { fuzzFail++; console.log('FAIL  fixPlateChars fuzz#' + i + ' threw -> ' + JSON.stringify({ input, error: e.message })); continue; }
    let ok = typeof out === 'string' && out.length === input.length;
    if (ok) for (let k = 0; k < input.length; k++) if (!/[A-Za-z0-9]/.test(input[k]) && out[k] !== input[k]) ok = false;
    if (!ok) { fuzzFail++; console.log('FAIL  fixPlateChars fuzz#' + i + ' length/non-alnum preserved -> ' + JSON.stringify({ input, out })); continue; }
    let out2;
    try { out2 = fixPlateChars(out); } catch (e) { fuzzFail++; console.log('FAIL  fixPlateChars fuzz#' + i + ' re-apply threw -> ' + JSON.stringify({ input, out, error: e.message })); continue; }
    if (out2 !== out) { fuzzFail++; console.log('FAIL  fixPlateChars fuzz#' + i + ' not a stable fixed point -> ' + JSON.stringify({ input, out, out2 })); continue; }
    fuzzPass++;
  }
  pass += fuzzPass; fail += fuzzFail;
  console.log((fuzzFail ? 'FAIL  ' : 'PASS  ') + 'fixPlateChars fuzz: ' + fuzzPass + '/' + N + ' passed (never throws, preserves length/separators, stable fixed point)');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
