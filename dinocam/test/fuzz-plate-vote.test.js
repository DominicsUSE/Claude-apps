// 1,000,000 randomized cases against applyPlateVote() - the temporal vote-accumulation +
// promotion decision that drives how fast a plate goes from "candidate" to "confirmed" on the
// live camera (the exact logic behind this session's "stop needing to lock the region" and
// "make it faster" changes). Extracted directly out of ../index.html, not reimplemented; this
// function used to be duplicated almost identically in two places (primary + extra camera) and
// was never unit-tested on its own before this. Run: node fuzz-plate-vote.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf-8');
const start = html.indexOf('function applyPlateVote');
const end = html.indexOf('async function scanPlates');
if (start < 0 || end < 0) throw new Error('Could not find applyPlateVote markers in index.html');
const src = html.slice(start, end) + '\nmodule.exports = { applyPlateVote };';
const sandbox = { module: { exports: {} } };
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'index.html(extracted)' });
const { applyPlateVote } = sandbox.module.exports;
if (typeof applyPlateVote !== 'function') throw new Error('applyPlateVote did not extract as a function');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}

const SEED = 20261001;
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
const KEYS = ['ABC123', 'XYZ789', 'ZZZ000', 'A1B2C3']; // a small fixed key set so repeat votes on the same plate actually happen
const STATUSES = ['confirmed', 'candidate', 'unreadable'];

function randResult(malformed) {
  if (malformed) {
    const variants = [
      { key: KEYS[randInt(0, KEYS.length - 1)], value: null, confidence: NaN, status: 'confirmed' },
      { key: '', value: '', confidence: -50, status: 'confirmed' },
      { key: KEYS[0], value: 'X', confidence: Infinity, status: 'confirmed' },
      { key: undefined, value: undefined, confidence: undefined, status: undefined },
      { key: KEYS[0], value: 'X', confidence: 50, status: 'not-a-real-status' },
      {},
    ];
    return variants[randInt(0, variants.length - 1)];
  }
  const key = KEYS[randInt(0, KEYS.length - 1)];
  return { key, value: key, confidence: randInt(0, 100), status: STATUSES[randInt(0, 2)] };
}

console.log('Seed: ' + SEED + ' (re-run with this seed to reproduce any failure)\n');

const N = 1000000;
for (let i = 0; i < N; i++) {
  const malformed = i % 10 === 0;
  // Simulate one "track": a fresh Map, then a short sequence of votes (like several scans of
  // the same vehicle while it's in frame), checking invariants after every single application.
  const plateVotes = new Map();
  const seqLen = randInt(1, 6);
  let everConfirmedKey = null; // first key that ever got a 'confirmed' result, for the critical single-shot-promotion check

  for (let s = 0; s < seqLen; s++) {
    const r = randResult(malformed && s === 0); // keep malformed cases to the first vote in a sequence - realistic (one bad frame), and keeps later invariant checks meaningful
    // Must match applyPlateVote's own validity guard exactly - a 'confirmed' status with a
    // falsy key/value gets rejected (not stored) now, so it must not count as "ever confirmed" here either.
    const wellFormed = typeof r.key === 'string' && r.key && typeof r.value === 'string' && r.value;
    if (r.status === 'confirmed' && everConfirmedKey === null && wellFormed) everConfirmedKey = r.key;

    let result;
    try { result = applyPlateVote(plateVotes, r.key, r); }
    catch (e) { check('applyPlateVote#' + i + '.' + s + ' does not throw', false, { r, error: e.message }); continue; }

    check('applyPlateVote#' + i + '.' + s + ' returns an object with candidate/plate keys', 'candidate' in result && 'plate' in result, result);

    // Recompute the expected answer directly from the Map's own contents (the actual source of
    // truth after the call) and cross-check applyPlateVote's return value against it - this is
    // the real correctness check, not just "didn't crash".
    if (plateVotes.size > 0) {
      const entries = [...plateVotes];
      const best = entries.sort((a, b) => (b[1].n * 70 + b[1].score) - (a[1].n * 70 + a[1].score))[0];
      check('applyPlateVote#' + i + '.' + s + ' candidate matches the actual top-ranked entry', result.candidate === best[1].last, { got: result.candidate, expected: best[1].last });
      const shouldPromote = best[1].sawConfirmed || (best[1].n >= 3 && best[1].score / best[1].n >= 55);
      check('applyPlateVote#' + i + '.' + s + ' plate promotion matches the documented rule', (result.plate !== null) === shouldPromote, { result, bestEntry: best[1], shouldPromote });
    }
  }

  // THE critical behavioral invariant this whole change exists for: once any single vote for a
  // key came back 'confirmed', a follow-up vote for that SAME key (even a lower-confidence one)
  // must promote it to plate on the spot - it must never need to wait for more repeat votes.
  if (everConfirmedKey !== null) {
    const isTopRanked = [...plateVotes].sort((a, b) => (b[1].n * 70 + b[1].score) - (a[1].n * 70 + a[1].score))[0][0] === everConfirmedKey;
    if (isTopRanked) {
      check('applyPlateVote#' + i + ' a key that was ever confirmed stays promotable without waiting for 3 votes', plateVotes.get(everConfirmedKey).sawConfirmed === true, plateVotes.get(everConfirmedKey));
    }
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed (out of ' + (pass + fail) + ' total checks across ' + N + ' randomized vote sequences)');
process.exit(fail ? 1 : 0);
