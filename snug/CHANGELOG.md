# Changelog

Snug's releases, newest first. Every version's files stay on the releases page
(<https://github.com/DominicsUSE/Claude-apps/releases?q=snug-v>); the desktop app updates itself and never
goes back to an older version on its own (README, "Install, update, go back").

## 0.12.0 (unreleased)

<!-- The integrator fills this in from each track's report. Plain words, what people notice first;
     say honestly what is and isn't encrypted and who can see what. -->

### Private conversations

- (end-to-end encryption: what it covers, what it doesn't)

### Accounts

- (no GitHub account needed, recovery key)

### New

- (features)

### Fixed

- (the tester panel's findings)

### Installing and security

- An install page (`docs/install.html`, at `/docs/install.html` on any Snug server, linked from
  Settings > Desktop app in a browser) and the same steps in every release's notes: which file to pick, the
  Windows and Mac warnings, checking a download's SHA-256 against `SHA256SUMS-*.txt`, and
  `gh attestation verify`.
- Windows code signing is wired up and switches on as soon as the project has a SignPath Foundation account or
  a certificate; every signature is checked in CI. Until then the files are unsigned and Windows warns, and the
  page says so.
- A weekly and per-push OWASP ZAP baseline scan of a seeded server joins the security checks; High-risk alerts
  fail the build.
- Help pages are served with their own strict Content-Security-Policy (no script at all).

### Known limits

- (what this release does not do)

## 0.11.1

- Updates install themselves, with the review's fixes.

## 0.11.0

- Security hardening across the server, the registry, the desktop app and CI.
