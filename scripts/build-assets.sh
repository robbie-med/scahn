#!/usr/bin/env bash
# Run the Blender asset pipeline over the raw model drop.
#
#   ./scripts/build-assets.sh [in.glb] [out.glb]
#
# Repairs non-watertight meshes so stencil capping produces solid cut faces
# instead of scattered fragments, drops duplicate and unpositioned copies, and
# re-exports Draco-compressed.
#
# LD_LIBRARY_PATH is required: Blender ships libdraco.so.9 in its own lib
# directory, but the glTF exporter dlopen()s it by bare name, so without this
# the export dies with "libdraco.so.9: cannot open shared object file" *after*
# doing all the repair work.
set -euo pipefail
cd "$(dirname "$0")/.."

BLENDER="${BLENDER:-$HOME/.local/bin/blender}"
if ! command -v "$BLENDER" >/dev/null 2>&1; then
  echo "Blender not found at $BLENDER. Install it or set BLENDER=/path/to/blender." >&2
  exit 1
fi

BLENDER_ROOT="$(dirname "$(readlink -f "$BLENDER")")"
export LD_LIBRARY_PATH="$BLENDER_ROOT/lib:${LD_LIBRARY_PATH:-}"

IN="${1:-3d_models/abdomen_anatomy.glb}"
OUT="${2:-clients/viewer/public/models/abdomen.glb}"

echo "pipeline: $IN -> $OUT"
"$BLENDER" --background --factory-startup --python pipeline/pipeline.py -- "$IN" "$OUT"

ls -lh "$OUT"
