// Renders the Siteless app icons from the logo with headless Chromium.
//   npm i playwright && node siteless/tools/make-icons.js
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const OUT = path.resolve(__dirname, '..', 'icons');
const LOGO = `
  <path d="M17 2.5c-6.1 0-11 4.8-11 10.8 0 7.6 9.3 16.6 10.3 17.6.4.4 1 .4 1.4 0C18.7 29.9 28 20.9 28 13.3 28 7.3 23.1 2.5 17 2.5z" fill="#d03b3b"/>
  <circle cx="17" cy="13.3" r="6" fill="none" stroke="#fff" stroke-width="1.5"/>
  <path d="M11 13.3h12M17 7.3c1.7 1.7 2.5 3.7 2.5 6s-.8 4.3-2.5 6c-1.7-1.7-2.5-3.7-2.5-6s.8-4.3 2.5-6z" fill="none" stroke="#fff" stroke-width="1.2"/>
  <path d="M11.6 19 22.4 7.6" stroke="#d03b3b" stroke-width="3.6" stroke-linecap="round"/>
  <path d="M11.6 19 22.4 7.6" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>`;
// rounded icon for browsers and iOS, full-bleed one with a smaller logo for Android's masks
const svg = (radius, scale) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" rx="${radius}" fill="#141a23"/>
  <g transform="translate(256 262) scale(${scale}) translate(-17 -16.8)">${LOGO}</g></svg>`;
const ICONS = [
  ['icon-512.png', 512, svg(112, 11), true], ['icon-192.png', 192, svg(112, 11), true],
  ['apple-touch-icon.png', 180, svg(0, 11), false], ['maskable-512.png', 512, svg(0, 8.4), false],
];

(async () => {
  const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', process.env.CHROMIUM].find(p => p && fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, size, markup, transparent] of ICONS) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0;background:transparent">${markup.replace('width="512" height="512"', `width="${size}" height="${size}"`)}</body></html>`);
    await page.screenshot({ path: path.join(OUT, name), omitBackground: transparent, clip: { x: 0, y: 0, width: size, height: size } });
    console.log('wrote', name);
  }
  await browser.close();
})();
