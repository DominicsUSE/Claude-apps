// Tests decodePlateOutput() - the pure argmax+softmax decoder for the plate-specific ONNX
// model's output - extracted directly out of ../index.html, not reimplemented.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { test } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf-8');
const start = html.indexOf("const PLATE_MODEL_ALPHABET=");
const end = html.indexOf('async function scanPlateImage');
if (start < 0 || end < 0) throw new Error('Could not find plate-model markers in index.html');
const src = html.slice(start, end) + '\nmodule.exports = { decodePlateOutput, PLATE_MODEL_ALPHABET, PLATE_MODEL_SLOTS, PLATE_MODEL_PAD };';
const sandbox = { module: { exports: {} }, console, atob: () => '' };
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'index.html(extracted)' });
const { decodePlateOutput, PLATE_MODEL_ALPHABET, PLATE_MODEL_SLOTS, PLATE_MODEL_PAD } = sandbox.module.exports;
if (typeof decodePlateOutput !== 'function') throw new Error('decodePlateOutput did not extract as a function');

const VOCAB = PLATE_MODEL_ALPHABET.length;

// Builds a flat (slots*vocab) array matching the real model's actual output convention: each
// slot is ALREADY a softmax probability distribution (values in [0,1] summing to ~1 per slot),
// not raw logits - decodePlateOutput takes the argmax value directly as its confidence, it does
// not re-run softmax. `winProb` is the probability mass given to the target character; the rest
// is split evenly across the other classes.
function buildLogits(text, slots, winProb = 0.98) {
  const arr = new Float32Array(slots * VOCAB);
  const rest = (1 - winProb) / (VOCAB - 1);
  for (let slot = 0; slot < slots; slot++) {
    const ch = slot < text.length ? text[slot] : PLATE_MODEL_PAD;
    const idx = PLATE_MODEL_ALPHABET.indexOf(ch);
    for (let v = 0; v < VOCAB; v++) arr[slot * VOCAB + v] = v === idx ? winProb : rest;
  }
  return arr;
}

test('decodes a confident plate and strips trailing padding', () => {
  const logits = buildLogits('ABC123', PLATE_MODEL_SLOTS, 0.98);
  const r = decodePlateOutput(logits, PLATE_MODEL_ALPHABET, PLATE_MODEL_SLOTS, PLATE_MODEL_PAD);
  assert.strictEqual(r.value, 'ABC123');
  assert.ok(r.confidence >= 95, 'confidence should be near 100 for a very peaked distribution: ' + r.confidence);
});

test('confidence is lower for a flatter (less certain) distribution', () => {
  const peaked = decodePlateOutput(buildLogits('XYZ', PLATE_MODEL_SLOTS, 0.98), PLATE_MODEL_ALPHABET, PLATE_MODEL_SLOTS, PLATE_MODEL_PAD);
  const flat = decodePlateOutput(buildLogits('XYZ', PLATE_MODEL_SLOTS, 0.1), PLATE_MODEL_ALPHABET, PLATE_MODEL_SLOTS, PLATE_MODEL_PAD);
  assert.ok(flat.confidence < peaked.confidence, `flat (${flat.confidence}) should be less confident than peaked (${peaked.confidence})`);
});

test('an all-padding output decodes to an empty value with 0 confidence contribution', () => {
  const logits = buildLogits('', PLATE_MODEL_SLOTS, 0.98);
  const r = decodePlateOutput(logits, PLATE_MODEL_ALPHABET, PLATE_MODEL_SLOTS, PLATE_MODEL_PAD);
  assert.strictEqual(r.value, '');
});

test('a full 10-character plate with no padding is not truncated', () => {
  const text = 'ABCDEFGHIJ'.slice(0, PLATE_MODEL_SLOTS);
  const logits = buildLogits(text, PLATE_MODEL_SLOTS, 0.98);
  const r = decodePlateOutput(logits, PLATE_MODEL_ALPHABET, PLATE_MODEL_SLOTS, PLATE_MODEL_PAD);
  assert.strictEqual(r.value, text);
});

test('null logits does not throw and yields an empty unreadable result', () => {
  const r = decodePlateOutput(null, PLATE_MODEL_ALPHABET, PLATE_MODEL_SLOTS, PLATE_MODEL_PAD);
  assert.strictEqual(r.value, '');
  assert.strictEqual(r.confidence, 0);
});

test('a too-short logits array does not throw and yields an empty unreadable result', () => {
  const r = decodePlateOutput(new Float32Array(5), PLATE_MODEL_ALPHABET, PLATE_MODEL_SLOTS, PLATE_MODEL_PAD);
  assert.strictEqual(r.value, '');
  assert.strictEqual(r.confidence, 0);
});

test('works with a plain Array, not just a typed array (defensive against either)', () => {
  const logits = Array.from(buildLogits('Z9', PLATE_MODEL_SLOTS, 0.98));
  const r = decodePlateOutput(logits, PLATE_MODEL_ALPHABET, PLATE_MODEL_SLOTS, PLATE_MODEL_PAD);
  assert.strictEqual(r.value, 'Z9');
});

test('confidence is always within [0,100] across a range of win-probability values', () => {
  for (const winProb of [1 / VOCAB, 0.1, 0.3, 0.6, 0.9, 0.999]) {
    const r = decodePlateOutput(buildLogits('AB1', PLATE_MODEL_SLOTS, winProb), PLATE_MODEL_ALPHABET, PLATE_MODEL_SLOTS, PLATE_MODEL_PAD);
    assert.ok(r.confidence >= 0 && r.confidence <= 100, `confidence out of range for winProb=${winProb}: ${r.confidence}`);
  }
});

test('a confidence of exactly 1/vocab (uniform distribution) decodes to ~3% not ~0 or ~100', () => {
  // 1/37 ≈ 2.7% - sanity check that the raw model value is used directly as the probability,
  // not re-normalized against a different baseline.
  const r = decodePlateOutput(buildLogits('A', PLATE_MODEL_SLOTS, 1 / VOCAB), PLATE_MODEL_ALPHABET, PLATE_MODEL_SLOTS, PLATE_MODEL_PAD);
  assert.ok(r.confidence >= 1 && r.confidence <= 5, `expected ~3% for a uniform distribution, got ${r.confidence}`);
});
