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

// ---------- S1: attachment files at rest (server/filecrypt.js) ----------
import { useFilesKey, writeStoredSync, readStoredSync, readStoredRangeSync, readStored, copyStoredSync, sealFile, isSealed, storedSize, reencryptDir, SEG, MAGIC, _test as fc } from '../server/filecrypt.js';

test('S1: files are sealed in 64 KiB AES-GCM segments and read back whole or by range', async () => {
  const dir = tmp();
  try {
    const stop = useFilesKey(dir, randomBytes(32));
    for (const size of [0, 1, SEG - 1, SEG, SEG + 1, 3 * SEG + 17]) {
      const data = randomBytes(size);
      const p = join(dir, `f_size${size}`);
      writeStoredSync(p, data);
      const disk = readFileSync(p);
      assert.ok(disk.subarray(0, 6).equals(MAGIC), 'starts with SNUGF1');
      assert.equal(disk.length, fc.sealedLength(size));
      if (size >= 32) assert.ok(!disk.includes(data.subarray(0, 32)), 'no plaintext on disk');
      assert.equal((statSync(p).mode & 0o777).toString(8), '600');
      assert.ok(readStoredSync(p).equals(data));
      assert.ok((await readStored(p)).equals(data));
      assert.equal(storedSize(p), size);
      for (const [o, n] of [[0, 10], [SEG - 3, 6], [SEG, SEG], [size - 5, 100], [2 * SEG - 1, SEG + 2]]) {
        if (o < 0 || o >= size) continue;
        assert.ok(readStoredRangeSync(p, o, n).equals(data.subarray(o, o + n)), `range ${o}+${n} of ${size}`);
      }
    }
    // Two files never share a nonce prefix.
    writeStoredSync(join(dir, 'f_a1'), Buffer.alloc(10));
    writeStoredSync(join(dir, 'f_a2'), Buffer.alloc(10));
    assert.ok(!readFileSync(join(dir, 'f_a1')).subarray(14, 22).equals(readFileSync(join(dir, 'f_a2')).subarray(14, 22)));
    stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('S1: a tampered, truncated, reordered or renamed file is refused, never read as plaintext', () => {
  const dir = tmp();
  try {
    useFilesKey(dir, randomBytes(32));
    const data = randomBytes(3 * SEG);
    const p = join(dir, 'f_tamper01');
    writeStoredSync(p, data);
    const good = readFileSync(p);
    const flip = Buffer.from(good); flip[fc.HEAD + SEG + 16 + 5] ^= 1; // a byte in segment 1
    writeFileSync(p, flip);
    assert.ok(readStoredRangeSync(p, 0, 100).equals(data.subarray(0, 100)), 'segment 0 is still fine');
    assert.throws(() => readStoredRangeSync(p, SEG, 10), /damaged/);
    assert.throws(() => readStoredSync(p), /damaged/);
    writeFileSync(p, good.subarray(0, good.length - 1)); // cut short
    assert.throws(() => readStoredSync(p), /damaged/);
    const swapped = Buffer.from(good); // segments 0 and 1 swapped
    good.copy(swapped, fc.HEAD, fc.HEAD + SEG + 16, fc.HEAD + 2 * (SEG + 16));
    good.copy(swapped, fc.HEAD + SEG + 16, fc.HEAD, fc.HEAD + SEG + 16);
    writeFileSync(p, swapped);
    assert.throws(() => readStoredRangeSync(p, 0, 10), /damaged/);
    const size = Buffer.from(good); size.writeBigUInt64BE(BigInt(3 * SEG - 16), 22); // a smaller size claimed
    writeFileSync(p, size);
    assert.throws(() => readStoredSync(p));
    writeFileSync(join(dir, 'f_other001'), good); // the same bytes under another id
    assert.throws(() => readStoredSync(join(dir, 'f_other001')), /damaged/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('S1: legacy plaintext files stay readable; copies are sealed for their new id; re-encrypt seals old files', async () => {
  const dir = tmp();
  try {
    const legacy = Buffer.from('0.13 file in plaintext, still readable '.repeat(4000));
    writeFileSync(join(dir, 'f_legacy01'), legacy, { mode: 0o600 });
    writeFileSync(join(dir, 'f_magic001'), Buffer.concat([MAGIC, Buffer.from(' an old upload that happens to start with the magic')]));
    writeFileSync(join(dir, 'f_gone0001'), 'about to be deleted');
    writeFileSync(join(dir, 'f_x1.part'), 'a transfer in progress');
    useFilesKey(dir, randomBytes(32));
    assert.ok(readStoredSync(join(dir, 'f_legacy01')).equals(legacy));
    assert.ok(readStoredRangeSync(join(dir, 'f_legacy01'), 70_000, 50).equals(legacy.subarray(70_000, 70_050)));
    assert.match(readStoredSync(join(dir, 'f_magic001')).toString(), /happens to start/);
    // A copy of a legacy file is sealed.
    copyStoredSync(join(dir, 'f_legacy01'), join(dir, 'f_copy0001'));
    assert.ok(isSealed(join(dir, 'f_copy0001')));
    assert.ok(readStoredSync(join(dir, 'f_copy0001')).equals(legacy));
    // An assembled plaintext file is sealed into place and the plaintext removed.
    writeFileSync(join(dir, 'assembled'), legacy);
    await sealFile(join(dir, 'assembled'), join(dir, 'f_upload01'));
    assert.ok(!existsSync(join(dir, 'assembled')));
    assert.ok(isSealed(join(dir, 'f_upload01')));
    const r = await reencryptDir(dir, { keep: (n) => n !== 'f_gone0001' });
    assert.ok(r.sealed >= 2);
    assert.ok(isSealed(join(dir, 'f_legacy01')) && isSealed(join(dir, 'f_magic001')));
    assert.ok(readStoredSync(join(dir, 'f_legacy01')).equals(legacy), 'still the same bytes');
    assert.ok(!isSealed(join(dir, 'f_gone0001')), 'a file going away is left alone');
    assert.equal(readFileSync(join(dir, 'f_x1.part'), 'utf8'), 'a transfer in progress', 'part files untouched');
    assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.sealing')), [], 'no temp files left');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
