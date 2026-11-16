// The server owner's password reset (v0.12): npm run reset-password -- <username> [--two-factor]
//
// For someone who lost both their password and their recovery key, after the
// owner has checked who is asking (Snug can't do that part). It sets a random
// temporary password, signs out every device, removes the account's passkeys
// and recovery key (either could be someone else's) and, with --two-factor,
// turns off two-factor sign-in. The temporary password
// is printed once to this terminal and never logged. It can't bring back
// end-to-end encrypted history: the server never had the recovery key.
//
// Safe to run while the server runs (SQLite allows it); the person's open
// windows sign out at their next check, within a minute.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { openDb } from '../db.js';
import { hashPassword } from '../auth.js';

const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o, 1/l/i
// 16 unbiased characters (about 79 bits), in groups of four.
function tempPassword() {
  let s = '';
  while (s.length < 16) for (const x of randomBytes(16)) if (x < 248 && s.length < 16) s += ALPHA[x % 31];
  return s.match(/.{4}/g).join('-');
}
const has = (db, table) => !!db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", table);

/** { password, handle, passkeys, twoFactor, recovery } or throws with a message for the owner. */
export function resetPassword(db, handle, { twoFactor = false } = {}) {
  const h = String(handle || '').trim().toLowerCase().replace(/^@/, '');
  const user = db.get('SELECT id, handle, pass, deleted FROM users WHERE handle = ?', h);
  if (!user || user.deleted) throw new Error(`No account is called @${h} on this server.`);
  if (user.pass === '!') throw new Error(`@${h} has no password here (a friend on another PC, a bot, or a desktop account that signs in with GitHub or a recovery key). Nothing was changed.`);
  const password = tempPassword();
  const pass = hashPassword(password);
  let passkeys = 0, totp = false, recovery = false;
  db.tx(() => {
    db.run('UPDATE users SET pass = ? WHERE id = ?', pass, user.id);
    db.run('DELETE FROM sessions WHERE user = ?', user.id);
    if (has(db, 'push_subs')) db.run('DELETE FROM push_subs WHERE user = ?', user.id);
    if (has(db, 'passkeys')) { passkeys = db.run('DELETE FROM passkeys WHERE user = ?', user.id).changes; db.run('DELETE FROM passkey_users WHERE user = ?', user.id); }
    if (twoFactor && has(db, 'totp')) totp = db.run('DELETE FROM totp WHERE user = ?', user.id).changes > 0;
    // The recovery key resets the password too: one someone else made would undo this reset.
    if (has(db, 'recovery')) {
      recovery = !!db.get('SELECT 1 AS x FROM recovery WHERE user = ? AND used IS NULL', user.id);
      db.run('DELETE FROM recovery WHERE user = ?', user.id);
    }
    if (has(db, 'auth_events')) db.run("INSERT INTO auth_events (ts, user, event, ok, ip, agent, why) VALUES (?, ?, 'password.reset.owner', 1, '', 'server owner', ?)", Date.now(), user.id, totp ? 'two-factor-reset' : null);
  });
  return { password, handle: user.handle, passkeys, twoFactor: totp, recovery };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const handle = args.find((a) => !a.startsWith('--'));
  if (!handle) {
    console.error('Usage: npm run reset-password -- <username> [--two-factor]');
    process.exit(2);
  }
  const dataDir = process.env.SNUG_DATA || fileURLToPath(new URL('../../data', import.meta.url));
  const db = openDb(join(dataDir, 'snug.db'));
  try {
    const r = resetPassword(db, handle, { twoFactor: args.includes('--two-factor') });
    console.log(`@${r.handle} can sign in with this temporary password. It is shown only now:`);
    console.log('');
    console.log(`  ${r.password}`);
    console.log('');
    console.log('Every device was signed out.');
    if (r.passkeys) console.log(`${r.passkeys} passkey${r.passkeys === 1 ? ' was' : 's were'} removed.`);
    if (r.twoFactor) console.log('Two-factor sign-in was turned off.');
    if (r.recovery) console.log('Their recovery key was deleted (in case someone else made it).');
    console.log('Tell them to change it in Settings > Account and security, and to make a new recovery key there.');
    console.log('If they used end-to-end encrypted conversations, a reset can’t bring back what they could read before.');
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  } finally { db.close(); }
}
