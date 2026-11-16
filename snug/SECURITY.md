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
  use to lock the owner out. Desktop (P2P) accounts have no password at all. Since v0.12 they need no
  GitHub account either: the account is the PC's device key plus a recovery key (20 random bytes shown
  once; the registry keeps only the public half of a key derived from it, `registry/src/keyacct.js`).
  GitHub accounts still work: their token is checked once by the registry and revoked, never stored.
- **Server accounts that forgot their password** (v0.12). A recovery key resets the password with no email:
  the server keeps only a scrypt hash of a key derived from it, so a database thief or the server's owner
  can't use it. Using it signs out every device and removes passkeys; a key works once. Anyone holding the
  key and the username can do the same, so it is as sensitive as the password, and it gets past two-factor
  sign-in (someone who forgot a password has often lost the phone too). So replacing a key needs the
  password (and a code): a session alone may save only a first key, within 10 minutes of signing up or of
  using the old key. Wrong keys are counted per account and address, so tries from elsewhere can't lock the
  owner out. The owner's `npm run reset-password` deletes the key too. Optional **passkeys** add a sign-in
  that phishing pages can't replay (bound to the server's domain); only their public halves are stored.
- **Account takeover with a recovery key.** Someone who copies the recovery key only starts a **move**,
  which waits 72 hours unless the current PC approves. The current PC is told it was the recovery key, can
  stop it, and can then replace the key with the old one in hand (the copy stops working at once). The copy
  can't stop the PC from pressing Stop: the recovery key and the device key keep separate replay counters,
  and signed changes can be dated at most a minute ahead.
- **A stolen current PC.** The PC's key alone can't add a second proof at once: a new recovery key set
  without the old one, a GitHub account's first recovery key, and linking or unlinking GitHub on an account
  without GitHub all wait 7 days. The recovery key cancels them; so does a GitHub sign-in (a GitHub
  account's own, or the linked GitHub of an account without GitHub, which can cancel an unlink or a new
  recovery key). The person can do this from a new PC while the account moves there: it shows the waiting
  changes. The PC's key can't replace a linked GitHub (unlink first, which waits), and deleting the account
  through a linked GitHub needs a link that has worked for at least 7 days. With the device and the recovery
  key together, a link or unlink happens at once. If the thief has the PC and the person has only the linked
  GitHub (no recovery key), neither side can remove the other's proof; the registry owner settles it. The
  registry owner's forced move (`move.force`) must name the security code (or key) of the person's new PC,
  so the thief can't use it up with a move of its own or swap one in. The PC's key can still move the account at once with a pairing code and stop
  other moves; recovery from that is the registry owner's forced move (`registry/SECURITY.md`).
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

### End-to-end encrypted conversations (0.12, offered by default; `SNUG_E2EE=off` stops offering it)

Direct messages and groups whose members have all turned on encryption are end-to-end encrypted:
messages, edits, replies, thread replies, attachments, GIFs, stickers and scheduled messages. Against
theft of the database, WAL, snapshots, files folder or disk, an operator or admin who reads stored rows,
logs or backups, and server bugs that leak rows, the server holds only ciphertext. The server can't alter
a message, move it to another message, conversation, thread or revision, or forge its author (AEAD
binding, a device signature, and a device list signed by the account key). Removed devices and members
get nothing sent after their removal. Key substitution by the server is caught when two people compare
safety numbers.

It does not protect against whoever serves the browser's JavaScript (an operator who changes the code
can read messages in a browser; the desktop app runs its own built-in code, also when it joins another server, except on a server's own page, which its window title names), membership decided by the
server (ghost members), withheld or delayed messages, metadata (who, when, how much, group names,
reactions, devices, IP addresses), compromised devices and people in the conversation, history readable
with the history key (on by default) or the recovery key and password, messages sent before a
conversation turned encrypted, and calls. There is no per-message forward secrecy and no deniability.

**Protocol, briefly** (full design in the v0.12 e2ee spec; code in `js/lib/e2ee/`, `js/e2ee/`,
`server/e2ee.js`, `server/e2ee-conv.js`): WebCrypto only (Ed25519, X25519, HKDF-SHA256, HMAC,
AES-256-GCM); HPKE base mode (RFC 9180, suite X25519/HKDF-SHA256/AES-256-GCM) from the vendored
`@hpke/core` (checked against the RFC's test vectors). Each account has an identity key (Ed25519) that
signs its device list, and a history key (X25519) per weekly epoch. Each device has a non-extractable
signing key and a weekly prekey (X25519) signed by it. A message gets a fresh 32-byte key; the body
(padded) is sealed with AES-256-GCM with the signed header as associated data; the header names the
conversation, place, message id, revision, author and device, recipients and declared mentions, and is
signed by the device; the key is sealed with HPKE to every current trusted device of every member and to
each member's current history key. The server refuses a recipient set that isn't exactly the current
one (`e2ee_stale`), so a client fetches newer keys and seals again. Attachments are sealed whole with
AES-256-GCM under a key carried in the message. Safety numbers follow libsignal's numeric fingerprint
(version 0) over the account keys. A new device is added with a 12-character one-time code shown on a
trusted device and typed on the new one (HMAC over the exact keys involved), or with the recovery key
(160 random bits; it opens an AES-256-GCM backup of the account keys). No external audit has been done;
the protocol description should be reviewed by someone outside the implementation before any wording
stronger than "end-to-end encrypted" is used.

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
- **Metadata.** The registry sees who is online, which accounts signal each other and when, each account's
  list of friends and group co-members (to tell them who is online), and IP addresses (stored only as keyed
  hashes or truncated). Cloudflare, which runs the registry and the TURN relays, sees connecting addresses. Voice and video go peer to peer, so the other side of a call
  sees your IP address unless "Hide my IP from friends" is on and a relay server is set up.
- **People you talk to.** Anyone in a conversation can copy, screenshot or forward it. Deleting a message
  removes it from Snug, not from someone else's copy.
- **Disappearing messages are not unrecoverable.** The timer (0.12) removes a message from Snug's database,
  search index and attachments when it is due, and devices hide it on time. Before then anyone can copy it;
  the encrypted daily database snapshots (`server/dbbackup.js`, seven kept) can hold a copy for up to a week;
  a friend's PC on an older or modified Snug could keep it (Snug only offers the timer when every friend's
  PC says it supports it, and can't check what a modified one does).
- **A stolen GitHub account combined with an absent owner.** If the current PC is offline for the whole
  72-hour wait, a move started with a stolen GitHub login completes. Keep GitHub two-factor sign-in on.
- **A stolen recovery key combined with an absent owner,** the same way. And a lost PC plus a lost recovery key
  (with no GitHub linked) means the account is gone: nobody, including Snug, can reset it.
- **One person, many accounts.** Accounts without GitHub cost a proof of work (checked again at sign-up
  against the difficulty then), address budgets (3 a day per /48), more work for an IPv6 /32 that made 20 or
  more sign-ups in a day (it is not a refusal, so everyone sharing a tunnel broker's or carrier's /32 can
  still sign up) and a global budget over a sliding hour. These slow down mass sign-ups; they do not stop someone with many addresses.
- **The same recovery key on two servers.** The proof a browser sends for a server account's recovery key
  is bound to the server's host name (`web-auth-v2`), so the owner of one server can't use it on another.
  A key saved by 0.12.0 used the unbound proof (`web-auth-v1`); it still works, once, and the browser sends
  that old proof alongside when using a key, so until such a key is replaced the old exposure remains for
  it. A key saved at one address of a server (say `localhost`) works only at that address; the server says
  which. Snug makes a new key for each account; don't type one account's key into another server.

### Privacy and data kept

The plain-language version for people using Snug is the privacy page (Settings > Privacy guide, or `/privacy`),
built from `js/lib/privacy.js` and `GET /api/privacy` (`server/privacy.js`).

- Sign-in history (`auth_events`) and security events are kept 30 days by default (`SNUG_LOG_DAYS`, 1 to 365),
  with addresses truncated (1.2.3.x, /48). Failed sign-in counters last 2 days and hold an address only as an
  HMAC under the data key. Sessions store a device label, never an address. Logs never print a full address.
- Who sees that someone is online (everyone sharing a place, friends only, nobody) and typing are applied to
  every frame the server sends (`hub.outFilter`), not only in the browser: presence, status (words, picture and
  end time, and no frame at all when it changes), the "last wrote" lines, house voice-room lists and a stage's
  speakers and raised hands for people not in the room, and houses' online and in-voice counts. Message
  times and who is in a voice room, for people in it, stay visible. A voice room with a user limit still
  refuses someone when it is full, so a room that looks empty but says it's full shows that someone hidden
  is in it (letting them in instead would break the limit). In P2P mode, friends only watches group
  co-members who aren't friends "quietly" at the registry: it sends them no presence, and their PCs can signal
  (sig, relay, TURN) to the PC only after it has contacted them in its current registry session, the same
  answer as offline otherwise. The PC contacts each such co-member when they come online, so group messages,
  files and calls keep connecting directly; a modified client on their side can therefore still tell when the
  PC is online. A registry without quiet watches (no `quiet` in its `ready` frame) gets the older behaviour:
  those co-members aren't watched, so neither side can open a link to the other.
- In P2P mode, link previews for links friends send are off unless the PC's owner turns them on, since the
  fetch reveals the PC's address to the linked site.
- Deleting an account can erase what the person wrote (messages, files, reactions, poll votes, sign-in and
  security history); report rows moderators already hold and copies on other PCs stay. Encrypted database
  snapshots keep up to 7 days, so erased content can survive that long in a snapshot.
- Snug sends no telemetry, analytics or crash reports, and the web client loads nothing from other origins
  (CSP `default-src 'self'`; tested in `tests/e2e-privacy.test.js`). Outside parties it does reach: the STUN
  server (Google by default, `SNUG_STUN=none` turns it off), a TURN relay if configured, the browser's push
  service, the registry and Cloudflare (P2P), GitHub (desktop updates), and Tenor (only server-side, only if
  the server owner enables GIF search).

## Controls in place

| Area | Control | Where |
| --- | --- | --- |
| Passwords | scrypt (N=2^15, r=8, p=3), common-password list, no username in the password, rehash on sign-in | `server/auth.js` |
| Brute force | Per-address and per-account limits with doubling waits kept in the database; IPv6 grouped by prefix | `server/auth.js`, `registry/src` |
| Two-factor | TOTP encrypted under the data key, backup codes stored as HMACs, attempt limits | `server/account.js` |
| Recovery key (server accounts) | Only scrypt(HKDF(key)) stored; per-address and per-account-and-address limits; single use; every session ended on use; replacing it needs the password; the owner's reset deletes it | `server/recovery.js`, `server/tools/reset-password.js` |
| Passkeys | Single-use 5-minute challenges (at most 30 outstanding per /48 or account; when the map is full the busiest /32 or IPv4 /24 loses its oldest; sign-in options limited per /64 and /48), origin and RP ID checks, user verification required, counter regression refused, RP ID never from the `Host` header alone | `server/webauthn.js`, `server/passkeys.js` |
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
