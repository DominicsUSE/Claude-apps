// Copies the real app source into this folder before packaging, so dinocam/index.html
// stays the single source of truth (this folder never holds an independent, driftable
// copy of the app in git — only the packaging scaffolding does).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
fs.mkdirSync(path.join(__dirname, 'app'), { recursive: true });
fs.mkdirSync(path.join(__dirname, 'build'), { recursive: true });

fs.copyFileSync(path.join(root, 'index.html'), path.join(__dirname, 'app', 'index.html'));
fs.copyFileSync(path.join(root, 'windows', 'dinosaur.ico'), path.join(__dirname, 'app', 'dinosaur.ico'));
fs.copyFileSync(path.join(root, 'windows', 'dinosaur.ico'), path.join(__dirname, 'build', 'icon.ico'));

// The plate-specific OCR model index.html loads via a relative <script src> (models/plate-ocr/...)
fs.mkdirSync(path.join(__dirname, 'app', 'models', 'plate-ocr'), { recursive: true });
fs.copyFileSync(
  path.join(root, 'models', 'plate-ocr', 'model-data.js'),
  path.join(__dirname, 'app', 'models', 'plate-ocr', 'model-data.js')
);

console.log('Copied ../index.html, ../windows/dinosaur.ico, and ../models/plate-ocr into electron/app and electron/build.');
