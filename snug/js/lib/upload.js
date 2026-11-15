// Big uploads from the browser: the client half of server/uploads.js.
// A file over 8 MB goes up in parts (the server says how big), each part only
// once the one before it is stored, so a dropped connection costs one part:
// the next try asks the server how much it has and carries on from there.
// Pure apart from the fetch it is given, so it runs in tests too.
import { fileSize } from './util.js';

const MB = 1024 * 1024;
export const CHUNK_OVER = 8 * MB;
const TRIES = 8; // failed parts in a row before giving up (about a minute and a half of backoff)

export const needsChunks = (size) => size > CHUNK_OVER;

// "600 KB", "100 MB", "2 GB": the same wording as the server's messages.
export function limitText(n) {
  if (n >= 1024 * MB) return `${Math.round((n / (1024 * MB)) * 10) / 10} GB`;
  if (n >= MB) return `${Math.round((n / MB) * 10) / 10} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

const backoff = (n) => new Promise((r) => setTimeout(r, Math.min(15000, 500 * 2 ** n)));
const abortError = () => Object.assign(new Error('Upload cancelled.'), { name: 'AbortError' });

// The server's limits, once per page: { maxFile, chunk }.
export async function fetchLimits(fetchFn) {
  try {
    const r = await fetchFn('/api/uploads', { credentials: 'same-origin' });
    if (r.ok) { const d = await r.json(); if (d.maxFile && d.chunk) return d; }
  } catch { /* offline: the server checks again anyway */ }
  return null;
}

// Uploads `blob` as `name` into conversation `conv` in parts. Resolves the
// stored file ({ id, name, size, kind }), or rejects with a message for people
// (an AbortError when `signal` aborts). onProgress(0..1) after each part.
// enc: the bytes are already encrypted on this device (an end-to-end encrypted conversation); the server
// stores them as an opaque blob, and allows the 16 bytes AES-GCM adds on top of its file limit.
export async function uploadBlob({ fetch: fetchFn, conv, blob, name, type = blob.type, onProgress = () => {}, signal, limits, wait = backoff, enc = false }) {
  const L = limits || (await fetchLimits(fetchFn)) || { maxFile: 10 * MB, chunk: 4 * MB };
  if (blob.size > L.maxFile + (enc ? 16 : 0)) throw new Error(`${name} is ${fileSize(blob.size)}. Files can be up to ${limitText(L.maxFile)} here.`);
  const call = async (path, init = {}) => {
    if (signal?.aborted) throw abortError();
    const res = await fetchFn(path, { credentials: 'same-origin', signal, ...init });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  };
  let begun;
  try {
    begun = await call('/api/uploads', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(enc ? { conv, name: 'file', size: blob.size, type: 'application/octet-stream', enc: true } : { conv, name, size: blob.size, type: type || 'application/octet-stream' }),
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error(`Couldn’t upload ${name}. Check your connection and try again.`);
  }
  if (!begun.res.ok) throw new Error(begun.data.error || `Couldn’t upload ${name}.`);
  const { id } = begun.data;
  const chunk = begun.data.chunk || L.chunk;
  const base = `/api/uploads/${id}`;
  const cancel = () => fetchFn(`${base}/cancel`, { method: 'POST', credentials: 'same-origin' }).catch(() => {});

  let received = begun.data.received || 0;
  let fails = 0;
  onProgress(received / blob.size);
  try {
    while (received < blob.size) {
      let r;
      try {
        r = await call(`${base}?offset=${received}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: blob.slice(received, received + chunk) });
      } catch (e) {
        if (e.name === 'AbortError' || signal?.aborted) throw abortError();
        // Lost the connection mid-part: wait, ask where the server got to, carry on.
        if (++fails >= TRIES) throw new Error(`${name} stopped uploading: the connection keeps dropping. Try again when it’s steadier.`);
        await wait(fails);
        try { const s = await call(base); if (s.res.ok) received = s.data.received; } catch (e2) { if (e2.name === 'AbortError') throw abortError(); }
        continue;
      }
      if (r.res.status === 409 && Number.isSafeInteger(r.data.received)) { received = r.data.received; continue; }
      if (!r.res.ok) throw Object.assign(new Error(r.data.error || `Couldn’t upload ${name}.`), { final: true });
      received = r.data.received;
      fails = 0;
      onProgress(received / blob.size);
    }
    const done = await call(`${base}/done`, { method: 'POST' });
    if (!done.res.ok) throw Object.assign(new Error(done.data.error || `Couldn’t upload ${name}.`), { final: true });
    return done.data;
  } catch (e) {
    cancel();
    throw e;
  }
}
