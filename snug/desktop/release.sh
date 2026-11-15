#!/usr/bin/env bash
# Publishes this version's files to the GitHub release snug-v<version> (both build workflows call it).
#   release.sh <windows|mac> <file>...
# Creates the release if it is missing (marked latest), writes SHA256SUMS-<platform>.txt for the
# given files, uploads only the files the release doesn't have yet (never --clobber, so a published
# file never changes under someone's download), and marks the release latest. Needs gh, node and GH_TOKEN.
# With SNUG_UPDATE_SIGNING_KEY (an Ed25519 private key, PEM) it also signs the checksum file
# (SHA256SUMS-<platform>.txt.sig, desktop/sign-sums.js); once updater.js pins a key it refuses to run without one.
set -euo pipefail

platform="${1:-}"
shift || true
case "$platform" in windows|mac) ;; *) echo "usage: release.sh <windows|mac> <file>..." >&2; exit 2 ;; esac
[ "$#" -gt 0 ] || { echo "release.sh: no files given" >&2; exit 2; }
for f in "$@"; do [ -f "$f" ] || { echo "release.sh: missing $f" >&2; exit 1; }; done

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
version="$(node -p "require(process.argv[1]).version" "$here/package.json")"
tag="snug-v$version"
sha="${GITHUB_SHA:-$(git -C "$here" rev-parse HEAD)}"

# sec-desktop D3: once updater.js pins an update key, every release must carry a signature by it, or no
# client would take it. Checked before anything is created or uploaded; a key that isn't pinned fails here too.
pinned="$(node -p "require(process.argv[1]).UPDATE_PUBKEYS.length" "$here/updater.js")"
if [ -n "${SNUG_UPDATE_SIGNING_KEY:-}" ]; then
  node "$here/sign-sums.js" /dev/null >/dev/null
elif [ "$pinned" != 0 ]; then
  echo "release.sh: updater.js pins an update key, but SNUG_UPDATE_SIGNING_KEY is not set: not publishing an unsigned release" >&2
  exit 1
fi

title="Snug $version"
# The same notes whichever workflow creates the release (they are set once, at creation). They don't claim the
# files are signed: the Digital Signatures tab tells, and the steps match docs/install.html (the install page,
# /docs/install.html on any Snug server).
notes="$(cat <<EOF
## Which file?

| You have | Download |
| --- | --- |
| Windows, Snug in the Start menu | **Snug-Setup-$version.exe** (installs for you only, no administrator needed) |
| Windows, nothing installed | **Snug-$version-portable.exe** |
| Mac (Apple silicon or Intel) | **Snug-$version-mac.dmg**: open it and drag Snug to Applications |

## Check the download

Compare the file's SHA-256 with its line in **SHA256SUMS-windows.txt** or **SHA256SUMS-mac.txt** (download it too):

- Windows (PowerShell, in your Downloads folder): \`Get-FileHash .\\Snug-Setup-$version.exe -Algorithm SHA256\`
- Mac (Terminal): \`cd ~/Downloads && shasum -a 256 -c SHA256SUMS-mac.txt\` prints OK for a match.

Different? Don't open the file; download it again. Every file here was built by GitHub Actions from this repository; with the GitHub CLI you can check that: \`gh attestation verify Snug-Setup-$version.exe -R DominicsUSE/Claude-apps\`.

## Warnings

- **Windows** may say "Windows protected your PC" (SmartScreen, "Unknown publisher") while Snug's Windows files are not code-signed. Right-click the file > Properties: a signed file has a **Digital Signatures** tab. After checking the download: **More info**, then **Run anyway**.
- **Mac:** Snug is not notarized by Apple (that needs a paid Apple developer membership), so macOS says it can't verify Snug. Open it once, then System Settings > **Privacy & Security** > **Open Anyway**.

## Updates

Snug updates itself from this page, after checking each file against the checksum file (and its signature, once update signing is on). It never goes back to an older version by itself; every version stays on the releases page if you need to reinstall an older one.

Step by step: the install page, /docs/install.html on any Snug server (snug/docs/install.html in this repository).
EOF
)"

# The second view covers the other workflow creating it between our view and create.
gh release view "$tag" >/dev/null 2>&1 \
  || gh release create "$tag" --target "$sha" --title "$title" --notes "$notes" --latest \
  || gh release view "$tag" >/dev/null

have="$(gh release view "$tag" --json assets -q '.assets[].name')"
in_release() { printf '%s\n' "$have" | grep -Fqx -- "$1"; }

# The checksum file sits next to the files, named for the platform, so the two workflows never race on one asset.
# A file the release already has is hashed as published (a rebuild is never byte-identical), so the sums
# always describe what people download.
dir="$(cd "$(dirname "$1")" && pwd)"
sums_name="SHA256SUMS-$platform.txt"
sums="$dir/$sums_name"
hash_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
pub="$(mktemp -d)"
trap 'rm -rf "$pub"' EXIT
if in_release "$sums_name"; then
  echo "release.sh: $sums_name is already in $tag"
else
  : > "$sums"
  for f in "$@"; do
    name="$(basename "$f")"
    src="$f"
    if in_release "$name"; then gh release download "$tag" -p "$name" -D "$pub" --clobber; src="$pub/$name"; fi
    printf '%s  %s\n' "$(hash_of "$src")" "$name" >> "$sums"
  done
fi

# The signature of the checksum file exactly as people download it (the published copy, if there is one).
sig_name="$sums_name.sig"
sig="$sums.sig"
rm -f "$sig"
if in_release "$sig_name"; then
  echo "release.sh: $sig_name is already in $tag"
elif [ -n "${SNUG_UPDATE_SIGNING_KEY:-}" ]; then
  signed="$sums"
  if in_release "$sums_name"; then gh release download "$tag" -p "$sums_name" -D "$pub" --clobber; signed="$pub/$sums_name"; fi
  node "$here/sign-sums.js" "$signed" > "$sig"
fi

# The files first, then the signature, the checksum file last: the app needs them all before it offers an update.
for f in "$@"; do
  name="$(basename "$f")"
  if in_release "$name"; then echo "release.sh: $name is already in $tag"; else gh release upload "$tag" "$f"; fi
done
if [ -f "$sig" ]; then gh release upload "$tag" "$sig"; fi
in_release "$sums_name" || gh release upload "$tag" "$sums"

gh release edit "$tag" --latest >/dev/null
echo "release.sh: $tag is published and marked latest"
