// 1,000,000 randomized cases against decodePlateOutput() - the plate-specific ONNX model's
// output decoder, added alongside the model integration and (unlike the six functions fuzzed
// in fuzz-1000000.test.js) never fuzzed before. Extracted directly out of ../index.html.
// Run: node fuzz-plate-model-decode.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf-8');
const start = html.indexOf('const PLATE_MODEL_ALPHABET=');
const end = html.indexOf('async function scanPlateImage');
if (start < 0 || end < 0) throw new Error('Could not find plate-model markers in index.html');
const src = html.slice(start, end) + '\nmodule.exports = { decodePlateOutput, PLATE_MODEL_ALPHABET, PLATE_MODEL_SLOTS, PLATE_MODEL_PAD };';
const sandbox = { module: { exports: {} }, console, atob: () => '' };
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'index.html(extracted)' });
const { decodePlateOutput, PLATE_MODEL_ALPHABET, PLATE_MODEL_SLOTS, PLATE_MODEL_PAD } = sandbox.module.exports;
if (typeof decodePlateOutput !== 'function') throw new Error('decodePlateOutput did not extract as a function');

const VOCAB = PLATE_MODEL_ALPHABET.length;

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

// A real per-slot softmax distribution: `vocab` non-negative values summing to 1, with a
// randomized peakiness so both confident and ambiguous slots get exercised.
function randSoftmaxSlot(vocab) {
  const raw = new Array(vocab);
  const peaky = rand() < 0.5;
  for (let v = 0; v < vocab; v++) raw[v] = peaky ? Math.pow(rand(), randInt(1, 12)) : rand();
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  return raw.map(v => v / sum);
}

console.log('Seed: ' + SEED + ' (re-run with this seed to reproduce any failure)\n');

const N = 1000000;
for (let i = 0; i < N; i++) {
  const malformed = i % 10 === 0; // 10% deliberately malformed/degenerate inputs

  if (malformed) {
    const variants = [
      () => null,
      () => undefined,
      () => new Float32Array(0),
      () => new Float32Array(randInt(0, PLATE_MODEL_SLOTS * VOCAB - 1)), // too short
      () => 'not an array',
      () => 42,
      () => { const a = new Float32Array(PLATE_MODEL_SLOTS * VOCAB); a.fill(NaN); return a; },
      () => { const a = new Float32Array(PLATE_MODEL_SLOTS * VOCAB); a.fill(Infinity); return a; },
      () => { const a = new Float32Array(PLATE_MODEL_SLOTS * VOCAB); a.fill(-1); return a; }, // all-negative, no valid softmax
      () => { const a = new Float32Array(PLATE_MODEL_SLOTS * VOCAB); return a; }, // all-zero
    ];
    const input = variants[randInt(0, variants.length - 1)]();
    let r;
    try { r = decodePlateOutput(input, PLATE_MODEL_ALPHABET, PLATE_MODEL_SLOTS, PLATE_MODEL_PAD); }
    catch (e) { check('decodePlateOutput#' + i + ' does not throw on malformed input', false, { error: e.message }); continue; }
    check('decodePlateOutput#' + i + ' returns a string value on malformed input', typeof r.value === 'string', r);
    check('decodePlateOutput#' + i + ' returns a finite confidence on malformed input', Number.isFinite(r.confidence), r);
    check('decodePlateOutput#' + i + ' confidence within [0,100] on malformed input', r.confidence >= 0 && r.confidence <= 100, r);
    continue;
  }

  // Normal case: a real, well-formed batch of per-slot softmax distributions, with a randomly
  // chosen "true" character per slot and a random fraction of trailing slots set to padding.
  const trueChars = [];
  const padFrom = randInt(0, PLATE_MODEL_SLOTS); // slots [padFrom, SLOTS) are padding
  const flat = new Float32Array(PLATE_MODEL_SLOTS * VOCAB);
  for (let slot = 0; slot < PLATE_MODEL_SLOTS; slot++) {
    const isPad = slot >= padFrom;
    const ch = isPad ? PLATE_MODEL_PAD : PLATE_MODEL_ALPHABET[randInt(0, VOCAB - 2)]; // never randomly pick pad_char as a "real" char
    trueChars.push(ch);
    const dist = randSoftmaxSlot(VOCAB);
    // Force `ch` to be the UNAMBIGUOUS argmax (not just tied for it - a plain swap with
    // whatever was previously largest can leave a duplicate of that same value sitting at a
    // third index, tying with the target and making the "correct" answer ambiguous by
    // construction, not because of anything decodePlateOutput does) - then renormalize back
    // to a valid softmax distribution.
    const targetIdx = PLATE_MODEL_ALPHABET.indexOf(ch);
    const otherMax = Math.max(...dist.filter((_, idx) => idx !== targetIdx));
    dist[targetIdx] = otherMax + 0.05;
    const sum = dist.reduce((a, b) => a + b, 0);
    for (let v = 0; v < VOCAB; v++) flat[slot * VOCAB + v] = dist[v] / sum;
  }
  const expectedValue = trueChars.join('').replace(new RegExp(PLATE_MODEL_PAD + '+$'), '');

  let r;
  try { r = decodePlateOutput(flat, PLATE_MODEL_ALPHABET, PLATE_MODEL_SLOTS, PLATE_MODEL_PAD); }
  catch (e) { check('decodePlateOutput#' + i + ' does not throw', false, { error: e.message }); continue; }

  check('decodePlateOutput#' + i + ' returns a string', typeof r.value === 'string', r);
  check('decodePlateOutput#' + i + ' confidence is within [0,100]', r.confidence >= 0 && r.confidence <= 100, r);
  check('decodePlateOutput#' + i + ' never returns pad_char inside the value', !r.value.includes(PLATE_MODEL_PAD), r);
  check('decodePlateOutput#' + i + ' decodes the argmax character per slot correctly', r.value === expectedValue, { got: r.value, expected: expectedValue });
  // A real per-slot softmax distribution's argmax probability is always >= 1/vocab (it can't
  // be the winner while below the uniform baseline) - confidence must reflect that floor.
  if (expectedValue.length) check('decodePlateOutput#' + i + ' confidence respects the 1/vocab floor for a real distribution', r.confidence >= Math.floor(100 / VOCAB) - 1, r);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed (out of ' + (pass + fail) + ' total checks across ' + N + ' randomized cases)');
process.exit(fail ? 1 : 0);
