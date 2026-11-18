// Notifications when Snug is closed, on this device.
//
// The setting registers /sw.js, asks the browser's push service for a
// subscription with this server's key, and hands it to the server. The
// server then sends a push only when something needs you and no Snug tab or
// window of yours is connected (server/push.js). Clicking the notification
// opens the conversation: in a Snug tab that is already open (a message from
// the service worker), or in a new one (/?open=<conv>&msg=<id>).
//
// In the desktop app there is no push service; the window stays alive in the
// system tray instead, and the setting there is "Keep Snug running".
import { S, emit, jumpToMsg } from './store.js';
import { api, on } from './server.js';

// off | asking | working | on | blocked | error | unsupported | insecure | desktop | checking
export const push = { status: 'checking', error: '', keepRunning: true };

const desktop = () => typeof window !== 'undefined' && !!window.snugApp?.desktop;
const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const set = (status, error = '') => { push.status = status; push.error = error; emit(); };
const keyBytes = (b64u) => {
  const raw = atob(b64u.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};
const sameKey = (a, b) => !!a && a.byteLength === b.byteLength && new Uint8Array(a).every((x, i) => x === b[i]);

async function registration() {
  return navigator.serviceWorker.getRegistration('/');
}

// Work out the current state, and keep the server's copy of this device's
// subscription fresh (a new server key, or a different person signed in).
export async function refreshPush({ sync = false } = {}) {
  if (desktop()) {
    push.keepRunning = await window.snugApp.getKeepRunning().catch(() => true);
    return set('desktop');
  }
  if (!window.isSecureContext) return set('insecure');
  if (!supported()) return set('unsupported');
  if (push.status === 'asking' || push.status === 'working') return undefined;
  if (Notification.permission === 'denied') return set('blocked');
  try {
    const reg = await registration();
    let sub = reg && await reg.pushManager.getSubscription();
    if (!sub || Notification.permission !== 'granted') return set('off');
    if (sync && S.auth === 'in') {
      const { key } = await api('/api/push/key');
      const want = keyBytes(key);
      if (!sameKey(sub.options?.applicationServerKey, want)) {
        await sub.unsubscribe().catch(() => {});
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want });
      }
      await api('/api/push/subscribe', sub.toJSON());
    }
    return set('on');
  } catch (e) {
    return set('off', '');
  }
}

export async function enablePush() {
  if (!supported() || !window.isSecureContext) return refreshPush();
  set('asking');
  let perm = Notification.permission;
  try {
    if (perm !== 'granted') perm = await Notification.requestPermission();
  } catch { perm = Notification.permission; }
  if (perm === 'denied') return set('blocked');
  if (perm !== 'granted') return set('off', 'Snug needs your permission to notify you. Turn this on again and choose Allow.');
  set('working');
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    const { key } = await api('/api/push/key');
    const old = await reg.pushManager.getSubscription();
    if (old && !sameKey(old.options?.applicationServerKey, keyBytes(key))) await old.unsubscribe().catch(() => {});
    // The browser asks its maker's push service; with no answer in 20 seconds, say so.
    const sub = await Promise.race([
      reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'AbortError' })), 20_000)),
    ]);
    await api('/api/push/subscribe', sub.toJSON());
    return set('on');
  } catch (e) {
    const why = e?.name === 'AbortError' || e?.name === 'NotAllowedError' || /push service/i.test(e?.message || '')
      ? 'The browser couldn’t reach its push service. Check your connection and try again.'
      : (e?.message || 'Something went wrong. Try again.');
    return set('error', why);
  }
}

export async function disablePush() {
  try {
    const reg = await registration();
    const sub = reg && await reg.pushManager.getSubscription();
    if (sub) {
      await api('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
  } catch { /* nothing to undo */ }
  return set('off');
}

// Signing out: this device stops getting the person's notifications.
export async function pushSignOut() {
  if (desktop() || !supported()) return;
  try {
    const reg = await registration();
    const sub = reg && await reg.pushManager.getSubscription();
    if (!sub) return;
    await api('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
    push.status = 'off';
  } catch { /* signing out anyway */ }
}

export async function setKeepRunning(v) {
  if (!desktop()) return;
  push.keepRunning = await window.snugApp.setKeepRunning(!!v).catch(() => push.keepRunning);
  emit();
}

// Opening a conversation from a notification.
let pending = null;
try {
  const q = new URLSearchParams(location.search);
  if (q.get('open')) {
    pending = { conv: q.get('open'), msg: q.get('msg') };
    history.replaceState(history.state, '', location.pathname === '/' ? '/' : location.pathname);
  }
} catch { /* no address to read */ }
const openFrom = ({ conv, msg }) => {
  if (typeof conv !== 'string' || S.auth !== 'in') return;
  if (typeof msg === 'string') jumpToMsg(conv, msg);
};
// Every connect (a sign-in included) re-sends this device's subscription.
on('open', () => {
  if (pending) { const p = pending; pending = null; openFrom(p); }
  refreshPush({ sync: true });
});
if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.t === 'snug:open') openFrom(e.data);
  });
}
