// In-memory Durable Object runtime for Node (tests and local dev only; never deployed).
// Mirrors the parts of workerd the Hub uses: ctx.storage.sql (node:sqlite), alarms, hibernatable
// WebSockets with tags, attachments and an auto-response, and env.HUB.idFromName().get().fetch().
// Fidelity checks: attachments over 2 KB throw; more than 50 outbound fetches in one event throw.
import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';

const MAX_ATTACHMENT = 2048;
const MAX_FETCHES_PER_EVENT = 50;

function cursor(rows, rowsWritten = 0) {
  return {
    rowsRead: rows.length,
    rowsWritten,
    toArray: () => rows.slice(),
    one() {
      if (rows.length !== 1) throw new Error(`Expected exactly one result from SQL query, got ${rows.length}`);
      return rows[0];
    },
    raw: () => rows.map((r) => Object.values(r))[Symbol.iterator](),
    [Symbol.iterator]: () => rows[Symbol.iterator](),
  };
}

function bind(v) {
  if (v === undefined) throw new TypeError('SQL binding is undefined');
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

function makeSql(db) {
  const cache = new Map();
  let depth = 0;
  return {
    sql: {
      exec(q, ...b) {
        if (!b.length && /;\s*\S/.test(q.trim())) {
          db.exec(q);
          return cursor([]);
        }
        let st = cache.get(q);
        if (!st) {
          st = db.prepare(q);
          if (cache.size > 300) cache.clear();
          cache.set(q, st);
        }
        const args = b.map(bind);
        if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(q) || /\bRETURNING\b/i.test(q)) {
          return cursor(st.all(...args).map((r) => ({ ...r })));
        }
        return cursor([], Number(st.run(...args).changes));
      },
      get databaseSize() {
        return 0;
      },
    },
    transactionSync(fn) {
      const sp = `sp${depth}`;
      db.exec(depth ? `SAVEPOINT ${sp}` : 'BEGIN');
      depth++;
      try {
        const out = fn();
        depth--;
        db.exec(depth ? `RELEASE ${sp}` : 'COMMIT');
        return out;
      } catch (e) {
        depth--;
        db.exec(depth ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : 'ROLLBACK');
        throw e;
      }
    },
  };
}

class ShimSocket {
  constructor(rt) {
    this.rt = rt;
    this.readyState = 1;
    this.tags = [];
    this.peer = null; // the real `ws` socket once bridged
    this.queue = [];
    this.attachment = 'null';
    this.closedByServer = null;
  }
  send(data) {
    if (this.readyState !== 1) throw new Error('WebSocket is not open');
    if (this.peer) this.peer.send(data);
    else this.queue.push(data);
  }
  close(code = 1000, reason = '') {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this.closedByServer = { code, reason };
    if (this.peer) this.peer.close(code, reason);
  }
  serializeAttachment(v) {
    const s = JSON.stringify(v ?? null);
    if (s.length > MAX_ATTACHMENT) throw new Error(`WebSocket attachment too large (${s.length} > ${MAX_ATTACHMENT})`);
    this.attachment = s;
  }
  deserializeAttachment() {
    return JSON.parse(this.attachment);
  }
}

/**
 * createRuntime({env, Hub, dbPath, clock?}) -> {env, clock, hub(), evict(), sql(), bridge(), stats, close()}
 * env gets: HUB (namespace), TEST_CLOCK, __platform, __fetch.
 */
export function createRuntime({ env: baseEnv = {}, Hub, dbPath = ':memory:' }) {
  const db = new DatabaseSync(dbPath);
  const { sql, transactionSync } = makeSql(db);
  const als = new AsyncLocalStorage();
  const sockets = new Set();
  let offset = 0;
  let alarmAt = null;
  let alarmTimer = null;
  let instance = null;
  let auto = null;
  let closed = false;
  const stats = { doRequests: 0, alarms: 0, wsMessages: 0, fetches: 0 };

  const clock = {
    now: () => Date.now() + offset,
    /** Move registry time forward and run any alarm that became due. */
    async advance(ms) {
      offset += ms;
      await runDueAlarm();
    },
  };

  const ctx = {
    id: { name: 'hub', toString: () => 'hub' },
    storage: {
      sql,
      transactionSync,
      async getAlarm() {
        return alarmAt;
      },
      async setAlarm(t) {
        alarmAt = typeof t === 'number' ? t : new Date(t).getTime();
        scheduleTimer();
      },
      async deleteAlarm() {
        alarmAt = null;
        scheduleTimer();
      },
    },
    acceptWebSocket(ws, tags = []) {
      ws.tags = tags.map(String);
      sockets.add(ws);
    },
    getWebSockets(tag) {
      return [...sockets].filter((s) => s.readyState !== 3 && (tag === undefined || s.tags.includes(tag)));
    },
    setWebSocketAutoResponse(pair) {
      auto = pair ? { req: pair.req ?? pair.request, res: pair.res ?? pair.response } : null;
    },
    getWebSocketAutoResponse: () => auto,
    waitUntil() {},
    blockConcurrencyWhile: (fn) => fn(),
  };

  const platform = {
    newPair() {
      const server = new ShimSocket(rt);
      return { client: { __shimClient: true, server }, server };
    },
    upgradeResponse(client, headers) {
      return { status: 101, webSocket: client, headers: new Headers(headers || {}) };
    },
    autoResponse(c, req, res) {
      c.setWebSocketAutoResponse({ req, res });
    },
  };

  async function countedFetch(...args) {
    const store = als.getStore();
    if (store && ++store.fetches > MAX_FETCHES_PER_EVENT) throw new Error('shim: more than 50 outbound fetches in one event');
    stats.fetches++;
    return fetch(...args);
  }

  const env = { ...baseEnv };
  env.TEST_CLOCK = clock.now;
  env.__platform = platform;
  env.__fetch = countedFetch;
  env.HUB = {
    idFromName: (name) => ({ name, toString: () => name }),
    get: () => ({
      fetch: (req) => {
        stats.doRequests++;
        return event(() => hub().fetch(req));
      },
    }),
  };

  function hub() {
    if (!instance) instance = new Hub(ctx, env);
    return instance;
  }
  function event(fn) {
    return als.run({ fetches: 0 }, fn);
  }

  function scheduleTimer() {
    if (alarmTimer) clearTimeout(alarmTimer);
    alarmTimer = null;
    if (alarmAt == null || closed) return;
    const delay = Math.min(Math.max(0, alarmAt - clock.now()), 2 ** 31 - 1);
    alarmTimer = setTimeout(() => runDueAlarm().catch(() => {}), delay);
    alarmTimer.unref?.();
  }

  async function runDueAlarm() {
    for (let i = 0; i < 10 && !closed && alarmAt != null && alarmAt <= clock.now(); i++) {
      alarmAt = null;
      stats.alarms++;
      await event(() => hub().alarm());
      await new Promise((r) => setImmediate(r)); // let fire-and-forget setAlarm calls land
    }
    scheduleTimer();
  }

  /** Connect a ShimSocket (from upgradeResponse) to a real `ws` server-side socket. */
  function bridge(server, ws) {
    server.peer = ws;
    if (server.readyState >= 2) {
      ws.close(server.closedByServer?.code ?? 1000, server.closedByServer?.reason ?? '');
    } else {
      for (const d of server.queue) ws.send(d);
    }
    server.queue = [];
    ws.on('message', (data, isBinary) => {
      if (server.readyState !== 1) return;
      const msg = isBinary ? new Uint8Array(data).buffer : data.toString();
      if (auto && msg === auto.req) {
        ws.send(auto.res); // never reaches the DO, as in workerd
        return;
      }
      stats.wsMessages++;
      event(() => hub().webSocketMessage(server, msg)).catch((e) => console.error('shim: webSocketMessage threw', e && e.message));
    });
    ws.on('close', (code, reason) => {
      // workerd also delivers webSocketClose after a close the DO started itself (verified under
      // `wrangler dev`), so the Hub's cleanup must be idempotent; the shim does the same.
      server.readyState = 3;
      sockets.delete(server);
      if (!closed) {
        event(() => hub().webSocketClose(server, code, String(reason), true)).catch(() => {});
      }
    });
    ws.on('error', () => {
      if (server.readyState === 3 || closed) return;
      event(() => hub().webSocketError(server, new Error('socket error'))).catch(() => {});
    });
  }

  const rt = {
    env,
    clock,
    stats,
    hub,
    bridge,
    runDueAlarm,
    get alarmAt() {
      return alarmAt;
    },
    /** Drop the DO instance (memory caches) but keep SQLite, sockets and the alarm: like hibernation/eviction. */
    evict() {
      instance = null;
    },
    /** Direct SQL for tests. */
    sql: (q, ...b) => sql.exec(q, ...b).toArray(),
    close() {
      closed = true;
      if (alarmTimer) clearTimeout(alarmTimer);
      for (const s of sockets) s.peer?.terminate?.();
      sockets.clear();
      try {
        db.close();
      } catch {
        /* already closed */
      }
    },
  };
  return rt;
}
