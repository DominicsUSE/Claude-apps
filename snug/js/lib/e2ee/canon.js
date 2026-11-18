// Canonical JSON for everything end-to-end encryption signs or binds: keys
// sorted, no undefined, finite numbers, depth at most 8, and no keys that
// could reach an object's prototype. The same algorithm as canon() in
// server/peercrypto.js (P2P), kept separate so neither side can change the
// other's signatures; tests/logic-e2ee.test.js checks they agree.

const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function canon(v, depth = 0) {
  if (depth > 8) throw new Error('too deep');
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('bad number'); return JSON.stringify(v); }
  if (Array.isArray(v)) return `[${v.map((x) => canon(x, depth + 1)).join(',')}]`;
  const proto = typeof v === 'object' ? Object.getPrototypeOf(v) : undefined;
  if (proto === Object.prototype || proto === null) {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    for (const k of keys) if (BAD_KEYS.has(k)) throw new Error('bad key');
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(v[k], depth + 1)}`).join(',')}}`;
  }
  throw new Error('not canonical');
}

/** Parse JSON text of at most `max` UTF-8 bytes that canon() accepts, or null. */
export function parseCanon(text, max = 64 * 1024) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > max) return null;
  try { const v = JSON.parse(text); canon(v); return v; } catch { return null; }
}

/** The object without its signature, for signing and checking. */
export function unsigned(obj) {
  const { sig, ...rest } = obj; // eslint-disable-line no-unused-vars
  return rest;
}
