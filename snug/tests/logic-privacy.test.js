// The words Snug uses for who can see what (js/lib/privacy.js): true for the
// mode the app is in, and never a promise it can't keep.
import test from 'node:test';
import assert from 'node:assert/strict';
import { whoSeesWhat, keptFor, snugAt, lastActive } from '../js/lib/privacy.js';

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

// 0.14 tracking track: the whole list of what the server keeps, with the windows it really purges at.
const ABOUT = { mode: 'host', logDays: 14, failureHours: 48, undoMinutes: 11, sessionDays: 30, idleDays: 14, memberLogDays: 90, linkCacheHours: 24, friendCooldownHours: 24, activity: 'day', pushTtlHours: 24 };
test('0.14 what Snug stores lists call records, the house join log, link previews, push addresses, reactions and reads, and day-only activity', () => {
  const t = keptFor(ABOUT).join('\n');
  assert.match(t, /Sign-in history and security events: 14 days/);
  assert.match(t, /Call records .*who called.*answered.*how long/);
  assert.match(t, /joins or leaves a house: 90 days/);
  assert.match(t, /Link previews: .*24 hours/);
  assert.match(t, /push address.*until that sign-in ends.*24 hours/);
  assert.match(t, /Reactions, where you’ve read up to, pins and saved messages/);
  assert.match(t, /last used: the day only/);
  assert.match(t, /Friend requests that were declined or taken back: 24 hours/);
  assert.match(t, /GIF searches/);
  // End-to-end encryption: what the server can still see, said plainly.
  assert.match(keptFor(ABOUT, { e2ee: true }).join('\n'), /who is mentioned/);
  // Encryption device records are not purged: they stay until removed or reset, and removed ones stay listed.
  assert.match(keptFor(ABOUT, { e2ee: true }).join('\n'), /Encryption device records.*until the device is removed or encryption is reset.*removed devices stay listed/i);
  // GIF results can sit in the directory's Cloudflare cache, keyed by the words searched.
  assert.match(t, /GIF searches.*cached for an hour.*Cloudflare cache, keyed by the words searched.*not saved in the database/);
  assert.doesNotMatch(t, /kept in memory for an hour/);
  // The desktop app: update checks and the directory.
  const d = keptFor(ABOUT, { desktopApp: true, updates: 'notify' }).join('\n');
  assert.match(d, /GitHub sees your internet address/);
  assert.match(d, /once a day/);
  assert.match(keptFor(ABOUT, { desktopApp: true, updates: 'manual' }).join('\n'), /only when you ask/);
  assert.match(keptFor({ ...ABOUT, mode: 'desktop' }, { p2p: true }).join('\n'), /directory.*keyed hash.*2 days/);
});

test('0.14 STUN: Google is named as a third party with the way to turn it off; with a TURN relay, the relay is asked and its operator isn’t guessed', () => {
  const g = text(whoSeesWhat({ mode: 'host', stun: 'google' }));
  assert.match(g, /Google/);
  assert.match(g, /SNUG_STUN=none/);
  const r = text(whoSeesWhat({ mode: 'host', stun: 'relay', turn: true }));
  assert.doesNotMatch(r, /Google/);
  assert.match(r, /relay server/);
  // The server can't know who runs the relay (it may be a hosted one), so it doesn't say no outside company is asked.
  assert.doesNotMatch(r, /no outside company/);
  assert.match(r, /whoever runs that relay sees your address/i);
  assert.match(text(whoSeesWhat({ mode: 'p2p', turn: true })), /STUN/);
});

test('0.14 last active: today, or the date only', () => {
  const now = Date.UTC(2026, 10, 16, 15, 30);
  assert.equal(lastActive(Date.UTC(2026, 10, 16), now), 'Active today');
  assert.match(lastActive(Date.UTC(2026, 10, 2), now), /^Last active .*2/);
  assert.doesNotMatch(lastActive(Date.UTC(2026, 10, 2), now), /:/, 'no time of day');
});

test('0.14 README: the SNUG_LOG_DAYS default matches the code, and encryption device records are not said to expire with sign-in', async () => {
  const { readFileSync } = await import('node:fs');
  const { LOG_DAYS } = await import('../server/privacy.js');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const row = readme.split('\n').find((l) => l.startsWith('| `SNUG_LOG_DAYS`'));
  assert.match(row, new RegExp(`\\| \`${LOG_DAYS}\``));
  assert.doesNotMatch(readme, /Signed-in devices and encryption keys: until signed out/);
  assert.doesNotMatch(readme, /cached in memory for an hour, not stored/);
});
