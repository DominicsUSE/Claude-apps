// GitHub token check. The token is used once, here, then revoked. It is never stored or logged.

export class GhError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export const TOKEN_RE = /^gh[ou]_[A-Za-z0-9_]{20,255}$/;

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function headers(extra) {
  return {
    'User-Agent': 'snug-registry',
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  };
}

/** Throws GhError('config_error') unless the env describes a safe configuration. Returns 'app' | 'unchecked'. */
export function githubMode(env) {
  let host;
  try {
    host = new URL(env.GITHUB_API || 'https://api.github.com').hostname;
  } catch {
    throw new GhError('config_error');
  }
  if (env.ALLOW_UNCHECKED_TOKENS === '1') {
    if (!LOCAL_HOSTS.has(host)) throw new GhError('config_error');
    return 'unchecked';
  }
  if (!env.GITHUB_CLIENT_ID || !env.GH_CLIENT_SECRET) throw new GhError('config_error');
  return 'app';
}

function fail(status) {
  return new GhError(status === 401 || status === 404 || status === 422 ? 'github_invalid' : 'github_unavailable');
}

/** Returns {id:number}. Throws GhError with code github_invalid | github_unavailable | config_error. */
export async function checkToken(env, token, fetchFn = fetch) {
  const mode = githubMode(env);
  const api = String(env.GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
  let res;
  if (mode === 'unchecked') {
    try {
      res = await fetchFn(`${api}/user`, { headers: headers({ Authorization: `Bearer ${token}` }) });
    } catch {
      throw new GhError('github_unavailable');
    }
    if (res.status !== 200) throw fail(res.status);
    const u = await res.json().catch(() => null);
    if (!u || !Number.isSafeInteger(u.id) || u.id <= 0) throw new GhError('github_unavailable');
    return { id: u.id };
  }
  const cid = env.GITHUB_CLIENT_ID;
  const url = `${api}/applications/${encodeURIComponent(cid)}/token`;
  const init = (method) => ({
    method,
    headers: headers({
      Authorization: `Basic ${btoa(`${cid}:${env.GH_CLIENT_SECRET}`)}`,
      'Content-Type': 'application/json',
    }),
    body: JSON.stringify({ access_token: token }),
  });
  try {
    res = await fetchFn(url, init('POST'));
  } catch {
    throw new GhError('github_unavailable');
  }
  if (res.status !== 200) throw fail(res.status);
  const body = await res.json().catch(() => null);
  if (!body || !body.app || body.app.client_id !== cid) throw new GhError('github_invalid');
  const id = body.user && body.user.id;
  if (!Number.isSafeInteger(id) || id <= 0) throw new GhError('github_unavailable');
  try {
    const r = await fetchFn(url, init('DELETE')); // revoke: the token was single-use for us
    await r.arrayBuffer().catch(() => {});
  } catch {
    /* a failed revoke is ignored */
  }
  return { id };
}
