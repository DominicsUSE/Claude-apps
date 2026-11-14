// HTTP client for the registry (design section 2.5). Every request is signed
// by this PC's identity key where the API asks for it; every response carries
// x-snug-now, from which the client keeps its clock skew (F9).
const TIMEOUT = 10_000;

export class RegError extends Error {
  constructor(code, message, extra = {}) { super(message || code); this.code = code; Object.assign(this, extra); }
}

export function createRegClient({ url, identity, fetch: fetchFn = globalThis.fetch }) {
  const base = String(url || '').replace(/\/+$/, '');
  let skew = 0;
  let lastTs = 0;
  const now = () => Date.now() + skew;
  // Mutating calls need ts > the last one the registry accepted.
  const ts = () => { lastTs = Math.max(Math.round(now()), lastTs + 1); return lastTs; };
  const uid = () => identity.self()?.uid || null;

  async function send(method, path, body) {
    if (!base) throw new RegError('config_error', 'No registry is set up.');
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT);
    let res;
    try {
      res = await fetchFn(`${base}${path}`, {
        method, signal: ctl.signal,
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new RegError('offline', 'Can’t reach the Snug registry.');
    } finally { clearTimeout(t); }
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    const n = Number(res.headers.get('x-snug-now'));
    if (Number.isFinite(n) && n > 0) skew = n - Date.now();
    else if (Number.isFinite(data?.now)) skew = data.now - Date.now();
    if (!res.ok) {
      const d = data || {};
      throw new RegError(d.error || (res.status >= 500 ? 'unavailable' : 'bad_request'), d.message, { status: res.status, retryAt: d.retryAt, retryAfter: d.retryAfter });
    }
    return data || {};
  }
  // A signed request refused as stale (this PC's clock was off): the reply
  // carried the registry's time, so sign it once more with the corrected clock.
  async function signed(method, path, make) {
    try { return await send(method, path, make()); } catch (e) {
      if (e.code !== 'stale') throw e;
      return send(method, path, make());
    }
  }
  const sign = (...parts) => identity.sign(['snug-reg-v1', ...parts].join('\n'));

  const R = {
    now,
    get skew() { return skew; },
    // The registry's clock as seen on the signal socket (challenge and ready carry `now`).
    sawNow(n) { if (Number.isFinite(n) && n > 0) skew = n - Date.now(); },
    async authGithub(token) {
      const { ik, xk } = identity.ensureKeys();
      return signed('POST', '/v1/auth/github', () => { const t = ts(); return { token, ik, xk, ts: t, sig: sign('auth', ik, xk, t) }; });
    },
    async claim(ticket, username) {
      return signed('POST', '/v1/claim', () => { const t = ts(); return { ticket, username, ts: t, sig: sign('claim', ticket, username, t) }; });
    },
    async rebind(ticket) {
      return signed('POST', '/v1/rebind', () => { const t = ts(); return { ticket, ts: t, sig: sign('rebind', ticket, t) }; });
    },
    // The old PC's answer to a move: `prev` is its signature over the new key (section 1.6).
    async rebindApprove({ kver, ik, xk, prev }) {
      return send('POST', '/v1/rebind/approve', { uid: uid(), kver, ik, xk, prev });
    },
    async rebindCancel() {
      const u = uid();
      return signed('POST', '/v1/rebind/cancel', () => { const t = ts(); return { uid: u, ts: t, sig: sign('rebind-cancel', u, t) }; });
    },
    async rename(username) {
      const u = uid();
      return signed('POST', '/v1/rename', () => { const t = ts(); return { uid: u, username, ts: t, sig: sign('rename', u, username, t) }; });
    },
    async release(ticket) {
      const u = uid();
      return signed('POST', '/v1/release', () => { const t = ts(); return { uid: u, ticket, ts: t, sig: sign('release', u, ticket, t) }; });
    },
    async check(name) {
      return send('GET', `/v1/check?name=${encodeURIComponent(name)}`);
    },
    // {name} or {uid}; null when nobody has it.
    async lookup(q) {
      const u = uid();
      const byName = q?.name != null;
      const key = byName ? String(q.name) : String(q?.uid);
      try {
        return await signed('POST', '/v1/lookup', () => { const t = ts(); return { uid: u, ts: t, sig: sign('lookup', u, t, key), q: byName ? { name: key } : { uid: key } }; });
      } catch (e) { if (e.code === 'not_found') return null; throw e; }
    },
    async turn(peerUid) {
      const u = uid();
      try {
        return await signed('POST', '/v1/turn', () => { const t = ts(); return { uid: u, peer: peerUid, ts: t, sig: sign('turn', u, peerUid, t) }; });
      } catch (e) { if (e.status === 404) return null; throw e; }
    },
    wsUrl() { return `${base.replace(/^http/, 'ws')}/v1/ws?uid=${uid()}`; },
  };
  return R;
}
