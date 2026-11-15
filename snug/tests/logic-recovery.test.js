// The recovery key format (js/lib/recovery.js): round trip, typos caught, misreads mapped,
// derivations separate and stable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newRecoveryKey, formatRecoveryKey, parseRecoveryKey, deriveAuthKey, deriveP2pSeed, deriveBackupKey, recoveryFileText } from '../js/lib/recovery.js';

const hex = (u) => Buffer.from(u).toString('hex');
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

test('recovery key: 36 characters in 9 groups, round trip, random', async () => {
  const a = await newRecoveryKey();
  const b = await newRecoveryKey();
  assert.match(a.text, /^([A-Z2-7]{4}-){8}[A-Z2-7]{4}$/);
  assert.notEqual(a.text, b.text);
  const p = await parseRecoveryKey(a.text);
  assert.equal(hex(p.raw), hex(a.raw));
  // Case, spaces and missing dashes don't matter.
  assert.equal(hex((await parseRecoveryKey(a.text.toLowerCase().replace(/-/g, ' '))).raw), hex(a.raw));
});

test('recovery key: any single changed character is caught; misreads 0 1 8 are mapped', async () => {
  const raw = new Uint8Array(20).map((_, i) => (i * 37 + 11) & 255);
  const text = await formatRecoveryKey(raw);
  const flat = text.replace(/-/g, '');
  let caught = 0, tried = 0;
  for (let i = 0; i < flat.length; i++) {
    for (const c of B32) {
      if (c === flat[i]) continue;
      tried += 1;
      const r = await parseRecoveryKey(flat.slice(0, i) + c + flat.slice(i + 1));
      if (r.error === 'check') caught += 1;
    }
  }
  assert.equal(caught, tried, 'every single-character change is caught by the check characters');
  assert.equal((await parseRecoveryKey(flat.slice(1))).error, 'length');
  assert.equal((await parseRecoveryKey(`${flat.slice(0, 35)}!`)).error, 'chars');
  // A key that happens to contain O, I or B, typed as 0, 1, 8.
  const withO = flat.replace(/O/g, '0').replace(/I/g, '1').replace(/B/g, '8');
  assert.equal(hex((await parseRecoveryKey(withO)).raw), hex(raw));
});

test('recovery key: derivations are separate, 32 bytes and stable (fixed vectors)', async () => {
  const raw = new Uint8Array(20).fill(7);
  const [a, p, k] = await Promise.all([deriveAuthKey(raw), deriveP2pSeed(raw), deriveBackupKey(raw)]);
  for (const x of [a, p, k]) assert.equal(x.length, 32);
  assert.notEqual(hex(a), hex(p));
  assert.notEqual(hex(a), hex(k));
  assert.notEqual(hex(p), hex(k));
  // The same as Node's own HKDF (an independent implementation).
  const { hkdfSync } = await import('node:crypto');
  const ref = (info) => Buffer.from(hkdfSync('sha256', Buffer.from(raw), Buffer.from('snug-recovery'), Buffer.from(info), 32)).toString('hex');
  assert.equal(hex(a), ref('web-auth-v1'));
  assert.equal(hex(p), ref('p2p-rk-ed25519-v1'));
  assert.equal(hex(k), ref('e2ee-backup-v1'));
});

test('recovery file text names the account and says the key can’t be reset', async () => {
  const t = recoveryFileText({ text: 'ABCD-EFGH', username: 'robin', date: new Date('2026-11-15T00:00:00Z') });
  assert.match(t, /ABCD-EFGH/);
  assert.match(t, /@robin/);
  assert.match(t, /2026-11-15/);
  assert.match(t, /can’t reset this key/);
});
