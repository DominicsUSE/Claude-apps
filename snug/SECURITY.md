# Security policy for Snug

## Reporting a vulnerability

Please report security problems **privately**, never in a public issue, pull request or discussion.

1. Open <https://github.com/DominicsUSE/Claude-apps/security/advisories/new> (repository **Security** tab,
   **Report a vulnerability**). This is GitHub's private vulnerability reporting: only you and the
   maintainers can see the report.
2. Say which part is affected (the web/local server, the desktop app, the registry at
   `snug-registry.snugapp.workers.dev`), the version (Settings, About, or `package.json`), the steps to
   reproduce, and what an attacker gains.
3. Do not include anyone else's data, and do not test against accounts that are not yours.

What happens next: an acknowledgement within 7 days, an assessment within 14, and a fix in a new release as
fast as the severity calls for. A fixed desktop release is pushed to every install by the built-in updater,
and the registry can refuse versions below a minimum. You are credited in the advisory unless you ask not to
be. Good-faith research that follows this policy is welcome and will not be pursued.

Problems in a dependency (Electron, `ws`, Cloudflare Workers) go to that project too; tell us as well, so
Snug can ship the patched version.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.10.x (latest release) | Yes |
| Anything older | No. The desktop updater moves every install to the latest release, and the registry can refuse old versions (`min_version`). |

Security fixes go into the newest release only; there are no backports.

## Security model

### What Snug protects

- **Accounts.** Passwords (web and LAN accounts) are stored as scrypt hashes, with common passwords (about
  38,000) refused, two-factor sign-in (TOTP with backup codes) and slowing lockouts that a stranger cannot
  use to lock the owner out. Desktop (P2P) accounts have no password at all. Since v0.12 they need no
  GitHub account either: the account is the PC's device key plus a recovery key (20 random bytes shown
  once; the registry keeps only the public half of a key derived from it, `registry/src/keyacct.js`).
  GitHub accounts still work: their token is checked once by the registry and revoked, never stored.
- **Account takeover with a recovery key.** Someone who copies the recovery key only starts a **move**,
  which waits 72 hours unless the current PC approves. The current PC is told it was the recovery key, can
  stop it, and can then replace the key with the old one in hand (the copy stops working at once). A new
  key set without the old one waits 7 days, and the old key can cancel it.
- **Account takeover through GitHub.** Someone who phishes or steals the GitHub login only starts a
  **move**, which waits 72 hours (or the approval of the current PC). The current PC is told and can stop it.
  Until then the newcomer gets no vault key and no data file.
- **Sessions.** Random 256-bit tokens in `HttpOnly`, `SameSite`, `__Host-`/`Secure` cookies (over HTTPS).
  Only a hash is stored. Sessions expire, and a password change or "sign out everywhere" ends the rest.
- **Who can see and do what.** Every action is authorized on the server against the database (membership,
  roles, blocks, privacy settings). The browser only decides what to show.
- **Messages between PCs.** Friends on different PCs talk over an end-to-end encrypted link (signed X25519
  handshake, then AES-256-GCM, forward secret and replay-safe). The registry relays sealed frames and never
  sees content. Each friend's key is pinned and a change is shown loudly.
- **Data at rest that matters most.** Device identity keys are wrapped with the operating system's key store
  (Electron `safeStorage`). Two-factor secrets and database snapshots are encrypted with AES-256-GCM under a
  data key kept outside the database. The portable data file (`.snugvault`) is AES-256-GCM encrypted and
  tamper-evident, under a key the registry holds wrapped and hands only to the account's current device.
- **The desktop app itself.** Sandboxed, context-isolated renderers with no Node access, navigation and new
  windows locked to Snug's own origin, Electron fuses that turn off `RunAsNode`, `NODE_OPTIONS` and the
  inspector and enforce asar integrity, and an updater that installs only files whose SHA-256 matches the
  release's checksum file (and, once a key is pinned, that file's Ed25519 signature).
- **Common web attacks.** Prepared SQL statements only; messages rendered as a token tree, never as HTML; a
  strict Content-Security-Policy with scripts only from Snug; cross-site requests and WebSocket upgrades
  refused unless they come from Snug's origin; `Host` checking against DNS rebinding; outbound fetches limited
  (GIFs: only the provider's media hosts, no redirects; link previews: public addresses only, each redirect
  checked, time and size caps); rate limits per person and per
  address.

### What Snug cannot protect against

- **A compromised device.** Malware running as you, or someone with your unlocked PC, can read what you can
  read. Keys wrapped by the OS key store protect against other users and offline copying of the disk, not
  against code running in your session. If the OS key store is unavailable, Snug says the key file is "not
  protected by the OS".
- **The machine that hosts a server.** Houses and their conversations live in that server's SQLite database,
  which is not encrypted as a whole. Whoever runs a Snug server, or gets its disk, can read its houses. Use
  full-disk encryption and keep `data/secret.key` (or `SNUG_DATA_KEY`) stored apart from backups.
- **The registry operator.** The registry holds every account's vault key (wrapped under its own secrets). Its
  operator, or anyone who obtains both the Durable Object data and those secrets, could decrypt a data file
  they also obtain. The registry never sees messages between PCs.
- **Metadata.** The registry sees who is online, which accounts signal each other and when, and IP addresses
  (stored only as keyed hashes or truncated). Voice and video go peer to peer, so the other side of a call
  sees your IP address unless "Hide my IP from friends" is on and a relay server is set up.
- **People you talk to.** Anyone in a conversation can copy, screenshot or forward it. Deleting a message
  removes it from Snug, not from someone else's copy.
- **A stolen GitHub account combined with an absent owner.** If the current PC is offline for the whole
  72-hour wait, a move started with a stolen GitHub login completes. Keep GitHub two-factor sign-in on.
- **A stolen recovery key combined with an absent owner,** the same way. And a lost PC plus a lost recovery key
  (with no GitHub linked) means the account is gone: nobody, including Snug, can reset it.
- **One person, many accounts.** Accounts without GitHub cost a proof of work, an address budget (3 a day per
  /48) and a global budget. These slow down mass sign-ups; they do not stop someone with many addresses.

## Controls in place

| Area | Control | Where |
| --- | --- | --- |
| Passwords | scrypt (N=2^15, r=8, p=3), common-password list, no username in the password, rehash on sign-in | `server/auth.js` |
| Brute force | Per-address and per-account limits with doubling waits kept in the database; IPv6 grouped by prefix | `server/auth.js`, `registry/src` |
| Two-factor | TOTP encrypted under the data key, backup codes stored as HMACs, attempt limits | `server/account.js` |
| Sessions | 256-bit tokens, hashed at rest, `__Host-` cookies, absolute and idle expiry, revoke-all | `server/auth.js` |
| Authorization | Server-side checks on every op, one shared permission and role model | `js/lib/perms.js`, `js/lib/safety.js`, `js/lib/places.js` |
| Input and output | Type and length checks on every field, prepared SQL, token-tree rendering, strict CSP | `server/`, `js/`, `server/index.js` |
| CSRF, rebinding, SSRF | Origin checks, `Host` allow-list, outbound fetches checked per hop (allow-lists, no private addresses) | `server/index.js`, `server/media.js`, `server/linkpreview.js` |
| Transport | HTTPS with HSTS behind a TLS proxy (`SNUG_SECURE=1`); E2E links between PCs; TLS to the registry | `README.md` (Putting it online) |
| Encryption at rest | AES-256-GCM for TOTP secrets, snapshots and data files; OS key store for device keys; HMACs for GitHub ids | `server/vault.js`, `server/vaultfile.js`, `server/dbbackup.js`, `server/identity.js` |
| Audit and detection | `auth_events` and `security_events` tables, JSON log lines without secrets, burst detection with `suspicious` alerts, "new sign-in" notices, alerts in Settings > Account > Recent activity; refused cross-site requests and sockets, foreign `Host` names, rate-limit hits (HTTP, sockets and socket ops), evicted sockets, refused role-hierarchy changes, filtered webhook posts and CSP reports all reach one log; signed and audited registry admin actions | `server/seclog.js`, `registry/src/admin.js` |
| Error handling | Users see plain messages; stack traces and internals stay in the server log | `server/` |
| Backup and recovery | Daily encrypted, integrity-checked database snapshots with automatic restore of the newest good one; the portable data file; registry point-in-time recovery | `server/dbbackup.js`, `server/vault.js`, `registry/SECURITY.md` |
| Desktop hardening | Sandbox, context isolation, navigation lock, Electron fuses, hardened runtime on macOS, verified updates | `desktop/main.js`, `desktop/fuses.js`, `desktop/updater.js` |
| Release integrity | Release jobs only in the protected `release` environment; build jobs skip npm install scripts; read-only tokens elsewhere; every action pinned to a commit | `.github/workflows/`, `desktop/workflows.test.js` |
| Registry | Signed device-key requests, move delay, wrapped vault keys, bans, minimum version, per-address and global budgets | `registry/SECURITY.md` |

### Automated security testing (all free and open source)

`.github/workflows/security.yml` runs on every push and pull request and every week:

| Tool | What it checks | Fails the build on |
| --- | --- | --- |
| `npm audit` | Known advisories in `snug/`, `snug/registry`, `snug/desktop` (development tools included) | high or critical |
| [OSV-Scanner](https://github.com/google/osv-scanner) | Every lockfile in the repository against the OSV database | high or critical in `snug/` (the rest is reported) |
| [gitleaks](https://github.com/gitleaks/gitleaks) | Secrets anywhere in the git history (`snug/.gitleaks.toml`) | any finding |
| [CodeQL](https://codeql.github.com) | Snug's JavaScript and the workflows, `security-extended` queries | high or critical from precise queries |
| [Semgrep CE](https://github.com/semgrep/semgrep) | `p/javascript`, `p/nodejs`, `p/owasp-top-ten`, `p/secrets` over `snug/` (`snug/.semgrepignore`) | severity ERROR, security, confidence above low |
| [Electronegativity](https://github.com/doyensec/electronegativity) | Electron misconfigurations in `snug/desktop` | high or critical, firm or certain |
| Dependency review | New dependencies in a pull request | high or critical |
| Workflow rules (`desktop/workflows.test.js`) | Least-privilege tokens, actions pinned to commits, no kept credentials, release jobs in the `release` environment | any rule broken |

Every report also goes to the repository's code scanning alerts. `.github/security/gate.mjs` decides what
fails; a finding that a person checked and found not exploitable goes into `.github/security/reviewed.json`
with the reason, by rule and file. Tests, mocks, generated and third-party code are reported but never fail.

[Dependabot](../.github/dependabot.yml) proposes updates weekly for the three npm folders and the pinned
actions, grouped, and security updates as soon as an advisory appears. Routine updates wait 7 days after a
release, which keeps most hijacked versions out.

The same checks run locally from `snug/` (install the tools first: `gitleaks`, `osv-scanner`, `semgrep`;
Electronegativity runs through `npx`):

```sh
npm run audit:deps       # npm audit, three folders, high and above
npm run audit:secrets    # gitleaks over the whole history
npm run audit:osv        # OSV-Scanner over every lockfile, gated on snug/
npm run audit:electron   # Electronegativity over desktop/
npm run lint:security    # Semgrep with the four rule packs
npm run audit:all        # all of the above
```

Security regression tests live with the other tests (`npm test`, `tests/server-sec-*.test.js`,
`registry/test/`, `desktop/*.test.js`).

## For maintainers

- Turn on **Private vulnerability reporting**, **Dependabot alerts and security updates**, **Secret scanning
  with push protection** and **Code scanning** in the repository's security settings (all free for public
  repositories), and require the `Security scans` checks on the default branch.
- Never rotate `GH_HMAC_SECRET` and never change `HUB_NAME`: see `registry/SECURITY.md`.
- Keep `SNUG_UPDATE_SIGNING_KEY` only in the protected `release` environment.
