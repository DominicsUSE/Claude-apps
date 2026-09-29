// Regression test for classifyColor in ../index.html. Run: node vehicle-attributes.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf-8');
const start = html.indexOf('function classifyColor');
const end = html.indexOf('function sampleVehicleColor');
if (start < 0 || end < 0) throw new Error('Could not find classifyColor markers in index.html');
const src = html.slice(start, end) + '\nmodule.exports = { classifyColor };';
const sandbox = { module: { exports: {} } };
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'index.html(extracted)' });
const { classifyColor } = sandbox.module.exports;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

const cases = [
  [[0, 0, 0], 'black'],
  [[255, 255, 255], 'white'],
  [[192, 192, 192], 'silver'],
  [[90, 90, 90], 'gray'],
  [[220, 20, 20], 'red'],
  [[120, 10, 10], 'maroon'],
  [[20, 30, 220], 'blue'],
  [[20, 160, 40], 'green'],
  [[235, 220, 20], 'yellow'],
  [[230, 140, 15], 'orange'],
  [[110, 60, 20], 'brown'],
  [[150, 30, 200], 'purple'],
];
for (const [[r, g, b], expected] of cases) {
  check(`rgb(${r},${g},${b}) -> ${expected}`, classifyColor(r, g, b) === expected, 'got ' + classifyColor(r, g, b));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
