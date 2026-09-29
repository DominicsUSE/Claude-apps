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
const start = html.indexOf('function faceDistance');
const end = html.indexOf('async function enrollFaceLocal');
if (start < 0 || end < 0) throw new Error('Could not find faceDistance/matchKnownFace markers in index.html');
const src = html.slice(start, end) + '\nmodule.exports = { faceDistance, matchKnownFace };';
const sandbox = { module: { exports: {} } };
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'index.html(extracted)' });
const { faceDistance, matchKnownFace } = sandbox.module.exports;

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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
