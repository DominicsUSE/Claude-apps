// The help pages under /docs/ (docs/install.html: how to download, check and install the desktop app).
// They are plain pages: their own policy lets them use Snug's stylesheets, fonts and pictures and nothing
// else (no script at all, no frames, no forms), and the app page's policy stays exactly as it was.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/index.js';

const dir = mkdtempSync(join(tmpdir(), 'snug-docs-'));
let srv, base;
test.before(async () => { srv = await startServer({ port: 0, dataDir: dir, quiet: true }); base = `http://127.0.0.1:${srv.port}`; });
test.after(async () => { await srv.close(); rmSync(dir, { recursive: true, force: true }); });
const get = (p) => fetch(base + p, { signal: AbortSignal.timeout(10_000) });
const policy = (h) => Object.fromEntries(h.split(';').map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([k, ...v]) => [k, v]));

test('docs pages get a page policy: Snug\'s own styles, fonts and pictures, never script, frames or forms', async () => {
  const res = await get('/docs/install.html');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  const p = policy(res.headers.get('content-security-policy'));
  assert.deepEqual(p['default-src'], ["'none'"]);
  assert.deepEqual(p['style-src'], ["'self'"], 'stylesheets from Snug only, no inline styles');
  assert.deepEqual(p['font-src'], ["'self'"]);
  assert.deepEqual(p['img-src'], ["'self'"]);
  for (const d of ['script-src', 'connect-src', 'frame-src', 'object-src']) assert.equal(p[d], undefined, `${d} falls back to 'none'`);
  assert.deepEqual(p['frame-ancestors'], ["'none'"]);
  assert.deepEqual(p['base-uri'], ["'none'"]);
  assert.deepEqual(p['form-action'], ["'none'"]);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  await res.text();
});

test('only HTML under docs/ gets it: other files there, and the app page, keep their policies', async () => {
  const png = await get('/docs/preview.png');
  assert.equal(png.status, 200);
  assert.equal(png.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  await png.arrayBuffer();
  const app = await get('/');
  assert.match(app.headers.get('content-security-policy'), /^default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'/);
  await app.text();
  assert.equal((await get('/docs/../server/index.js')).status, 404);
});

test('the install page explains, in plain words, which file to get, the warning, and how to check the download', async () => {
  const html = await (await get('/docs/install.html')).text();
  for (const want of [
    /Snug-Setup-/, /portable/, /-mac\.dmg/, // which file
    /SmartScreen/, /Windows protected your PC/, /More info/, /Run anyway/, // the warning, honestly
    /Get-FileHash .*-Algorithm SHA256/, /shasum -a 256/, /SHA256SUMS-windows\.txt/, /SHA256SUMS-mac\.txt/, // the checksum
    /gh attestation verify .* -R DominicsUSE\/Claude-apps/, // provenance
    /github\.com\/DominicsUSE\/Claude-apps\/releases/, // where the files are
    /never (go|goes) back|older version/i, // rollback
  ]) assert.match(html, want);
  assert.doesNotMatch(html, /<script|\sstyle=|\son[a-z]+=/i, 'no script, inline style or handler: the policy would block them');
  for (const m of html.matchAll(/<link [^>]*href="([^"]+)"/g)) assert.equal((await get(m[1])).status, 200, m[1]);
  assert.match(html, /<html lang="en"/);
  assert.match(html, /<meta name="viewport"/);
  // The release notes template and the page name the same files (desktop/release.sh).
  const notes = readFileSync(new URL('../desktop/release.sh', import.meta.url), 'utf8');
  assert.match(notes, /docs\/install\.html|install page/);
});
