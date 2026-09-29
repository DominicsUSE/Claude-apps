// Runs the real, unmodified plate-reading pipeline from ../../index.html against the
// synthetic test images from gen-plates.js, using a genuine local Tesseract.js@5.1.1 engine
// (the exact version the app pins) served from disk instead of the CDN - useful in sandboxes
// where cdn.jsdelivr.net is blocked, identical behavior otherwise. See README.md for setup,
// exactly what this does and doesn't prove, and the results obtained when this was last run.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const LOCAL_ROOTS = [
  path.join(__dirname, 'node_modules/tesseract.js/dist'),
  path.join(__dirname, 'node_modules/tesseract.js-core'),
  path.join(__dirname, 'node_modules/@tesseract.js-data/eng/4.0.0'),
];
function findLocalFile(basename) {
  for (const root of LOCAL_ROOTS) {
    const p = path.join(root, basename);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
function contentTypeFor(basename) {
  if (basename.endsWith('.wasm')) return 'application/wasm';
  if (basename.endsWith('.gz')) return 'application/gzip';
  if (basename.endsWith('.js')) return 'application/javascript';
  return 'application/octet-stream';
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));

  await page.route('**cdn.jsdelivr.net**tesseract**', async route => {
    const url = new URL(route.request().url());
    const basename = url.pathname.split('/').pop();
    const localPath = findLocalFile(basename);
    if (localPath) await route.fulfill({ status: 200, contentType: contentTypeFor(basename), body: fs.readFileSync(localPath) });
    else { console.log('UNMATCHED CDN REQUEST (no local file for):', url.href); await route.abort(); }
  });

  await page.goto('file://' + path.resolve(__dirname, '..', '..', 'index.html'));
  await page.waitForSelector('#later');
  await page.click('#later');

  console.log('Loading real local Tesseract OCR engine...');
  const { ocrReady } = await page.evaluate(async () => { await loadOCR(); return { ocrReady: !!A.ocr }; });
  console.log('OCR engine ready:', ocrReady);
  if (!ocrReady) throw new Error('Real Tesseract engine failed to load - cannot run the accuracy test.');

  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'generated', 'manifest.json'), 'utf-8'));
  const results = [];

  for (const testCase of manifest) {
    const dataUrl = 'data:image/jpeg;base64,' + fs.readFileSync(testCase.file).toString('base64');
    const result = await page.evaluate(async ({ dataUrl, bounds }) => {
      const img = new Image();
      await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = dataUrl; });
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      // exact=true: OCR precisely the known plate rectangle, isolating plate-reading
      // accuracy from vehicle detection (a separate concern, tested elsewhere).
      return await scanPlateImage(canvas, bounds, true);
    }, { dataUrl, bounds: testCase.bounds });

    const expectedKey = testCase.expectedText.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const gotKey = (result.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const exactMatch = gotKey === expectedKey;
    results.push({ ...testCase, result, exactMatch });

    const mark = exactMatch ? (result.status === 'confirmed' ? 'PASS ' : 'PASS?') : 'FAIL ';
    console.log(
      `${mark} [${testCase.distance.padEnd(5)} ${testCase.country.padEnd(8)}] expected "${testCase.expectedText}" -> ` +
      `got ${result.status} "${result.value || ''}" (${result.confidence || 0}%)`
    );
  }

  const byDistance = {};
  for (const r of results) {
    byDistance[r.distance] = byDistance[r.distance] || { total: 0, exact: 0, confirmed: 0 };
    byDistance[r.distance].total++;
    if (r.exactMatch) byDistance[r.distance].exact++;
    if (r.exactMatch && r.result.status === 'confirmed') byDistance[r.distance].confirmed++;
  }
  console.log('\n=== Summary by distance ===');
  for (const [dist, stats] of Object.entries(byDistance)) {
    console.log(`${dist.padEnd(6)}: ${stats.exact}/${stats.total} read correctly (${stats.confirmed}/${stats.total} confirmed status)`);
  }

  fs.writeFileSync(path.join(__dirname, 'generated', 'results.json'), JSON.stringify(results, null, 2));
  if (errors.length) { console.error('\nPage errors during test:', errors); process.exitCode = 1; }
  await browser.close();
})().catch(e => { console.error('TEST HARNESS ERROR:', e); process.exit(1); });
