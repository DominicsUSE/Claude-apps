const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, 'generated');
fs.mkdirSync(OUT_DIR, { recursive: true });

// Three distance presets calibrated to real ANPR engineering guidance: commercial systems
// typically want >=15-20px character height for a workable read, 25-40px+ for a comfortable
// one. "Far away" here is deliberately near the practical floor for ANY OCR technology, not
// an arbitrarily-easy small size.
const PRESETS = {
  close: { plateHeightPx: 70, blur: 0.3, jpegQuality: 90 },
  mid: { plateHeightPx: 34, blur: 0.5, jpegQuality: 80 },
  far: { plateHeightPx: 17, blur: 0.7, jpegQuality: 65 },
};

const PLATES = [
  { country: 'UK', text: 'AB12 CDE' },
  { country: 'Germany', text: 'M AB 1234' },
  { country: 'France', text: 'AB-123-CD' },
];

const FRAME_W = 1280, FRAME_H = 720;
const ASPECT = 4.68; // UK plate ratio; close enough for this test's purpose

async function makeScene(plateText, preset, outPath) {
  const plateW = Math.round(preset.plateHeightPx * ASPECT);
  const plateH = preset.plateHeightPx;
  const px = Math.round((FRAME_W - plateW) / 2 + (Math.random() - 0.5) * 40);
  const py = Math.round((FRAME_H - plateH) / 2 + (Math.random() - 0.5) * 40);
  const carW = plateW * 3.4, carH = plateH * 3.8;
  const carX = px - (carW - plateW) / 2, carY = py - carH * 0.62;
  const fontSize = plateH * 0.6;
  const strokeW = Math.max(1, plateH * 0.035);

  const svg = `<svg width="${FRAME_W}" height="${FRAME_H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${FRAME_W}" height="${FRAME_H}" fill="#606a72"/>
    <rect x="0" y="${FRAME_H * 0.75}" width="${FRAME_W}" height="${FRAME_H * 0.25}" fill="#3c4147"/>
    <rect x="${carX}" y="${carY}" width="${carW}" height="${carH}" rx="${carH * 0.08}" fill="#1e2b3a"/>
    <rect x="${px}" y="${py}" width="${plateW}" height="${plateH}" fill="#f5f0d8" stroke="#111" stroke-width="${strokeW}"/>
    <text x="${px + plateW / 2}" y="${py + plateH * 0.74}" font-family="Liberation Mono, DejaVu Sans Mono, monospace" font-weight="bold" font-size="${fontSize}" text-anchor="middle" fill="#0a0a0a" letter-spacing="${plateH * 0.02}">${plateText}</text>
  </svg>`;

  let img = sharp(Buffer.from(svg));
  if (preset.blur > 0) img = img.blur(preset.blur);
  await img.jpeg({ quality: preset.jpegQuality }).toFile(outPath);
  return { bounds: { x: px, y: py, w: plateW, h: plateH } };
}

(async () => {
  const manifest = [];
  for (const [distanceName, preset] of Object.entries(PRESETS)) {
    for (const plate of PLATES) {
      const filename = `plate_${distanceName}_${plate.country}.jpg`.replace(/\s+/g, '_');
      const outPath = path.join(OUT_DIR, filename);
      const { bounds } = await makeScene(plate.text, preset, outPath);
      manifest.push({ distance: distanceName, country: plate.country, expectedText: plate.text, file: outPath, bounds, plateHeightPx: preset.plateHeightPx });
      console.log(`${distanceName.padEnd(5)} ${plate.country.padEnd(8)} "${plate.text}" -> ${filename}  (plate ${bounds.w}x${bounds.h}px, char height ~${Math.round(preset.plateHeightPx * 0.6)}px)`);
    }
  }
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('\nWrote manifest.json with', manifest.length, 'test images');
})();
