/**
 * Phone orientation -> quaternion. Spec section 3.
 *
 * All sensor fusion happens here, on the phone. Only quaternions cross the
 * wire; Euler angles over a socket gimbal-lock at exactly the steep angles a
 * subxiphoid view requires.
 *
 * Two backends:
 *   - AbsoluteOrientationSensor (Generic Sensor API, Android/Chrome) yields a
 *     quaternion directly.
 *   - deviceorientation (iOS, where the Generic Sensor API is unavailable),
 *     converted here rather than on the viewer.
 */

import { Euler, Quaternion, Vector3 } from 'three';

const ZEE = new Vector3(0, 0, 1);

/**
 * -90 degrees about X. The deviceorientation reference frame is screen-UP, not
 * screen-forward, and this is the correction. Part of the copied maths below —
 * see the warning on `eulerToQuaternion`.
 */
const Q_SCREEN_UP = new Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));

const _euler = new Euler();
const _q0 = new Quaternion();

/**
 * alpha/beta/gamma (radians) + screen orientation (radians) -> quaternion.
 *
 * DO NOT DERIVE THIS. It is copied from three.js's deprecated
 * DeviceOrientationControls, which is correct and battle-tested. The spec uses
 * intrinsic Z-X'-Y'' composition, needs the -90 deg X correction above because
 * the reference frame is screen-up, and needs a further twist by
 * screen.orientation.angle. Every step is load-bearing.
 */
export function eulerToQuaternion(out, alpha, beta, gamma, orient) {
  _euler.set(beta, alpha, -gamma, 'YXZ');
  out.setFromEuler(_euler);
  out.multiply(Q_SCREEN_UP);
  out.multiply(_q0.setFromAxisAngle(ZEE, -orient));
  return out;
}

function screenAngleRad() {
  const deg = screen.orientation?.angle ?? window.orientation ?? 0;
  return (Number(deg) || 0) * (Math.PI / 180);
}

export class OrientationSource {
  constructor() {
    this.raw = new Quaternion();
    /** Reference pose captured by recenter(); transmitted value is
     *  q_ref^-1 . q_current. */
    this.ref = new Quaternion();
    this.out = new Quaternion();
    this._refInv = new Quaternion();
    this.backend = null;
    this.running = false;
    this._sensor = null;
    this._onDeviceOrientation = null;
  }

  /**
   * Must be called from a user gesture: iOS requires both a gesture and a
   * secure context for DeviceOrientationEvent.requestPermission().
   * @returns {Promise<'sensor'|'deviceorientation'>}
   */
  async start() {
    if (this.running) return this.backend;

    if ('AbsoluteOrientationSensor' in window) {
      try {
        await this._startSensorApi();
        this.running = true;
        return (this.backend = 'sensor');
      } catch (err) {
        // Permissions policy or missing hardware — fall through.
        console.warn('AbsoluteOrientationSensor unavailable:', err?.message ?? err);
      }
    }

    await this._startDeviceOrientation();
    this.running = true;
    return (this.backend = 'deviceorientation');
  }

  async _startSensorApi() {
    if (navigator.permissions?.query) {
      const needed = ['accelerometer', 'gyroscope', 'magnetometer'];
      const results = await Promise.all(
        needed.map((name) => navigator.permissions.query({ name }).catch(() => null)),
      );
      if (results.some((r) => r && r.state === 'denied')) {
        throw new Error('motion sensor permission denied');
      }
    }

    // eslint-disable-next-line no-undef
    const sensor = new AbsoluteOrientationSensor({ frequency: 60, referenceFrame: 'device' });
    await new Promise((resolve, reject) => {
      const ok = () => { sensor.removeEventListener('error', bad); resolve(); };
      const bad = (e) => { sensor.removeEventListener('reading', ok); reject(e.error ?? e); };
      sensor.addEventListener('reading', ok, { once: true });
      sensor.addEventListener('error', bad, { once: true });
      sensor.start();
      setTimeout(() => reject(new Error('sensor timeout')), 2500);
    });

    sensor.addEventListener('reading', () => {
      const q = sensor.quaternion;
      if (!q) return;
      this.raw.set(q[0], q[1], q[2], q[3]);
      // Screen-orientation twist, so landscape feels the same as portrait.
      this.raw.multiply(_q0.setFromAxisAngle(ZEE, -screenAngleRad()));
    });
    this._sensor = sensor;
  }

  async _startDeviceOrientation() {
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) throw new Error('no orientation sensors on this device');

    if (typeof DOE.requestPermission === 'function') {
      const res = await DOE.requestPermission();
      if (res !== 'granted') throw new Error('motion permission denied');
    }

    // `deviceorientationabsolute` carries a compass-referenced heading where it
    // exists; plain `deviceorientation` is the universal fallback. Heading
    // drift is handled by recentring, not by preferring one event.
    const type = 'ondeviceorientationabsolute' in window
      ? 'deviceorientationabsolute'
      : 'deviceorientation';

    const D2R = Math.PI / 180;
    this._onDeviceOrientation = (e) => {
      if (e.alpha == null && e.beta == null && e.gamma == null) return;
      eulerToQuaternion(
        this.raw,
        (e.alpha ?? 0) * D2R,
        (e.beta ?? 0) * D2R,
        (e.gamma ?? 0) * D2R,
        screenAngleRad(),
      );
    };
    window.addEventListener(type, this._onDeviceOrientation, true);
    this._eventType = type;
  }

  /**
   * Capture the current pose as the reference.
   *
   * Mandatory, not optional: magnetometer heading drifts badly near hospital
   * beds, metal furniture and monitors. Without this the tool is unusable in
   * the environment it is meant for.
   */
  recenter() {
    this.ref.copy(this.raw);
  }

  /** q_ref^-1 . q_current, as a plain XYZW array for the wire. */
  read() {
    this._refInv.copy(this.ref).invert();
    this.out.copy(this._refInv).multiply(this.raw);
    return [this.out.x, this.out.y, this.out.z, this.out.w];
  }

  stop() {
    if (this._sensor) { try { this._sensor.stop(); } catch { /* ignore */ } this._sensor = null; }
    if (this._onDeviceOrientation) {
      window.removeEventListener(this._eventType, this._onDeviceOrientation, true);
      this._onDeviceOrientation = null;
    }
    this.running = false;
  }
}

/** Best-effort device label so nobody has to type their phone's name. */
export function guessDeviceName() {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  const android = ua.match(/Android[^;]*;\s*([^)]+?)(?:\s+Build|\))/);
  if (android) return android[1].trim().slice(0, 24);
  if (/Android/.test(ua)) return 'Android phone';
  return 'Phone';
}
