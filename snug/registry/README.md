# Snug registry

A small Cloudflare Worker with one SQLite Durable Object (`Hub`, a single instance). It is the only
central piece of Snug P2P. It does four things:

1. **Accounts.** Signs people in with GitHub (OAuth Device Flow). It checks the token once against
   our OAuth App, keeps only an HMAC of the numeric GitHub id, then revokes the token. Snug never
   shows a GitHub identity, and the registry never stores one.
2. **Usernames.** Keeps them globally unique, using the rules in `../js/lib/usernames.js` plus a
   unique look-alike "skeleton". One name per GitHub account. A rename frees the old name at once.
   One rename per 7 days. `1` and `a` are reserved for `OWNER_GITHUB_IDS`.
3. **Phone book.** `lookup` returns a username's uid, public keys and key history, and no GitHub data.
4. **Introductions.** Hibernatable WebSockets carry presence (mutual friends only), sealed WebRTC
   signaling, sealed friend-request "knocks" (kept up to 30 days), and, only as a fallback, relayed
   end-to-end-encrypted link frames. The registry never sees plaintext.

What it stores: accounts (uid, GitHub-id HMAC, username, public keys), the last 5 public keys per
account with continuity signatures, any pending PC move (up to 72 h), short-lived sign-in tickets
(stored as hashes, valid 10 min), sealed knocks, the watch list of each connected user (deleted on
disconnect), per-uid daily counters (kept 2 days), and a per-GitHub-hash record of rename and
release times. It stores no messages, no profiles, no IP addresses and no long-term friend graph.

## Layout

| Path | What |
|---|---|
| `wrangler.toml` | Worker config. Account-specific values are placeholders; secrets are listed but never stored here. |
| `src/worker.js` | Front door: path allowlist, 16 KB body cap, `?uid=` shape check, `/v1/health`. Exports `Hub`. |
| `src/hub.js` | The Durable Object: HTTP API, sockets, presence, relay, knocks, moves, alarm. |
| `src/github.js` | Token check (`POST/DELETE /applications/{client_id}/token`) and dev mode. |
| `src/crypto.js` | WebCrypto helpers: base64url, Ed25519 verify, SHA-256, HMAC, random ids. |
| `src/limits.js` | Every rate limit in one table, memory windows, and budgets kept in SQLite. |
| `src/platform.js` | The seam between workerd and the Node shim. |
| `shim.js` | Durable Object runtime for Node (`node:sqlite`, alarms, hibernatable sockets). Tests and dev only. |
| `dev.js` | `startLocalRegistry()`: the real Worker and Hub behind Node `http` + `ws`. Tests and dev only. |
| `mock-github.js` | `startMockGithub()`: device flow, app-token check and revoke, `/user`, and a fake TURN endpoint. |
| `test/*.test.js` | `node:test` suites (rules, accounts, sockets). No network. |

Only `src/` and `../js/lib/usernames.js` are deployed. `wrangler deploy` bundles them with esbuild.
The deployed bundle is about 50 KiB (14 KiB gzipped).

## Local use (no Cloudflare, no GitHub)

```sh
cd snug
npm test                 # app tests + registry tests
npm run test:registry    # registry tests only (about 5 s)
npm run registry         # local registry on :8787 with a mock GitHub; prints both URLs
```

From tests (`registry/dev.js`):

```js
import { startLocalRegistry } from '../registry/dev.js';
const reg = await startLocalRegistry({ env: { OWNER_GITHUB_IDS: '900001' } });
reg.url                         // http://127.0.0.1:<free port>
reg.github                      // the mock GitHub (started for you unless you pass githubMock)
reg.github.authorize(userCode, { id: 1001 })   // approve a device-flow code
reg.github.issueToken({ id: 1001 })            // or skip the device flow
await reg.clock.advance(72 * 3600e3)           // registry time; runs any alarm that became due
reg.clock.now()
reg.runtime.sql('SELECT * FROM accounts')      // inspect storage
reg.runtime.evict()                            // drop the DO's memory, keep SQLite and sockets
await reg.close()
```

Options: `port` (0 means a free port), `env` (overrides), `githubMock` (alias `github`), `limits`
(`'relaxed'` by default: per-IP limits ×1000 and the auth/connect caps ×10, because every test user
shares 127.0.0.1; `'production'` for the real values; or an object of overrides), `trustClientIp`
(accept an incoming `cf-connecting-ip`, for IP-limit tests), and `dbPath`. Default env: a dev HMAC
secret, the mock's URL, client id `Iv1.test`, secret `test-secret`, and the fake owner id `900001`.
Use only fake ids in tests.

`startMockGithub({port=0, clientId='Iv1.test', clientSecret='test-secret', turnToken='turn-token'})`
returns `{url, clientId, clientSecret, authorize(userCode,{id}), deny(userCode), issueToken({id, clientId?}), calls, close()}`.
It answers 403 to any request without a `User-Agent`. The device endpoints answer JSON only when sent
`Accept: application/json` (as GitHub does). It records `scope` and every call in `calls`.

## Deploy (exact steps)

You need a free Cloudflare account, a GitHub account, and Node 22+. Run every command in `snug/registry/`.

### 1. Create the GitHub OAuth App (Device Flow)
1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**
   (https://github.com/settings/applications/new).
2. Application name `Snug`. Homepage URL: any page you own, such as the repo URL. Authorization
   callback URL: `http://127.0.0.1/` (required by the form; Device Flow never uses it).
3. **Register application**, then tick **Enable Device Flow** and **Update application**.
4. Copy the **Client ID** (public). Click **Generate a new client secret** and copy it (secret).
5. Put the client id into `wrangler.toml` → `[vars] GITHUB_CLIENT_ID`. The desktop app needs the same
   id as its default GitHub client id. It is public, and the app holds no client secret.

### 2. Let wrangler reach your Cloudflare account
Use one of these:
- Interactive: `npx wrangler login` (opens a browser).
- Token (CI or headless): Cloudflare dashboard → **My Profile → API Tokens → Create Token** → template
  **Edit Cloudflare Workers** → Account Resources: your account → Zone Resources: **All zones** (or
  remove the zone row if you deploy only to workers.dev) → **Create Token**. Then:
  ```sh
  export CLOUDFLARE_API_TOKEN=<token>
  export CLOUDFLARE_ACCOUNT_ID=<account id, shown on the Workers & Pages overview page>
  ```
If this account has never used Workers, open **Workers & Pages** once in the dashboard to pick your
`*.workers.dev` subdomain.

### 3. Deploy, then set the secrets
```sh
npx wrangler deploy --dry-run --outdir .wrangler/dry-run   # optional: bundles locally, uploads nothing
npx wrangler deploy                                        # creates the Worker and the Hub DO (migration v1)
openssl rand -base64 48 | npx wrangler secret put GH_HMAC_SECRET
npx wrangler secret put GH_CLIENT_SECRET        # paste the OAuth App client secret
npx wrangler secret put OWNER_GITHUB_IDS        # your numeric GitHub id; comma-separate if several
```
To find your numeric GitHub id: `curl -s https://api.github.com/users/<your-login>` and read `"id"`.
Until the secrets are set, sign-in answers `500 config_error`, so a missing secret fails closed.

### 4. Check it
```sh
curl https://snug-registry.<your-subdomain>.workers.dev/v1/health    # {"ok":true,"v":2}
curl "https://snug-registry.<your-subdomain>.workers.dev/v1/check?name=someone"
```
Put that URL in the app as its default registry URL (desktop config: see the P2P design, section 9.4).

### 5. Optional: TURN for calls behind strict NATs
Create a TURN key in the Cloudflare dashboard (the Realtime / Calls section, "TURN keys"). Put its id
in `wrangler.toml` → `TURN_KEY_ID` and run `npx wrangler secret put TURN_KEY_TOKEN`. The Hub calls
`POST https://rtc.live.cloudflare.com/v1/turn/keys/{TURN_KEY_ID}/credentials/generate` with `{ttl: 7200}`.
It was tested only against the mock, so check that endpoint against current Cloudflare docs; the
`TURN_API` var overrides the base URL. **Check current TURN pricing and set a
usage alert first.** Without it, `/v1/turn` answers 404 and calls use STUN only.

### Updating and rules that must not be broken
- Redeploy with `npx wrangler deploy`. Schema changes go in `src/hub.js` as `CREATE ... IF NOT EXISTS`
  or additive `ALTER`. Never rename or delete the `Hub` class or its migration: that deletes every account.
- **Never rotate `GH_HMAC_SECRET`.** It keys every account's GitHub hash. A new value orphans every
  account: people could no longer sign in to their names.
- `GH_CLIENT_SECRET` can be rotated in GitHub at any time. Put the new one, then delete the old one.
- `OWNER_GITHUB_IDS` changes take effect on the next request.

### Logging
`[observability] enabled = false`: Cloudflare keeps no request logs for this Worker. The code logs
only `registry: internal error <ErrorName> <path>` on unexpected exceptions. It never logs request
bodies, tokens, IP addresses or keys (tests check that the token never reaches console output).
Avoid `wrangler tail` on production except to debug, and never paste its output anywhere public.

### STUN
The registry serves no STUN. The app's calls and links use `stun:stun.l.google.com:19302` by default
(`server/voiceopts.js`, overridable with `SNUG_STUN`). Google sees the public IP of each PC that
uses it. "Hide my IP" in the app avoids that only when TURN is configured.

### Free tier (re-check before launch)
Workers Free allows about 100k requests/day, and SQLite Durable Objects about 100k requests/day.
Incoming WebSocket messages count 20:1, and hibernation keeps idle sockets cheap. The design estimates
about 6.5 DO requests per active user per day, plus 48 if keepalive auto-responses turn out to be
billed. The keepalive interval is `PING_SECONDS` (sent to clients in `ready.ping`), so it can be raised
without an app update. Relay is refused for the rest of the UTC day once the Hub's own request
estimate passes `RELAY_OFF_AT`. Re-check the plan limits, whether auto-responses are billed, and the
WebSocket idle timeout against current Cloudflare docs.

## API summary

Every response carries `x-snug-now: <ms>`. Clients keep `skew = now - Date.now()` and sign with
`Date.now() + skew`. Errors are `{error, message, retryAfter?, retryAt?, now}`. Signed strings are
`\n`-joined UTF-8, with the domain tag `snug-reg-v1`, signed with Ed25519 (keys and signatures in
base64url without padding).

| Call | Body | Signed by / string |
|---|---|---|
| `POST /v1/auth/github` | `{token, ik, xk, ts, sig}` | request `ik`: `auth\n{ik}\n{xk}\n{ts}` → `{status:'new'|'ok'|'rebind'|'pending', ticket, owner?, account?, at?, rebind?}` |
| `POST /v1/claim` | `{ticket, username, ts, sig}` | ticket's `ik`: `claim\n{ticket}\n{username}\n{ts}` → `{account}`. A failed claim keeps the ticket. |
| `POST /v1/rebind` | `{ticket, ts, sig}` | ticket's `ik`: `rebind\n{ticket}\n{ts}` → `{status:'pending', uid, at}` |
| `POST /v1/rebind/approve` | `{uid, kver, ik, xk, prev}` | current key: `snug-keychange-v1\n{uid}\n{kver}\n{ik}\n{xk}` (no `snug-reg-v1` tag) |
| `POST /v1/rebind/cancel` | `{uid, ts, sig}` | current key: `rebind-cancel\n{uid}\n{ts}` |
| `POST /v1/rename` | `{uid, username, ts, sig}` | current key: `rename\n{uid}\n{username}\n{ts}` |
| `POST /v1/release` | `{uid, ticket, ts, sig}` | current key: `release\n{uid}\n{ticket}\n{ts}`, plus a fresh GitHub ticket for the same account |
| `GET /v1/check?name=` | | `{ok:true}` or `{ok:false, error}` |
| `POST /v1/lookup` | `{uid, ts, sig, q:{name}|{uid}}` | current key: `lookup\n{uid}\n{ts}\n{name or uid}` → `{uid, username, ik, xk, kver, chain}` |
| `POST /v1/turn` | `{uid, peer, ts, sig}` | current key: `turn\n{uid}\n{peer}\n{ts}` → `{iceServers, ttl}` (404 if not configured) |
| `GET /v1/ws?uid=` | WebSocket | challenge `{t:'challenge', n, now}`, then `{t:'auth', uid, sig, visible?}` over `signal\n{uid}\n{n}` |

`account` = `{uid, username, kver, claimedAt, renamedAt, renameAt}`. `ts` must be within ±5 min, and
mutating calls by uid need `ts > ` the last accepted ts.

Socket frames, client → Hub: `watch {uids}`, `visible {on}`, `sig {id,to,box}` (≤ 16 KB),
`relay {id,to,box}` (≤ 64 KB), `knock {id,to,box}` (≤ 4 KB, always answered `{t:'ok', id}`),
`knocked {ids}`, and the literal `ping` (auto-answered `pong`). Hub → client: `ready`, `presence`,
`sig`, `relay`, `knock`, `rebind`, and `err {id, code}` with codes `unavailable`, `too_big`,
`rate_limited`, `too_many`, `relay_unavailable` and `bad_request`. Close codes: 4001 bad auth, 4002
replaced, 4003 revoked, 4004 rebound (reconnect now), 4005 auth timeout, 4006 move stopped, 4029 rate limited.

Every limit is in `src/limits.js` (`DEFAULT_LIMITS`).

### Differences from the design document (v2, section 2)
- `knocks` has the primary key `(to_uid, frm, id)`, so nobody can block a knock id another sender uses.
  `budget.win` holds the window start in ms (day or hour) instead of a day number.
- `auth` with `status:'pending'` also returns `account`, so a restarted new PC knows its uid.
- The auth frame may carry `visible:false`, so an invisible user is never announced, not even briefly.
- If an invisible user sends a `sig` or `relay` to a friend, that friend may answer it for the rest
  of the session (at most 20 uids, kept in the socket attachment). Without this, an invisible user
  could not open any link.
- When a move is stopped, current-key sockets get `{t:'rebind', state:'stopped'}`.
- Extra error codes: `turn_unavailable` (502), `server_error` (500), and `bad_request` on socket `err`.
- A knock to a uid that does not exist is answered `ok` and dropped.

## What was verified
- `npm run test:registry`: 42 tests, run in Node 22 over the shim.
- The bundle builds with `wrangler deploy --dry-run` (wrangler 4.154.0).
- A manual smoke script ran against real workerd (`wrangler dev --local`). It covered sign-up, lookup,
  the ping auto-response, presence, sig, a 64 KB relay and an oversized one, knocks, replacement
  (4002), an approved move (4003/4004, kver 2), a bad `?uid=` (400), a bad signature (4001) and the
  alarm-driven auth timeout (4005). Under `wrangler dev`, a client's `close` event can arrive about
  10 s after the close frame because the local proxy holds the TCP connection. The Hub's handlers
  run at once.
- Not yet verified on Cloudflare itself: nothing has been deployed.
