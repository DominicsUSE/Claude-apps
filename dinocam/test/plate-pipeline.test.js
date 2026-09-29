// Regression test for the plate-recognition pipeline in ../index.html.
// Extracts the pure, DOM-free recognition functions directly out of the shipped app
// (not a copy) and drives them with constructed Tesseract-shaped OCR fixtures, so this
// always tests the actual code that ships, not a fork of it. Run: node plate-pipeline.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf-8');
const start = html.indexOf('/* ---------- plate text helpers');
const end = html.indexOf('/* ---------- OCR effort profiles ---------- */');
if (start < 0 || end < 0) throw new Error('Could not find plate-helper markers in index.html — did the section get renamed?');
const src = html.slice(start, end) + '\nmodule.exports = { plateKey, tidyToken, lineReading, fullCropReading, isPlausibleKey, plateCandidates, aggregateVotes };';
const sandbox = { module: { exports: {} } };
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'index.html(extracted)' });
const { plateKey, lineReading, fullCropReading, isPlausibleKey, plateCandidates, aggregateVotes } = sandbox.module.exports;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

// helper to build a tesseract-shaped word
function word(text, x0, conf) {
  const w = 14 * text.length;
  return { text, confidence: conf ?? 90, bbox: { x0, y0: 100, x1: x0 + w, y1: 130 } };
}
function line(words, y0, y1, conf) {
  return { words, bbox: { x0: words[0].bbox.x0, y0, x1: words[words.length-1].bbox.x1, y1 }, text: words.map(w=>w.text).join(' '), confidence: conf ?? 90 };
}

// ---- Scenario 1: THE reported bug — two separate OCR lines "A022" and "NTC" ----
{
  const data = { lines: [
    line([word('A022', 0)], 0, 30),
    line([word('NTC', 0)], 60, 90),
  ]};
  const cands = plateCandidates(data);
  const full = cands.find(c => c.kind === 'full');
  check('two-line merge: full candidate exists', !!full, JSON.stringify(cands));
  check('two-line merge: full candidate is "A022 NTC"', full && full.value === 'A022 NTC', full && full.value);
  const ntcFrag = cands.find(c => c.kind === 'line' && c.value === 'NTC');
  check('two-line merge: letters-only fragment "NTC" NOT discarded', !!ntcFrag, JSON.stringify(cands));
}

// ---- Scenario 2: single line, two words with a real gap ----
{
  const w1 = word('A022', 0), w2 = word('NTC', w1.bbox.x1 + 60); // clear visual gap between groups
  const data = { lines: [ line([w1, w2], 0, 30) ] };
  const cands = plateCandidates(data);
  const full = cands.find(c => c.kind === 'full');
  check('single-line two-word: merges to "A022 NTC"', full && full.value === 'A022 NTC', full && full.value);
}

// ---- Scenario 2b: single line, tight glued token should NOT get a false space ----
{
  const w1 = word('AB', 0), w2 = word('12', w1.bbox.x1 + 2); // tiny gap, same group
  const data = { lines: [ line([w1, w2], 0, 30) ] };
  const cands = plateCandidates(data);
  const full = cands.find(c => c.kind === 'full');
  check('tight kerning: no spurious space inserted', full && full.value === 'AB12', full && full.value);
}

// ---- Scenario 3: fragments only ever seen SEPARATELY (never together in one crop) still
// combine into the right CONTENT, but must be honestly flagged as needing verification
// (not falsely "Confirmed") since the left-to-right order was never actually observed. ----
{
  const passCandidateLists = [];
  for (let i = 0; i < 4; i++) passCandidateLists.push(plateCandidates({ lines: [ line([word('A022', 0)], 0, 30) ] }));
  for (let i = 0; i < 4; i++) passCandidateLists.push(plateCandidates({ lines: [ line([word('NTC', 0)], 0, 30) ] }));
  const result = aggregateVotes(passCandidateLists, { confirmN: 3, confirmScore: 55 });
  check('never-co-occurring combo: content is right', result.value === 'A022 NTC' || result.value === 'NTC A022', result.value);
  check('never-co-occurring combo: NOT falsely Confirmed (order unverified)', result.status === 'candidate', JSON.stringify(result));
  check('never-co-occurring combo: source flags unordered', result.source === 'fragment-combo-unordered', result.source);
}

// ---- Scenario 3b: same two fragments, but at least one pass saw them TOGETHER (so the
// order is real, observed evidence) — this SHOULD be Confirmed. ----
{
  const passCandidateLists = [];
  for (let i = 0; i < 3; i++) passCandidateLists.push(plateCandidates({ lines: [ line([word('A022', 0)], 0, 30) ] }));
  for (let i = 0; i < 3; i++) passCandidateLists.push(plateCandidates({ lines: [ line([word('NTC', 0)], 0, 30) ] }));
  // one pass genuinely captured both (as two OCR lines), giving real left-to-right/top-to-bottom evidence
  passCandidateLists.push(plateCandidates({ lines: [ line([word('A022', 0)], 0, 30), line([word('NTC', 0)], 40, 70) ] }));
  const result = aggregateVotes(passCandidateLists, { confirmN: 3, confirmScore: 55 });
  check('co-occurring combo: Confirmed', result.status === 'confirmed', JSON.stringify(result));
  check('co-occurring combo: correct order "A022 NTC"', result.value === 'A022 NTC', result.value);
}

// ---- Scenario 4: letters-only FULL plate must not be hard-rejected ----
{
  const passCandidateLists = [];
  for (let i = 0; i < 4; i++) passCandidateLists.push(plateCandidates({ lines: [ line([word('NTC', 0)], 0, 30) ] }));
  const result = aggregateVotes(passCandidateLists, { confirmN: 3, confirmScore: 55 });
  check('letters-only plate NTC can be confirmed', result.status === 'confirmed' && result.value === 'NTC', JSON.stringify(result));
}

// ---- Scenario 5: digits-only plate must not be hard-rejected ----
{
  const passCandidateLists = [];
  for (let i = 0; i < 4; i++) passCandidateLists.push(plateCandidates({ lines: [ line([word('1234', 0)], 0, 30) ] }));
  const result = aggregateVotes(passCandidateLists, { confirmN: 3, confirmScore: 55 });
  check('digits-only plate 1234 can be confirmed', result.status === 'confirmed' && result.value === '1234', JSON.stringify(result));
}

// ---- Scenario 6: inconsistent noise must NOT be confirmed ----
{
  const junk = ['XQ7Z', 'ZZP9', 'K3JQ', 'M0WX'];
  const passCandidateLists = junk.map(t => plateCandidates({ lines: [ line([word(t, 0, 40)], 0, 30, 40) ] }));
  const result = aggregateVotes(passCandidateLists, { confirmN: 3, confirmScore: 55 });
  check('inconsistent noise stays unconfirmed', result.status !== 'confirmed', JSON.stringify(result));
}

// ---- Scenario 7: three-segment international plate (e.g. German-style "B MV 1234") ----
{
  const w1 = word('B', 0), w2 = word('MV', w1.bbox.x1 + 50), w3 = word('1234', w2.bbox.x1 + 50);
  const data = { lines: [ line([w1, w2, w3], 0, 30) ] };
  const cands = plateCandidates(data);
  const full = cands.find(c => c.kind === 'full');
  check('three-segment plate merges with spaces', full && full.value === 'B MV 1234', full && full.value);
}

// ---- Scenario 8: two-row physical plate (two lines close together, still separate) ----
{
  const data = { lines: [
    line([word('AB12', 0)], 0, 30),
    line([word('CDE', 0)], 35, 65), // stacked, second row
  ]};
  const cands = plateCandidates(data);
  const full = cands.find(c => c.kind === 'full');
  check('two-row plate merges top-to-bottom', full && full.value === 'AB12 CDE', full && full.value);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
