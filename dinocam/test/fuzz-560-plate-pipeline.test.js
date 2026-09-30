// 560 randomized (property-based) test cases against the plate-OCR aggregation pipeline in
// ../index.html - extracted directly out of the shipped app, not reimplemented. This is the
// part of the app where a real bug (the A022/NTC merge issue) was found and fixed earlier -
// the most complex, most bug-prone logic here - and it had never been fuzzed with random
// inputs before, only hand-picked cases (plate-pipeline.test.js). Run: node fuzz-560-plate-pipeline.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf-8');
const start = html.indexOf('/* ---------- plate text helpers');
const end = html.indexOf('/* ---------- OCR effort profiles ---------- */');
if (start < 0 || end < 0) throw new Error('Could not find plate-helper markers in index.html');
const src = html.slice(start, end) + '\nmodule.exports = { plateKey, tidyToken, lineReading, fullCropReading, isPlausibleKey, plateCandidates, aggregateVotes };';
const sandbox = { module: { exports: {} } };
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'index.html(extracted)' });
const { plateKey, tidyToken, lineReading, fullCropReading, isPlausibleKey, plateCandidates, aggregateVotes } = sandbox.module.exports;
for (const [name, fn] of Object.entries({ plateKey, tidyToken, lineReading, fullCropReading, isPlausibleKey, plateCandidates, aggregateVotes }))
  if (typeof fn !== 'function') throw new Error(name + ' did not extract as a function');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}

const SEED = 560560;
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
function randInt(min, max) { return Math.floor(rand() * (max - min + 1)) + min; }
const PLATE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function randToken(len) { let s = ''; for (let i = 0; i < len; i++) s += PLATE_CHARS[randInt(0, PLATE_CHARS.length - 1)]; return s; }

// Builds one synthetic Tesseract-shaped OCR pass: 1-3 lines, each with 1-4 words placed at
// increasing x so line-reading's word-joining logic (gap detection) gets exercised too.
// A fraction of passes deliberately include malformed/missing fields to stress robustness.
function randPass(malformed) {
  let lineCount = randInt(1, 3);
  let lines = [];
  for (let li = 0; li < lineCount; li++) {
    let y0 = li * 40, y1 = y0 + 30;
    let wordCount = randInt(1, 4);
    let words = [], x = 0;
    for (let wi = 0; wi < wordCount; wi++) {
      if (malformed && rand() < 0.15) {
        // A deliberately broken word entry - must not crash the pipeline.
        const variants = [
          {}, { text: null }, { text: undefined }, { text: 42 },
          { text: randToken(3), bbox: null }, { text: randToken(3), bbox: {} },
          { text: '' }, { text: '   ' }, { text: '日本語🚗' },
        ];
        words.push(variants[randInt(0, variants.length - 1)]);
        continue;
      }
      let len = randInt(1, 6);
      let text = randToken(len);
      let w = 12 * len;
      let gap = rand() < 0.3 ? randInt(8, 30) : randInt(0, 3); // sometimes a real group gap, sometimes tight kerning
      x += gap;
      words.push({ text, confidence: randInt(0, 100), bbox: { x0: x, y0, x1: x + w, y1 } });
      x += w;
    }
    lines.push({ bbox: { y0, y1 }, words });
  }
  if (malformed && rand() < 0.1) return {}; // no lines at all
  return { lines };
}

console.log('Seed: ' + SEED + ' (re-run with this seed to reproduce any failure)\n');

const N = 560;
for (let i = 0; i < N; i++) {
  const malformed = i % 4 === 0; // 25% of cases deliberately include garbage/missing fields
  const passCount = randInt(1, 6);
  const passes = [];
  const allSourceChars = new Set(); // every character that appeared in any word's text across all passes

  for (let p = 0; p < passCount; p++) {
    const data = randPass(malformed);
    // Collect every character actually present in this pass's word text, tidied the same way
    // the app itself tidies it (uppercase, strip non-alphanumeric) - this is the ground truth
    // the "never invents characters" contract must be checked against.
    for (const line of data.lines || []) {
      for (const w of line.words || []) {
        const t = tidyToken(w && w.text);
        for (const ch of t) allSourceChars.add(ch);
      }
    }
    let cands;
    try { cands = plateCandidates(data); }
    catch (e) { check('plateCandidates#' + i + '.' + p + ' does not throw on ' + (malformed ? 'malformed' : 'normal') + ' input', false, { data, error: e.message }); cands = []; }
    passes.push(cands);
  }

  let result;
  try { result = aggregateVotes(passes); }
  catch (e) { check('aggregateVotes#' + i + ' does not throw', false, { passes, error: e.message }); continue; }

  check('aggregateVotes#' + i + ' returns one of the three valid statuses', ['confirmed', 'candidate', 'unreadable'].includes(result.status), result.status);
  check('aggregateVotes#' + i + ' confidence is within [0,100]', result.confidence >= 0 && result.confidence <= 100, result.confidence);

  if (result.status === 'unreadable') {
    check('aggregateVotes#' + i + ' unreadable has null value/key and 0 votes', result.value === null && result.key === null && result.votes === 0, result);
  } else {
    check('aggregateVotes#' + i + ' non-unreadable result has a non-empty value', typeof result.value === 'string' && result.value.length > 0, result);
    check('aggregateVotes#' + i + ' non-unreadable result has a non-empty key', typeof result.key === 'string' && result.key.length > 0, result);
    // THE core contract this pipeline exists to uphold (the exact bug class fixed earlier
    // this session): a combined/merged result must never contain a character that wasn't
    // actually present in SOME OCR pass's word text - it must only ever concatenate real
    // reads, never invent or hallucinate a character.
    const resultChars = new Set(tidyToken(result.value));
    const invented = [...resultChars].filter(ch => !allSourceChars.has(ch));
    check('aggregateVotes#' + i + ' never invents a character not seen in any OCR pass', invented.length === 0, { value: result.value, invented, allSourceChars: [...allSourceChars] });
    // key must match plateKey(value) exactly - no drift between the two fields.
    check('aggregateVotes#' + i + ' key is exactly plateKey(value)', result.key === plateKey(result.value), result);
  }
}

// A few specific edge cases beyond the random sweep: totally empty input, a single empty pass,
// and a pass list containing only malformed entries - the aggregator's own input, not just
// plateCandidates' input, must degrade gracefully.
for (const edge of [[], [[]], [[], [], []], null, undefined]) {
  let result;
  try { result = aggregateVotes(edge); }
  catch (e) { check('aggregateVotes handles edge case ' + JSON.stringify(edge) + ' without throwing', false, { error: e.message }); continue; }
  check('aggregateVotes handles edge case ' + JSON.stringify(edge) + ' without throwing', result && result.status === 'unreadable', result);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed (out of ' + (pass + fail) + ' total checks across ' + N + ' randomized pipeline runs)');
process.exit(fail ? 1 : 0);
