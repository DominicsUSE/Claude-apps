// Siteless service worker: lets the app be installed and open without a connection.
// The app itself is fetched from the network first, so updates show up straight away;
// Google, OpenStreetMap and map tiles are never cached here.
const CACHE = 'siteless-v2';
const SHELL = ['./', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const keep = res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return res; };
  if (url.origin === location.origin) {
    e.respondWith(fetch(req).then(keep).catch(() => caches.match(req).then(r => r || caches.match('./'))));
  } else if (url.hostname === 'unpkg.com' || /^fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
    e.respondWith(caches.match(req).then(r => r || fetch(req).then(keep)));
  }
});
