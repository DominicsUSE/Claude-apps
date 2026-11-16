// The call's media encryption worker (calls C1). One per call. Every sender
// and receiver of every connection pipes its encoded frames through here:
// RTCRtpScriptTransform where the browser has it, or the streams of
// createEncodedStreams handed over from the page. js/lib/callcrypt.js does the
// sealing; js/voice.js tells this worker which keys to use. Keys arrive as
// raw bytes and are zeroed as soon as they are imported (non-extractable).
import { FrameCrypto, clearBytes } from './lib/callcrypt.js';

const fc = new FrameCrypto();
// Video receivers that dropped frames (no key yet, or a damaged frame): asked
// for a fresh key frame once frames open again, so the picture recovers quickly.
const stale = new Set();

function pipe(readable, writable, opts, transformer = null) {
  const { dir, peer, kind } = opts || {};
  const t = new TransformStream({
    async transform(frame, ctl) {
      let meta = {};
      try { meta = frame.getMetadata?.() || {}; } catch { /* older browsers */ }
      const clear = clearBytes({ kind, type: frame.type, mime: meta.mimeType });
      const data = new Uint8Array(frame.data);
      const r = dir === 'send' ? await fc.encrypt(peer, data, clear) : await fc.decrypt(peer, data, clear);
      if (!r.data) { if (kind === 'video') stale.add(transformer || opts); return; }
      if (r.data !== data) frame.data = r.data.buffer.byteLength === r.data.length ? r.data.buffer : r.data.slice().buffer;
      if (r.e2ee && dir === 'recv' && stale.delete(transformer || opts)) { try { transformer?.sendKeyFrameRequest?.(); } catch { /* the decoder asks by itself */ } }
      ctl.enqueue(frame);
    },
  });
  readable.pipeThrough(t).pipeTo(writable).catch(() => { /* the connection closed */ });
}

// RTCRtpScriptTransform: the browser hands over each sender's or receiver's frames.
self.onrtctransform = (e) => { const tr = e.transformer; pipe(tr.readable, tr.writable, tr.options, tr); };

// One message at a time, in order: a key is in place before the message that uses it.
let queue = Promise.resolve();
self.onmessage = ({ data: m }) => { queue = queue.then(() => handle(m)); };
async function handle(m) {
  if (!m || typeof m !== 'object') return;
  try {
    if (m.t === 'streams') pipe(m.readable, m.writable, m.opts);
    else if (m.t === 'send') await fc.setSendKey(m.id, new Uint8Array(m.raw));
    else if (m.t === 'use') fc.useFor(m.peer, m.id);
    else if (m.t === 'recv') { await fc.addRecvKey(m.peer, m.id, new Uint8Array(m.raw)); self.postMessage({ t: 'done', req: m.req }); }
    else if (m.t === 'drop') fc.dropPeer(m.peer);
    else if (m.t === 'wipe') fc.wipe();
    else if (m.t === 'tamper') { if (m.on) fc.tamper.add(m.peer); else fc.tamper.delete(m.peer); }
    else if (m.t === 'stats') self.postMessage({ t: 'stats', req: m.req, stats: fc.stats() });
  } catch { if (m.t === 'stats' || m.t === 'recv') self.postMessage({ t: m.t === 'stats' ? 'stats' : 'done', req: m.req, stats: {}, failed: true }); }
}
