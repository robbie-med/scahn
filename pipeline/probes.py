"""
Transducer bodies: POCUS Collective STLs -> probe-frame Draco GLBs.

    blender --background --factory-startup --python pipeline/probes.py \
        -- IN_DIR OUT_DIR

Source: "Ultrasound Probes STLs" by Ben Smith (Core Ultrasound), hosted by
The POCUS Collective under its site-wide content licence, CC BY-NC 4.0
(https://pocuscollective.com/legal). Credited in credits.js. NonCommercial
is already a project constraint via the female pelvis.

Expected inputs in IN_DIR: Ultrasound_Probe_Phased.stl,
Ultrasound_Probe_Curvilinear.stl, Ultrasound_Probe_Linear.stl.

## Probe frame (CONVENTIONS.md section 4)

Metres. Footprint (the scanning face) centred on the origin, handle along
local +Y, scan plane = local XY, marker side = local +X. The viewer adds the
yellow notch at +X itself, so the mesh only has to be the right way up and
the right way round.

## How the orientation is decided

STLs carry no frame. Each mesh is measured rather than assumed:

  1. Principal axis of the vertex cloud = the handle axis (a probe is much
     longer than it is wide). Rotated onto +Y.
  2. Which end is the face: the face end is the WIDER end — the footprint
     of every probe here is wider than its grip — so the end with the larger
     cross-section is put at -Y... then the whole thing is flipped so that
     end sits at y = 0 and the handle rises along +Y.
  3. The scan plane is the probe's wide direction across the face: the
     face's longer in-plane extent becomes local X (marker axis), its
     shorter extent local Z. For the curvilinear and linear probes this is
     unambiguous; for the phased array the face is nearly square and the
     cable/handle flattening decides, which is what a sonographer uses too.
  4. Units: the STLs are millimetres; the result is scaled so the footprint
     width matches the viewer's beam profile (curvilinear 60 mm, phased
     25 mm, linear 40 mm) — the models were made for printing at "novelty"
     sizes, so their absolute size is not trusted, only their shape.

Each step logs its measurements so a wrong guess shows up in the build log
rather than on screen. Override any step per probe in OVERRIDES.
"""

import math
import os
import sys

import bmesh
import bpy
import mathutils
import numpy as np

FOOTPRINT_MM = {'curvilinear': 60.0, 'phased': 25.0, 'linear': 40.0}
FILES = {
    'phased': 'Ultrasound_Probe_Phased.stl',
    'curvilinear': 'Ultrasound_Probe_Curvilinear.stl',
    'linear': 'Ultrasound_Probe_Linear.stl',
}
TRI_BUDGET = 6000
# Per-probe manual overrides, applied after the automatic frame:
#   'flip_y': True   -> handle was put the wrong way up
#   'spin_deg': 90   -> rotate about Y (swap which face extent is X)
OVERRIDES = {}


def log(*a):
    print('[probes]', *a, flush=True)


def tri_count(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)


def principal_axes(pts):
    c = pts.mean(axis=0)
    d = pts - c
    cov = d.T @ d / len(pts)
    w, v = np.linalg.eigh(cov)
    order = np.argsort(w)[::-1]
    return c, v[:, order], w[order]


def main():
    argv = sys.argv[sys.argv.index('--') + 1:]
    in_dir, out_dir = argv[0], argv[1]
    os.makedirs(out_dir, exist_ok=True)

    for kind, fname in FILES.items():
        path = os.path.join(in_dir, fname)
        if not os.path.isfile(path):
            log(f'{kind}: {fname} missing, skipped')
            continue
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.wm.stl_import(filepath=path)
        ob = [o for o in bpy.data.objects if o.type == 'MESH'][0]
        ob.name = f'probe-{kind}'
        ob.data.name = ob.name

        pts = np.array([v.co[:] for v in ob.data.vertices], dtype=np.float64)
        c, axes, w = principal_axes(pts)
        # 1. handle axis -> +Y. Chosen by EXTENT along the PCA axes, not by
        # variance: the curvilinear STL's vertices crowd its grip, so the
        # largest-variance axis was the 74 mm face width, not the 141 mm
        # handle, and the probe came out 36 cm deep.
        proj = (pts - c) @ axes
        extents = proj.max(axis=0) - proj.min(axis=0)
        order = np.argsort(extents)[::-1]
        axes = axes[:, order]
        handle = axes[:, 0]
        basis = np.column_stack([axes[:, 1], handle, axes[:, 2]])
        if np.linalg.det(basis) < 0:
            basis[:, 2] *= -1
        local = (pts - c) @ basis  # columns: x (wide), y (handle), z
        # 2. the wider end is the face
        ymin, ymax = local[:, 1].min(), local[:, 1].max()
        span = ymax - ymin
        lo = local[local[:, 1] < ymin + 0.15 * span]
        hi = local[local[:, 1] > ymax - 0.15 * span]
        width = lambda q: (q[:, 0].max() - q[:, 0].min()) * (q[:, 2].max() - q[:, 2].min())
        face_at_min = width(lo) > width(hi)
        if not face_at_min:
            # flip so the face is at -Y, then shift so it sits at y=0
            local[:, 1] *= -1
            local[:, 0] *= -1  # keep right-handed
            ymin, ymax = local[:, 1].min(), local[:, 1].max()
        local[:, 1] -= ymin
        face = local[local[:, 1] < 0.08 * span]
        # 3. face's long extent -> X
        ex = face[:, 0].max() - face[:, 0].min()
        ez = face[:, 2].max() - face[:, 2].min()
        spin = 0.0
        if ez > ex:
            spin = 90.0
            x, z = local[:, 0].copy(), local[:, 2].copy()
            local[:, 0], local[:, 2] = z, -x
            ex, ez = ez, ex
        ov = OVERRIDES.get(kind, {})
        if ov.get('flip_y'):
            local[:, 1] = local[:, 1].max() - local[:, 1]
            local[:, 0] *= -1
        if ov.get('spin_deg'):
            a = math.radians(ov['spin_deg'])
            x, z = local[:, 0].copy(), local[:, 2].copy()
            local[:, 0] = x * math.cos(a) + z * math.sin(a)
            local[:, 2] = -x * math.sin(a) + z * math.cos(a)
        # centre the footprint on the origin in X and Z
        local[:, 0] -= (face[:, 0].max() + face[:, 0].min()) / 2
        local[:, 2] -= (face[:, 2].max() + face[:, 2].min()) / 2
        # 4. scale: footprint width -> the beam profile's, in metres
        scale = (FOOTPRINT_MM[kind] / 1000.0) / max(ex, 1e-6)
        local *= scale
        log(f'{kind:12} handle {span:.1f} units, face {ex:.1f} x {ez:.1f} '
            f'(face at {"min" if face_at_min else "max"} Y, spin {spin:.0f}), '
            f'scale {scale * 1000:.3f} -> {ex * scale * 100:.1f} cm wide, '
            f'{(local[:, 1].max()) * 100:.1f} cm tall')

        for i, v in enumerate(ob.data.vertices):
            v.co = mathutils.Vector(local[i])
        ob.data.update()

        # weld + decimate for the viewer
        bm = bmesh.new()
        bm.from_mesh(ob.data)
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(ob.data)
        bm.free()
        n = tri_count(ob)
        if n > TRI_BUDGET:
            bpy.ops.object.select_all(action='DESELECT')
            ob.select_set(True)
            bpy.context.view_layer.objects.active = ob
            mod = ob.modifiers.new(name='dec', type='DECIMATE')
            mod.ratio = TRI_BUDGET / n
            bpy.ops.object.modifier_apply(modifier=mod.name)
        for p in ob.data.polygons:
            p.use_smooth = True
        log(f'{kind:12} {n} -> {tri_count(ob)} tris')

        # Pre-compensate the exporter's Y-up conversion: Blender (x, y, z) ->
        # glTF (x, z, -y). We want glTF = probe frame (X, Y, Z), so Blender must
        # hold (X, -Z, Y).
        for v in ob.data.vertices:
            x, y, z = v.co
            v.co = mathutils.Vector((x, -z, y))
        ob.data.update()

        out = os.path.join(out_dir, f'{kind}.glb')
        bpy.ops.export_scene.gltf(
            filepath=out, export_format='GLB',
            export_draco_mesh_compression_enable=True,
            export_draco_mesh_compression_level=6,
            export_materials='NONE', export_normals=True,
            export_texcoords=False, export_yup=True,
            use_selection=False,
        )
        log(f'wrote {out} ({os.path.getsize(out) / 1024:.0f} KB)')


if __name__ == '__main__':
    main()
