// 1,000,000-iteration randomized (property-based) stress test - per request. Extends the
// three earlier fuzzing rounds (fuzz-1000, fuzz-560-plate-pipeline, fuzz-10000; ~34,000
// checks total, 3 real bugs found and fixed) with a fresh seed at 100x the volume, across
// the same six pure functions extracted directly out of ../index.html.
//
// Honest framing, worth stating once rather than burying: these are low-dimensional input
// spaces (short strings, small numeric vectors, RGB triples, keypoint sets). The three
// earlier rounds already found and fixed every bug random sampling could reach in them -
// going from ~34,000 checks to 1,000,000+ on the SAME invariants has rapidly diminishing
// odds of finding something new, not because the run isn't real, but because the space is
// small enough that ~15-20k well-distributed samples already covers it thoroughly. This is
// run for real anyway (not faked), because "did anything change at 100x" is itself a
// legitimate thing to check, and the number was asked for specifically.
//
// Split (sums to 1,000,000): editDistance/plateSimilarity 300,000, watchlistMatch 200,000,
// faceDistance/matchKnownFace 200,000, classifyPosture 150,000, classifyColor 100,000,
// findPlateBand 50,000 (weighted down - by far the most expensive per-call of the six, due
// to its W*H array passes).
// Run: node fuzz-1000000.test.js (takes roughly 1-3 minutes)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf-8');

function extractRange(startMarker, endMarker, prelude, exportNames, sandboxExtra) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error('Could not find markers: ' + startMarker + ' / ' + endMarker);
  const src = (prelude || '') + html.slice(start, end) + '\nmodule.exports = { ' + exportNames.join(', ') + ' };';
  const sandbox = Object.assign({ module: { exports: {} } }, sandboxExtra || {});
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'index.html(extracted:' + startMarker + ')' });
  return sandbox.module.exports;
}

const { editDistance, plateSimilarity } = extractRange(
  'function editDistance', 'function watchlistBadge', '', ['editDistance', 'plateSimilarity']
);
const wlSrc = "function plateKey(v){return String(v||'').toUpperCase().replace(/[^A-Z0-9]/g,'')}\n" +
  html.slice(html.indexOf('function editDistance'), html.indexOf('function watchlistBadge')) +
  '\nmodule.exports = { watchlistMatch, setWatchlist: w => { A.watchlist = w; } };';
const wlSandbox = { module: { exports: {} }, A: { watchlist: [] } };
vm.createContext(wlSandbox);
vm.runInContext(wlSrc, wlSandbox, { filename: 'index.html(extracted:watchlist)' });
const { watchlistMatch, setWatchlist } = wlSandbox.module.exports;

const { faceDistance, matchKnownFace } = extractRange(
  'function faceDistance', 'function classifyPosture', '', ['faceDistance', 'matchKnownFace']
);

const cpStart = html.indexOf('function classifyPosture');
const cpEnd = html.indexOf('\n/* ----------', cpStart + 10);
if (cpStart < 0 || cpEnd < 0) throw new Error('Could not find classifyPosture markers');
const cpSandbox = { module: { exports: {} } };
vm.createContext(cpSandbox);
vm.runInContext(html.slice(cpStart, cpEnd) + '\nmodule.exports = { classifyPosture };', cpSandbox, { filename: 'index.html(extracted:classifyPosture)' });
const { classifyPosture } = cpSandbox.module.exports;

const { classifyColor } = extractRange(
  'function classifyColor', 'function sampleVehicleColor', '', ['classifyColor']
);

const { findPlateBand } = extractRange(
  'function findPlateBand', 'function locatePlateRect', '', ['findPlateBand'],
  { Float32Array, Uint8Array }
);

for (const [name, fn] of Object.entries({ editDistance, plateSimilarity, watchlistMatch, faceDistance, matchKnownFace, classifyPosture, classifyColor, findPlateBand }))
  if (typeof fn !== 'function') throw new Error(name + ' did not extract as a function');

let pass = 0, fail = 0;
const failuresByCategory = {};
function check(category, name, cond, detail) {
  if (cond) { pass++; }
  else {
    fail++;
    failuresByCategory[category] = (failuresByCategory[category] || 0) + 1;
    if (failuresByCategory[category] <= 5) console.log('FAIL  [' + category + '] ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''));
    else if (failuresByCategory[category] === 6) console.log('  ... further [' + category + '] failures suppressed after 5 shown');
  }
}

const SEED = 1000000123;
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
const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_ÀÉ日本语😀\t\n';
function randString(maxLen) { let len = randInt(0, maxLen), s = ''; for (let i = 0; i < len; i++) s += CHARS[randInt(0, CHARS.length - 1)]; return s; }
function randVector(dim) { let v = []; for (let i = 0; i < dim; i++) v.push((rand() - 0.5) * randInt(1, 200)); return v; }

console.log('Seed: ' + SEED + ' (re-run with this seed to reproduce any failure)');
const t0 = Date.now();

// ============ 300,000: editDistance / plateSimilarity ============
for (let i = 0; i < 300000; i++) {
  let a = randString(15), b = randString(15), d;
  try { d = editDistance(a, b); } catch (e) { check('editDistance', '#' + i, false, { a, b, error: e.message }); continue; }
  check('editDistance', '#' + i, d >= 0 && d === editDistance(b, a) && editDistance(a, a) === 0, { a, b, d });
  let sim;
  try { sim = plateSimilarity(a, b); } catch (e) { check('plateSimilarity', '#' + i, false, { a, b, error: e.message }); continue; }
  check('plateSimilarity', '#' + i, sim >= 0 && sim <= 1 && plateSimilarity(a, a) === 1, { a, b, sim });
}
console.log('  editDistance/plateSimilarity (300,000) done at ' + (Date.now() - t0) + 'ms, running total: ' + pass + ' pass / ' + fail + ' fail');

// ============ 200,000: watchlistMatch ============
const PLATE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function randPlate(len) { let s = ''; for (let j = 0; j < len; j++) s += PLATE_CHARS[randInt(0, PLATE_CHARS.length - 1)]; return s; }
for (let i = 0; i < 200000; i++) {
  let wlCount = randInt(1, 8), wl = [];
  for (let j = 0; j < wlCount; j++) wl.push({ key: randPlate(randInt(3, 8)), label: 'v' + j });
  setWatchlist(wl);
  let pick = wl[randInt(0, wl.length - 1)], hit;
  try { hit = watchlistMatch(pick.key); } catch (e) { check('watchlistMatch', '#' + i, false, { error: e.message }); continue; }
  check('watchlistMatch', '#' + i, hit && hit.key === pick.key && hit.fuzzy !== true, { wl: wl.map(w => w.key), queried: pick.key, hit });
  let garbageHit;
  try { garbageHit = watchlistMatch(randString(20)); } catch (e) { check('watchlistMatch-garbage', '#' + i, false, { error: e.message }); continue; }
  check('watchlistMatch-garbage', '#' + i, !garbageHit || wl.some(w => w.key === garbageHit.key), { garbageHit });
}
console.log('  watchlistMatch (200,000) done at ' + (Date.now() - t0) + 'ms, running total: ' + pass + ' pass / ' + fail + ' fail');

// ============ 200,000: faceDistance / matchKnownFace ============
for (let i = 0; i < 200000; i++) {
  let dim = randInt(2, 128), a = randVector(dim), b = randVector(dim), d;
  try { d = faceDistance(a, b); } catch (e) { check('faceDistance', '#' + i, false, { error: e.message }); continue; }
  check('faceDistance', '#' + i, d >= 0 && Math.abs(d - faceDistance(b, a)) < 1e-9 && faceDistance(a, a) === 0, { d });
  let rosterSize = randInt(2, 10), roster = [];
  for (let j = 0; j < rosterSize; j++) roster.push({ name: 'p' + j, descriptor: randVector(dim).map(x => x + j * 1000) });
  let target = roster[randInt(0, roster.length - 1)], match;
  try { match = matchKnownFace(target.descriptor.slice(), roster); } catch (e) { check('matchKnownFace', '#' + i, false, { error: e.message }); continue; }
  check('matchKnownFace', '#' + i, match && match.name === target.name && match.status === 'confirmed', { expected: target.name, got: match });
}
console.log('  faceDistance/matchKnownFace (200,000) done at ' + (Date.now() - t0) + 'ms, running total: ' + pass + ' pass / ' + fail + ' fail');

// ============ 150,000: classifyPosture ============
const KEYPOINT_NAMES = ['nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear', 'left_shoulder', 'right_shoulder',
  'left_elbow', 'right_elbow', 'left_wrist', 'right_wrist', 'left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_ankle', 'right_ankle'];
function randKeypoints() {
  let n = randInt(0, 17), names = KEYPOINT_NAMES.slice(), kp = [];
  for (let j = 0; j < n; j++) { let idx = randInt(0, names.length - 1), name = names.splice(idx, 1)[0]; kp.push({ name, x: (rand() - 0.5) * 2000, y: (rand() - 0.5) * 2000, score: rand() }); }
  return kp;
}
for (let i = 0; i < 150000; i++) {
  let result;
  try { result = classifyPosture(randKeypoints()); } catch (e) { check('classifyPosture', '#' + i, false, { error: e.message }); continue; }
  check('classifyPosture', '#' + i, typeof result.status === 'string' && ['unknown', 'upright', 'lying'].includes(result.status) && result.confidence >= 0 && result.confidence <= 1, result);
}
console.log('  classifyPosture (150,000) done at ' + (Date.now() - t0) + 'ms, running total: ' + pass + ' pass / ' + fail + ' fail');

// ============ 100,000: classifyColor ============
function randColorComponent() {
  const r = rand();
  if (r < 0.7) return randInt(0, 255);
  if (r < 0.85) return randInt(-1000, 1000);
  if (r < 0.92) return [NaN, Infinity, -Infinity][randInt(0, 2)];
  if (r < 0.97) return rand() * 255;
  return [null, undefined, 'x', {}, []][randInt(0, 4)];
}
const VALID_COLORS = ['black', 'white', 'silver', 'gray', 'maroon', 'red', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple'];
for (let i = 0; i < 100000; i++) {
  let r = randColorComponent(), g = randColorComponent(), b = randColorComponent(), result;
  try { result = classifyColor(r, g, b); } catch (e) { check('classifyColor', '#' + i, false, { r, g, b, error: e.message }); continue; }
  check('classifyColor', '#' + i, typeof result === 'string' && VALID_COLORS.includes(result), { r, g, b, result });
}
console.log('  classifyColor (100,000) done at ' + (Date.now() - t0) + 'ms, running total: ' + pass + ' pass / ' + fail + ' fail');

// ============ 50,000: findPlateBand ============
function randGrayArray(W, H, kind) {
  const n = W * H;
  if (kind === 'short') return new Float32Array(Math.max(0, n - randInt(1, Math.max(1, n))));
  if (kind === 'empty') return new Float32Array(0);
  const arr = new Float32Array(n);
  if (kind === 'noise') { for (let i = 0; i < n; i++) arr[i] = rand() * 255; }
  else if (kind === 'flat') { const v = rand() * 255; arr.fill(v); }
  else {
    let bandY0 = randInt(0, Math.max(0, H - 3)), bandH = randInt(2, Math.max(2, H - bandY0));
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let inBand = y >= bandY0 && y < bandY0 + bandH;
      arr[y * W + x] = inBand ? (x % 4 < 2 ? 20 : 220) : 128;
    }
  }
  return arr;
}
const GRAY_KINDS = ['noise', 'flat', 'platelike', 'short', 'empty'];
for (let i = 0; i < 50000; i++) {
  let W = randInt(0, 100), H = randInt(0, 70);
  let kind = GRAY_KINDS[randInt(0, GRAY_KINDS.length - 1)];
  let gray = randGrayArray(W, H, kind);
  let result;
  try { result = findPlateBand(gray, W, H); } catch (e) { check('findPlateBand', '#' + i, false, { W, H, kind, error: e.message }); continue; }
  if (result === null) { pass++; continue; }
  check('findPlateBand', '#' + i, [result.x, result.y, result.w, result.h, result.score].every(v => typeof v === 'number' && isFinite(v)) && result.w > 0 && result.h > 0 && result.x >= 0 && result.y >= 0, { W, H, kind, result });
}
console.log('  findPlateBand (50,000) done at ' + (Date.now() - t0) + 'ms, running total: ' + pass + ' pass / ' + fail + ' fail');

console.log('\n' + pass + ' passed, ' + fail + ' failed (out of ' + (pass + fail) + ' total checks across 1,000,000 randomized cases, ' + (Date.now() - t0) + 'ms total)');
process.exit(fail ? 1 : 0);
