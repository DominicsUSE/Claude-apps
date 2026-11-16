// Content policies, in one module so the server (server/index.js) and the
// desktop app's pinned join mode (which serves its own bundled page at a host's
// origin) send exactly the same ones. Moved unchanged from server/index.js;
// tests/server-sec-web.test.js checks the page still gets this policy.

export const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "media-src 'self' blob:", "connect-src 'self'", "font-src 'self'", "object-src 'none'", "base-uri 'none'",
  "frame-ancestors 'none'", "form-action 'self'",
  "worker-src 'self'", "manifest-src 'self'", "frame-src 'none'", // sec-web: no workers, manifests or frames from anywhere else
].join('; ');
// sec-web W6: every other response (API JSON, errors, scripts, styles) gets a
// policy that allows nothing, so nothing served here can be framed or run as a
// page; brand SVGs may style themselves but never run script; the service
// worker may fetch from this origin only.
export const BASE_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
export const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'";
export const WORKER_CSP = "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
// sec-web: a stricter page policy in report-only mode (no inline styles, Trusted
// Types for script sinks). Nothing is blocked by it; what it would block is
// reported to /api/csp-report and kept as a security event, so an injection
// attempt (or a page change that would break under it) shows up.
export const CSP_STRICT = `${CSP.replace("style-src 'self' 'unsafe-inline'", "style-src 'self'")}; require-trusted-types-for 'script'; report-uri /api/csp-report`; // report-uri: sent at once by every browser (report-to batches for up to a minute)
// Help pages (docs/*.html, e.g. docs/install.html): plain reading pages with Snug's own stylesheets, fonts
// and pictures; no script, no inline style, no frames, no forms.
export const DOCS_CSP = "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
