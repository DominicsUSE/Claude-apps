// Snug's service worker. Two jobs:
// 1. Push: show a notification when the server pushes one while no Snug tab
//    is open, and open the conversation when the notification is clicked.
// 2. The app shell (0.12): keep a copy of the app's own files (the page,
//    scripts, styles, fonts, pictures) so Snug opens with no connection and
//    shows what this device already has. Always network first, so a new
//    version shows at once whenever the server can be reached; the copy is
//    only used when it can't. Never kept: anything under /api/ (messages,
//    files, sign-in), the socket, or this worker itself. The list of files and
//    its version come from /shell.json (server/shell.js).
/* eslint-env serviceworker */

const SHELL = 'snug-shell-v1';
const NEVER = /^\/(api|ws)(\/|$)|^\/sw\.js$|^\/shell\.json$/;

async function precache() {
  const r = await fetch('/shell.json', { cache: 'no-store' });
  if (!r.ok) return;
  const { version, files } = await r.json();
  const cache = await caches.open(SHELL);
  if ((await (await cache.match('/__version'))?.text()) === version) return;
  // One at a time is slow but kind to a small server; a file that fails is fetched on use instead.
  for (const f of files) {
    if (typeof f !== 'string' || !f.startsWith('/') || NEVER.test(f)) continue;
    try { const res = await fetch(f, { cache: 'no-cache' }); if (res.ok) await cache.put(f, res); } catch { /* next time */ }
  }
  await cache.put('/__version', new Response(version));
}

self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(precache().catch(() => {})); });
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith('snug-shell-') && k !== SHELL) await caches.delete(k);
  await self.clients.claim();
})()));
// The page asks for a refresh of the copy after it loads (a new version on the server).
self.addEventListener('message', (e) => { if (e.data?.t === 'snug:shell') e.waitUntil(precache().catch(() => {})); });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || NEVER.test(url.pathname)) return;
  // Pages (/, /join/..., /m/...) are all the same app page.
  const key = req.mode === 'navigate' ? '/' : url.pathname;
  if (req.mode !== 'navigate' && !/^\/(js|css|vendor|fonts|brand)\//.test(url.pathname)) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      // Keep the newest copy of what loaded fine (never a partial or an error).
      if (res.ok && res.status === 200 && res.type === 'basic' && (req.mode !== 'navigate' || /^text\/html/.test(res.headers.get('content-type') || ''))) {
        const copy = res.clone();
        e.waitUntil(caches.open(SHELL).then((c) => c.put(key, copy)).catch(() => {}));
      }
      return res;
    } catch (err) {
      const hit = await caches.match(key, { cacheName: SHELL });
      if (hit) return hit;
      throw err;
    }
  })());
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  const title = typeof d.title === 'string' && d.title ? d.title : 'Snug';
  const body = typeof d.body === 'string' ? d.body : '';
  // One notification per conversation: a newer message replaces the older one quietly.
  const tag = typeof d.tag === 'string' ? d.tag : 'snug';
  const icons = { icon: '/brand/app-icon-192.png', badge: '/brand/notify-badge.png' };
  // A ring is over (answered elsewhere, declined, missed): its "is calling"
  // note, if it is still showing, becomes a quiet one that doesn't stay on
  // screen. Anything else showing for that conversation is left alone.
  if (typeof d.ringOver === 'string') {
    e.waitUntil((async () => {
      const open = await self.registration.getNotifications({ tag });
      if (!open.some((n) => n.data?.ring === d.ringOver)) return;
      await self.registration.showNotification(title, { ...icons, body, tag, silent: true, data: { conv: d.conv } });
    })());
    return;
  }
  e.waitUntil(self.registration.showNotification(title, {
    ...icons, body, tag,
    renotify: d.call === true,
    // Someone calling stays on screen until it is dealt with (or the ring ends: above).
    requireInteraction: d.call === true,
    data: { conv: d.conv, msg: d.msg, ring: typeof d.ring === 'string' ? d.ring : undefined },
  }));
});

const openUrl = (conv, msg) => {
  const u = new URL('/', self.location.origin);
  if (typeof conv === 'string') u.searchParams.set('open', conv);
  if (typeof msg === 'string') u.searchParams.set('msg', msg);
  return u.href;
};

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const { conv, msg } = e.notification.data || {};
  e.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const tab = tabs.find((c) => new URL(c.url).origin === self.location.origin);
    if (tab) {
      // A Snug tab is open: bring it forward and let it open the conversation.
      tab.postMessage({ t: 'snug:open', conv, msg });
      try { await tab.focus(); } catch { /* the browser decides */ }
      return;
    }
    await self.clients.openWindow(openUrl(conv, msg));
  })());
});

// The browser renewed the subscription: tell the server about the new one.
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    const r = await fetch('/api/push/key', { credentials: 'same-origin' });
    if (!r.ok) return;
    const { key } = await r.json();
    const raw = atob(key.replace(/-/g, '+').replace(/_/g, '/'));
    const sub = await self.registration.pushManager.subscribe({
      userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, (c) => c.charCodeAt(0)),
    });
    await fetch('/api/push/subscribe', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub.toJSON()),
    });
  })());
});
