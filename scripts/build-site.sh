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

# Draco decoder must be in the build output, not just in node_modules — the
# assets are Draco-compressed and the viewer fetches the decoder at runtime.
DRACO_SRC=node_modules/three/examples/jsm/libs/draco/gltf
if [ ! -f "$DRACO_SRC/draco_decoder.wasm" ]; then
  echo "Draco decoder missing from $DRACO_SRC — run npm install." >&2
  exit 1
fi
mkdir -p clients/viewer/public/draco
cp "$DRACO_SRC"/draco_decoder.js "$DRACO_SRC"/draco_decoder.wasm \
   "$DRACO_SRC"/draco_wasm_wrapper.js clients/viewer/public/draco/

# Licence-gated assets. The Visible Korean female pelvis is NOT cleared for
# release, so it lives outside public/ and is copied in only on explicit
# opt-in. Keeping it out of public/ rather than only out of git is deliberate:
# .gitignore stops it reaching the repository, but a deploy builds from the
# working tree, so an ignored file in public/ would ship anyway.
UNCLEARED=3d_models/derived/kvh-female-pelvis.glb
if [ "${SCAHN_UNCLEARED:-0}" = "1" ] && [ -f "$UNCLEARED" ]; then
  echo "WARNING: including $UNCLEARED — permission is PENDING, do not deploy this build"
  mkdir -p clients/viewer/public/models
  cp "$UNCLEARED" clients/viewer/public/models/
else
  rm -f clients/viewer/public/models/kvh-female-pelvis.glb
fi

npm run build --workspace @scahn/viewer
npm run build --workspace @scahn/phone

rm -rf site
mkdir -p site/phone
cp -r clients/viewer/dist/. site/
cp -r clients/phone/dist/. site/phone/

echo
echo "site/ assembled"
du -sh site
