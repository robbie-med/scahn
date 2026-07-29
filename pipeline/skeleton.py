"""
Skeleton sub-model pipeline: full-body GLB -> torso-only, mirrored, decimated.

    blender --background --factory-startup --python pipeline/skeleton.py -- IN.glb OUT.glb

Three things this has to do.

1. Filter. The source is a whole skeleton, 144 meshes and 508k triangles,
   including teeth, finger and toe phalanges, and a skull. None of that is
   reachable by an abdominal or cardiac probe, and all of it costs frame time.

2. Mirror. The source is a HEMI-skeleton: every paired bone exists only as `.r`.
   Shipping it unmirrored would give a patient with no left ribcage, which for a
   tool about where to put a probe would be worse than having no skeleton. The
   vertebrae sit at x = 0.0000, so the sagittal plane is exactly x = 0 and the
   mirror is unambiguous. Mirroring reverses winding, so faces are flipped back
   or every left-side bone would be inside-out and cap wrong.

3. Decimate. Vertebrae ship at ~8k triangles each; 24 of them alone would
   outweigh the entire abdomen model.

Orientation needs no correction: `.r` bones sit at negative X and the source is
already (left, superior, anterior), matching the scene basis. As with the heart,
the remap that IS applied is only the pre-compensation for the glTF exporter's
Z-up to Y-up conversion — here that is the identity, so nothing is done.
"""

import re
import sys
import bmesh
import bpy
import mathutils

# Bones a probe on the trunk could plausibly meet. Everything else is dropped.
KEEP = re.compile(
    r'vertebrae|atlas|axis|rib|costal|sternum|sacrum|coccyx|clavicle|scapula|hip bone',
    re.I,
)

TRI_BUDGET = 120000

# Ribs and the sternum are what actually shadow a cardiac or RUQ window, so they
# keep more detail than the vertebrae, which are mostly out of reach behind the
# viscera.
DETAIL = re.compile(r'rib|costal|sternum', re.I)
DETAIL_FLOOR = 0.35


def log(*a):
    print('[skeleton]', *a)


def tris(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)


def bake_world(ob):
    ob.data.transform(ob.matrix_world)
    ob.matrix_world = mathutils.Matrix.Identity(4)
    ob.data.update()


def mirror(ob):
    """Sagittal mirror of a `.r` bone to produce its left-side counterpart."""
    m = ob.copy()
    m.data = ob.data.copy()
    m.name = re.sub(r'\.r\.?$', '', ob.name).strip() + '.l'
    m.data.name = m.name
    bpy.context.collection.objects.link(m)

    m.data.transform(mathutils.Matrix.Scale(-1, 4, (1, 0, 0)))
    # A mirror reverses triangle winding. Left uncorrected, every mirrored bone
    # is inside-out: back faces become front faces and the stencil capping
    # counts them the wrong way round.
    bm = bmesh.new()
    bm.from_mesh(m.data)
    bmesh.ops.reverse_faces(bm, faces=bm.faces)
    bm.to_mesh(m.data)
    m.data.update()
    bm.free()
    return m


def tidy_name(name):
    n = name.lower()
    n = re.sub(r'[()]', '', n)
    n = re.sub(r'\s+', '-', n.strip())
    n = re.sub(r'-+', '-', n)
    return f'bone-{n}'


def main():
    argv = sys.argv[sys.argv.index('--') + 1:]
    src, dst = argv[0], argv[1]

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src)

    all_meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    keep = [o for o in all_meshes if KEEP.search(o.name)]
    log(f'imported {len(all_meshes)} meshes ({sum(tris(o) for o in all_meshes)} tris), '
        f'kept {len(keep)} torso bones')

    for ob in all_meshes:
        if ob not in keep:
            bpy.data.objects.remove(ob, do_unlink=True)

    for ob in keep:
        bake_world(ob)

    # Mirror the hemi-skeleton.
    made = []
    for ob in list(keep):
        if re.search(r'\.r\.?$', ob.name):
            made.append(mirror(ob))
    keep.extend(made)
    log(f'mirrored {len(made)} right-side bones to the left')

    total = sum(tris(o) for o in keep)
    ratio = min(1.0, TRI_BUDGET / total)
    log(f'{len(keep)} bones, {total} tris, global decimate ratio {ratio:.3f}')

    for ob in keep:
        r = max(ratio, DETAIL_FLOOR) if DETAIL.search(ob.name) else ratio
        if r < 0.999:
            bpy.context.view_layer.objects.active = ob
            mod = ob.modifiers.new(name='dec', type='DECIMATE')
            mod.ratio = r
            bpy.ops.object.modifier_apply(modifier=mod.name)
        ob.name = tidy_name(ob.name)
        ob.data.name = ob.name

    log(f'after decimate: {sum(tris(o) for o in keep)} tris across {len(keep)} bones')

    # Join every bone into ONE mesh.
    #
    # Capping clears the stencil buffer once per mesh, and a full-buffer clear is
    # not cheap. At 73 separate bones that is 73 clears per pass across three
    # passes, which took the panel from 5 ms to 32 ms a frame — the cost is mesh
    # count, not triangles.
    #
    # Safe to merge because every bone classifies identically, so nothing is lost
    # visually, and because the stencil count is per-ray: disjoint closed shells
    # in one mesh still balance individually. Even where a rib and its costal
    # cartilage interpenetrate the count stays nonzero inside the union, which is
    # the correct cap.
    bpy.ops.object.select_all(action='DESELECT')
    for ob in keep:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = keep[0]
    bpy.ops.object.join()
    merged = bpy.context.view_layer.objects.active
    merged.name = 'bone-skeleton'
    merged.data.name = merged.name
    log(f'joined into one mesh: {tris(merged)} tris')

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
