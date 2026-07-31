/**
 * Roll-to-slide: absolute circumferential probe position from phone attitude.
 *
 * ## Why this exists
 *
 * Physical translation by dead reckoning (translation.js) cannot work on
 * consumer MEMS hardware. Position needs acceleration integrated twice, and the
 * dominant error is not noise but attitude error leaking gravity into the
 * horizontal plane: 1° of tilt error injects 0.17 m/s², which is metres of drift
 * within seconds against a 0.6 m torso. No filtering fixes that.
 *
 * But the probe does not live in free space. It slides on a surface, so its
 * position is two coordinates (u around the circumference, v head-to-foot), not
 * three. And for a SUPINE patient — which is how anyone is scanned — the torso
 * is a horizontal cylinder, so moving the probe around the flank ROTATES the
 * phone about the body's long axis. Rotation is exactly what the phone measures
 * well: it is a tilt relative to gravity, so it is absolute and drift-free,
 * and needs no integration at all.
 *
 * ## The decomposition
 *
 * The phone's attitude is already fully spent on probe orientation, so reading
 * position out of it too would make one gesture mean two things. A swing-twist
 * split resolves that cleanly, and the split is physically meaningful rather
 * than a maths convenience:
 *
 *   TWIST about the phone's long axis -> sliding around the torso.
 *     A real probe stays normal to the skin as it travels around the flank, so
 *     this rotation IS the translation. Consuming it here and handing the
 *     SWING to the probe is what stops the probe rotating twice as fast as the
 *     hand: surfaceFrame(u,v) already re-orients the probe to the new surface
 *     normal, so the twist must not be applied a second time.
 *
 *   SWING (everything else) -> angling the probe off the surface normal.
 *     Fanning and rocking, which is what the learner is actually being taught.
 *
 * The mapping is 1:1 by construction: rolling the phone 90° moves the probe 90°
 * around a circular cross-section. There is no gain constant to tune, and no
 * reference to recalibrate — the only trimming needed is a rebase whenever
 * something else moves the probe (a preset, or the drag pad).
 *
 * ## What this deliberately does NOT do
 *
 * Nothing here gives v (head-to-foot). Sliding craniocaudally on a supine
 * patient does not change the phone's attitude at all, so there is no
 * attitude-derived signal to read, and inventing one — tilt-as-joystick — would
 * teach a motor habit that a real probe does not reward. v stays on the drag
 * pad, where it is honest.
 */

import * as THREE from 'three';

/** The phone's long axis in its own frame: local +Y is the top of the screen. */
const LONG_AXIS = new THREE.Vector3(0, 1, 0);

const _twist = new THREE.Quaternion();
const _inv = new THREE.Quaternion();

/**
 * Split `q` into a twist about the phone's long axis and the remaining swing.
 *
 * Standard swing-twist: project the quaternion's vector part onto the axis and
 * renormalise. Because the axis is local +Y the projection is just the y
 * component, so this reduces to a two-term normalise rather than a general
 * projection.
 *
 * @param {THREE.Quaternion} q      attitude, relative to the recentre pose
 * @param {THREE.Quaternion} swing  written with the non-twist remainder
 * @returns {number} signed twist angle in radians, in (-PI, PI]
 */
export function splitTwist(q, swing) {
  let w = q.w;
  let y = q.y;
  // A quaternion and its negation are the same rotation, but atan2 below is not
  // sign-agnostic — without this the angle jumps by 2*PI as w crosses zero and
  // the probe teleports to the far side of the torso.
  if (w < 0) { w = -w; y = -y; }

  const n = Math.hypot(y, w);
  if (n < 1e-9) {
    // Rotation is a half-turn perpendicular to the long axis: the twist is
    // undefined. Report none and let the whole rotation be swing.
    swing.copy(q);
    return 0;
  }
  _twist.set(0, y / n, 0, w / n);
  const angle = 2 * Math.atan2(y / n, w / n);

  _inv.copy(_twist).invert();
  swing.copy(q).multiply(_inv);

  return angle > Math.PI ? angle - 2 * Math.PI : angle;
}

/**
 * Absolute circumferential position from phone attitude.
 *
 * Holds the (twist, u) pair the mapping is measured from, so that anything else
 * moving the probe — applying a window preset, dragging the pad — can rebase it
 * without the probe snapping back on the next frame.
 */
export class RollToSlide {
  constructor() {
    this.enabled = false;
    /** Twist angle at the last rebase. */
    this.refTwist = 0;
    /** Probe u at the last rebase. */
    this.refU = 0;
    /** Live twist, exposed for diagnostics. */
    this.twist = 0;
    this.swing = new THREE.Quaternion();
  }

  /** Re-anchor the mapping so the current attitude means the current u. */
  rebase(q, u) {
    this.refTwist = splitTwist(q, this.swing);
    this.refU = u;
    this.twist = this.refTwist;
  }

  setEnabled(on, q, u) {
    this.enabled = !!on;
    if (this.enabled) this.rebase(q, u);
  }

  /**
   * @returns {number|null} the new u, or null when the mode is off — in which
   * case the caller must leave both u and the attitude alone.
   */
  update(q, u) {
    if (!this.enabled) {
      this.swing.copy(q);
      return null;
    }
    this.twist = splitTwist(q, this.swing);
    let d = this.twist - this.refTwist;
    // Shortest way round: rolling through the wrap point should keep sliding in
    // the same direction, not reverse across the body.
    if (d > Math.PI) d -= 2 * Math.PI;
    else if (d < -Math.PI) d += 2 * Math.PI;
    // 1:1 with the circumference. A quarter turn of the phone is a quarter of
    // the way around the torso.
    const next = this.refU + d / (2 * Math.PI);
    return ((next % 1) + 1) % 1;
  }
}
