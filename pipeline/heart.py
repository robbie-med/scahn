"""
Heart sub-model pipeline: FBX -> scene-space, decimated, Draco GLB.

    blender --background --factory-startup --python pipeline/heart.py -- IN.fbx OUT.glb

This heart replaces the one bundled in the abdomen model, which is a closed
outer shell with no chambers. This one has genuine interior surfaces — ray
casting crosses 8 to 10 surfaces per axis rather than 2 — so the chambers cap
open by themselves and nothing has to be invented.

## Orientation, established from the valves rather than from node names

    mitral (+Y) vs tricuspid (-Y)          -> +Y is the patient's LEFT
    semilunar valves sit superior to AV:
      pulmonary +0.0074 > aortic -0.0101
      > mitral -0.0155 > tricuspid -0.0187 -> +Z is SUPERIOR
    right-handed closure, Left x Superior = Anterior
                                            -> +X is ANTERIOR

So the source basis is (anterior, left, superior) against the scene's
(left, superior, anterior). That is a cyclic permutation with determinant +1 —
a proper rotation, no mirroring. Baked here so the runtime only needs to
translate the heart into place (CONVENTIONS.md section 5: one named correction,
applied once).

The model is already life size (5.6 x 7.5 x 11.6 cm), so no scaling is applied.
"""

import sys
import bmesh
import bpy
import mathutils

# Total triangle budget for the whole heart assembly. The source is 368k, which
# is more than the entire abdomen model, and every organ is drawn four times per
# frame across two passes.
TRI_BUDGET = 90000

# Valves are small, high-curvature and diagnostically the point of a cardiac
# view, so they are protected from the worst of the decimation.
VALVE_FLOOR = 0.55

WELD_DIST = 1e-5

# Unambiguous names for the runtime classifier. The source ships Maya autonames
# ("polySurface4") and a misspelling ("Vains") that no keyword list should be
# expected to guess at.
RENAME = [
    ('tricuspid', 'heart-valve-tricuspid'),
    ('mitral', 'heart-valve-mitral'),
    ('aortice', 'heart-valve-aortic'),
    ('aortic', 'heart-valve-aortic'),
    ('pulmonary', 'heart-valve-pulmonary'),
    ('vains_2', 'heart-vessels-2'),
    ('vains_1', 'heart-vessels-1'),
    ('polysurface4', 'heart-myocardium'),
    ('polysurface3', 'heart-myocardium-inner'),
]


def log(*a):
    print('[heart]', *a)


def tri_count(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)


def rename(ob):
    low = ob.name.lower()
    for needle, new in RENAME:
        if needle in low:
            return new
    return f'heart-{ob.name.lower()}'


def main():
    argv = sys.argv[sys.argv.index('--') + 1:]
    src, dst = argv[0], argv[1]

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=src)
    meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    log(f'imported {len(meshes)} meshes, {sum(tri_count(o) for o in meshes)} tris')

    # Bake the FULL world transform into the vertex data, then reset the object
    # transforms. `transform_apply` is NOT sufficient here: the FBX importer
    # parents every mesh under a scaled root, and transform_apply only bakes an
    # object's own transform, so the parent's 0.01 scale survives and the model
    # comes out 100x too large. Baking matrix_world also guarantees the axis
    # remap below operates on exactly the coordinates the orientation was
    # measured in — otherwise the remap silently permutes the wrong axes.
    for ob in meshes:
        ob.data.transform(ob.matrix_world)
        ob.matrix_world = mathutils.Matrix.Identity(4)
        ob.data.update()

    # Remap into BLENDER's frame such that the glTF exporter's own Z-up -> Y-up
    # conversion lands us in scene axes. Targeting scene axes directly here is
    # wrong and is why the heart first came out lying on its back: the exporter
    # applies (x, y, z) -> (x, z, -y) on the way out, so we must pre-compensate.
    #
    #   want glTF/scene = (left, superior, anterior)
    #   exporter gives  glTF = (blender_x, blender_z, -blender_y)
    #   therefore blender must be (left, posterior, superior)
    #
    # source (post-FBX-import, Blender world) is (anterior, left, superior):
    #   blender_x = left      =  source_y
    #   blender_y = posterior = -source_x
    #   blender_z = superior  =  source_z
    remap = mathutils.Matrix((
        (0.0, 1.0, 0.0, 0.0),
        (-1.0, 0.0, 0.0, 0.0),
        (0.0, 0.0, 1.0, 0.0),
        (0.0, 0.0, 0.0, 1.0),
    ))
    assert abs(remap.to_3x3().determinant() - 1.0) < 1e-9, 'remap must be a proper rotation'

    for ob in meshes:
        ob.data.transform(remap)
        ob.data.update()

    # Centre the assembly on its own bounding box, so the runtime override only
    # has to translate it to the correct place in the torso.
    lo = mathutils.Vector((1e18,) * 3)
    hi = mathutils.Vector((-1e18,) * 3)
    for ob in meshes:
        for v in ob.data.vertices:
            for i in range(3):
                lo[i] = min(lo[i], v.co[i])
                hi[i] = max(hi[i], v.co[i])
    centre = (lo + hi) / 2
    shift = mathutils.Matrix.Translation(-centre)
    for ob in meshes:
        ob.data.transform(shift)
        ob.data.update()
    # Blender frame here is (left, posterior, superior); the exporter turns that
    # into scene axes. A human heart is roughly LR 7-9, SI 11-13, AP 5-7 cm.
    log(f'extent LR={hi.x-lo.x:.4f} AP={hi.y-lo.y:.4f} SI={hi.z-lo.z:.4f} m (pre-export frame)')

    # Weld before measuring: FBX splits vertices at smoothing and UV seams.
    for ob in meshes:
        bm = bmesh.new()
        bm.from_mesh(ob.data)
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=WELD_DIST)
        bm.to_mesh(ob.data)
        ob.data.update()
        bm.free()

    total = sum(tri_count(o) for o in meshes)
    ratio = min(1.0, TRI_BUDGET / total)
    log(f'welded to {total} tris, global decimate ratio {ratio:.3f}')

    for ob in meshes:
        is_valve = 'valve' in rename(ob)
        r = max(ratio, VALVE_FLOOR) if is_valve else ratio
        before = tri_count(ob)
        if r < 0.999:
            bpy.context.view_layer.objects.active = ob
            mod = ob.modifiers.new(name='dec', type='DECIMATE')
            mod.ratio = r
            bpy.ops.object.modifier_apply(modifier=mod.name)
        ob.name = rename(ob)
        ob.data.name = ob.name
        log(f'{ob.name:28} {before:>7} -> {tri_count(ob):>7} tris')

    log(f'total {sum(tri_count(o) for o in meshes)} tris')

    bpy.ops.export_scene.gltf(
        filepath=dst,
        export_format='GLB',
        export_draco_mesh_compression_enable=True,
        export_draco_mesh_compression_level=6,
        export_materials='NONE',
        export_normals=True,
        export_texcoords=False,
        export_yup=True,
    )
    log(f'wrote {dst}')


if __name__ == '__main__':
    main()
