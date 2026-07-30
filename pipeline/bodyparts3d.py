"""
BodyParts3D full-body pipeline: ISA-tree OBJ parts -> one Draco-compressed GLB.

    blender --background --factory-startup --python pipeline/bodyparts3d.py -- ISA_OBJ_DIR OUT.glb

Builds every mesh named in bodyparts3d_manifest.py from the raw BodyParts3D
OBJ drop, repairs it (same two-tier logic as pipeline.py — hole-fill first,
wall-thickness-capped voxel remesh only for genuinely torn meshes), derives
bladder/gallbladder lumens, applies the single named source->scene correction
(CONVENTIONS.md section 5), asserts laterality, and exports.

Repair runs in MILLIMETRES, before any transform: the pipeline.py constants
(WELD_DIST, voxel caps) are tuned for mm and BP3D is authored in mm. Scaling
first would make the weld threshold meaningless.

Coordinate chain (each step verified by the assertions at the bottom):

    BP3D file axes:      +X left, +Y posterior, +Z superior, mm
                         (3d_models/bodyparts3d/coordinate_system.png)
    OBJ import (Y-up):   blender = (file_x, -file_z, file_y)
                         = (left, inferior, posterior)
    SOURCE_TO_SCAHN:     blender = (left, posterior, superior), metres
    recentre:            BP3D is authored with its origin at the FEET, so the
                         torso lands at blender z ~0.75-1.45; the scene expects
                         the torso centred on the origin (the shell fit pins
                         yCenter to 0). Translated so the SI midpoint of the
                         whole set sits at z=0. This is part of the same single
                         named correction — a runtime offset would be a second
                         transform in a second place.
    glTF export_yup:     gltf = (blender_x, blender_z, -blender_y)
                         = (left, superior, anterior)  == scene basis
"""

import os
import sys

import bmesh
import bpy
import mathutils

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from bodyparts3d_manifest import BONES, MUSCLES, ORGANS, SKIN
from pipeline import (
    HOLLOW,
    NONMANIFOLD_LIMIT,
    fill_holes,
    log,
    make_lumen,
    mesh_stats,
    plan_remesh,
    voxel_remesh,
    weld_and_clean,
)

# CONVENTIONS.md section 5: the single named source->scene correction.
#
# Targeting scene axes directly here is wrong (the heart first shipped lying on
# its back that way): the glTF exporter applies (x, y, z) -> (x, z, -y) on the
# way out, so the Blender-internal frame must be pre-compensated to
# (left, posterior, superior). See the module docstring for the full chain.
#
# Post-import Blender holds (left, inferior, posterior):
#   blender_x' = left      =  blender_x
#   blender_y' = posterior =  blender_z
#   blender_z' = superior  = -blender_y
SOURCE_TO_SCAHN_ROT = mathutils.Matrix((
    (1.0, 0.0, 0.0),
    (0.0, 0.0, 1.0),
    (0.0, -1.0, 0.0),
))
assert abs(SOURCE_TO_SCAHN_ROT.determinant() - 1.0) < 1e-9, \
    'SOURCE_TO_SCAHN must be a proper rotation — a mirror here flips patient laterality'

# mm -> m, composed with the rotation. One matrix, applied once, to every mesh.
SOURCE_TO_SCAHN = mathutils.Matrix.Scale(0.001, 4) @ SOURCE_TO_SCAHN_ROT.to_4x4()

# heart-valve-* meshes are thin open shells whose boundary loops ARE the
# anatomy (leaflet free edges). Hole-filling or remeshing them seals those
# boundaries and destroys the chamber views; the renderer's bounding-box guard
# covers the residual leaks. Weld and clean only.
VALVE_PREFIX = 'heart-valve-'

# --- skin shell -------------------------------------------------------------
#
# The skin is NOT anatomy for this tool: nothing images it, the scan plane
# never cuts it, and it is excluded from the capping set entirely. It is the
# surface the probe rides on (torso.js raycasts it) and a translucent shell to
# look through. So it is treated unlike every other mesh here:
#
#   - never repaired. It is an open shell BY DESIGN once cropped, and
#     hole-filling would cap the neck and waist openings shut.
#   - never asserted on. It has no laterality to check.
#   - cropped to the trunk, because BP3D ships it head-to-feet and the probe
#     only ever rides the trunk. Cropping first means the triangle budget is
#     spent where the probe actually is.
#   - decimated hard. 203k faces for a surface whose only jobs are a raycast
#     and a 16%-opacity render is two orders of magnitude more than needed.
#
# Range is in the PRE-EXPORT Blender frame (left, posterior, superior), so
# superior-inferior is blender Z, and it is applied AFTER the recentring that
# puts the torso's SI midpoint at 0. torso.js rides v=0..1 over
# y=-0.30..+0.30 m; the margin here keeps the shell from ending exactly at the
# probe's travel limit.
SKIN_TRUNK_Z = (-0.36, 0.38)
SKIN_TRI_BUDGET = 18000

# Total triangles for the whole muscle layer. The raw set is ~66 MB of OBJ —
# more than the rest of the model combined — because sheet muscles like the
# intercostals and external oblique are finely tessellated over a large area.
# They are near-field context, not the structures being measured, so they get a
# small share of the budget.
MUSCLE_TRI_BUDGET = 45000

# --- Z-Anatomy muscle top-up ------------------------------------------------
#
# BodyParts3D simply has no rectus abdominis, internal oblique, transversus
# abdominis, latissimus dorsi or quadratus lumborum — and those are precisely
# the near-field layers a learner scans THROUGH on an abdominal view. Z-Anatomy
# (itself BP3D-derived) does have them, so they are appended from its blend.
#
# LICENCE: Z-Anatomy is CC BY-SA 4.0, BodyParts3D is CC BY 4.0. Including these
# makes the shipped GLB a combined work carrying a share-alike obligation. That
# is a deliberate product decision, not an implementation detail — see
# credits.js and the About panel.
#
# FRAME: verified, not assumed. Measured in the blend, Z-Anatomy is METRES,
# Z-up, origin at the feet, with (+X left, +Y posterior, +Z superior) — rectus
# abdominis anterior at y=-0.1, latissimus dorsi posterior at y=+0.1, liver
# (z=1.2) above bladder (z=0.9). That is already the pre-export Blender frame
# SOURCE_TO_SCAHN produces, and already in metres, so these get NO rotation and
# NO scale: only the same SI recentring the BP3D meshes receive. The assertions
# at the bottom re-check that rather than trusting it.
ZANATOMY_BLEND = os.path.join('3d_models', 'z-anatomy', 'Z-Anatomy', 'Startup.blend')
# Z-Anatomy and BodyParts3D do NOT share an origin. Z-Anatomy is BP3D-derived
# but retopologised and reseated, and dropping its meshes in on the assumption
# that they register put latissimus dorsi 7.5 cm behind the skin of the back and
# buried rectus abdominis 10 cm deep. Relative-order assertions did not catch it,
# because the whole set was offset together. So the offset is MEASURED from a
# structure both models contain, and applied before anything else.
Z_LANDMARK = 'Liver'

Z_MUSCLES = [
    ('muscle-rectus-abdominis', ['Rectus abdominis muscle.l', 'Rectus abdominis muscle.r']),
    ('muscle-oblique-internal', ['Internal abdominal oblique muscle.l',
                                 'Internal abdominal oblique muscle.r']),
    ('muscle-transversus-abdominis', ['Transversus abdominis muscle.l',
                                      'Transversus abdominis muscle.r']),
    ('muscle-latissimus-dorsi', ['Latissimus dorsi muscle.l', 'Latissimus dorsi muscle.r']),
    ('muscle-quadratus-lumborum', ['Quadratus lumborum muscle.l',
                                   'Quadratus lumborum muscle.r']),
]


def import_obj(path):
    """Import one OBJ, returning its new mesh objects. Fail loudly on a miss."""
    if not os.path.isfile(path):
        raise FileNotFoundError(f'manifest id without a file: {path}')
    before = set(bpy.data.objects)
    # Explicit axes so the chain in the docstring does not depend on defaults.
    bpy.ops.wm.obj_import(filepath=path, forward_axis='NEGATIVE_Z', up_axis='Y')
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == 'MESH']
    for o in new:
        if o.type != 'MESH':
            bpy.data.objects.remove(o, do_unlink=True)
    if not meshes:
        raise RuntimeError(f'no mesh imported from {path}')
    return meshes


def bake_world(ob):
    """Bake the full world transform into the vertex data, reset to identity.

    Same idiom as heart.py: the axis remap must operate on exactly the
    coordinates the file was authored in, not on whatever object transform the
    importer happened to hang on the object.
    """
    ob.data.transform(ob.matrix_world)
    ob.matrix_world = mathutils.Matrix.Identity(4)
    ob.data.update()


def join_objects(objs, name):
    bpy.ops.object.select_all(action='DESELECT')
    for ob in objs:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    merged = bpy.context.view_layer.objects.active
    merged.name = name
    merged.data.name = name
    return merged


def repair(ob):
    """
    Two-tier repair, same decision logic as pipeline.py's main flow, plus the
    selection the modifier_apply gotcha needs (skeleton.py: a modifier_apply
    on an object that is active but not SELECTED is a silent no-op).
    """
    if ob.name.startswith(VALVE_PREFIX):
        weld_and_clean(ob)
        open_e, nonman, tris, _, _ = mesh_stats(ob)
        log(f'{ob.name[:38]:40} valve shell — weld/clean only '
            f'(open={open_e} nonMan={nonman}, {tris} tris)')
        return 'valve'

    weld_and_clean(ob)
    open_e, nonman, tris, area, vol = mesh_stats(ob)
    if open_e == 0 and nonman == 0:
        log(f'{ob.name[:38]:40} already watertight ({tris} tris)')
        return 'clean'

    # Tier 1 first, whatever the hole count. Most "damage" is open tube ends.
    if nonman <= NONMANIFOLD_LIMIT:
        if open_e:
            fill_holes(ob)
        o2, n2, t2, a2, v2 = mesh_stats(ob)
        if o2 == 0 and n2 <= NONMANIFOLD_LIMIT:
            note = '' if n2 == 0 else f' ({n2} non-manifold left)'
            log(f'{ob.name[:38]:40} hole-filled  {tris}->{t2} tris{note}')
            return 'fixed'
        open_e, nonman, tris, area, vol = o2, n2, t2, a2, v2

    voxel, est = plan_remesh(area, vol, tris)
    thickness = (2.0 * vol / area) if area > 0 else 0.0
    if voxel is None:
        log(f'{ob.name[:38]:40} LEFT AS IMPORTED — {thickness:.2f}mm walls would '
            f'need ~{est} tris to remesh safely (open={open_e} nonMan={nonman})')
        return 'declined'

    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    voxel_remesh(ob, voxel)
    o2, n2, t2, _, _ = mesh_stats(ob)
    status = 'OK' if (o2 == 0 and n2 == 0) else f'STILL LEAKY open={o2} nonMan={n2}'
    log(f'{ob.name[:38]:40} remesh @{voxel:.2f} (walls {thickness:.2f}mm)  '
        f'{tris}->{t2} tris  {status}')
    return 'remeshed'


def build_skin(src_dir, si_mid):
    """
    Import, place, crop and decimate the skin shell.

    Deliberately called AFTER the organ recentring, and given that recentring's
    `si_mid` to apply itself, rather than being imported alongside everything
    else. If the skin were in `all_meshes` when the SI midpoint is computed, a
    head-to-feet mesh would drag that midpoint off the torso and translate
    every organ with it — silently moving the anatomy the eight window presets
    were tuned against. Importing it after keeps the existing model bit-identical.
    """
    objs = []
    for fj in SKIN:
        objs.extend(import_obj(os.path.join(src_dir, f'{fj}.obj')))
    for ob in objs:
        bake_world(ob)
    skin = join_objects(objs, 'skin-surface') if len(objs) > 1 else objs[0]
    skin.name = 'skin-surface'
    skin.data.name = 'skin-surface'

    before = sum(len(p.vertices) - 2 for p in skin.data.polygons)

    # Same named correction every other mesh got, then the same recentring.
    skin.data.transform(SOURCE_TO_SCAHN)
    skin.data.transform(mathutils.Matrix.Translation((0.0, 0.0, -si_mid)))
    skin.data.update()

    lo_z, hi_z = SKIN_TRUNK_Z
    bm = bmesh.new()
    bm.from_mesh(skin.data)
    doomed = [v for v in bm.verts if v.co.z < lo_z or v.co.z > hi_z]
    bmesh.ops.delete(bm, geom=doomed, context='VERTS')
    bm.to_mesh(skin.data)
    skin.data.update()
    bm.free()
    cropped = sum(len(p.vertices) - 2 for p in skin.data.polygons)

    if cropped > SKIN_TRI_BUDGET:
        # modifier_apply is a silent no-op unless the object is SELECTED, not
        # merely active (skeleton.py's lesson).
        bpy.ops.object.select_all(action='DESELECT')
        skin.select_set(True)
        bpy.context.view_layer.objects.active = skin
        mod = skin.modifiers.new(name='dec', type='DECIMATE')
        mod.ratio = SKIN_TRI_BUDGET / cropped
        bpy.ops.object.modifier_apply(modifier=mod.name)
    final = sum(len(p.vertices) - 2 for p in skin.data.polygons)

    bpy.context.view_layer.update()
    zs = [(skin.matrix_world @ mathutils.Vector(c)).z for c in skin.bound_box]
    log(f'{"skin-surface":40} {before} -> crop {cropped} -> decimate {final} tris '
        f'(SI {min(zs):+.3f}..{max(zs):+.3f} m)')
    return skin


def append_zanatomy_muscles(si_mid):
    """
    Append the muscles BodyParts3D lacks from the Z-Anatomy blend.

    Returns [] when the blend is absent, so the build still works from the
    BP3D drop alone — the layer is just missing the abdominal wall.
    """
    if not os.path.isfile(ZANATOMY_BLEND):
        log(f'Z-Anatomy blend not found at {ZANATOMY_BLEND}; '
            f'skipping the abdominal-wall muscles')
        return []

    # 'Liver' rides along purely as a registration landmark: it exists in both
    # models, so the offset between the two bodies can be measured rather than
    # assumed. It is deleted again once the muscles are aligned.
    wanted = [n for _, srcs in Z_MUSCLES for n in srcs] + [Z_LANDMARK]
    with bpy.data.libraries.load(ZANATOMY_BLEND, link=False) as (src, dst):
        missing = [n for n in wanted if n not in src.objects]
        if missing:
            raise RuntimeError(f'Z-Anatomy objects not in blend: {missing}')
        # A COPY, not `wanted` itself. Blender rewrites the assigned list IN
        # PLACE on exiting the block, swapping the names for the loaded
        # datablocks — aliasing it here silently turns `wanted` into a list of
        # Objects, and every later name lookup misses.
        dst.objects = list(wanted)
    # After the with-block dst.objects holds the loaded datablocks, in the same
    # order as requested. Link by datablock, and key by the name we asked for
    # rather than ob.name: appending can suffix a name on collision.
    appended = {}
    for name, ob in zip(wanted, dst.objects):
        if ob is None:
            continue
        if ob.name not in bpy.context.scene.objects:
            bpy.context.scene.collection.objects.link(ob)
        appended[name] = ob

    # Evaluate the depsgraph before ANY matrix_world is read. Freshly appended
    # objects report an identity world matrix until the view layer updates, so
    # capturing it here without this yields raw local coordinates — rectus
    # abdominis baked at its authoring origin instead of its body position,
    # while its neighbours happened to look plausible.
    bpy.context.view_layer.update()

    # Measure the body-to-body offset from the shared landmark first.
    lm = appended.get(Z_LANDMARK)
    if lm is None:
        raise RuntimeError(f'Z-Anatomy landmark {Z_LANDMARK!r} not appended')
    lm.data = lm.data.copy()
    lm_mw = lm.matrix_world.copy()
    lm.parent = None
    lm.matrix_parent_inverse.identity()
    lm.matrix_basis.identity()
    lm.data.transform(lm_mw)
    lm.data.transform(mathutils.Matrix.Translation((0.0, 0.0, -si_mid)))
    lm.data.update()
    bpy.context.view_layer.update()
    z_lm = scene_centre(lm)
    bp_lm = scene_centre(bpy.data.objects['liver'])
    # scene axes are (left, superior, anterior); convert the correction back to
    # the pre-export Blender frame (x, -z, y) the meshes still live in.
    d = bp_lm - z_lm
    delta = mathutils.Vector((d.x, -d.z, d.y))
    log(f'  Z-Anatomy liver  ({z_lm.x:+.4f}, {z_lm.y:+.4f}, {z_lm.z:+.4f}) m')
    log(f'  BodyParts3D liver({bp_lm.x:+.4f}, {bp_lm.y:+.4f}, {bp_lm.z:+.4f}) m')
    log(f'  registration offset (scene) ({d.x:+.4f}, {d.y:+.4f}, {d.z:+.4f}) m')
    bpy.data.objects.remove(lm, do_unlink=True)
    appended.pop(Z_LANDMARK, None)

    out = []
    for name, srcs in Z_MUSCLES:
        objs = [appended[n] for n in srcs if appended.get(n) is not None]
        if not objs:
            continue
        for ob in objs:
            # Single-user the mesh FIRST. Z-Anatomy instances one datablock for
            # both sides of a paired muscle (.l and .r have identical vertex
            # counts and differ only by a mirroring object transform), so baking
            # matrix_world for the second side compounds onto data the first
            # already baked — rectus abdominis came out at z = -9 m.
            ob.data = ob.data.copy()
            # Capture the world matrix, then DETACH from any parent before
            # baking. bake_world's `ob.matrix_world = Identity` does not stick
            # on a parented object — Blender recomputes world from the parent,
            # so the parent transform is applied a second time downstream and
            # rectus abdominis landed metres outside the body.
            mw = ob.matrix_world.copy()
            ob.parent = None
            ob.matrix_parent_inverse.identity()
            ob.matrix_basis.identity()
            ob.data.transform(mw)
            # No rotation, no scale: already metres in the pre-export frame.
            ob.data.transform(mathutils.Matrix.Translation((0.0, 0.0, -si_mid)))
            # Register onto the BodyParts3D body.
            ob.data.transform(mathutils.Matrix.Translation(delta))
            ob.data.update()
        # Force the depsgraph to recompute world matrices before joining.
        # object.join() reads evaluated transforms, and parent/basis edits above
        # are not visible until an update — a stale matrix reapplies the very
        # transform that was just baked into the vertices.
        bpy.context.view_layer.update()
        ob = join_objects(objs, name) if len(objs) > 1 else objs[0]
        ob.name = name
        ob.data.name = name
        out.append(ob)
    bpy.context.view_layer.update()
    log(f'appended {len(out)} Z-Anatomy muscles (CC BY-SA 4.0)')
    return out


def decimate_to(ob, budget):
    """Collapse-decimate one mesh down to a triangle budget. No-op if under."""
    tris = sum(len(p.vertices) - 2 for p in ob.data.polygons)
    if tris <= budget:
        return tris
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    mod = ob.modifiers.new(name='dec', type='DECIMATE')
    mod.ratio = budget / tris
    bpy.ops.object.modifier_apply(modifier=mod.name)
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)


def scene_centre(ob):
    """World bbox centre converted to scene (glTF) axes: (b.x, b.z, -b.y)."""
    c = sum((mathutils.Vector(v) for v in ob.bound_box), mathutils.Vector()) / 8
    b = ob.matrix_world @ c
    return mathutils.Vector((b.x, b.z, -b.y))


def anatomical_assertions():
    """
    Laterality and placement checks, asserted against ANATOMY, never node
    names (CONVENTIONS.md). Runs in scene axes, and must hold both before
    export (post-SOURCE_TO_SCAHN) and on the re-imported GLB (full chain
    including the exporter's Y-up conversion and Draco round-trip).
    """
    get = lambda name: scene_centre(bpy.data.objects[name])
    liver, spleen = get('liver'), get('spleen')
    heart, bladder = get('heart-wall-ventricle'), get('bladder')
    adr, adl = get('adrenal-right'), get('adrenal-left')
    for name in ('liver', 'spleen', 'heart-wall-ventricle', 'bladder',
                 'adrenal-right', 'adrenal-left'):
        c = get(name)
        log(f'  centre {name:22} ({c.x:+.4f}, {c.y:+.4f}, {c.z:+.4f}) m')
    checks = [
        ('spleen at greater X than liver (patient left)', spleen.x > liver.x),
        ('heart superior to liver', heart.y > liver.y),
        ('liver superior to bladder', liver.y > bladder.y),
        ('liver anterior to adrenal-right', liver.z > adr.z),
        ('liver anterior to adrenal-left', liver.z > adl.z),
    ]
    for label, ok in checks:
        log(f'  assert {label:48} {"OK" if ok else "FAILED"}')
    if not all(ok for _, ok in checks):
        raise AssertionError('anatomical assertions FAILED — the model is '
                             'mirrored or misplaced; do not ship this GLB')


def main():
    argv = sys.argv[sys.argv.index('--') + 1:]
    src_dir, dst = argv[0], argv[1]

    bpy.ops.wm.read_factory_settings(use_empty=True)

    meshes = []
    for name, fj_ids, merge in ORGANS:
        objs = []
        for fj in fj_ids:
            objs.extend(import_obj(os.path.join(src_dir, f'{fj}.obj')))
        for ob in objs:
            bake_world(ob)
        if len(objs) > 1:
            if not merge:
                log(f'{name}: {len(objs)} objects in one FJ id, joining anyway')
            ob = join_objects(objs, name)
        else:
            ob = objs[0]
            ob.name = name
            ob.data.name = name
        meshes.append(ob)
    log(f'imported {len(meshes)} organ meshes from {len(BONES) + sum(len(f) for _, f, _ in ORGANS)} OBJ files')

    # Bones: repair each element BEFORE joining (skeleton.py's lesson — one
    # bone's imbalance would otherwise send the whole joined mesh past the
    # non-manifold limit and into a detail-destroying whole-skeleton remesh),
    # then join into ONE mesh so capping pays one stencil clear, not 65.
    bones = []
    for fj in BONES:
        bones.extend(import_obj(os.path.join(src_dir, f'{fj}.obj')))
    for ob in bones:
        bake_world(ob)
    for ob in bones:
        repair(ob)
    skeleton = join_objects(bones, 'bone-skeleton')
    o, n, t, _, _ = mesh_stats(skeleton)
    log(f'{"bone-skeleton"[:38]:40} joined {len(bones)} elements: {t} tris, '
        f'open={o} nonMan={n}')
    meshes.append(skeleton)

    # Muscles. Imported and repaired like organs, then decimated to a shared
    # budget in proportion to size, so one huge sheet cannot eat the layer.
    muscles = []
    for name, fj_ids, merge in MUSCLES:
        objs = []
        for fj in fj_ids:
            objs.extend(import_obj(os.path.join(src_dir, f'{fj}.obj')))
        for ob in objs:
            bake_world(ob)
        ob = join_objects(objs, name) if len(objs) > 1 else objs[0]
        ob.name = name
        ob.data.name = name
        muscles.append(ob)
    # Repair BEFORE decimating, not after. Decimating first sends a sheet muscle
    # to a few hundred triangles, and the voxel remesh that repair then chooses
    # rebuilds it at ITS own resolution — iliacus went 600 -> 11,220 and the
    # layer landed at twice its budget. Repairing first means the budget is
    # applied to whatever geometry actually ships.
    raw = {m.name: sum(len(p.vertices) - 2 for p in m.data.polygons) for m in muscles}
    for ob in muscles:
        repair(ob)
    fixed = {m.name: sum(len(p.vertices) - 2 for p in m.data.polygons) for m in muscles}
    total = sum(fixed.values()) or 1
    for ob in muscles:
        share = max(600, int(MUSCLE_TRI_BUDGET * fixed[ob.name] / total))
        after = decimate_to(ob, share)
        log(f'{ob.name[:38]:40} {raw[ob.name]:>7} raw -> {fixed[ob.name]:>6} repaired '
            f'-> {after:>6} tris')
    log(f'muscles: {len(muscles)} meshes, '
        f'{sum(len(p.vertices) - 2 for m in muscles for p in m.data.polygons)} tris total')

    # The skeleton's elements were already repaired above; re-running tier
    # logic on the joined mesh would only risk a whole-skeleton remesh.
    counts = {}
    for ob in sorted(meshes, key=lambda m: -len(m.data.polygons)):
        if ob is skeleton:
            continue
        result = repair(ob)
        counts[result] = counts.get(result, 0) + 1
    log('summary: ' + ', '.join(f'{k}={v}' for k, v in sorted(counts.items())))

    # Derive cavities for the hollow viscera. NEVER on any heart mesh — the
    # chamber meshes are already the cavities, and shrinking a wall inward
    # would seal the valve annuli.
    for name, thickness in HOLLOW.items():
        ob = bpy.data.objects.get(name)
        if ob is None:
            log(f'{name}: not in manifest, no lumen derived')
            continue
        lumen = make_lumen(ob, thickness)
        if lumen:
            log(f'{name[:38]:40} + lumen @{thickness}mm '
                f'({sum(len(p.vertices) - 2 for p in lumen.data.polygons)} tris)')
        else:
            log(f'{name[:38]:40} lumen FAILED (wall too thin or self-intersecting)')

    # The single named source->scene correction, applied ONCE (CONVENTIONS.md
    # section 5). Everything before this line is millimetres in BP3D axes;
    # everything after is metres in the pre-compensated Blender frame.
    all_meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    for ob in all_meshes:
        ob.data.transform(SOURCE_TO_SCAHN)
        ob.data.update()
    # ob.bound_box is a cached evaluated property: without a depsgraph update
    # it still reports the PRE-transform box, and the assertions below read a
    # frame (and unit scale) the data no longer lives in.
    bpy.context.view_layer.update()

    lo = mathutils.Vector((1e18,) * 3)
    hi = mathutils.Vector((-1e18,) * 3)
    for ob in all_meshes:
        for corner in ob.bound_box:
            for i in range(3):
                lo[i] = min(lo[i], corner[i])
                hi[i] = max(hi[i], corner[i])

    # BP3D's origin is at the feet; the scene expects the torso centred on the
    # origin. Recentre the superior-inferior axis only (blender z): the lateral
    # midline is already at x=0 and the shell fit handles the AP offset via
    # zCenter. Baked here, once, as part of the named correction.
    si_mid = (lo.z + hi.z) / 2
    for ob in all_meshes:
        ob.data.transform(mathutils.Matrix.Translation((0.0, 0.0, -si_mid)))
        ob.data.update()
    bpy.context.view_layer.update()
    lo.z -= si_mid
    hi.z -= si_mid
    log(f'extent LR={hi.x - lo.x:.3f} PA={hi.y - lo.y:.3f} SI={hi.z - lo.z:.3f} m '
        f'(pre-export frame, recentred by {-si_mid:+.3f} m SI; torso-only set, '
        f'so SI ~0.6-0.8, not full height)')

    build_skin(src_dir, si_mid)

    # Z-Anatomy muscles: appended after the recentring because they arrive
    # already in the pre-export frame and in metres (see ZANATOMY_BLEND).
    z_muscles = append_zanatomy_muscles(si_mid)
    if z_muscles:
        for ob in z_muscles:
            repair(ob)
        zf = {m.name: sum(len(p.vertices) - 2 for p in m.data.polygons) for m in z_muscles}
        ztotal = sum(zf.values()) or 1
        for ob in z_muscles:
            share = max(800, int(MUSCLE_TRI_BUDGET * zf[ob.name] / ztotal))
            after = decimate_to(ob, share)
            log(f'{ob.name[:38]:40} {zf[ob.name]:>7} repaired -> {after:>6} tris')
        bpy.context.view_layer.update()

        # The frame claim is CHECKED, not trusted: a different basis would put
        # the abdominal wall inside the spine and nothing downstream would say so.
        for nm, _ in Z_MUSCLES:
            c = scene_centre(bpy.data.objects[nm])
            log(f'  centre {nm:28} ({c.x:+.4f}, {c.y:+.4f}, {c.z:+.4f}) m')
        rect = scene_centre(bpy.data.objects['muscle-rectus-abdominis'])
        lat = scene_centre(bpy.data.objects['muscle-latissimus-dorsi'])
        liver = scene_centre(bpy.data.objects['liver'])
        log(f'  centre {"muscle-rectus-abdominis":22} '
            f'({rect.x:+.4f}, {rect.y:+.4f}, {rect.z:+.4f}) m')
        log(f'  centre {"muscle-latissimus-dorsi":22} '
            f'({lat.x:+.4f}, {lat.y:+.4f}, {lat.z:+.4f}) m')
        # CONTAINMENT, not just ordering. The relative-order checks below all
        # passed while the entire Z-Anatomy set sat 10 cm too deep, because an
        # offset applied to every mesh preserves their order. What actually
        # catches a bad registration is asking whether the muscle is inside the
        # body at all.
        skin_ob = bpy.data.objects.get('skin-surface')
        if skin_ob is not None:
            sc = [skin_ob.matrix_world @ mathutils.Vector(c) for c in skin_ob.bound_box]
            s_lo = mathutils.Vector((min(c[i] for c in sc) for i in range(3)))
            s_hi = mathutils.Vector((max(c[i] for c in sc) for i in range(3)))
            for nm, _ in Z_MUSCLES:
                ob = bpy.data.objects[nm]
                mc = [ob.matrix_world @ mathutils.Vector(c) for c in ob.bound_box]
                m_lo = mathutils.Vector((min(c[i] for c in mc) for i in range(3)))
                m_hi = mathutils.Vector((max(c[i] for c in mc) for i in range(3)))
                # AP only (blender y): SI overhang is legitimate for muscles that
                # run past the cropped trunk, but a muscle outside the skin front
                # or back is floating in space.
                inside = (m_lo.y >= s_lo.y - 0.005) and (m_hi.y <= s_hi.y + 0.005)
                log(f'  assert {nm + " inside the skin (AP)":48} '
                    f'{"OK" if inside else "FAILED"}'
                    f'   muscle AP [{m_lo.y:+.3f},{m_hi.y:+.3f}] '
                    f'skin AP [{s_lo.y:+.3f},{s_hi.y:+.3f}]')
                if not inside:
                    raise AssertionError(
                        f'{nm} lies outside the skin surface — the Z-Anatomy '
                        f'registration is wrong; do not ship this GLB')

        zchecks = [
            ('rectus abdominis anterior to latissimus dorsi', rect.z > lat.z),
            ('rectus abdominis anterior to the body axis', rect.z > 0.0),
            ('latissimus dorsi posterior to the body axis', lat.z < liver.z),
            ('rectus abdominis near the midline', abs(rect.x) < 0.05),
            ('rectus abdominis within the trunk, SI', abs(rect.y) < 0.35),
        ]
        for label, ok in zchecks:
            log(f'  assert {label:48} {"OK" if ok else "FAILED"}')
        if not all(ok for _, ok in zchecks):
            raise AssertionError('Z-Anatomy muscles are in an unexpected frame — '
                                 'do not ship this GLB')

    log('anatomical assertions, pre-export:')
    anatomical_assertions()

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

    # Re-import the shipped artifact and re-assert: this is the only check that
    # covers the exporter's Y-up conversion and the Draco round-trip together.
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=dst)
    log('anatomical assertions, re-imported GLB:')
    anatomical_assertions()
    log('verification OK')


if __name__ == '__main__':
    main()
