// Local database snapshots and recovery (sec-registry REG-L6).
//
// The data file (server/vault.js) holds an account's friends and conversations across PCs, but not houses,
// people on this PC, local groups or settings: those live only in snug.db. This keeps a daily snapshot of
// the whole database and puts the newest good one back when snug.db is found damaged at start.
//
// - snapshot(): SQLite `VACUUM INTO` a temp file (a consistent copy while the server runs), checked with
//   PRAGMA integrity_check, then encrypted with AES-256-GCM under a key derived from the data key
//   (server/auth.js loadDataKey: SNUG_DATA_KEY or data/secret.key, wrapped by the OS key store on the
//   desktop). A copy of the backups folder alone is unreadable. The newest KEEP files are kept.
//   File: "SNUGBAK1" | iv(12) | ciphertext | tag(16); AAD = "snug-db-backup-v1\n" + file name.
// - restoreIfDamaged(): before the database is opened. When snug.db exists but can't be opened or fails
//   PRAGMA quick_check, the newest snapshot that decrypts and passes integrity_check takes its place. 0.14: the
//   damaged file (and its -wal, -shm) is sealed the same way into backups/damaged-<time>.snugdmg and the
//   plaintext removed, so no readable copy of the database is left beside the live one (openDamaged reads it).
// - cleanupDataDir(): at start. Seals plaintext damaged copies an older version left (snug.db.damaged-<time>),
//   removes restore and snapshot temp files a crash left, and deletes sealed damaged copies after 7 days.
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

export const KEEP = 7;
const MAGIC = Buffer.from('SNUGBAK1');
const NAME = /^snug-(\d{8}-\d{6})(?:-\d+)?\.db\.snugbak$/;
const DAMAGED = /^snug\.db\.damaged-(\d+)(-wal|-shm)?$/; // what 0.13 left, in plaintext
const SEALED_DAMAGED = /^damaged-\d+(?:-wal|-shm)?\.snugdmg$/;
export const DAMAGED_KEEP_MS = 7 * 86_400_000;
const rm = (f) => { try { unlinkSync(f); } catch { /* gone */ } };
const aad = (name) => Buffer.from(`snug-db-backup-v1\n${name}`);
export const backupKey = (dataKey) => createHmac('sha256', dataKey).update('snug:db-backup').digest();
export const backupDir = (dataDir) => join(dataDir, 'backups');

function stamp(t = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}-${p(t.getUTCHours())}${p(t.getUTCMinutes())}${p(t.getUTCSeconds())}`;
}
/** Snapshot files, newest first. */
export function snapshots(dataDir) {
  let names = [];
  try { names = readdirSync(backupDir(dataDir)); } catch { return []; }
  return names.filter((n) => NAME.test(n)).sort().reverse();
}
function check(path, pragma = 'integrity_check') {
  let d = null;
  try {
    d = new DatabaseSync(path, { readOnly: true });
    const rows = d.prepare(`PRAGMA ${pragma}`).all();
    return rows.length === 1 && Object.values(rows[0])[0] === 'ok';
  } catch { return false; } finally { try { d?.close(); } catch { /* closed */ } }
}
function seal(key, name, plain) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  c.setAAD(aad(name));
  return Buffer.concat([MAGIC, iv, c.update(plain), c.final(), c.getAuthTag()]);
}
function unseal(key, name, buf) {
  if (buf.length < MAGIC.length + 12 + 16 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a snapshot');
  const iv = buf.subarray(MAGIC.length, MAGIC.length + 12);
  const d = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  d.setAAD(aad(name));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([d.update(buf.subarray(MAGIC.length + 12, buf.length - 16)), d.final()]);
}

/** Write one encrypted, checked snapshot of the open database `raw` (a DatabaseSync). Returns its name. */
export function snapshot({ raw, dataDir, dataKey, keep = KEEP, now = new Date() }) {
  const dir = backupDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let name = `snug-${stamp(now)}.db.snugbak`;
  for (let i = 1; existsSync(join(dir, name)); i++) name = `snug-${stamp(now)}-${i}.db.snugbak`;
  const tmp = join(dir, `.${name}.tmp-db`);
  rm(tmp);
  try {
    raw.prepare('VACUUM INTO ?').run(tmp);
    if (!check(tmp)) throw new Error('snapshot failed its integrity check');
    const out = seal(backupKey(dataKey), name, readFileSync(tmp));
    writeFileSync(join(dir, `${name}.part`), out, { mode: 0o600 });
    renameSync(join(dir, `${name}.part`), join(dir, name));
  } finally { rm(tmp); }
  for (const old of snapshots(dataDir).slice(keep)) rm(join(dir, old));
  return name;
}

/**
 * Before openDb(): if <dataDir>/snug.db exists and is damaged, move it aside and put back the newest good
 * snapshot. Returns { restored: name, damaged: path } or null (nothing to do, or no good snapshot).
 */
export function restoreIfDamaged({ dataDir, dataKey, log = () => {} }) {
  const file = join(dataDir, 'snug.db');
  if (!existsSync(file) || statSync(file).size === 0 || check(file, 'quick_check')) return null;
  const key = backupKey(dataKey);
  for (const name of snapshots(dataDir)) {
    const tmp = join(dataDir, `.restore-${name}.tmp-db`);
    try {
      writeFileSync(tmp, unseal(key, name, readFileSync(join(backupDir(dataDir), name))), { mode: 0o600 });
      if (!check(tmp)) throw new Error('integrity');
      const t = Date.now();
      let damaged = null;
      // The damaged file and its -wal and -shm go before the snapshot takes its place (SQLite would apply an old WAL).
      for (const ext of ['', '-wal', '-shm']) {
        if (!existsSync(file + ext)) continue;
        let at;
        try { at = sealAside(dataDir, key, file + ext, `damaged-${t}${ext}.snugdmg`); } catch (e) {
          at = `${file}.damaged-${t}${ext}`; // can't seal (disk full): kept in plaintext; cleanupDataDir seals it later
          renameSync(file + ext, at);
          log('security', 'could not seal the damaged database copy', e.message);
        }
        if (!ext) damaged = at;
      }
      renameSync(tmp, file);
      log('security', 'snug.db was damaged; restored the snapshot', name, 'and kept the damaged file, sealed with the backup key, as', damaged);
      return { restored: name, damaged };
    } catch (e) {
      rm(tmp);
      log('security', 'snapshot not usable', name, e.message);
    }
  }
  log('security', 'snug.db looks damaged and no snapshot could be restored');
  return null;
}

// A plaintext file moved into the backups folder, sealed under the backup key (the original removed). Returns its path.
function sealAside(dataDir, key, src, name) {
  const dir = backupDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out = join(dir, name);
  try {
    writeFileSync(`${out}.part`, seal(key, name, readFileSync(src)), { mode: 0o600 });
    renameSync(`${out}.part`, out);
  } catch (e) { rm(`${out}.part`); throw e; }
  rm(src);
  return out;
}
/** The plaintext of a sealed damaged copy (backups/damaged-<time>.snugdmg), for whoever holds the data key. */
export function openDamaged({ path, dataKey }) { return unseal(backupKey(dataKey), basename(path), readFileSync(path)); }

/**
 * At start, before the database is used: no plaintext copy of the database stays behind. Seals damaged copies
 * an older version kept in plaintext (only with a usable data key), removes restore and snapshot temp files a
 * crash left, and deletes sealed damaged copies older than 7 days. Returns { sealed: [paths], removed: [paths] }.
 */
export function cleanupDataDir({ dataDir, dataKey, log = () => {}, now = Date.now() }) {
  const out = { sealed: [], removed: [] };
  const gone = (p) => { rm(p); if (!existsSync(p)) out.removed.push(p); };
  let names = [];
  try { names = readdirSync(dataDir); } catch { return out; }
  const key = dataKey ? backupKey(dataKey) : null;
  for (const n of names) {
    if (/^\.restore-.*\.tmp-db$/.test(n)) { gone(join(dataDir, n)); continue; }
    const m = DAMAGED.exec(n);
    if (!m || !key) continue;
    try {
      const at = sealAside(dataDir, key, join(dataDir, n), `damaged-${m[1]}${m[2] || ''}.snugdmg`);
      out.sealed.push(at);
      log('security', 'sealed a plaintext copy of a damaged database with the backup key:', n, 'is now', at);
    } catch (e) { log('security', 'could not seal', n, e.message); }
  }
  const dir = backupDir(dataDir);
  let inBackups = [];
  try { inBackups = readdirSync(dir); } catch { return out; }
  for (const n of inBackups) {
    const p = join(dir, n);
    if (n.endsWith('.tmp-db') || n.endsWith('.part')) { gone(p); continue; }
    if (!SEALED_DAMAGED.test(n)) continue;
    try { if (statSync(p).mtimeMs < now - DAMAGED_KEEP_MS) { gone(p); log('security', 'deleted a sealed damaged database copy older than 7 days:', p); } } catch { /* gone */ }
  }
  return out;
}

/** Daily snapshots for a running server. Returns { now(), stop() }. */
export function scheduleSnapshots({ raw, dataDir, dataKey, log = () => {}, everyMs = 86_400_000, firstMs = 10 * 60_000 }) {
  const run = () => {
    try { return snapshot({ raw, dataDir, dataKey }); } catch (e) { log('security', 'database snapshot failed', e.message); return null; }
  };
  // Due when the newest snapshot is older than a day (also across restarts).
  const due = () => {
    const m = NAME.exec(snapshots(dataDir)[0] || '');
    if (!m) return true;
    const s = m[1];
    const t = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15));
    return Date.now() - t >= everyMs;
  };
  const first = setTimeout(() => { if (due()) run(); }, firstMs);
  first.unref?.();
  const timer = setInterval(() => { if (due()) run(); }, Math.min(everyMs, 3600_000));
  timer.unref?.();
  return { now: run, stop() { clearTimeout(first); clearInterval(timer); } };
}
