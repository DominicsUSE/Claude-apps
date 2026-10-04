// End-to-end test for Siteless with every network call mocked (no Google key needed).
//
//   npm i playwright leaflet@1.9.4
//   node siteless/tests/app.test.js            # add --shots DIR to save screenshots
//
// Covers free mode (OpenStreetMap), saving a Google key, a Google scan that splits busy
// areas, website classification and PageSpeed checks, the place panel and CSV export.
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LEAFLET = path.dirname(require.resolve('leaflet/dist/leaflet.js'));
const shotsArg = process.argv.indexOf('--shots');
const SHOTS = shotsArg > 0 ? process.argv[shotsArg + 1] : null;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+hc2rNAAAAABJRU5ErkJggg==', 'base64');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log('  ok  ' + msg);
  else { failures++; console.log('  FAIL ' + msg); }
}

// deterministic pseudo-random numbers
function rng(seed) { let x = seed >>> 0 || 1; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296); }
const SITES = [
  () => '', () => 'https://www.facebook.com/somebistro', i => `https://good-bistro${i}.com/`, i => `http://old-diner${i}.com/`,
  () => 'https://joes-grill.business.site/', () => 'https://order.online/store/abc', i => `https://dead-domain${i}.com/`,
  i => `http://mamas${i}.wixsite.com/home`, i => `https://parked${i}.com/`,
];

const nearbyCalls = [];
const generated = new Map();   // id -> place, so the details mock can echo it
function nearbyResponse(body) {
  nearbyCalls.push(body);
  if (body.includedTypes.includes('juice_shop')) {
    return { status: 400, json: { error: { code: 400, message: 'Unsupported types: juice_shop.', status: 'INVALID_ARGUMENT' } } };
  }
  const c = body.locationRestriction.circle;
  const n = c.radius > 450 ? 20 : Math.max(2, Math.floor(c.radius / 40));
  const r = rng(Math.round(c.center.latitude * 1e5) ^ Math.round(c.center.longitude * 1e5));
  const places = [];
  for (let i = 0; i < n; i++) {
    const id = `P${Math.round(c.center.latitude * 1e5)}_${Math.round(c.center.longitude * 1e5)}_${i}`;
    const k = Math.floor(r() * SITES.length);
    const ang = r() * Math.PI * 2, d = r() * c.radius * 0.7 / 111000;
    places.push({
      id, displayName: { text: `Place ${i} ${['Bistro', 'Diner', 'Café', 'Grill'][i % 4]}` },
      location: { latitude: c.center.latitude + d * Math.sin(ang), longitude: c.center.longitude + d * Math.cos(ang) },
      shortFormattedAddress: `${10 + i} Market St`, formattedAddress: `${10 + i} Market St, Testville`,
      rating: Math.round((3.6 + r() * 1.4) * 10) / 10, userRatingCount: Math.floor(r() * 600),
      websiteUri: SITES[k](i) || undefined, googleMapsUri: `https://maps.google.com/?cid=${i}`,
      primaryType: 'restaurant', primaryTypeDisplayName: { text: 'Restaurant' }, types: ['restaurant', 'food'],
      businessStatus: i === 3 ? 'CLOSED_PERMANENTLY' : 'OPERATIONAL', nationalPhoneNumber: `(555) 010-${String(1000 + i).slice(-4)}`,
    });
  }
  places.forEach(p => generated.set(p.id, p));
  return { status: 200, json: { places } };
}

function psiResponse(url) {
  const host = new URL(url).hostname;
  const lh = (p, a, b, s, extra = {}) => ({
    finalDisplayedUrl: url,
    categories: { performance: { score: p }, accessibility: { score: a }, 'best-practices': { score: b }, seo: { score: s } },
    audits: Object.assign({ 'final-screenshot': { details: { data: 'data:image/png;base64,' + PNG.toString('base64') } } }, extra),
  });
  if (host.startsWith('dead-domain')) return { status: 500, json: { error: { code: 500, message: 'Lighthouse returned error: DNS_FAILURE. DNS servers could not resolve the provided domain.', errors: [{ domain: 'lighthouse', reason: 'lighthouseUserError' }] } } };
  if (host.startsWith('parked')) return { status: 200, json: { lighthouseResult: Object.assign(lh(0.9, 0.9, 0.9, 0.9), { finalDisplayedUrl: 'https://www.sedoparking.com/x' }) } };
  if (host.startsWith('old-diner')) return { status: 200, json: { lighthouseResult: lh(0.18, 0.62, 0.55, 0.7, { viewport: { score: 0 }, 'is-on-https': { score: 0 }, 'largest-contentful-paint': { numericValue: 9800 } }) } };
  return { status: 200, json: { lighthouseResult: lh(0.82, 0.95, 1, 0.98, { viewport: { score: 1 } }) } };
}

const OSM = { elements: [
  { type: 'node', id: 1, lat: 40.7225, lon: -73.9880, tags: { amenity: 'restaurant', name: 'Nonna Rosa', cuisine: 'italian', 'addr:housenumber': '12', 'addr:street': 'Ludlow St' } },
  { type: 'node', id: 2, lat: 40.7230, lon: -73.9870, tags: { amenity: 'cafe', name: 'Little Cup', 'contact:facebook': 'https://facebook.com/littlecup' } },
  { type: 'way', id: 3, center: { lat: 40.7218, lon: -73.9890 }, tags: { amenity: 'restaurant', name: 'Taco Spot', website: 'https://tacospot.example' } },
  { type: 'node', id: 4, lat: 40.7221, lon: -73.9885, tags: { amenity: 'fast_food', name: 'BigChain', brand: 'BigChain' } },
] };

async function main() {
  const server = http.createServer((req, res) => {
    const f = path.join(ROOT, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  const exe = ['/opt/pw-browsers/chromium/chrome-linux/chrome', process.env.CHROMIUM].find(p => p && fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, acceptDownloads: true, timezoneId: 'America/New_York' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });

  let psiCalls = 0, detailCalls = 0, psiDisabled = false, psiBadCategories = false;
  await ctx.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (u.origin === new URL(base).origin) return route.continue();
    if (u.hostname === 'unpkg.com') {
      const file = path.join(LEAFLET, path.basename(u.pathname));
      return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.css') ? 'text/css' : 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' } });
    }
    if (u.hostname.endsWith('basemaps.cartocdn.com')) return route.fulfill({ body: PNG, contentType: 'image/png' });
    if (/fonts\.(googleapis|gstatic)\.com/.test(u.hostname)) return route.fulfill({ body: '', contentType: 'text/css' });
    if (/overpass/.test(u.hostname)) return route.fulfill({ json: OSM, headers: { 'Access-Control-Allow-Origin': '*' } });
    if (u.hostname === 'nominatim.openstreetmap.org') return route.fulfill({ json: [{ display_name: 'Testville', lat: '40.72', lon: '-73.99', boundingbox: ['40.715', '40.725', '-73.995', '-73.985'] }], headers: { 'Access-Control-Allow-Origin': '*' } });
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
    if (u.hostname === 'places.googleapis.com') {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (u.pathname.endsWith(':searchText')) return route.fulfill({ json: { places: [{ id: 'x' }] }, headers: cors });
      if (u.pathname.endsWith(':searchNearby')) { const r = nearbyResponse(JSON.parse(route.request().postData())); return route.fulfill({ status: r.status, json: r.json, headers: cors }); }
      if (u.pathname.endsWith('/media')) return route.fulfill({ body: PNG, contentType: 'image/png' });
      detailCalls++;
      const g = generated.get(decodeURIComponent(u.pathname.split('/').pop())) || {};
      return route.fulfill({ headers: cors, json: {
        rating: 4.7, userRatingCount: 321, websiteUri: g.websiteUri,
        regularOpeningHours: { weekdayDescriptions: ['Monday: 9 AM – 5 PM', 'Tuesday: 9 AM – 5 PM', 'Wednesday: 9 AM – 5 PM', 'Thursday: 9 AM – 5 PM', 'Friday: 9 AM – 9 PM', 'Saturday: 10 AM – 9 PM', 'Sunday: Closed'] },
        reviews: [{ rating: 5, relativePublishTimeDescription: '2 weeks ago', text: { text: 'Best <b>pasta</b> in town.' }, authorAttribution: { displayName: 'Sam', uri: 'https://maps.google.com/contrib/1' } }],
        photos: [{ name: 'places/abc/photos/def', authorAttributions: [{ displayName: 'Owner' }] }],
      } });
    }
    if (u.hostname === 'www.googleapis.com' && u.pathname.includes('pagespeedonline')) {
      psiCalls++;
      if (psiDisabled) return route.fulfill({ status: 403, headers: cors, json: { error: { code: 403, message: 'PageSpeed Insights API has not been used in project 1 before or it is disabled.', details: [{ reason: 'SERVICE_DISABLED' }] } } });
      await new Promise(r => setTimeout(r, 150));
      const r = psiResponse(u.searchParams.get('url'));
      if (u.searchParams.getAll('category').length !== 4) psiBadCategories = true;
      return route.fulfill({ status: r.status, json: r.json, headers: cors });
    }
    if (/google\.com$/.test(u.hostname)) return route.fulfill({ body: '<html><body style="font:14px sans-serif;background:#eee;margin:0;display:grid;place-items:center;height:100vh">Google Maps listing (mock)</body></html>', contentType: 'text/html' });
    return route.abort();
  });

  console.log('free mode (OpenStreetMap)');
  await page.goto(base);
  await page.waitForSelector('#map .leaflet-tile-pane', { state: 'attached' });
  check(await page.locator('.mode.free').isVisible(), 'starts in free mode');
  check(/Find places that need a website/.test(await page.locator('#empty').innerText()), 'shows how-it-works before the first scan');
  await page.click('#btnScan');
  await page.waitForFunction(() => document.querySelectorAll('#list .item').length > 0);
  const names = await page.locator('#list .nm').allInnerTexts();
  check(names.length === 3 && !names.includes('BigChain'), `lists 3 places and skips chains (${names.join(', ')})`);
  check((await page.locator('.leaflet-marker-icon').count()) === 3, 'draws 3 pins');
  await page.locator('#list .item', { hasText: 'Little Cup' }).click();
  check(/Social page only/.test(await page.locator('#dStatus').innerText()), 'facebook-only place is "Social page only"');
  check(/output=embed/.test(await page.locator('iframe.embed').getAttribute('src')), 'free mode embeds a Google Maps search');
  await page.click('#btnBack');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'free-mode.png') });

  console.log('Google key');
  await page.click('#btnSettings');
  await page.fill('#keyInput', 'AIzaTEST');
  await page.click('#btnKeySave');
  await page.waitForSelector('#keyStatus.ok');
  check(true, 'key test call succeeds and is saved');
  await page.selectOption('#budget', '20');
  await page.click('dialog .dlg-head button');
  check(await page.locator('.mode:not(.free)').isVisible(), 'switches to Google mode');
  check((await page.locator('#list .item').count()) === 0, 'OpenStreetMap places are hidden in Google mode');

  console.log('Google scan');
  await page.selectOption('#minReviews', '0');
  await page.locator('#minRating').fill('3.5');
  await page.click('#btnScan');
  await page.waitForSelector('#progress', { state: 'visible' });
  await page.waitForSelector('#progress', { state: 'hidden', timeout: 30000 });
  check(nearbyCalls.length > 1, `busy area was split into smaller searches (${nearbyCalls.length} requests incl. 1 retry)`);
  const billed = nearbyCalls.filter(b => !b.includedTypes.includes('juice_shop')).length;
  check(billed <= 20, `stays within the 20-search budget (${billed})`);
  check(nearbyCalls[0].includedTypes.includes('juice_shop') && nearbyCalls.slice(1).every(b => !b.includedTypes.includes('juice_shop')), 'drops an unsupported place type and retries');
  check(nearbyCalls.every(b => b.rankPreference === 'POPULARITY' && b.maxResultCount === 20), 'searches by popularity, 20 at a time');
  const statuses = await page.evaluate(() => [...document.querySelectorAll('#statusChips .chip')].map(c => c.dataset.st + ':' + c.querySelector('b').textContent));
  console.log('     chips', statuses.join(' '));
  const n = st => +statuses.find(s => s.startsWith(st + ':')).split(':')[1];
  check(n('none') > 0 && n('social') > 0 && n('platform') > 0, 'finds no-website, social-only and platform-page places');

  await page.waitForFunction(() => document.getElementById('checkBadge').hidden, null, { timeout: 60000 });
  const after = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#statusChips .chip')].map(c => [c.dataset.st, +c.querySelector('b').textContent])));
  console.log('     after checks', JSON.stringify(after));
  check(psiCalls > 0 && !psiBadCategories, `ran ${psiCalls} website checks, each for all four Lighthouse categories`);
  check(after.unchecked === 0, 'every own website got checked');
  check(after.poor > 0 && after.good > 0 && after.broken > 0, 'checks sort sites into poor, decent and broken');
  check(!(await page.locator('.pinwrap .pin').evaluateAll(els => els.some(e => getComputedStyle(e).getPropertyValue('--c').includes('good')))), 'decent websites are hidden by default');

  console.log('place panel');
  await page.locator('#list .item', { hasText: 'Poor site' }).first().click();
  await page.waitForSelector('#dExtra .reviews');
  const panel = await page.locator('#detailView').innerText();
  check(/Not made for phones/.test(panel) && /Not secure/.test(panel), 'explains why the website is poor');
  check(detailCalls === 1, 'loads the detailed listing once');
  check(/\/maps\/embed\/v1\/place\?key=AIzaTEST&q=place_id%3A|\/maps\/embed\/v1\/place\?key=AIzaTEST&q=place_id:/.test(await page.locator('iframe.embed').getAttribute('src')), 'embeds the official Google listing by place ID');
  check(await page.locator('.review p').evaluate(e => e.innerHTML.includes('&lt;b&gt;')), 'review text is escaped');
  check(/Friday: 9 AM/.test(panel), 'shows opening hours');
  await page.locator('[data-lead="saved"]').click();
  await page.fill('#leadNote', 'Call after lunch');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'google-detail.png') });
  await page.click('#btnBack');
  check(/★ Saved/.test(await page.locator('#list').innerText()), 'saved lead is marked in the list');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'google-list.png') });

  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnCsv')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  check(csv.startsWith('﻿Name,Website status,') && /Call after lunch/.test(csv), 'CSV export has the listed places and notes');

  console.log('reload keeps everything');
  await page.reload();
  await page.waitForSelector('#list .item');
  check((await page.locator('#list .item').count()) > 5 && /★ Saved/.test(await page.locator('#list').innerText()), 'places and leads survive a reload');

  console.log('PageSpeed API turned off');
  psiDisabled = true;
  await page.evaluate(() => { localStorage.removeItem('siteless.v1.places'); });
  await page.reload();
  await page.click('#btnScan');
  await page.waitForSelector('.alert', { timeout: 30000 });
  check(/PageSpeed Insights API/.test(await page.locator('#modeBox .alert').innerText()), 'tells you to turn on the PageSpeed Insights API');

  console.log('phone and dark mode');
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', isMobile: true, hasTouch: true });
  const p2 = await phone.newPage();
  await phone.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (u.origin === new URL(base).origin) return route.continue();
    if (u.hostname === 'unpkg.com') return route.fulfill({ body: fs.readFileSync(path.join(LEAFLET, path.basename(u.pathname))), contentType: u.pathname.endsWith('.css') ? 'text/css' : 'application/javascript' });
    if (u.hostname.endsWith('basemaps.cartocdn.com')) return route.fulfill({ body: PNG, contentType: 'image/png' });
    if (/overpass/.test(u.hostname)) return route.fulfill({ json: OSM, headers: { 'Access-Control-Allow-Origin': '*' } });
    return route.abort();
  });
  await p2.goto(base);
  await p2.click('#btnScan');
  await p2.waitForSelector('#list .item');
  const overflow = await p2.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check(!overflow, 'no sideways scrolling on a phone');
  check(await p2.evaluate(() => getComputedStyle(document.body).backgroundColor) === 'rgb(11, 16, 23)', 'dark theme applies');
  if (SHOTS) await p2.screenshot({ path: path.join(SHOTS, 'phone-dark.png') });
  await p2.locator('#list .item').first().click();
  if (SHOTS) await p2.screenshot({ path: path.join(SHOTS, 'phone-detail.png') });

  check(errors.length === 0, 'no script errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
