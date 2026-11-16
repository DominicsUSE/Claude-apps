#!/usr/bin/env node
// Maintainer tool (not served: server/ is outside PUBLIC). Vendors the HPKE
// library (RFC 9180) that end-to-end encryption uses into vendor/hpke/:
//   node server/tools/vendor-hpke.mjs
// It packs the two pinned npm packages, checks each tarball against the
// registry's published sha512, copies only their plain ES module trees (no
// .d.ts, .map or CommonJS), rewrites the one bare import ("@hpke/common") to a
// relative path so the browser can load it without a build step, and writes
// vendor/hpke/SHA256SUMS. tests/logic-e2ee.test.js re-hashes every file
// against SHA256SUMS, so a hand edit under vendor/hpke fails the tests.
//
// Upgrading: pick releases at least 14 days old, change PINS, run this, run
// npm test (the RFC 9180 vectors must still pass), and commit the result.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, dirname, posix, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PINS = [
  { name: '@hpke/common', version: '1.10.1', dir: 'common' },
  { name: '@hpke/core', version: '1.9.0', dir: 'core' },
];
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OUT = join(ROOT, 'vendor', 'hpke');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const npm = (args, cwd) => execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd, encoding: 'utf8' });

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// Static `import … from "@hpke/common"` / `export … from "@hpke/common"` lines
// only; doc comments that mention the package are left as they are.
export function rewriteCommon(text, fileRel) {
  const target = posix.relative(posix.dirname(`core/${fileRel}`), 'common/mod.js');
  const rel = target.startsWith('.') ? target : `./${target}`;
  return text.replace(/^((?:import|export)\b[^\n]*?\bfrom\s*)"@hpke\/common";/gm, `$1"${rel}";`);
}

function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'snug-hpke-'));
  try {
    rmSync(OUT, { recursive: true, force: true });
    const notes = [];
    for (const pin of PINS) {
      const spec = `${pin.name}@${pin.version}`;
      const integrity = JSON.parse(npm(['view', spec, 'dist.integrity', '--json'], tmp));
      const file = JSON.parse(npm(['pack', spec, '--json'], tmp))[0].filename;
      const tgz = readFileSync(join(tmp, file));
      const got = `sha512-${createHash('sha512').update(tgz).digest('base64')}`;
      if (got !== integrity) throw new Error(`${spec}: tarball sha512 ${got} does not match the registry's ${integrity}`);
      const unpack = join(tmp, pin.dir);
      mkdirSync(unpack);
      execFileSync('tar', ['-xzf', join(tmp, file), '-C', unpack]);
      const pkg = join(unpack, 'package');
      const license = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).license;
      if (license !== 'MIT') throw new Error(`${spec}: licence is ${license}, expected MIT`);
      const dest = join(OUT, pin.dir);
      for (const src of walk(join(pkg, 'esm'))) {
        if (!src.endsWith('.js')) continue;
        const rel = relative(join(pkg, 'esm'), src).split(sep).join('/');
        mkdirSync(dirname(join(dest, rel)), { recursive: true });
        const text = readFileSync(src, 'utf8');
        writeFileSync(join(dest, rel), pin.dir === 'core' ? rewriteCommon(text, rel) : text);
      }
      copyFileSync(join(pkg, 'LICENSE'), join(dest, 'LICENSE'));
      notes.push({ spec, integrity, license });
    }
    const sums = walk(OUT).map((p) => relative(OUT, p).split(sep).join('/')).sort()
      .map((rel) => `${sha256(readFileSync(join(OUT, rel)))}  ${rel}`);
    writeFileSync(join(OUT, 'SHA256SUMS'), `${sums.join('\n')}\n`);
    const readme = join(ROOT, 'vendor', 'README.txt');
    const start = '--- hpke (written by server/tools/vendor-hpke.mjs) ---';
    const before = readFileSync(readme, 'utf8').split(start)[0].trimEnd();
    const block = [start,
      'hpke/ holds the plain ES module builds of @hpke/core and @hpke/common (HPKE, RFC 9180), MIT licence,',
      'by Ajitomi Daisuke. https://github.com/dajiaji/hpke-js  https://www.npmjs.com/package/@hpke/core',
      'Only change: `from "@hpke/common"` in core is rewritten to a relative path. SHA256SUMS lists every file after that.',
      ...notes.map((n) => `${n.spec}  ${n.license}  ${n.integrity}`)].join('\n');
    writeFileSync(readme, `${before}\n\n${block}\n`);
    console.log(`vendor/hpke: ${sums.length} files from ${notes.map((n) => n.spec).join(', ')}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
