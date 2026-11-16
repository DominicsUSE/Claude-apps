// The security gate's ZAP reader (.github/security/gate.mjs zap): the baseline scan reports everything it
// sees; only High-risk alerts that nobody accepted in .github/security/zap-rules.tsv fail the build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const GATE = fileURLToPath(new URL('../../.github/security/gate.mjs', import.meta.url));
const RULES = fileURLToPath(new URL('../../.github/security/zap-rules.tsv', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'snug-gate-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

// The shape of `zap-baseline.py -J`: site[].alerts[] with riskcode 0-3 and confidence 0-4 (0 = false positive).
const alert = (pluginid, riskcode, confidence = '2', name = `rule ${pluginid}`) => ({
  pluginid, alertRef: pluginid, name, riskcode, confidence, riskdesc: `risk ${riskcode}`, count: '1',
  instances: [{ uri: 'http://127.0.0.1:8787/', method: 'GET' }],
});
const report = (alerts) => ({ '@programName': 'ZAP', '@version': '2.17.0', site: [{ '@name': 'http://127.0.0.1:8787', alerts }] });
let n = 0;
function gate(body, ...args) {
  const f = join(dir, `zap-${n++}.json`);
  writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body));
  return spawnSync(process.execPath, [GATE, 'zap', f, ...args], { encoding: 'utf8' });
}

test('zap: medium, low and informational alerts are reported but pass', () => {
  const r = gate(report([alert('10055', '2', '3'), alert('10038', '0'), alert('10027', '1')]));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /gate zap: 3 finding\(s\) reported, 0 blocking/);
});

test('zap: a High-risk alert fails, a High that ZAP itself marks a false positive does not', () => {
  const r = gate(report([alert('40012', '3', '2', 'Cross Site Scripting (Reflected)'), alert('10055', '2')]));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /BLOCKING .*40012/);
  assert.equal(gate(report([alert('40012', '3', '0')])).status, 0, 'confidence 0 is a false positive');
});

test('zap: a High alert accepted with IGNORE in the rules file passes, with the reason shown', () => {
  const rules = join(dir, 'rules.tsv');
  writeFileSync(rules, '# comment\n10202\tIGNORE\t(Absence of Anti-CSRF Tokens: JSON API checks Origin)\n10055\tWARN\t(CSP)\n');
  const r = gate(report([alert('10202', '3')]), '--rules', rules);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /accepted .*10202.*Origin/);
  assert.equal(gate(report([alert('10055', '3')]), '--rules', rules).status, 1, 'WARN is not acceptance');
});

test('zap: a report that is not ZAP JSON, or is empty, is an error (exit 2), never a pass', () => {
  assert.equal(gate('').status, 2);
  assert.equal(gate({ results: [] }).status, 2);
  assert.equal(gate('not json').status, 2);
});

test('the committed rules file is valid: id, action, reason on every line; nothing High-risk silently ignored', () => {
  const lines = readFileSync(RULES, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  assert.ok(lines.length >= 1);
  for (const l of lines) assert.match(l, /^\d+\t(IGNORE|INFO|WARN|FAIL)\t\(.{10,}\)$/, l);
  // 10055 (style-src 'unsafe-inline') is known: the stricter policy runs report-only (server/index.js CSP_STRICT).
  assert.ok(lines.some((l) => l.startsWith('10055\tWARN\t')));
});
