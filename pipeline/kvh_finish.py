"""
Stage 2 of the Visible Korean female pelvis build: blocky OBJs -> Draco GLB.

    blender --background --factory-startup --python pipeline/kvh_finish.py \
        -- OBJ_DIR OUT.glb

*** LICENCE: NOT CLEARED — see kvh_pelvis.py. Local use only. ***

Stage 1 emits one blocky OBJ per structure, already in the Blender pre-export
frame and in metres, so there is no coordinate work here. This stage only has to
turn voxel staircases into something that reads as anatomy, get the triangle
count down to something shippable, and prove the result is still the right way
round.

Voxel remesh rather than a smoothing modifier alone: the input is a boundary of
axis-aligned cubes, so smoothing it directly just rounds the corners of the
staircase. Remeshing resamples it into an isosurface, which is what removes the
terracing; the shrink-wrap-ish loss of fine detail is acceptable because
everything here is rendered as a flat grey cross-section.

The remesh voxel size is deliberately close to the source resolution (0.768 mm
in-plane, 1.0 mm slices). Going finer just re-encodes the staircase; going much
coarser eats the thin structures, and the thinnest things here — the ureters at
under a millimetre across, the female urethra — are exactly the ones a coarse
remesh deletes silently.
"""

import json
import os
import sys

import bmesh
import bpy
import mathutils

REMESH_VOXEL = 0.0015          # 1.5 mm
SMOOTH_ITERATIONS = 3
# Per-class triangle budgets. Skin dominates by surface area and carries the
# least information, so it gets the harshest cut.
BUDGET = {'organs': 70000, 'muscles': 90000, 'bones': 60000, 'skin': 35000}
# Structures too thin to survive a 1.5 mm remesh. They keep their blocky form,
# smoothed instead — a slightly faceted ureter beats a deleted one.
THIN = {'ureter-right', 'ureter-left', 'urethra-female'}


def log(*a):
    print('[kvh-finish]', *a, flush=True)


def tri_count(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)


def weld(ob, dist=1e-5):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=dist)
    bm.to_mesh(ob.data)
    ob.data.update()
    bm.free()


def select_only(ob):
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob


def apply_mod(ob, mod):
    # modifier_apply is a silent no-op unless the object is SELECTED, not
    # merely active — the same trap the BodyParts3D pipeline documents.
    select_only(ob)
    bpy.ops.object.modifier_apply(modifier=mod.name)


def smooth(ob, iterations):
    m = ob.modifiers.new(name='smooth', type='SMOOTH')
    m.iterations = iterations
    m.factor = 1.0
    apply_mod(ob, m)


def remesh(ob, voxel):
    m = ob.modifiers.new(name='remesh', type='REMESH')
    m.mode = 'VOXEL'
    m.voxel_size = voxel
    apply_mod(ob, m)


def decimate(ob, budget):
    n = tri_count(ob)
    if n <= budget:
        return n
    m = ob.modifiers.new(name='dec', type='DECIMATE')
    m.ratio = budget / n
    apply_mod(ob, m)
    return tri_count(ob)


def centre(ob):
    """Bounding-box centre in SCENE axes: gltf = (bx, bz, -by)."""
    c = sum((mathutils.Vector(v) for v in ob.bound_box), mathutils.Vector()) / 8
    b = ob.matrix_world @ c
    return mathutils.Vector((b.x, b.z, -b.y))


def assertions():
    """
    Anatomy, not node names. Scene basis is +X patient's left, +Y superior,
    +Z anterior.
    """
    get = lambda n: centre(bpy.data.objects[n])
    ovr, ovl = get('ovary-right'), get('ovary-left')
    ut, vag = get('uterus'), get('vagina')
    bl, rec = get('bladder'), get('rectum')
    for n in ('ovary-right', 'ovary-left', 'uterus', 'vagina', 'bladder', 'rectum'):
        c = get(n)
        log(f'  centre {n:18} ({c.x:+.4f}, {c.y:+.4f}, {c.z:+.4f}) m')
    checks = [
        ('right ovary on the patient RIGHT (negative X)', ovr.x < 0),
        ('left ovary on the patient LEFT (positive X)', ovl.x > 0),
        ('left ovary at greater X than the right', ovl.x > ovr.x),
        ('uterus superior to the vagina', ut.y > vag.y),
        ('bladder anterior to the rectum', bl.z > rec.z),
        ('uterus posterior to the bladder', ut.z < bl.z),
    ]
    for label, ok in checks:
        log(f'  assert {label:52} {"OK" if ok else "FAILED"}')
    if not all(ok for _, ok in checks):
        raise AssertionError('female pelvis is mirrored or misplaced — do not use this GLB')


def main():
    argv = sys.argv[sys.argv.index('--') + 1:]
    obj_dir, dst = argv[0], argv[1]
    meta = json.load(open(os.path.join(obj_dir, 'manifest.json')))
    klass = {s['name']: s['class'] for s in meta['structures']}

    bpy.ops.wm.read_factory_settings(use_empty=True)
    made = []
    for s in meta['structures']:
        name = s['name']
        path = os.path.join(obj_dir, f'{name}.obj')
        before = set(bpy.data.objects)
        bpy.ops.wm.obj_import(filepath=path, forward_axis='Y', up_axis='Z')
        new = [o for o in bpy.data.objects if o not in before and o.type == 'MESH']
        if not new:
            raise RuntimeError(f'nothing imported from {path}')
        ob = new[0]
        if len(new) > 1:
            select_only(ob)
            for o in new:
                o.select_set(True)
            bpy.ops.object.join()
            ob = bpy.context.view_layer.objects.active
        ob.name = name
        ob.data.name = name
        raw = tri_count(ob)
        weld(ob)
        if name in THIN:
            smooth(ob, 2)
        else:
            remesh(ob, REMESH_VOXEL)
            smooth(ob, SMOOTH_ITERATIONS)
        mid = tri_count(ob)
        final = decimate(ob, BUDGET[klass[name]] // max(1, sum(
            1 for x in meta['structures'] if x['class'] == klass[name])))
        log(f'{name[:28]:30} {raw:8d} -> remesh {mid:7d} -> {final:6d} tris')
        made.append(ob)

    bpy.context.view_layer.update()
    log(f'total {sum(tri_count(o) for o in made)} tris across {len(made)} meshes')
    log('anatomical assertions, pre-export:')
    assertions()

    bpy.ops.export_scene.gltf(
        filepath=dst, export_format='GLB',
        export_draco_mesh_compression_enable=True,
        export_draco_mesh_compression_level=6,
        export_materials='NONE', export_normals=True,
        export_texcoords=False, export_yup=True,
    )
    log(f'wrote {dst}')

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=dst)
    log('anatomical assertions, re-imported GLB:')
    assertions()
    log('verification OK')


if __name__ == '__main__':
    main()
