/**
 * Calipers that exist in 3D. ROADMAP Part A2.
 *
 * The panel is an orthographic view of the scan plane, so a point on the
 * panel IS a point in the body. A caliper is therefore stored in WORLD space
 * — two Vector3s — and drawn twice from that one truth: as crosses and a
 * dotted line on the panel's SVG overlay, and as a line with two beads in the
 * 3D scene. In ghost mode (3) the far half of every organ is translucent, so
 * the 3D segment reads as sitting inside the liver, not floating in front of
 * it, which is the point: a learner sees what a 2D measurement measures.
 *
 * Because the segment is world space, moving the probe away leaves it where
 * it was measured; the panel shows it only while the scan plane still passes
 * within PLANE_TOLERANCE of both ends (a frozen frame always does).
 */

import * as THREE from 'three';
import { CALIPER_IDS, MAX_CALIPERS } from '@scahn/protocol';
import { LAYER_3D } from './capping.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Metres either side of the plane within which a caliper is still "on" it. */
const PLANE_TOLERANCE = 0.002;
/** Machine-style colours per letter: A yellow, B cyan, C magenta, D green. */
const COLOURS = ['#ffd84a', '#5fe3ff', '#ff6ad5', '#8dff7a'];

export class Calipers {
  constructor() {
    /** @type {{id:string, a:THREE.Vector3, b:THREE.Vector3|null}[]} */
    this.items = [];
    this.group = new THREE.Group();
    this.group.name = 'calipers';
    this.group.renderOrder = 950;
    this._svgLayer = null;
    this._v = new THREE.Vector3();
    this._w = new THREE.Vector3();
    this._changed = true;
  }

  get placing() {
    const last = this.items[this.items.length - 1];
    return !!last && last.b === null;
  }

  get full() {
    return this.items.length >= MAX_CALIPERS && !this.placing;
  }

  /**
   * Add a point. The first point opens a new caliper, the second closes it.
   * Returns the caliper touched, or null when all four are used.
   */
  addPoint(world) {
    const last = this.items[this.items.length - 1];
    if (last && last.b === null) {
      last.b = world.clone();
      this._changed = true;
      return last;
    }
    if (this.items.length >= MAX_CALIPERS) return null;
    const item = { id: CALIPER_IDS[this.items.length], a: world.clone(), b: null };
    this.items.push(item);
    this._changed = true;
    return item;
  }

  /** Drop an unfinished second point (Escape). */
  cancel() {
    const last = this.items[this.items.length - 1];
    if (last && last.b === null) {
      this.items.pop();
      this._changed = true;
    }
  }

  clear() {
    this.items = [];
    this._changed = true;
  }

  /** Length of a finished caliper, metres. */
  static length(item) {
    return item.b ? item.a.distanceTo(item.b) : 0;
  }

  /** Wire form for the `state` echo. */
  toWire() {
    return this.items.filter((c) => c.b).map((c) => ({
      id: c.id, a: c.a.toArray().map((n) => +n.toFixed(4)), b: c.b.toArray().map((n) => +n.toFixed(4)),
    }));
  }

  // --- 3D ------------------------------------------------------------------

  /** Rebuild the 3D objects when the set changed. Cheap: at most four lines. */
  update3D() {
    if (!this._changed) return;
    this._changed = false;
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      child.geometry?.dispose();
      child.material?.dispose();
    }
    this.items.forEach((c, i) => {
      const colour = new THREE.Color(COLOURS[i % COLOURS.length]);
      const bead = (p) => {
        const m = new THREE.Mesh(
          new THREE.SphereGeometry(0.004, 12, 8),
          new THREE.MeshBasicMaterial({ color: colour, depthTest: false }),
        );
        m.position.copy(p);
        m.renderOrder = 951;
        m.layers.set(LAYER_3D);
        this.group.add(m);
      };
      bead(c.a);
      if (!c.b) return;
      bead(c.b);
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([c.a, c.b]),
        new THREE.LineBasicMaterial({ color: colour, depthTest: false }),
      );
      line.renderOrder = 950;
      line.layers.set(LAYER_3D);
      this.group.add(line);
    });
  }

  // --- 2D ------------------------------------------------------------------

  /**
   * Draw onto the panel overlay. `map(lx, ly)` is Panel2D's probe-local ->
   * pixel mapping. Calipers whose ends have left the plane are not drawn, and
   * the readout for them says so.
   */
  draw2D(svg, probe, map, pending) {
    if (!this._svgLayer || this._svgLayer.ownerSVGElement !== svg || !svg.contains(this._svgLayer)) {
      this._svgLayer = document.createElementNS(SVG_NS, 'g');
      this._svgLayer.setAttribute('id', 'calipers');
      svg.appendChild(this._svgLayer);
    }
    const g = this._svgLayer;
    // Always on top of the dressing, which is rebuilt (and re-appended) on
    // profile changes.
    if (svg.lastChild !== g) svg.appendChild(g);
    while (g.firstChild) g.removeChild(g.firstChild);

    const el = (name, attrs, text) => {
      const n = document.createElementNS(SVG_NS, name);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
      if (text != null) n.textContent = text;
      g.appendChild(n);
      return n;
    };
    const toLocal = (p) => probe.worldToLocal(this._v.copy(p));
    const cross = (x, y, colour) => {
      el('line', { x1: x - 6, y1: y, x2: x + 6, y2: y, stroke: colour, 'stroke-width': 1.5 });
      el('line', { x1: x, y1: y - 6, x2: x, y2: y + 6, stroke: colour, 'stroke-width': 1.5 });
    };

    const readouts = [];
    this.items.forEach((c, i) => {
      const colour = COLOURS[i % COLOURS.length];
      const la = toLocal(c.a).clone();
      const onPlaneA = Math.abs(la.z) <= PLANE_TOLERANCE;
      if (!c.b) {
        if (onPlaneA) {
          const [x, y] = map(la.x, la.y);
          cross(x, y, colour);
          if (pending) {
            const [px, py] = map(pending.x, pending.y);
            el('line', { x1: x, y1: y, x2: px, y2: py, stroke: colour, 'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0.7 });
          }
        }
        readouts.push({ id: c.id, text: '…', colour });
        return;
      }
      const lb = toLocal(c.b).clone();
      const onPlane = onPlaneA && Math.abs(lb.z) <= PLANE_TOLERANCE;
      const cm = (Calipers.length(c) * 100).toFixed(1);
      if (onPlane) {
        const [x1, y1] = map(la.x, la.y);
        const [x2, y2] = map(lb.x, lb.y);
        el('line', { x1, y1, x2, y2, stroke: colour, 'stroke-width': 1, 'stroke-dasharray': '4 3' });
        cross(x1, y1, colour);
        cross(x2, y2, colour);
        el('text', {
          x: (x1 + x2) / 2 + 8, y: (y1 + y2) / 2 - 6, fill: colour,
          'font-size': 11, 'font-family': 'ui-monospace, monospace', 'font-weight': 700,
        }, `${c.id} ${cm}`);
      }
      readouts.push({ id: c.id, text: onPlane ? `${cm} cm` : `${cm} cm (off plane)`, colour });
    });

    // Readout list, bottom-left above the transducer line.
    const h = Number(svg.getAttribute('viewBox')?.split(' ')[3] ?? 0);
    readouts.forEach((r, i) => {
      el('text', {
        x: 12, y: h - 30 - (readouts.length - 1 - i) * 15, fill: r.colour,
        'font-size': 11, 'font-family': 'ui-monospace, monospace', 'font-weight': 700,
      }, `${r.id}  ${r.text}`);
    });
  }
}
