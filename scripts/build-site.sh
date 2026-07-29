#!/usr/bin/env bash
# Assemble the static bundle the Worker serves via Workers Static Assets.
#
#   site/
#     index.html        viewer (the display)
#     assets/…
#     phone/index.html  sensor client
#     phone/assets/…
#
# Both clients and the WS endpoint come from ONE origin (spec 7.1), so the
# clients derive the relay URL from location.host and need no build-time config.
# VITE_SCAHN_WS remains as an escape hatch for split-origin hosting.
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build --workspace @scahn/viewer
npm run build --workspace @scahn/phone

rm -rf site
mkdir -p site/phone
cp -r clients/viewer/dist/. site/
cp -r clients/phone/dist/. site/phone/

echo
echo "site/ assembled"
du -sh site
