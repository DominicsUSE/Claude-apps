// The proof of work a keypair sign-up needs (registry/src/keyacct.js): the lowest decimal nonce such that
// SHA-256("snug-pow-v1\n" + c + "\n" + ik + "\n" + nonce) starts with `bits` zero bits.
//
// It runs in a worker thread so the app stays responsive, with node:crypto's synchronous hash: one native
// call per try is many times faster than awaiting WebCrypto per try, and the result is the same SHA-256.
// The worker's code is passed inline (eval) rather than as a file, so it also works from the desktop
// app's packed archive. Expected time on an ordinary laptop: 2^20 tries, about a second.
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';

export const powInput = (c, ik, nonce) => `snug-pow-v1\n${c}\n${ik}\n${nonce}`;

export function zeroBits(d) {
  let n = 0;
  for (const b of d) {
    if (b === 0) { n += 8; continue; }
    return n + Math.clz32(b) - 24;
  }
  return n;
}

/** True when nonce does the work (used by tests, and to double-check the worker's answer). */
export const powOk = (c, ik, bits, nonce) => zeroBits(createHash('sha256').update(powInput(c, ik, nonce)).digest()) >= bits;

const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { createHash } = require('node:crypto');
const { c, ik, bits } = workerData;
const head = 'snug-pow-v1\\n' + c + '\\n' + ik + '\\n';
const full = bits >> 3, rest = bits & 7, mask = rest ? (0xff << (8 - rest)) & 0xff : 0;
for (let n = 0; n < Number.MAX_SAFE_INTEGER; n++) {
  const d = createHash('sha256').update(head + n).digest();
  let ok = true;
  for (let i = 0; i < full; i++) if (d[i] !== 0) { ok = false; break; }
  if (ok && rest && (d[full] & mask) !== 0) ok = false;
  if (ok) { parentPort.postMessage(String(n)); break; }
}
`;

/**
 * Solve a challenge. Resolves with the nonce (a decimal string); rejects with {cancelled: true} when
 * `signal` aborts (the worker is stopped at once).
 */
export function solvePow(c, ik, bits, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(Object.assign(new Error('cancelled'), { cancelled: true })); return; }
    const w = new Worker(WORKER, { eval: true, workerData: { c, ik, bits } });
    const stop = () => { w.terminate().catch(() => {}); reject(Object.assign(new Error('cancelled'), { cancelled: true })); };
    signal?.addEventListener('abort', stop, { once: true });
    w.once('message', (nonce) => {
      signal?.removeEventListener('abort', stop);
      w.terminate().catch(() => {});
      if (powOk(c, ik, bits, nonce)) resolve(nonce);
      else reject(new Error('proof of work failed'));
    });
    w.once('error', (e) => { signal?.removeEventListener('abort', stop); reject(e); });
  });
}
