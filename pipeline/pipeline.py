"""
Headless Blender asset pipeline. Spec section 5.

    blender --background --factory-startup --python pipeline/pipeline.py -- IN.glb OUT.glb

Why this exists: stencil capping needs closed, manifold surfaces. A mesh with
holes leaves the back/front face count unbalanced, which paints cap fragments
in scattered places — speckle that a learner could read as echogenic foci. On
the bundled abdomen model 15 of 24 meshes are leaky before treatment.

Repair is deliberately two-tier rather than "voxel remesh everything", because
remeshing is destructive to polygon budget in both directions. On this model a
blanket 2 mm remesh took the liver from 1,480 triangles to 73,148 (49x) while
fixing only two bad edges, and simultaneously *reduced* the heart from 23,688
to 6,784. Tier 1 preserves the original surface where the damage is small;
tier 2 is the hammer for meshes that are genuinely torn.

The source -> scene transform is NOT baked here. It stays in
clients/viewer/src/models.js so there is exactly one named correction
(CONVENTIONS.md section 5); baking it here as well would double-apply it.
"""

import sys
import bmesh
import bpy
import mathutils

# Meshes that are scene furniture or instruments, not anatomy.
DROP = ('label', 'endosonographieger', 'duodenoskopp', 'schallkeule')

# Merge threshold for welding split vertices. glTF splits vertices at normal and
# UV seams, so a perfectly closed mesh imports looking torn — the raw open-edge
# count on this model is ~9x the true one until this runs.
WELD_DIST = 1e-4

# Hole filling is tried FIRST and without a defect-count limit, because a high
# open-edge count usually means open tube ends, not damage — a trachea has 168
# and they are simply the two ends of the airway. Filling those preserves every
# ring of cartilage; remeshing them destroys the structure.
#
# What hole filling cannot repair is non-manifold edges, so only a mesh with
# many of those is genuinely torn and worth the hammer.
NONMANIFOLD_LIMIT = 40

# Voxel remesh cannot resolve a wall thinner than roughly this many voxels, and
# a wall it cannot resolve it simply erases. Mean wall thickness is estimated as
# 2 * volume / area, which is exact for a thin closed shell.
THICKNESS_VOXELS = 2.5

# If preserving a mesh's walls would need more triangles than this, remeshing is
# not affordable at a safe resolution, and remeshing at an unsafe one would
# destroy the very thing being repaired. Leave the mesh as imported and say so.
MAX_REMESH_TRIS = 45000

# Voxel remesh targets. Output scales as surface_area / voxel^2, so the voxel
# size is solved for a triangle budget instead of being a fixed guess.
MIN_TARGET_TRIS = 2500
MAX_TARGET_TRIS = 30000


def log(*a):
    print('[pipeline]', *a)


def mesh_stats(ob):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    open_e = sum(1 for e in bm.edges if len(e.link_faces) == 1)
    nonman = sum(1 for e in bm.edges if len(e.link_faces) > 2)
    tris = sum(len(f.verts) - 2 for f in bm.faces)
    area = sum(f.calc_area() for f in bm.faces)
    try:
        vol = abs(bm.calc_volume(signed=True))
    except Exception:
        vol = 0.0
    bm.free()
    return open_e, nonman, tris, area, vol


def weld_and_clean(ob):
    """Weld split vertices, drop loose geometry and collapse degenerate faces."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=WELD_DIST)
    loose = [v for v in bm.verts if not v.link_faces]
    if loose:
        bmesh.ops.delete(bm, geom=loose, context='VERTS')
    bmesh.ops.dissolve_degenerate(bm, dist=WELD_DIST, edges=bm.edges)
    bm.to_mesh(ob.data)
    ob.data.update()
    bm.free()


def fill_holes(ob):
    """Tier 1: span the remaining boundary loops, preserving the original surface."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    edges = [e for e in bm.edges if len(e.link_faces) == 1]
    if edges:
        bmesh.ops.holes_fill(bm, edges=edges, sides=0)
        # holes_fill can leave n-gons; triangulate so downstream counts are honest.
        ngons = [f for f in bm.faces if len(f.verts) > 3]
        if ngons:
            bmesh.ops.triangulate(bm, faces=ngons)
    bm.to_mesh(ob.data)
    ob.data.update()
    bm.free()


def plan_remesh(area, vol, current_tris):
    """
    Choose a voxel size, or decline.

    Two constraints fight here. A triangle budget wants coarse voxels; the wall
    thickness wants fine ones. Thickness must win, because a voxel larger than
    the wall does not approximate the wall, it deletes it — which is how a
    trachea remeshed at 2.2 mm with 2.6 mm walls came out as 1,172 triangles of
    unrecognisable tube.

    Returns (voxel, estimated_tris) or (None, estimated_tris) to decline.
    """
    target = max(MIN_TARGET_TRIS, min(MAX_TARGET_TRIS, current_tris))
    budget_voxel = (2.0 * area / target) ** 0.5 if area > 0 else 2.0

    thickness = (2.0 * vol / area) if area > 0 else 0.0
    safe_voxel = thickness / THICKNESS_VOXELS if thickness > 0 else budget_voxel

    voxel = max(0.4, min(budget_voxel, safe_voxel, 8.0))
    est = int(2.0 * area / (voxel * voxel)) if voxel > 0 else 0
    if est > MAX_REMESH_TRIS:
        return None, est
    return voxel, est


def voxel_remesh(ob, voxel):
    bpy.context.view_layer.objects.active = ob
    mod = ob.modifiers.new(name='voxel', type='REMESH')
    mod.mode = 'VOXEL'
    mod.voxel_size = voxel
    bpy.ops.object.modifier_apply(modifier=mod.name)


# Hollow viscera that arrive as a single closed mesh, with the wall thickness to
# assume, in source units (mm).
#
# Spec section 5 asks for wall and lumen as separate watertight meshes so that
# per-mesh capping yields an echogenic wall around an anechoic cavity by itself.
# These models ship only the outer surface, so capping paints one solid disc: a
# bladder rendered entirely as fluid is two grey levels away from "nothing
# rendered", and its wall disappears. Deriving the lumen by shrinking the wall
# inward is not invented anatomy — it is the same surface, offset.
HOLLOW = {
    'bladder': 2.0,
    'gallbladder': 1.5,
}


def make_lumen(ob, thickness):
    """Duplicate a hollow organ and shrink it inward to form its cavity."""
    lumen = ob.copy()
    lumen.data = ob.data.copy()
    lumen.name = f'{ob.name}_lumen'
    lumen.data.name = lumen.name
    bpy.context.collection.objects.link(lumen)

    bm = bmesh.new()
    bm.from_mesh(lumen.data)
    bm.normal_update()
    for v in bm.verts:
        v.co -= v.normal * thickness
    # Shrinking a concave region can push faces through each other; dissolving
    # the degenerate ones keeps the result closed.
    bmesh.ops.dissolve_degenerate(bm, dist=WELD_DIST, edges=bm.edges)
    bm.to_mesh(lumen.data)
    lumen.data.update()
    bm.free()

    o, n, t, _, vol = mesh_stats(lumen)
    if o or n or vol <= 0:
        bpy.data.objects.remove(lumen, do_unlink=True)
        return None
    return lumen


def dedupe(meshes):
    """
    Keep the anatomically placed copy of each duplicated mesh.

    The signature MUST include the bounding box. Keying on vertex and polygon
    counts alone collides for symmetric pairs — the left and right kidneys have
    identical counts — and silently deletes one side of the body.
    """
    best = {}
    for ob in meshes:
        bb = [tuple(round(c, 2) for c in v) for v in (ob.bound_box[0], ob.bound_box[6])]
        sig = (len(ob.data.vertices), len(ob.data.polygons), bb[0], bb[1])
        centre = sum(
            (ob.matrix_world @ mathutils.Vector(v.co) for v in ob.data.vertices),
            mathutils.Vector(),
        ) / max(len(ob.data.vertices), 1)
        dist = centre.length
        if sig not in best or dist > best[sig][1]:
            best[sig] = (ob, dist)

    keep = {id(v[0]) for v in best.values()}
    dropped = [ob for ob in meshes if id(ob) not in keep]
    # An unpositioned duplicate sits on the source origin; no real organ does.
    positioned = any(v[1] > 1.0 for v in best.values())
    if positioned:
        for sig, (ob, dist) in list(best.items()):
            if dist < 1.0:
                dropped.append(ob)
                keep.discard(id(ob))
    return [ob for ob in meshes if id(ob) in keep], dropped


def main():
    argv = sys.argv[sys.argv.index('--') + 1:]
    src, dst = argv[0], argv[1]

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src)

    meshes = [
        o for o in bpy.data.objects
        if o.type == 'MESH' and not any(d in o.name.lower() for d in DROP)
    ]
    log(f'imported {len(meshes)} candidate meshes')

    keep, dropped = dedupe(meshes)
    log(f'kept {len(keep)}, dropped {len(dropped)} duplicate/unpositioned')
    for ob in dropped:
        bpy.data.objects.remove(ob, do_unlink=True)
    for ob in bpy.data.objects:
        if ob.type == 'MESH' and ob not in keep:
            bpy.data.objects.remove(ob, do_unlink=True)

    fixed = remeshed = clean = declined = 0
    for ob in sorted(keep, key=lambda o: -len(o.data.polygons)):
        weld_and_clean(ob)
        open_e, nonman, tris, area, vol = mesh_stats(ob)
        if open_e == 0 and nonman == 0:
            clean += 1
            log(f'{ob.name[:38]:40} already watertight ({tris} tris)')
            continue

        # Tier 1 first, whatever the hole count. Most "damage" is open tube ends.
        if nonman <= NONMANIFOLD_LIMIT:
            if open_e:
                fill_holes(ob)
            o2, n2, t2, a2, v2 = mesh_stats(ob)
            if o2 == 0 and n2 <= NONMANIFOLD_LIMIT:
                fixed += 1
                note = '' if n2 == 0 else f' ({n2} non-manifold left)'
                log(f'{ob.name[:38]:40} hole-filled  {tris}->{t2} tris{note}')
                continue
            open_e, nonman, tris, area, vol = o2, n2, t2, a2, v2

        voxel, est = plan_remesh(area, vol, tris)
        thickness = (2.0 * vol / area) if area > 0 else 0.0
        if voxel is None:
            declined += 1
            log(f'{ob.name[:38]:40} LEFT AS IMPORTED — {thickness:.2f}mm walls would '
                f'need ~{est} tris to remesh safely (open={open_e} nonMan={nonman})')
            continue

        voxel_remesh(ob, voxel)
        o2, n2, t2, _, _ = mesh_stats(ob)
        remeshed += 1
        status = 'OK' if (o2 == 0 and n2 == 0) else f'STILL LEAKY open={o2} nonMan={n2}'
        log(f'{ob.name[:38]:40} remesh @{voxel:.2f} (walls {thickness:.2f}mm)  '
            f'{tris}->{t2} tris  {status}')

    log(f'summary: {clean} clean, {fixed} hole-filled, {remeshed} remeshed, '
        f'{declined} left as imported')

    # Derive cavities for hollow viscera that shipped as a single surface.
    for ob in list(keep):
        low = ob.name.lower()
        # Longest key first: 'bladder' is a substring of 'gallbladder', so a
        # naive scan gives the gallbladder the bladder's wall thickness.
        match = next((k for k in sorted(HOLLOW, key=len, reverse=True) if k in low), None)
        if not match or 'lumen' in low:
            continue
        lumen = make_lumen(ob, HOLLOW[match])
        if lumen:
            log(f'{ob.name[:38]:40} + lumen @{HOLLOW[match]}mm '
                f'({sum(len(p.vertices)-2 for p in lumen.data.polygons)} tris)')
        else:
            log(f'{ob.name[:38]:40} lumen FAILED (wall too thin or self-intersecting)')

    bpy.ops.export_scene.gltf(
        filepath=dst,
        export_format='GLB',
        export_draco_mesh_compression_enable=True,
        export_draco_mesh_compression_level=6,
        export_materials='EXPORT',
        export_normals=True,
        export_texcoords=False,
        export_yup=True,
    )
    log(f'wrote {dst}')


if __name__ == '__main__':
    main()
