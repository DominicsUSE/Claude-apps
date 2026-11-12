// Loads the sample houses, people and conversations into an empty database,
// as real accounts that can sign in. Run with `npm run seed`.
//   SNUG_DEMO_PASSWORD  password for every sample account (default: snug-demo-1)
//   --force             wipe the existing database first
import { rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createModel } from './model.js';
import { hashPassword } from './auth.js';
import { seed } from '../js/seed.js';
import { ART } from '../js/seed-art.js';

export function seedDatabase(db, filesDir, { password = 'snug-demo-1', now = Date.now() } = {}) {
  const M = createModel(db);
  const S = seed(now);
  const pass = hashPassword(password);
  mkdirSync(filesDir, { recursive: true, mode: 0o700 });

  db.tx(() => {
    for (const u of Object.values(S.users)) {
      db.run('INSERT INTO users (id, handle, name, pass, hue, emoji, about, status, presence, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        u.id, u.handle, u.name, pass, u.hue, u.emoji || null, u.about, u.status, u.presence, now - 60 * 86_400_000);
    }
    for (const h of Object.values(S.houses)) {
      db.run('INSERT INTO houses (id, name, mark, hue, about, join_role, starter, first_step, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        h.id, h.name, h.mark, h.hue, h.about, h.joinRole, JSON.stringify(h.starter), h.firstStep ? JSON.stringify(h.firstStep) : null, now - 50 * 86_400_000);
      h.roles.forEach((r, i) => db.run('INSERT INTO roles (id, house, name, hue, perms, pos) VALUES (?, ?, ?, ?, ?, ?)',
        `${h.id}_${r.id}`, h.id, r.name, r.hue, JSON.stringify(r.perms), i));
      let order = 0;
      for (const [u, role] of Object.entries(h.members)) {
        db.run('INSERT INTO members (house, user, role, newcomer, joined) VALUES (?, ?, ?, 0, ?)', h.id, u, `${h.id}_${role}`, now - 40 * 86_400_000 + order++);
      }
      let pos = 0;
      h.groups.forEach((g, gi) => {
        db.run('INSERT INTO room_groups (id, house, name, pos) VALUES (?, ?, ?, ?)', g.id, h.id, g.name, gi);
        for (const rid of g.rooms) {
          const r = S.rooms[rid];
          db.run('INSERT INTO rooms (id, house, grp, name, kind, topic, pos, highlights) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            rid, h.id, g.id, r.name, r.kind, r.topic, pos++, JSON.stringify(r.highlights));
        }
      });
      db.run('UPDATE houses SET join_role = ? WHERE id = ?', `${h.id}_${h.joinRole}`, h.id);
    }
    S.dmOrder.forEach((id, i) => {
      const d = S.dms[id];
      db.run('INSERT INTO dms (id, name, created) VALUES (?, ?, ?)', id, d.name || null, now - 30 * 86_400_000 - i * 1000);
      for (const u of d.members) db.run('INSERT INTO dm_members (dm, user) VALUES (?, ?)', id, u);
    });
    for (const [tid, t] of Object.entries(S.threads)) db.run('INSERT INTO threads (id, conv, root) VALUES (?, ?, ?)', tid, t.conv, t.root);

    // Insert in time order, so the server's sequence matches the conversation order.
    const all = Object.entries(S.msgs).flatMap(([conv, list]) => list.map((m) => ({ conv, m }))).sort((a, b) => a.m.ts - b.m.ts);
    for (const { conv, m } of all) {
      const files = [];
      for (const f of m.files || []) {
        if (!f.art) continue;
        const fid = `f_seed${f.art}${m.id.replace(/[^a-z0-9]/g, '')}`;
        const svg = decodeURIComponent(ART[f.art].slice('data:image/svg+xml,'.length));
        writeFileSync(join(filesDir, fid), svg, { mode: 0o600 });
        db.run('INSERT INTO files (id, owner, conv, name, type, size, created) VALUES (?, ?, ?, ?, ?, ?, ?)',
          fid, m.author, conv, f.name.replace(/\.(jpg|png)$/, '.svg'), 'image/svg+xml', Buffer.byteLength(svg), m.ts);
        files.push({ kind: 'image', id: fid, name: f.name.replace(/\.(jpg|png)$/, '.svg'), size: Buffer.byteLength(svg), w: f.w, h: f.h });
      }
      db.run('INSERT INTO messages (id, conv, author, ts, text, fold, reply_to, files) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        m.id, conv, m.author, m.ts, m.text, M.foldText(m.text, files), m.replyTo || null, files.length ? JSON.stringify(files) : null);
      for (const [emoji, who] of Object.entries(m.reactions || {})) {
        who.forEach((u, i) => db.run('INSERT OR IGNORE INTO reactions (msg, user, emoji, ts) VALUES (?, ?, ?, ?)', m.id, u, emoji, m.ts + i + 1));
      }
    }

    // Robin has unread news; everyone else has read everything.
    for (const conv of Object.keys(S.msgs)) {
      for (const u of Object.keys(S.users)) {
        const ts = u === S.me ? S.read[conv] : now;
        if (ts) db.run('INSERT OR REPLACE INTO reads (user, conv, ts) VALUES (?, ?, ?)', u, conv, ts);
      }
    }
    for (const t of Object.keys(S.followed)) db.run('INSERT INTO follows (user, thread) VALUES (?, ?)', S.me, t);
    for (const s of S.saved) db.run('INSERT INTO saved (user, msg, conv, at, note) VALUES (?, ?, ?, ?, ?)', S.me, s.id, s.conv, s.at, s.note);
    for (const i of S.invites) db.run('INSERT INTO personal_invites (house, user, by, ts) VALUES (?, ?, ?, ?)', i.house, S.me, i.from, i.ts);
  });
  return { users: Object.keys(S.users).length, messages: Object.values(S.msgs).flat().length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dataDir = process.env.SNUG_DATA || fileURLToPath(new URL('../data', import.meta.url));
  const path = join(dataDir, 'snug.db');
  if (existsSync(path)) {
    if (!process.argv.includes('--force')) {
      console.error(`${path} already exists. Run with --force to wipe it and load the sample data.`);
      process.exit(1);
    }
    for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });
    rmSync(join(dataDir, 'files'), { recursive: true, force: true });
  }
  const db = openDb(path);
  const password = process.env.SNUG_DEMO_PASSWORD || 'snug-demo-1';
  const r = seedDatabase(db, join(dataDir, 'files'), { password });
  db.close();
  console.log(`Loaded ${r.users} sample people and ${r.messages} messages into ${path}.`);
  console.log(`Sign in as robin (or ines, tomasz, priya, jonas, bex ...) with the password: ${password}`);
}
