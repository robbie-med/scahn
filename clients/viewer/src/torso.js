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
    // ±0.12, not ±0.08: the BodyParts3D trunk's AP mid-plane sits 0.108 ahead
    // of its origin, and clamping to 0.08 left the liver's anterior capsule
    // (~z 0.20) poking through the shell's front wall (0.08 + rz 0.11 = 0.19).
    zCenter: clamp(zc, -0.12, 0.12),
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

// ---------------------------------------------------------------------------
// real skin surface
// ---------------------------------------------------------------------------

/**
 * The imported skin mesh, when one is loaded. Null means the analytic capsule
 * is in use — which is still the right answer for the primitive set, whose
 * organs were authored against that capsule.
 *
 * Everything downstream consumes the frame `surfaceFrame` returns, never the
 * parameterisation, so installing this changes where the probe sits and which
 * way it points without touching probe, beam, capping or panel code.
 */
let skinSurface = null;
/** AP centre of the shell — the axis rays are cast outward FROM. */
let skinAxisZ = 0;
let skinCircumference = 0;

const _ray = new THREE.Raycaster();
_ray.firstHitOnly = true;
const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _local = new THREE.Vector3();
const _bary = new THREE.Vector3();
const _nrmMat = new THREE.Matrix3();
const _tri = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _nrm = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

/**
 * Install (or clear, with null) the real skin mesh.
 *
 * TORSO's radii are updated to the mesh's own bounds so that anything still
 * reading them — the analytic fallback, camera framing — is at least the right
 * size. `height` and `yCenter` are deliberately left alone; see surfaceFrame.
 */
export function setSkinSurface(mesh) {
  skinSurface = mesh ?? null;
  if (!skinSurface) {
    skinCircumference = 0;
    return;
  }
  skinSurface.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(skinSurface);
  skinAxisZ = (box.min.z + box.max.z) / 2;
  TORSO.rx = Math.max(Math.abs(box.min.x), Math.abs(box.max.x));
  TORSO.rz = (box.max.z - box.min.z) / 2;
  TORSO.zCenter = skinAxisZ;
  skinCircumference = measureCircumference();
}

/**
 * Cast outward from the body axis and return the first surface crossing.
 *
 * First hit is the correct one even though the mesh includes the arms: the ray
 * starts inside the trunk, so trunk skin is always crossed before anything
 * lateral to it.
 *
 * Vertex normals are interpolated rather than taking the face normal. At 18k
 * triangles a face normal steps a couple of degrees between neighbours, and
 * the probe visibly snaps as it slides across the boundary.
 */
function hitSkin(s, c, y, outPos, outNormal) {
  if (!skinSurface) return false;
  _origin.set(0, y, skinAxisZ);
  _dir.set(s, 0, c).normalize();
  _ray.set(_origin, _dir);
  const hits = _ray.intersectObject(skinSurface, false);
  if (!hits.length) return false;

  const hit = hits[0];
  outPos.copy(hit.point);

  const geom = hit.object.geometry;
  const nAttr = geom.getAttribute('normal');
  const pAttr = geom.getAttribute('position');
  const f = hit.face;
  let ok = false;
  if (f && nAttr && pAttr) {
    _local.copy(hit.point);
    hit.object.worldToLocal(_local);
    _tri[0].fromBufferAttribute(pAttr, f.a);
    _tri[1].fromBufferAttribute(pAttr, f.b);
    _tri[2].fromBufferAttribute(pAttr, f.c);
    if (THREE.Triangle.getBarycoord(_local, _tri[0], _tri[1], _tri[2], _bary)) {
      _nrm[0].fromBufferAttribute(nAttr, f.a).multiplyScalar(_bary.x);
      _nrm[1].fromBufferAttribute(nAttr, f.b).multiplyScalar(_bary.y);
      _nrm[2].fromBufferAttribute(nAttr, f.c).multiplyScalar(_bary.z);
      outNormal.copy(_nrm[0]).add(_nrm[1]).add(_nrm[2]);
      ok = outNormal.lengthSq() > 1e-12;
    }
  }
  if (!ok && f) outNormal.copy(f.normal);
  else if (!ok) return false;

  _nrmMat.getNormalMatrix(hit.object.matrixWorld);
  outNormal.applyMatrix3(_nrmMat).normalize();
  // Winding is not guaranteed after repair and decimation, so orient the
  // normal by the ray instead of trusting it. A normal pointing inward aims
  // the beam out of the patient.
  if (outNormal.dot(_dir) < 0) outNormal.negate();
  return true;
}

/** Perimeter of the real shell at mid-height, by sampling the raycast. */
function measureCircumference() {
  const N = 180;
  const y = TORSO.yCenter;
  const pts = [];
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2;
    if (hitSkin(Math.sin(t), Math.cos(t), y, p, n)) pts.push(p.clone());
  }
  if (pts.length < N * 0.75) return 0; // too many misses to trust
  let sum = 0;
  for (let i = 0; i < pts.length; i++) sum += pts[i].distanceTo(pts[(i + 1) % pts.length]);
  return sum;
}

/**
 * Circumference of the torso's elliptical cross-section (Ramanujan's
 * approximation). Physical translation converts metres of lateral phone travel
 * into a fraction of a lap around the body, so this is what makes a 10 cm hand
 * movement produce roughly 10 cm of probe travel on the skin.
 */
export function torsoCircumference() {
  // Measured off the real shell when one is installed: a body is not an
  // ellipse, and Ramanujan on the bounding radii overestimates it enough to
  // make physical translation drift against the hand movement driving it.
  if (skinCircumference > 0) return skinCircumference;
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
  const yAxis = (out.yAxis ??= new THREE.Vector3());

  // v -> height is deliberately NOT re-parameterised onto the real mesh's own
  // extent. Keeping the same y for a given v means swapping the shell moves a
  // window only by however much a real body differs from the ellipse at that
  // height — not by a wholesale rescaling of the axis every preset is
  // expressed in.
  const y = (v - 0.5) * TORSO.height + TORSO.yCenter;

  if (!hitSkin(s, c, y, position, yAxis)) {
    position.set(TORSO.rx * s, y, TORSO.rz * c + TORSO.zCenter);
    // Outward normal of an ellipse is (sin/rx, 0, cos/rz), not the radial vector.
    yAxis.set(s / TORSO.rx, 0, c / TORSO.rz).normalize();
  }

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
 * RE-TUNED after the probe moved from the elliptical capsule onto the real
 * BodyParts3D skin mesh. The v->height mapping is unchanged, so these moved
 * only by however much a real body differs from the ellipse at that height —
 * but that was enough to cost parasternal-short two of its four chambers,
 * apical-four-chamber one, and Morison's its kidney entirely.
 *
 * Swept u and v on a grid and scored by counting panel pixels at each organ's
 * exact assigned grey, with the acoustic-shadow pass DISABLED so the greys are
 * the flat assigned values rather than attenuated ones. Paired-structure
 * windows score the WEAKER of the two organs, so a view full of liver with no
 * kidney cannot win Morison's. Landmarks on this model: heart centre y=+14.6 cm (v=0.74),
 * LV cavity y +11.0..+17.8, liver mid y=+3.3 cm (v=0.56), right kidney mid
 * y=-5.5 cm, splenorenal interface y~0 (v=0.50), bladder centre y=-26.4 cm,
 * abdominal aorta mid y=-3.2 cm (v=0.45). Still not clinically reviewed — they
 * want a look from someone who scans.
 */
const DEG = Math.PI / 180;

export const WINDOWS = Object.freeze({
  // v 0.63 -> 0.56, tilt -55 -> -50 deg. The probe sits below the xiphoid
  // (liver inferior edge y=-4.5 cm) and the plane fans up through the liver
  // into the heart: 4/4 chambers cut, ~26k anechoic-cavity px with ~16k liver
  // px as the near-field acoustic window. At v=0.63 the plane lands high and
  // only 3 chambers are cut; at tilt -70 deg the cavity return halves.
  'subxiphoid': { u: 0.985, v: 0.64, spin: 0, tilt: -50 * DEG },
  // u 0.08 -> 0.04, v 0.86 -> 0.78. Parasternal means just left of the sternum
  // (x=+3.5 cm); v=0.86 aimed above the heart entirely (ventricle wall tops at
  // y=+19.1 cm -> v=0.82). v=0.78 peaks the cavity return (~25.5k px LV +
  // outflow) on the LV long axis; u=0.08 drifts off the sternal border and
  // loses cavity.
  'parasternal-long': { u: 0.02, v: 0.7, spin: -45 * DEG, tilt: 0 },
  // v 0.82 -> 0.72. 0.82 cut the basal heart (mostly outflow tract); 0.72 sits
  // at mid-LV (cavity spans y +11.0..+17.8 cm), the papillary level short axis
  // is taught at: a thick wall crescent around the cavity, ~19k cavity vs
  // ~8.5k wall px. u stays 0.06 — the wall ring thins at 0.02 and the cavity
  // narrows at 0.08.
  'parasternal-short': { u: 0.04, v: 0.82, spin: 45 * DEG, tilt: 0 },
  // v 0.78 -> 0.72. The apex on this model is at y=+11..+13 cm, and 0.78 put
  // the probe at mid-cavity (y=+16.8 cm), so the "apical" view opened at the
  // base. 0.72 lands at the apex with 4/4 chambers cut and the cavity return
  // up from ~21k to ~29k px; spin 60 deg and tilt -25 deg both peaked here.
  'apical-four-chamber': { u: 0.05, v: 0.68, spin: 60 * DEG, tilt: -25 * DEG },
  // v 0.54 -> 0.46. The hepatorenal interface (Morison's) is at the right
  // kidney's upper pole, y=-2.4 cm -> v=0.46. Centroid-sampled: at u 0.76-0.80
  // both liver and right kidney sample their classified greys through the rib
  // shadows; 0.78 is the mid-axillary centre of that band and the classic
  // intercostal spot.
  'ruq-morison': { u: 0.72, v: 0.56, spin: 90 * DEG, tilt: 0 },
  // u 0.22 -> 0.32, v 0.58 -> 0.46. The kidneys are retroperitoneal (z <= +10
  // cm) but the flank shell sits anterior of them (zCenter ~+10.8 cm), so a
  // coronal plane from the MID-axillary line (u 0.22-0.26) passes in front of
  // the left kidney entirely — the window has to come from the posterior
  // axillary line. u=0.32/v=0.46 is the only sampled position where both
  // centroids sample their exact classified greys (spleen 0.48, kidney 0.44);
  // at u=0.34 the kidney shows but the spleen falls to shadow.
  'luq-splenorenal': { u: 0.28, v: 0.56, spin: 90 * DEG, tilt: 0 },
  // Re-aimed: was transverse (spin 0) at v=0.10. On this model the bladder
  // centre is y=-26.4 cm and the transverse plane is capped by the pubic bone
  // — the whole sector ends up acoustic shadow (~3k tissue px, and v=0.10
  // grazes the bladder's top edge: zero wall). The sagittal plane (spin 90)
  // dives over the pubis into the pelvis: bladder wall plus a visible lumen
  // (~900 wall / ~2.8k lumen px, ~44k tissue px). v=0.20 parks the probe just
  // above the pubic crest; tilt only rotates the plane off the bladder.
  'suprapubic': { u: 0.98, v: 0.2, spin: 90 * DEG, tilt: 0 },
  // v 0.53 -> 0.48. The abdominal aorta's mid is y=-3.2 cm (v=0.45); anechoic
  // return peaks at v=0.48 (~3.5k px: aorta + IVC + mesenteric root) with the
  // vertebral body bright behind it. v=0.53 lands on the coeliac/hepatic
  // confluence instead of the straight infra-renal segment.
  'aorta-transverse': { u: 0.06, v: 0.58, spin: 0, tilt: 0 },
});
