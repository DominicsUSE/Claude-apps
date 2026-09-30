// 10,000-iteration randomized (property-based) stress test spanning every pure, DOM-free
// recognition/matching function in ../index.html - extracted directly out of the shipped
// app, not reimplemented. Extends fuzz-1000.test.js/fuzz-560-plate-pipeline.test.js with a
// fresh seed (genuinely new random coverage, not a repeat) plus two functions never fuzzed
// before: classifyColor (vehicle color classifier) and findPlateBand (the edge-density
// plate-region locator). Run: node fuzz-10000.test.js
//
// Split: editDistance/plateSimilarity 1500, watchlistMatch 1500, faceDistance/matchKnownFace
// 1500, classifyPosture 1500, classifyColor 2000, findPlateBand 2000 = 10,000 total.
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
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}

const SEED = 10000777;
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

console.log('Seed: ' + SEED + ' (re-run with this seed to reproduce any failure)\n');

// ============ 1500: editDistance / plateSimilarity ============
for (let i = 0; i < 1500; i++) {
  let a = randString(15), b = randString(15), d;
  try { d = editDistance(a, b); } catch (e) { check('editDistance#' + i, false, { a, b, error: e.message }); continue; }
  check('editDistance#' + i + ' non-negative & symmetric & self=0', d >= 0 && d === editDistance(b, a) && editDistance(a, a) === 0, { a, b, d });
  let sim;
  try { sim = plateSimilarity(a, b); } catch (e) { check('plateSimilarity#' + i, false, { a, b, error: e.message }); continue; }
  check('plateSimilarity#' + i + ' in [0,1] & self=1', sim >= 0 && sim <= 1 && plateSimilarity(a, a) === 1, { a, b, sim });
}

// ============ 1500: watchlistMatch ============
const PLATE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function randPlate(len) { let s = ''; for (let j = 0; j < len; j++) s += PLATE_CHARS[randInt(0, PLATE_CHARS.length - 1)]; return s; }
for (let i = 0; i < 1500; i++) {
  let wlCount = randInt(1, 8), wl = [];
  for (let j = 0; j < wlCount; j++) wl.push({ key: randPlate(randInt(3, 8)), label: 'v' + j });
  setWatchlist(wl);
  let pick = wl[randInt(0, wl.length - 1)], hit;
  try { hit = watchlistMatch(pick.key); } catch (e) { check('watchlistMatch#' + i, false, { error: e.message }); continue; }
  check('watchlistMatch#' + i + ' exact match finds its own entry, not fuzzy', hit && hit.key === pick.key && hit.fuzzy !== true, { wl: wl.map(w => w.key), queried: pick.key, hit });
  let garbage = randString(20), garbageHit;
  try { garbageHit = watchlistMatch(garbage); } catch (e) { check('watchlistMatch#' + i + ' garbage', false, { error: e.message }); continue; }
  check('watchlistMatch#' + i + ' garbage hit (if any) is a real entry', !garbageHit || wl.some(w => w.key === garbageHit.key), { garbage, garbageHit });
}

// ============ 1500: faceDistance / matchKnownFace ============
for (let i = 0; i < 1500; i++) {
  let dim = randInt(2, 128), a = randVector(dim), b = randVector(dim), d;
  try { d = faceDistance(a, b); } catch (e) { check('faceDistance#' + i, false, { error: e.message }); continue; }
  check('faceDistance#' + i + ' non-negative, symmetric, self=0', d >= 0 && Math.abs(d - faceDistance(b, a)) < 1e-9 && faceDistance(a, a) === 0, { d });
  let rosterSize = randInt(2, 10), roster = [];
  for (let j = 0; j < rosterSize; j++) roster.push({ name: 'p' + j, descriptor: randVector(dim).map(x => x + j * 1000) });
  let target = roster[randInt(0, roster.length - 1)], match;
  try { match = matchKnownFace(target.descriptor.slice(), roster); } catch (e) { check('matchKnownFace#' + i, false, { error: e.message }); continue; }
  check('matchKnownFace#' + i + ' exact copy matches its own owner', match && match.name === target.name && match.status === 'confirmed', { expected: target.name, got: match });
}

// ============ 1500: classifyPosture ============
const KEYPOINT_NAMES = ['nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear', 'left_shoulder', 'right_shoulder',
  'left_elbow', 'right_elbow', 'left_wrist', 'right_wrist', 'left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_ankle', 'right_ankle'];
function randKeypoints() {
  let n = randInt(0, 17), names = KEYPOINT_NAMES.slice(), kp = [];
  for (let j = 0; j < n; j++) { let idx = randInt(0, names.length - 1), name = names.splice(idx, 1)[0]; kp.push({ name, x: (rand() - 0.5) * 2000, y: (rand() - 0.5) * 2000, score: rand() }); }
  return kp;
}
for (let i = 0; i < 1500; i++) {
  let result;
  try { result = classifyPosture(randKeypoints()); } catch (e) { check('classifyPosture#' + i, false, { error: e.message }); continue; }
  check('classifyPosture#' + i + ' valid shape', typeof result.status === 'string' && ['unknown', 'upright', 'lying'].includes(result.status) && result.confidence >= 0 && result.confidence <= 1, result);
}
for (const bad of [null, undefined, [], [{}], 'not array', 42, {}]) {
  let result;
  try { result = classifyPosture(bad); } catch (e) { check('classifyPosture malformed ' + JSON.stringify(bad), false, { error: e.message }); continue; }
  check('classifyPosture malformed ' + JSON.stringify(bad) + ' does not throw', result && typeof result === 'object', result);
}

// ============ 2000: classifyColor ============
function randColorComponent() {
  const r = rand();
  if (r < 0.7) return randInt(0, 255); // normal range, most cases
  if (r < 0.85) return randInt(-1000, 1000); // out of range
  if (r < 0.92) return [NaN, Infinity, -Infinity][randInt(0, 2)];
  if (r < 0.97) return rand() * 255; // float, not int
  return [null, undefined, 'x', {}, []][randInt(0, 4)]; // wrong type entirely
}
const VALID_COLORS = ['black', 'white', 'silver', 'gray', 'maroon', 'red', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple'];
for (let i = 0; i < 2000; i++) {
  let r = randColorComponent(), g = randColorComponent(), b = randColorComponent(), result;
  try { result = classifyColor(r, g, b); } catch (e) { check('classifyColor#' + i + ' does not throw', false, { r, g, b, error: e.message }); continue; }
  check('classifyColor#' + i + ' always returns a valid color name', typeof result === 'string' && VALID_COLORS.includes(result), { r, g, b, result });
}
// Pure in-range sanity: grayscale (r=g=b) must never be classified as a chromatic color.
for (let i = 0; i < 200; i++) {
  let v = randInt(0, 255), result;
  try { result = classifyColor(v, v, v); } catch (e) { check('classifyColor grayscale#' + i, false, { v, error: e.message }); continue; }
  check('classifyColor grayscale#' + i + ' (' + v + ',' + v + ',' + v + ') is black/white/silver/gray, never a hue', ['black', 'white', 'silver', 'gray'].includes(result), { v, result });
}

// ============ 2000: findPlateBand ============
function randGrayArray(W, H, kind) {
  const n = W * H;
  if (kind === 'short') return new Float32Array(Math.max(0, n - randInt(1, Math.max(1, n)))); // deliberately too-short buffer
  if (kind === 'empty') return new Float32Array(0);
  const arr = new Float32Array(n);
  if (kind === 'noise') { for (let i = 0; i < n; i++) arr[i] = rand() * 255; }
  else if (kind === 'flat') { const v = rand() * 255; arr.fill(v); }
  else { // synthetic plate-like: a band of alternating high-contrast columns
    let bandY0 = randInt(0, Math.max(0, H - 3)), bandH = randInt(2, Math.max(2, H - bandY0));
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let inBand = y >= bandY0 && y < bandY0 + bandH;
      arr[y * W + x] = inBand ? (x % 4 < 2 ? 20 : 220) : 128;
    }
  }
  return arr;
}
const GRAY_KINDS = ['noise', 'flat', 'platelike', 'short', 'empty'];
for (let i = 0; i < 2000; i++) {
  let W = randInt(0, 120), H = randInt(0, 80);
  let kind = GRAY_KINDS[randInt(0, GRAY_KINDS.length - 1)];
  let gray = randGrayArray(W, H, kind);
  let result;
  try { result = findPlateBand(gray, W, H); } catch (e) { check('findPlateBand#' + i + ' does not throw', false, { W, H, kind, error: e.message }); continue; }
  if (result === null) { check('findPlateBand#' + i + ' null is a valid "nothing found" result', true); continue; }
  check('findPlateBand#' + i + ' returns finite, sane box fields', [result.x, result.y, result.w, result.h, result.score].every(v => typeof v === 'number' && isFinite(v)), { W, H, kind, result });
  check('findPlateBand#' + i + ' box has positive width and height', result.w > 0 && result.h > 0, { W, H, kind, result });
  check('findPlateBand#' + i + ' box origin is non-negative', result.x >= 0 && result.y >= 0, { W, H, kind, result });
}
// Degenerate dimensions must never throw.
for (const [W, H] of [[0, 0], [-5, 10], [10, -5], [1, 1], [NaN, 50], [50, NaN]]) {
  let result;
  try { result = findPlateBand(new Float32Array(Math.max(0, (W || 0) * (H || 0))), W, H); }
  catch (e) { check('findPlateBand degenerate W=' + W + ' H=' + H, false, { error: e.message }); continue; }
  check('findPlateBand degenerate W=' + W + ' H=' + H + ' does not throw', true);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed (out of ' + (pass + fail) + ' total checks across 10,000+ randomized cases)');
process.exit(fail ? 1 : 0);
