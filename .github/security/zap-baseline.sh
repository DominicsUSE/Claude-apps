#!/usr/bin/env bash
# OWASP ZAP baseline scan of a seeded Snug server (security.yml's zap-baseline job; locally: npm run audit:zap
# in snug/, needs Docker). Starts the server on a throw-away data folder with the sample houses, runs ZAP's
# passive baseline against it, then .github/security/gate.mjs fails only on High-risk alerts not accepted in
# zap-rules.tsv. The reports land in $ZAP_OUT (default ./zap): zap.html, zap.json, zap.md.
#   ZAP_PORT   the port for the scanned server (default 8787)
#   ZAP_OUT    where the reports go
#   ZAP_SERVE_ONLY=1  start the seeded server, check it answers, stop it (no Docker needed)
# Limits: the baseline is passive (it spiders and reads responses, it does not attack) and Snug is a
# single-page app over a WebSocket, so it checks headers, cookies, CSP and information leaks on the HTTP
# routes, not the socket operations.
set -euo pipefail

# The official image, pinned by digest (ZAP 2.17.0). Dependabot doesn't update digests in scripts: refresh with
# `docker pull zaproxy/zap-stable && docker image inspect zaproxy/zap-stable --format '{{index .RepoDigests 0}}'`.
ZAP_IMAGE="zaproxy/zap-stable@sha256:9624669db72f54d86c4b46a7064518bd9bf79d8c61a4c31befa9923489f328af"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
snug="$here/../../snug"
port="${ZAP_PORT:-8787}"
out="$(mkdir -p "${ZAP_OUT:-zap}" && cd "${ZAP_OUT:-zap}" && pwd)"
data="$(mktemp -d)"
server=""
cleanup() { [ -n "$server" ] && kill "$server" 2>/dev/null || true; rm -rf "$data"; }
trap cleanup EXIT

export SNUG_DATA="$data"
node --disable-warning=ExperimentalWarning "$snug/server/seed.js" >/dev/null
PORT="$port" HOST=127.0.0.1 node --disable-warning=ExperimentalWarning "$snug/server/index.js" > "$out/server.log" 2>&1 &
server=$!
for _ in $(seq 1 30); do
  curl -sf -o /dev/null "http://127.0.0.1:$port/" && break
  kill -0 "$server" 2>/dev/null || { echo "zap-baseline: the server stopped:" >&2; cat "$out/server.log" >&2; exit 1; }
  sleep 1
done
curl -sf -o /dev/null "http://127.0.0.1:$port/" || { echo "zap-baseline: the server never answered" >&2; cat "$out/server.log" >&2; exit 1; }
echo "zap-baseline: seeded Snug answers on http://127.0.0.1:$port"
if [ "${ZAP_SERVE_ONLY:-}" = 1 ]; then exit 0; fi

# ZAP runs as its own user (uid 1000) in the container and writes the reports into the mounted folder.
cp "$here/zap-rules.tsv" "$out/rules.tsv"
chmod 777 "$out"
# Host network: ZAP reaches 127.0.0.1, which the server's Host allow-list accepts. -I: warnings never fail the
# run here; the gate below decides. Exit 1 (a FAIL rule) or 2 (warnings) still writes the report; 3 is an error.
set +e
docker run --rm --network host -v "$out:/zap/wrk:rw" "$ZAP_IMAGE" \
  zap-baseline.py -t "http://127.0.0.1:$port" -c rules.tsv -J zap.json -r zap.html -w zap.md -I
rc=$?
set -e
[ "$rc" -le 2 ] || { echo "zap-baseline: ZAP failed ($rc)" >&2; exit "$rc"; }
node "$here/gate.mjs" zap "$out/zap.json" --rules "$here/zap-rules.tsv"
