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
function mmTransform({ offset, scale = 0.001 }) {
  return new THREE.Matrix4()
    .makeScale(scale, scale, scale)
    .multiply(new THREE.Matrix4().makeTranslation(-offset[0], -offset[1], -offset[2]));
}

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
    transform: mmTransform({ offset: [70.4, 0, 48] }),
    credit: 'Sketchfab — abdomen anatomy',
    // This model's heart is a closed outer shell with no chambers. Swap in one
    // that has genuine interior surfaces so the chambers cap open by themselves
    // rather than being invented.
    overrides: [{
      replaces: /heart/i,
      url: 'models/heart.glb',
      // heart.glb leaves the pipeline already in scene axes and centred on its
      // own bounding box, so this is a pure translation into the thorax.
      // Slightly left of midline and anterior, which is where a heart sits.
      transform: new THREE.Matrix4().makeTranslation(0.012, 0.205, 0.045),
      credit: 'Human Heart (FBX)',
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

  const box = new THREE.Box3();
  for (const o of organs) {
    o.geometry.computeBoundingBox();
    box.union(o.geometry.boundingBox);
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
      // Lumens must win the coplanar depth fight against any enclosing wall.
      depthRank: spec.kind === LUMEN ? 2 : 1,
    });
  }

  return organs;
}
