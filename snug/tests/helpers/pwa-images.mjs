// Makes the web app manifest's maskable icon and its screenshots (brand/):
//   node --disable-warning=ExperimentalWarning tests/helpers/pwa-images.mjs
// The screenshots show the sample data (npm run seed), signed in as robin.
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../server/index.js';
import { openDb } from '../../server/db.js';
import { seedDatabase } from '../../server/seed.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const brand = fileURLToPath(new URL('../../brand/', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'snug-pwa-'));
const db = openDb(join(dir, 'snug.db'));
seedDatabase(db, join(dir, 'files'), { password: 'snug-demo-1' });
db.close();
const srv = await startServer({ port: 0, dataDir: dir, quiet: true });
const url = `http://127.0.0.1:${srv.port}`;
const browser = await chromium.launch();
try {
  // The maskable icon, 512 px.
  const icon = await browser.newPage({ viewport: { width: 512, height: 512 } });
  await icon.setContent(`<style>html,body{margin:0}</style>${readFileSync(join(brand, 'app-icon-maskable.svg'), 'utf8').replace('width="1024" height="1024"', 'width="512" height="512"')}`);
  await icon.screenshot({ path: join(brand, 'app-icon-maskable-512.png') });
  // Screenshots: a phone and a wide window, in the dark theme.
  for (const [name, opts, house] of [
    ['phone', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, false],
    ['wide', { viewport: { width: 1280, height: 800 } }, true],
  ]) {
    const ctx = await browser.newContext({ ...opts, colorScheme: 'dark' });
    const page = await ctx.newPage();
    await page.goto(url);
    await page.fill('#auth-handle', 'robin');
    await page.fill('#auth-pass', 'snug-demo-1');
    await page.click('.auth-form button[type=submit]');
    await page.waitForFunction(() => window.snug?.S.conn.socket === 'open');
    if (house) {
      await page.click('.rail-house:has-text("Kiln & Co.")');
      await page.click('.nav .row:has-text("Glaze lab")');
      await page.locator('.main .msg').first().waitFor();
    }
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(brand, 'screens', `${name}.png`) });
    await ctx.close();
  }
} finally {
  await browser.close();
  await srv.close();
  rmSync(dir, { recursive: true, force: true });
}
