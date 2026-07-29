/**
 * Physical translation — moving the phone through space to slide the probe
 * across the body, as opposed to dragging on the placement pad.
 *
 * ## Why this is built the way it is
 *
 * Position from an IMU means double-integrating acceleration, and the error
 * grows as t². The dominant term is not sensor noise, it is orientation error
 * leaking gravity into the horizontal plane: a 1° attitude error injects a
 * phantom 0.17 m/s², which is ~8 cm of drift after one second and ~2 m after
 * five. The torso model is 0.6 m tall. Free-running dead reckoning puts the
 * probe off the body in about three seconds. That is fundamental to consumer
 * MEMS hardware, not something that can be tuned away.
 *
 * Three things make it usable anyway:
 *
 *  1. **A clutch.** Integration only runs while the user holds the Move button,
 *     and velocity is zeroed on release — exactly like lifting a mouse. Drift
 *     can only accumulate across one deliberate stroke, not indefinitely.
 *  2. **Zero-velocity updates.** While held, a stretch of near-zero linear
 *     acceleration is treated as "actually stopped" and velocity is reset. This
 *     is the same trick foot-mounted pedestrian navigation uses at each
 *     footfall, and it stops slow phantom creep during a pause mid-stroke.
 *  3. **Closed-loop correction.** The learner watches the probe while moving it,
 *     so this behaves like a mouse with imperfect gain rather than like blind
 *     navigation. Consistent direction and responsiveness matter far more than
 *     absolute accuracy — which is fortunate, because absolute accuracy is not
 *     on offer.
 *
 * Output is a displacement delta in the *recentered* frame. The phone does the
 * sensor fusion; the viewer decides what that means against the torso surface.
 */

import { Quaternion, Vector3 } from 'three';

/** Linear acceleration below this (m/s²) counts as "not really moving". */
const ZUPT_ACCEL = 0.12;
/** Consecutive quiet samples before velocity is forced to zero. */
const ZUPT_SAMPLES = 6;
/** Per-sample velocity bleed. Bounds runaway from residual bias; costs a little
 *  travel on slow sustained strokes, which is the right trade here. */
const DAMPING = 0.92;
/** Hard ceiling on speed (m/s). A probe does not move faster than this on skin,
 *  so anything above it is integration blow-up. */
const MAX_SPEED = 1.5;
/** Low-pass coefficient for estimating gravity when the platform does not
 *  provide a gravity-free reading. */
const GRAVITY_LP = 0.9;

export class TranslationSource {
  /** @param {import('./orientation.js').OrientationSource} orientation */
  constructor(orientation) {
    this.orientation = orientation;
    this.enabled = false;
    this.running = false;

    this.velocity = new Vector3();
    /** Displacement accumulated since the last read(), metres. */
    this.delta = new Vector3();

    this._acc = new Vector3();
    this._gravity = new Vector3();
    this._q = new Quaternion();
    this._quiet = 0;
    this._haveGravityFree = false;
    this._lastT = null;
    this._onMotion = null;

    /** Diagnostics for the UI. */
    this.speed = 0;
  }

  /**
   * iOS gates devicemotion behind the same permission as deviceorientation, so
   * in practice this does not cost the learner a second prompt — but it must
   * still be requested, and from the same user gesture.
   */
  async start() {
    if (this.running) return;
    const DME = window.DeviceMotionEvent;
    if (!DME) throw new Error('no motion sensors on this device');

    if (typeof DME.requestPermission === 'function') {
      const res = await DME.requestPermission();
      if (res !== 'granted') throw new Error('motion permission denied');
    }

    this._onMotion = (e) => this._sample(e);
    window.addEventListener('devicemotion', this._onMotion, true);
    this.running = true;
  }

  stop() {
    if (this._onMotion) window.removeEventListener('devicemotion', this._onMotion, true);
    this._onMotion = null;
    this.running = false;
  }

  /** Engage the clutch. Called on button press. */
  engage() {
    this.enabled = true;
    this.velocity.set(0, 0, 0);
    this._quiet = 0;
    this._lastT = null;
  }

  /** Release the clutch: stop integrating and drop any residual velocity, so
   *  the next stroke starts from a known-zero state rather than inheriting
   *  whatever bias had accumulated. */
  release() {
    this.enabled = false;
    this.velocity.set(0, 0, 0);
    this.speed = 0;
  }

  _sample(e) {
    // `acceleration` is already gravity-compensated where the platform provides
    // it. Where it is not, estimate gravity with a low-pass filter over the
    // combined signal and subtract — done in the device frame, so it needs no
    // attitude estimate and cannot be poisoned by attitude error.
    let ax, ay, az;
    if (e.acceleration && e.acceleration.x != null) {
      this._haveGravityFree = true;
      ({ x: ax, y: ay, z: az } = e.acceleration);
    } else if (e.accelerationIncludingGravity && e.accelerationIncludingGravity.x != null) {
      const g = e.accelerationIncludingGravity;
      this._gravity.set(
        GRAVITY_LP * this._gravity.x + (1 - GRAVITY_LP) * (g.x ?? 0),
        GRAVITY_LP * this._gravity.y + (1 - GRAVITY_LP) * (g.y ?? 0),
        GRAVITY_LP * this._gravity.z + (1 - GRAVITY_LP) * (g.z ?? 0),
      );
      ax = (g.x ?? 0) - this._gravity.x;
      ay = (g.y ?? 0) - this._gravity.y;
      az = (g.z ?? 0) - this._gravity.z;
    } else {
      return;
    }

    const now = performance.now();
    let dt = e.interval ? e.interval / 1000 : (this._lastT == null ? 1 / 60 : (now - this._lastT) / 1000);
    this._lastT = now;
    // A backgrounded tab resumes with a huge gap; integrating it would fling
    // the probe across the torso.
    if (!(dt > 0) || dt > 0.1) dt = 1 / 60;

    if (!this.enabled) return;

    this._acc.set(ax, ay, az);

    // Zero-velocity update: a quiet stretch means stopped, not drifting.
    if (this._acc.length() < ZUPT_ACCEL) {
      if (++this._quiet >= ZUPT_SAMPLES) this.velocity.set(0, 0, 0);
    } else {
      this._quiet = 0;
    }

    // Device frame -> recentered frame. Rotating by the *recentered* quaternion
    // is exactly q_ref⁻¹ · q_raw · a, i.e. the same frame the probe's rotation
    // is expressed in, so translation and rotation agree by construction.
    this._q.set(...this.orientation.read());
    this._acc.applyQuaternion(this._q);

    this.velocity.addScaledVector(this._acc, dt).multiplyScalar(DAMPING);
    if (this.velocity.length() > MAX_SPEED) this.velocity.setLength(MAX_SPEED);

    this.delta.addScaledVector(this.velocity, dt);
    this.speed = this.velocity.length();
  }

  /**
   * Consume the displacement accumulated since the last call.
   * @returns {[number,number,number]|null} metres in the recentered frame
   */
  read() {
    if (this.delta.lengthSq() === 0) return null;
    const out = [this.delta.x, this.delta.y, this.delta.z];
    this.delta.set(0, 0, 0);
    return out;
  }
}
