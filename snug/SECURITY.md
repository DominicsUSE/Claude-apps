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
| The latest release (0.12.x) | Yes |
| Anything older | No. The desktop updater moves every install to the latest release, and the registry can refuse old versions (`min_version`). |

Security fixes go into the newest release only; there are no backports.

## Security model

### What Snug protects

- **Accounts.** Passwords (web and LAN accounts) are stored as scrypt hashes, with common passwords (about
  38,000) refused, two-factor sign-in (TOTP with backup codes) and slowing lockouts that a stranger cannot
  use to lock the owner out. Desktop (P2P) accounts have no password at all: they are proved with GitHub's
  device flow, and the GitHub token is checked once by the registry and revoked, never stored.
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
| Release integrity | Release jobs only in the protected `release` environment; build jobs skip npm install scripts; read-only tokens elsewhere; every action pinned to a commit and every container image to a digest; SHA256SUMS per platform, Ed25519-signed when the update key is set; GitHub build provenance attestations; Windows Authenticode signing as soon as a credential is configured (see "Code signing") | `.github/workflows/`, `desktop/release.sh`, `desktop/workflows.test.js` |
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
| [OWASP ZAP](https://www.zaproxy.org) baseline | A seeded Snug server started on the runner: headers, cookies, CSP, information leaks on the HTTP routes (passive; it does not attack, and it doesn't exercise the WebSocket operations). Official image pinned by digest; accepted alerts with the reason in `.github/security/zap-rules.tsv`; reports kept as the `zap-baseline` artifact | high risk |
| Dependency review | New dependencies in a pull request | high or critical |
| Workflow rules (`desktop/workflows.test.js`) | Least-privilege tokens, actions pinned to commits, images pinned to digests, no kept credentials, release and signing jobs in the `release` environment, signing credentials only in signing jobs, every signature checked | any rule broken |

Every report also goes to the repository's code scanning alerts. `.github/security/gate.mjs` decides what
fails; a finding that a person checked and found not exploitable goes into `.github/security/reviewed.json`
with the reason, by rule and file. Tests, mocks, generated and third-party code are reported but never fail.

[Dependabot](../.github/dependabot.yml) proposes updates weekly for the three npm folders and the pinned
actions, grouped, and security updates as soon as an advisory appears. Routine updates wait 7 days after a
release, which keeps most hijacked versions out.

The same checks run locally from `snug/` (install the tools first: `gitleaks`, `osv-scanner`, `semgrep`;
Electronegativity runs through `npx`; the ZAP scan needs Docker):

```sh
npm run audit:deps       # npm audit, three folders, high and above
npm run audit:secrets    # gitleaks over the whole history
npm run audit:osv        # OSV-Scanner over every lockfile, gated on snug/
npm run audit:electron   # Electronegativity over desktop/
npm run lint:security    # Semgrep with the four rule packs
npm run audit:all        # all of the above
npm run audit:zap        # ZAP baseline against a seeded server (Docker; ZAP_PORT=8787 by default)
```

Security regression tests live with the other tests (`npm test`, `tests/server-sec-*.test.js`,
`registry/test/`, `desktop/*.test.js`).

## For maintainers

- Turn on **Private vulnerability reporting**, **Dependabot alerts and security updates**, **Secret scanning
  with push protection** and **Code scanning** in the repository's security settings (all free for public
  repositories), and require the `Security scans` checks on the default branch.
- Never rotate `GH_HMAC_SECRET` and never change `HUB_NAME`: see `registry/SECURITY.md`.
- Keep `SNUG_UPDATE_SIGNING_KEY` and every code-signing credential only in the protected `release` environment
  (Settings > Environments > release: deployment branches limited to the release branches; add yourself as a
  required reviewer if you want to approve each release).

### Update signing (turn it on once)

The release jobs already sign `SHA256SUMS-<platform>.txt` whenever the `SNUG_UPDATE_SIGNING_KEY` secret exists
(`desktop/release.sh`, `desktop/sign-sums.js`); the app only *requires* a signature once a public key is pinned.
Do this on your own computer, never in CI, and never commit or paste the private key anywhere:

1. `cd snug/desktop && node sign-sums.js --new-key snug-update-key.pem` writes the private key (owner-only file)
   and prints its public key. Make a second, backup key the same way (`snug-update-key-backup.pem`) and keep
   both files offline (a password manager or an encrypted USB stick), apart from each other.
2. GitHub: Settings > Environments > release > Add environment secret `SNUG_UPDATE_SIGNING_KEY`, value: the whole
   contents of `snug-update-key.pem` (from `-----BEGIN PRIVATE KEY-----` to the end line).
3. Ship one release as it is (the key exists, nothing pinned yet): its checksum files get `.sig` files next to
   them (`sign-sums.js` checks each signature before it is uploaded, so a bad key fails the release job).
4. Put both printed public keys in `UPDATE_PUBKEYS` in `desktop/updater.js` (main first, backup second), run
   `node --test updater.test.js release.test.js`, and release that version. From then on an update without a
   valid signature by one of the pinned keys is never offered or installed, and `release.sh` refuses to publish
   without the key. If the main key is lost or leaks: sign with the backup, and pin a new backup in the next
   release.

### Code signing (Windows; switch it on when you have a credential)

`build-snug-windows.yml` signs the app, then the installer and the portable exe, as soon as the repository
variable `SNUG_WINDOWS_SIGNING` is set; each signature is checked with `Get-AuthenticodeSignature`. Signed files
can still get a SmartScreen warning for a while after each new version until they gain download reputation.

- **SignPath Foundation (free for qualifying open-source projects).** Apply at <https://signpath.org> (OSI
  licence, public repository, builds on GitHub-hosted runners, MFA for maintainers). When accepted: in SignPath,
  create the project and two artifact configurations by pasting `desktop/signpath/snug-app.xml` (slug
  `snug-app`) and `desktop/signpath/snug-installers.xml` (slug `snug-installers`); link the project to this
  repository with the GitHub connector (trusted build system). In GitHub: environment `release` secret
  `SIGNPATH_API_TOKEN` (a CI user's API token); repository variables `SIGNPATH_ORGANIZATION_ID`,
  `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_POLICY_SLUG` (for example `release-signing`); then variable
  `SNUG_WINDOWS_SIGNING` = `signpath`.
- **A certificate you bought (PFX).** Environment `release` secrets `WIN_CSC_LINK` (the `.pfx` file as base64:
  `[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx"))` in PowerShell, or `base64 -w0 cert.pfx`)
  and `WIN_CSC_KEY_PASSWORD`; then variable `SNUG_WINDOWS_SIGNING` = `pfx`. Certificates whose key must stay on
  a hardware token can't be used this way; use SignPath or a cloud signing service.
- Azure Trusted Signing also works with signtool but is a paid service; it is not wired up.
- A misspelt `SNUG_WINDOWS_SIGNING` fails the build. With signing on, a signing failure stops the release; it
  never falls back to unsigned files. Remove the variable to go back to unsigned releases.

macOS: the app is ad-hoc signed with the hardened runtime. Notarization (no Gatekeeper warning) needs the paid
Apple Developer Program; `build-snug-mac.yml` says what to add if you join.
