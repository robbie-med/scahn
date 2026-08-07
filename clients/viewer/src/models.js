/**
 * Anatomy model registry and GLB import.
 *
 * The primitive set loads instantly and is watertight by construction, so it
 * paints first and stays as the reference against which capping bugs are
 * distinguished from geometry bugs. The real anatomy is a single self-consistent
 * BodyParts3D model: one source, so no runtime transforms, per-organ overrides
 * or scene layout are needed to reconcile anything.
 *
 * ## Source orientation (CONVENTIONS.md §5)
 *
 * The source correction is baked into the GLB by the Blender pipeline — there
 * is deliberately NO import transform here. Never add a compensating flip in
 * the renderer: a correction in a second place is how a pipeline ends up
 * mirrored in only some modes.
 *
 * The model was verified against anatomy rather than node names, which is the
 * only check that cannot be fooled by a mislabelled mesh:
 *   - the SPLEEN sits at greater X than the LIVER and GALLBLADDER  -> +X = patient's left
 *   - the HEART sits at greater Y than the LIVER than the BLADDER  -> +Y = superior
 *   - the LIVER sits at greater Z than the ADRENALS (retroperitoneal) -> +Z = anterior
 */

import * as THREE from 'three';

export const MODELS = Object.freeze({
  primitives: {
    id: 'primitives',
    label: 'Primitives',
    note: 'Geometric stand-ins. Watertight, instant, not anatomy.',
    builtin: true,
  },
  'kvh-female-pelvis': {
    id: 'kvh-female-pelvis',
    label: 'Female pelvis',
    note: 'Female pelvic anatomy from the Visible Korean sectioned-image set — '
        + 'uterus, ovaries, vagina and the pelvic floor, none of which the '
        + 'whole-body male model contains.',
    url: 'models/kvh-female-pelvis.glb',
    credit: 'Visible Korean Human (VKH), Ajou University School of Medicine — '
          + 'CC BY-NC 4.0 (non-commercial)',
  },
  bodyparts3d: {
    id: 'bodyparts3d',
    label: 'BodyParts3D',
    note: 'Full-body anatomy from one source, cardiac chambers and valves included.',
    url: 'models/bodyparts3d.glb',
    // The verbatim string the BodyParts3D README asks for, plus the
    // Z-Anatomy share-alike notice the combined model now carries.
    credit: 'BodyParts3D, © The Database Center for Life Science licensed under '
          + 'CC Attribution 4.0 · muscles from Z-Anatomy (CC BY-SA 4.0)',
  },
});

// ---------------------------------------------------------------------------
// name -> appearance
// ---------------------------------------------------------------------------

const LUMEN = 'lumen';
const SOLID = 'solid';

/**
 * Keyword classifier. Source meshes carry names like
 * `Lever_liver_mat_0` and `Organ_Niere rechts_Niere_0`, mixing English, Dutch
 * and German, so matching on substrings is far more robust than an exact table.
 * Order matters: the first hit wins.
 *
 * `grey` is the flat value used by the 2D panel. These are assigned constants,
 * not simulated echogenicity (spec section 0) — but fluid-filled structures go
 * near-black because anechoic blood, bile and urine is the one convention every
 * learner will expect to see.
 */
const CLASSES = [
  // Bone first and matched on an unambiguous prefix the pipeline assigns, so
  // no anatomical keyword can ever steal it. Cortical bone reflects almost the
  // whole beam: the near surface is the brightest thing in any image, and
  // everything deep to it is shadow. The brightness is here; the shadow is a
  // rendering pass (see Panel2D).
  [/^bone-/i, { label: 'Bone', color: 0xe9e3d6, cap: 0xfffdf6, grey: 0.97, kind: SOLID, bone: true }],
  // Hollow viscera: lumen patterns first, and gallbladder before bladder, since
  // "gallbladder" contains "bladder" and would otherwise be swallowed.
  //
  // The wall is echogenic and the cavity anechoic. Rendering the whole organ as
  // fluid — which is what happened while these models shipped a single mesh —
  // puts the bladder two grey levels from the background, so it reads as
  // nothing rendered rather than as a large fluid-filled structure. The asset
  // pipeline now derives the cavity by offsetting the wall inward.
  [/(gallbladder|galblaas|gallenweg).*lumen/i, { label: 'Gallbladder lumen', color: 0x11161c, cap: 0x0a0d11, grey: 0.04, kind: LUMEN }],
  [/(bladder|blaas).*lumen/i, { label: 'Bladder lumen', color: 0x11161c, cap: 0x0a0d11, grey: 0.03, kind: LUMEN }],
  [/gallbladder|galblaas|gallenweg/i, { label: 'Gallbladder wall', color: 0x6f8f3f, cap: 0x9fc45c, grey: 0.60, kind: SOLID }],
  [/bladder|blaas/i, { label: 'Bladder wall', color: 0xb0a24c, cap: 0xe0d179, grey: 0.64, kind: SOLID }],
  // Cardiac chambers are blood pools: anechoic like any vessel lumen. The
  // pipeline names them `chamber-*`, and this must precede the generic heart
  // pattern below or the cavities would render as myocardium.
  // Muscle, matched on the prefix the pipeline assigns so no anatomical
  // keyword can steal it (several muscles are named for the bone they attach
  // to). Skeletal muscle is relatively hypoechoic against fat and fascia, and
  // it is near-field context here rather than a structure being measured.
  [/^muscle-/i, { label: 'Muscle', color: 0x8c4a4a, cap: 0xb86a66, grey: 0.35, kind: SOLID, muscle: true }],
  [/^chamber-/i, { label: 'Cardiac chamber', color: 0x11161c, cap: 0x0a0d11, grey: 0.05, kind: LUMEN }],
  // Valves before heart: they are named `heart-valve-mitral` and would
  // otherwise be swallowed by the heart pattern. Leaflets are markedly
  // echogenic, and on a cardiac view they are the moving landmark a learner
  // is actually looking for.
  [/valve/i, { label: 'Valve', color: 0xd9d2c2, cap: 0xf2ede1, grey: 0.80, kind: SOLID }],
  // Heart before artery and vein. Source meshes bundle the chambers with the
  // great vessels under names like `Heart_arteries`, so a vessel pattern placed
  // first swallows the entire heart and renders it as anechoic blood — the whole
  // cardiac window comes out black while capping is working perfectly.
  [/heart|hart|myocard/i, { label: 'Heart', color: 0x9c3f45, cap: 0xd4737a, grey: 0.56, kind: SOLID }],
  [/lever|liver|leber/i, { label: 'Liver', color: 0x8c5a4a, cap: 0xc98a72, grey: 0.52, kind: SOLID }],
  [/spleen|milt|milz/i, { label: 'Spleen', color: 0x7a4358, cap: 0xb56d87, grey: 0.48, kind: SOLID }],
  [/kidney|nier/i, { label: 'Kidney', color: 0x99604a, cap: 0xd08f70, grey: 0.44, kind: SOLID }],
  [/suprarenal|nebenniere|adrenal/i, { label: 'Adrenal', color: 0xa87a55, cap: 0xd6a878, grey: 0.50, kind: SOLID }],
  [/pancrea|pankreas/i, { label: 'Pancreas', color: 0xb8925a, cap: 0xe3bd82, grey: 0.55, kind: SOLID }],
  [/uterus/i, { label: 'Uterus', color: 0xa8657f, cap: 0xd894ad, grey: 0.53, kind: SOLID }],
  [/ovar/i, { label: 'Ovary', color: 0xb07f95, cap: 0xdda9bd, grey: 0.46, kind: SOLID }],
  // Female pelvic structures. 'urethra' must not be confused with 'ureter' —
  // they differ by one letter and are different organs at different depths.
  //
  // Their greys must also be mutually distinct, which is not cosmetic: on a
  // pelvic view the uterus, an ovary and the vagina are frequently in the same
  // sector, and sharing a grey makes them one indistinguishable blob in exactly
  // the window this model exists to teach. The values follow relative
  // echogenicity — the vaginal stripe reads brighter than myometrium, an ovary
  // slightly darker — and are placed in gaps in the ladder the other organs
  // already occupy.
  [/vagina/i, { label: 'Vagina', color: 0xa8657f, cap: 0xd894ad, grey: 0.62, kind: SOLID }],
  [/urethra/i, { label: 'Urethra', color: 0x9c7f8f, cap: 0xcaa9b8, grey: 0.58, kind: SOLID }],
  [/rectum/i, { label: 'Rectum', color: 0x9c8262, cap: 0xc7ad88, grey: 0.38, kind: SOLID }],
  [/urether|ureter/i, { label: 'Ureter', color: 0x8f9aa8, cap: 0xbcc6d2, grey: 0.45, kind: SOLID }],
  [/aorta|arter|pfortader/i, { label: 'Artery', color: 0xa33a3a, cap: 0xdc5f5f, grey: 0.05, kind: LUMEN }],
  [/vena|vein|vene/i, { label: 'Vein', color: 0x3a5aa3, cap: 0x6f92dc, grey: 0.05, kind: LUMEN }],
  [/intestine|darm|magen|stomach/i, { label: 'Bowel', color: 0xa88b6a, cap: 0xd3b891, grey: 0.42, kind: SOLID }],
  [/trachea|cartilage/i, { label: 'Airway', color: 0xc9c2b4, cap: 0xe6e0d4, grey: 0.72, kind: SOLID }],
];

function classify(name) {
  for (const [re, spec] of CLASSES) if (re.test(name)) return spec;
  return { label: 'Tissue', color: 0x8a8f96, cap: 0xc2c7cd, grey: 0.50, kind: SOLID };
}

const greyHex = (g) => {
  const v = Math.round(g * 255);
  return (v << 16) | (v << 8) | v;
};

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

/**
 * Load a model and return organ descriptors ready for CappedOrgan.
 *
 * Geometry comes back pre-baked into scene space, matching what the primitive
 * builder produces, so the capping code needs no knowledge of where an organ
 * came from.
 */
export async function loadModel(id, { onProgress } = {}) {
  const model = MODELS[id];
  if (!model || model.builtin) throw new Error(`not a loadable model: ${id}`);

  // Loaded on demand: the GLB must not sit in the critical path of a display
  // that is only ever going to show the primitives.
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const { DRACOLoader } = await import('three/examples/jsm/loaders/DRACOLoader.js');

  const loader = new GLTFLoader();
  // The pipeline exports Draco-compressed, and GLTFLoader cannot decode that on
  // its own. The decoder is copied into the build output by
  // scripts/build-site.sh; without it the model fails to load in production
  // while working from a dev tree that happens to have node_modules on disk.
  const draco = new DRACOLoader();
  draco.setDecoderPath('draco/');
  loader.setDRACOLoader(draco);

  const { organs, skinGeometry } = await importGlb(loader, model.url, model.transform, onProgress);

  // Bones are excluded from the shell fit: the skeleton is a whole body and its
  // pelvis and shoulders reach far outside the trunk the probe rides on, so
  // including them would inflate the torso into a barrel.
  const box = new THREE.Box3();
  for (const o of organs) {
    o.geometry.computeBoundingBox();
    if (!o.bone) box.union(o.geometry.boundingBox);
  }
  return { organs, skinGeometry, credit: model.credit ?? '', box };
}

/** Load one GLB and turn its meshes into organ descriptors in scene space. */
async function importGlb(loader, url, transform, onProgress) {
  const gltf = await loader.loadAsync(url, (e) => {
    if (onProgress && e.total) onProgress(e.loaded / e.total);
  });

  const found = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    found.push(o);
  });

  // Stage 1: bake node transforms only, so centroids are still in SOURCE space.
  //
  // Deduplication MUST happen here rather than after the model transform. Some
  // exports ship each mesh twice — one copy positioned anatomically, one left
  // at the source origin — and a recentring transform moves that origin
  // somewhere nowhere near the scene origin. Testing "is it at the origin?"
  // after transforming therefore matches nothing and every organ gets drawn
  // twice, once in a pile.
  const staged = found.map((mesh) => {
    // Content signature from the RAW geometry, before any transform.
    //
    // Not the node name: GLTFLoader makes names unique by appending _1, _2 to
    // collisions, so the two copies of an organ arrive as `Liver` and
    // `Liver_1` and a name-keyed dedupe silently matches nothing. Two copies of
    // the same organ share identical local vertex data, so this catches them —
    // and also catches the pairs whose source names genuinely differ.
    const raw = mesh.geometry;
    raw.computeBoundingBox();
    const bb = raw.boundingBox;
    // 4 decimals, not 2: a hollow organ and its derived lumen differ only by a
    // 1.5-2 mm inward offset, so at centimetre rounding their signatures are
    // IDENTICAL and the dedupe silently discards the wall (gallbladder shipped
    // as lumen-only that way). Genuine duplicate placements have byte-identical
    // vertex data and collide at any precision.
    const sig = [
      raw.attributes.position.count,
      raw.index ? raw.index.count : 0,
      bb.min.toArray().map((n) => n.toFixed(4)).join(','),
      bb.max.toArray().map((n) => n.toFixed(4)).join(','),
    ].join('|');

    const geometry = raw.clone();
    geometry.applyMatrix4(mesh.matrixWorld);
    for (const attr of Object.keys(geometry.attributes)) {
      // Only position and normal survive; the rest is dead weight across the
      // four passes each organ is drawn in.
      if (attr !== 'position' && attr !== 'normal') geometry.deleteAttribute(attr);
    }
    if (!geometry.attributes.normal) geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return { mesh, geometry, sig, srcDist: geometry.boundingSphere.center.length() };
  });

  // Stage 2: per signature, keep the copy furthest from the source origin — the
  // anatomically placed one. Comparing distances rather than thresholding is
  // robust to models whose origin convention differs.
  const best = new Map();
  for (const item of staged) {
    const prev = best.get(item.sig);
    if (!prev || item.srcDist > prev.srcDist) best.set(item.sig, item);
  }

  // A few pairs have their placement baked into the vertices rather than the
  // node transform, so the two copies have different raw geometry and different
  // signatures — the pass above cannot see them as duplicates. What it *can*
  // rely on is that no real organ's centroid sits within a millimetre of the
  // source origin, so any mesh that does is an unpositioned copy. Guarded by
  // `positioned` so a model that legitimately centres its anatomy on the origin
  // is left alone.
  const positioned = staged.some((i) => i.srcDist > 1);
  const kept = [...best.values()].filter((i) => {
    if (positioned && i.srcDist < 1) {
      i.geometry.dispose();
      return false;
    }
    return true;
  });

  for (const item of staged) {
    if (!kept.includes(item)) {
      if (best.get(item.sig) !== item) item.geometry.dispose();
    }
  }

  // Stage 3: apply the source correction, if the registry entry carries one
  // (bodyparts3d does not — the pipeline bakes it), and classify.
  const organs = [];
  let skinGeometry = null;
  for (const { mesh, geometry } of kept) {
    if (transform) geometry.applyMatrix4(transform);
    geometry.computeBoundingSphere();
    // The skin shell is not anatomy: nothing images it and the scan plane
    // never cuts it. It leaves here before classification so it can never
    // reach the capping set, where an open shell would count stencil it
    // cannot balance and bleed a cap across the whole panel.
    if (/^skin-/i.test(mesh.name || '')) {
      skinGeometry = geometry;
      continue;
    }
    const spec = classify(mesh.name || '');
    organs.push({
      name: mesh.name || spec.label,
      label: spec.label,
      kind: spec.kind,
      geometry,
      color: spec.color,
      capColor: spec.cap,
      greyColor: greyHex(spec.grey),
      bone: spec.bone === true,
      muscle: spec.muscle === true,
      // Group node the organ is parented under. Bone is kept apart so the
      // shadow pass can find it; the heart is kept apart from the viscera.
      group: spec.bone === true ? 'bones'
        : spec.muscle === true ? 'muscles'
        : (/^heart-|myocardium|^chamber-/i.test(mesh.name || '') ? 'heart' : 'organs'),
      // Lumens must win the coplanar depth fight against any enclosing wall.
      depthRank: spec.kind === LUMEN ? 2 : 1,
    });
  }

  return { organs, skinGeometry };
}
