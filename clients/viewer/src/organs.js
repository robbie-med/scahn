/**
 * P2/P3 organ set.
 *
 * These are primitive stand-ins. They exist so clipping, capping and the 2D
 * panel can be built and *verified* before the Blender pipeline lands — and
 * because three.js primitives are watertight and manifold by construction,
 * which is exactly the property Z-Anatomy meshes lack (spec section 5). If
 * capping misbehaves against these, the bug is in the capping code, not the
 * geometry. That separation is worth the throwaway coordinates.
 *
 * Positions are anatomically plausible, not anatomically correct. P3 replaces
 * every one of them with a named node from the GLB.
 *
 * Basis: +X patient's left, +Y superior, +Z anterior. Metres.
 */

import * as THREE from 'three';

/** `lumen` parts cap darker and win the coplanar fight against their wall, so
 *  a cut shows a capped wall with an open (anechoic) cavity. */
const WALL = 'wall';
const LUMEN = 'lumen';
const SOLID = 'solid';

/**
 * Note the aorta/IVC pair: the aorta sits slightly to the patient's LEFT of
 * midline (+X) and the IVC slightly to the RIGHT (-X). If those two ever swap
 * sides on screen, the scene is mirrored — a second, independent check on the
 * `L` fiducial.
 */
export const ORGAN_SPECS = Object.freeze([
  // --- upper abdomen ---
  { name: 'liver', kind: SOLID, shape: 'ellipsoid',
    pos: [-0.055, 0.090, 0.015], scale: [0.100, 0.055, 0.070],
    color: 0x8c5a4a, cap: 0xc98a72 },
  { name: 'gallbladder', kind: WALL, shape: 'ellipsoid',
    pos: [-0.045, 0.052, 0.052], scale: [0.014, 0.026, 0.014],
    color: 0x6f8f3f, cap: 0x9fc45c },
  { name: 'gallbladder-lumen', kind: LUMEN, shape: 'ellipsoid',
    pos: [-0.045, 0.052, 0.052], scale: [0.009, 0.020, 0.009],
    color: 0x11161c, cap: 0x0a0d11 },
  { name: 'spleen', kind: SOLID, shape: 'ellipsoid',
    pos: [0.085, 0.098, -0.030], scale: [0.028, 0.040, 0.032],
    color: 0x7a4358, cap: 0xb56d87 },
  { name: 'kidney-right', kind: SOLID, shape: 'ellipsoid',
    pos: [-0.075, 0.030, -0.055], scale: [0.022, 0.045, 0.025],
    color: 0x99604a, cap: 0xd08f70 },
  { name: 'kidney-left', kind: SOLID, shape: 'ellipsoid',
    pos: [0.075, 0.045, -0.055], scale: [0.022, 0.045, 0.025],
    color: 0x99604a, cap: 0xd08f70 },

  // --- great vessels ---
  { name: 'aorta', kind: WALL, shape: 'cylinder',
    pos: [0.012, 0.050, -0.062], scale: [0.011, 0.280, 0.011],
    color: 0xa33a3a, cap: 0xdc5f5f },
  { name: 'aorta-lumen', kind: LUMEN, shape: 'cylinder',
    pos: [0.012, 0.050, -0.062], scale: [0.0078, 0.281, 0.0078],
    color: 0x11161c, cap: 0x0a0d11 },
  { name: 'ivc', kind: WALL, shape: 'cylinder',
    pos: [-0.018, 0.050, -0.055], scale: [0.012, 0.280, 0.012],
    color: 0x3a5aa3, cap: 0x6f92dc },
  { name: 'ivc-lumen', kind: LUMEN, shape: 'cylinder',
    pos: [-0.018, 0.050, -0.055], scale: [0.0090, 0.281, 0.0090],
    color: 0x11161c, cap: 0x0a0d11 },

  // --- heart: myocardium + four chambers as separate lumens ---
  { name: 'myocardium', kind: WALL, shape: 'ellipsoid',
    pos: [0.030, 0.190, 0.030], scale: [0.045, 0.055, 0.040],
    color: 0x9c3f45, cap: 0xd4737a },
  { name: 'chamber-rv', kind: LUMEN, shape: 'ellipsoid',
    pos: [0.012, 0.175, 0.045], scale: [0.018, 0.024, 0.018],
    color: 0x11161c, cap: 0x0a0d11 },
  { name: 'chamber-lv', kind: LUMEN, shape: 'ellipsoid',
    pos: [0.048, 0.170, 0.025], scale: [0.020, 0.030, 0.020],
    color: 0x11161c, cap: 0x0a0d11 },
  { name: 'chamber-ra', kind: LUMEN, shape: 'ellipsoid',
    pos: [0.014, 0.212, 0.020], scale: [0.015, 0.017, 0.015],
    color: 0x11161c, cap: 0x0a0d11 },
  { name: 'chamber-la', kind: LUMEN, shape: 'ellipsoid',
    pos: [0.046, 0.212, 0.010], scale: [0.016, 0.017, 0.015],
    color: 0x11161c, cap: 0x0a0d11 },

  // --- pelvis ---
  { name: 'bladder', kind: WALL, shape: 'ellipsoid',
    pos: [0.0, -0.230, 0.030], scale: [0.034, 0.030, 0.030],
    color: 0xb0a24c, cap: 0xe0d179 },
  { name: 'bladder-lumen', kind: LUMEN, shape: 'ellipsoid',
    pos: [0.0, -0.230, 0.030], scale: [0.028, 0.024, 0.024],
    color: 0x11161c, cap: 0x0a0d11 },
  { name: 'uterus', kind: WALL, shape: 'ellipsoid',
    pos: [0.0, -0.190, -0.005], scale: [0.025, 0.032, 0.022],
    color: 0xa8657f, cap: 0xd894ad },
  { name: 'uterus-cavity', kind: LUMEN, shape: 'ellipsoid',
    pos: [0.0, -0.188, -0.005], scale: [0.008, 0.018, 0.006],
    color: 0x11161c, cap: 0x0a0d11 },
]);

/**
 * Flat grey per organ for the 2D panel.
 *
 * These are *assigned constants*, not simulated echogenicity — v1 explicitly
 * does no acoustics (spec section 0). They exist so the panel reads as a
 * greyscale cross-section instead of a colour-coded diagram. Lumens go near
 * black because fluid is anechoic, which is the one convention a learner will
 * absolutely expect to see.
 */
const GREYS = Object.freeze({
  liver: 0.52,
  gallbladder: 0.62,
  spleen: 0.48,
  'kidney-right': 0.44,
  'kidney-left': 0.44,
  aorta: 0.68,
  ivc: 0.60,
  myocardium: 0.56,
  bladder: 0.64,
  uterus: 0.50,
});
const LUMEN_GREY = 0.03;

function greyFor(spec) {
  const g = spec.kind === LUMEN ? LUMEN_GREY : (GREYS[spec.name] ?? 0.5);
  const v = Math.round(g * 255);
  return (v << 16) | (v << 8) | v;
}

function buildGeometry(spec) {
  let geom;
  if (spec.shape === 'cylinder') {
    // openEnded = false: a closed surface, which is what stencil capping counts.
    geom = new THREE.CylinderGeometry(1, 1, 1, 32, 1, false);
  } else {
    geom = new THREE.SphereGeometry(1, 40, 28);
  }
  geom.scale(spec.scale[0], spec.scale[1], spec.scale[2]);
  geom.translate(spec.pos[0], spec.pos[1], spec.pos[2]);
  geom.computeBoundingSphere();
  return geom;
}

/**
 * @returns {{name:string, kind:string, geometry:THREE.BufferGeometry,
 *            color:number, capColor:number, depthRank:number}[]}
 */
export function buildOrgans() {
  return ORGAN_SPECS.map((spec) => ({
    name: spec.name,
    kind: spec.kind,
    geometry: buildGeometry(spec),
    color: spec.color,
    capColor: spec.cap,
    greyColor: greyFor(spec),
    group: /myocardium|^chamber-/.test(spec.name) ? 'heart' : 'organs',
    // Lumen caps must win the coplanar depth fight against their enclosing
    // wall's cap, otherwise the chamber vanishes into the myocardium.
    depthRank: spec.kind === LUMEN ? 2 : 1,
  }));
}
