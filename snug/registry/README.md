# Snug registry

A small Cloudflare Worker with one SQLite Durable Object (`Hub`, a single instance). It is the only
central piece of Snug P2P. It does four things:

1. **Accounts.** Since v0.12 an account needs no GitHub account: a sign-up sends the PC's device key and
   the public half of a recovery key, plus a proof of work (`src/keyacct.js`, on when `KEY_ACCOUNTS = "1"`).
   Signing in with GitHub (OAuth Device Flow) still works: the registry checks the token once against our
   OAuth App, keeps only an HMAC of the numeric GitHub id, then revokes the token. Snug never shows a GitHub
   identity, and the registry never stores one.
2. **Usernames.** Keeps them globally unique, using the rules in `../js/lib/usernames.js` plus a
   unique look-alike "skeleton". One name per GitHub account. A rename frees the old name at once.
   One rename per 7 days. `1` and `a` are reserved for `OWNER_GITHUB_IDS`.
3. **Phone book.** `lookup` returns a username's uid, public keys and key history, and no GitHub data.
4. **Introductions.** Hibernatable WebSockets carry presence (mutual friends only), sealed WebRTC
   signaling, sealed friend-request "knocks" (kept up to 30 days), and, only as a fallback, relayed
   end-to-end-encrypted link frames. The registry never sees plaintext.

What it stores: accounts (uid, GitHub-id HMAC or `a:<uid>`, username, public keys), v0.12 recovery
public keys, optional GitHub links (HMACs), pairing codes (hashed, 10 min) and spent proof-of-work challenges, the last 5 public keys per
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
| `src/admin.js` | v0.10: admin rights, bans and timeouts, reserved names, announcements, minimum app version, audit log. |
| `src/xfer.js` | v0.10: `xfer` sockets between two device keys of the same account (data file transfer). |
| `src/vaultkey.js` | v0.10: one wrapped data-file key per GitHub account (`POST /v1/vault/key`). |
| `src/gif.js` | 0.12: GIF search for desktop PCs: tokens (Hub) and search and files (Worker, stateless). |
| `src/common.js` | Errors and shape checks shared by the Hub and its v0.10 parts. |
| `src/github.js` | Token check (`POST/DELETE /applications/{client_id}/token`) and dev mode. |
| `src/crypto.js` | WebCrypto helpers: base64url, Ed25519 verify, SHA-256, HMAC, random ids. |
| `src/limits.js` | Every rate limit in one table, memory windows, and budgets kept in SQLite. |
| `src/platform.js` | The seam between workerd and the Node shim. |
| `shim.js` | Durable Object runtime for Node (`node:sqlite`, alarms, hibernatable sockets). Tests and dev only. |
| `dev.js` | `startLocalRegistry()`: the real Worker and Hub behind Node `http` + `ws`. Tests and dev only. |
| `mock-github.js` | `startMockGithub()`: device flow, app-token check and revoke, `/user`, and a fake TURN endpoint. |
| `test/*.test.js` | `node:test` suites (rules, accounts, sockets, admin, vault keys + xfer). No network. |

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

### 6. GIF search for desktop PCs (0.12, on by default)
A desktop PC searches GIFs through the registry, so GIF sites see the registry's address, never the
person's. The registry already sees each PC's address (SECURITY.md "Metadata"); it now also sees the
words searched for. `POST /v1/gif/token` (signed, in the Hub) gives a token good for an hour, at most 48
per account and 20,000 for everyone a day. `GET /v1/gif/search?q=` and `GET /v1/gif/file?u=&s=` are
answered by the Worker without the Hub; a file address must carry the registry's own signature from a
search, so nothing else is fetched. Files: no redirects, at most 10 MB, GIF/WebP/MP4 by their bytes.
Searches are cached an hour and files a day (Cache API). Per-token counts (120 searches, 1,200 files an
hour) live in each Worker instance's memory, so they are best-effort; the token caps are the hard limit.
- `GIF_PROVIDERS` (vars): `openverse` (default, keyless, mature results filtered), `commons` (Wikimedia
  Commons: no safe-search filter, so opt-in), `tenor` (needs `npx wrangler secret put TENOR_KEY`, a free
  Google Cloud key; check Tenor's current API terms first), comma-separated, or `off`.
- `GIF_CONTACT` (vars): a URL or e-mail for the User-Agent, which Wikimedia's User-Agent policy asks for.
  Use a project or contact page, never a personal address you don't want public.
- `GIF_TOKEN_SECRET` (secret, optional): otherwise derived from `GH_HMAC_SECRET`.
- Openverse's anonymous limits are tight (a few searches a minute per address, 20 results a page); the
  registry's one address shares them for every desktop user, and the hour-long cache helps. If that is
  not enough, register free Openverse API credentials (not yet wired in; it would be a small change).
- Free tier: each search is one Worker request plus up to 20 preview files (each one request), so
  roughly 4,000 searches a day fit in the 100k-request free Workers allowance next to everything else.

### Updating and rules that must not be broken
- Redeploy with `npx wrangler deploy`. Schema changes go in `src/hub.js` as `CREATE ... IF NOT EXISTS`
  or additive `ALTER`. Never rename or delete the `Hub` class or its migration: that deletes every account.
- **Never rotate `GH_HMAC_SECRET`.** It keys every account's GitHub hash. A new value orphans every
  account: people could no longer sign in to their names.
- **Never change `HUB_NAME`.** Every account and every data-file key lives in that one Durable Object; a
  new name starts an empty registry. See `SECURITY.md` for the recovery plan.
- Optional: `npx wrangler secret put VAULT_WRAP_SECRET` (32+ characters) wraps data-file keys apart from
  `GH_HMAC_SECRET` (rows re-wrap as they are read). Once set, never change or remove it.
- `GH_CLIENT_SECRET` can be rotated in GitHub at any time, with no code change and no downtime (an OAuth App
  allows two client secrets at once). By hand, and never pasted into a chat, issue or command line:
  1. GitHub > Settings > Developer settings > OAuth Apps > Snug's app > **Generate a new client secret**.
  2. `npx wrangler secret put GH_CLIENT_SECRET` and paste it at the hidden prompt (or the Cloudflare
     dashboard: Workers & Pages > snug-registry > Settings > Variables and Secrets, type *Secret*,
     then Save and deploy). Don't pass it as a command argument or through `echo` (it would land in the
     shell history). Either way a new version deploys and the Hub restarts with the new value.
  3. Check: sign in with GitHub from the desktop app. `config_error` or `github_invalid` means the new
     value is wrong; the old secret still works, so put the right one again.
  4. Delete the old secret in GitHub.
  5. If the old one may have leaked, also **Revoke all user tokens** on the OAuth App. People just sign
     in again; Snug never stores GitHub tokens.
  The registry needs this secret only to ask GitHub whether a token belongs to Snug's app (and to revoke
  it); the desktop app never holds it.
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

`account` = `{uid, username, kver, claimedAt, renamedAt, renameAt}`. `ts` must be within 5 min of the
registry's clock; a state-changing call (claim, rebind, cancel, rename, release, every mutating signed call)
may be at most 60 s ahead. Mutating calls need `ts >` the last ts accepted **from the same signer**: the
current device key's counter is `accounts.last_ts`, every other signer (a recovery key, a pending move's key)
has its own (`signer_ts`), and a counter moves only when the call succeeded. A completed move starts the new
key's counter at no later than now.

Socket frames, client → Hub: `watch {uids}`, `visible {on}`, `sig {id,to,box}` (≤ 16 KB),
`relay {id,to,box}` (≤ 64 KB), `knock {id,to,box}` (≤ 4 KB, always answered `{t:'ok', id}`),
`knocked {ids}`, and the literal `ping` (auto-answered `pong`). Hub → client: `ready`, `presence`,
`sig`, `relay`, `knock`, `rebind`, and `err {id, code}` with codes `unavailable`, `too_big`,
`rate_limited`, `too_many`, `relay_unavailable` and `bad_request`. Close codes: 4001 bad auth, 4002
replaced, 4003 revoked, 4004 rebound (reconnect now), 4005 auth timeout, 4006 move stopped, 4029 rate limited.

Every limit is in `src/limits.js` (`DEFAULT_LIMITS`).

### v0.10: admin, bans, notices, data file keys, xfer

v0.10 calls send their arguments as one JSON string `p`, signed whole: `{op}\n{uid}\n{ts}\n{p}`.

| Call | Body | Signed by / string |
|---|---|---|
| `POST /v1/admin` | `{uid, ts, p, sig}`, `p` = `{a, ...}` ≤ 8192 chars | current key, `admin`, mutating (a captured call never replays). Actions below. |
| `POST /v1/vault/key` | `{uid, ts, p:"{}" \| "{\"kid\":n}", sig}` | current key only (never a pending move's key, REG-H1), `vault-key` → `{key, kid}` (created on first use, one per GitHub account; `p:"{}"` is the newest key, `{kid}` an older one for an older file) |
| `POST /v1/vault/rotate` | `{uid, ts, p:"{}", sig}` | current key, `vault-rotate`, mutating → `{kid}`: a new newest key; older keys stay readable by `{kid}` (REG-L1, 5 a day) |
| `GET /v1/notices` | | public → `{min, ann:[{id, text, level, at, until}]}` |

Admin actions (`a`) and the right each needs: `me` (anyone → `{perms}`), `stats` (stats), `user.find {q}`
(names or ban), `name.rename {uid, name}`, `name.free {name}`, `name.reserve {name, note?}`,
`name.unreserve {name}`, `name.reserved` (names), `ban {uid, reason, until|null}`, `unban {uid}`, `bans`
(ban), `ann.add {text, level, until?}`, `ann.remove {id}` (ann), `min.set {v|null, app}` (update; never
above `app`, the caller's own version), `admin.grant {uid, perms}`, `admin.revoke {uid}`, `admins`
(owner only), `audit {before?}` (stats), `move.force {uid, fp | ik}` (owner only, for a stolen current
device: bound to one device key. Without `fp`/`ik` it is refused (`bad_request`): someone with the recovery key
or the GitHub login could swap their own key into the waiting move between the check and the force. With `fp` (the security code the new PC shows, spaces and case ignored) or
`ik` (its device key), the account's next move of exactly that key within 7 days (GitHub-proved or by recovery
key) completes at once; a waiting move of that `ik` completes now. Moves of any other key wait as usual. The forced-out key gets no `old` xfer
role and the vault key rotates; a force armed before v0.12's binding applies to no move), `vault.export {after?}` (owner only: the vault key rows,
still wrapped; audited). The owner (`OWNER_GITHUB_IDS`) has every right; nobody acts on
the owner; only the owner acts on an admin. Changes are written to `audit` (newest 5000 kept; bans, grants, renames, `min.set`, `move.force` and
`vault.export` are kept a year instead); plain
reads (`me`, `stats`, `bans`, `name.reserved`, `admins`, `audit`) are not. Errors: `forbidden` 403,
`banned` 403 (`{until, reason}`), `not_found`, `bad_request`.

Enforcement: a banned account's signal auth gets `{t:'banned', until, reason}` and close 4010; its
`lookup`, `turn`, `claim`, `rename`, `rebind` and `release` answer `banned`. With a minimum version set,
an auth frame whose `v` is missing or lower gets `{t:'update', min}` and close 4011 (sockets below a new
minimum are closed the same way). `ready` carries `notices {min, ann}` and, for admins, `admin: [perms]`.
Live frames: `notices`, `admin {perms}`, `account {username}` (a forced rename).

`xfer` sockets: auth `{t:'auth', uid, mode:'xfer', sig, v}` over `signal-xfer\n{uid}\n{n}`, by the current
key (role `cur`), the pending move's key (`pending`) or the key just before the current one for 30 days
(`old`). `ready {mode:'xfer', role, kver, keys:{chain, pending}, others}`; `xfer-peer {ik, xk, role, on}`;
`xfer {id, to:<ik>, box ≤ 64 KB}` → `xfer {from:<ik>, box}` to the same account's socket(s) of that key only.
Banned accounts and old apps may use xfer and the vault key (their own data). Budgets: `xferDay`,
`xferBytesDay`, `xferBurst`; `RELAY_OFF_AT` applies. Two xfer sockets per key at most (a third: 4002).
`/v1/health` is `{ok:true, v:3}`.

### v0.12: accounts with no GitHub (`src/keyacct.js`)

On only when `KEY_ACCOUNTS = "1"` (wrangler.toml `[vars]`); otherwise every route below answers exactly like
an unknown path. No existing route, field, signed string, status or socket frame changes for 0.11 apps
(`test/keyacct.test.js` runs a whole 0.11 flow with the feature on and off and compares the answers).
A keypair account is an ordinary `accounts` row whose `ghh` is `a:<uid>` (never a GitHub hash), so vault
keys, renames, bans and `move.force` work for it unchanged. `rk` is an Ed25519 key whose seed the app
derives from the recovery secret (`js/lib/recovery.js`); the registry stores only its public half.

| Call | Body | Signed by / string |
|---|---|---|
| `POST /v1/pow` | `{purpose:"register"}` | none (20 an hour per address) → `{c, bits, exp}` (10 min, MAC-protected, single use) |
| `POST /v1/register` | `{ik, xk, rk, username, c, nonce, ts, sig, rsig}` | `ik` **and** `rk` over `register\n{ik}\n{xk}\n{rk}\n{username}\n{c}\n{nonce}\n{ts}`; `SHA-256("snug-pow-v1\n"+c+"\n"+ik+"\n"+nonce)` starts with `bits` zero bits → `{account}` |
| `POST /v1/recover` | `{rk, ik, xk, ts, sig, rsig}` | `rk` and the new `ik` over `recover\n{rk}\n{ik}\n{xk}\n{ts}` → `{status:"pending", uid, account, at}`: a 72 h move (the old PC gets the usual `rebind` frame and can stop it); at once when the owner armed `move.force` |
| `POST /v1/move/hello` | `{ik, xk, ts, sig}` | new `ik`, `move-hello\n{ik}\n{xk}\n{ts}` → `{code:"XXXXX-XXXXX", hid, exp}` (10 min, Crockford base32) |
| `POST /v1/move/wait` | `{hid, ts, sig}` | the hello's `ik`, `move-wait\n{hid}\n{ts}` → `{state: waiting \| done (+account) \| expired}` |
| `POST /v1/move/peek` | `{uid, ts, p:{code}, sig}` | current key, `move-peek` → `{ik, xk, kver}` (5 tries a code, 10 codes a day) |
| `POST /v1/move/accept` | `{uid, ts, p:{code, prev, knock?}, sig}` | current key, `move-accept`, mutating; `prev` as `/v1/rebind/approve` → `{ok}`: the move completes now; `knock {id, box}` is the restore list for the new key |
| `POST /v1/recovery/set` | `{uid, ts, p:{rk, rsigNew, rsigOld?}, sig}` | current key; both rsigs over `recovery-set\n{uid}\n{rk}\n{ts}` → `{state:"set"}` with the old key, else `{state:"pending", at}` (7 days), a GitHub account's first key included |
| `POST /v1/recovery/cancel` | `{uid, ts, rsig, what?}` or `{ticket, ts, sig, what?}` | current `rk`, `recovery-cancel\n{uid}\n{ts}` (with `what`: `\n{what}` appended; its own replay counter): stops a waiting recovery key and a waiting GitHub link or unlink, or with `what: "key"` / `"link"` only that one. Or a fresh `/v1/auth/github` ticket (any key may hold it, so a new PC can send it), signed by the ticket's key over `recovery-cancel-gh\n{ticket}\n{ts}` (`\n{what}` likewise): a GitHub account's own GitHub stops its waiting recovery key; a keypair account's working linked GitHub stops its waiting recovery key and its waiting unlink; (0.13) the GitHub account a waiting link would add stops that link only (every link waiting for that GitHub account, on any account) → `{ok}` |
| `POST /v1/recovery/drop` (0.13) | signedP `recovery-drop`, `p = {what: "key"}` | device key: stops a **first** recovery key the device asked for (an account with no recovery key yet, so nothing is replaced). `not_found` when none waits, `forbidden` when the account has a current recovery key (that key, or a GitHub account's GitHub, cancels instead) → `{ok}` |
| `POST /v1/recovery/whose` | `{rk, ts, rsig}` | `rk` over `recovery-whose\n{rk}\n{ts}` → `{uid}` of the account whose current recovery key it is (`not_found` otherwise); changes nothing. A PC that still holds an account asks this before `/v1/recover`, to refuse another account's key without starting a move |
| `POST /v1/link/github` | `{uid, ts, p:{ticket}, sig, rsig?}` | current key, `link-github`; a fresh `new` ticket issued to the same key → `{ok, state:"pending", at}`: the link works 7 days later unless the recovery key cancels it. Refused while a GitHub account is linked (`already_linked`: unlink first). With `rsig` (the current `rk` over the same string) → `{ok, state:"done"}` at once. A working link signs in to (and can move) the account |
| `POST /v1/link/github/remove` | `{uid, ts, p:{}, sig, rsig?}` | current key, `unlink-github` → `{ok, state:"done"}` (nothing linked; a waiting link is dropped) or `{ok, state:"pending", at}` (a working link goes 7 days later unless the recovery key or the linked GitHub cancels). With `rsig` (the current `rk` over the same string): `{ok, state:"done"}`, unlinked at once |
| `POST /v1/release/key` | `{uid, ts, p:{}, sig, rsig}` | current key **and** `rk` over `release-key\n{uid}\n{ts}\n{p}` → `{ok}` (the name is free at once) |
| `POST /v1/account/kind` | `{uid, ts, p:{}, sig}` | current key, or the waiting move's key (a PC moving in sees what waits on the account) → `{kind, recovery:{set, pendingAt, rk}, github:{linked, pending:{change:"link"\|"unlink", at}\|null}, move:{via, at}\|null}` (`rk`: the current recovery public key or null; left out for the waiting move's key) |

Errors added: `pow_invalid` 400, `too_new` 409 (`{retryAt?, what?}`), `key_in_use` 409, `recovery_pending`
409, `move_pending` 409, `link_too_new` 409 (`{retryAt}`), `already_linked` 409. New frame, only to sockets whose auth `v` is 0.12.0
or newer: `{t:'recovery', state}`.

Second proofs the device adds or removes alone wait 7 days and another proof can stop them: a GitHub link or
unlink on a keypair account (the recovery key stops either; the linked GitHub stops an unlink), a GitHub
account's first recovery key (its GitHub sign-in stops it), and any new recovery key set without the old one
(the old key, or the GitHub account or linked GitHub, stops it). A link can't replace another: the device must
unlink first, which itself waits. The device and the recovery key together link or unlink at once.
`/v1/release` through a linked GitHub (instead of the account's own) needs a link at least 7 days old
(`link_too_new`), counted from when the link took effect, so a link that came through the wait can delete the
account only 7 days after it started working. Where only the device and the linked GitHub are left (no recovery
key at hand), neither can remove the other: the result is a stand-off the registry owner settles.

After a move that completed without the old PC's approval, the proof that started it wins: a recovery move
drops a linked GitHub; a GitHub move drops a GitHub account's recovery key. Such a move also drops any waiting
recovery key or link change (the device left behind asked for them) and rotates the account's data-file key
(old files stay readable by `kid`).

Abuse limits (`src/limits.js`; raise `POW_BITS` or lower `regGlobal` without a code change):

| Control | Value |
|---|---|
| Proof of work | `POW_BITS` (20) + 1 per doubling of sign-ups past 30 in the last hour (a sliding hour: the previous hour counts by how much of it is still within 60 min), at most 28. `/v1/register` checks the challenge against the difficulty **now**, one bit of slack |
| Per address | `ipPow` 20/h, `ipAccount` 5/h, `ipRegister` 3/day (IPv6 by /48), spent only by a sign-up that worked; a sign-up refused for its name (invalid, reserved, taken, too short) gives back its `ipAccount`, and `ipRegTry` 30/h (memory, /48) bounds the tries. `ipRegisterWide` is not a cap: from 20 sign-ups in a day per IPv6 /32 (IPv4: the address), that /32's proof of work needs 2 more bits, and 2 more each time the count doubles (a /32 can hold a whole tunnel broker or mobile carrier). `/v1/register` checks that too, with 2 bits of slack. The per-address sign-up counts are kept in SQLite |
| Global | `regGlobal` 300 sign-ups in a sliding hour (GitHub sign-up is not counted) |
| New accounts (72 h) | knocks 10/day (2 per person), lookups 60/day, TURN 3/day |
| Names | 2 or 3 characters only after 30 days; the first rename after 7 days |
| Never connected | deleted after 7 days (the name is freed); banned accounts and accounts with a move waiting are kept, and a completed move gives the new PC its own 7 days |
| Idle | optional `KEY_ACCOUNT_IDLE_DAYS` (off unless set) frees names of accounts with no connection for that long; banned accounts, ones with a move waiting, ones still connected and (0.13) ones with a GitHub account linked are kept |

None of this makes one person equal one account: someone with many addresses and spare CPU can still make
accounts slowly. The registry can still read nothing of what friends send each other, and, as for GitHub
accounts, it holds every data-file key (wrapped with its secrets).

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
