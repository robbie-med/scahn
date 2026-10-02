"""
Repair the shipped Visible Korean female pelvis GLB in place.

    blender --background --factory-startup --python pipeline/kvh_repair.py \
        -- IN.glb OUT.glb

The source slice stack is not on this machine, so this stage works on the
distributed artifact rather than regenerating it. Everything here is a
derivative of the same CC BY-NC 4.0 data and ships under the same terms. It
stays a separate GLB from the BodyParts3D model (see CLAUDE.md, licensing).

Two defects it fixes, and why they mattered:

1. **The bladder had no lumen.** It classified as "Bladder wall" and painted
   a solid mid-grey disc. A full bladder as an anechoic acoustic window is
   the whole point of the pelvic view, so the cavity is derived the same way
   the whole-body pipeline does it: the wall offset inward by its thickness.
   3 mm here (a full bladder's wall), in metres because this file is metres.

2. **The ureters and urethra were not cappable.** kvh_finish.py kept them
   blocky-and-smoothed because a 1.5 mm voxel remesh deletes a structure
   under a millimetre across — but the blocky shells were never manifold
   (1,500 open and 650 non-manifold edges each), so the stencil count never
   balanced and they painted garbage inside their bounding boxes. Each is
   rebuilt as a swept tube: vertices are ordered along the structure's
   principal axis, binned into a centreline, and a closed tube of realistic
   calibre (3 mm ureter, 4 mm urethra) is swept along it. That is a watertight
   surface by construction, and anatomically no worse than a sub-millimetre
   voxel stair-step.
"""

import math
import sys

import bmesh
import bpy
import mathutils

sys.path.insert(0, bpy.path.abspath('//'))

BLADDER_WALL_M = 0.003
TUBES = {
    'ureter-left': 0.0015,
    'ureter-right': 0.0015,
    'urethra-female': 0.002,
}
TUBE_BINS = 40
TUBE_SIDES = 12
SMOOTH_PASSES = 3


def log(*a):
    print('[kvh-repair]', *a, flush=True)


def mesh_stats(ob):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    open_e = sum(1 for e in bm.edges if len(e.link_faces) == 1)
    nonman = sum(1 for e in bm.edges if len(e.link_faces) > 2)
    tris = sum(len(f.verts) - 2 for f in bm.faces)
    try:
        vol = abs(bm.calc_volume(signed=True))
    except Exception:
        vol = 0.0
    bm.free()
    return open_e, nonman, tris, vol


def make_lumen(ob, thickness):
    """
    Duplicate a hollow organ and shrink it inward to form its cavity.

    A plain vertex-normal offset is what the whole-body pipeline uses, but
    this bladder has been remeshed, smoothed and decimated, and its concave
    neck folds through itself at 3 mm. So the offset shell is voxel-remeshed
    afterwards: the remesh takes a signed-distance field of the (closed,
    self-intersecting) shell and returns a clean manifold isosurface, which is
    exactly the repair a crumpled inward offset needs.
    """
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
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.dissolve_degenerate(bm, dist=1e-6, edges=bm.edges)
    bm.to_mesh(lumen.data)
    lumen.data.update()
    bm.free()

    o, n, t, vol = mesh_stats(lumen)
    if o or n or vol <= 0:
        bpy.ops.object.select_all(action='DESELECT')
        lumen.select_set(True)
        bpy.context.view_layer.objects.active = lumen
        mod = lumen.modifiers.new(name='remesh', type='REMESH')
        mod.mode = 'VOXEL'
        mod.voxel_size = 0.0015
        bpy.ops.object.modifier_apply(modifier=mod.name)
        o, n, t, vol = mesh_stats(lumen)
        log(f'{lumen.name[:28]:30} offset shell was not manifold; remeshed -> '
            f'open={o} nonMan={n} {t} tris')
    if o or n or vol <= 0:
        bpy.data.objects.remove(lumen, do_unlink=True)
        return None
    return lumen


def principal_axis(points):
    """Unit vector of greatest spread (power iteration on the covariance)."""
    c = sum(points, mathutils.Vector()) / len(points)
    cov = [[0.0] * 3 for _ in range(3)]
    for p in points:
        d = p - c
        for i in range(3):
            for j in range(3):
                cov[i][j] += d[i] * d[j]
    v = mathutils.Vector((1.0, 0.7, 0.3)).normalized()
    for _ in range(50):
        w = mathutils.Vector((
            cov[0][0] * v.x + cov[0][1] * v.y + cov[0][2] * v.z,
            cov[1][0] * v.x + cov[1][1] * v.y + cov[1][2] * v.z,
            cov[2][0] * v.x + cov[2][1] * v.y + cov[2][2] * v.z,
        ))
        if w.length < 1e-18:
            break
        v = w.normalized()
    return c, v


def centreline(points, bins=TUBE_BINS):
    """Bin the vertices along the principal axis and take each bin's mean."""
    c, axis = principal_axis(points)
    ts = [(p - c).dot(axis) for p in points]
    lo, hi = min(ts), max(ts)
    if hi - lo < 1e-9:
        return [c]
    sums = [mathutils.Vector() for _ in range(bins)]
    counts = [0] * bins
    for p, t in zip(points, ts):
        k = min(bins - 1, int((t - lo) / (hi - lo) * bins))
        sums[k] += p
        counts[k] += 1
    pts = [sums[k] / counts[k] for k in range(bins) if counts[k]]
    for _ in range(SMOOTH_PASSES):
        pts = [pts[0]] + [(pts[i - 1] + pts[i] + pts[i + 1]) / 3
                          for i in range(1, len(pts) - 1)] + [pts[-1]]
    return pts


def sweep_tube(name, path, radius, sides=TUBE_SIDES):
    """Closed tube along `path`: rings joined by quads, capped at both ends."""
    bm = bmesh.new()
    rings = []
    up = mathutils.Vector((0.0, 0.0, 1.0))
    for i, p in enumerate(path):
        if len(path) == 1:
            tangent = up
        elif i == 0:
            tangent = (path[1] - path[0]).normalized()
        elif i == len(path) - 1:
            tangent = (path[-1] - path[-2]).normalized()
        else:
            tangent = (path[i + 1] - path[i - 1]).normalized()
        ref = up if abs(tangent.dot(up)) < 0.9 else mathutils.Vector((1.0, 0.0, 0.0))
        n1 = tangent.cross(ref).normalized()
        n2 = tangent.cross(n1).normalized()
        ring = []
        for s in range(sides):
            a = 2 * math.pi * s / sides
            ring.append(bm.verts.new(p + n1 * (radius * math.cos(a)) + n2 * (radius * math.sin(a))))
        rings.append(ring)
    for r0, r1 in zip(rings, rings[1:]):
        for s in range(sides):
            bm.faces.new((r0[s], r0[(s + 1) % sides], r1[(s + 1) % sides], r1[s]))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    return ob


def rebuild_as_tube(ob, radius):
    pts = [ob.matrix_world @ v.co for v in ob.data.vertices]
    before = mesh_stats(ob)
    path = centreline(pts)
    name = ob.name
    bpy.data.objects.remove(ob, do_unlink=True)
    tube = sweep_tube(name, path, radius)
    tube.data.name = name
    o, n, t, vol = mesh_stats(tube)
    log(f'{name[:28]:30} tube r={radius * 1000:.1f}mm over {len(path)} points: '
        f'{before[2]} tris (open={before[0]} nonMan={before[1]}) -> {t} tris '
        f'(open={o} nonMan={n}, {vol * 1e6:.1f} mL)')
    return tube


def centre(ob):
    """Bounding-box centre in SCENE axes: gltf = (bx, bz, -by)."""
    c = sum((mathutils.Vector(v) for v in ob.bound_box), mathutils.Vector()) / 8
    b = ob.matrix_world @ c
    return mathutils.Vector((b.x, b.z, -b.y))


def assertions():
    """Anatomy, not node names. Scene basis is +X left, +Y superior, +Z anterior."""
    get = lambda n: centre(bpy.data.objects[n])
    ovr, ovl = get('ovary-right'), get('ovary-left')
    ut, vag = get('uterus'), get('vagina')
    bl, rec = get('bladder'), get('rectum')
    urr, url = get('ureter-right'), get('ureter-left')
    checks = [
        ('right ovary on the patient RIGHT (negative X)', ovr.x < 0),
        ('left ovary on the patient LEFT (positive X)', ovl.x > 0),
        ('uterus superior to the vagina', ut.y > vag.y),
        ('bladder anterior to the rectum', bl.z > rec.z),
        ('uterus posterior to the bladder', ut.z < bl.z),
        ('right ureter on the patient RIGHT', urr.x < 0),
        ('left ureter on the patient LEFT', url.x > 0),
        ('bladder lumen exists', 'bladder_lumen' in bpy.data.objects),
    ]
    for label, ok in checks:
        log(f'  assert {label:52} {"OK" if ok else "FAILED"}')
    if not all(ok for _, ok in checks):
        raise AssertionError('female pelvis is mirrored or misplaced — do not use this GLB')


def main():
    argv = sys.argv[sys.argv.index('--') + 1:]
    src, dst = argv[0], argv[1]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src)
    bpy.context.view_layer.update()

    if 'bladder_lumen' in bpy.data.objects:
        raise SystemExit('already repaired: bladder_lumen present')

    for name, radius in TUBES.items():
        ob = bpy.data.objects.get(name)
        if ob is None:
            log(f'{name}: absent, skipped')
            continue
        rebuild_as_tube(ob, radius)

    bladder = bpy.data.objects['bladder']
    lumen = make_lumen(bladder, BLADDER_WALL_M)
    if lumen is None:
        raise SystemExit('bladder lumen failed (wall too thin or self-intersecting)')
    o, n, t, vol = mesh_stats(lumen)
    log(f'{"bladder":30} + lumen @{BLADDER_WALL_M * 1000:.0f}mm ({t} tris, {vol * 1e6:.0f} mL)')

    bpy.context.view_layer.update()
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
