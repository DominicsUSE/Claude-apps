// Broad international plate-format matrix against the real pipeline in ../index.html.
// Run: node plate-formats.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf-8');
const start = html.indexOf('/* ---------- plate text helpers');
const end = html.indexOf('/* ---------- OCR effort profiles ---------- */');
const src = html.slice(start, end) + '\nmodule.exports = { plateKey, plateCandidates, aggregateVotes };';
const sandbox = { module: { exports: {} } };
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'index.html(extracted)' });
const { plateCandidates, aggregateVotes } = sandbox.module.exports;

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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
