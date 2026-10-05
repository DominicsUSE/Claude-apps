// End-to-end test for Siteless with every network call mocked (no Google key needed).
//
//   npm i playwright leaflet@1.9.4 leaflet.markercluster@1.5.3
//   node siteless/tests/app.test.js            # add --shots DIR to save screenshots
//
// Covers free mode (OpenStreetMap, tiling, keywords), saving a Google key, area scans that
// split busy areas, keyword scans with paging, the monthly limit, chains, website checks,
// clusters, the place panel, leads and follow-ups, outreach messages, routes, CSV, backups,
// keyboard shortcuts, the satellite map and the phone layout in dark mode.
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LIBS = {
  'leaflet.js': require.resolve('leaflet/dist/leaflet.js'),
  'leaflet.css': require.resolve('leaflet/dist/leaflet.css'),
  'leaflet.markercluster.js': require.resolve('leaflet.markercluster/dist/leaflet.markercluster.js'),
  'MarkerCluster.css': require.resolve('leaflet.markercluster/dist/MarkerCluster.css'),
};
const shotsArg = process.argv.indexOf('--shots');
const SHOTS = shotsArg > 0 ? process.argv[shotsArg + 1] : null;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+hc2rNAAAAABJRU5ErkJggg==', 'base64');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

let failures = 0;
const state = {};   // switches the mocks flip during the test
const results = [];
function check(cond, msg) {
  results.push([!!cond, msg]);
  if (cond) console.log('  ok  ' + msg);
  else { failures++; console.log('  FAIL ' + msg); }
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };

// deterministic pseudo-random numbers
function rng(seed) { let x = seed >>> 0 || 1; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296); }
const SITES = [
  () => '', () => 'https://www.facebook.com/somebistro', i => `https://good-bistro${i}.com/`, i => `http://old-diner${i}.com/`,
  () => 'https://joes-grill.business.site/', () => 'https://order.online/store/abc', i => `https://dead-domain${i}.com/`,
  i => `http://mamas${i}.wixsite.com/home`, i => `https://parked${i}.com/`,
];
const NAMES = ['Bistro', 'Diner', 'Café', 'Grill', 'Kitchen', 'Starbucks', 'Tavern', "Joe's Pizza - Downtown"];

const calls = { nearby: [], text: [], overpass: [], psi: 0, details: 0, sat: 0 };
const generated = new Map();   // id -> place, so the details mock can echo it
const nameOf = new Map();      // id -> a unique, stable name
function makePlace(id, i, lat, lng, r) {
  const k = Math.floor(r() * SITES.length);
  if (!nameOf.has(id)) nameOf.set(id, `Place ${nameOf.size + 1} ${NAMES[i % NAMES.length]}`);
  const name = NAMES[i % NAMES.length].includes(' ') || NAMES[i % NAMES.length] === 'Starbucks' ? NAMES[i % NAMES.length] : nameOf.get(id);
  const p = {
    id, displayName: { text: name }, location: { latitude: lat, longitude: lng },
    shortFormattedAddress: `${10 + i} Market St`, formattedAddress: `${10 + i} Market St, Testville, TS 12345, USA`,
    rating: Math.round((3.6 + r() * 1.4) * 10) / 10, userRatingCount: Math.floor(r() * 600),
    websiteUri: SITES[k](i) ? SITES[k](i) + (state.siteSuffix ? '?v2' : '') : undefined, googleMapsUri: `https://maps.google.com/?cid=${encodeURIComponent(id)}`,
    primaryType: 'restaurant', primaryTypeDisplayName: { text: 'Restaurant' }, types: ['restaurant', 'food'],
    businessStatus: i === 3 ? 'CLOSED_PERMANENTLY' : 'OPERATIONAL', nationalPhoneNumber: `(555) 010-${String(1000 + i).slice(-4)}`,
  };
  generated.set(id, p);
  return p;
}
function nearbyResponse(body) {
  calls.nearby.push(body);
  if (body.includedTypes.includes('juice_shop')) {
    return { status: 400, json: { error: { code: 400, message: 'Unsupported types: juice_shop.', status: 'INVALID_ARGUMENT' } } };
  }
  const c = body.locationRestriction.circle;
  const n = c.radius > 450 ? 20 : Math.max(2, Math.floor(c.radius / 40));
  const r = rng(Math.round(c.center.latitude * 1e5) ^ Math.round(c.center.longitude * 1e5) ^ body.includedTypes.length);
  const places = [];
  for (let i = 0; i < n; i++) {
    const ang = r() * Math.PI * 2, d = r() * c.radius * 0.7 / 111000;
    places.push(makePlace(`N${Math.round(c.center.latitude * 1e5)}_${Math.round(c.center.longitude * 1e5)}_${body.includedTypes.length}_${i}`, i,
      c.center.latitude + d * Math.sin(ang), c.center.longitude + d * Math.cos(ang), r));
  }
  return { status: 200, json: { places } };
}
function textResponse(body) {
  calls.text.push(body);
  const { low, high } = body.locationRestriction.rectangle;
  const big = high.latitude - low.latitude > 0.006;
  const page = body.pageToken ? +body.pageToken.slice(1) : 1;
  const r = rng(Math.round(low.latitude * 1e5) ^ Math.round(low.longitude * 1e5) ^ page);
  const n = big ? 20 : 6;
  const places = [];
  for (let i = 0; i < n; i++) {
    places.push(makePlace(`T${Math.round(low.latitude * 1e5)}_${Math.round(low.longitude * 1e5)}_${page}_${i}`, i,
      low.latitude + r() * (high.latitude - low.latitude), low.longitude + r() * (high.longitude - low.longitude), r));
  }
  const json = { places };
  if (big && page < 3) json.nextPageToken = 'p' + (page + 1);
  return { status: 200, json };
}
function psiResponse(url) {
  const host = new URL(url).hostname;
  const lh = (p, a, b, s, extra = {}, more = {}) => Object.assign({
    finalDisplayedUrl: url,
    categories: { performance: { score: p }, accessibility: { score: a }, 'best-practices': { score: b }, seo: { score: s } },
    audits: Object.assign({ 'final-screenshot': { details: { data: 'data:image/png;base64,' + PNG.toString('base64') } } }, extra),
  }, more);
  if (host.startsWith('dead-domain')) return { status: 500, json: { error: { code: 500, message: 'Lighthouse returned error: DNS_FAILURE. DNS servers could not resolve the provided domain.', errors: [{ domain: 'lighthouse', reason: 'lighthouseUserError' }] } } };
  if (host.startsWith('parked')) return { status: 200, json: { lighthouseResult: lh(0.9, 0.9, 0.9, 0.9, {}, { finalDisplayedUrl: 'https://www.sedoparking.com/x' }) } };
  if (host.startsWith('old-diner')) {
    return { status: 200, json: { lighthouseResult: lh(0.18, 0.62, 0.55, 0.7, {
      viewport: { score: 0 }, 'is-on-https': { score: 0 }, 'largest-contentful-paint': { numericValue: 9800 },
      'js-libraries': { details: { items: [{ name: 'jQuery', version: '1.12.4' }] } },
    }, { stackPacks: [{ id: 'wordpress', title: 'WordPress' }] }) } };
  }
  return { status: 200, json: { lighthouseResult: lh(0.82, 0.95, 1, 0.98, { viewport: { score: 1 } }) } };
}
const OSM = { elements: [
  { type: 'node', id: 1, lat: 40.7225, lon: -73.9880, tags: { amenity: 'restaurant', name: 'Nonna Rosa', cuisine: 'italian', 'addr:housenumber': '12', 'addr:street': 'Ludlow St', 'addr:city': 'New York' } },
  { type: 'node', id: 2, lat: 40.7230, lon: -73.9870, tags: { amenity: 'cafe', name: 'Little Cup', 'contact:facebook': 'https://facebook.com/littlecup' } },
  { type: 'way', id: 3, center: { lat: 40.7218, lon: -73.9890 }, tags: { amenity: 'restaurant', name: 'Taco Spot', website: 'https://tacospot.example' } },
  { type: 'node', id: 4, lat: 40.7221, lon: -73.9885, tags: { amenity: 'fast_food', name: 'BigChain', brand: 'BigChain' } },
] };

function mockRoutes(ctx, base, state) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
  return ctx.route('**/*', async route => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.origin === new URL(base).origin) return route.continue();
    if (u.hostname === 'unpkg.com') {
      const file = LIBS[path.basename(u.pathname)];
      return file ? route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.css') ? 'text/css' : 'application/javascript', headers: cors }) : route.abort();
    }
    if (u.hostname.endsWith('basemaps.cartocdn.com')) return route.fulfill({ body: PNG, contentType: 'image/png' });
    if (u.hostname === 'server.arcgisonline.com') { calls.sat++; return route.fulfill({ body: PNG, contentType: 'image/png' }); }
    if (/fonts\.(googleapis|gstatic)\.com/.test(u.hostname)) return route.fulfill({ body: '', contentType: 'text/css' });
    if (u.pathname.endsWith('/api/interpreter')) {
      calls.overpass.push(decodeURIComponent((req.postData() || '').replace(/^data=/, '')));
      calls.overpassHosts = (calls.overpassHosts || []).concat(u.hostname);
      if (state.overpassFailAfter != null && calls.overpass.length > state.overpassFailAfter) return route.fulfill({ status: 504, body: 'busy', headers: cors });
      // a server that never answers (the page gives up on it and asks another one)
      if (state.overpassHang && u.hostname === state.overpassHang) return new Promise(r => setTimeout(r, 20000)).then(() => route.abort()).catch(() => {});
      if (state.overpassRemark) return route.fulfill({ json: { elements: [], remark: 'runtime error: Query timed out in "query" at line 1 after 31 seconds.' }, headers: cors });
      return route.fulfill({ json: OSM, headers: cors });
    }
    if (u.hostname === 'nominatim.openstreetmap.org') {
      const q = u.searchParams.get('q') || '';
      if (/slowtown/i.test(q)) { await new Promise(r => setTimeout(r, 900)); return route.fulfill({ json: [{ display_name: 'Slowtown', lat: '10', lon: '10' }], headers: cors }); }
      if (/fasttown/i.test(q)) return route.fulfill({ json: [{ display_name: 'Fasttown', lat: '20', lon: '20' }], headers: cors });
      return route.fulfill({ json: [{ display_name: 'Testville', lat: '40.72', lon: '-73.99', boundingbox: ['40.715', '40.725', '-73.995', '-73.985'] }], headers: cors });
    }
    if (u.hostname === 'lh3.googleusercontent.com') {
      if (state.photoFailOnce) { state.photoFailOnce = false; return route.fulfill({ status: 404, body: 'expired' }); }
      return route.fulfill({ body: PNG, contentType: 'image/png' });
    }
    if (u.hostname === 'places.googleapis.com') {
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (u.pathname.endsWith(':searchText')) {
        const body = JSON.parse(req.postData());
        if (req.headers()['x-goog-fieldmask'] === 'places.id') return route.fulfill({ json: { places: [{ id: 'x' }] }, headers: cors });
        const r = textResponse(Object.assign(body, { mask: req.headers()['x-goog-fieldmask'] }));
        return route.fulfill({ status: r.status, json: r.json, headers: cors });
      }
      if (u.pathname.endsWith(':searchNearby')) { const r = nearbyResponse(JSON.parse(req.postData())); return route.fulfill({ status: r.status, json: r.json, headers: cors }); }
      if (u.pathname.endsWith('/media')) {
        calls.photo = (calls.photo || 0) + 1;
        const n = calls.photo;
        if (u.searchParams.get('key') || !req.headers()['x-goog-api-key'] || u.searchParams.get('skipHttpRedirect') !== 'true') state.photoKeyInUrl = true;
        if (state.photoDelay) await new Promise(r => setTimeout(r, state.photoDelay));
        return route.fulfill({ json: { name: u.pathname.slice(4), photoUri: `https://lh3.googleusercontent.com/places/test-${n}=w800` }, headers: cors });
      }
      calls.details++;
      const g = generated.get(decodeURIComponent(u.pathname.split('/').pop())) || {};
      return route.fulfill({ headers: cors, json: {
        rating: g.rating, userRatingCount: g.userRatingCount, websiteUri: g.websiteUri, formattedAddress: g.formattedAddress,
        regularOpeningHours: { weekdayDescriptions: ['Monday: 9 AM – 5 PM', 'Tuesday: 9 AM – 5 PM', 'Wednesday: 9 AM – 5 PM', 'Thursday: 9 AM – 5 PM', 'Friday: 9 AM – 9 PM', 'Saturday: 10 AM – 9 PM', 'Sunday: Closed'] },
        reviews: [{ rating: 5, relativePublishTimeDescription: '2 weeks ago', text: { text: 'Best <b>pasta</b> in town.' }, authorAttribution: { displayName: 'Sam', uri: 'https://maps.google.com/contrib/1' } }],
        photos: [{ name: `places/${(g.id || 'x').replace(/[^\w-]/g, '')}/photos/p1`, authorAttributions: [{ displayName: 'Owner' }] }],
      } });
    }
    if (u.hostname === 'www.googleapis.com' && u.pathname.includes('pagespeedonline')) {
      calls.psi++;
      if (state.psiDisabled) return route.fulfill({ status: 403, headers: cors, json: { error: { code: 403, message: 'PageSpeed Insights API has not been used in project 1 before or it is disabled.', details: [{ reason: 'SERVICE_DISABLED' }] } } });
      if (u.searchParams.getAll('category').join() !== 'PERFORMANCE,ACCESSIBILITY,BEST_PRACTICES,SEO') state.badCategories = true;
      if (state.psiSlowFail && !/v2/.test(u.searchParams.get('url'))) { await new Promise(r => setTimeout(r, 1500)); return route.abort('failed'); }
      await new Promise(r => setTimeout(r, state.psiDelay || 15));
      const r = psiResponse(u.searchParams.get('url'));
      return route.fulfill({ status: r.status, json: r.json, headers: cors });
    }
    if (/google\.com$/.test(u.hostname)) return route.fulfill({ body: '<html><body style="font:14px sans-serif;background:#e8eaed;margin:0;display:grid;place-items:center;height:100vh">Google Maps listing (mock)</body></html>', contentType: 'text/html' });
    return route.abort();
  });
}

async function main() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const f = path.join(ROOT, rel === '/' ? 'index.html' : rel);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', process.env.CHROMIUM].find(p => p && fs.existsSync(p));
  // CHANNEL=msedge or CHANNEL=chrome tests in the installed Edge or Chrome (e.g. on Windows)
  const browser = await chromium.launch(process.env.CHANNEL ? { channel: process.env.CHANNEL } : exe ? { executablePath: exe } : {});
  console.log(`browser: ${process.env.CHANNEL || 'chromium'} ${browser.version()}`);
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, acceptDownloads: true, timezoneId: 'America/New_York', serviceWorkers: 'block' });
  await mockRoutes(ctx, base, state);
  const page = await ctx.newPage();
  const stateOf = () => page.evaluate(() => {
    const { S } = window.__siteless;
    const ps = [...S.places.values()].filter(p => p.src === 'google' && window.__siteless.passes(p, true));
    return { checked: ps.filter(p => p.check).length, unchecked: ps.filter(p => p.status === 'unchecked').length };
  });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED/.test(m.text())) errors.push(m.text()); });
  const settle = (pg = page) => pg.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const scanDone = async (pg = page) => {
    await pg.waitForFunction(() => document.getElementById('progress').hidden && !document.getElementById('btnScan').hidden, null, { timeout: 60000 });
    await settle(pg);
  };
  const listNames = async () => { await settle(); return page.locator('#list .nm').allInnerTexts(); };
  const chipCounts = async () => { await settle(); return page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#statusChips .chip')].map(c => [c.dataset.st, +c.querySelector('b').textContent]))); };
  // set the zoom and wait until it sticks (an animated pan to a place may still be finishing)
  const setZoom = async (z, pg = page) => {
    for (let i = 0; i < 6; i++) {
      await pg.evaluate(z => { const m = window.__siteless.map; m.stop(); if (m.getZoom() !== z) m.setZoom(z, { animate: false }); }, z);
      await pg.waitForTimeout(350);
      if (await pg.evaluate(() => window.__siteless.map.getZoom()) === z) break;
    }
    await settle(pg);
  };

  console.log('free mode (OpenStreetMap)');
  await page.goto(base + '?debug');
  await page.waitForSelector('#map .leaflet-tile-pane', { state: 'attached' });
  await setZoom(15);
  check(await page.locator('.mode.free').isVisible(), 'starts in free mode');
  check((await page.locator('#cats .chip[aria-pressed="true"]').count()) === 13, 'every type of place is selected by default');
  check((await page.locator('#empty .legend .gdot').count()) === 6, 'explains the pin colours and glyphs before the first scan');
  check(await page.evaluate(() => !!document.querySelector('link[rel=manifest]')), 'is installable (web app manifest)');
  await page.click('#btnScan');
  await scanDone();
  const names = await listNames();
  check(names.length === 3 && !names.includes('BigChain'), `lists 3 places and hides chains (${names.join(', ')})`);
  await page.uncheck('#hideChains');
  check((await listNames()).includes('BigChain'), 'a place OpenStreetMap lists as a brand shows when chains are not hidden');
  await page.check('#hideChains');
  await settle();
  check(/"office"/.test(calls.overpass[0]) && /"tourism"/.test(calls.overpass[0]), 'free scan asks OpenStreetMap for every type');
  check(/\d+% of 3 places here have no real website/.test(await page.locator('#summary').innerText()), 'area summary shows the share without a real website');
  await page.locator('#list .item', { hasText: 'Little Cup' }).click();
  check(/Social page only/.test(await page.locator('#dStatus').innerText()), 'facebook-only place is "Social page only"');
  check(/output=embed/.test(await page.locator('iframe.embed').getAttribute('src')), 'free mode embeds a Google Maps search');
  check(/links to a Facebook page instead of a website/.test(await page.inputValue('#pitchText')), 'outreach email names the Facebook page correctly');
  await page.click('#btnBack');
  await shot(page, 'free-mode');

  // bigger area: split into several OpenStreetMap requests; too big: ask to zoom in
  const before = calls.overpass.length;
  await setZoom(13);
  await page.click('#btnScan');
  await scanDone();
  check(calls.overpass.length - before === 9, `a city-sized free scan is split into ${calls.overpass.length - before} OpenStreetMap requests`);
  // if a later part fails, what the earlier parts found is still saved
  await page.evaluate(() => { localStorage.removeItem('siteless.v1.places'); localStorage.removeItem('siteless.v1.areas'); });
  await page.reload();
  await page.waitForSelector('#btnScan');
  await setZoom(13);
  state.overpassFailAfter = calls.overpass.length + 1;
  await page.click('#btnScan');
  await scanDone();
  state.overpassFailAfter = null;
  await page.waitForTimeout(700);
  const savedIds = await page.evaluate(() => JSON.parse(localStorage.getItem('siteless.v1.places') || '[]').map(p => p.id));
  check(/busy/.test(await page.locator('#toast').innerText()) && savedIds.includes('o:n1'), 'keeps the places from a free scan that failed part-way');
  // the first server never answers: the page asks the next one and still finds the places
  await page.evaluate(() => { localStorage.removeItem('siteless.v1.places'); localStorage.removeItem('siteless.v1.areas'); });
  await page.reload();
  await page.waitForSelector('#btnScan');
  await setZoom(15);
  await page.evaluate(() => Object.assign(window.__siteless.OSM_T, { hedge: 600, wait: 2500 }));
  state.overpassHang = 'overpass-api.de';
  calls.overpassHosts = [];
  await page.click('#btnScan');
  await scanDone();
  check((await listNames()).length === 3 && calls.overpassHosts[0] === 'overpass-api.de' && calls.overpassHosts.length === 2,
    `a server that does not answer is skipped for the next one (${calls.overpassHosts.join(', ')})`);
  // every server silent: the scan ends with a clear message and the button comes back
  state.overpassHang = null;
  await page.route('**/api/interpreter', () => {});   // never answer
  await page.click('#btnScan');
  await scanDone();
  check(/not answering/.test(await page.locator('#toast').innerText()) && await page.locator('#btnScan').isVisible(), 'when no server answers, says so and the scan button comes back');
  await page.unroute('**/api/interpreter');
  // Stop works while waiting for a server
  await page.route('**/api/interpreter', () => {});
  await page.click('#btnScan');
  await page.waitForTimeout(300);
  await page.click('#btnStop');
  await scanDone();
  check(await page.locator('#btnScan').isVisible(), 'Stop ends a scan that is waiting for a server');
  await page.unroute('**/api/interpreter');
  // a server that ran out of time is reported as busy, not as "no places here"
  state.overpassRemark = true;
  await page.click('#btnScan');
  await scanDone();
  state.overpassRemark = false;
  check(/busy/.test(await page.locator('#toast').innerText()), 'a server that ran out of time is reported as busy');
  await page.evaluate(() => Object.assign(window.__siteless.OSM_T, { hedge: 9000, wait: 35000 }));
  await setZoom(11);
  check(/Zoom in/.test(await page.locator('#scanLabel').innerText()), 'asks to zoom in when the free scan area is too big');
  await setZoom(15);

  await page.fill('#kw', 'taco');
  await page.press('#kw', 'Enter');
  check(/Scan for “taco”/.test(await page.locator('#scanLabel').innerText()), 'keyword changes the scan button');
  await page.click('#btnScan');
  await scanDone();
  check(/"name"~"taco",i/.test(calls.overpass[calls.overpass.length - 1]), 'free keyword scan searches names');
  await page.click('#btnKwClear');

  console.log('Google key');
  await page.click('#btnSettings');
  await page.fill('#keyInput', 'AIzaTEST');
  await page.click('#btnKeySave');
  await page.waitForSelector('#keyStatus.ok');
  check(true, 'key test call succeeds and is saved');
  check(await page.locator('#depthRadios input[value="max"]').isChecked(), 'scans at Maximum coverage by default');
  await page.fill('#meName', 'Dana');
  await page.fill('#meBiz', 'Corner Web Co');
  await page.click('dialog .dlg-head button');
  check(await page.locator('.mode:not(.free)').isVisible(), 'switches to Google mode');
  check((await page.locator('#list .item').count()) === 0, 'OpenStreetMap places are hidden in Google mode');
  check(/Maximum · 1,000 free left/.test(await page.locator('#scanHint').innerText()), 'scan button shows coverage and free searches left');

  console.log('Google area scan at Maximum');
  await page.selectOption('#minReviews', '0');
  await page.locator('#minRating').fill('3.5');
  await setZoom(17);
  await page.click('#btnScan');
  await scanDone();
  const okCalls = calls.nearby.filter(b => !b.includedTypes.includes('juice_shop'));
  const full = okCalls.filter(b => b.locationRestriction.circle.radius > 450).length;
  const leaves = okCalls.length - full;
  check(full === 2 && leaves === 8, `Maximum keeps splitting until every square is complete (${okCalls.length} searches, ${leaves} complete squares)`);
  check(calls.nearby.every(b => b.includedTypes.length <= 50), 'never sends more than 50 types in one search');
  check(calls.nearby.filter(b => b.includedTypes.includes('juice_shop')).length === 1 && okCalls.every(b => !b.includedTypes.includes('juice_shop')), 'drops an unsupported place type and retries');
  check(calls.nearby.every(b => b.rankPreference === 'POPULARITY' && b.maxResultCount === 20), 'searches by popularity, 20 at a time');
  // scan the same area again while its website checks are still running
  state.psiDelay = 400;
  await page.click('#btnScan');
  await scanDone();
  state.psiDelay = 15;
  await page.waitForFunction(() => document.getElementById('checkBadge').hidden, null, { timeout: 90000 });
  let st = await stateOf();
  check(st.unchecked === 0 && st.checked === calls.psi, `a rescan during website checks loses none and repeats none (${calls.psi} checks for ${st.checked} sites)`);

  console.log('Quick scan and the monthly limit');
  await setZoom(15);
  await page.click('#btnSettings');
  await page.check('#depthRadios input[value="quick"]');
  await page.click('dialog .dlg-head button');
  let n0 = calls.nearby.length;
  await page.click('#btnScan');
  await scanDone();
  check(calls.nearby.length - n0 === 15 && calls.nearby.slice(n0).every(b => !b.includedTypes.includes('juice_shop')), `Quick stays within 15 searches and remembers the unsupported type (${calls.nearby.length - n0})`);
  check(/choose Maximum/.test(await page.locator('#toast').innerText()), 'suggests Maximum when a busy area was cut short');
  const usedNow = await page.evaluate(() => JSON.parse(localStorage.getItem('siteless.v1.usage')).nearby);
  await page.click('#btnSettings');
  await page.check('#depthRadios input[value="thorough"]');
  await page.fill('#monthlyCap', String(Math.ceil((usedNow + 5) / 50) * 50));
  await page.press('#monthlyCap', 'Tab');
  await page.click('dialog .dlg-head button');
  const capVal = Math.max(50, Math.ceil((usedNow + 5) / 50) * 50);
  n0 = calls.nearby.length;
  await setZoom(14);
  await page.click('#btnScan');
  await scanDone();
  const afterCap = await page.evaluate(() => JSON.parse(localStorage.getItem('siteless.v1.usage')).nearby);
  check(afterCap <= capVal, `stops at the monthly limit (${afterCap} of ${capVal})`);
  check(/monthly limit/i.test(await page.locator('#toast').innerText()) && /Monthly limit reached/.test(await page.locator('#scanLabel').innerText()), 'says the monthly limit was reached');
  await page.click('#btnSettings');
  await page.uncheck('#capOn');
  await page.click('dialog .dlg-head button');
  check(await page.waitForFunction(() => !document.getElementById('btnScan').disabled, null, { timeout: 5000 }).then(() => true, () => false), 'turning the limit off allows scanning again');

  console.log('chains, website checks and clusters');
  await page.waitForFunction(() => document.getElementById('checkBadge').hidden, null, { timeout: 90000 });
  check(!(await listNames()).some(n => /Starbucks|Joe's Pizza/.test(n)), 'hides chains (a known chain and a name seen 3+ times)');
  await page.uncheck('#hideChains');
  await page.fill('#nameFilter', 'starbucks');
  await page.waitForTimeout(300);
  check((await listNames()).length > 0 && (await listNames()).every(n => /Starbucks/.test(n)), 'shows chains when asked, and the list filters by name');
  await page.fill('#nameFilter', '');
  await page.waitForTimeout(300);
  await page.check('#hideChains');
  const after = await chipCounts();
  console.log('     chips', JSON.stringify(after));
  check(calls.psi > 0 && !state.badCategories, `ran ${calls.psi} website checks, each for all four Lighthouse categories`);
  check(after.unchecked === 0, 'every own website got checked');
  check(after.poor > 0 && after.good > 0 && after.broken > 0 && after.none > 0 && after.social > 0 && after.platform > 0, 'sorts places into all website types');
  check((await page.locator('.sum-bar span').count()) >= 5, 'summary bar has a segment per website type');
  await page.locator('.sum-bar span').first().hover();
  check(/No website: \d+ \(\d+%\)/.test(await page.locator('#tip').innerText()), 'summary bar segments explain themselves on hover');
  check((await page.locator('.cl').count()) > 0, 'groups overlapping pins into clusters');
  check((await page.locator('.pin .g').count()) > 0, 'every pin carries a glyph as well as a colour');
  await shot(page, 'google-list');

  console.log('website changes while its check is running');
  {
    const home = await page.evaluate(() => { const c = window.__siteless.map.getCenter(); return [c.lat, c.lng, window.__siteless.map.getZoom()]; });
    await page.evaluate(() => window.__siteless.map.setView([40.80, -73.95], 17, { animate: false }));
    await settle();
    state.psiSlowFail = true;
    await page.click('#btnScan');
    await scanDone();
    state.siteSuffix = true;
    await page.click('#btnScan');
    await scanDone();
    await page.waitForTimeout(1800);
    await page.waitForFunction(() => document.getElementById('checkBadge').hidden, null, { timeout: 90000 });
    state.psiSlowFail = false;
    state.siteSuffix = false;
    const area = await page.evaluate(() => {
      const { S, map, passes } = window.__siteless;
      const b = map.getBounds();
      const ps = [...S.places.values()].filter(p => p.src === 'google' && b.contains([p.lat, p.lng]) && passes(p, true));
      return { places: ps.length, newSites: ps.filter(p => /v2/.test(p.website || '')).length, errors: ps.filter(p => p.check && p.check.error).length, unchecked: ps.filter(p => p.status === 'unchecked').length };
    });
    check(area.newSites > 0 && area.errors === 0 && area.unchecked === 0, `a failed check of an old website never lands on its new one (${JSON.stringify(area)})`);
    await page.evaluate(h => window.__siteless.map.setView([h[0], h[1]], h[2], { animate: false }), home);
    await settle();
  }

  console.log('place panel');
  await setZoom(16);
  await page.locator('#list .item', { hasText: 'Poor site' }).first().click();
  await page.waitForSelector('#dExtra .reviews');
  let panel = await page.locator('#detailView').innerText();
  check(/Not made for phones/.test(panel) && /Not secure/.test(panel), 'explains why the website is poor');
  check(/old jQuery version \(1\.12\.4\)/.test(panel) && /Built with WordPress/.test(panel), 'shows what the site is built with and old libraries');
  check(/\/maps\/embed\/v1\/place\?key=AIzaTEST&q=place_id(%3A|:)/.test(await page.locator('iframe.embed').getAttribute('src')), 'embeds the official Google listing by place ID');
  check(await page.locator('.review p').evaluate(e => e.innerHTML.includes('&lt;b&gt;')), 'review text is escaped');
  check(/Friday: 9 AM/.test(panel), 'shows opening hours');
  await page.waitForSelector('#dPhoto img');
  const photoSrc = await page.getAttribute('#dPhoto img', 'src');
  check(photoSrc.startsWith('https://lh3.googleusercontent.com/') && !/key=/.test(photoSrc) && !state.photoKeyInUrl, 'the photo address never contains the API key');
  const email = await page.inputValue('#pitchText');
  check(/^Subject: A website for /.test(email) && /PageSpeed test and it scored \d+ out of 100/.test(email) && /I'm Dana from Corner Web Co/.test(email) && /in Testville/.test(email),
    'writes a tailored email with the score, your details and the town');
  check(/^mailto:\?subject=/.test(await page.getAttribute('#lnkMail', 'href')), 'offers to open the email in your mail app');
  await page.click('[data-pitch="call"]');
  check(/^OPENING:/.test(await page.inputValue('#pitchText')) && await page.locator('#lnkMail').isHidden(), 'has a call script');
  await page.click('[data-pitch="dm"]');
  check((await page.inputValue('#pitchText')).length < 400, 'has a short text message');
  await page.click('[data-pitch="email"]');

  const firstName = await page.locator('.d-head h2').innerText();
  {
    // with no saved leads yet, Route goes through the top 10 places in the list
    await page.click('#btnBack');
    const [pop] = await Promise.all([ctx.waitForEvent('page'), page.click('#btnRoute')]);
    await pop.waitForURL(/^https:\/\/www\.google\.com\/maps\/dir\//, { timeout: 15000 });
    const u = new URL(pop.url());
    const stops = (u.searchParams.get('waypoints') || '').split('|').filter(Boolean).length + 1;
    check(stops === 10 && u.searchParams.get('waypoint_place_ids').split('|').length === 9, `route goes through the top 10 places with their Google place IDs (${stops} stops)`);
    await pop.close();
    // places at the end of the list have not been opened yet, so their photos are not cached
    const others = (await listNames()).filter(n => n !== firstName).slice(-2);
    // reopening a place while its photo is still loading shares the one request
    let before = calls.photo;
    state.photoDelay = 800;
    await page.locator('#list .item', { hasText: others[0] }).first().click();
    for (let i = 0; i < 50 && calls.photo === before; i++) await page.waitForTimeout(50);   // the photo request has started
    await page.click('#btnBack');
    await page.locator('#list .item', { hasText: others[0] }).first().click();
    await page.waitForSelector('#dPhoto img', { timeout: 10000 });
    state.photoDelay = 0;
    check(calls.photo - before === 1, `reopening a place while its photo loads asks Google once (${calls.photo - before} requests)`);
    // an image address that no longer works is fetched again, once
    await page.click('#btnBack');
    before = calls.photo;
    state.photoFailOnce = true;
    await page.locator('#list .item', { hasText: others[1] }).first().click();
    for (let i = 0; i < 40 && calls.photo - before < 2; i++) await page.waitForTimeout(100);
    await page.waitForTimeout(300);
    check(calls.photo - before === 2 && await page.locator('#dPhoto img').isVisible(), 'an expired photo address is replaced with a fresh one');
    await page.click('#btnBack');
    before = calls.photo;
    await page.locator('#list .item', { hasText: firstName }).first().click();
    await page.waitForSelector('#dPhoto img');
    check(calls.photo === before && await page.evaluate(() => JSON.parse(localStorage.getItem('siteless.v1.usage')).photos) === calls.photo,
      `reopening a place does not fetch or count its photo again (${calls.photo} photo requests in total)`);
  }
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await settle();
  const pos0 = +(await page.locator('#dPos').innerText()).split(' ')[0];
  await page.keyboard.press('j');
  await settle();
  const pos1 = +(await page.locator('#dPos').innerText()).split(' ')[0];
  check(pos1 === pos0 + 1 && (await page.locator('.d-head h2').innerText()) !== firstName, `J moves to the next place (${pos0} → ${pos1})`);
  await page.keyboard.press('k');
  await settle();
  check((await page.locator('.d-head h2').innerText()) === firstName, 'K moves back');
  await page.keyboard.press('2');
  check(await page.locator('[data-lead="saved"]').getAttribute('aria-pressed') === 'true', 'number keys set the lead status');
  await page.click('[data-due="1"]');
  check(await page.inputValue('#leadDue') !== '', 'sets a follow-up date');
  check(await page.locator('#btnDue').isHidden(), 'a follow-up for tomorrow is not due yet');
  await page.fill('#leadNote', 'Call after lunch');
  const todayStr = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
  await page.fill('#leadDue', todayStr);
  await page.dispatchEvent('#leadDue', 'change');
  await shot(page, 'google-detail');
  await page.click('#btnBack');
  await settle();
  check(/1 follow-up due/.test(await page.locator('#btnDue').innerText()), 'shows how many follow-ups are due');
  await page.click('#btnDue');
  await settle();
  check((await page.locator('#list .item').count()) === 1 && /Follow up today/.test(await page.locator('#list').innerText()), 'lists the follow-ups that are due');
  await page.selectOption('#leadFilter', 'all');

  const [popup] = await Promise.all([ctx.waitForEvent('page'), page.click('#btnRoute')]);
  const routeUrl = new URL(popup.url());
  check(routeUrl.pathname === '/maps/dir/' && routeUrl.searchParams.get('destination') && !routeUrl.searchParams.get('waypoints'), 'once you have saved leads, Route visits just those');
  await popup.close();

  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnCsv')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  check(csv.startsWith('﻿Name,Website status,') && /Call after lunch/.test(csv) && csv.includes(todayStr), 'CSV export has places, follow-up dates and notes');

  console.log('keyword scan with Google');
  await page.fill('#kw', 'tattoo');
  await page.press('#kw', 'Enter');
  const t0 = calls.text.length;
  await page.click('#btnScan');
  await scanDone();
  const texts = calls.text.slice(t0);
  check(texts.length > 0 && texts.every(b => b.textQuery === 'tattoo' && b.locationRestriction.rectangle && /nextPageToken/.test(b.mask)), `keyword scan uses Text Search inside the map area (${texts.length} requests)`);
  check(texts.some(b => b.pageToken === 'p2') && texts.some(b => b.pageToken === 'p3'), 'pages through up to 60 results per square');
  const small = texts.filter(b => b.locationRestriction.rectangle.high.latitude - b.locationRestriction.rectangle.low.latitude <= 0.006);
  check(small.length > 0, 'splits a square that still had more results');
  check((await page.locator('#list .item').count()) > 0, 'keyword finds are listed whatever types are selected');
  await page.click('#btnKwClear');

  console.log('backup, clear and restore');
  await page.click('#btnSettings');
  const [bk] = await Promise.all([page.waitForEvent('download'), page.click('#btnBackup')]);
  const backupFile = await bk.path();
  const backup = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
  check(backup.app === 'siteless' && backup.places.length > 10 && !('key' in backup.settings), `backup holds ${backup.places.length} places and no API key`);
  await page.click('#btnClear');
  await page.click('#btnClear');
  check(/kept/.test(await page.locator('#clearStatus').innerText()), 'clearing keeps marked leads');
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('siteless.v1.places') || '[]').length);
  const leadId = await page.evaluate(() => { const { S } = window.__siteless; return Object.keys(S.leads).find(id => S.leads[id].s === 'saved' && S.places.has(id)); });
  await page.evaluate(id => { const p = window.__siteless.S.places.get(id); p.check = undefined; p.seen = 1; }, leadId);
  await page.fill('#meName', 'Somebody else');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#btnRestore')]);
  await chooser.setFiles(backupFile);
  await page.waitForSelector('#clearStatus.ok');
  check(await page.inputValue('#meName') === 'Dana', 'restoring a backup brings back your settings');
  check(await page.evaluate(id => { const p = window.__siteless.S.places.get(id); return !!(p.check && p.check.score != null) && p.status !== 'unchecked'; }, leadId),
    'restoring takes the newer website check from the backup');
  check(/Restored: [\d,]+ new places/.test(await page.locator('#clearStatus').innerText()), `restores the backup (had ${kept} kept places)`);
  {
    // a hand-made backup with a javascript: link and junk fields
    const evil = backup.places.find(p => p.src === 'google');
    const bad = { app: 'siteless', version: 2, places: [Object.assign({}, evil, { id: 'g:EVIL', name: 'Evil Diner', maps: 'javascript:alert(document.domain)', types: 'oops', seen: Date.now() + 1 }), { id: 'x', lat: 'no' }],
      leads: { 'g:EVIL': { s: 'saved', at: Date.now() + 1 }, '__proto__': { s: 'saved' } }, areas: [[1, 2, 3, 'x', 'osm']], settings: { me: { name: 42 } } };
    const badFile = path.join(path.dirname(backupFile), 'bad-backup.json');
    fs.writeFileSync(badFile, JSON.stringify(bad));
    await page.click('#clearStatus');
    const [ch2] = await Promise.all([page.waitForEvent('filechooser'), page.click('#btnRestore')]);
    await ch2.setFiles(badFile);
    await page.waitForFunction(() => /Restored/.test(document.getElementById('clearStatus').textContent));
    await page.click('dialog .dlg-head button');
    await page.evaluate(() => { const { S, map } = window.__siteless; const p = S.places.get('g:EVIL'); map.setView([p.lat, p.lng], 17, { animate: false }); });
    await settle();
    await page.fill('#nameFilter', 'Evil Diner');
    await page.waitForTimeout(300);
    await page.locator('#list .item', { hasText: 'Evil Diner' }).first().click();
    const href = await page.getAttribute('#lnkMaps', 'href');
    check(/^https:\/\/www\.google\.com\/maps\/search\//.test(href) && await page.inputValue('#meName').catch(() => 'Dana') !== '42', `a javascript: link from a backup is replaced with a safe one (${href.slice(0, 40)}…)`);
    await page.click('#btnBack');
    await page.fill('#nameFilter', '');
    await page.evaluate(() => { const { S } = window.__siteless; delete S.leads['g:EVIL']; S.places.delete('g:EVIL'); });
  }

  console.log('satellite and reload');
  const s0 = calls.sat;
  await page.click('#btnLayer');
  await page.waitForTimeout(500);
  check(calls.sat > s0 && await page.getAttribute('#btnLayer', 'aria-pressed') === 'true', 'switches to satellite imagery');
  await page.click('#btnLayer');
  await page.reload();
  await page.waitForSelector('#list .item');
  await settle();
  const listed = await page.locator('#list .item').count();
  await page.fill('#nameFilter', firstName);
  await page.waitForTimeout(300);
  await settle();
  check(listed > 5 && /★ Saved/.test(await page.locator('#list').innerText()), 'places and leads survive a reload');
  await page.fill('#nameFilter', '');

  console.log('PageSpeed API turned off');
  state.psiDisabled = true;
  await page.evaluate(() => { localStorage.removeItem('siteless.v1.places'); });
  await page.reload();
  await page.click('#btnScan');
  await page.waitForSelector('#modeBox .alert', { timeout: 30000 });
  check(/PageSpeed Insights API/.test(await page.locator('#modeBox .alert').innerText()), 'tells you to turn on the PageSpeed Insights API');

  console.log('phone and dark mode');
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', isMobile: true, hasTouch: true, serviceWorkers: 'block', timezoneId: 'America/New_York' });
  await mockRoutes(phone, base, {});
  const p2 = await phone.newPage();
  p2.on('pageerror', e => errors.push('phone: ' + e));
  await p2.goto(base + '?debug');
  await p2.click('#btnScan');
  await scanDone(p2);
  check(!(await p2.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), 'no sideways scrolling on a phone');
  check(await p2.evaluate(() => getComputedStyle(document.body).backgroundColor) === 'rgb(11, 16, 23)', 'dark theme applies');
  await shot(p2, 'phone-dark');
  await p2.locator('#list .item').first().click();
  check(!(await p2.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), 'place panel fits a phone');
  await shot(p2, 'phone-detail');

  console.log('location search');
  await page.fill('#q', 'slowtown');
  await page.press('#q', 'Enter');
  await page.fill('#q', 'fasttown');
  await page.press('#q', 'Enter');
  await page.waitForTimeout(1300);
  const c = await page.evaluate(() => window.__siteless.map.getCenter());
  check(Math.abs(c.lat - 20) < 0.01 && Math.abs(c.lng - 20) < 0.01, 'a slow older search cannot move the map after a newer one');

  check(errors.length === 0, 'no script errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Map page in ${process.env.CHANNEL || 'Chromium'} ${browser.version()}: ${results.length - failures} of ${results.length} checks passed\n\n` +
      results.filter(r => !r[0]).map(r => `- ❌ ${r[1]}`).join('\n') + '\n');
  }
  process.exit(failures ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
