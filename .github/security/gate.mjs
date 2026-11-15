#!/usr/bin/env node
// Pass/fail gate for Snug's security scanners (.github/workflows/security.yml and `npm run audit:*` in snug/).
// The scanners report everything (their SARIF goes to GitHub code scanning); this decides what breaks the build:
// HIGH and CRITICAL findings in Snug's own code and dependencies. Node built-ins only, no dependencies.
//
//   node gate.mjs osv <osv.json|->  [--only snug/]      CVSS >= 7.0, or advisory severity HIGH/CRITICAL
//   node gate.mjs semgrep <semgrep.json|->              severity ERROR, category security, confidence not LOW
//   node gate.mjs electronegativity <report.csv>        severity HIGH/CRITICAL, confidence FIRM/CERTAIN
//   node gate.mjs sarif <file.sarif|dir> [--any]        security-severity >= 7.0 at level error, precision high
//                                                       (CodeQL); --any: every result blocks (gitleaks)
//   node gate.mjs rebase <in.sarif> <out.sarif> <prefix> make a tool's relative paths repository-relative
//
// Options: --root <repo> (paths are reported relative to it; default $GITHUB_WORKSPACE or the current folder),
// --reviewed <file> (default reviewed.json next to this script: findings a person checked and recorded as not
// exploitable, by rule and file, each with the reason).
// Test files, mocks, generated code (desktop/snug, dist) and third-party code (node_modules, vendor) never block:
// they are still in the uploaded reports. Exit 0 = pass, 1 = blocking findings, 2 = bad or missing input.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const [mode, file, ...rest] = process.argv.slice(2);
const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
const SKIP = /(^|\/)(node_modules|vendor|dist|tests?)\/|(^|\/)desktop\/snug\/|(^|\/)test\.js$|\.test\.[cm]?js$|(^|\/)mock-[^/]*\.js$/;

const bad = (msg) => { console.error(`gate: ${msg}`); process.exit(2); };
const ROOT = opt('--root') || process.env.GITHUB_WORKSPACE || process.cwd();
const rel = (p) => {
  let s = String(p || '');
  if (s.startsWith('file:')) { try { s = fileURLToPath(s); } catch { /* keep as is */ } }
  return (isAbsolute(s) ? relative(ROOT, s) : s).split(sep).join('/').replace(/^\.\//, '');
};
const samePath = (a, b) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);

const reviewedFile = opt('--reviewed') || join(dirname(fileURLToPath(import.meta.url)), 'reviewed.json');
const reviewed = existsSync(reviewedFile) ? JSON.parse(readFileSync(reviewedFile, 'utf8')) : [];
for (const r of reviewed) if (!r.rule || !r.path || !r.why) bad(`${reviewedFile}: every entry needs rule, path and why`);
const isReviewed = (rule, path) => reviewed.some((r) => (rule === r.rule || rule.endsWith(`.${r.rule}`)) && samePath(rel(path), r.path));

function input(f = file) {
  if (!f) bad('no report given');
  let text;
  try { text = readFileSync(f === '-' ? 0 : f, 'utf8'); } catch (e) { bad(`cannot read ${f}: ${e.code || e.message}`); }
  if (!text.trim()) bad(`${f === '-' ? 'stdin' : f} is empty (did the scanner run?)`);
  return text;
}
function json(text) { try { return JSON.parse(text); } catch { return bad('report is not JSON'); } }
function finish(name, found, seen) {
  const blocking = found.filter((b) => !isReviewed(b.rule, b.path));
  for (const b of found) console.log(`${blocking.includes(b) ? 'BLOCKING' : 'reviewed'}  ${rel(b.path)}${b.line ? `:${b.line}` : ''}  ${b.rule}  ${b.note || ''}`);
  console.log(`gate ${name}: ${seen} finding(s) reported, ${blocking.length} blocking (high/critical)${found.length > blocking.length ? `, ${found.length - blocking.length} reviewed` : ''}.`);
  process.exit(blocking.length ? 1 : 0);
}

const modes = {
  // osv-scanner v2 `--format json`: results[].source.path, packages[].groups[].max_severity (a CVSS score).
  osv() {
    const j = json(input());
    if (!Array.isArray(j.results)) bad('not an osv-scanner JSON report');
    const only = opt('--only');
    const found = [];
    let seen = 0;
    for (const r of j.results) {
      const src = rel(r.source?.path);
      for (const p of r.packages || []) {
        const label = new Map((p.vulnerabilities || []).map((v) => [v.id, String(v.database_specific?.severity || '').toUpperCase()]));
        for (const g of p.groups || []) {
          seen++;
          if (only && !src.startsWith(only)) continue;
          const score = Number.parseFloat(g.max_severity);
          const high = (g.ids || []).map((id) => label.get(id)).find((s) => s === 'HIGH' || s === 'CRITICAL');
          if ((Number.isFinite(score) && score >= 7) || high) {
            found.push({ path: src, rule: (g.aliases || g.ids || []).join(','), note: `${p.package?.name}@${p.package?.version} severity ${g.max_severity || high}` });
          }
        }
      }
    }
    finish('osv', found, seen);
  },
  // semgrep `--json`: results[].extra.{severity, metadata.{category, confidence}}.
  semgrep() {
    const j = json(input());
    if (!Array.isArray(j.results)) bad('not a semgrep JSON report');
    const fatal = (j.errors || []).filter((e) => e.level === 'error');
    if (fatal.length) bad(`semgrep reported ${fatal.length} error(s), first: ${fatal[0].type || ''} ${String(fatal[0].message || '').slice(0, 200)}`);
    const found = j.results
      .filter((r) => r.extra?.severity === 'ERROR')
      .filter((r) => (r.extra.metadata?.category || 'security') === 'security')
      .filter((r) => String(r.extra.metadata?.confidence || 'MEDIUM').toUpperCase() !== 'LOW')
      .filter((r) => !SKIP.test(rel(r.path)))
      .map((r) => ({ path: r.path, line: r.start?.line, rule: r.check_id }));
    finish('semgrep', found, j.results.length);
  },
  // electronegativity `-o report.csv`: issue, severity, confidence, filename, location, ...
  electronegativity() {
    const rows = input().trim().split(/\r?\n/).slice(1)
      .map((l) => (l.match(/("([^"]|"")*"|[^,]*)(,|$)/g) || []).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '')));
    const found = rows
      .filter(([, sev, conf]) => /^(HIGH|CRITICAL)$/.test(sev) && /^(FIRM|CERTAIN)$/.test(conf))
      .filter(([, , , f]) => !SKIP.test(rel(f)) && !/^snug\//.test(rel(f))) // snug/ inside desktop/ is the generated copy
      .map(([rule, sev, conf, path, loc]) => ({ path, line: String(loc).split(':')[0], rule, note: `${sev}/${conf}` }));
    finish('electronegativity', found, rows.length);
  },
  // SARIF 2.1.0 (CodeQL, gitleaks). security-severity and precision come from the rule (driver or extensions).
  sarif() {
    if (!file) bad('no report given');
    const files = existsSync(file) && statSync(file).isDirectory()
      ? readdirSync(file).filter((f) => f.endsWith('.sarif')).map((f) => join(file, f)) : [file];
    if (!files.length) bad(`no .sarif files in ${file}`);
    const any = rest.includes('--any');
    const found = [];
    let seen = 0;
    for (const f of files) {
      for (const run of json(input(f)).runs || []) {
        const rules = new Map();
        for (const c of [run.tool?.driver, ...(run.tool?.extensions || [])]) for (const r of c?.rules || []) rules.set(r.id, r);
        for (const r of run.results || []) {
          seen++;
          const loc = r.locations?.[0]?.physicalLocation;
          const path = loc?.artifactLocation?.uri || '';
          const rule = rules.get(r.ruleId) || {};
          const level = r.level || rule.defaultConfiguration?.level || rule.properties?.['problem.severity'] || 'warning';
          const score = Number.parseFloat(rule.properties?.['security-severity']);
          const precise = /^(high|very-high)$/.test(rule.properties?.precision || 'high');
          if (any || (level === 'error' && score >= 7 && precise && !SKIP.test(rel(path)))) {
            found.push({ path, line: loc?.region?.startLine, rule: r.ruleId, note: any ? '' : `security-severity ${score}` });
          }
        }
      }
    }
    finish('sarif', found, seen);
  },
  rebase() {
    const [out, prefix] = rest;
    if (!out || !prefix) bad('usage: rebase <in.sarif> <out.sarif> <prefix>');
    const s = json(input());
    for (const run of s.runs || []) {
      delete run.originalUriBaseIds;
      for (const r of run.results || []) {
        for (const l of r.locations || []) {
          const a = l.physicalLocation?.artifactLocation;
          if (!a?.uri) continue;
          if (!/^[a-z]+:|^\//i.test(a.uri)) a.uri = `${prefix.replace(/\/?$/, '/')}${a.uri}`;
          else a.uri = rel(a.uri);
          delete a.uriBaseId;
        }
      }
      for (const a of run.artifacts || []) if (a.location?.uri && !/^[a-z]+:|^\//i.test(a.location.uri)) a.location.uri = `${prefix.replace(/\/?$/, '/')}${a.location.uri}`;
    }
    writeFileSync(out, JSON.stringify(s, null, 1));
    console.log(`gate rebase: ${out} paths now start with ${prefix}`);
  },
};
if (!Object.hasOwn(modes, mode || '')) bad(`unknown mode "${mode}" (osv, semgrep, electronegativity, sarif, rebase)`);
modes[mode]();
