// Regression test for the watchlist fuzzy-matching math in ../index.html (editDistance,
// plateSimilarity, watchlistMatch) - extracted directly out of the shipped app, not a
// copy, so this always tests the actual code that ships.
// Run: node watchlist-match.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf-8');
const start = html.indexOf('function editDistance');
const end = html.indexOf('function watchlistBadge');
if (start < 0 || end < 0) throw new Error('Could not find editDistance/plateSimilarity/watchlistMatch markers in index.html');
// watchlistMatch reads global A.watchlist and calls plateKey() (defined earlier in the
// real file) - stub both minimally rather than dragging in the whole app.
const src =
  "function plateKey(v){return String(v||'').toUpperCase().replace(/[^A-Z0-9]/g,'')}\n" +
  html.slice(start, end) +
  '\nmodule.exports = { editDistance, plateSimilarity, watchlistMatch, setWatchlist: w => { A.watchlist = w; } };';
const sandbox = { module: { exports: {} }, A: { watchlist: [] } };
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'index.html(extracted)' });
const { editDistance, plateSimilarity, watchlistMatch, setWatchlist } = sandbox.module.exports;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

check('editDistance of identical strings is 0', editDistance('ABC123', 'ABC123') === 0);
check('editDistance of a one-character substitution is 1', editDistance('ABC123', 'ABC128') === 1);
check('editDistance of empty vs non-empty is the string length', editDistance('', 'ABC') === 3);
check('editDistance is symmetric', editDistance('ABC123', 'XYZ789') === editDistance('XYZ789', 'ABC123'));

check('plateSimilarity of identical strings is 1', plateSimilarity('ABC123', 'ABC123') === 1);
check('plateSimilarity of two empty strings is 1', plateSimilarity('', '') === 1);
const oneCharOff = plateSimilarity('ABC123', 'ABC128'); // classic OCR 3/8 confusion
check('plateSimilarity of a one-character-off plate is high (>0.8)', oneCharOff > 0.8, oneCharOff);
const veryDifferent = plateSimilarity('ABC123', 'ZZZ999');
check('plateSimilarity of a very different plate is low (<0.3)', veryDifferent < 0.3, veryDifferent);

// watchlistMatch: exact match takes priority over fuzzy, fuzzy only kicks in above the
// threshold, and a fuzzy hit is clearly flagged as such (never silently exact).
setWatchlist([{ key: 'ABC123', label: 'My car' }]);
const exact = watchlistMatch('ABC123');
check('an exact plate match is found', exact && exact.key === 'ABC123' && !exact.fuzzy, JSON.stringify(exact));

const fuzzy = watchlistMatch('ABC128'); // one-character OCR misread (3->8)
check('a one-character misread still matches via fuzzy fallback', fuzzy && fuzzy.key === 'ABC123', JSON.stringify(fuzzy));
check('a fuzzy match is explicitly flagged, not presented as exact', fuzzy && fuzzy.fuzzy === true, JSON.stringify(fuzzy));

const noMatch = watchlistMatch('ZZZ999');
check('an unrelated plate does not match at all', noMatch === null, JSON.stringify(noMatch));

const empty = watchlistMatch('');
check('an empty/unreadable value never matches', empty === null, JSON.stringify(empty));

setWatchlist([]);
const emptyWatchlist = watchlistMatch('ABC123');
check('an empty watchlist matches nothing', emptyWatchlist === null, JSON.stringify(emptyWatchlist));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
