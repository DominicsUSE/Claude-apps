// Usage: node render_frames.js <page.html> <outDir> [fps] [t1,t2,...]
const { chromium } = require('playwright');
const path = require('path'); const fs = require('fs');
(async () => {
  const [page_, out, fpsArg, only] = process.argv.slice(2);
  fs.mkdirSync(out, { recursive: true });
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
  await p.goto('file://' + path.resolve(page_), { waitUntil: 'networkidle' });
  await p.evaluate(() => document.fonts.ready);
  const fps = +(fpsArg || 12);
  const dur = await p.evaluate(() => window.DURATION);
  const times = only ? only.split(',').map(Number) : [...Array(Math.round(dur * fps)).keys()].map(i => i / fps);
  let i = 0;
  for (const t of times) {
    await p.evaluate(t => window.render(t), t);
    const name = only ? `t_${t.toFixed(2)}.png` : `f_${String(i).padStart(4, '0')}.png`;
    await p.screenshot({ path: path.join(out, name) });
    i++;
    if (!only && i % 60 === 0) console.log(i, '/', times.length);
  }
  await b.close();
})();
