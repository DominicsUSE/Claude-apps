// Regression test for the in-browser face-matching math in ../index.html (faceDistance,
// matchKnownFace) - extracted directly out of the shipped app, not a copy, so this always
// tests the actual code that ships. The face-api.js model itself (which turns a photo into
// a descriptor) can't be exercised here since it needs a browser + a CDN this sandbox's
// network policy blocks - this covers the matching logic that runs once a descriptor
// exists, using synthetic descriptor vectors instead of real model output.
// Run: node face-match.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf-8');
const start = html.indexOf('const FACE_ALIGN_TEMPLATE');
const end = html.indexOf('async function enrollFaceLocal');
if (start < 0 || end < 0) throw new Error('Could not find face-matching markers in index.html');
const src = html.slice(start, end) + '\nmodule.exports = { FACE_ALIGN_TEMPLATE, deriveFaceLandmarks5, estimateSimilarityTransform, faceDistance, matchKnownFace, cosineSimilarity, matchKnownFaceEdge, matchKnownFaceBest };';
const sandbox = { module: { exports: {} } };
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'index.html(extracted)' });
const { FACE_ALIGN_TEMPLATE, deriveFaceLandmarks5, estimateSimilarityTransform, faceDistance, matchKnownFace, cosineSimilarity, matchKnownFaceEdge, matchKnownFaceBest } = sandbox.module.exports;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

// A 128-d descriptor is overkill for math tests; short vectors exercise the same formula.
const alex = [0, 0, 0, 0];
const alexAgain = [0.05, -0.05, 0.02, 0.01]; // a second photo of the same person: close, not identical
const jordan = [3, 3, 3, 3]; // a clearly different person

check('faceDistance of identical vectors is 0', faceDistance(alex, alex) === 0);
check('faceDistance is symmetric', faceDistance(alex, jordan) === faceDistance(jordan, alex));
check('faceDistance of a near-duplicate is small', faceDistance(alex, alexAgain) < 0.1, faceDistance(alex, alexAgain));
check('faceDistance of a different person is large', faceDistance(alex, jordan) > 3, faceDistance(alex, jordan));

const knownFaces = [{ name: 'Alex', descriptor: alex }, { name: 'Jordan', descriptor: jordan }];

const m1 = matchKnownFace(alexAgain, knownFaces);
check('matches the near-duplicate to the right person', m1 && m1.name === 'Alex', JSON.stringify(m1));
check('a close match is reported confirmed (not just candidate)', m1 && m1.status === 'confirmed', JSON.stringify(m1));

const strangerDescriptor = [10, 10, 10, 10];
const m2 = matchKnownFace(strangerDescriptor, knownFaces);
check('an unenrolled face matches nobody', m2 === null, JSON.stringify(m2));

const m3 = matchKnownFace(alexAgain, []);
check('an empty known-faces list matches nobody', m3 === null, JSON.stringify(m3));

// Right at the edge of the default threshold (0.6): a distance just under it should match
// as a weaker "candidate" (not "confirmed", since that needs < threshold*.7 = 0.42);
// just over it should not match at all. This is the actual boundary behavior a real,
// slightly-worse-than-ideal photo would hit.
const borderlineClose = matchKnownFace([0.5, 0, 0, 0], [{ name: 'Alex', descriptor: alex }]);
check('a distance just under the threshold matches as a candidate', borderlineClose && borderlineClose.status === 'candidate', JSON.stringify(borderlineClose));
const borderlineFar = matchKnownFace([0.7, 0, 0, 0], [{ name: 'Alex', descriptor: alex }]);
check('a distance just over the threshold does not match', borderlineFar === null, JSON.stringify(borderlineFar));

// ---------- estimateSimilarityTransform / deriveFaceLandmarks5 (the EdgeFace alignment math) ----------

// Identity: src === dst should recover a=1,b=0,tx=0,ty=0 (no-op transform).
const tIdentity = estimateSimilarityTransform(FACE_ALIGN_TEMPLATE, FACE_ALIGN_TEMPLATE);
check('identity src/dst recovers a=1,b=0', tIdentity && Math.abs(tIdentity.a - 1) < 1e-9 && Math.abs(tIdentity.b) < 1e-9, JSON.stringify(tIdentity));
check('identity src/dst recovers tx=0,ty=0', tIdentity && Math.abs(tIdentity.tx) < 1e-9 && Math.abs(tIdentity.ty) < 1e-9, JSON.stringify(tIdentity));

// Pure translation: every dst point is src+[10,-5].
const srcT = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 8 }];
const dstT = srcT.map(p => ({ x: p.x + 10, y: p.y - 5 }));
const tTrans = estimateSimilarityTransform(srcT, dstT);
check('pure translation recovers a=1,b=0', tTrans && Math.abs(tTrans.a - 1) < 1e-9 && Math.abs(tTrans.b) < 1e-9, JSON.stringify(tTrans));
check('pure translation recovers tx/ty', tTrans && Math.abs(tTrans.tx - 10) < 1e-9 && Math.abs(tTrans.ty + 5) < 1e-9, JSON.stringify(tTrans));

// Pure uniform scale (2x) about the origin.
const srcS = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: -1 }];
const dstS = srcS.map(p => ({ x: p.x * 2, y: p.y * 2 }));
const tScale = estimateSimilarityTransform(srcS, dstS);
check('pure 2x scale recovers a=2,b=0', tScale && Math.abs(tScale.a - 2) < 1e-9 && Math.abs(tScale.b) < 1e-9, JSON.stringify(tScale));

// Pure 90-degree rotation (a=cos90=0, b=sin90=1 in this {a,b} parameterization: X=a*x-b*y, Y=b*x+a*y).
const srcR = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }];
const dstR = srcR.map(p => ({ x: -p.y, y: p.x })); // rotate +90 degrees
const tRot = estimateSimilarityTransform(srcR, dstR);
check('pure 90deg rotation recovers a~0,b~1', tRot && Math.abs(tRot.a) < 1e-9 && Math.abs(tRot.b - 1) < 1e-9, JSON.stringify(tRot));

// Malformed input never throws, returns null.
check('mismatched lengths returns null', estimateSimilarityTransform([{ x: 0, y: 0 }], [{ x: 0, y: 0 }, { x: 1, y: 1 }]) === null);
check('single point (underdetermined) returns null', estimateSimilarityTransform([{ x: 0, y: 0 }], [{ x: 0, y: 0 }]) === null);
check('non-array input returns null', estimateSimilarityTransform(null, FACE_ALIGN_TEMPLATE) === null);
check('NaN coordinates return null, not a NaN transform', estimateSimilarityTransform([{ x: NaN, y: 0 }, { x: 1, y: 1 }], [{ x: 0, y: 0 }, { x: 1, y: 1 }]) === null);

// deriveFaceLandmarks5: build a synthetic 68-point array where every point is predictable,
// so the eye-center averaging and fixed-index picks (nose=30, mouth=48/54) are checkable exactly.
function synthetic68() {
  let pts = [];
  for (let i = 0; i < 68; i++) pts.push({ x: i, y: i * 2 });
  return pts;
}
const pts68 = synthetic68();
const p5 = deriveFaceLandmarks5(pts68);
check('derives 5 points from 68', Array.isArray(p5) && p5.length === 5, JSON.stringify(p5));
check('left eye is mean of indices 36-41', p5 && p5[0].x === 38.5 && p5[0].y === 77, JSON.stringify(p5 && p5[0]));
check('right eye is mean of indices 42-47', p5 && p5[1].x === 44.5 && p5[1].y === 89, JSON.stringify(p5 && p5[1]));
check('nose is point 30', p5 && p5[2].x === 30 && p5[2].y === 60, JSON.stringify(p5 && p5[2]));
check('left mouth is point 48', p5 && p5[3].x === 48 && p5[3].y === 96, JSON.stringify(p5 && p5[3]));
check('right mouth is point 54', p5 && p5[4].x === 54 && p5[4].y === 108, JSON.stringify(p5 && p5[4]));

check('too-short landmark array returns null', deriveFaceLandmarks5([{ x: 0, y: 0 }]) === null);
check('non-array landmark input returns null', deriveFaceLandmarks5(null) === null);
check('a hole in the required indices returns null, not a crash', deriveFaceLandmarks5(synthetic68().map((p, i) => i === 40 ? null : p)) === null);

// ---------- cosineSimilarity / matchKnownFaceEdge / matchKnownFaceBest (the EdgeFace matcher) ----------

check('cosine similarity of identical normalized vectors is 1', Math.abs(cosineSimilarity([1, 0, 0], [1, 0, 0]) - 1) < 1e-9);
check('cosine similarity of orthogonal vectors is 0', Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);
check('cosine similarity of opposite vectors is -1', Math.abs(cosineSimilarity([1, 0], [-1, 0]) + 1) < 1e-9);
check('cosine similarity of mismatched lengths is -1 (never matches)', cosineSimilarity([1, 0], [1, 0, 0]) === -1);
check('cosine similarity of non-arrays is -1, not a throw', cosineSimilarity(null, [1]) === -1);

const edgeAlex = [1, 0, 0], edgeAlexAgain = [0.95, 0.312, 0], edgeJordan = [0, 1, 0];
const normalize = v => { let n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)); return v.map(x => x / n); };
const edgeKnown = [{ name: 'Alex', descriptor: [0, 0, 0, 0], edge: normalize(edgeAlex) }, { name: 'Jordan', descriptor: [3, 3, 3, 3], edge: normalize(edgeJordan) }];

const em1 = matchKnownFaceEdge(normalize(edgeAlexAgain), edgeKnown);
check('edge matcher matches the near-duplicate to the right person', em1 && em1.name === 'Alex', JSON.stringify(em1));
const em2 = matchKnownFaceEdge(normalize([0, 0, 1]), edgeKnown);
check('edge matcher: an orthogonal embedding matches nobody', em2 === null, JSON.stringify(em2));
check('edge matcher skips entries without .edge', matchKnownFaceEdge(normalize(edgeAlex), [{ name: 'NoEdge', descriptor: [0, 0, 0, 0] }]) === null);
check('edge matcher on empty list returns null', matchKnownFaceEdge(normalize(edgeAlex), []) === null);

const capturedWithEdge = { descriptor: [0, 0, 0, 0], edge: normalize(edgeAlexAgain) };
const mb1 = matchKnownFaceBest(capturedWithEdge, edgeKnown);
check('matchKnownFaceBest prefers the edge match when available', mb1 && mb1.name === 'Alex' && mb1.distance < 1, JSON.stringify(mb1));

// A person enrolled before EdgeFace existed: only has a legacy descriptor, no .edge. The
// captured face has an edge embedding, but since nobody in knownFaces matches on edge,
// matchKnownFaceBest must fall back to the legacy descriptor match rather than returning null.
const legacyOnlyKnown = [{ name: 'OldAlex', descriptor: [0, 0, 0, 0] }];
const mb2 = matchKnownFaceBest({ descriptor: [0.05, -0.05, 0.02, 0.01], edge: normalize(edgeAlex) }, legacyOnlyKnown);
check('matchKnownFaceBest falls back to legacy descriptor for pre-EdgeFace enrollments', mb2 && mb2.name === 'OldAlex', JSON.stringify(mb2));

// The capture itself has no edge embedding (model not loaded yet) - must still match via legacy.
const mb3 = matchKnownFaceBest({ descriptor: [0.05, -0.05, 0.02, 0.01] }, [{ name: 'Alex', descriptor: [0, 0, 0, 0], edge: normalize(edgeAlex) }]);
check('matchKnownFaceBest works when the capture has no edge embedding at all', mb3 && mb3.name === 'Alex', JSON.stringify(mb3));

check('matchKnownFaceBest returns null for null input', matchKnownFaceBest(null, edgeKnown) === null);
check('matchKnownFaceBest returns null when neither edge nor descriptor present', matchKnownFaceBest({}, edgeKnown) === null);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
