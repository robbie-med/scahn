/**
 * Torso shell and the surface frame the probe rides on. Spec section 8.
 *
 * The analytic elliptical cylinder is the fallback: the primitive organ set
 * was authored against it, and a point that misses the real skin mesh (above
 * or below its crop) lands on it. With an imported model, `surfaceFrame()` is
 * a raycast against the skin mesh — everything downstream consumes the
 * returned frame, not the parameterisation, so only this file knows which.
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
 * TORSO's radii are updated to the mesh's TRUNK bounds so that anything still
 * reading them — the analytic fallback, camera framing — is at least the right
 * size. The trunk is measured at mid-height rather than taken from the mesh's
 * bounding box: the BodyParts3D skin includes the upper arms, and the box
 * width (0.67 m) put the fallback shell a hand's breadth outside the body.
 * `height` and `yCenter` are deliberately left alone; see surfaceFrame.
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
  TORSO.zCenter = skinAxisZ;
  const ring = measureRing();
  skinCircumference = ring.circumference;
  TORSO.rx = ring.rx || Math.max(Math.abs(box.min.x), Math.abs(box.max.x));
  TORSO.rz = ring.rz || (box.max.z - box.min.z) / 2;
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

/** Perimeter and half-extents of the real shell at mid-height, by sampling
 *  the raycast. Circumference 0 means too many misses to trust. */
function measureRing() {
  const N = 180;
  const y = TORSO.yCenter;
  const pts = [];
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  let maxX = 0;
  let maxZ = 0;
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2;
    if (hitSkin(Math.sin(t), Math.cos(t), y, p, n)) {
      pts.push(p.clone());
      maxX = Math.max(maxX, Math.abs(p.x));
      maxZ = Math.max(maxZ, Math.abs(p.z - skinAxisZ));
    }
  }
  if (pts.length < N * 0.75) return { circumference: 0, rx: 0, rz: 0 };
  let sum = 0;
  for (let i = 0; i < pts.length; i++) sum += pts[i].distanceTo(pts[(i + 1) % pts.length]);
  return { circumference: sum, rx: maxX, rz: maxZ };
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

// ---------------------------------------------------------------------------
// named scan windows
// ---------------------------------------------------------------------------

/**
 * Named scan windows (spec section 8), as snap points, PER MODEL.
 *
 *   u, v  : where on the shell
 *   spin  : rotation about the probe's beam axis (local Y). 0 = scan plane
 *           contains the probe's local X. ±90 deg swings it to contain the
 *           superior direction, i.e. a longitudinal/coronal plane.
 *   tilt  : rotation about the probe's local X, aiming the beam off-normal.
 *           Subxiphoid needs a lot of it — the probe lies almost flat on the
 *           abdomen and aims up under the ribs.
 *
 * ## The spin SIGN is chosen by convention, never by search
 *
 * Probe-local +X is the orientation marker, and the 2D panel puts that side on
 * its LEFT (panel2d.js). Spin θ and θ+180° cut the identical plane and return
 * the identical pixel counts, differing only in which way round the image is —
 * so a tuning search can never choose between them, and four of the eight
 * windows once shipped mirrored (feet on the left of a coronal view, PLAX
 * back to front). The marker direction for each window is therefore fixed
 * first, from the convention a learner will meet on a real machine, and only
 * u, v and tilt are searched. With local X = Y×Z and Z = superior:
 *
 *   X' = cos(spin)·X − sin(spin)·Z
 *   spin    0 → marker along local X (patient's RIGHT at the anterior midline)
 *   spin  −90 → marker SUPERIOR (toward the head)
 *   spin  +45 → right hip,  +135 → left hip
 *
 * Because the panel's marker is on the LEFT (abdominal convention), cardiac
 * windows that a cardiology machine shows with the marker on the RIGHT are
 * reproduced by pointing the physical marker the opposite way; the image is
 * then the textbook image:
 *
 *   subxiphoid   → patient's right   (spin 0)      liver top-left, apex to the right
 *   PLAX         → left hip          (spin +135)   aorta/LA on the right, apex left
 *   PSAX         → right hip         (spin +45)    RV top-left, LV round in the middle
 *   A4C          → patient's right   (spin 0)      LV on the right of the screen
 *   RUQ / LUQ    → head              (spin −90)    cephalad on the left
 *   suprapubic   → head              (spin −90)    sagittal, bladder dome left
 *   aorta        → patient's right   (spin 0)      transverse, radiological
 *
 * u, v and tilt were tuned by sweeping a grid and scoring the panel per organ
 * with each organ painted a unique id colour and the shadow pass ON, so a
 * window only scores for tissue the learner would actually see. Cardiac
 * windows score the weakest of their required chambers, so a view with three
 * chambers cannot beat one with four. Still not clinically reviewed — these
 * want a look from someone who scans.
 */
const DEG = Math.PI / 180;

/**
 * Tuned on the fused-heart BodyParts3D build with the muscle layer off.
 * Panel pixel counts (410 x 741 panel) at the chosen placement are quoted so
 * a future re-tune can tell a regression from a different scoring choice.
 */
const BODYPARTS3D_WINDOWS = Object.freeze({
  // Just below the xiphoid, almost flat, fanning up through the liver. All
  // four chambers (LV 5.4k, RV 4.0k, LA 3.2k, RA 2.7k px) with 6.9k px of
  // liver as the near-field window. Tilt -50 lost the liver; -30 lost the
  // atria.
  'subxiphoid': { u: 0.96, v: 0.60, spin: 0, tilt: -40 * DEG },
  // Left sternal border, high. LV 7.1k, LA 2.7k, RV 2.5k px; the aortic root
  // is the weakest member at ~0.5k, which is as much as this interspace gives
  // on this skeleton. Marker to the left hip (spin +135): textbook PLAX.
  'parasternal-long': { u: 0.05, v: 0.80, spin: 135 * DEG, tilt: 0 },
  // One interspace lateral of PLAX. LV 4.1k and RV 4.3k px at the papillary
  // level. The search was CONSTRAINED to the parasternal strip (u 0.01-0.08):
  // unconstrained it slid to the subcostal margin, which cuts the same two
  // chambers through 37k px of liver and is a different window.
  'parasternal-short': { u: 0.08, v: 0.81, spin: 45 * DEG, tilt: -10 * DEG },
  // At the apex (x ~ +8 cm, y ~ +11 cm), beam aimed up toward the base. All
  // four chambers from the apex (LV 5.1k, RV 4.9k, LA 2.9k, RA 2.9k px).
  // Constrained to u >= 0.08; from the parasternal position the same four
  // chambers appear but it is not an apical view.
  'apical-four-chamber': { u: 0.13, v: 0.65, spin: 0, tilt: -20 * DEG },
  // Mid-axillary, coronal, marker to the head. Liver 21k, right kidney 9.8k px
  // with the hepatorenal interface in the middle of the sector.
  'ruq-morison': { u: 0.70, v: 0.48, spin: -90 * DEG, tilt: 0 },
  // Posterior axillary line (the left kidney is further back than the right),
  // coronal, marker to the head. Spleen 7.3k, left kidney 7.3k px.
  'luq-splenorenal': { u: 0.20, v: 0.52, spin: -90 * DEG, tilt: -20 * DEG },
  // Sagittal, marker to the head, just above the pubis and aimed a little
  // caudad. BodyParts3D's bladder is an EMPTY one (76 mL, behind the pubic
  // bone), so this is the weakest window on this model: lumen 3.1k, wall
  // 0.6k, prostate 0.9k px behind 8.6k px of bone. The pelvis model is the
  // one to teach this window on.
  'suprapubic': { u: 0.97, v: 0.06, spin: -90 * DEG, tilt: -10 * DEG },
  // Epigastric midline, transverse, marker to the patient's right. Aorta and
  // IVC side by side (~0.5k px each, which is the right size for 2 cm vessels
  // at this scale) over the vertebral body, liver in the near field. The
  // search preferred y = +5 cm for its liver bonus; y = -3 cm is the straight
  // infra-coeliac segment the window is taught on, so it is set by hand.
  'aorta-transverse': { u: 0.0, v: 0.45, spin: 0, tilt: 0 },
});

/**
 * The female pelvis is a 25 cm stack centred on the scene origin, with no
 * heart, liver, spleen or kidney, so only the pelvic window applies. Every
 * other preset reports itself unavailable rather than moving the probe to a
 * spot tuned against a different body (the whole-body "suprapubic" sits 6 cm
 * below the bottom of this model).
 */
const PELVIS_WINDOWS = Object.freeze({
  // Midline sagittal, marker to the head, aimed slightly caudad over the
  // pubis. Bladder lumen 10.8k px as the window, uterus 4.3k behind it,
  // vagina 1.4k and rectum 0.7k px below: the textbook sagittal pelvis.
  // `depth` is optional on any window: this model is 10 cm deep, and at the
  // curvilinear default of 20 cm the pelvis is a small patch at the top of a
  // black sector.
  'suprapubic': { u: 0.03, v: 0.44, spin: -90 * DEG, tilt: 10 * DEG, depth: 0.14 },
});

export const MODEL_WINDOWS = Object.freeze({
  bodyparts3d: BODYPARTS3D_WINDOWS,
  // The primitives are ellipsoids at plausible positions, authored against the
  // analytic shell. The whole-body placements land near enough on them for a
  // capping check, which is all the primitive set is for.
  primitives: BODYPARTS3D_WINDOWS,
  'kvh-female-pelvis': PELVIS_WINDOWS,
});

/** Windows for a model id; unknown models get the whole-body set. */
export function windowsFor(modelId) {
  return MODEL_WINDOWS[modelId] ?? BODYPARTS3D_WINDOWS;
}

/** @deprecated Use windowsFor(modelId). Kept for the console smoke tests. */
export const WINDOWS = BODYPARTS3D_WINDOWS;
