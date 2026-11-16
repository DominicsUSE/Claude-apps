// What the server forgets on its own (0.14 tracking track). Run once an hour
// from the minute sweep (server/index.js); GET /api/privacy reports these
// windows (server/privacy.js) and the privacy page lists them.
//
// - House join and leave log (server/places.js member_log): only owners'
//   insights read it, for at most 90 days, so rows past 90 days go. Before
//   the first purge in a house, when its log began is kept in
//   member_log_began, so joins from before the log are still counted from
//   members.joined exactly as before (places.js insights.get).
// - Link-preview cache (server/messaging.js link_cache): reused for 6 hours,
//   so rows past 24 hours go, with the cached pictures (lc_<hash> files).
//   Previews already shown in messages keep their own copies.
// - Friend-request cooldowns (server/ops.js friend_cooldown): a refusal or a
//   taken-back request blocks asking again for a day; rows past that go.
// Moderation records (bans, timeouts, reports, the audit log) are not touched here.
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const HOUR = 3_600_000;
const DAY = 86_400_000;
export const MEMBER_LOG_DAYS = 90;
export const LINK_CACHE_HOURS = 24;
export const FRIEND_COOLDOWN_MS = DAY; // the same day server/ops.js friend.request waits

export function createRetention({ db, filesDir = null, log = () => {} }) {
  const has = (t) => !!db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", t);
  let last = 0;

  function memberLog(now) {
    if (!has('member_log')) return 0;
    const cutoff = now - MEMBER_LOG_DAYS * DAY;
    let n = 0;
    db.tx(() => {
      if (has('member_log_began')) {
        db.run(`INSERT OR IGNORE INTO member_log_began (house, ts)
          SELECT house, MIN(ts) FROM member_log WHERE kind = 'join' AND house IN (SELECT DISTINCT house FROM member_log WHERE ts < ?) GROUP BY house`, cutoff);
      }
      n = db.run('DELETE FROM member_log WHERE ts < ?', cutoff).changes;
    });
    return n;
  }

  function linkCache(now) {
    if (!has('link_cache')) return 0;
    const cutoff = now - LINK_CACHE_HOURS * HOUR;
    const hashOf = (data) => { try { return JSON.parse(data)?.media?.hash || null; } catch { return null; } };
    const gone = new Set(db.all('SELECT data FROM link_cache WHERE fetched < ? AND data IS NOT NULL', cutoff).map((r) => hashOf(r.data)).filter(Boolean));
    const n = db.run('DELETE FROM link_cache WHERE fetched < ?', cutoff).changes;
    if (!filesDir) return n;
    // The pictures of those rows, and any other cached picture past the window that no row names
    // (one younger than that may belong to a preview being fetched right now).
    const live = new Set(db.all('SELECT data FROM link_cache WHERE data IS NOT NULL').map((r) => hashOf(r.data)).filter(Boolean));
    let names = [];
    try { names = readdirSync(filesDir).filter((f) => f.startsWith('lc_')); } catch { return n; }
    for (const f of names) {
      const h = f.slice(3);
      if (live.has(h)) continue;
      try {
        if (gone.has(h) || statSync(join(filesDir, f)).mtimeMs < cutoff) unlinkSync(join(filesDir, f));
      } catch (e) { if (e.code !== 'ENOENT') log('error', 'link cache sweep', e.code); }
    }
    return n;
  }

  function cooldowns(now) {
    if (!has('friend_cooldown')) return 0;
    return db.run('DELETE FROM friend_cooldown WHERE ts <= ?', now - FRIEND_COOLDOWN_MS).changes;
  }

  // Everything now (tests pass their own clock).
  function run(now = Date.now()) {
    last = now;
    const out = {};
    for (const [k, fn] of [['memberLog', memberLog], ['linkCache', linkCache], ['cooldowns', cooldowns]]) {
      try { out[k] = fn(now); } catch (e) { log('error', 'retention', k, e.message); }
    }
    return out;
  }
  // From the minute sweep: at most once an hour.
  const tick = (now = Date.now()) => (now - last >= HOUR ? run(now) : null);
  return { run, tick };
}
