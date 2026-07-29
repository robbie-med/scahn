#!/usr/bin/env bash
# Publish the relay over HTTPS so real phones can grant motion access.
#
# Why this is not optional (spec 7.1): DeviceOrientationEvent.requestPermission()
# on iOS needs BOTH a user gesture AND a secure context. The phone is a
# different host from this machine, so the localhost HTTPS exemption does not
# apply. There is no way around a real certificate.
#
# Serves the BUILT clients and the WS endpoint from one origin, so run
# `npm run build` first.
#
#   ./scripts/tunnel.sh              quick tunnel, random trycloudflare.com host
#   ./scripts/tunnel.sh <name>       named tunnel from your cloudflared config
#
# Tailscale Serve is the better choice for solo development (free certs on the
# tailnet, no public exposure) but is useless for a room full of residents who
# do not have Tailscale installed:
#   tailscale serve --bg 3105
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${SCAHN_PORT:-3105}"

if ! curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
  echo "Relay is not answering on 127.0.0.1:${PORT}." >&2
  echo "Start it first:  npm start" >&2
  exit 1
fi

if [ ! -d clients/viewer/dist ] || [ ! -d clients/phone/dist ]; then
  echo "No client build found. Run: npm run build" >&2
  exit 1
fi

if [ $# -ge 1 ]; then
  exec cloudflared tunnel run --url "http://127.0.0.1:${PORT}" "$1"
fi

echo "Starting a quick tunnel. The printed https:// host serves:"
echo "  /        viewer (shows the QR + room code)"
echo "  /phone   sensor client"
exec cloudflared tunnel --url "http://127.0.0.1:${PORT}"
