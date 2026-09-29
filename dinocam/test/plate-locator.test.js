// Regression test for the plate-region localizer in ../index.html (findPlateBand).
// Extracts the pure, DOM-free core directly out of the shipped app and drives it with
// synthetic grayscale buffers simulating a plate's dense vertical-edge signature against
// a smooth background, so this always tests the actual code that ships. Run: node plate-locator.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf-8');
const start = html.indexOf('function findPlateBand');
const end = html.indexOf('function locatePlateRect');
if (start < 0 || end < 0) throw new Error('Could not find findPlateBand markers in index.html — did it get renamed?');
const src = html.slice(start, end) + '\nmodule.exports = { findPlateBand };';
const sandbox = { module: { exports: {} }, Float32Array, Uint8Array };
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'index.html(extracted)' });
const { findPlateBand } = sandbox.module.exports;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}
function overlap(a0, a1, b0, b1) { return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)); }

// ---- Scenario 1: a clean plate-like band of alternating stripes on a smooth background ----
{
  const W = 240, H = 150;
  const bandY0 = 90, bandY1 = 110, stripeX0 = 60, stripeX1 = 180;
  const gray = new Float32Array(W * H).fill(120); // smooth background everywhere
  for (let y = bandY0; y < bandY1; y++) {
    for (let x = stripeX0; x < stripeX1; x++) {
      gray[y * W + x] = (Math.floor(x / 4) % 2 === 0) ? 30 : 220; // alternating dark/light strokes
    }
  }
  const band = findPlateBand(gray, W, H);
  check('clean plate band: found something', !!band, JSON.stringify(band));
  if (band) {
    const yOverlap = overlap(band.y, band.y + band.h, bandY0, bandY1) / (bandY1 - bandY0);
    const xOverlap = overlap(band.x, band.x + band.w, stripeX0, stripeX1) / (stripeX1 - stripeX0);
    check('clean plate band: y-range substantially overlaps the real band', yOverlap > 0.6, 'yOverlap=' + yOverlap.toFixed(2) + ' band=' + JSON.stringify(band));
    check('clean plate band: x-range substantially overlaps the real stripes', xOverlap > 0.6, 'xOverlap=' + xOverlap.toFixed(2));
    const aspect = band.w / band.h;
    check('clean plate band: plate-like aspect ratio', aspect >= 1.3 && aspect <= 9, 'aspect=' + aspect.toFixed(2));
  }
}

// ---- Scenario 2: perfectly uniform image (no edges anywhere) must NOT produce a false band ----
{
  const W = 240, H = 150;
  const gray = new Float32Array(W * H).fill(150);
  const band = findPlateBand(gray, W, H);
  check('uniform image: no false-positive band', band === null, JSON.stringify(band));
}

// ---- Scenario 3: uniform low-level sensor noise (no structured edges) must NOT produce a false band ----
{
  const W = 240, H = 150;
  const gray = new Float32Array(W * H);
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < gray.length; i++) gray[i] = 120 + (rand() - 0.5) * 6; // +/-3 gray levels of noise
  const band = findPlateBand(gray, W, H);
  check('sensor noise: no false-positive band', band === null, JSON.stringify(band));
}

// ---- Scenario 4: a wrong-aspect-ratio dense-edge blob (e.g. a grille, roughly square) is rejected ----
{
  const W = 240, H = 150;
  const gray = new Float32Array(W * H).fill(120);
  for (let y = 60; y < 110; y++) for (let x = 100; x < 150; x++) gray[y * W + x] = (Math.floor(x / 3) % 2 === 0) ? 30 : 220;
  const band = findPlateBand(gray, W, H);
  // A ~50x50 square blob is aspect ~1:1, outside the accepted 1.3-9 plate range, OR if the
  // band-search crops it into a plate-like slice that's fine too — either way it must not
  // report the whole square as-is with aspect < 1.3.
  if (band) {
    const aspect = band.w / band.h;
    check('square grille blob: not reported as a ~1:1 block', aspect >= 1.3, 'aspect=' + aspect.toFixed(2));
  } else {
    check('square grille blob: rejecting entirely is also acceptable', true);
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
