// Snug's service worker. It does one job: show a notification when the server
// pushes one while no Snug tab is open, and open the conversation when the
// notification is clicked. It caches nothing and handles no requests.
/* eslint-env serviceworker */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

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
