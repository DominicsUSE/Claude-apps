# Pre-built binaries

These are the actual compiled outputs of `../` (built and verified — see
`../README.md` for exactly what was checked). Checked in directly here, rather than
via a GitHub Release, because the release/upload tooling available in the session that
built this wasn't reachable at the time. If you'd rather these live as Release assets
instead of in git history (they're ~70MB each), that's a reasonable cleanup to ask for
later — the source in `../` rebuilds them identically at any time.

- **`DinoCamSecurity Setup 2.0.0.exe`** — the installer. Run it, pick an install
  folder, and it creates Desktop + Start Menu shortcuts with the dinosaur icon.
- **`DinoCamSecurity 2.0.0.exe`** — portable, no installation. Just run it directly.

Neither has been run on an actual Windows machine — see `../README.md` for what was
and wasn't verified.
