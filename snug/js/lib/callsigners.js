// calls C2: which of a person's devices signed calls with this device, kept on
// this device only as one sealed entry of its encryption store (js/e2ee/store.js
// putSecret; never sent anywhere). js/e2ee/callkeys.js uses one book per account.
//
// Losing the record reopens the first-call gap, so it is guarded:
// - an entry that can't be read (damaged, a key that won't open it, a locked
//   store) is never written over: what this tab learns stays in memory;
// - every write reads the saved entry again first and changes only the one
//   person it is about, so two tabs don't erase each other's entries;
// - writes run one at a time (and, given `lock`, one at a time across tabs).
//
// open(): the store, or null when this device has none (nothing remembered then).
const KEY = 'callsig';
const PER_USER = 8, USERS = 500;

function parse(got) {
  const map = new Map();
  if (!got || typeof got !== 'object' || Array.isArray(got)) return map;
  for (const [u, list] of Object.entries(got)) {
    if (Array.isArray(list)) map.set(u, list.filter((d) => typeof d === 'string').slice(-PER_USER));
  }
  return map;
}

export function signerBook({ open, lock = null }) {
  let map = new Map();
  let state = 'new'; // 'new' | 'none' (no store yet: read again next time) | 'ok' | 'memory' (unreadable: never written)
  let loading = null;
  let chain = Promise.resolve();

  async function load() {
    if (state === 'ok' || state === 'memory') return map;
    loading ||= (async () => {
      const st = await open().catch(() => null);
      if (!st) { state = 'none'; return; }
      try {
        const saved = parse(await st.getSecret(KEY));
        for (const [u, list] of map) saved.set(u, [...new Set([...(saved.get(u) || []), ...list])].slice(-PER_USER));
        map = saved;
        state = 'ok';
      } catch { state = 'memory'; }
    })().finally(() => { loading = null; });
    await loading;
    return map;
  }

  // One person's list changed by fn(list) -> list: in memory, and in the saved entry read afresh.
  function change(u, fn) {
    const run = async () => {
      await load();
      const mem = () => { const now = fn(map.get(u) || []); map.delete(u); if (now.length) map.set(u, now); };
      if (state !== 'ok') return mem();
      const st = await open().catch(() => null);
      let saved;
      try { saved = parse(await st.getSecret(KEY)); } catch { return mem(); }
      const now = fn([...new Set([...(saved.get(u) || []), ...(map.get(u) || [])])]);
      saved.delete(u);
      if (now.length) saved.set(u, now);
      map = saved;
      try { await st.putSecret(KEY, Object.fromEntries([...saved.entries()].slice(-USERS))); } catch { /* this tab only */ }
      return undefined;
    };
    const locked = () => (lock ? lock(run) : run());
    const p = chain.then(locked, locked);
    chain = p.catch(() => {});
    return p;
  }

  return {
    load,
    /** The devices of u that signed calls with this device: [device ids], most recent last. */
    get: async (u) => (await load()).get(u) || [],
    /** The same if already read (null while still to be read; [] with no store here). */
    now: (u) => (state === 'new' ? null : map.get(u) || []),
    /** Device d of u signed something of a call that checked. */
    remember: (u, d) => change(u, (list) => (list.includes(d) ? list : [...list, d].slice(-PER_USER))),
    /** Keep only those of u's devices still in their list. */
    prune: (u, listed) => change(u, (list) => list.filter((d) => listed.includes(d))),
  };
}
