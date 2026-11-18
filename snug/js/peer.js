// The link host (design section 5.2): this page, on the PC's own desktop
// window or a browser on 127.0.0.1, carries the WebRTC data channels for links
// to friends' PCs. It never sees keys or plaintext: the local server hands it
// sealed frame strings to send and takes the ones that arrive. Loaded by
// js/app.js only for the owner of a P2P account.
import { S, emit } from './store.js';
import { on, sendOp } from './server.js';

const pcs = new Map(); // `${peer}|${sid}` -> { pc, dc, done, timer }
const keyOf = (peer, sid) => `${peer}|${sid}`;

// Host candidates with a raw private, loopback or link-local address are taken
// out of the description before it leaves the PC (S14); mDNS names (.local) stay.
function privateIp(a) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(a)) {
    const [x, y] = a.split('.').map(Number);
    return x === 10 || x === 127 || (x === 169 && y === 254) || (x === 192 && y === 168) || (x === 172 && y >= 16 && y <= 31) || (x === 100 && y >= 64 && y <= 127);
  }
  const v = a.toLowerCase();
  return v === '::1' || v.startsWith('fe80:') || v.startsWith('fc') || v.startsWith('fd');
}
export function stripSdp(sdp) {
  return sdp.split('\r\n').filter((line) => {
    const m = /^a=candidate:\S+ \d+ \S+ \d+ (\S+) \d+ typ host/.exec(line);
    return !m || m[1].endsWith('.local') || !privateIp(m[1]);
  }).join('\r\n');
}

// Inbound frames go to the server in batches: one op per microtask, at most 16 frames and 400 KB.
const inbox = new Map(); // key -> { peer, sid, fs, size }
let flushing = false;
function deliver(peer, sid, f) {
  if (typeof f !== 'string' || f.length > 64 * 1024) return;
  const k = keyOf(peer, sid);
  let b = inbox.get(k);
  if (b && (b.fs.length >= 16 || b.size + f.length > 400 * 1024)) { sendOp('peer.in', { peer, sid, fs: b.fs }); b = null; inbox.delete(k); }
  if (!b) { b = { peer, sid, fs: [], size: 0 }; inbox.set(k, b); }
  b.fs.push(f);
  b.size += f.length;
  if (!flushing) {
    flushing = true;
    queueMicrotask(() => {
      flushing = false;
      for (const x of inbox.values()) sendOp('peer.in', { peer: x.peer, sid: x.sid, fs: x.fs });
      inbox.clear();
    });
  }
}

function hangup(peer, sid, tell = false) {
  const k = keyOf(peer, sid);
  const e = pcs.get(k);
  if (!e) return;
  pcs.delete(k);
  clearTimeout(e.timer);
  try { e.dc?.close(); } catch { /* closed */ }
  try { e.pc.close(); } catch { /* closed */ }
  if (tell) sendOp('peer.closed', { peer, sid });
}

// Send the description once it is good enough (F8): gathering done, 500 ms after
// the first server-reflexive candidate, 1.5 s with host candidates only, 3 s at most.
function whenGathered(e, send) {
  const start = Date.now();
  let srflxAt = 0;
  let sent = false;
  const go = () => {
    if (sent || !e.pc.localDescription) return;
    sent = true;
    clearTimeout(e.timer);
    send(stripSdp(e.pc.localDescription.sdp));
  };
  const check = () => {
    if (sent) return;
    const t = Date.now() - start;
    if (e.pc.iceGatheringState === 'complete' || t >= 3000 || (srflxAt && Date.now() - srflxAt >= 500) || (!srflxAt && t >= 1500)) { go(); return; }
    clearTimeout(e.timer);
    const next = srflxAt ? 500 - (Date.now() - srflxAt) : 1500 - t;
    e.timer = setTimeout(check, Math.max(10, Math.min(next, 3000 - t)));
  };
  e.pc.onicecandidate = (ev) => {
    if (ev.candidate && / typ srflx/.test(ev.candidate.candidate) && !srflxAt) srflxAt = Date.now();
    if (!ev.candidate) go(); else check();
  };
  e.pc.onicegatheringstatechange = () => { if (e.pc.iceGatheringState === 'complete') go(); };
  check();
}

async function dial({ peer, sid, ice, offer }) {
  if (typeof peer !== 'string' || typeof sid !== 'string') return;
  hangup(peer, sid);
  const hideIp = !!S.p2p?.hideIp && (ice || []).some((s) => [].concat(s.urls || []).some((u) => /^turns?:/.test(u)));
  const pc = new RTCPeerConnection({ iceServers: Array.isArray(ice) ? ice : [], ...(hideIp ? { iceTransportPolicy: 'relay' } : {}) });
  const dc = pc.createDataChannel('snug', { negotiated: true, id: 0, ordered: true });
  const e = { pc, dc, timer: null };
  pcs.set(keyOf(peer, sid), e);
  dc.bufferedAmountLowThreshold = 256 * 1024;
  dc.onopen = () => sendOp('peer.open', { peer, sid });
  dc.onmessage = (m) => deliver(peer, sid, m.data);
  dc.onbufferedamountlow = () => { if (e.busy) { e.busy = false; sendOp('peer.drain', { peer, sid }); } };
  dc.onclose = () => { if (pcs.get(keyOf(peer, sid)) === e) hangup(peer, sid, true); };
  pc.oniceconnectionstatechange = () => { if (pc.iceConnectionState === 'failed') hangup(peer, sid, true); };
  try {
    if (offer) {
      await pc.setRemoteDescription({ type: 'offer', sdp: offer });
      await pc.setLocalDescription(await pc.createAnswer());
    } else await pc.setLocalDescription(await pc.createOffer());
    whenGathered(e, (sdp) => sendOp('peer.sdp', { peer, sid, sdp }));
  } catch { hangup(peer, sid, true); }
}

on('peer.dial', (d) => { dial(d); });
on('peer.answer', async ({ peer, sid, sdp }) => {
  const e = pcs.get(keyOf(peer, sid));
  if (!e) return;
  try { await e.pc.setRemoteDescription({ type: 'answer', sdp }); } catch { hangup(peer, sid, true); }
});
on('peer.out', ({ peer, sid, fs }) => {
  const e = pcs.get(keyOf(peer, sid));
  if (!e || e.dc.readyState !== 'open') { sendOp('peer.closed', { peer, sid }); return; }
  for (const f of fs || []) {
    if (e.dc.bufferedAmount > 1024 * 1024) { e.busy = true; sendOp('peer.busy', { peer, sid }); return; }
    try { e.dc.send(f); } catch { hangup(peer, sid, true); return; }
  }
});
on('peer.hangup', ({ peer, sid }) => hangup(peer, sid));
// Fresh TURN credentials for calls with friends on other PCs (server/peer.js), and P2P state changes.
on('ice', (d) => { if (Array.isArray(d?.ice)) { S.ice = d.ice; S.iceExp = d.iceExp || null; } });
on('p2p', (d) => { S.p2p = { ...(S.p2p || {}), ...d }; emit(); });

// Offer to host links whenever the socket (re)opens. The server accepts it only from this PC.
const volunteer = () => sendOp('peer.host', { on: true, desktop: !!window.snugApp });
on('open', volunteer);
on('close', () => { for (const k of [...pcs.keys()]) { const [peer, sid] = k.split('|'); hangup(peer, sid); } });
volunteer();
