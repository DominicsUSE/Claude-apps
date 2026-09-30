// Regression test for the in-browser fall/posture heuristic in ../index.html
// (classifyPosture) - extracted directly out of the shipped app, not a copy, so this always
// tests the actual code that ships. The pose-estimation model itself (which turns a video
// frame into keypoints) can't be exercised here since it needs a browser + a CDN this
// sandbox's network policy blocks - this covers the pure geometry that runs once keypoints
// exist, using synthetic keypoint sets shaped like real MoveNet output instead.
// Run: node posture-classify.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf-8');
const start = html.indexOf('function classifyPosture');
if (start < 0) throw new Error('Could not find classifyPosture marker in index.html');
// classifyPosture is a single self-contained function - grab up to its closing brace by
// finding the next top-level function/comment boundary after it.
const nextMarker = html.indexOf('\n/* ----------', start + 10);
if (nextMarker < 0) throw new Error('Could not find the end-of-function marker after classifyPosture in index.html');
const src = html.slice(start, nextMarker) + '\nmodule.exports = { classifyPosture };';
const sandbox = { module: { exports: {} } };
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'index.html(extracted)' });
const { classifyPosture } = sandbox.module.exports;
if (typeof classifyPosture !== 'function') throw new Error('classifyPosture did not extract as a function');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

function kp(name, x, y, score) { return { name, x, y, score: score == null ? 0.9 : score }; }

// A person standing: shoulders well above hips, narrow horizontally, tall vertically.
const standing = [
  kp('left_shoulder', 95, 100), kp('right_shoulder', 125, 100),
  kp('left_hip', 97, 220), kp('right_hip', 123, 220),
  kp('left_knee', 98, 320), kp('right_knee', 122, 320),
];
const r1 = classifyPosture(standing);
check('a person standing upright is classified upright', r1.status === 'upright', JSON.stringify(r1));
check('upright classification is reasonably confident', r1.confidence >= 0.7, JSON.stringify(r1));

// A person lying flat on the ground: shoulders and hips at nearly the same height, spread
// out horizontally - both the torso-angle signal and the aspect-ratio signal agree.
const lying = [
  kp('left_shoulder', 50, 200), kp('right_shoulder', 90, 205),
  kp('left_hip', 160, 210), kp('right_hip', 200, 208),
  kp('left_knee', 260, 212), kp('right_knee', 300, 214),
];
const r2 = classifyPosture(lying);
check('a person lying flat is classified lying', r2.status === 'lying', JSON.stringify(r2));
check('lying classification (both signals agree) is highly confident', r2.confidence >= 0.85, JSON.stringify(r2));

// Too few confidently-detected keypoints to say anything.
const sparse = [kp('nose', 100, 100), kp('left_eye', 95, 95)];
const r3 = classifyPosture(sparse);
check('too few keypoints yields unknown, not a guess', r3.status === 'unknown' && r3.confidence === 0, JSON.stringify(r3));

// Low-confidence keypoints (below minScore) are filtered out, same as too few keypoints.
const lowConfidence = [
  kp('left_shoulder', 95, 100, 0.1), kp('right_shoulder', 125, 100, 0.1),
  kp('left_hip', 97, 220, 0.1), kp('right_hip', 123, 220, 0.1),
];
const r4 = classifyPosture(lowConfidence);
check('keypoints below minScore are ignored', r4.status === 'unknown', JSON.stringify(r4));

// A person crouching/reaching sideways: wide-ish bounding box but the torso itself is
// still fairly vertical - only one of the two signals fires, so this should not be
// confidently reported as "lying" the same way an unambiguous fall is.
const crouching = [
  kp('left_shoulder', 150, 100), kp('right_shoulder', 180, 100),
  kp('left_hip', 152, 180), kp('right_hip', 178, 180),
  kp('left_wrist', 40, 190), kp('right_wrist', 300, 190),
];
const r5 = classifyPosture(crouching);
check('a crouch/reach with only the aspect signal firing is less confident than a clean fall', r5.confidence < r2.confidence, JSON.stringify([r5, r2]));

// No face/body detected at all in this frame.
const r6 = classifyPosture([]);
check('no keypoints at all yields unknown', r6.status === 'unknown', JSON.stringify(r6));
const r7 = classifyPosture(null);
check('null keypoints does not throw and yields unknown', r7.status === 'unknown', JSON.stringify(r7));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
