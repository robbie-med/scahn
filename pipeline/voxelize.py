"""
Label volume from a shipped GLB — the data behind the "Volume" engine
(ROADMAP.md, Part C).

    blender --background --factory-startup --python pipeline/voxelize.py \
        -- IN.glb OUT_PREFIX [voxel_mm]

Writes OUT_PREFIX.vol.bin.gz — one uint8 label per voxel, x fastest, then y,
then z, in SCENE axes (+X patient left, +Y superior, +Z anterior, metres) —
and OUT_PREFIX.vol.json with the grid origin, voxel size, dimensions and the
mesh name behind each label. Label 0 is empty. The viewer classifies the
names with the same classifier the mesh engine uses, so the two engines
cannot disagree about what a tissue is called or what grey it gets.

## Why columns, not points

Testing every voxel for containment is millions of ray casts. Instead each
(x, y) column casts ONE ray along +Z through the organ's bounding box and
collects every surface crossing. Entering crossings (ray against the face
normal) open a run, exiting ones close it, and the run is filled with numpy
slicing. A liver is ~7k columns and ~30k casts; the whole model is well
under a minute.

Using the face normal rather than hit parity is what makes this tolerant of
the meshes that are not quite closed: a missed exit extends one run to the
far side of ONE column's bounding box instead of inverting everything after
it, which is the failure that made stencil capping fragile.

## Order of painting

Later meshes overwrite earlier ones, so the order is: bone, muscle, solid
organs, then lumens, chambers and vessels last. A lumen sits inside its
wall; painting it last is what makes the bladder a dark cavity in a bright
wall, exactly as the mesh engine's depth-rank does.
"""

import gzip
import json
import os
import re
import sys

import bpy
import mathutils
import numpy as np
from mathutils.bvhtree import BVHTree

MARGIN_M = 0.004
LATE = re.compile(r'lumen|^chamber-|aorta|arter|^vein|vena|pfortader', re.I)
EARLY_BONE = re.compile(r'^bone-', re.I)
EARLY_MUSCLE = re.compile(r'^muscle-', re.I)


def log(*a):
    print('[voxelize]', *a, flush=True)


def scene_of(b):
    """Blender (x, y, z) -> scene (x, z, -y): the glTF importer's Y-up to Z-up."""
    return mathutils.Vector((b.x, b.z, -b.y))


def blender_of(s):
    return mathutils.Vector((s[0], -s[2], s[1]))


def paint_order(ob):
    n = ob.name
    if EARLY_BONE.search(n):
        return 0
    if EARLY_MUSCLE.search(n):
        return 1
    if LATE.search(n):
        return 3
    return 2


def main():
    argv = sys.argv[sys.argv.index('--') + 1:]
    src, out_prefix = argv[0], argv[1]
    voxel = (float(argv[2]) if len(argv) > 2 else 2.0) / 1000.0

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src)
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()

    meshes = [o for o in bpy.data.objects
              if o.type == 'MESH' and not o.name.startswith('skin-')]
    meshes.sort(key=lambda o: (paint_order(o), o.name))

    # Grid extents from every mesh, in scene axes.
    lo = mathutils.Vector((1e9,) * 3)
    hi = mathutils.Vector((-1e9,) * 3)
    for ob in meshes:
        for c in ob.bound_box:
            s = scene_of(ob.matrix_world @ mathutils.Vector(c))
            for i in range(3):
                lo[i] = min(lo[i], s[i])
                hi[i] = max(hi[i], s[i])
    lo -= mathutils.Vector((MARGIN_M,) * 3)
    hi += mathutils.Vector((MARGIN_M,) * 3)
    dims = [int(np.ceil((hi[i] - lo[i]) / voxel)) for i in range(3)]
    nx, ny, nz = dims
    log(f'grid {nx} x {ny} x {nz} at {voxel * 1000:.2f} mm = {nx * ny * nz / 1e6:.1f} M voxels, '
        f'origin ({lo.x:+.3f}, {lo.y:+.3f}, {lo.z:+.3f}) m')
    vol = np.zeros((nz, ny, nx), dtype=np.uint8)

    names = ['']
    zs = lo.z + (np.arange(nz) + 0.5) * voxel
    ray_dir = blender_of((0.0, 0.0, 1.0))
    for ob in meshes:
        label = len(names)
        if label > 255:
            raise SystemExit('more than 255 meshes; widen the label type')
        names.append(ob.name)
        bvh = BVHTree.FromObject(ob, depsgraph)
        corners = [scene_of(ob.matrix_world @ mathutils.Vector(c)) for c in ob.bound_box]
        blo = [min(c[i] for c in corners) for i in range(3)]
        bhi = [max(c[i] for c in corners) for i in range(3)]
        ix0 = max(0, int((blo[0] - lo.x) / voxel))
        ix1 = min(nx - 1, int((bhi[0] - lo.x) / voxel))
        iy0 = max(0, int((blo[1] - lo.y) / voxel))
        iy1 = min(ny - 1, int((bhi[1] - lo.y) / voxel))
        z_start = blo[2] - 0.001
        span = (bhi[2] - blo[2]) + 0.002
        casts = 0
        filled = 0
        for iy in range(iy0, iy1 + 1):
            y = lo.y + (iy + 0.5) * voxel
            for ix in range(ix0, ix1 + 1):
                x = lo.x + (ix + 0.5) * voxel
                origin = blender_of((x, y, z_start))
                travelled = 0.0
                depth = 0
                run_start = None
                while travelled < span:
                    hit, normal, _, dist = bvh.ray_cast(origin, ray_dir, span - travelled)
                    casts += 1
                    if hit is None:
                        break
                    travelled += dist
                    z = z_start + travelled
                    entering = normal.dot(ray_dir) < 0
                    if entering:
                        if depth == 0:
                            run_start = z
                        depth += 1
                    else:
                        depth = max(0, depth - 1)
                        if depth == 0 and run_start is not None:
                            a = int(np.searchsorted(zs, run_start))
                            b = int(np.searchsorted(zs, z))
                            if b > a:
                                vol[a:b, iy, ix] = label
                                filled += b - a
                            run_start = None
                    origin = hit + ray_dir * 1e-5
                    travelled += 1e-5
                if run_start is not None:
                    # Missed exit: close at the far side of this organ's box.
                    a = int(np.searchsorted(zs, run_start))
                    b = int(np.searchsorted(zs, bhi[2]))
                    if b > a:
                        vol[a:b, iy, ix] = label
                        filled += b - a
        log(f'{ob.name[:34]:36} label {label:3d}  {casts:7d} casts  '
            f'{filled * voxel ** 3 * 1e6:8.0f} mL')

    raw = vol.tobytes()
    with gzip.open(out_prefix + '.vol.bin.gz', 'wb', compresslevel=9) as fh:
        fh.write(raw)
    meta = {
        'dims': dims,
        'origin': [lo.x, lo.y, lo.z],
        'voxel': voxel,
        'order': 'x fastest, then y, then z; scene axes',
        'names': names,
        'source': os.path.basename(src),
    }
    with open(out_prefix + '.vol.json', 'w') as fh:
        json.dump(meta, fh)
    log(f'wrote {out_prefix}.vol.bin.gz '
        f'({os.path.getsize(out_prefix + ".vol.bin.gz") / 1e6:.2f} MB gz from {len(raw) / 1e6:.1f} MB) '
        f'and .vol.json ({len(names) - 1} labels)')


if __name__ == '__main__':
    main()
