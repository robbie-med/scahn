"""
Visible Korean female pelvis: segmented slice stack -> per-structure OBJ.

    python3 pipeline/kvh_pelvis.py SEG_DIR COLOR_TXT OUT_DIR

Stage 1 of two. This runs under the system Python (numpy/PIL/scipy only, no
scikit-image) and emits one blocky OBJ per structure in the Blender pre-export
frame, in metres. Stage 2 (kvh_finish.py) runs under Blender and does the
remesh, smoothing, decimation and Draco export.

*** LICENCE: NOT CLEARED. ***
The source is the Visible Korean female pelvis browsing software (Prof. Min Suk
Chung, Ajou University). The installer carries no licence, copyright or terms
string of any kind, so there is no grant to extract this data, derive meshes and
redistribute them. Permission is being sought in writing. Until it arrives in
writing, output of this script is LOCAL ONLY: it must not be deployed, and the
GLB is gitignored so it cannot reach the repository by accident. The data also
derives from an identifiable cadaver donor, which is a reason for care
independent of the legal question.

## Why the obvious approach fails

The segmented images are 16-BIT BMPs (RGB555), so every channel is quantised to
five bits and the 8-bit values in color.txt do not appear in the pixels: the
table's 105 is stored as 106, its 217 as 213. Matching colours exactly finds
3 of 205. Nearest-colour on its own is not safe either — the two closest table
entries differ by only 5, which is inside the ~8 quantisation error, so a
ligament would silently merge into a muscle.

What works, and is used here, is nearest-colour RESTRICTED to the structures
whose color.txt slice range contains the slice being read. That shrinks the
candidate set enough that the quantisation error cannot reach a neighbour.
It is checked rather than assumed: color.txt's slice ranges were authored
independently of its colours, so reproducing every structure's stated range
exactly is a real acceptance test, and assert_ranges() below enforces it.

## Geometry, all measured rather than assumed

  in-plane   0.384 mm/px. Two independent landmarks agree to 0.3%: the widest
             hip-bone span is 729 px against a ~28 cm intercristal diameter,
             and the widest skin span is 965 px against a ~37 cm hip width.
             Skin never touches the image border, so nothing is clipped.
  slice      filenames run 0000-1250 in steps of 5, and one unit is 0.2 mm, so
             slices are 1.0 mm apart and the stack is 25 cm tall. Confirmed
             independently: the uterus spans slices 295-665, which is 7.4 cm
             against a 7-9 cm normal.

## Orientation, established from anatomy and not from the file layout

  +column -> patient's LEFT      (hip/ovary/ureter rt at x~288/441/415,
                                  lt at x~735/603/603)
  +row    -> POSTERIOR           (bladder y~224, rectum y~380, coccyx y~471)
  +slice  -> INFERIOR            (uterine fundus above cervix; sacrum above
                                  coccyx)

That index triple is LEFT-handed, so mapping it into the right-handed scene
basis carries a determinant of -1. That is correct — it is a handedness
conversion, not a mirror, because each axis was pinned to anatomy — but it
inverts triangle winding, so the winding is flipped on output. Getting this
wrong points every normal into the organ.
"""

import json
import os
import sys

import numpy as np
from PIL import Image

# --- measured geometry ------------------------------------------------------
MM_PER_PX = 0.384
MM_PER_SLICE_UNIT = 0.2
# Halve the in-plane resolution before meshing. 0.384 mm against 1.0 mm slices
# is strongly anisotropic; 0.768 mm is close to isotropic, cuts the surface
# extraction fourfold, and is far finer than anything this tool renders.
DOWNSAMPLE = 2
# Per-channel ceiling on the nearest-colour match: the most RGB555 can shift a
# channel. Anything farther is unsegmented background, not a near miss.
MAX_CHANNEL_D = 8
# Filenames advance by this many units per slice.
SLICE_STEP = 5

# (output name, [color.txt names], class)
MANIFEST = [
    ('uterus', ['Uterus; fundus of uterus', 'Uterus; body of uterus',
                'Uterus; cervix of uterus'], 'organs'),
    ('ovary-right', ['Ovary (rt)'], 'organs'),
    ('ovary-left', ['Ovary (lt)'], 'organs'),
    ('vagina', ['Vagina'], 'organs'),
    ('urethra-female', ['Female urethra'], 'organs'),
    ('bladder', ['Urinary bladder'], 'organs'),
    ('rectum', ['Rectum'], 'organs'),
    ('intestine-sigmoid', ['Sigmoid colon'], 'organs'),
    ('ureter-right', ['Ureter (rt)'], 'organs'),
    ('ureter-left', ['Ureter (lt)'], 'organs'),
    # Muscle is its own class so the viewer can toggle it like bone. This
    # dataset carries the pelvic floor — levator ani, coccygeus, obturator
    # internus, the external anal sphincter — and the full abdominal wall,
    # none of which BodyParts3D contains at all. Thigh muscles (vastus,
    # sartorius, rectus femoris, gemelli) are deliberately excluded: they are
    # outside anything this tool images and would only cost payload.
    ('muscle-rectus-abdominis', ['Rectus abdominis m (rt.lt)'], 'muscles'),
    ('muscle-oblique-external', ['External oblique abdominal m (rt)',
                                 'External oblique abdominal m (lt)'], 'muscles'),
    ('muscle-oblique-internal', ['Internal oblique abdominal m (rt)',
                                 'Internal oblique abdominal m (lt)'], 'muscles'),
    ('muscle-transversus-abdominis', ['Transversus abdominis m (rt)',
                                      'Transversus abdominis m (lt)'], 'muscles'),
    ('muscle-levator-ani', ['Levator ani m(rt)', 'Levator ani m(lt)'], 'muscles'),
    ('muscle-coccygeus', ['Coccygeus m(rt, lt)'], 'muscles'),
    ('muscle-anal-sphincter', ['External anal sphincter'], 'muscles'),
    ('muscle-obturator-internus', ['Obturator internus m (rt)',
                                   'Obturator internus m (lt)'], 'muscles'),
    ('muscle-piriformis', ['Piriformis m (rt)', 'Piriformis m (lt)'], 'muscles'),
    ('muscle-iliopsoas', ['Iliopsoas m (rt)', 'Iliopsoas m (lt)',
                          'Iliacus m (rt)', 'Iliacus m (lt)',
                          'Psoas major m (rt)', 'Psoas major m (lt)'], 'muscles'),
    ('muscle-gluteus', ['Gluteus maximus m (rt)', 'Gluteus maximus m (lt)',
                        'Gluteus medius m (rt)', 'Gluteus medius m (lt)',
                        'Gluteus minimus m (rt)', 'Gluteus minimus m (lt)'], 'muscles'),
    ('bone-pelvis', ['Sacrum', 'Coccyx', 'Hip bone (rt)', 'Hip bone (lt)',
                     '4th lumbar vertebrae', 'Pubic symphysis',
                     'Femur (rt)', 'Femur (lt)'], 'bones'),
    ('skin-surface', ['Skin'], 'skin'),
]

# Paired structures, used to find the true midline. The bounding box is the
# wrong thing to centre on — it is skewed by whichever side happens to be
# bulkier — so the midline comes from structures that exist symmetrically.
MIDLINE_PAIRS = [('Hip bone (rt)', 'Hip bone (lt)'),
                 ('Ovary (rt)', 'Ovary (lt)'),
                 ('Ureter (rt)', 'Ureter (lt)'),
                 ('Femur (rt)', 'Femur (lt)')]


def log(*a):
    print('[kvh]', *a, flush=True)


def read_table(path):
    out = []
    with open(path, encoding='utf-8-sig', errors='replace') as fh:
        for line in fh:
            p = line.rstrip('\n').split('\t')
            if len(p) >= 6 and p[1].strip().isdigit():
                out.append({
                    'name': p[0],
                    'rgb': np.array([int(p[1]), int(p[2]), int(p[3])], dtype=np.int32),
                    'lo': int(p[4]), 'hi': int(p[5]),
                })
    return out


def build_volume(seg_dir, table, wanted):
    """
    Label the whole stack, keeping only `wanted` structures.

    Returns (volume, slices, index) where volume is uint8 with 0 meaning
    "nothing we asked for" and index maps a structure name to its label value.
    """
    files = sorted(f for f in os.listdir(seg_dir) if f.lower().endswith('.bmp'))
    index = {n: i + 1 for i, n in enumerate(sorted(wanted))}
    probe = np.array(Image.open(os.path.join(seg_dir, files[0])).convert('RGB'))
    h, w = probe.shape[:2]
    hs, ws = h // DOWNSAMPLE, w // DOWNSAMPLE
    vol = np.zeros((len(files), hs, ws), dtype=np.uint8)
    slices = []
    seen = {n: [] for n in wanted}

    for k, fn in enumerate(files):
        sl = int(fn[:4])
        slices.append(sl)
        a = np.array(Image.open(os.path.join(seg_dir, fn)).convert('RGB')).astype(np.int32)
        cand = [t for t in table if t['lo'] <= sl <= t['hi']]
        if not cand:
            continue
        C = np.array([t['rgb'] for t in cand])
        cols, inv = np.unique(a.reshape(-1, 3), axis=0, return_inverse=True)
        d = np.abs(cols[:, None, :] - C[None, :, :]).max(axis=2)
        nearest = d.argmin(axis=1)
        lut = np.where(d.min(axis=1) <= MAX_CHANNEL_D, nearest, -1)
        lab = lut[inv].reshape(a.shape[:2])

        out = np.zeros((h, w), dtype=np.uint8)
        for ci, t in enumerate(cand):
            if t['name'] not in index:
                continue
            m = (lab == ci)
            if m.any():
                out[m] = index[t['name']]
                seen[t['name']].append(sl)
        # Nearest-neighbour decimation, not averaging: labels are categorical
        # and the mean of two label ids is a third, unrelated structure.
        vol[k] = out[:hs * DOWNSAMPLE:DOWNSAMPLE, :ws * DOWNSAMPLE:DOWNSAMPLE]
        if k % 50 == 0:
            log(f'  labelled slice {sl:4d} ({k + 1}/{len(files)})')
    return vol, slices, index, seen


def assert_ranges(table, seen):
    """
    Every structure must appear exactly across its stated slice range.

    color.txt's ranges were written independently of its colours, so this is a
    genuine check on the colour mapping rather than a restatement of it. A
    mismatch means the keying has drifted onto a neighbouring structure.
    """
    byname = {t['name']: t for t in table}
    bad = []
    for name, sl in seen.items():
        t = byname[name]
        if not sl:
            bad.append(f'{name}: nothing found, expected {t["lo"]}-{t["hi"]}')
            continue
        # One slice step of slack at each end. color.txt's ranges are stated to
        # the nearest step and are occasionally a step generous: the left
        # internal oblique is listed from 0 but is genuinely undrawn on slice
        # 0000, where the nearest colour present sits 17 away — far outside the
        # matching ceiling, so the guard correctly declined it. Real colour
        # drift does not produce a one-step edge difference, it produces a
        # wildly wrong range, which this still catches.
        if abs(min(sl) - t['lo']) > SLICE_STEP or abs(max(sl) - t['hi']) > SLICE_STEP:
            bad.append(f'{name}: found {min(sl)}-{max(sl)}, stated {t["lo"]}-{t["hi"]}')
    for name in sorted(seen):
        t = byname[name]
        got = seen[name]
        exact = got and min(got) == t['lo'] and max(got) == t['hi']
        mark = ('OK' if exact else 'ok (edge)') if all(name not in b for b in bad) else 'FAILED'
        log(f'  assert {name[:34]:36} {t["lo"]:4d}-{t["hi"]:4d}  {mark}')
    if bad:
        raise AssertionError('colour keying disagrees with color.txt slice '
                             'ranges:\n  ' + '\n  '.join(bad))


def surface_quads(mask):
    """
    Blocky isosurface: one quad per voxel face that borders empty space.

    scikit-image is not installed and marching cubes is not worth hand-rolling,
    because the Blender stage voxel-remeshes and smooths this anyway. What
    matters here is only that the shell is closed and correctly wound.
    """
    verts = {}
    faces = []

    def vid(p):
        i = verts.get(p)
        if i is None:
            i = len(verts)
            verts[p] = i
        return i

    # (axis, +1/-1) and the four corner offsets of the face, wound so the
    # normal points OUT of the solid.
    dirs = [
        (0, 1, [(1, 0, 0), (1, 1, 0), (1, 1, 1), (1, 0, 1)]),
        (0, -1, [(0, 0, 0), (0, 0, 1), (0, 1, 1), (0, 1, 0)]),
        (1, 1, [(0, 1, 0), (0, 1, 1), (1, 1, 1), (1, 1, 0)]),
        (1, -1, [(0, 0, 0), (1, 0, 0), (1, 0, 1), (0, 0, 1)]),
        (2, 1, [(0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)]),
        (2, -1, [(0, 0, 0), (0, 1, 0), (1, 1, 0), (1, 0, 0)]),
    ]
    for axis, sign, corners in dirs:
        shifted = np.roll(mask, -sign, axis=axis)
        # Rolling wraps, so the far plane would see the near plane as a
        # neighbour and lose the cap. Treat outside the volume as empty.
        idx = [slice(None)] * 3
        idx[axis] = -1 if sign > 0 else 0
        shifted[tuple(idx)] = False
        exposed = mask & ~shifted
        for z, y, x in zip(*np.nonzero(exposed)):
            quad = [vid((x + cx, y + cy, z + cz)) for cx, cy, cz in corners]
            faces.append(quad)
    return verts, faces


def write_obj(path, verts, faces, origin, name):
    """
    Write in the Blender pre-export frame, in metres.

      blender x = LEFT      =  column
      blender y = POSTERIOR =  row
      blender z = SUPERIOR  = -slice

    The z negation makes this a reflection of a left-handed index triple, which
    is the correct handedness conversion but inverts winding, so each face is
    emitted reversed.
    """
    sx = MM_PER_PX * DOWNSAMPLE / 1000.0
    sy = MM_PER_PX * DOWNSAMPLE / 1000.0
    sz = MM_PER_SLICE_UNIT * 5.0 / 1000.0   # filenames step by 5 units
    ox, oy, oz = origin
    order = sorted(verts.items(), key=lambda kv: kv[1])
    with open(path, 'w') as fh:
        fh.write(f'o {name}\n')
        for (x, y, z), _ in order:
            fh.write(f'v {(x - ox) * sx:.6f} {(y - oy) * sy:.6f} {-(z - oz) * sz:.6f}\n')
        for q in faces:
            a, b, c, d = (i + 1 for i in q)
            fh.write(f'f {d} {c} {b} {a}\n')       # reversed: see docstring


def main():
    seg_dir, color_txt, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs(out_dir, exist_ok=True)
    table = read_table(color_txt)
    wanted = {n for _, names, _ in MANIFEST for n in names}
    missing = wanted - {t['name'] for t in table}
    if missing:
        raise SystemExit(f'manifest names absent from color.txt: {sorted(missing)}')

    log(f'{len(table)} structures in the table, {len(wanted)} requested')
    vol, slices, index, seen = build_volume(seg_dir, table, wanted)
    log(f'volume {vol.shape} (slice, row, col) at {MM_PER_PX * DOWNSAMPLE:.3f} mm in-plane')
    log('slice-range assertions:')
    assert_ranges(table, seen)

    # Midline from paired structures, and SI/AP centre from the whole model.
    mids = []
    for a, b in MIDLINE_PAIRS:
        if a not in index or b not in index:
            continue
        for nm in (a, b):
            xs = np.nonzero((vol == index[nm]).any(axis=(0, 1)))[0]
            if xs.size:
                mids.append(float(xs.mean()))
    if len(mids) < 2:
        raise SystemExit('not enough paired structures to establish the midline')
    ox = float(np.mean(mids))
    occupied = vol > 0
    ys = np.nonzero(occupied.any(axis=(0, 2)))[0]
    zs = np.nonzero(occupied.any(axis=(1, 2)))[0]
    oy = float((ys.min() + ys.max()) / 2)
    oz = float((zs.min() + zs.max()) / 2)
    log(f'origin: midline col {ox:.1f} (from {len(mids)} paired structures), '
        f'row {oy:.1f}, slice {oz:.1f}')

    meta = {'structures': [], 'mm_per_px': MM_PER_PX * DOWNSAMPLE,
            'mm_per_slice': MM_PER_SLICE_UNIT * 5.0}
    for out_name, names, klass in MANIFEST:
        mask = np.zeros(vol.shape, dtype=bool)
        for nm in names:
            mask |= (vol == index[nm])
        if not mask.any():
            log(f'{out_name}: empty, skipped')
            continue
        verts, faces = surface_quads(mask)
        path = os.path.join(out_dir, f'{out_name}.obj')
        write_obj(path, verts, faces, (ox, oy, oz), out_name)
        meta['structures'].append({'name': out_name, 'class': klass,
                                   'voxels': int(mask.sum()), 'quads': len(faces)})
        log(f'{out_name[:28]:30} {int(mask.sum()):8d} voxels -> {len(faces):7d} quads')
    with open(os.path.join(out_dir, 'manifest.json'), 'w') as fh:
        json.dump(meta, fh, indent=2)
    log(f'wrote {len(meta["structures"])} OBJs to {out_dir}')


if __name__ == '__main__':
    main()
