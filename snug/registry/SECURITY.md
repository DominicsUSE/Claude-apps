# Snug registry: security notes

The registry is a Cloudflare Worker in front of one SQLite Durable Object (`Hub`). It knows usernames,
device public keys, pending moves, presence and sealed signaling. It never sees messages or data files.
Each account has a 32-byte data-file key (the vault key), stored wrapped (encrypted). The registry hands
that key only to the account's current device key.

## Threat model

| Attacker has | What stops them |
|---|---|
| A GitHub token or session for the victim (phished device-flow code, stolen GitHub account) | A sign-in from a new device only starts a **move**. The move completes after 72 h, or at once if the current PC approves it, and the current PC can press Stop. Until the move completes, the new key gets **no vault key** and **no data file** (REG-H1). The current PC takes no file from a pending key. Its connect budget is its own, so it always hears about the move (REG-M1). |
| A stolen *old* PC (the account moved away from it) | Its key has the `old` xfer role for 30 days. It can hand over a file once, and only while the new PC waits for one. It never talks to a pending key. Signal sockets get 4003. The account owner can rotate the vault key (`POST /v1/vault/rotate`; the app does this when Stop is pressed, REG-L1). |
| A stolen *current* PC | That PC's key can cancel every move, move the account at once with a pairing code, and is needed for release. It can't add a second proof of its own at once: a GitHub link, an unlink, a GitHub account's first recovery key and a recovery key set without the old one all wait 7 days, and another proof stops them (the recovery key; a GitHub account's GitHub sign-in; a keypair account's linked GitHub, for an unlink or a new recovery key), also from the person's new PC while it moves in. It can't replace a linked GitHub (it must unlink first, which waits). Release through a linked GitHub needs a link that has worked for at least 7 days. Its signed calls can't push the recovery key's replay counter (each signer has its own, dated at most 60 s ahead). Recovery: the registry owner verifies the person, for example through their GitHub account, then runs the admin action `move.force {uid, fp}` (owner only, audited) with the security code the new PC shows. That key's move (waiting now, or its next within 7 days) completes at once; a move by any other key (the thief's) waits as usual. The stolen key gets no `old` role, and the vault key rotates (REG-M2). |
| A leaked database row | Vault keys are AES-GCM wrapped under HKDF(`VAULT_WRAP_SECRET` or `GH_HMAC_SECRET`), with AAD set to the GitHub hash and the kid. GitHub ids and IP prefixes are stored only as HMACs. |
| Floods from many addresses | Per-address limits treat an IPv6 /48 as one address for sign-in and account calls (REG-M4). The sensitive limits survive the Hub sleeping (REG-L3). Junk GitHub tokens have their own global budget, so the sign-in budget counts only accepted tokens (REG-M4). Refused requests don't count toward the relay kill switch (REG-M5). A socket that floods frames is closed. |

## Rules that must never be broken

- **Never rotate `GH_HMAC_SECRET`.** It keys every GitHub hash. It also wraps every vault key that has not
  been re-wrapped under `VAULT_WRAP_SECRET`.
- **Never change `HUB_NAME`** (currently `hub-2`) and never delete the `Hub` class or its migration. Every
  account and every vault key lives in that one object. If they are lost, every `.snugvault` file and backup
  becomes unreadable on any device that has no cached key.
- Once `VAULT_WRAP_SECRET` is set, never change or remove it.

## Backup and recovery of the registry

1. **Point-in-time recovery (built into SQLite Durable Objects, free).** Cloudflare keeps 30 days of history
   for SQLite-backed objects. To roll the Hub back, get a bookmark with
   `ctx.storage.getBookmarkForTime(t)`, call `ctx.storage.onNextSessionRestoreBookmark(bookmark)`, then
   restart the object with `ctx.abort()`. Do this from a one-off admin route or a temporary deploy, and
   check the current Cloudflare docs first.
2. **Wrapped vault key export (owner only, audited).** Run the admin action `vault.export {after?}`, which
   returns 200 rows per page. Keep the output offline. The rows stay wrapped, so they are useless without
   the registry secrets. Keep the secrets apart from the export, for example in a password manager.
3. **Accounts.** Accounts can be rebuilt by signing in again. Usernames and key chains do not hold secrets.
   Keep the vault keys above all.

## Account recovery procedure (stolen current device)

1. The person writes from the GitHub account that owns the Snug account. Check this, for example with a
   GitHub issue or gist posted from that account.
2. The person reads you the security code the new PC shows for itself (Settings > Account and security >
   Security code). Run `move.force {uid, fp: "<that code>"}` with a signed `/v1/admin` call (the admin panel
   has no form for it). If that PC's move is already waiting, it completes now. Otherwise the next move of
   that PC's key completes at once, and a move by any other key waits as usual. `move.force` without `fp`
   or `ik` is refused: a bare force could complete a move someone swapped in after you checked.
3. If the move wasn't waiting yet, the person signs in with GitHub (or uses the recovery key) on that PC.
   The move completes at once, and friends see a loud key change. The data file can be imported from a
   backup. The vault key's older kids stay readable.

## Reporting

Report suspected vulnerabilities privately to the maintainer. Do not post them in a public issue.
