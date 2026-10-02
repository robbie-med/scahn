/**
 * Dynamics: the cardiac and respiratory clock, the deformation fields, and
 * the flow table for Doppler. ROADMAP Part B, built on the volume engine.
 *
 * The product rule still holds — nothing here is physics. A beating heart is
 * geometry moving on a clock; Doppler is geometry coloured by a velocity it
 * has been assigned. Both are teaching aids about what the learner will see
 * from a given probe position, and why the colour disappears at 90 degrees.
 *
 * ## One field, two directions
 *
 * The volume shader (volume.js) samples the UNDEFORMED volume at
 * `w + d(w)` for a display point `w` — the inverse warp. The 3D mesh
 * surfaces move FORWARD: `p' = p − d(p)` in the vertex shader. Both use the
 * formulas below with the same uniforms, so the cut face and the surface
 * agree to first order in the amplitude, which at ≤ 1.5 cm is below a voxel
 * of disagreement.
 *
 * ## The heart field
 *
 *   t   = clamp(dot(p − apex, axis) / L, 0, 1)      0 at the apex, 1 at the base
 *   ρ   = p − (apex + t·L·axis)                     radial vector from the long axis
 *   d   = s(φ) · falloff · (k_long · t · L · axis + k_rad · ρ)
 *
 * The apex is the origin because a real apex does not move on an echo: the
 * base descends toward it (MAPSE 12–15 mm on an 11 cm heart). Cavities
 * contract radially more than the wall's outer surface, so the wall
 * thickens, which is what a learner sees. Atria run on their own curve, with
 * the a-wave kick late in diastole.
 */

import * as THREE from 'three';

/** Fraction of the cycle spent in ventricular systole at 70 bpm; the
 *  absolute systolic time is roughly fixed (~300 ms), so it shortens as the
 *  rate rises. */
const SYSTOLE_MS = 300;

const smooth = (a, b, x) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};
const bump = (x, c, w) => {
  const d = Math.abs(x - c) / w;
  return d >= 1 ? 0 : 0.5 * (1 + Math.cos(Math.PI * d));
};

export const DEFAULTS = Object.freeze({
  bpm: 70,
  respPerMin: 14,
  /** Ventricular long-axis shortening and radial contraction at peak systole. */
  kLong: 0.2,
  kRadChamber: 0.35,
  kRadWall: 0.09,
  /** Atrial contraction amplitude at the a-wave. */
  kAtrium: 0.12,
  /** Aorta radial pulsation (fraction of radius) and IVC collapse (fraction). */
  aortaPulse: 0.05,
  ivcCollapse: 0.4,
  /** Doppler scale (Nyquist), metres per second. */
  nyquist: 0.6,
});

export class Dynamics {
  constructor() {
    this.bpm = DEFAULTS.bpm;
    this.paused = false;
    /** 0 = off, 1 = colour, 2 = power. */
    this.doppler = 0;
    this.nyquist = DEFAULTS.nyquist;
    this.phase = 0;      // cardiac, 0..1, 0 = end-diastole
    this.resp = 0;       // respiratory, 0..1, 0 = end-expiration
    this._last = null;

    /** Geometry, world metres. Set by fit(). */
    this.apex = new THREE.Vector3();
    this.axis = new THREE.Vector3(0, 1, 0);
    this.length = 0.1;
    this.heartCentre = new THREE.Vector3();
    this.heartRadius = 0.08;
    this.aorta = { centre: new THREE.Vector3(), y: new THREE.Vector2(0, 0), radius: 0.03 };
    this.ivc = { centre: new THREE.Vector3(), y: new THREE.Vector2(0, 0), radius: 0.03 };
    this.ready = false;
    /** Per label name: { dir: Vector3 (world, unit), speed: m/s peak, kind }. */
    this.flow = new Map();
  }

  /** Advance the clocks. */
  tick(nowMs) {
    if (this._last == null) { this._last = nowMs; return; }
    const dt = Math.min((nowMs - this._last) / 1000, 0.1);
    this._last = nowMs;
    if (this.paused) return;
    this.phase = (this.phase + dt * this.bpm / 60) % 1;
    this.resp = (this.resp + dt * DEFAULTS.respPerMin / 60) % 1;
  }

  /** Systole fraction of the cycle at the current rate. */
  get systoleFrac() {
    return Math.min(0.5, SYSTOLE_MS / (60000 / this.bpm));
  }

  /** Ventricular contraction 0 (end-diastole) .. 1 (end-systole). */
  ventricle(phi = this.phase) {
    const s = this.systoleFrac;
    if (phi < s) return smooth(0, s * 0.85, phi);           // ejection
    const e = (phi - s) / (1 - s);                            // diastole 0..1
    const rapid = 1 - smooth(0, 0.35, e) * 0.8;               // early rapid filling to 0.2
    const diastasis = 0.2 - smooth(0.35, 0.8, e) * 0.08;      // slow filling to 0.12
    const kick = 0.12 - smooth(0.8, 1.0, e) * 0.12;           // atrial kick to 0
    return e < 0.35 ? rapid : (e < 0.8 ? diastasis : kick);
  }

  /** Atrial contraction 0..1: relaxed (full) at end of ventricular systole,
   *  the a-wave contraction late in diastole. */
  atrium(phi = this.phase) {
    const s = this.systoleFrac;
    const e = phi < s ? 0 : (phi - s) / (1 - s);
    const aWave = bump(e, 0.92, 0.16);
    // Atria also passively shrink a little as the ventricle fills from them.
    return Math.max(aWave, 0.25 * smooth(0, 0.35, e) * (1 - smooth(0.6, 0.9, e)));
  }

  /** Arterial pressure pulse 0..1 with a dicrotic notch; `delaySec` from the
   *  aortic root at ~6 m/s pulse-wave velocity. */
  artery(phi = this.phase, delaySec = 0) {
    const d = (delaySec * this.bpm) / 60;
    const x = ((phi - d) % 1 + 1) % 1;
    const s = this.systoleFrac;
    const up = smooth(0.02, 0.12, x) * (1 - 0.25 * smooth(0.2, s, x));
    const notch = -0.08 * bump(x, s + 0.03, 0.04);
    const decay = (1 - smooth(s, 1.0, x)) ;
    return Math.max(0, Math.min(1, (x < s ? up : 0.75 * decay) + notch));
  }

  /** Inspiration 0..1 (inspiratory IVC collapse peaks at 1). */
  inspiration(r = this.resp) {
    return 0.5 * (1 - Math.cos(2 * Math.PI * r));
  }

  /** Chamber flow direction sign along the long axis: +1 toward the base
   *  (outflow, systole), −1 toward the apex (inflow, diastole). */
  chamberFlow(phi = this.phase) {
    const s = this.systoleFrac;
    if (phi < s) return smooth(0, s * 0.3, phi) * (1 - smooth(s * 0.8, s, phi));
    const e = (phi - s) / (1 - s);
    return -(bump(e, 0.2, 0.2) + 0.6 * bump(e, 0.92, 0.1));
  }

  /**
   * Derive the geometry from the loaded organs (CappedOrgan list), by anatomy:
   * the apex is the LV vertex farthest from the mitral valve's centroid, the
   * long axis points from it to that centroid. Vessels get a vertical axis
   * through their bounding-box centre and the box's y-range.
   */
  fit(organs) {
    const byName = Object.fromEntries(organs.map((o) => [o.name, o]));
    const lv = byName['chamber-lv'];
    const mitral = byName['heart-valve-mitral'];
    this.ready = false;
    if (!lv || !mitral) return false;
    const mc = centroid(mitral.geometry);
    const pos = lv.geometry.attributes.position;
    let best = -1;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const d = v.distanceToSquared(mc);
      if (d > best) { best = d; this.apex.copy(v); }
    }
    this.axis.copy(mc).sub(this.apex);
    this.length = this.axis.length();
    this.axis.normalize();
    const hb = new THREE.Box3();
    for (const o of organs) if (o.group === 'heart') { o.geometry.computeBoundingBox(); hb.union(o.geometry.boundingBox); }
    hb.getCenter(this.heartCentre);
    this.heartRadius = hb.getSize(new THREE.Vector3()).length() / 2 * 1.1;

    const vessel = (names, out) => {
      const box = new THREE.Box3();
      for (const n of names) { const o = byName[n]; if (o) { o.geometry.computeBoundingBox(); box.union(o.geometry.boundingBox); } }
      if (box.isEmpty()) return false;
      box.getCenter(out.centre);
      out.y.set(box.min.y, box.max.y);
      const sz = box.getSize(new THREE.Vector3());
      out.radius = Math.max(sz.x, sz.z) / 2 + 0.015;
      return true;
    };
    vessel(['aorta-abdominal', 'aorta-descending'], this.aorta);
    vessel(['vena-cava-inferior'], this.ivc);

    this.buildFlow(byName);
    this.ready = true;
    return true;
  }

  /**
   * Flow directions per vessel, from anatomy rather than geometry: arteries
   * away from the aortic root, veins toward the heart. Chambers flow along
   * the long axis with the sign from chamberFlow(). Speeds are peak m/s,
   * textbook order of magnitude.
   */
  buildFlow(byName) {
    const F = this.flow;
    F.clear();
    const set = (name, dir, speed, kind) => {
      if (!byName[name]) return;
      F.set(name, { dir: new THREE.Vector3(...dir).normalize(), speed, kind });
    };
    const ax = this.axis;
    // Arteries (kind 1)
    set('aorta-ascending', [0, 1, 0], 1.2, 1);
    set('aorta-arch', [1, 0, -0.4], 1.0, 1);
    set('aorta-descending', [0, -1, 0], 1.0, 1);
    set('aorta-abdominal', [0, -1, 0], 0.9, 1);
    set('artery-mesenteric-superior', [0, -0.9, 0.3], 0.8, 1);
    set('artery-pulmonary-trunk', [0, 0.8, -0.4], 0.9, 1);
    set('artery-pulmonary-left', [1, 0.2, -0.3], 0.7, 1);
    set('artery-pulmonary-right', [-1, 0.2, -0.3], 0.7, 1);
    // Veins (kind 2), toward the heart
    set('vena-cava-inferior', [0, 1, 0], 0.35, 2);
    set('vena-cava-superior', [0, -1, 0], 0.35, 2);
    set('vein-hepatic', [0, 0.7, -0.5], 0.3, 2);
    set('vein-portal', [-0.6, 0.5, 0.3], 0.25, 2);
    set('vein-splenic', [-1, 0, 0], 0.25, 2);
    // Chambers (kind 3): along the long axis, sign by phase
    for (const n of ['chamber-lv', 'chamber-rv', 'chamber-la', 'chamber-ra']) set(n, [ax.x, ax.y, ax.z], 0.9, 3);
  }

  /** Values for this frame, as plain numbers for uniforms. */
  sample() {
    const delay = this.aorta.y.x < 0 ? 0.04 : 0;
    return {
      sV: this.ventricle(),
      sA: this.atrium(),
      pulse: this.artery(this.phase, delay),
      insp: this.inspiration(),
      chamberFlow: this.chamberFlow(),
    };
  }
}

function centroid(geometry) {
  geometry.computeBoundingBox();
  return geometry.boundingBox.getCenter(new THREE.Vector3());
}

/**
 * GLSL for the forward displacement, shared by the mesh materials. The
 * uniforms are the same object the volume shader binds (DYN_UNIFORMS keys).
 */
export const DYN_GLSL_UNIFORMS = /* glsl */`
  uniform float uDynOn, uSV, uSA, uPulse, uInsp;
  uniform float uKLong, uKRadChamber, uKRadWall, uKAtrium, uAortaPulse, uIvcCollapse;
  uniform vec3 uApex, uAxis, uHeartC;
  uniform float uHeartL, uHeartR;
  uniform vec3 uAortaC; uniform vec2 uAortaY; uniform float uAortaR;
  uniform vec3 uIvcC; uniform vec2 uIvcY; uniform float uIvcR;
`;

/**
 * d(p, kind): kind 0 = other tissue, 1 ventricle cavity, 2 atrial cavity,
 * 3 heart wall/valve/papillary, 4 artery (big aorta), 5 IVC. Returns the
 * forward displacement; the volume shader adds it (inverse), meshes subtract.
 */
export const DYN_GLSL_FIELD = /* glsl */`
  vec3 dynDisplace(vec3 p, float kind) {
    if (uDynOn < 0.5) return vec3(0.0);
    vec3 d = vec3(0.0);
    // Heart: everything inside the heart's sphere moves with it, fading at the rim.
    float hr = distance(p, uHeartC) / uHeartR;
    if (hr < 1.0) {
      // tu runs 0 at the apex to 1 at the mitral plane and beyond 1 into the
      // atria. The wall is ONE fused mesh, so its atrial part has to follow
      // the atrial curve or it tears away from the atrial cavities at the
      // base; blend by position rather than by label.
      float tu = dot(p - uApex, uAxis) / uHeartL;
      float t = clamp(tu, 0.0, 1.0);
      vec3 rho = p - (uApex + t * uHeartL * uAxis);
      float atrial = smoothstep(0.85, 1.15, tu);
      float s = mix(uSV, uSA, atrial);
      float kr = mix(uKRadWall, uKAtrium, atrial);
      if (kind == 1.0) { kr = uKRadChamber; s = uSV; }
      else if (kind == 2.0) { kr = uKAtrium; s = uSA; }
      else if (kind != 3.0) { kr *= 0.5; }
      float fw = 1.0 - smoothstep(0.75, 1.0, hr);
      // The base (and the atria above it) descends toward the apex on the
      // ventricular curve; the radial term uses each region's own curve.
      d += fw * (uSV * uKLong * clamp(tu, 0.0, 1.3) * uHeartL * uAxis + s * kr * rho);
    }
    // Aorta: radial pulsation about a vertical axis through its centre.
    vec2 ra = vec2(p.x - uAortaC.x, p.z - uAortaC.z);
    float la = length(ra) / uAortaR;
    if (la < 1.0 && p.y > uAortaY.x && p.y < uAortaY.y) {
      float fw = 1.0 - smoothstep(0.5, 1.0, la);
      d -= uAortaPulse * uPulse * fw * vec3(ra.x, 0.0, ra.y);   // outward = negative source shift
    }
    // IVC: inspiratory collapse about its own axis.
    vec2 ri = vec2(p.x - uIvcC.x, p.z - uIvcC.z);
    float li = length(ri) / uIvcR;
    if (li < 1.0 && p.y > uIvcY.x && p.y < uIvcY.y) {
      float fw = 1.0 - smoothstep(0.5, 1.0, li);
      d += uIvcCollapse * uInsp * fw * vec3(ri.x, 0.0, ri.y);
    }
    return d;
  }
`;

/** Build the uniform object once; both engines and the mesh materials share it. */
export function makeDynUniforms() {
  return {
    uDynOn: { value: 0 },
    uSV: { value: 0 }, uSA: { value: 0 }, uPulse: { value: 0 }, uInsp: { value: 0 },
    uKLong: { value: DEFAULTS.kLong }, uKRadChamber: { value: DEFAULTS.kRadChamber },
    uKRadWall: { value: DEFAULTS.kRadWall }, uKAtrium: { value: DEFAULTS.kAtrium },
    uAortaPulse: { value: DEFAULTS.aortaPulse }, uIvcCollapse: { value: DEFAULTS.ivcCollapse },
    uApex: { value: new THREE.Vector3() }, uAxis: { value: new THREE.Vector3(0, 1, 0) },
    uHeartC: { value: new THREE.Vector3() }, uHeartL: { value: 0.1 }, uHeartR: { value: 0.08 },
    uAortaC: { value: new THREE.Vector3() }, uAortaY: { value: new THREE.Vector2() }, uAortaR: { value: 0.03 },
    uIvcC: { value: new THREE.Vector3() }, uIvcY: { value: new THREE.Vector2() }, uIvcR: { value: 0.03 },
  };
}

/** Copy the frame's values into the shared uniforms. */
export function updateDynUniforms(u, dyn, on) {
  const s = dyn.sample();
  u.uDynOn.value = on && dyn.ready ? 1 : 0;
  u.uSV.value = s.sV; u.uSA.value = s.sA; u.uPulse.value = s.pulse; u.uInsp.value = s.insp;
  u.uApex.value.copy(dyn.apex); u.uAxis.value.copy(dyn.axis);
  u.uHeartC.value.copy(dyn.heartCentre); u.uHeartL.value = dyn.length; u.uHeartR.value = dyn.heartRadius;
  u.uAortaC.value.copy(dyn.aorta.centre); u.uAortaY.value.copy(dyn.aorta.y); u.uAortaR.value = dyn.aorta.radius;
  u.uIvcC.value.copy(dyn.ivc.centre); u.uIvcY.value.copy(dyn.ivc.y); u.uIvcR.value = dyn.ivc.radius;
}

/**
 * Inject the forward displacement into a mesh material (surface or ghost) via
 * onBeforeCompile. `kind` is fixed per organ. Geometry is baked in world
 * space and the group nodes are identity, so object space IS world space
 * here and the field can be applied to `transformed` directly.
 */
export function attachMeshDynamics(material, uniforms, kind) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${DYN_GLSL_UNIFORMS}\n${DYN_GLSL_FIELD}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n  transformed -= dynDisplace(transformed, ${kind.toFixed(1)});`);
  };
  material.customProgramCacheKey = () => `dyn-${kind}`;
  material.needsUpdate = true;
}

/** Kind code for an organ, by the same classification the volume palette uses. */
export function dynKindFor(name) {
  if (/^chamber-(lv|rv)$/.test(name)) return 1;
  if (/^chamber-(la|ra)$/.test(name)) return 2;
  if (/^heart-/.test(name)) return 3;
  if (/^aorta-(abdominal|descending)$/.test(name)) return 4;
  if (name === 'vena-cava-inferior') return 5;
  return 0;
}
