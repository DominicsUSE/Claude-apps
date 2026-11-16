// The app's own files, sent efficiently (0.12), and the list of them the
// service worker keeps for opening the app offline (sw.js).
//
// - Every static file gets an ETag from its size and modification time. It is
//   still sent with Cache-Control: no-cache, so the browser checks each time
//   (a new version shows at once) and gets an empty 304 when nothing changed.
// - Text files (scripts, styles, the page, JSON, SVG) are gzipped when the
//   browser accepts it, once per file version, kept in memory. Fonts and
//   pictures are already compressed and go as they are. API replies are never
//   compressed here: compressing secrets next to attacker-chosen text leaks
//   them (BREACH), and they change on every request anyway.
// - /shell.json lists the app's files and a version that changes whenever any
//   of them does. It holds nothing private.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { join, extname } from 'node:path';

const ZIP = new Set(['.js', '.css', '.html', '.json', '.svg', '.txt', '.webmanifest']);
const MAX_ZIP_CACHE = 32 * 1024 * 1024; // bytes of gzipped copies kept

export function createShell({ root, dirs }) {
  const zipped = new Map(); // file -> { key, buf }
  let zippedBytes = 0;
  const etagOf = (info) => `"${info.size.toString(36)}-${Math.floor(info.mtimeMs).toString(36)}"`;
  const fresh = (req, tag) => {
    const inm = String(req.headers['if-none-match'] || '');
    return !!inm && inm.split(',').some((t) => t.trim().replace(/^W\//, '').replace(/-gz"$/, '"') === tag);
  };
  async function gz(file, info) {
    const key = `${info.size}-${info.mtimeMs}`;
    const have = zipped.get(file);
    if (have?.key === key) return have.buf;
    const buf = gzipSync(await readFile(file), { level: 6 });
    if (have) zippedBytes -= have.buf.length;
    // A simple cap: past it, start again (the app has a few hundred files, so this is rare).
    if (zippedBytes + buf.length > MAX_ZIP_CACHE) { zipped.clear(); zippedBytes = 0; }
    zipped.set(file, { key, buf });
    zippedBytes += buf.length;
    return buf;
  }

  // Send one static file. `setHeaders` writes the shared security headers plus `extra`.
  // Returns false when it didn't handle the body (the caller streams it as before).
  async function send(req, res, file, info, setHeaders, extra) {
    const tag = etagOf(info);
    const ext = extname(file);
    const zip = ZIP.has(ext) && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    const vary = ZIP.has(ext) ? { Vary: 'Accept-Encoding' } : {};
    if (fresh(req, tag)) {
      setHeaders(res, { ...extra, ETag: zip ? tag.replace(/"$/, '-gz"') : tag, ...vary });
      res.writeHead(304);
      res.end();
      return true;
    }
    if (!zip) { setHeaders(res, { ...extra, ETag: tag, ...vary }); return false; }
    const buf = await gz(file, info);
    setHeaders(res, { ...extra, ETag: tag.replace(/"$/, '-gz"'), 'Content-Encoding': 'gzip', 'Content-Length': String(buf.length), ...vary });
    res.writeHead(200);
    res.end(req.method === 'HEAD' ? undefined : buf);
    return true;
  }

  // The files sw.js keeps: the page and everything under the public folders
  // (not docs/, which only the README links to, and not the worker itself).
  // pdf.js's character maps and standard fonts are fetched when a PDF needs one.
  const ON_DEMAND = new Set(['vendor/pdfjs/cmaps', 'vendor/pdfjs/standard_fonts']);
  let list = null, listAt = 0;
  function shellList() {
    if (list && Date.now() - listAt < 30_000) return list; // files can change under a running server (a deploy, development)
    listAt = Date.now();
    const files = ['/'];
    const sig = createHash('sha256');
    const walk = (dir) => {
      for (const e of readdirSync(join(root, dir), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const rel = `${dir}${e.name}`;
        if (e.isDirectory()) { if (!ON_DEMAND.has(rel)) walk(`${rel}/`); }
        else if (e.isFile() && !e.name.startsWith('.')) {
          const st = statSync(join(root, rel));
          files.push(`/${rel}`);
          sig.update(`${rel}\n${st.size}\n${Math.floor(st.mtimeMs)}\n`);
        }
      }
    };
    for (const d of dirs) walk(d);
    const st = statSync(join(root, 'index.html'));
    sig.update(`index.html\n${st.size}\n${Math.floor(st.mtimeMs)}\n`);
    let version = '0.0.0';
    try { version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version; } catch { /* keep the default */ }
    list = { version: `${version}-${sig.digest('hex').slice(0, 12)}`, files };
    return list;
  }
  return { send, shellList };
}
