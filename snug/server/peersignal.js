// One WebSocket to the registry's /v1/ws (design sections 2.7, 5.1): auth by
// challenge, then presence, sealed signaling, the E2E relay and knocks.
// Reconnects with backoff (2 s up to 5 min, with jitter), reset once ready;
// a "ping" every ready.ping seconds is the only timer while idle.
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

const MIN_BACKOFF = 2000, MAX_BACKOFF = 5 * 60_000;

export function createSignal({ reg, identity, log = () => {} }) {
  const ev = new EventEmitter();
  let ws = null;
  let stopped = true;
  let attempt = 0;
  let retry = null;
  let pingT = null, pongT = null;
  let ready = null;      // the last ready frame, while connected

  const clearTimers = () => { clearTimeout(retry); clearInterval(pingT); clearTimeout(pongT); retry = pingT = pongT = null; };
  function schedule(ms) {
    clearTimeout(retry);
    if (stopped) return;
    const d = ms ?? Math.min(MAX_BACKOFF, MIN_BACKOFF * 2 ** attempt) * (0.7 + Math.random() * 0.6);
    attempt++;
    retry = setTimeout(connect, d);
    retry.unref?.();
  }
  function connect() {
    clearTimeout(retry);
    if (stopped || (ws && ws.readyState <= 1)) return;
    const self = identity.self();
    if (!self?.uid) return;
    let sock;
    try { sock = new WebSocket(reg.wsUrl(), { maxPayload: 80 * 1024, handshakeTimeout: 10_000 }); } catch { schedule(); return; }
    ws = sock;
    sock.on('message', (buf, isBinary) => {
      if (isBinary || ws !== sock || stopped) return;
      const s = buf.toString();
      if (s === 'pong') { clearTimeout(pongT); pongT = null; return; }
      if (s.length > 80 * 1024) return;
      let m;
      try { m = JSON.parse(s); } catch { return; }
      if (!m || typeof m.t !== 'string' || ['error', 'newListener', 'removeListener'].includes(m.t)) return;
      if (m.t === 'challenge') {
        if (typeof m.n !== 'string' || m.n.length !== 22) return;
        reg.sawNow?.(m.now); // F9: the registry's clock
        const uid = identity.self()?.uid;
        sock.send(JSON.stringify({ t: 'auth', uid, sig: identity.sign(`snug-reg-v1\nsignal\n${uid}\n${m.n}`) }));
        return;
      }
      if (m.t === 'ready') {
        attempt = 0;
        reg.sawNow?.(m.now);
        ready = m;
        const every = Math.max(10, Math.min(3600, Number(m.ping) || 90)) * 1000;
        clearInterval(pingT);
        pingT = setInterval(() => {
          if (sock.readyState !== 1) return;
          sock.send('ping');
          clearTimeout(pongT);
          pongT = setTimeout(() => sock.terminate(), 30_000);
          pongT.unref?.();
        }, every);
        pingT.unref?.();
        ev.emit('ready', m);
        if (m.rebind) ev.emit('rebind', { state: 'pending', ...m.rebind });
        return;
      }
      ev.emit(m.t, m);
    });
    sock.on('close', (code) => {
      if (ws === sock) ws = null;
      const wasReady = !!ready;
      ready = null;
      clearInterval(pingT); clearTimeout(pongT);
      if (wasReady) ev.emit('down', code);
      if (code === 4003) { stopped = true; ev.emit('revoked'); return; }
      if (code === 4006) { stopped = true; ev.emit('stopped'); return; }
      if (code === 4004) { ev.emit('rebound'); attempt = 0; schedule(0); return; }
      ev.emit('offline', code);
      schedule();
    });
    sock.on('error', (e) => { log('peer', 'signal error', e.code || e.message); });
    sock.on('unexpected-response', (_req, res) => { log('peer', 'signal refused', res.statusCode); });
  }

  Object.assign(ev, {
    start() { if (!stopped && ws) return; stopped = false; attempt = 0; connect(); },
    stop() { stopped = true; clearTimers(); const s = ws; ws = null; ready = null; if (s) { try { s.close(1000); } catch { /* closing */ } } },
    // The PC woke up or the screen unlocked: reconnect at once instead of waiting out the backoff (F12).
    wake() {
      if (stopped) return;
      if (ws && ws.readyState === 1) { ws.send('ping'); clearTimeout(pongT); pongT = setTimeout(() => ws?.terminate(), 10_000); pongT.unref?.(); return; }
      attempt = 0; connect();
    },
    send(obj) { if (!ws || ws.readyState !== 1 || !ready) return false; ws.send(JSON.stringify(obj)); return true; },
  });
  Object.defineProperties(ev, {
    ready: { get: () => ready },
    connected: { get: () => !!ready },
    mode: { get: () => ready?.mode || null },
  });
  return ev;
}
