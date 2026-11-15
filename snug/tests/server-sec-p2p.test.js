// Security fixes for the P2P, vault and registry-client side (sec-registry). Each test failed before its fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startServer } from '../server/index.js';
import { openDb } from '../server/db.js';
import { snapshot, restoreIfDamaged, snapshots, backupDir, KEEP } from '../server/dbbackup.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'snug-secp2p-'));

// ---------- REG-L6: database snapshots and recovery ----------
test('REG-L6: an encrypted, checked snapshot; a damaged snug.db is restored from the newest good one', () => {
  const dir = tmp();
  const key = randomBytes(32);
  const db = openDb(join(dir, 'snug.db'));
  db.run("INSERT INTO users (id, handle, name, pass, hue, created) VALUES ('u_keep', 'keepme', 'Keep Me', '!', 10, 1)");
  const name = snapshot({ raw: db.raw, dataDir: dir, dataKey: key });
  const file = readFileSync(join(backupDir(dir), name));
  assert.equal(file.subarray(0, 8).toString(), 'SNUGBAK1');
  assert.ok(!file.includes(Buffer.from('Keep Me')), 'encrypted: no plain rows in the snapshot');
  assert.ok(!file.includes(Buffer.from('SQLite format 3')));
  db.raw.close();
  // Healthy: nothing happens.
  assert.equal(restoreIfDamaged({ dataDir: dir, dataKey: key }), null);
  // Damage the database (ransomware, a bad disk), then start: the snapshot comes back.
  const buf = readFileSync(join(dir, 'snug.db'));
  randomBytes(4096).copy(buf, 0);
  writeFileSync(join(dir, 'snug.db'), buf);
  assert.equal(restoreIfDamaged({ dataDir: dir, dataKey: randomBytes(32) }), null, 'the wrong key opens nothing');
  const r = restoreIfDamaged({ dataDir: dir, dataKey: key });
  assert.equal(r.restored, name);
  assert.ok(existsSync(r.damaged), 'the damaged file is kept aside');
  const back = openDb(join(dir, 'snug.db'));
  assert.equal(back.get("SELECT name FROM users WHERE id = 'u_keep'").name, 'Keep Me');
  back.raw.close();
});

test('REG-L6: at most 7 snapshots are kept, newest first', () => {
  const dir = tmp();
  const key = randomBytes(32);
  const db = openDb(join(dir, 'snug.db'));
  for (let i = 0; i < KEEP + 3; i++) snapshot({ raw: db.raw, dataDir: dir, dataKey: key, now: new Date(Date.UTC(2026, 0, 1 + i)) });
  const list = snapshots(dir);
  assert.equal(list.length, KEEP);
  assert.match(list[0], /^snug-20260110-/);
  assert.deepEqual(readdirSync(backupDir(dir)).filter((n) => !n.endsWith('.snugbak')), [], 'no temp files left');
  db.raw.close();
});

test('REG-L6: the server snapshots its database, and restores it at start when damaged', async () => {
  const dir = tmp();
  let srv = await startServer({ port: 0, dataDir: dir, quiet: true });
  srv.db.run("INSERT INTO users (id, handle, name, pass, hue, created) VALUES ('u_srv', 'srvkeep', 'Server Keep', '!', 10, 1)");
  const name = srv.dbSnapshots.now();
  assert.ok(name, 'snapshot written');
  await srv.close();
  const buf = readFileSync(join(dir, 'snug.db'));
  randomBytes(4096).copy(buf, 0);
  writeFileSync(join(dir, 'snug.db'), buf);
  srv = await startServer({ port: 0, dataDir: dir, quiet: true });
  try {
    assert.equal(srv.db.get("SELECT name FROM users WHERE id = 'u_srv'").name, 'Server Keep');
  } finally {
    await srv.close();
  }
});
