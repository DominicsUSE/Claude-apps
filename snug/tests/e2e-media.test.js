// Media in Chromium against the real server and seeded data: big files going
// up in parts with progress and Cancel, the server's own size limit, GIF search
// through a keyless provider (a local stand-in for Openverse) with credits and
// an offline note, SVG shown safely as a picture, PDF first page and pages, and
// text files shown as text. Ends with the GIF picker and a preview on a phone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { startServer } from '../server/index.js';
import { openDb } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const PASSWORD = 'snug-demo-1';
const MB = 1024 * 1024;
const dir = mkdtempSync(join(tmpdir(), 'snug-e2e-media-'));
let srv, browser, url, mock, here;
const errors = [];
const hits = [];
const GIF = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');

// A PDF with `pages` pages, each saying "Page N" (offsets computed, so pdf.js reads it without repair).
function pdf(pages = 2) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>'];
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(' ');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  const font = 3 + pages * 2;
  for (let i = 0; i < pages; i++) {
    const text = `BT /F1 36 Tf 72 700 Td (Page ${i + 1}) Tj ET 0 0 1 rg 72 400 300 200 re f`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  }
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test.before(async () => {
  // A stand-in for Openverse and for any outside address an SVG might try to load.
  mock = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    hits.push(u.pathname);
    if (u.pathname === '/v1/images/') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ results: [1, 2, 3].map((n) => ({ id: `cat${n}`, title: `Cat ${n}`, url: `${here}/m/cat${n}.gif`, thumbnail: `${here}/m/cat${n}-t.gif`, creator: 'Ada Lovelace', license: 'by', license_version: '4.0', foreign_landing_url: `https://example.org/cat${n}`, width: 120, height: 90 })) }));
    } else if (u.pathname.endsWith('.gif')) { res.setHeader('content-type', 'image/gif'); res.end(GIF); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  here = `http://127.0.0.1:${mock.address().port}`;
  const db = openDb(join(dir, 'snug.db'));
  seedDatabase(db, join(dir, 'files'), { password: PASSWORD });
  db.close();
  Object.assign(process.env, { SNUG_GIF_PROVIDER: 'openverse', SNUG_OPENVERSE_BASE: here });
  try {
    srv = await startServer({ port: 0, dataDir: dir, quiet: true, linkPreviews: false, uploads: { maxFile: 40 * MB, statfs: () => ({ bavail: 1e9, bsize: 4096 }) } });
  } finally { delete process.env.SNUG_GIF_PROVIDER; delete process.env.SNUG_OPENVERSE_BASE; }
  url = `http://127.0.0.1:${srv.port}`;
  browser = await chromium.launch();
});
test.after(async () => { await browser?.close(); await srv.close(); await new Promise((r) => mock.close(r)); rmSync(dir, { recursive: true, force: true }); });
test.beforeEach(() => srv.resetLimits());
test.afterEach(() => { const seen = errors.splice(0); assert.deepEqual(seen, [], 'page errors'); });

async function person(handle, { viewport = { width: 1280, height: 800 }, mobile = false } = {}) {
  const ctx = await browser.newContext({ viewport, ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}), acceptDownloads: true });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(`${handle}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|WebSocket connection|ERR_CONNECTION_REFUSED|ERR_INTERNET_DISCONNECTED|Report Only/.test(m.text())) errors.push(`${handle} console: ${m.text()}`);
  });
  page.on('dialog', (d) => { errors.push(`${handle}: a dialog opened: ${d.message()}`); d.dismiss(); });
  await page.goto(url);
  await page.waitForSelector('.auth-form');
  await page.fill('#auth-handle', handle);
  await page.fill('#auth-pass', PASSWORD);
  await page.click('.auth-form button[type=submit]');
  await page.waitForFunction(() => window.snug.S.conn.socket === 'open');
  return page;
}
async function go(page, name) {
  if (!(await page.locator('.rail-house[aria-current="page"]:has-text("Kiln & Co.")').count())) {
    await page.click('.rail-house:has-text("Kiln & Co.")');
    await page.locator('.nav .ctx-house:has-text("Kiln & Co.")').waitFor();
  }
  await page.click(`.nav .row:has-text("${name}")`);
  await page.locator(`.main .bar-title:has-text("${name}")`).waitFor();
}
const box = (page) => page.locator('.main .composer textarea');
const attach = (page, files) => page.locator('.main .composer input[type=file]').setInputFiles(files);
const msg = (page, text) => page.locator('.main .msg', { hasText: text });
const ready = (page, name) => page.locator(`.pending-file:has-text("${name}") .pending-state:not(:has-text("Uploading"))`).waitFor({ timeout: 30000 });
const send = async (page, text) => { await box(page).fill(text); await box(page).press('Enter'); };

let robin, ines;
test('big file: goes up in parts with a progress bar, then sends; another is cancelled and leaves nothing on the server', async () => {
  robin = await person('robin');
  ines = await person('ines');
  await go(robin, 'Glaze lab');
  await go(ines, 'Glaze lab');
  // Slow each part down a little so the progress bar can be seen.
  await robin.route('**/api/uploads/u_*', async (route) => { await new Promise((r) => setTimeout(r, 120)); await route.continue().catch(() => {}); });
  const big = randomBytes(25 * MB);
  await attach(robin, { name: 'kiln-log.zip', mimeType: 'application/zip', buffer: big });
  const bar = robin.locator('.pending-file:has-text("kiln-log.zip") progress.pending-progress');
  await bar.waitFor();
  await robin.locator('.pending-file:has-text("kiln-log.zip") .pending-state:has-text("%")').waitFor();
  await ready(robin, 'kiln-log.zip');
  await send(robin, 'the whole firing log');
  const chip = msg(ines, 'the whole firing log').last().locator('a.file');
  await chip.waitFor();
  assert.match(await chip.textContent(), /kiln-log\.zip.*25\.0 MB/);
  const dl = await chip.getAttribute('href');
  const got = await ines.evaluate(async (h) => (await (await fetch(h)).arrayBuffer()).byteLength, dl);
  assert.equal(got, big.length);
  // Cancel while it uploads: the chip goes and so does the server's partial upload.
  await attach(robin, { name: 'second.zip', mimeType: 'application/zip', buffer: randomBytes(30 * MB) });
  await robin.locator('.pending-file:has-text("second.zip") progress.pending-progress').waitFor();
  await robin.click('button[aria-label="Cancel uploading second.zip"]');
  await robin.locator('.pending-file:has-text("second.zip")').waitFor({ state: 'detached' });
  await robin.waitForFunction(() => true);
  for (let i = 0; i < 50 && srv.db.get('SELECT COUNT(*) n FROM uploads').n; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(srv.db.get('SELECT COUNT(*) n FROM uploads').n, 0, 'the server dropped the half upload');
  await robin.unroute('**/api/uploads/u_*');
});

test('size limit: a file over the server’s limit is refused at once with the limit named', async () => {
  await attach(robin, { name: 'too-big.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(41 * MB) });
  await robin.locator('.toast:has-text("too-big.bin is 41.0 MB. Files can be up to 40 MB here.")').waitFor();
  assert.equal(await robin.locator('.pending-file:has-text("too-big.bin")').count(), 0);
});

test('GIF search: says where results come from, sends a copy with its credit, and says so when offline', async () => {
  await robin.click('.main .composer .gif-btn');
  const pop = robin.locator('.pop .gif-picker');
  await pop.waitFor();
  await pop.locator('[role=tab]:has-text("Search")').click();
  await pop.locator('.gif-from:has-text("Openverse")').waitFor();
  assert.match(await pop.locator('.gif-from').textContent(), /sees this server’s address and what you search for, not yours/);
  await pop.locator('input[aria-label="Search GIFs"]').fill('cat');
  const tile = pop.locator('.gif-tile', { hasText: 'Ada Lovelace' }).first();
  await tile.waitFor();
  assert.match(await tile.getAttribute('aria-label'), /Send Cat \d \(Ada Lovelace, CC BY 4\.0, via Openverse\)/);
  const before = hits.filter((h) => h === '/v1/images/').length;
  assert.equal(before, 1, 'the server searched, once');
  await tile.click();
  const sent = msg(ines, '').locator('.gif-credit:has-text("Ada Lovelace, CC BY 4.0, via Openverse")').last();
  await sent.waitFor();
  assert.equal(await sent.locator('a').getAttribute('href'), 'https://example.org/cat1');
  // Offline: the picker says so instead of spinning.
  await robin.click('.main .composer .gif-btn');
  await pop.waitFor();
  await pop.locator('[role=tab]:has-text("Search")').click();
  await robin.context().setOffline(true);
  await pop.locator('input[aria-label="Search GIFs"]').fill('dog');
  await pop.locator('.gif-none:has-text("You’re offline")').waitFor();
  await robin.context().setOffline(false);
  await robin.keyboard.press('Escape');
});

test('SVG: shown as a picture from its own bytes, no script runs and nothing outside loads; it still downloads', async () => {
  const svg = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="120" height="80" viewBox="0 0 120 80">
    <script>parent.__svgRan = 1; window.top.__svgRan = 1;</script>
    <rect width="120" height="80" fill="#c0603c"/><image href="${here}/track.png" width="10" height="10"/></svg>`;
  hits.length = 0;
  await attach(robin, { name: 'cone.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) });
  await ready(robin, 'cone.svg');
  await send(robin, 'the cone chart');
  const img = msg(ines, 'the cone chart').last().locator('.svg-file img');
  await img.waitFor();
  assert.match(await img.getAttribute('src'), /^blob:/);
  await ines.waitForFunction(() => document.querySelector('.svg-file img')?.naturalWidth > 0);
  assert.equal(await ines.evaluate(() => window.__svgRan), undefined, 'the script in the SVG did not run');
  assert.equal(hits.includes('/track.png'), false, 'the SVG loaded nothing from elsewhere');
  const dl = msg(ines, 'the cone chart').last().locator('.svg-file a[download="cone.svg"]');
  const res = await ines.evaluate(async (h) => { const r = await fetch(h); return [r.headers.get('content-type'), r.headers.get('content-disposition')]; }, await dl.getAttribute('href'));
  assert.equal(res[0], 'application/octet-stream', 'opened directly, it is still a download');
  assert.match(res[1], /^attachment/);
});

test('PDF: the first page shows in the conversation; Open goes through the pages', async () => {
  await attach(robin, { name: 'firing-guide.pdf', mimeType: 'application/pdf', buffer: pdf(2) });
  await ready(robin, 'firing-guide.pdf');
  await send(robin, 'the guide');
  const card = msg(ines, 'the guide').last().locator('.pdf-file');
  await card.locator('.tfile-head:has-text("2 pages")').waitFor({ timeout: 20000 });
  const painted = await card.locator('canvas').evaluate((c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let blue = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 2] > 200 && d[i] < 60 && d[i + 1] < 60) blue++;
    return { w: c.width, blue };
  });
  assert.ok(painted.w > 100 && painted.blue > 100, `page 1 was drawn: ${JSON.stringify(painted)}`);
  await card.locator('button:has-text("Open")').click();
  const viewer = ines.locator('.pdf-viewer');
  await viewer.locator('.pdf-count:has-text("Page 1 of 2")').waitFor();
  await viewer.locator('button[aria-label="Next page"]').click();
  await viewer.locator('.pdf-count:has-text("Page 2 of 2")').waitFor();
  await viewer.locator('button:has-text("Close")').click();
  // Something named .pdf that isn't one stays a plain download.
  await attach(robin, { name: 'not-really.pdf', mimeType: 'application/pdf', buffer: Buffer.from('hello, not a pdf') });
  await ready(robin, 'not-really.pdf');
  await send(robin, 'a fake one');
  await msg(ines, 'a fake one').last().locator('a.file:has-text("not-really.pdf")').waitFor({ timeout: 20000 });
});

// One page with text in fonts the file doesn't carry: Helvetica, Symbol, and a Japanese font through a
// predefined character map (UniJIS-UCS2-H), as many PDFs made in Japan are.
function pdfFonts() {
  const text = 'BT /F1 30 Tf 72 700 Td (Helvetica here) Tj ET BT /F2 30 Tf 72 600 Td (abgd) Tj ET BT /F3 30 Tf 72 500 Td <65E5672C> Tj ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Symbol >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /KozMinPr6N-Regular /Encoding /UniJIS-UCS2-H /DescendantFonts [8 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /KozMinPr6N-Regular /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> /FontDescriptor 9 0 R >>',
    '<< /Type /FontDescriptor /FontName /KozMinPr6N-Regular /Flags 6 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>',
  ];
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('PDF: text in fonts the file doesn’t carry shows, with pdf.js’s own character maps and standard fonts from this server', async () => {
  const asked = [];
  const warned = [];
  const listen = (p) => {
    p.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/vendor/pdfjs/')) asked.push(u.pathname); });
    // (A note that this computer lacks the Japanese font itself is fine: pdf.js draws a stand-in.)
    const hear = (m) => { if (/cMapUrl|standardFontDataUrl|fetchStandardFontData|fetchBuiltInCMap|failed to fetch|Unable to load/i.test(m.text())) warned.push(m.text()); };
    p.on('console', hear);
    p.on('worker', (w) => w.on('console', hear));
  };
  listen(ines);
  await attach(robin, { name: 'fonts.pdf', mimeType: 'application/pdf', buffer: pdfFonts() });
  await ready(robin, 'fonts.pdf');
  await send(robin, 'fonts it lacks');
  const card = msg(ines, 'fonts it lacks').last().locator('.pdf-file');
  await card.locator('.tfile-head:has-text("1 page")').waitFor({ timeout: 20000 });
  // Each line of text left ink on page 1.
  const ink = await card.locator('canvas').evaluate((c) => {
    const g = c.getContext('2d');
    const band = (top, bottom) => { // PDF y (from the bottom of a 792-high page) to canvas rows
      const y0 = Math.round(c.height * (1 - bottom / 792)), y1 = Math.round(c.height * (1 - top / 792));
      const d = g.getImageData(0, y0, c.width, Math.max(1, y1 - y0)).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && d[i] < 120 && d[i + 1] < 120 && d[i + 2] < 120) n++;
      return n;
    };
    return { helvetica: band(690, 735), symbol: band(590, 635), japanese: band(490, 535) };
  });
  assert.ok(ink.helvetica > 50 && ink.symbol > 50 && ink.japanese > 50, `every line drawn: ${JSON.stringify(ink)}`);
  assert.ok(asked.includes('/vendor/pdfjs/cmaps/UniJIS-UCS2-H.bcmap'), `the character map came from this server: ${asked.join(', ')}`);
  assert.ok(asked.includes('/vendor/pdfjs/standard_fonts/FoxitSymbol.pfb'), `the Symbol font came from this server: ${asked.join(', ')}`);
  assert.deepEqual(warned, [], 'no font warnings');
});

test('text files: shown as text, never as markup; a big one shows its start and says so', async () => {
  await attach(robin, [
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('line one\n<b>not bold</b><img src=x onerror="window.__txt=1">\nline three') },
    { name: 'kiln.log', mimeType: 'text/plain', buffer: Buffer.from(Array.from({ length: 6000 }, (_, i) => `entry ${i}: temperature ok`).join('\n')) },
  ]);
  await ready(robin, 'notes.txt');
  await ready(robin, 'kiln.log');
  await send(robin, 'two text files');
  const m = msg(ines, 'two text files').last();
  const t = m.locator('.tfile:has-text("notes.txt")');
  await t.locator('text=<b>not bold</b>').waitFor();
  assert.equal(await t.locator('b, img').count(), 0, 'no markup was made');
  assert.equal(await ines.evaluate(() => window.__txt), undefined);
  const log = m.locator('.tfile:has-text("kiln.log")');
  await log.locator('button:has-text("Expand")').click();
  await log.locator('text=That’s the start of a bigger file').waitFor();
  assert.equal(await log.locator('text=entry 5999').count(), 0, 'only the start was read');
});

test('phone: the GIF picker’s Search tab and its source note fit a 390 px screen', async () => {
  const phone = await person('ines', { viewport: { width: 390, height: 844 }, mobile: true });
  await phone.evaluate(() => import('/js/store.js').then((s) => s.openConv('k_glaze')));
  await phone.locator('.main .bar-title:has-text("Glaze lab")').waitFor();
  await phone.click('.main .composer .gif-btn');
  const pop = phone.locator('.gif-picker');
  await pop.waitFor();
  await pop.locator('[role=tab]:has-text("Search")').click();
  await pop.locator('.gif-from').waitFor();
  const fits = await phone.evaluate(() => {
    const r = document.querySelector('.gif-picker').getBoundingClientRect();
    return { left: r.left, right: r.right, vw: innerWidth, scroll: document.documentElement.scrollWidth };
  });
  assert.ok(fits.left >= 0 && fits.right <= fits.vw + 1, JSON.stringify(fits));
  assert.ok(fits.scroll <= fits.vw + 1, 'no sideways scroll');
  await phone.context().close();
  await robin.context().close();
  await ines.context().close();
});
