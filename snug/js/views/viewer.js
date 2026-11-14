// The media viewer: pictures and videos full screen, one at a time.
//
// A modal dialog with focus kept inside it and given back to the thumbnail
// that opened it. Left and Right (or a swipe) go through every picture and
// video in the message, then the rest of the loaded conversation, with a
// counter ("3 of 8"). Zoom by clicking, + and -, the wheel or a pinch; drag
// to look around while zoomed. Open the original, download it with its name,
// read its description, and jump to the message it came from.
import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { S, emit, person, closeLightbox, jumpToMsg } from '../store.js';
import { fmtFull } from '../lib/util.js';
import { Icon } from '../ui/icons.js';

// Icons the shared set doesn't have, drawn the same way (20px grid, 1.5px stroke).
const EXTRA = {
  'chev-l': 'M12.5 5l-5 5 5 5',
  download: 'M10 3.5v9|M6 9l4 4 4-4|M4 16.5h12',
  'zoom-in': 'M9 15A6 6 0 1 0 9 3a6 6 0 0 0 0 12Z|M17 17l-3.7-3.7|M9 6.5v5|M6.5 9h5',
  'zoom-out': 'M9 15A6 6 0 1 0 9 3a6 6 0 0 0 0 12Z|M17 17l-3.7-3.7|M6.5 9h5',
  volume: 'M3.5 8v4h3l4 3.5v-11l-4 3.5Z|M13.5 7.5a3.5 3.5 0 0 1 0 5|M15.5 5a7 7 0 0 1 0 10',
  'volume-off': 'M3.5 8v4h3l4 3.5v-11l-4 3.5Z|M13.5 8l4 4|M17.5 8l-4 4',
  pip: 'M3 5h14v10H3Z|f:M10.5 10h5v4h-5Z',
};
export function XIcon({ name, size = 20 }) {
  if (!EXTRA[name]) return html`<${Icon} name=${name} size=${size} />`;
  return html`<svg class="ic" width=${size} height=${size} viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    ${EXTRA[name].split('|').map((d) => (d.startsWith('f:') ? html`<path d=${d.slice(2)} fill="currentColor" stroke="none" />` : html`<path d=${d} />`))}
  </svg>`;
}

const visual = (f) => f && f.id && !f.voice && (f.kind === 'image' || f.kind === 'video');
const itemOf = (conv, m, f) => ({
  key: `${m.id}:${f.id}`, src: f.src || `/api/files/${f.id}`, name: f.name, alt: f.alt || '', kind: f.kind, gif: !!f.gif,
  w: f.w, h: f.h, conv, mid: m.id, author: m.author, ts: m.ts,
});

// Everything the viewer can step through: this message's pictures and videos
// first, then the rest of the loaded conversation in order. Spoilers stay
// out unless they are the one being opened.
export function viewerItems(conv, mid, fileId, msgs = S.msgs[conv] || []) {
  const here = msgs.find((m) => m.id === mid);
  const ok = (m, f) => visual(f) && (!f.spoiler || (m.id === mid && f.id === fileId));
  const first = here ? (here.files || []).filter((f) => ok(here, f)).map((f) => itemOf(conv, here, f)) : [];
  const rest = msgs.filter((m) => m.id !== mid && !m.state).flatMap((m) => (m.files || []).filter((f) => ok(m, f)).map((f) => itemOf(conv, m, f)));
  return [...first, ...rest];
}

// Open a message's picture or video.
export function openViewer(conv, m, f) {
  S.ui.lightbox = { src: f.src || `/api/files/${f.id}`, alt: f.alt || f.name, conv, mid: m.id, fileId: f.id };
  emit();
}

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
const clampZoom = (z) => Math.min(5, Math.max(1, z));
const reduced = () => {
  const m = document.documentElement.getAttribute('data-motion');
  return m === 'off' || (m !== 'full' && matchMedia('(prefers-reduced-motion: reduce)').matches);
};

export function Viewer({ lb }) {
  const ref = useRef();
  const opener = useRef(null);
  const items = lb.conv && lb.mid ? viewerItems(lb.conv, lb.mid, lb.fileId) : [];
  const start = Math.max(0, items.findIndex((it) => it.mid === lb.mid && it.key.endsWith(`:${lb.fileId}`)));
  const list = items.length ? items : [{ key: 'one', src: lb.src, name: lb.alt || 'Picture', alt: '', kind: 'image' }];
  const [i, setI] = useState(start);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const pointers = useRef(new Map());
  const gesture = useRef(null);
  const it = list[Math.min(i, list.length - 1)];
  const many = list.length > 1;

  useLayoutEffect(() => {
    opener.current = document.activeElement;
    ref.current?.querySelector('.vw-close')?.focus();
    return () => {
      const o = opener.current;
      // Back to the thumbnail that opened it, if it is still there.
      if (o && o.isConnected && typeof o.focus === 'function') requestAnimationFrame(() => o.focus());
    };
  }, []);
  // Each picture starts unzoomed.
  const go = (d) => { if (!many) return; setZoom(1); setPan({ x: 0, y: 0 }); setI((x) => (x + d + list.length) % list.length); };
  const zoomBy = (k) => setZoom((z) => { const n = clampZoom(z * k); if (n === 1) setPan({ x: 0, y: 0 }); return n; });
  const onKey = (e) => {
    if (e.key === 'ArrowRight') go(1);
    else if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === '+' || e.key === '=') zoomBy(1.5);
    else if (e.key === '-' || e.key === '_') zoomBy(1 / 1.5);
    else if (e.key === '0') { setZoom(1); setPan({ x: 0, y: 0 }); }
    else if (e.key === 'Tab') {
      const els = [...ref.current.querySelectorAll(FOCUSABLE)];
      if (!els.length) return;
      const first = els[0], last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onWheel = (e) => { if (it.kind !== 'image') return; e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.2 : 1 / 1.2); };
  // Pointers: one drags (pans when zoomed, swipes when not), two pinch.
  const down = (e) => {
    if (it.kind !== 'image' || e.target.tagName !== 'IMG') return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const ps = [...pointers.current.values()];
    gesture.current = ps.length === 2
      ? { pinch: Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y), zoom }
      : { x: e.clientX, y: e.clientY, pan, moved: false };
  };
  const move = (e) => {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    const ps = [...pointers.current.values()];
    if (g.pinch && ps.length === 2) { setZoom(clampZoom(g.zoom * (Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y) / g.pinch))); return; }
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) g.moved = true;
    if (zoom > 1) setPan({ x: g.pan.x + dx, y: g.pan.y + dy });
  };
  const up = (e) => {
    const g = gesture.current;
    pointers.current.delete(e.pointerId);
    if (!g || g.pinch) { if (!pointers.current.size) gesture.current = null; return; }
    gesture.current = null;
    const dx = e.clientX - g.x;
    if (zoom === 1 && g.moved && Math.abs(dx) > 50) { go(dx < 0 ? 1 : -1); return; }
    if (!g.moved) { if (zoom > 1) { setZoom(1); setPan({ x: 0, y: 0 }); } else setZoom(2); }
  };
  const author = it.author ? person(it.author) : null;
  const jump = () => { const { conv, mid } = it; closeLightbox(); jumpToMsg(conv, mid); };
  const label = `${it.kind === 'video' ? 'Video' : 'Picture'}: ${it.alt || it.name}`;

  return html`<div class=${`viewer${reduced() ? ' still' : ''}`} ref=${ref} role="dialog" aria-modal="true" aria-label=${label} onKeyDown=${onKey}>
    <div class="vw-top">
      <div class="vw-who">
        ${author && html`<b>${author.name}</b><time datetime=${new Date(it.ts).toISOString()}>${fmtFull(it.ts)}</time>`}
        ${many && html`<span class="vw-count" aria-live="polite">${i + 1} of ${list.length}</span>`}
      </div>
      <div class="vw-tools">
        ${it.kind === 'image' && html`
          <button class="ib" aria-label="Zoom out" data-tip="Zoom out" data-key="−" disabled=${zoom <= 1} onClick=${() => zoomBy(1 / 1.5)}><${XIcon} name="zoom-out" /></button>
          <button class="ib" aria-label="Zoom in" data-tip="Zoom in" data-key="+" disabled=${zoom >= 5} onClick=${() => zoomBy(1.5)}><${XIcon} name="zoom-in" /></button>`}
        ${it.mid && html`<button class="ib" aria-label="Go to the message" data-tip="Jump to message" onClick=${jump}><${Icon} name="reply" /></button>`}
        <a class="ib" href=${it.src} target="_blank" rel="noopener" aria-label="Open the original" data-tip="Open original"><${Icon} name="external" /></a>
        <a class="ib vw-download" href=${it.src} download=${it.name} aria-label=${`Download ${it.name}`} data-tip="Download"><${XIcon} name="download" /></a>
        <button class="ib vw-close" aria-label="Close" data-tip="Close" data-key="Esc" onClick=${closeLightbox}><${Icon} name="x" /></button>
      </div>
    </div>
    <div class="vw-stage" onWheel=${onWheel} onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${up}
      onClick=${(e) => { if (e.target === e.currentTarget) closeLightbox(); }}>
      ${it.kind === 'video'
        ? html`<video key=${it.key} class="vw-media" src=${it.src} controls autoplay=${!reduced()} playsinline aria-label=${it.alt || it.name}></video>`
        : html`<img key=${it.key} class=${`vw-media${zoom > 1 ? ' zoomed' : ''}`} src=${it.src} alt=${it.alt || it.name} draggable="false"
            style=${`transform:translate(${pan.x}px,${pan.y}px) scale(${zoom})`} />`}
    </div>
    ${many && html`
      <button class="vw-nav prev" aria-label="Previous" data-tip="Previous" data-key="←" onClick=${() => go(-1)}><${XIcon} name="chev-l" size=${24} /></button>
      <button class="vw-nav next" aria-label="Next" data-tip="Next" data-key="→" onClick=${() => go(1)}><${Icon} name="chev-r" size=${24} /></button>`}
    ${(it.alt || it.mid) && html`<div class="vw-foot">
      ${it.alt ? html`<p class="vw-alt"><span class="alt-tag">ALT</span>${it.alt}</p>` : html`<p class="vw-alt faint">${it.name}</p>`}
    </div>`}
  </div>`;
}
