// 1000-iteration randomized (fuzz/property-based) stress test of the app's real matching and
// recognition logic - extracted directly out of ../index.html, not reimplemented, so this
// always tests the actual code that ships. Unlike the hand-picked-case tests elsewhere in this
// directory, this generates hundreds of randomized inputs per function and checks invariants
// that must hold for ANY input, rather than a fixed list of expected outputs - the point is to
// surface edge cases (empty strings, huge inputs, negative numbers, garbage keypoints, unicode)
// that a small set of examples wouldn't stumble into.
//
// This does NOT retrain or fuzz the underlying pretrained models (face-api.js/coco-ssd/
// Tesseract/pose-detection) - those are fixed third-party models this app never trains. What
// IS "trainable" here is the app's own personalization memory (enrolled faces, watchlist
// plates) and the matching logic layered on top of the model output, which is exactly what
// this file exercises at volume.
//
// Run: node fuzz-1000.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf-8');

function extract(startMarker, endMarker, prelude, exportNames) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error('Could not find markers: ' + startMarker + ' / ' + endMarker);
  const src = (prelude || '') + html.slice(start, end) + '\nmodule.exports = { ' + exportNames.join(', ') + ' };';
  const sandbox = { module: { exports: {} }, A: { watchlist: [] } };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'index.html(extracted:' + startMarker + ')' });
  return sandbox.module.exports;
}

const { editDistance, plateSimilarity, watchlistMatch } = extract(
  'function editDistance', 'function watchlistBadge',
  "function plateKey(v){return String(v||'').toUpperCase().replace(/[^A-Z0-9]/g,'')}\n",
  ['editDistance', 'plateSimilarity', 'watchlistMatch']
);
const watchlistSandboxA = { watchlist: [] };
// Re-extract with a live reference to a settable A.watchlist for the watchlist fuzz section.
const wlSrc = "function plateKey(v){return String(v||'').toUpperCase().replace(/[^A-Z0-9]/g,'')}\n" +
  html.slice(html.indexOf('function editDistance'), html.indexOf('function watchlistBadge')) +
  '\nmodule.exports = { watchlistMatch, setWatchlist: w => { A.watchlist = w; } };';
const wlSandbox = { module: { exports: {} }, A: { watchlist: [] } };
vm.createContext(wlSandbox);
vm.runInContext(wlSrc, wlSandbox, { filename: 'index.html(extracted:watchlist)' });
const { watchlistMatch: watchlistMatchLive, setWatchlist } = wlSandbox.module.exports;

const { faceDistance, matchKnownFace } = extract(
  'function faceDistance', 'function classifyPosture',
  '', ['faceDistance', 'matchKnownFace']
);

const classifyPostureStart = html.indexOf('function classifyPosture');
const classifyPostureEnd = html.indexOf('\n/* ----------', classifyPostureStart + 10);
if (classifyPostureStart < 0 || classifyPostureEnd < 0) throw new Error('Could not find classifyPosture markers');
const cpSandbox = { module: { exports: {} } };
vm.createContext(cpSandbox);
vm.runInContext(html.slice(classifyPostureStart, classifyPostureEnd) + '\nmodule.exports = { classifyPosture };', cpSandbox, { filename: 'index.html(extracted:classifyPosture)' });
const { classifyPosture } = cpSandbox.module.exports;

if (typeof editDistance !== 'function') throw new Error('editDistance did not extract');
if (typeof matchKnownFace !== 'function') throw new Error('matchKnownFace did not extract');
if (typeof classifyPosture !== 'function') throw new Error('classifyPosture did not extract');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}

// Seeded PRNG (mulberry32) so a failure is reproducible by re-running with the same seed.
const SEED = 424242;
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_ÀÉ日本语😀\t\n';
function randInt(min, max) { return Math.floor(rand() * (max - min + 1)) + min; }
function randString(maxLen) {
  let len = randInt(0, maxLen), s = '';
  for (let i = 0; i < len; i++) s += CHARS[randInt(0, CHARS.length - 1)];
  return s;
}
function randVector(dim) {
  let v = [];
  for (let i = 0; i < dim; i++) v.push((rand() - 0.5) * randInt(1, 200));
  return v;
}

console.log('Seed: ' + SEED + ' (re-run with this seed to reproduce any failure)\n');

// ============ 1000 randomized editDistance / plateSimilarity cases ============
for (let i = 0; i < 1000; i++) {
  let a = randString(15), b = randString(15);
  let d;
  try { d = editDistance(a, b); } catch (e) { check('editDistance#' + i + ' does not throw on random input', false, { a, b, error: e.message }); continue; }
  check('editDistance#' + i + ' is non-negative', d >= 0, { a, b, d });
  check('editDistance#' + i + ' is symmetric', d === editDistance(b, a), { a, b });
  check('editDistance#' + i + ' of a string with itself is 0', editDistance(a, a) === 0, { a });
  check('editDistance#' + i + ' never exceeds the longer string length', d <= Math.max(a.length, b.length), { a, b, d });

  let sim;
  try { sim = plateSimilarity(a, b); } catch (e) { check('plateSimilarity#' + i + ' does not throw', false, { a, b, error: e.message }); continue; }
  check('plateSimilarity#' + i + ' is within [0,1]', sim >= 0 && sim <= 1, { a, b, sim });
  check('plateSimilarity#' + i + ' of identical strings is 1', plateSimilarity(a, a) === 1, { a });
}

// ============ 1000 randomized watchlist fuzz cases ============
for (let i = 0; i < 1000; i++) {
  // Build a random watchlist of 1-8 entries with plausible plate-like keys.
  let plateChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  function randPlate(len) { let s = ''; for (let j = 0; j < len; j++) s += plateChars[randInt(0, plateChars.length - 1)]; return s; }
  let wlCount = randInt(1, 8);
  let wl = [];
  for (let j = 0; j < wlCount; j++) wl.push({ key: randPlate(randInt(3, 8)), label: 'car' + j });
  setWatchlist(wl);

  // Exact match invariant: querying with an entry's own key must always return that entry.
  let pick = wl[randInt(0, wl.length - 1)];
  let exactHit;
  try { exactHit = watchlistMatchLive(pick.key); } catch (e) { check('watchlistMatch#' + i + ' exact does not throw', false, { wl, key: pick.key, error: e.message }); continue; }
  check('watchlistMatch#' + i + ' exact match always finds its own entry', exactHit && exactHit.key === pick.key, { wl: wl.map(w => w.key), queried: pick.key, got: exactHit });
  check('watchlistMatch#' + i + ' exact match is never marked fuzzy', exactHit && exactHit.fuzzy !== true, exactHit);

  // Fully random garbage query must never throw, and if it returns a hit, the hit must
  // actually belong to the watchlist array (no fabricated entries).
  let garbage = randString(20);
  let garbageHit;
  try { garbageHit = watchlistMatchLive(garbage); } catch (e) { check('watchlistMatch#' + i + ' garbage does not throw', false, { garbage, error: e.message }); continue; }
  check('watchlistMatch#' + i + ' any hit on garbage input is a real watchlist entry', !garbageHit || wl.some(w => w.key === garbageHit.key), { garbage, garbageHit, wl: wl.map(w => w.key) });

  // Empty/whitespace-only query must never match anything (plateKey strips to '').
  let emptyHit;
  try { emptyHit = watchlistMatchLive('   '); } catch (e) { check('watchlistMatch#' + i + ' empty does not throw', false, { error: e.message }); continue; }
  check('watchlistMatch#' + i + ' whitespace-only query matches nothing', emptyHit === null, emptyHit);
}

// ============ 1000 randomized faceDistance / matchKnownFace cases ============
for (let i = 0; i < 1000; i++) {
  let dim = randInt(2, 128); // real face-api descriptors are 128-d; vary it to stress-test
  let a = randVector(dim), b = randVector(dim);
  let d;
  try { d = faceDistance(a, b); } catch (e) { check('faceDistance#' + i + ' does not throw', false, { dim, error: e.message }); continue; }
  check('faceDistance#' + i + ' is non-negative', d >= 0, { d });
  check('faceDistance#' + i + ' is symmetric', Math.abs(d - faceDistance(b, a)) < 1e-9, { d, rev: faceDistance(b, a) });
  check('faceDistance#' + i + ' of a vector with itself is 0', faceDistance(a, a) === 0, { });

  // Build a random known-faces roster (2-10 people), each with a well-separated descriptor,
  // and confirm the roster member closest to a query always wins - and that an identical
  // copy of one member's descriptor is recognized as exactly that member, never a neighbor.
  let rosterSize = randInt(2, 10);
  let roster = [];
  for (let j = 0; j < rosterSize; j++) roster.push({ name: 'person' + j, descriptor: randVector(dim).map(x => x + j * 1000) }); // force separation
  let target = roster[randInt(0, roster.length - 1)];
  let queryDescriptor = target.descriptor.slice(); // exact copy
  let match;
  try { match = matchKnownFace(queryDescriptor, roster); } catch (e) { check('matchKnownFace#' + i + ' does not throw', false, { error: e.message }); continue; }
  check('matchKnownFace#' + i + ' an exact descriptor copy matches its own owner, not a neighbor', match && match.name === target.name, { expected: target.name, got: match });
  check('matchKnownFace#' + i + ' an exact copy is reported confirmed', match && match.status === 'confirmed', match);

  // An empty roster must never match, never throw.
  let emptyRosterMatch;
  try { emptyRosterMatch = matchKnownFace(queryDescriptor, []); } catch (e) { check('matchKnownFace#' + i + ' empty roster does not throw', false, { error: e.message }); continue; }
  check('matchKnownFace#' + i + ' empty roster matches nobody', emptyRosterMatch === null, emptyRosterMatch);
}

// ============ 1000 randomized classifyPosture cases ============
const KEYPOINT_NAMES = ['nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear', 'left_shoulder', 'right_shoulder',
  'left_elbow', 'right_elbow', 'left_wrist', 'right_wrist', 'left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_ankle', 'right_ankle'];
function randKeypoints() {
  let n = randInt(0, 17);
  let names = KEYPOINT_NAMES.slice();
  let kp = [];
  for (let j = 0; j < n; j++) {
    let idx = randInt(0, names.length - 1);
    let name = names.splice(idx, 1)[0];
    kp.push({ name, x: (rand() - 0.5) * 2000, y: (rand() - 0.5) * 2000, score: rand() });
  }
  return kp;
}
for (let i = 0; i < 1000; i++) {
  let kp = randKeypoints();
  let result;
  try { result = classifyPosture(kp); } catch (e) { check('classifyPosture#' + i + ' does not throw on random keypoints', false, { kp, error: e.message }); continue; }
  check('classifyPosture#' + i + ' always returns a status string', typeof result.status === 'string', result);
  check('classifyPosture#' + i + ' status is one of the three valid values', ['unknown', 'upright', 'lying'].includes(result.status), result);
  check('classifyPosture#' + i + ' confidence is within [0,1]', result.confidence >= 0 && result.confidence <= 1, result);
}
// Malformed-input edge cases classifyPosture must survive without throwing.
for (const bad of [null, undefined, [], [{}], [{ name: 'nose' }], [{ name: 'nose', x: NaN, y: NaN, score: NaN }], 'not an array', 42, [{ name: null, x: 1, y: 1, score: 1 }]]) {
  let result;
  try { result = classifyPosture(bad); } catch (e) { check('classifyPosture handles malformed input ' + JSON.stringify(bad), false, { error: e.message }); continue; }
  check('classifyPosture handles malformed input ' + JSON.stringify(bad) + ' without throwing', typeof result === 'object' && result !== null, result);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed (out of ' + (pass + fail) + ' total checks across 4000+ randomized cases)');
process.exit(fail ? 1 : 0);
