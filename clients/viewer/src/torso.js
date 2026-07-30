/**
 * Torso shell and the surface frame the probe rides on. Spec section 8.
 *
 * P2 stand-in: an elliptical cylinder. Chosen over a capsule because its surface
 * frame is exact and analytic, so probe placement has no raycast error to debug
 * while the orientation pipeline is still being trusted for the first time.
 *
 * P3 replaces the mesh with the skin GLB. When it does, `surfaceFrame()` becomes
 * a raycast against that mesh — everything downstream consumes the returned
 * frame, not the parameterisation, so only this file changes.
 */

import * as THREE from 'three';

/**
 * The skin shell the probe rides on.
 *
 * Mutable, because it is fitted to whichever anatomy is loaded. The imported
 * models are life-size and the capsule was a guess, so when they disagree the
 * capsule is what's wrong — forcing real organs into a placeholder shell is how
 * the probe ends up buried inside the liver.
 *
 * `zCenter` exists because a torso is not centred on its organs: the shell has
 * to sit slightly anterior of the anatomical mid-plane to enclose the liver and
 * bowel without the back of the shell floating away from the spine.
 */
export const TORSO = {
  rx: 0.17, // half-width, left-right
  rz: 0.115, // half-depth, anterior-posterior
  height: 0.6, // superior-inferior extent
  zCenter: 0, // AP offset of the shell axis
  yCenter: 0, // superior-inferior offset of the shell centre
};

/** Defaults, restored when the primitive organ set is active. */
export const TORSO_DEFAULTS = Object.freeze({ ...TORSO });

/** Soft-tissue allowance between the outermost organ and the skin. */
const SKIN_MARGIN = 0.014;

/**
 * Fit the shell around an anatomy bounding box.
 *
 * X is sized from the larger half-extent rather than recentred: the midline was
 * established from paired organs and must stay at x = 0, and a torso really is
 * asymmetric about it because the liver is bulkier than what faces it.
 * Z is both sized and recentred, since the model's AP origin is arbitrary.
 *
 * Clamped to plausible adult dimensions so a stray mesh cannot produce an
 * absurd torso.
 */
export function fitTorsoTo(box) {
  const halfX = Math.max(Math.abs(box.min.x), Math.abs(box.max.x));
  const zc = (box.min.z + box.max.z) / 2;
  const halfZ = (box.max.z - box.min.z) / 2;
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  return {
    rx: clamp(halfX + SKIN_MARGIN, 0.12, 0.26),
    rz: clamp(halfZ + SKIN_MARGIN, 0.09, 0.22),
    height: TORSO_DEFAULTS.height,
    zCenter: clamp(zc, -0.08, 0.08),
    yCenter: TORSO_DEFAULTS.yCenter,
  };
}

/** Apply new shell dimensions and rebuild the skin mesh in place. */
export function setTorso(dims, mesh) {
  Object.assign(TORSO, dims);
  if (mesh) {
    mesh.geometry.dispose();
    mesh.geometry = buildTorsoGeometry();
  }
}

const WORLD_SUPERIOR = new THREE.Vector3(0, 1, 0);

/**
 * Circumference of the torso's elliptical cross-section (Ramanujan's
 * approximation). Physical translation converts metres of lateral phone travel
 * into a fraction of a lap around the body, so this is what makes a 10 cm hand
 * movement produce roughly 10 cm of probe travel on the skin.
 */
export function torsoCircumference() {
  const { rx: a, rz: b } = TORSO;
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
}

/**
 * Surface point and orthonormal frame at parameter (u, v).
 *
 *   u: 0..1 around the circumference, measured from the ANTERIOR midline (+Z)
 *      rotating toward the patient's LEFT (+X). u=0.25 is the left flank,
 *      u=0.75 the right flank.
 *   v: 0..1 inferior -> superior.
 *
 * Frame (matches CONVENTIONS.md §4):
 *   Y = outward surface normal  (so the beam axis, local -Y, points inward)
 *   Z = superior, projected into the tangent plane
 *   X = Y x Z  (right-handed; at the anterior midline this is the patient's
 *       right, which is where a transducer's orientation marker conventionally
 *       points for a transverse abdominal scan)
 */
export function surfaceFrame(u, v, out = {}) {
  const theta = u * Math.PI * 2;
  const s = Math.sin(theta);
  const c = Math.cos(theta);

  const position = (out.position ??= new THREE.Vector3());
  position.set(
    TORSO.rx * s,
    (v - 0.5) * TORSO.height + TORSO.yCenter,
    TORSO.rz * c + TORSO.zCenter,
  );

  // Outward normal of an ellipse is (sin/rx, 0, cos/rz), not the radial vector.
  const yAxis = (out.yAxis ??= new THREE.Vector3());
  yAxis.set(s / TORSO.rx, 0, c / TORSO.rz).normalize();

  const zAxis = (out.zAxis ??= new THREE.Vector3());
  zAxis.copy(WORLD_SUPERIOR).addScaledVector(yAxis, -WORLD_SUPERIOR.dot(yAxis)).normalize();

  const xAxis = (out.xAxis ??= new THREE.Vector3());
  xAxis.crossVectors(yAxis, zAxis).normalize();

  const quaternion = (out.quaternion ??= new THREE.Quaternion());
  const m = (out.matrix ??= new THREE.Matrix4());
  m.makeBasis(xAxis, yAxis, zAxis);
  quaternion.setFromRotationMatrix(m);

  return out;
}

function buildTorsoGeometry() {
  const geom = new THREE.CylinderGeometry(1, 1, TORSO.height, 96, 1, true);
  geom.scale(TORSO.rx, 1, TORSO.rz);
  geom.translate(0, TORSO.yCenter, TORSO.zCenter);
  return geom;
}

/** Translucent skin shell. Open-ended so the interior is visible in Mode 1. */
export function createTorsoMesh() {
  const geom = buildTorsoGeometry();

  const mat = new THREE.MeshStandardMaterial({
    color: 0xd9b49a,
    transparent: true,
    opacity: 0.16,
    roughness: 0.9,
    metalness: 0.0,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(geom, mat);
  mesh.name = 'skin';
  mesh.renderOrder = 800; // after opaque organs, it is transparent
  return mesh;
}

/**
 * Named scan windows (spec section 8), as snap points.
 *
 *   u, v  : where on the shell
 *   spin  : rotation about the probe's beam axis (local Y). 0 = scan plane
 *           contains the probe's local X. 90 deg swings it to contain the
 *           superior direction, i.e. a longitudinal/coronal plane.
 *   tilt  : rotation about the probe's local X, aiming the beam off-normal.
 *           Subxiphoid needs a lot of it — the probe lies almost flat on the
 *           abdomen and aims up under the ribs.
 *
 * NOTE: these are first-pass values chosen to be anatomically defensible, not
 * clinically reviewed. They are the P6 acceptance target and want a look from
 * someone who scans.
 */
const DEG = Math.PI / 180;

export const WINDOWS = Object.freeze({
  'subxiphoid': { u: 0.985, v: 0.63, spin: 0, tilt: -55 * DEG },
  // Raised from v=0.77 after the scene was set in the editor: the heart moved up
  // to a centre of y=25.8 cm, and 0.77 aimed below it entirely (5 px of
  // myocardium). Swept against measured wall-and-cavity area; 0.86/0.08 cuts the
  // LV long axis with a prominent cavity, which is what PLAX should show.
  'parasternal-long': { u: 0.08, v: 0.86, spin: -45 * DEG, tilt: 0 },
  // v raised from 0.77: at that height the short-axis cut lands near the apex,
  // which is almost solid muscle (5% cavity). 0.82 puts it mid-ventricle, the
  // papillary level that short axis is normally taught at, giving a proper
  // ring of wall around a cavity (~33%).
  'parasternal-short': { u: 0.06, v: 0.82, spin: 45 * DEG, tilt: 0 },
  // v raised from 0.66: the apical window sits AT the cardiac apex, and 0.66
  // put the probe ~6 cm below the heart, which returned an essentially empty
  // sector. 0.78 lands inside both the imported heart (y 0.15-0.31) and the
  // primitive stand-in (y 0.135-0.245), so it holds across models.
  'apical-four-chamber': { u: 0.11, v: 0.78, spin: 60 * DEG, tilt: -25 * DEG },
  'ruq-morison': { u: 0.78, v: 0.54, spin: 90 * DEG, tilt: 0 },
  'luq-splenorenal': { u: 0.22, v: 0.58, spin: 90 * DEG, tilt: 0 },
  // v lowered from 0.14 and tilt removed. At the anterior midline with spin 0
  // the scan plane is axial at the probe's height, and 0.14 put it at y=-0.216,
  // the bladder's top edge (it spans -0.27 to -0.215), so the window grazed the
  // bladder and returned nothing. 0.10 cuts through its centre.
  //
  // A real suprapubic view is angled caudally, but on this simplified cylinder
  // a caudal tilt rotates the plane straight off the bladder rather than into
  // the pelvis. That is a limitation of the torso shell, not of the window.
  'suprapubic': { u: 0.0, v: 0.10, spin: 0, tilt: 0 },
  'aorta-transverse': { u: 0.0, v: 0.53, spin: 0, tilt: 0 },
});
