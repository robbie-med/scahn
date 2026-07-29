#!/usr/bin/env bash
# Local development: relay + both Vite dev servers.
#
# Ports are claimed in /home/user/Projects/PORTS.md — do not change them here
# without updating that registry:
#   3105  scahn-relay        (HTTP + WS, single origin)
#   3902  scahn-viewer-dev   (Vite HMR)
#   3903  scahn-phone-dev    (Vite HMR)
#
# NOTE: the phone will NOT grant motion access against these plain-HTTP dev
# servers. iOS requires a secure context and the localhost exemption does not
# apply from a different host. Use scripts/tunnel.sh for anything involving a
# real phone.
set -euo pipefail
cd "$(dirname "$0")/.."

pids=()
cleanup() {
  trap - INT TERM EXIT
  for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done
}
trap cleanup INT TERM EXIT

echo "relay  -> http://127.0.0.1:3105"
npm run dev --workspace @scahn/relay & pids+=($!)

echo "viewer -> http://127.0.0.1:3902"
npm run dev --workspace @scahn/viewer & pids+=($!)

echo "phone  -> http://127.0.0.1:3903"
npm run dev --workspace @scahn/phone & pids+=($!)

wait
