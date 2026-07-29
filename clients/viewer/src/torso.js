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

export const TORSO = Object.freeze({
  rx: 0.17, // half-width, left-right
  rz: 0.115, // half-depth, anterior-posterior
  height: 0.6, // superior-inferior extent
});

const WORLD_SUPERIOR = new THREE.Vector3(0, 1, 0);

/**
 * Circumference of the torso's elliptical cross-section (Ramanujan's
 * approximation). Physical translation converts metres of lateral phone travel
 * into a fraction of a lap around the body, so this is what makes a 10 cm hand
 * movement produce roughly 10 cm of probe travel on the skin.
 */
export const TORSO_CIRCUMFERENCE = (() => {
  const { rx: a, rz: b } = TORSO;
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
})();

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
  position.set(TORSO.rx * s, (v - 0.5) * TORSO.height, TORSO.rz * c);

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

/** Translucent skin shell. Open-ended so the interior is visible in Mode 1. */
export function createTorsoMesh() {
  const geom = new THREE.CylinderGeometry(1, 1, TORSO.height, 96, 1, true);
  geom.scale(TORSO.rx, 1, TORSO.rz);

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
  'parasternal-long': { u: 0.06, v: 0.77, spin: -45 * DEG, tilt: 0 },
  'parasternal-short': { u: 0.06, v: 0.77, spin: 45 * DEG, tilt: 0 },
  'apical-four-chamber': { u: 0.11, v: 0.66, spin: 60 * DEG, tilt: -25 * DEG },
  'ruq-morison': { u: 0.78, v: 0.54, spin: 90 * DEG, tilt: 0 },
  'luq-splenorenal': { u: 0.22, v: 0.58, spin: 90 * DEG, tilt: 0 },
  'suprapubic': { u: 0.0, v: 0.14, spin: 0, tilt: -20 * DEG },
  'aorta-transverse': { u: 0.0, v: 0.53, spin: 0, tilt: 0 },
});
