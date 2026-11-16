// Previews for attachments that aren't pictures, video or sound:
// - SVG: the server always sends it as a download (it can carry script). Here its
//   bytes become a Blob URL shown in an <img>, and an SVG drawn as an image runs
//   no script and loads nothing from anywhere else. It stays downloadable.
// - PDF: pdf.js (vendor/pdfjs, Apache-2.0) is loaded only when a PDF comes into
//   view. The file's bytes are fetched here and handed over in memory; pdf.js
//   never fetches anything and never evaluates code (isEvalSupported: false).
//   Page 1 shows in the conversation; Open shows every page, one at a time.
import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { openModal, closeModal } from '../store.js';
import { fileSize } from '../lib/util.js';
import { Icon } from '../ui/icons.js';
import { XIcon } from './viewer.js'; // the download icon

export const SVG_MAX = 1024 * 1024;
export const PDF_MAX = 25 * 1024 * 1024;
export const isSvgFile = (f) => f.kind === 'file' && !!f.id && /\.svg$/i.test(f.name || '') && (f.size || 0) <= SVG_MAX;
export const isPdfFile = (f) => f.kind === 'file' && !!f.id && /\.pdf$/i.test(f.name || '') && (f.size || 0) <= PDF_MAX;

// Only bytes that look like SVG markup become a picture; anything else stays a download.
export function looksLikeSvg(text) {
  let head = String(text).slice(0, 2048).replace(/^﻿/, '').trimStart();
  // Skip the prolog one piece at a time (an XML declaration, comments, an SVG doctype): one anchored
  // match per piece, so no input can make the check backtrack.
  for (let m; (m = /^(?:<\?xml[^>]*>|<!--[\s\S]*?-->|<!DOCTYPE svg[^>]*>)\s*/i.exec(head));) head = head.slice(m[0].length);
  return /^<svg[\s>]/i.test(head);
}
// The first bytes of a PDF say so.
export const looksLikePdf = (bytes) => bytes.length > 5 && String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-';

function useSeen(ref) {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen || !ref.current) return undefined;
    if (typeof IntersectionObserver === 'undefined') { setSeen(true); return undefined; }
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setSeen(true); io.disconnect(); } }, { rootMargin: '200px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen]);
  return seen;
}
const getBytes = async (url) => {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) throw new Error('fetch');
  return new Uint8Array(await r.arrayBuffer());
};
const Download = ({ f, url }) => html`<a class="btn sm quiet" href=${url} download=${f.name} aria-label=${`Download ${f.name}`}><${XIcon} name="download" size=${14} />Download</a>`;

// ---------------------------------------------------------------- SVG
export function SvgPreview({ f, url, fallback }) {
  const box = useRef();
  const seen = useSeen(box);
  const [st, setSt] = useState({ state: 'idle' });
  useEffect(() => {
    if (!seen) return undefined;
    let src = null, gone = false;
    getBytes(url).then((bytes) => {
      if (gone) return;
      if (!looksLikeSvg(new TextDecoder().decode(bytes.subarray(0, 2048)))) { setSt({ state: 'bad' }); return; }
      src = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }));
      setSt({ state: 'ok', src });
    }, () => { if (!gone) setSt({ state: 'error' }); });
    return () => { gone = true; if (src) URL.revokeObjectURL(src); };
  }, [seen, url]);
  if (st.state === 'bad' || st.state === 'error') return fallback;
  return html`<div class="pfile svg-file" ref=${box}>
    <div class="pfile-view">${st.state === 'ok' ? html`<img src=${st.src} alt=${f.alt || f.name} />` : html`<span class="skel pfile-skel"></span>`}</div>
    <div class="tfile-head"><${Icon} name="image" size=${16} /><span class="trunc grow">${f.name}</span><span class="faint">SVG, ${fileSize(f.size || 0)}</span><${Download} f=${f} url=${url} /></div>
  </div>`;
}

// ---------------------------------------------------------------- PDF
let pdfjs = null;
async function loadPdfjs() {
  if (!pdfjs) {
    pdfjs = import('../../vendor/pdfjs/pdf.min.js').then((m) => {
      m.GlobalWorkerOptions.workerSrc = new URL('../../vendor/pdfjs/pdf.worker.min.js', import.meta.url).href;
      return m;
    }).catch((e) => { pdfjs = null; throw e; });
  }
  return pdfjs;
}
const PDF_CMAPS = new URL('../../vendor/pdfjs/cmaps/', import.meta.url).href;
const PDF_FONTS = new URL('../../vendor/pdfjs/standard_fonts/', import.meta.url).href;
const docs = new Map(); // file id -> Promise<PDFDocumentProxy>, a few at a time
async function openPdf(id, url) {
  if (!docs.has(id)) {
    docs.set(id, (async () => {
      const [lib, data] = await Promise.all([loadPdfjs(), getBytes(url)]);
      if (!looksLikePdf(data)) throw Object.assign(new Error('not a pdf'), { bad: true });
      return lib.getDocument({
        data, isEvalSupported: false, disableAutoFetch: true, disableStream: true, enableXfa: false, stopAtErrors: false,
        // pdf.js's own character maps and standard fonts (vendor/pdfjs/cmaps, standard_fonts), from this server,
        // so text in fonts a PDF doesn't carry (Chinese, Japanese and Korean ones, Symbol, ZapfDingbats) still shows.
        cMapUrl: PDF_CMAPS, cMapPacked: true, standardFontDataUrl: PDF_FONTS,
      }).promise;
    })().catch((e) => { docs.delete(id); throw e; }));
    while (docs.size > 6) { const [k, p] = docs.entries().next().value; docs.delete(k); p.then((d) => d.destroy(), () => {}); }
  }
  return docs.get(id);
}
async function drawPage(doc, n, canvas, width) {
  const page = await doc.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  const vp = page.getViewport({ scale: (width / base.width) * dpr });
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  canvas.style.aspectRatio = `${vp.width} / ${vp.height}`;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, canvas }).promise;
}

export function PdfPreview({ f, url, fallback }) {
  const box = useRef();
  const cv = useRef();
  const seen = useSeen(box);
  const [st, setSt] = useState({ state: 'idle' });
  useEffect(() => {
    if (!seen) return undefined;
    let gone = false;
    setSt({ state: 'loading' });
    openPdf(f.id, url).then(async (doc) => {
      if (gone || !cv.current) return;
      await drawPage(doc, 1, cv.current, 320);
      if (!gone) setSt({ state: 'ok', pages: doc.numPages });
    }).catch((e) => { if (!gone) setSt({ state: e.bad ? 'bad' : 'error' }); });
    return () => { gone = true; };
  }, [seen, f.id]);
  if (st.state === 'bad') return fallback;
  const open = () => openModal(PdfViewer, { f, url, wide: true });
  return html`<div class="pfile pdf-file" ref=${box}>
    <button class="pfile-view" aria-label=${`Open ${f.name}`} disabled=${st.state !== 'ok'} onClick=${open}>
      <canvas ref=${cv} hidden=${st.state !== 'ok'} aria-hidden="true"></canvas>
      ${st.state === 'loading' || st.state === 'idle' ? html`<span class="skel pfile-skel"></span>` : null}
      ${st.state === 'error' ? html`<span class="pfile-note">The preview didn’t load. Download the file instead.</span>` : null}
    </button>
    <div class="tfile-head"><${Icon} name="file" size=${16} /><span class="trunc grow">${f.name}</span>
      <span class="faint">PDF${st.pages ? `, ${st.pages} ${st.pages === 1 ? 'page' : 'pages'}` : ''}, ${fileSize(f.size || 0)}</span>
      ${st.state === 'ok' && html`<button class="btn sm quiet" onClick=${open}>Open</button>`}<${Download} f=${f} url=${url} /></div>
  </div>`;
}

// Every page, one at a time: arrows or Page keys to move.
export function PdfViewer({ f, url }) {
  const cv = useRef();
  const [n, setN] = useState(1);
  const [st, setSt] = useState({ state: 'loading', pages: 0 });
  useEffect(() => {
    let gone = false;
    openPdf(f.id, url).then(async (doc) => {
      if (gone || !cv.current) return;
      setSt({ state: 'drawing', pages: doc.numPages });
      await drawPage(doc, Math.min(n, doc.numPages), cv.current, Math.min(760, (globalThis.innerWidth || 800) - 64));
      if (!gone) setSt({ state: 'ok', pages: doc.numPages });
    }).catch(() => { if (!gone) setSt({ state: 'error', pages: 0 }); });
    return () => { gone = true; };
  }, [n]);
  const go = (d) => setN((x) => Math.max(1, Math.min(st.pages || 1, x + d)));
  const onKey = (e) => {
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); go(1); }
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(-1); }
  };
  return html`<div class="pdf-viewer" onKeyDown=${onKey}>
    <h2 class="trunc">${f.name}</h2>
    <div class="pdf-page" role="img" aria-label=${`Page ${n} of ${st.pages || '…'}`}>
      <canvas ref=${cv} hidden=${st.state === 'error'}></canvas>
      ${st.state === 'error' && html`<p class="pfile-note">This PDF couldn’t be shown. Download it instead.</p>`}
    </div>
    <div class="modal-foot">
      <button class="btn" aria-label="Previous page" disabled=${n <= 1} onClick=${() => go(-1)}><${Icon} name="chev-l" size=${16} /></button>
      <span class="num pdf-count" aria-live="polite">Page ${n} of ${st.pages || '…'}</span>
      <button class="btn" aria-label="Next page" data-autofocus disabled=${!st.pages || n >= st.pages} onClick=${() => go(1)}><${Icon} name="chev-r" size=${16} /></button>
      <span class="grow"></span>
      <${Download} f=${f} url=${url} />
      <button class="btn" onClick=${closeModal}>Close</button>
    </div>
  </div>`;
}
