// The words Snug uses for who can see what (js/lib/privacy.js): true for the
// mode the app is in, and never a promise it can't keep.
import test from 'node:test';
import assert from 'node:assert/strict';
import { whoSeesWhat, keptFor, snugAt } from '../js/lib/privacy.js';

const text = (s) => s.flatMap((x) => [x.title, ...x.items]).join('\n');

test('host mode names this Snug and says its owner can read rooms; DMs follow the encryption state', () => {
  const plain = text(whoSeesWhat({ mode: 'host', host: 'chat.example.org' }));
  assert.match(plain, /stored on the server this Snug at chat\.example\.org runs on/);
  assert.match(plain, /Whoever runs it can read houses and rooms/);
  assert.match(plain, /Direct messages are stored on the same server and are not end-to-end encrypted/);
  assert.doesNotMatch(plain, /travel encrypted between your PC/);
  const enc = text(whoSeesWhat({ mode: 'host', host: 'chat.example.org', e2ee: true }));
  assert.match(enc, /marked “End-to-end encrypted” can be read only on the devices of the people in them/);
  assert.match(enc, /still sees who talks to whom/);
});

test('desktop P2P mode: encrypted between PCs, stored on each PC, and what the directory and Cloudflare see', () => {
  const t = text(whoSeesWhat({ mode: 'p2p', turn: true }));
  assert.match(t, /travel encrypted between your PC and theirs/);
  assert.match(t, /stored readable on each PC/);
  assert.match(t, /which accounts are your friends or share a group with you/);
  assert.match(t, /key to your data file \(\.snugvault\), wrapped/);
  assert.match(t, /Cloudflare/);
  assert.match(t, /Links friends send don’t get a preview unless you turn that on/);
  assert.doesNotMatch(t, /stored on the server this Snug/);
});

test('no mode ever claims anonymity or immunity, and every mode says there are no diagnostics', () => {
  for (const mode of ['host', 'p2p']) for (const e2ee of [false, true]) {
    const t = text(whoSeesWhat({ mode, e2ee, host: 'x.example' }));
    assert.match(t, /Snug is not anonymous/);
    assert.match(t, /no analytics, diagnostics or crash reports/);
    assert.doesNotMatch(t, /unhackable|only you can read|completely private|can’t be hacked/i);
    assert.equal(t.match(/anonymous/gi).length, 1, 'only in “not anonymous”');
  }
});

test('plain http is called out, and the presence line follows the setting', () => {
  assert.match(text(whoSeesWhat({ mode: 'host', https: false })), /plain connection \(http\)/);
  assert.match(text(whoSeesWhat({ presenceTo: 'friends' })), /Only your friends see when you’re online/);
  // review-media 6: what the setting covers, and what stays visible, in plain words.
  assert.match(text(whoSeesWhat({ presenceTo: 'friends' })), /your status.*voice room.*when each message was sent/);
  assert.match(text(whoSeesWhat({ presenceTo: 'nobody' })), /Nobody sees when you’re online/);
  assert.equal(snugAt(''), 'this Snug');
});

test('retention lines come from the server’s numbers', () => {
  const t = keptFor({ logDays: 7, failureHours: 48, undoMinutes: 11, sessionDays: 30, idleDays: 14, backupDays: 7 }).join('\n');
  assert.match(t, /Sign-in history and security events: 7 days/);
  assert.match(t, /30 days at most, or 14 days unused/);
  assert.match(t, /Encrypted backups of the database are kept for 7 days/);
  assert.doesNotMatch(keptFor({ logDays: 30 }).join('\n'), /backups/);
});
