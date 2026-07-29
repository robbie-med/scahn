/**
 * The 2D panel. Spec section 6.5.
 *
 * An orthographic camera looking down the scan-plane normal at the probe, with
 * near/far clamped to a thin slab so only the capped cut faces render. Masked
 * to the sector silhouette and dressed with a depth scale and an orientation
 * marker, so it reads as an ultrasound screen rather than a rectangle of
 * geometry.
 *
 * Camera side matters and is not arbitrary. The camera sits on the probe's
 * local -Z side, which puts probe-local +X (the transducer's orientation
 * marker) on the LEFT of the panel — matching the convention that the marker
 * dot is drawn in the upper-left corner of a real machine's display.
 */

import * as THREE from 'three';
import { BEAM_PROFILES, sectorExtent, sectorOutline } from './probe.js';
import { LAYER_2D } from './capping.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Distance from the plane to the ortho camera. */
const CAM_DIST = 0.5;

/**
 * Depth range, metres either side of the camera distance.
 *
 * This MUST be generous enough to contain each organ whole. It is tempting to
 * clamp it to a thin slab around the plane to isolate the cut face, but that
 * silently breaks capping: the stencil pass counts back faces against front
 * faces over the *entire* solid, and a near/far plane slicing through the mesh
 * removes faces from that count, leaving the stencil balanced at zero and the
 * cap unpainted. The panel goes black and it looks like a masking bug.
 *
 * Isolating the cut face is the job of the layer split (LAYER_2D sees only the
 * stencil groups and the grey caps), not of the depth range.
 */
const DEPTH = 0.45;

const PAD = 1.06; // frustum padding around the sector

export class Panel2D {
  constructor(svgEl) {
    this.svg = svgEl;
    this.camera = new THREE.OrthographicCamera(-0.1, 0.1, 0.1, -0.1, 0.01, 1);
    // The 2D camera sees ONLY layer 1 — the stencil groups and grey caps.
    this.camera.layers.set(LAYER_2D);

    /** @type {{x:number,y:number,w:number,h:number}} */
    this.rect = { x: 0, y: 0, w: 1, h: 1 };
    this._profileName = null;
    this._frustum = null;

    this._q = new THREE.Quaternion();
    this._pos = new THREE.Vector3();
    this._x = new THREE.Vector3();
    this._y = new THREE.Vector3();
    this._z = new THREE.Vector3();
    this._center = new THREE.Vector3();
  }

  /** Position the SVG overlay to sit exactly over the panel viewport. */
  layout(rect) {
    this.rect = rect;
    const { x, y, w, h } = rect;
    Object.assign(this.svg.style, {
      left: `${x}px`,
      top: `${y}px`,
      width: `${w}px`,
      height: `${h}px`,
    });
    this.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    this._frustum = null; // force a redraw of the mask at the new size
  }

  /**
   * Re-aim the camera at the probe and, when the transducer or panel size has
   * changed, rebuild the SVG dressing.
   */
  update(probe, profileName) {
    const profile = BEAM_PROFILES[profileName];
    probe.updateMatrixWorld();
    probe.getWorldQuaternion(this._q);
    probe.getWorldPosition(this._pos);

    this._x.set(1, 0, 0).applyQuaternion(this._q);
    this._y.set(0, 1, 0).applyQuaternion(this._q);
    this._z.set(0, 0, 1).applyQuaternion(this._q);

    const ext = sectorExtent(profile);
    const cx = (ext.minX + ext.maxX) / 2;
    const cy = (ext.minY + ext.maxY) / 2;

    // Fit the sector into the panel without distorting it.
    const panelAspect = this.rect.w / Math.max(this.rect.h, 1);
    let halfW = (ext.width / 2) * PAD;
    let halfH = (ext.height / 2) * PAD;
    if (halfW / halfH < panelAspect) halfW = halfH * panelAspect;
    else halfH = halfW / panelAspect;

    const cam = this.camera;
    cam.left = -halfW; cam.right = halfW;
    cam.top = halfH; cam.bottom = -halfH;
    cam.near = CAM_DIST - DEPTH;
    cam.far = CAM_DIST + DEPTH;

    // Sector centre in world space.
    this._center.copy(this._pos)
      .addScaledVector(this._x, cx)
      .addScaledVector(this._y, cy);

    // Camera on the probe's -Z side (see the note at the top of this file).
    cam.position.copy(this._center).addScaledVector(this._z, -CAM_DIST);
    cam.up.copy(this._y);
    cam.lookAt(this._center);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();

    this._view = { cx, cy, halfW, halfH };

    const key = `${profileName}:${this.rect.w}x${this.rect.h}`;
    if (key !== this._frustumKey) {
      this._frustumKey = key;
      this._drawDressing(profile);
    }
  }

  /**
   * Probe-local metres -> panel pixels.
   *
   * The x negation is the camera-side convention made explicit: probe-local +X
   * is on the panel's LEFT. If this ever gets "simplified" away, the panel
   * mirrors and the tool starts teaching laterality backwards.
   */
  _map(lx, ly) {
    const { cx, cy, halfW, halfH } = this._view;
    const ndcX = -(lx - cx) / halfW;
    const ndcY = (ly - cy) / halfH;
    return [
      ((ndcX + 1) / 2) * this.rect.w,
      (1 - (ndcY + 1) / 2) * this.rect.h,
    ];
  }

  _drawDressing(profile) {
    const { w, h } = this.rect;
    const svg = this.svg;
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const el = (name, attrs, text) => {
      const n = document.createElementNS(SVG_NS, name);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
      if (text != null) n.textContent = text;
      svg.appendChild(n);
      return n;
    };

    // 1. The mask: fill the whole panel, punch the sector out with even-odd.
    const outline = sectorOutline(profile)
      .map((p, i) => {
        const [x, y] = this._map(p.x, p.y);
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ') + ' Z';

    el('path', {
      d: `M0,0 H${w} V${h} H0 Z ${outline}`,
      'fill-rule': 'evenodd',
      fill: '#0b0d10',
    });
    el('path', { d: outline, fill: 'none', stroke: '#2c3844', 'stroke-width': 1 });

    // 2. Depth scale down the right edge, ticks every 2 cm, labels every 5 cm.
    const depthCm = Math.round(profile.depth * 100);
    const axisX = w - 26;
    el('line', {
      x1: axisX, y1: this._map(0, 0)[1], x2: axisX, y2: this._map(0, -profile.depth)[1],
      stroke: '#4b5a68', 'stroke-width': 1,
    });
    for (let cm = 0; cm <= depthCm; cm += 2) {
      const [, y] = this._map(0, -cm / 100);
      const major = cm % 5 === 0;
      el('line', {
        x1: axisX, y1: y, x2: axisX + (major ? 9 : 5), y2: y,
        stroke: major ? '#8b98a8' : '#4b5a68', 'stroke-width': 1,
      });
      if (major && cm > 0) {
        el('text', {
          x: axisX + 12, y: y + 4, fill: '#8b98a8',
          'font-size': 10, 'font-family': 'ui-monospace, monospace',
        }, String(cm));
      }
    }
    el('text', {
      x: axisX + 12, y: 14, fill: '#5d6b7a',
      'font-size': 9, 'font-family': 'ui-monospace, monospace',
    }, 'cm');

    // 3. Orientation marker: upper-left, the side probe-local +X maps to.
    el('circle', { cx: 22, cy: 22, r: 5, fill: '#ffc94a' });

    // 4. Transducer readout, bottom-left.
    el('text', {
      x: 12, y: h - 12, fill: '#5d6b7a',
      'font-size': 11, 'font-family': 'ui-sans-serif, system-ui, sans-serif',
    }, profile.label);
  }
}
