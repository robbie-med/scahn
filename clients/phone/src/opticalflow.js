/**
 * Optical translation — sliding the probe by watching the room move.
 *
 * ## Why this exists
 *
 * The other two ways of moving the probe with the phone both fail at the
 * physics:
 *
 *  - Dead reckoning (translation.js) double-integrates acceleration; attitude
 *    error leaks gravity into the horizontal plane and the probe is off the
 *    body within seconds. Fundamental to consumer MEMS, not tunable.
 *  - Roll-to-slide (surfaceroll.js, viewer side) reads position out of
 *    attitude — but the twist it consumes IS probe image rotation, the single
 *    most-taught manipulation in scanning, and its 1:1 premise only holds for
 *    one grip orientation. It spends the product's core channel to buy the
 *    less useful translation axis.
 *
 * A camera does not integrate anything. In the scanning grip the phone's back
 * is against the (imaginary) patient and the front camera faces the room, so
 * frame-to-frame scene shift is a direct *measurement* of hand translation —
 * an optical mouse pointed at the ceiling. Errors are per-frame and do not
 * compound; the worst case is a wrong gain, and the learner closes the loop
 * visually, exactly like a mouse with imperfect DPI.
 *
 * ## Failure modes and what is done about them
 *
 *  - **The face problem.** The user's face moves *with* the phone (zero flow)
 *    while the background moves opposite the hand. A median across a coarse
 *    grid survives this because background dominates the frame area.
 *  - **Rotation contamination.** Tilting the phone shifts the scene too.
 *    The orientation stream already measures that tilt, so the expected
 *    shift (focal-length constant × attitude delta) is subtracted per sample.
 *    Twist about the optical axis produces swirl, which cancels in the median.
 *  - **Covered lens / scene cut.** If the median block-match cost is high the
 *    frame is untrustworthy and reports zero travel rather than a guess.
 *  - **Absolute scale is unavailable** (unknown scene distance). PX_TO_M is a
 *    tuned constant; consistency matters, accuracy does not (see the clutch
 *    comment in translation.js).
 *
 * The clutch from translation.js applies unchanged: flow only accumulates
 * while Move is held, and read() consumes per 30 Hz frame, so the existing
 * `dpos` wire contract and the viewer's surface mapping are untouched.
 */

import { Quaternion } from 'three';

/** Processing resolution. Small enough for 30 Hz block matching on a phone. */
const W = 160;
const H = 120;
/** Template blocks: 12x12 px on a 20 px grid -> 8x6 blocks over the frame. */
const BLOCK = 12;
const STRIDE = 20;
/** Search radius in pixels, step 2 (SAD at 25 candidate positions). */
const SEARCH = 10;
/** Median match cost above this means no trustworthy track (covered lens). */
const MAX_MEAN_COST = 40;
/** Expected scene shift per radian of tilt, in px — an effective focal length.
 *  Tunable; over-subtracting is worse than under-subtracting, so keep it low. */
const FLOW_PER_RAD = 180;
/** Image px -> metres of hand travel. There is no absolute scale without
 *  knowing the scene distance; this is tuned by experiment and the viewer's
 *  own moveGain can trim it further. */
const PX_TO_M = 0.0018;
/** A single 30 Hz frame can never be a metre of travel (protocol limit). */
const MAX_FRAME_M = 0.25;

/**
 * Median block-match flow between two grayscale frames.
 *
 * Pure function, exported for tests: no DOM, no camera.
 *
 * @param {Uint8Array} prev  W*H grayscale
 * @param {Uint8Array} curr  W*H grayscale
 * @returns {{dx:number, dy:number, cost:number}|null}
 *   scene shift in px (curr relative to prev), or null if untrackable.
 */
export function matchFlow(prev, curr) {
  const xs = [];
  const ys = [];
  const costs = [];
  for (let by = BLOCK; by + BLOCK + SEARCH <= H; by += STRIDE) {
    for (let bx = BLOCK; bx + BLOCK + SEARCH <= W; bx += STRIDE) {
      let best = Infinity;
      let bdx = 0;
      let bdy = 0;
      for (let oy = -SEARCH; oy <= SEARCH; oy += 2) {
        for (let ox = -SEARCH; ox <= SEARCH; ox += 2) {
          let sad = 0;
          for (let y = 0; y < BLOCK; y += 2) {
            const rp = (by + y) * W + bx;
            const rc = (by + oy + y) * W + bx + ox;
            for (let x = 0; x < BLOCK; x += 2) {
              sad += Math.abs(prev[rp + x] - curr[rc + x]);
            }
          }
          if (sad < best) {
            best = sad;
            bdx = ox;
            bdy = oy;
          }
        }
      }
      xs.push(bdx);
      ys.push(bdy);
      costs.push(best / ((BLOCK * BLOCK) / 4)); // mean per compared px
    }
  }
  if (xs.length < 8) return null;
  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  costs.sort((a, b) => a - b);
  const mid = xs.length >> 1;
  const med = (a) => (a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2);
  const cost = med(costs);
  if (cost > MAX_MEAN_COST) return null;
  return { dx: med(xs), dy: med(ys), cost };
}

export class FlowSource {
  /** @param {import('./orientation.js').OrientationSource} orientation */
  constructor(orientation) {
    this.orientation = orientation;
    this.enabled = false;
    this.running = false;

    /** Displacement accumulated since the last read(), metres. */
    this.dx = 0;
    this.dy = 0;

    this._stream = null;
    this._video = null;
    this._canvas = null;
    this._ctx = null;
    this._prev = null;
    this._curr = new Uint8Array(W * H);
    this._timer = null;
    this._lastQ = new Quaternion();
    this._q = new Quaternion();
    this._dq = new Quaternion();

    /** Diagnostics for the UI. */
    this.flowX = 0;
    this.flowY = 0;
    this.tracking = false;
  }

  /**
   * Camera permission needs a user gesture; call this from the chip click.
   * The front camera is the one that faces the room in the scanning grip.
   */
  async start() {
    if (this.running) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    this._stream = stream;

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();

    this._canvas = document.createElement('canvas');
    this._canvas.width = W;
    this._canvas.height = H;
    this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });
    this._video = video;

    this._lastQ.set(...this.orientation.read());
    this._timer = setInterval(() => this._sample(), 33);
    this.running = true;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    if (this._stream) for (const track of this._stream.getTracks()) track.stop();
    this._stream = null;
    this._video = null;
    this._ctx = null;
    this._prev = null;
    this.running = false;
    this.tracking = false;
  }

  /** Engage the clutch. Called on button press. */
  engage() {
    this.enabled = true;
    this._lastQ.set(...this.orientation.read());
  }

  /** Release the clutch: stop accumulating; nothing to zero — no velocity
   *  state exists, which is the whole point over dead reckoning. */
  release() {
    this.enabled = false;
    this.tracking = false;
  }

  _sample() {
    if (!this._ctx || this._video.readyState < 2) return;
    this._ctx.drawImage(this._video, 0, 0, W, H);
    const { data } = this._ctx.getImageData(0, 0, W, H);
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      // Rec. 601 luma
      this._curr[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
    }

    if (this._prev) {
      const flow = matchFlow(this._prev, this._curr);
      this.tracking = !!flow;
      if (flow && this.enabled) {
        // Rotation compensation: the orientation stream knows how much of the
        // scene shift came from tilting the phone. Small-angle delta about the
        // screen x/y axes shifts the image by f*theta; remove it before
        // treating what remains as translation.
        this._q.set(...this.orientation.read());
        this._dq.copy(this._lastQ).invert().multiply(this._q);
        this._lastQ.copy(this._q);
        const rx = 2 * this._dq.x; // small-angle rotation vector, rad
        const ry = 2 * this._dq.y;

        const tx = flow.dx - FLOW_PER_RAD * rx;
        const ty = flow.dy - FLOW_PER_RAD * ry;
        this.flowX = tx;
        this.flowY = ty;

        // Scene shifts opposite the hand. Front-camera frames arrive in sensor
        // orientation; a portrait-held phone gets a landscape frame, so map
        // image axes onto recentered-frame +X (right) / +Y (up) through the
        // screen angle. Signs verified on-device; flip here, not downstream.
        const angle = ((screen.orientation?.angle ?? 0) * Math.PI) / 180;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        let mx = (-tx * cos - -ty * sin) * PX_TO_M;
        let my = (-tx * sin + -ty * cos) * PX_TO_M;
        const m = Math.hypot(mx, my);
        if (m > MAX_FRAME_M) {
          mx *= MAX_FRAME_M / m;
          my *= MAX_FRAME_M / m;
        }
        this.dx += mx;
        this.dy += my;
      }
    }

    // Frame buffers swap: current becomes next iteration's previous.
    const swap = this._prev;
    this._prev = this._curr;
    this._curr = swap ?? new Uint8Array(W * H);
  }

  /**
   * Consume the displacement accumulated since the last call.
   * @returns {[number,number,number]|null} metres in the recentered frame
   */
  read() {
    if (this.dx === 0 && this.dy === 0) return null;
    const out = [this.dx, this.dy, 0];
    this.dx = 0;
    this.dy = 0;
    return out;
  }
}
