// Which address loads which of the app's own files, and the headers each one
// gets. Shared by the server (server/index.js staticFile) and the desktop app's
// pinned join mode (desktop/pinned.js), which serves the app's bundled copy of
// these files at a host's address: both must answer the same paths with the
// same policies, or the bundled client would behave differently from the
// host's own page.
import { posix } from 'node:path';
import { CSP, CSP_STRICT, BASE_CSP, SVG_CSP, WORKER_CSP, DOCS_CSP } from './csp.js';

export const PUBLIC = ['index.html', 'css/', 'js/', 'fonts/', 'vendor/', 'docs/', 'brand/', 'sw.js'];
export const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

const ext = (rel) => posix.extname(rel);

// What every response carries (server/index.js headers(); HSTS is added there when the server is https).
export const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  // Camera and screen capture for video in voice rooms; same origin only.
  'Permissions-Policy': 'microphone=(self), camera=(self), display-capture=(self), fullscreen=(self), geolocation=()',
  // sec-web W6: no other origin may embed or frame anything served here, and
  // nothing is a page unless it says so (callers pass their own policy).
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': BASE_CSP,
};

// The file (relative to the app folder) a decoded URL path loads, or null for a 404.
// /, /join/<code> and /m/<conversation>/<message> (a message link) load the app itself,
// and so does any other path without an extension (the app's own routes).
export function staticRel(path) {
  // Web addresses always use forward slashes, whatever this machine's file paths look like.
  let rel = path === '/' || path.startsWith('/join/') || path.startsWith('/m/') ? 'index.html' : posix.normalize(String(path).replace(/\\/g, '/')).replace(/^\/+/, '');
  if (rel.includes('..') || !PUBLIC.some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p))) {
    if (ext(rel)) return null;
    rel = 'index.html';
  }
  return rel;
}

// The headers for one of those files, on top of the server's usual ones.
export function staticHeaders(rel, https = false) {
  return {
    'Content-Type': TYPES[ext(rel)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    ...(rel === 'index.html' ? {
      'Content-Security-Policy': https ? `${CSP}; upgrade-insecure-requests` : CSP,
      'Content-Security-Policy-Report-Only': CSP_STRICT, // sec-web
    } : {}),
    ...(ext(rel) === '.svg' ? { 'Content-Security-Policy': SVG_CSP } : {}), // sec-web W6
    ...(rel.startsWith('docs/') && ext(rel) === '.html' ? { 'Content-Security-Policy': DOCS_CSP } : {}), // help pages: no script
    ...(rel === 'sw.js' ? { 'Service-Worker-Allowed': '/', 'Content-Security-Policy': WORKER_CSP } : {}), // push notifications
  };
}
