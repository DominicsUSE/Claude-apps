// A software passkey authenticator for tests (v0.12): makes the same JSON a browser's
// PublicKeyCredential.toJSON() gives, for "none" attestation, with a P-256 or Ed25519 key.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const sha256 = (b) => createHash('sha256').update(b).digest();
const b64u = (b) => Buffer.from(b).toString('base64url');

// CBOR: just what attestation objects and COSE keys need.
export function cbor(v) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
  };
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  if (v === true) return Buffer.from([0xf5]);
  if (v === false) return Buffer.from([0xf4]);
  throw new Error('cbor: unsupported');
}

export function makeAuthenticator({ kind = 'p256', uv = true, up = true, synced = false } = {}) {
  const pair = kind === 'ed25519' ? generateKeyPairSync('ed25519') : generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  const cose = kind === 'ed25519'
    ? new Map([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(jwk.x, 'base64url')]])
    : new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]);
  const id = randomBytes(16);
  const a = { id: b64u(id), counter: 0, userHandle: null, uv, up, synced, step: synced ? 0 : 1 };
  const flags = (at) => (a.up ? 0x01 : 0) | (a.uv ? 0x04 : 0) | (a.synced ? 0x18 : 0) | (at ? 0x40 : 0);
  const authData = (rpId, at) => {
    const c = Buffer.alloc(4); c.writeUInt32BE(a.counter);
    const parts = [sha256(rpId), Buffer.from([flags(at)]), c];
    if (at) { const len = Buffer.alloc(2); len.writeUInt16BE(id.length); parts.push(Buffer.alloc(16), len, id, cbor(cose)); }
    return Buffer.concat(parts);
  };
  const clientData = (type, challenge, origin, extra = {}) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false, ...extra }));
  // navigator.credentials.create() with options from the server.
  a.create = (options, { origin, rpId = options.rp.id, clientExtra } = {}) => {
    a.userHandle = options.user.id;
    const cd = clientData('webauthn.create', options.challenge, origin, clientExtra);
    const att = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData(rpId, true)]]));
    return { id: a.id, rawId: a.id, type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {}, response: { clientDataJSON: b64u(cd), attestationObject: b64u(att), transports: ['internal'] } };
  };
  // navigator.credentials.get() with options from the server.
  a.get = (options, { origin, rpId = options.rpId, counter } = {}) => {
    a.counter = counter ?? a.counter + a.step;
    const cd = clientData('webauthn.get', options.challenge, origin);
    const ad = authData(rpId, false);
    const sig = sign(kind === 'ed25519' ? null : 'sha256', Buffer.concat([ad, sha256(cd)]), pair.privateKey);
    return { id: a.id, rawId: a.id, type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {}, response: { clientDataJSON: b64u(cd), authenticatorData: b64u(ad), signature: b64u(sig), userHandle: a.userHandle } };
  };
  return a;
}
