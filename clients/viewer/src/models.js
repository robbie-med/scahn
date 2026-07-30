/**
 * Anatomy model registry and GLB import.
 *
 * The primitive set stays as the default: it loads instantly, it is watertight
 * by construction, and it is the reference against which capping bugs are
 * distinguished from geometry bugs. Real anatomy is opt-in and lazily fetched.
 *
 * ## Source orientation (CONVENTIONS.md §5)
 *
 * The correction is a SINGLE named transform per model, applied once here at
 * import. Never add a compensating flip in the renderer — a second correction
 * in a second place is how a pipeline ends up mirrored in only some modes.
 *
 * Both bundled models were verified against anatomy rather than node names,
 * which is the only check that cannot be fooled by a mislabelled mesh:
 *   - the SPLEEN sits at greater X than the LIVER and GALLBLADDER  -> +X = patient's left
 *   - the HEART sits at greater Y than the LIVER than the BLADDER  -> +Y = superior
 *   - the LIVER sits at greater Z than the ADRENALS (retroperitoneal) -> +Z = anterior
 *
 * Both therefore already match the scene basis, and need only a scale from
 * millimetres and a recentre. If a future model fails those three tests, it
 * needs a rotation in its `transform` here — nowhere else.
 */

import * as THREE from 'three';

/**
 * Millimetres to metres, plus a recentre.
 *
 * `offset` is applied in SOURCE units before scaling. The X value is the
 * model's own midline, measured from paired structures (kidneys, adrenals,
 * ovaries) and cross-checked against midline organs (uterus, bladder) — not
 * from the bounding box, which is skewed by asymmetric organs like the liver.
 */
function mmTransform({ offset, scale = 0.001, aspect = [1, 1, 1] }) {
  return new THREE.Matrix4()
    .makeScale(scale * aspect[0], scale * aspect[1], scale * aspect[2])
    .multiply(new THREE.Matrix4().makeTranslation(-offset[0], -offset[1], -offset[2]));
}

/**
 * Aspect correction for the abdomen model.
 *
 * Measured against adult reference dimensions, this model is not uniformly
 * scaled — it is stretched along one axis:
 *
 *              lateral   superior-inferior   anterior-posterior
 *   kidney      1.16x          0.91x               1.94x
 *   liver       1.17x          1.03x               1.79x
 *
 * Superior-inferior is right, so the vertical landmarks the window presets were
 * tuned against are sound. But at ~1.8x too deep the liver measures 19.8 cm
 * anterior-posterior against a 10-12 cm reference, which is why it burst out
 * the front of the ribcage, why the auto-fitted torso came out 26 cm deep, and
 * why every organ read as oversized.
 *
 * Correcting the source is the right move rather than inflating the skeleton to
 * accommodate it: the skeleton is anatomically consistent and life-size, and
 * scaling it up to enclose a distorted liver would need a 2 m frame and would
 * pull every vertebral level out of alignment.
 */
const ABDOMEN_ASPECT = [0.86, 1.0, 0.54];

/**
 * Seat the detailed heart in the thorax.
 *
 * Three corrections, in order applied to the mesh (scale, then rotate, then
 * translate):
 *
 * 1. SCALE. Measured against the liver the heart was 11% undersized — a
 *    heart:liver superior-inferior ratio of 0.77 against a reference 0.86.
 *
 * 2. ROTATE. The pipeline centres the heart on its own bounding box with the
 *    long axis vertical, so the apex pointed straight down and very slightly
 *    POSTERIOR: measured axis (+2.4, -4.5, -0.8) cm. A real cardiac axis runs
 *    obliquely from a base that is posterior-superior-right to an apex that is
 *    antero-inferior-LEFT. Rotating about the patient's left axis swings the
 *    apex forward; a further rotation about the anterior axis adds leftward
 *    tilt.
 *
 * 3. TRANSLATE. The heart sits immediately behind the sternum, left of midline.
 *
 * The registration target is the great vessels: the abdomen model's descending
 * thoracic aorta runs at a steady (x = +0.6, z = -1.2 cm) through the whole
 * thorax, and the heart's own vessel stubs have to be continuous with it rather
 * than floating in front of it.
 */
const DEG = Math.PI / 180;

function heartTransform({ scale, rotX, rotZ, pos }) {
  return new THREE.Matrix4()
    .makeTranslation(pos[0], pos[1], pos[2])
    .multiply(new THREE.Matrix4().makeRotationZ(rotZ * DEG))
    .multiply(new THREE.Matrix4().makeRotationX(rotX * DEG))
    .multiply(new THREE.Matrix4().makeScale(scale, scale, scale));
}

const HEART_SEAT = heartTransform({
  scale: 1.22,
  rotX: -40,   // apex forward
  rotZ: 15,    // apex further to the patient's left
  pos: [0.020, 0.205, 0.040],
});



/**
 * Scene layout — how the three anatomy groups sit relative to one another.
 *
 * Set in the browser with the ?edit=1 scene editor by someone who scans, and
 * pasted here verbatim. These are GROUP transforms applied on top of each
 * model's own import transform, deliberately kept as data rather than folded
 * into the geometry: the editor's output maps onto this one-for-one, so the
 * arrangement can be re-tuned without touching the pipeline, and the rotation
 * order cannot silently drift between editing and shipping.
 *
 * Applied only to imported models. The primitive set was authored against the
 * default capsule and is left at identity.
 *
 * Measured world sizes at these values, cm (L/R x sup/inf x ant/post):
 *   organs  24.8 x 69.9 x 17.4   centre -1.1,  8.0, 1.6
 *   heart   14.8 x 19.4 x 18.2   centre  1.7, 25.8, 3.1
 *   bones   35.2 x 75.4 x 24.0   centre -0.9, 12.1, 1.7
 */
export const SCENE_LAYOUT = Object.freeze({
  organs: {
    position: [0.0000, 0.0000, 0.0000],
    rotationDeg: [0.00, 0.00, 0.00],
    // Anterior-posterior only. This multiplies ABDOMEN_ASPECT's 0.54, giving an
    // effective 0.75 of source depth — my 0.54 compressed it too far.
    scale: [1.0000, 1.0000, 1.3900],
  },
  heart: {
    position: [0.0060, 0.0650, -0.0980],
    rotationDeg: [23.50, 14.00, 6.50],
    scale: 1.1100,
  },
  bones: {
    position: [-0.0090, 0.0000, 0.0190],
    rotationDeg: [0.00, 0.00, 0.00],
    scale: [1.0150, 1.0000, 1.0450],
  },
});

/** Identity, for the primitive set. */
export const IDENTITY_LAYOUT = Object.freeze({
  organs: { position: [0, 0, 0], rotationDeg: [0, 0, 0], scale: 1 },
  heart: { position: [0, 0, 0], rotationDeg: [0, 0, 0], scale: 1 },
  bones: { position: [0, 0, 0], rotationDeg: [0, 0, 0], scale: 1 },
});

/** Meshes that are scene furniture or instruments, not anatomy. */
const DROP_PATTERNS = [
  /label/i,
  /endosonographieger/i, // the EUS scope body
  /duodenoskopp/i, // the scope shaft
  /schallkeule/i, // that model's own ultrasound beam cone
];

export const MODELS = Object.freeze({
  primitives: {
    id: 'primitives',
    label: 'Primitives',
    note: 'Geometric stand-ins. Watertight, instant, not anatomy.',
    builtin: true,
  },
  abdomen: {
    id: 'abdomen',
    label: 'Abdomen',
    note: 'Full abdominal/pelvic organ set. Core organs cap cleanly.',
    url: 'models/abdomen.glb',
    // Midline X = 70.4 (mean of kidney, adrenal and ovary midpoints, and of the
    // uterus and bladder centroids). Y needs no shift: the source origin already
    // sits near the torso centre. Z = -48 centres the organ mass in the shell.
    transform: mmTransform({ offset: [70.4, 0, 48], aspect: ABDOMEN_ASPECT }),
    credit: 'Sketchfab — abdomen anatomy',
    // This model's heart is a closed outer shell with no chambers. Swap in one
    // that has genuine interior surfaces so the chambers cap open by themselves
    // rather than being invented.
    overrides: [{
      replaces: /heart/i,
      url: 'models/heart.glb',
      transform: HEART_SEAT,
      credit: 'Human Heart (FBX)',
    }],
  },
  abdomenSkeleton: {
    id: 'abdomenSkeleton',
    label: 'Abdomen + Skeleton',
    note: 'Adds spine, ribs and sternum. Bone is hyperechoic and shadows.',
    url: 'models/abdomen.glb',
    transform: mmTransform({ offset: [70.4, 0, 48], aspect: ABDOMEN_ASPECT }),
    credit: 'Sketchfab — abdomen anatomy',
    overrides: [{
      replaces: /heart/i,
      url: 'models/heart.glb',
      transform: HEART_SEAT,
      credit: 'Human Heart (FBX)',
    }],
    // Added alongside rather than replacing anything.
    //
    // The Y offset aligns vertebral levels to the organs already in the scene,
    // not the bounding boxes: T8 sits at the heart's centre, T12 at the liver
    // dome and adrenals, L1 at the renal hilum. Averaging those three gives
    // -1.0546, and it places T8 at y=0.208 against a heart centre of 0.205 and
    // L1 at 0.055 against kidneys at 0.058-0.071.
    //
    // The pelvis lands high — the sacrum sits ~12 cm above the bladder rather
    // than level with it — because the organ model and the skeleton come from
    // different sources with different proportions. Thoracic alignment is what
    // rib shadowing depends on, so that is what this optimises for.
    additions: [{
      url: 'models/skeleton.glb',
      transform: new THREE.Matrix4().makeTranslation(0, -1.0546, 0),
      credit: 'Overview Skeleton',
    }],
  },
  eusLiver: {
    id: 'eusLiver',
    label: 'Liver / EUS',
    note: 'Liver, pancreas and biliary detail. Heavy (~578k tris).',
    url: 'models/eus-liver.glb',
    // Same basis, but this model sits far up its own +Y axis and is scaled
    // differently. Offsets derived from the same landmark organs.
    transform: mmTransform({ offset: [24, 482, -20] }),
    credit: 'Sketchfab — Endosonographie: Darstellung der Leber',
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
  [/uterus/i, { label: 'Uterus', color: 0xa8657f, cap: 0xd894ad, grey: 0.50, kind: SOLID }],
  [/ovar/i, { label: 'Ovary', color: 0xb07f95, cap: 0xdda9bd, grey: 0.50, kind: SOLID }],
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

  // Loaded on demand: the GLBs are 10-15 MB and must not sit in the critical
  // path of a display that is only ever going to show the primitives.
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const { DRACOLoader } = await import('three/examples/jsm/loaders/DRACOLoader.js');

  const loader = new GLTFLoader();
  // The pipeline exports Draco-compressed (10 MB -> 849 kB), and GLTFLoader
  // cannot decode that on its own. The decoder is copied into the build output
  // by scripts/build-site.sh; without it the model fails to load in production
  // while working from a dev tree that happens to have node_modules on disk.
  const draco = new DRACOLoader();
  draco.setDecoderPath('draco/');
  loader.setDRACOLoader(draco);

  const organs = await importGlb(loader, model.url, model.transform, onProgress);

  // Per-organ overrides: drop the matching meshes and splice in a better model
  // of the same structure. Used for the heart, whose bundled mesh is a solid
  // shell with no chambers.
  const credits = [model.credit];
  for (const ov of model.overrides ?? []) {
    let replaced = 0;
    for (let i = organs.length - 1; i >= 0; i--) {
      if (ov.replaces.test(organs[i].name)) {
        organs[i].geometry.dispose();
        organs.splice(i, 1);
        replaced++;
      }
    }
    const extra = await importGlb(loader, ov.url, ov.transform, null);
    organs.push(...extra);
    if (ov.credit) credits.push(ov.credit);
    console.info(`[scahn] override ${ov.url}: replaced ${replaced}, added ${extra.length}`);
  }

  for (const add of model.additions ?? []) {
    const extra = await importGlb(loader, add.url, add.transform, null);
    organs.push(...extra);
    if (add.credit) credits.push(add.credit);
    console.info(`[scahn] addition ${add.url}: +${extra.length} meshes`);
  }

  // Bones are excluded from the shell fit: the skeleton is a whole body and its
  // pelvis and shoulders reach far outside the trunk the probe rides on, so
  // including them would inflate the torso into a barrel.
  const box = new THREE.Box3();
  for (const o of organs) {
    o.geometry.computeBoundingBox();
    if (!o.bone) box.union(o.geometry.boundingBox);
  }
  return { organs, credit: credits.filter(Boolean).join(' + '), box };
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
    const name = o.name || 'mesh';
    if (DROP_PATTERNS.some((re) => re.test(name))) return;
    found.push(o);
  });

  // Stage 1: bake node transforms only, so centroids are still in SOURCE space.
  //
  // Deduplication MUST happen here rather than after the model transform. These
  // exports ship each mesh twice — one copy positioned anatomically, one left
  // at the source origin — and the recentring transform moves that origin to
  // (-offset * scale), which is nowhere near the scene origin. Testing
  // "is it at the origin?" after transforming therefore matches nothing and
  // every organ gets drawn twice, once in a pile.
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
    const sig = [
      raw.attributes.position.count,
      raw.index ? raw.index.count : 0,
      bb.min.toArray().map((n) => n.toFixed(2)).join(','),
      bb.max.toArray().map((n) => n.toFixed(2)).join(','),
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

  // Stage 3: apply the single named source correction and classify.
  const organs = [];
  for (const { mesh, geometry } of kept) {
    if (transform) geometry.applyMatrix4(transform);
    geometry.computeBoundingSphere();
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
      // Editable group. The scene editor moves these three independently, and
      // the values it produces are what get baked into the registry.
      group: spec.bone === true ? 'bones'
        : (/^heart-|myocardium|^chamber-/i.test(mesh.name || '') ? 'heart' : 'organs'),
      // Lumens must win the coplanar depth fight against any enclosing wall.
      depthRank: spec.kind === LUMEN ? 2 : 1,
    });
  }

  return organs;
}
