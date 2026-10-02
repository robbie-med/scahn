#!/usr/bin/env bash
# Post-process the shipped female pelvis GLB: derive the bladder lumen and
# rebuild the ureters and urethra as watertight tubes (pipeline/kvh_repair.py).
#
#   ./scripts/repair-pelvis.sh [in.glb] [out.glb]
#
# Idempotent by refusal: the script exits if the input already carries a
# bladder_lumen, so running it twice cannot shrink the lumen twice.
# LD_LIBRARY_PATH: see build-assets.sh — Blender dlopen()s libdraco by name.
set -euo pipefail
cd "$(dirname "$0")/.."

BLENDER="${BLENDER:-$HOME/.local/bin/blender}"
BLENDER_ROOT="$(dirname "$(readlink -f "$BLENDER")")"
export LD_LIBRARY_PATH="$BLENDER_ROOT/lib:${LD_LIBRARY_PATH:-}"

IN="${1:-clients/viewer/public/models/kvh-female-pelvis.glb}"
OUT="${2:-$IN}"
TMP="$(mktemp --suffix=.glb)"
"$BLENDER" --background --factory-startup --python pipeline/kvh_repair.py -- "$IN" "$TMP"
mv "$TMP" "$OUT"
ls -lh "$OUT"
