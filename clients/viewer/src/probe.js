/**
 * Transducer model and beam-sector geometry. Spec section 6.4.
 *
 * The scan region is a bounded sector whose shape follows the transducer, not a
 * rectangle. Sector shape drives three things that must stay in agreement:
 * the 3D beam mesh, the 2D panel's orthographic frustum, and the SVG mask that
 * gives the panel its ultrasound-screen silhouette. All three are derived here
 * from one profile so they cannot drift.
 *
 * Probe local frame: beam axis is -Y (into the patient), scan plane is XY,
 * scan-plane normal is +Z. See CONVENTIONS.md §4.
 */

import * as THREE from 'three';
import { clampDepth } from '@scahn/protocol';

export { clampDepth };

const DEG = Math.PI / 180;

/**
 * @typedef {{kind:'sector'|'linear', halfAngle?:number, originOffset?:number,
 *            halfWidth?:number, depth:number, label:string}} BeamProfile
 */

/** @type {Record<string, BeamProfile>} */
export const BEAM_PROFILES = Object.freeze({
  curvilinear: {
    kind: 'sector',
    halfAngle: 32.5 * DEG, // ~65 deg total
    originOffset: 0.05, // convex face radius
    depth: 0.20,
    label: 'Curvilinear',
  },
  phased: {
    kind: 'sector',
    halfAngle: 45 * DEG, // ~90 deg total
    originOffset: 0.005, // near-point apex, small footprint
    depth: 0.18,
    label: 'Phased array',
  },
  linear: {
    kind: 'linear',
    halfWidth: 0.02, // ~4 cm footprint
    depth: 0.06,
    label: 'Linear',
  },
});

/**
 * A beam profile with the user's chosen depth applied.
 *
 * Everything downstream — the 3D sector mesh, the 2D orthographic frustum and
 * the panel's depth graticule — derives from this one object, so a depth change
 * cannot leave them disagreeing about how deep the image goes.
 */
export function effectiveProfile(profileName, depth) {
  const base = BEAM_PROFILES[profileName];
  return { ...base, depth: clampDepth(profileName, depth ?? base.depth) };
}

const ARC_STEPS = 48;

/**
 * Outline of the scan region in the probe's local XY plane, counter-clockwise.
 * Returns Vector2s; y is negative going into the patient.
 */
export function sectorOutline(profile) {
  const pts = [];

  if (profile.kind === 'linear') {
    const { halfWidth: w, depth: d } = profile;
    pts.push(new THREE.Vector2(-w, 0), new THREE.Vector2(w, 0));
    pts.push(new THREE.Vector2(w, -d), new THREE.Vector2(-w, -d));
    return pts;
  }

  const { halfAngle: h, originOffset: r0, depth: d } = profile;
  const apexY = r0; // apex sits *behind* the face, at local +Y
  const rFar = r0 + d;

  // near arc (the transducer face), left -> right
  for (let i = 0; i <= ARC_STEPS; i++) {
    const a = -h + (2 * h * i) / ARC_STEPS;
    pts.push(new THREE.Vector2(r0 * Math.sin(a), apexY - r0 * Math.cos(a)));
  }
  // far arc, right -> left
  for (let i = ARC_STEPS; i >= 0; i--) {
    const a = -h + (2 * h * i) / ARC_STEPS;
    pts.push(new THREE.Vector2(rFar * Math.sin(a), apexY - rFar * Math.cos(a)));
  }
  return pts;
}

/** Bounding box of the scan region in probe local XY, for the 2D frustum. */
export function sectorExtent(profile) {
  const pts = sectorOutline(profile);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}

function outlineToShape(pts) {
  const shape = new THREE.Shape();
  shape.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i].x, pts[i].y);
  shape.closePath();
  return shape;
}

/**
 * Translucent fill for Mode 1, plus a thin outline for Modes 2 and 3.
 * Both opt out of clipping — the beam is an instrument, not tissue.
 */
export function createBeam(profileName, depth) {
  const profile = effectiveProfile(profileName, depth);
  const pts = sectorOutline(profile);

  const fill = new THREE.Mesh(
    new THREE.ShapeGeometry(outlineToShape(pts)),
    new THREE.MeshBasicMaterial({
      color: 0x4ea3ff,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
      clippingPlanes: null,
    }),
  );
  fill.renderOrder = 850;

  const loop = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(p.x, p.y, 0))),
    new THREE.LineBasicMaterial({ color: 0x4ea3ff, transparent: true, opacity: 0.9 }),
  );
  loop.renderOrder = 851;

  const group = new THREE.Group();
  group.name = `beam-${profileName}`;
  group.add(fill, loop);
  group.userData = { profileName, profile, fill, loop };
  return group;
}

/** Beam geometry is rebuilt whenever transducer or depth changes, so the old
 *  one has to be released rather than left for the GC to not collect. */
export function disposeBeam(group) {
  for (const child of group.children) {
    child.geometry?.dispose();
    child.material?.dispose();
  }
}

/**
 * Transducer body: a cylindrical handle on +Y with the footprint at the origin,
 * and a small marker ridge on local +X (the orientation notch on a real probe).
 */
export function createProbeModel() {
  const group = new THREE.Group();
  group.name = 'probe';

  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.014, 0.018, 0.075, 24),
    new THREE.MeshStandardMaterial({ color: 0x2f3742, roughness: 0.55 }),
  );
  body.position.y = 0.0375 + 0.008;
  group.add(body);

  const face = new THREE.Mesh(
    new THREE.CylinderGeometry(0.019, 0.016, 0.016, 24),
    new THREE.MeshStandardMaterial({ color: 0xd7dee7, roughness: 0.3 }),
  );
  face.position.y = 0.008;
  group.add(face);

  // Orientation marker — local +X. Whichever side this is on is the side the
  // panel's marker dot corresponds to (CONVENTIONS.md §4).
  const notch = new THREE.Mesh(
    new THREE.SphereGeometry(0.005, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xffc94a }),
  );
  notch.position.set(0.019, 0.022, 0);
  group.add(notch);

  return group;
}

/**
 * Sector outline as an SVG path in panel pixel space.
 *
 * `map` converts probe-local XY metres to panel pixels. Kept as a callback so
 * the panel owns its own letterboxing and this module stays unit-agnostic.
 */
export function sectorSvgPath(profile, map) {
  const pts = sectorOutline(profile);
  return pts
    .map((p, i) => {
      const [x, y] = map(p.x, p.y);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ') + ' Z';
}
