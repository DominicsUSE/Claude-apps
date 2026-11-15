// The browser side of passkeys (js/lib/webauthn.js): the base64url fallback for browsers without
// the JSON helpers, and the honest words for the browser's own refusals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { _test, passkeysHere, passkeyProblem } from '../js/lib/webauthn.js';

test('webauthn lib: base64url round trip matches Node for every length and byte', () => {
  for (let n = 0; n < 70; n++) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255);
    const text = _test.toB64u(bytes.buffer);
    assert.equal(text, Buffer.from(bytes).toString('base64url'));
    assert.deepEqual(new Uint8Array(_test.fromB64u(text)), bytes);
  }
  assert.equal(_test.toB64u(null), null, 'a missing userHandle stays missing');
});

test('webauthn lib: no passkeys where the platform has none; refusals in plain words', () => {
  assert.equal(passkeysHere(), false);
  assert.match(passkeyProblem({ name: 'NotAllowedError' }), /wasn’t used/);
  assert.match(passkeyProblem({ name: 'InvalidStateError' }), /already has a passkey/);
  assert.match(passkeyProblem({ name: 'SecurityError' }), /HTTPS with a domain name/);
});
