// v0.10 Settings > Your data > Data file, end to end: one PC with the local registry and a Chromium page.
// Save data file downloads the sealed file; an edited file is refused with the plain message and nothing
// changes; the same file imports as a no-op; the backup setting sticks. A LAN guest sees none of it.
import './helpers/vault.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { startRegistry, startPc, signUp, guest, until } from './helpers/p2p.js';
import { counts, flip } from './helpers/vault.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const SHOTS = process.env.SNUG_SHOTS || '';
const shot = (page, name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/vault-${name}.png` }) : null);

let registry, browser, A, a, page;
const errors = [];

async function open(srv, client) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
  const [name, value] = client.cookie.split('=');
  await ctx.addCookies([{ name, value, url: srv.base }]);
  const p = await ctx.newPage();
  p.setDefaultTimeout(15000);
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|WebSocket connection|ERR_CONNECTION_REFUSED|ERR_EMPTY_RESPONSE/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  await p.goto(srv.base);
  await p.waitForFunction(() => window.snug.S.auth === 'in' && window.snug.S.conn.socket === 'open');
  return p;
}
async function yourData(p) {
  await p.click('.me-row [aria-label="Settings"]');
  await p.locator('.layer-body h1').waitFor();
  await p.click('.layer-nav .row:has-text("Your data")');
  await p.locator('.layer-body h1:has-text("Your data")').waitFor();
}
const toastWith = (p, re) => p.waitForFunction((src) => (window.snug.S.ui.toasts || []).some((t) => new RegExp(src).test(t.text)), re.source);

test.before(async () => {
  registry = await startRegistry();
  browser = await chromium.launch();
  A = await startPc(registry);
  a = await signUp(A, registry, 9101, 'vault_e2e');
  await until(() => A.vault.status().file, 10_000, 'first data file');
});
test.after(async () => {
  await browser?.close();
  await A?.close().catch(() => {});
  await registry?.close();
});
test.afterEach(() => assert.deepEqual(errors.splice(0), [], 'page errors'));

test('Settings > Your data shows the data file; Save data file downloads the sealed file', async () => {
  page = await open(A, a);
  await yourData(page);
  await page.locator('#vault-head').waitFor();
  await page.waitForFunction(() => /Saved /.test(document.querySelector('#vault-status')?.textContent || ''));
  assert.match(await page.locator('#vault-status').textContent(), /Not protected by the OS/, 'no OS key store in tests, and the page says so');
  await shot(page, 'settings');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#vault-save')]);
  assert.match(dl.suggestedFilename(), /^Snug data \d{4}-\d{2}-\d{2}\.snugvault$/);
  const buf = readFileSync(await dl.path());
  assert.equal(buf.subarray(0, 8).toString(), 'SNUGVLT1');
});

test('an edited file is refused with the plain message and nothing changes; the real one imports as a no-op', async () => {
  const res = await fetch(`${A.base}/api/vault/file`, { headers: { cookie: a.cookie } });
  const file = Buffer.from(await res.arrayBuffer());
  const before = counts(A);
  await page.setInputFiles('#vault-file', { name: 'edited.snugvault', mimeType: 'application/octet-stream', buffer: flip(file, file.length - 20) });
  await toastWith(page, /changed outside Snug or is damaged, so Snug won’t use it/);
  assert.deepEqual(counts(A), before);
  await page.setInputFiles('#vault-file', { name: 'mine.snugvault', mimeType: 'application/octet-stream', buffer: file });
  await toastWith(page, /Everything in it was already here/);
  assert.deepEqual(counts(A), before);
});

test('the backup setting sticks; the Send row says when the other PC isn’t connected', async () => {
  await page.click('.seg[aria-label="Back up automatically"] button:has-text("Every 3 days")');
  await until(() => A.vault._meta.num('backup_days') === 3, 5000, 'saved');
  await page.waitForFunction(() => window.snug.S.vault?.backupDays === 3);
  assert.equal(await page.locator('.seg[aria-label="Back up automatically"] button[aria-pressed="true"]').textContent(), 'Every 3 days');
  assert.match(await page.locator('.layer-body').textContent(), /Your other PC isn’t connected/);
});

test('a LAN guest on the same PC sees no data file block', async () => {
  const g = await guest(A, 'vaultguest');
  const gp = await open(A, g);
  await yourData(gp);
  assert.equal(await gp.locator('#vault-head').count(), 0);
  await gp.context().close();
});
