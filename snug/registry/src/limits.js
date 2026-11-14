// Rate limits. Two kinds:
//  - Windows: in-memory fixed-window counters (IP buckets, bursts). Bounded Map; may reset on hibernation.
//  - Budgets: per-uid counters persisted in SQLite (`budget` table) so daily caps survive hibernation.

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** Every limit in one place. [count, window ms]. Tests may override via env.TEST_LIMITS (shim only). */
export const DEFAULT_LIMITS = {
  // per IP (memory)
  ipAuth: [10, HOUR],
  ipAccount: [5, HOUR], // claim, rebind, rebind/approve, rebind/cancel, release
  ipRename: [10, HOUR],
  ipCheck: [30, MIN],
  ipLookup: [60, MIN],
  ipTurn: [30, MIN],
  ipWs: [30, MIN],
  // global (SQLite)
  authGlobal: [300, HOUR],
  // per uid (SQLite)
  lookupDay: [300, DAY],
  turnDay: [10, DAY],
  connect: [30, HOUR],
  relayDay: [2000, DAY],
  relayBytesDay: [20 * 1024 * 1024, DAY],
  sigDay: [500, DAY],
  watchDay: [200, DAY],
  knockDay: [50, DAY],
  knockPairDay: [5, DAY],
  // per uid (memory)
  sigMin: [60, MIN],
  relayBurst: [50, 1000],
  watchHour: [30, HOUR],
  // sizes / counts
  unauthPerUid: [4, 0],
  knockBox: [100, 0],
  knockPerSender: [3, 0],
  watchMax: [500, 0],
};

/** Fixed-window counters in memory, at most `max` keys; clears the oldest half when full. */
export class Windows {
  constructor(now, max = 10_000) {
    this.now = now;
    this.max = max;
    this.m = new Map();
  }
  /** Count one hit. Returns 0 when allowed, else seconds until the window resets. */
  hit(key, [limit, ms]) {
    const t = this.now();
    let w = this.m.get(key);
    if (!w || w.reset <= t) {
      if (w) this.m.delete(key);
      if (this.m.size >= this.max) {
        let drop = this.m.size >> 1;
        for (const k of this.m.keys()) {
          if (drop-- <= 0) break;
          this.m.delete(k);
        }
      }
      w = { n: 0, reset: t + ms };
      this.m.set(key, w);
    }
    if (w.n >= limit) return Math.max(1, Math.ceil((w.reset - t) / 1000));
    w.n++;
    return 0;
  }
}

const FLUSH_EVERY = 100;
// Counters that move in big steps are written less often, so they stay cheap in rows written.
const FLUSH_EVERY_KIND = { req20: 20 * 100, relayB: 1 << 20 };
const MEM_MAX = 20_000;

/**
 * Persistent counters. In memory first, written to SQLite every 100 units per counter (bytes: every
 * 1 MB; the global request counter: every 100 requests), on flush() (alarm when dirty, socket close).
 * On wake a counter is read back on first use. Eviction between flushes loses at most one step.
 */
export class Budgets {
  constructor(sql, now) {
    this.sql = sql;
    this.now = now;
    this.m = new Map(); // key -> {uid, win, kind, n, saved}
    this.dirty = false;
  }
  _get(uid, kind, ms) {
    const win = Math.floor(this.now() / ms) * ms;
    const key = `${uid}|${kind}|${win}`;
    let c = this.m.get(key);
    if (!c) {
      if (this.m.size >= MEM_MAX) {
        this.flush();
        this.m.clear();
      }
      const row = this.sql.exec('SELECT n FROM budget WHERE uid=? AND win=? AND kind=?', uid, win, kind).toArray()[0];
      const n = row ? Number(row.n) : 0;
      c = { uid, win, kind, n, saved: n };
      this.m.set(key, c);
    }
    return c;
  }
  value(uid, kind, ms) {
    return this._get(uid, kind, ms).n;
  }
  /** Add `amount` if it fits under `limit`; returns true when allowed. */
  take(uid, kind, [limit, ms], amount = 1) {
    const c = this._get(uid, kind, ms);
    if (c.n + amount > limit) return false;
    this.add(c, amount);
    return true;
  }
  /** Add without a cap (usage counters). */
  bump(uid, kind, ms, amount = 1) {
    this.add(this._get(uid, kind, ms), amount);
  }
  add(c, amount) {
    c.n += amount;
    if (c.n - c.saved >= (FLUSH_EVERY_KIND[c.kind] || FLUSH_EVERY)) this._write(c);
    else this.dirty = true;
  }
  _write(c) {
    this.sql.exec(
      'INSERT INTO budget(uid,win,kind,n) VALUES(?,?,?,?) ON CONFLICT(uid,win,kind) DO UPDATE SET n=excluded.n',
      c.uid, c.win, c.kind, c.n,
    );
    c.saved = c.n;
  }
  flush() {
    if (!this.dirty) return;
    const old = this.now() - 2 * DAY;
    for (const [k, c] of this.m) {
      if (c.n !== c.saved) this._write(c);
      if (c.win < old) this.m.delete(k);
    }
    this.dirty = false;
  }
}
