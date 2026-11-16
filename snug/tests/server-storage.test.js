// Stored data at rest (0.14 storage track): no plaintext database copies left behind (S2), and attachment
// files encrypted on disk (S1, server/filecrypt.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync, statSync, utimesSync, rmSync, openSync, readSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDb } from '../server/db.js';
import { snapshot, restoreIfDamaged, cleanupDataDir, backupDir, openDamaged } from '../server/dbbackup.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'snug-storage-'));

// Every file under dir (recursively) that starts like an SQLite database.
function sqliteFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { out.push(...sqliteFiles(p)); continue; }
    const fd = openSync(p, 'r');
    const b = Buffer.alloc(16);
    try { readSync(fd, b, 0, 16, 0); } finally { closeSync(fd); }
    if (b.toString('latin1') === 'SQLite format 3\u0000') out.push(p);
  }
  return out;
}

test('S2: after a restore, the damaged database is sealed with the backup key; no readable copy stays in the data folder', () => {
  const dir = tmp();
  try {
    const key = randomBytes(32);
    const db = openDb(join(dir, 'snug.db'));
    db.run("INSERT INTO users (id, handle, name, pass, hue, created) VALUES ('u_dmg', 'dmg', 'Secret Name', '!', 10, 1)");
    snapshot({ raw: db.raw, dataDir: dir, dataKey: key });
    db.raw.close();
    // Damage the file but leave most of it readable (a bad disk sector), with a WAL next to it.
    const buf = readFileSync(join(dir, 'snug.db'));
    randomBytes(64).copy(buf, 100);
    writeFileSync(join(dir, 'snug.db'), buf);
    writeFileSync(join(dir, 'snug.db-wal'), Buffer.from('wal bytes with Secret Name inside'));
    const logs = [];
    const r = restoreIfDamaged({ dataDir: dir, dataKey: key, log: (...a) => logs.push(a.join(' ')) });
    assert.ok(r?.restored, 'restored');
    assert.ok(existsSync(r.damaged), 'the damaged copy is kept, sealed');
    assert.ok(r.damaged.startsWith(backupDir(dir)), 'in the backups folder');
    assert.ok(logs.some((l) => l.includes(r.damaged)), 'the log says where it is');
    const sealed = readFileSync(r.damaged);
    assert.ok(!sealed.includes(Buffer.from('Secret Name')), 'sealed: no plaintext rows');
    assert.ok(!sealed.includes(Buffer.from('SQLite format 3')));
    // Whoever holds the data key can still open it to look.
    assert.deepEqual(openDamaged({ path: r.damaged, dataKey: key }).subarray(0, 15).toString(), 'SQLite format 3');
    assert.throws(() => openDamaged({ path: r.damaged, dataKey: randomBytes(32) }));
    assert.deepEqual(readdirSync(dir).filter((n) => n.includes('damaged') || n.includes('.tmp-db')), [], 'nothing left beside snug.db');
    assert.ok(!readdirSync(backupDir(dir)).some((n) => n.endsWith('-wal') || n.includes('.part')), 'no plain WAL kept');
    assert.deepEqual(sqliteFiles(dir), [join(dir, 'snug.db')], 'the live database is the only readable SQLite file');
    const back = openDb(join(dir, 'snug.db'));
    assert.equal(back.get("SELECT name FROM users WHERE id = 'u_dmg'").name, 'Secret Name');
    back.raw.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('S2: cleanup seals a 0.13 plaintext damaged copy, removes stale restore temp files, and drops sealed copies after 7 days', () => {
  const dir = tmp();
  try {
    const key = randomBytes(32);
    const db = openDb(join(dir, 'snug.db'));
    db.run("INSERT INTO users (id, handle, name, pass, hue, created) VALUES ('u_old', 'old', 'Old Secret', '!', 10, 1)");
    db.raw.close();
    // What 0.13 left: snug.db.damaged-<time> (+ -wal, -shm) in plaintext, and a restore temp file from a crash.
    const plain = readFileSync(join(dir, 'snug.db'));
    writeFileSync(join(dir, 'snug.db.damaged-1700000000000'), plain);
    writeFileSync(join(dir, 'snug.db.damaged-1700000000000-wal'), 'old wal');
    writeFileSync(join(dir, '.restore-snug-x.db.snugbak.tmp-db'), plain);
    const db2 = openDb(join(dir, 'snug.db'));
    snapshot({ raw: db2.raw, dataDir: dir, dataKey: key });
    db2.raw.close();
    writeFileSync(join(backupDir(dir), '.snug-20260101-000000.db.snugbak.tmp-db'), plain); // a snapshot cut off by a crash
    const logs = [];
    const out = cleanupDataDir({ dataDir: dir, dataKey: key, log: (...a) => logs.push(a.join(' ')) });
    assert.equal(out.sealed.length, 2, 'the damaged file and its WAL are sealed');
    assert.deepEqual(readdirSync(dir).filter((n) => n.includes('damaged') || n.includes('.tmp-db')), []);
    assert.deepEqual(sqliteFiles(dir), [join(dir, 'snug.db')]);
    assert.ok(logs.some((l) => l.includes(out.sealed[0])), 'the log says where the sealed copy is');
    for (const p of out.sealed) assert.ok(!readFileSync(p).includes(Buffer.from('Old Secret')));
    // Seven days on, sealed damaged copies go too. Snapshots stay.
    const old = (Date.now() - 8 * 86_400_000) / 1000;
    for (const p of out.sealed) utimesSync(p, old, old);
    const later = cleanupDataDir({ dataDir: dir, dataKey: key });
    assert.equal(later.removed.length, 2);
    for (const p of out.sealed) assert.ok(!existsSync(p));
    assert.equal(readdirSync(backupDir(dir)).filter((n) => n.endsWith('.snugbak')).length, 1, 'the snapshot stays');
    // A data key that can't be used never seals (that would make the copy unreadable for good).
    writeFileSync(join(dir, 'snug.db.damaged-1700000000001'), plain);
    const none = cleanupDataDir({ dataDir: dir, dataKey: null });
    assert.equal(none.sealed.length, 0);
    assert.ok(statSync(join(dir, 'snug.db.damaged-1700000000001')).size > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
