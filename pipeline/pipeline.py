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

# Above this many defects a mesh is torn rather than nicked, and hole filling
# would just span the tears with garbage triangles.
LIGHT_REPAIR_LIMIT = 12

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
    bm.free()
    return open_e, nonman, tris, area


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


def voxel_remesh(ob, area, current_tris):
    """Tier 2: rebuild the surface. Guarantees manifold output."""
    target = max(MIN_TARGET_TRIS, min(MAX_TARGET_TRIS, current_tris))
    # tris ~= 2 * area / voxel^2  ->  voxel = sqrt(2 * area / target)
    voxel = (2.0 * area / target) ** 0.5 if area > 0 else 2.0
    voxel = max(0.8, min(voxel, 8.0))

    bpy.context.view_layer.objects.active = ob
    mod = ob.modifiers.new(name='voxel', type='REMESH')
    mod.mode = 'VOXEL'
    mod.voxel_size = voxel
    bpy.ops.object.modifier_apply(modifier=mod.name)
    return voxel


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

    fixed = remeshed = clean = 0
    for ob in sorted(keep, key=lambda o: -len(o.data.polygons)):
        weld_and_clean(ob)
        open_e, nonman, tris, area = mesh_stats(ob)
        if open_e == 0 and nonman == 0:
            clean += 1
            log(f'{ob.name[:38]:40} already watertight ({tris} tris)')
            continue

        defects = open_e + nonman
        if defects <= LIGHT_REPAIR_LIMIT:
            fill_holes(ob)
            o2, n2, t2, _ = mesh_stats(ob)
            if o2 == 0 and n2 == 0:
                fixed += 1
                log(f'{ob.name[:38]:40} hole-filled  {tris}->{t2} tris')
                continue
            open_e, nonman, tris, area = o2, n2, t2, area

        voxel = voxel_remesh(ob, area, tris)
        o2, n2, t2, _ = mesh_stats(ob)
        remeshed += 1
        status = 'OK' if (o2 == 0 and n2 == 0) else f'STILL LEAKY open={o2} nonMan={n2}'
        log(f'{ob.name[:38]:40} remesh @{voxel:.2f}  {tris}->{t2} tris  {status}')

    log(f'summary: {clean} already clean, {fixed} hole-filled, {remeshed} remeshed')

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
