/**
 * The Volume engine: the cross-section from a labelled voxel volume.
 *
 * ROADMAP.md Part C. The mesh engine derives the scan plane's cross-section
 * from the organ meshes with stencil capping, which needs closed surfaces and
 * up to seven passes per organ. This engine samples a label volume
 * (pipeline/voxelize.py: one byte per 1.5 mm voxel naming the mesh it fell
 * inside) with ONE fragment shader:
 *
 *   panel pixel -> probe-local (lx, ly) -> world point on the scan plane
 *               -> (undeformed point, under the dynamics warp)
 *               -> voxel -> label -> grey (or colour, for the 3D cut face)
 *
 * ## Sub-voxel edges without a distance field
 *
 * Nearest-voxel labels show 1.5 mm stair-steps at the panel's scale. Instead
 * of a per-organ distance atlas, `labelSmooth` takes the TRILINEAR ARGMAX of
 * the eight voxels around the sample point: each label's indicator (0/1) is
 * interpolated and the label with the largest weight wins. Between two
 * labels that puts the boundary at the 0.5 crossing between voxel centres —
 * exactly the surface marching cubes would extract from the mask — so
 * stair-steps become planes and the edge error drops from a voxel to about
 * a quarter of one, with no extra data. Four taps a quarter-voxel apart
 * then anti-alias the remaining hard edge.
 *
 * ## Shadow, dynamics, Doppler
 *
 * The acoustic shadow is the same shader marching from the pixel toward the
 * transducer and stopping at a bone label. The dynamics warp (dynamics.js)
 * is applied as an INVERSE displacement before sampling, so the beating
 * heart and pulsing vessels cost nothing beyond a few flops per sample.
 * Colour and power Doppler colour the lumen labels inside the colour box by
 * the assigned flow's component along the beam, with aliasing above the
 * Nyquist scale and nothing at 90 degrees — the two things a learner has to
 * see to understand the modality.
 *
 * Both views sample the SAME volume at the SAME plane with the same shader
 * (one #define apart) and the same uniform object, so they cannot disagree.
 */

import * as THREE from 'three';
import { classify } from './models.js';
import { sectorExtent } from './probe.js';
import { DYN_GLSL_FIELD, DYN_GLSL_UNIFORMS, dynKindFor } from './dynamics.js';

const SHADOW_STEPS = 64;
/** Metres. Same role as Panel2D's SHADOW_RIND (which is in UV): the bright
 *  cortical line a bone keeps before it shadows itself. */
const SHADOW_RIND_M = 0.003;
/** Panel2D attenuates to 0.06 in LINEAR light and then encodes to sRGB, so a
 *  shadowed liver reads ~33 and a rib's own body ~67 on screen. This shader
 *  works directly in the palette's sRGB greys, so the floor is the sRGB
 *  encoding of that same 0.06: without this the two engines disagreed by a
 *  factor of four inside every rib shadow. */
const SHADOW_FLOOR = Math.pow(0.06, 1 / 2.2);

const COMMON = /* glsl */`
  precision highp float;
  precision highp sampler3D;
  uniform sampler3D tVol;
  uniform sampler2D tPal;     // r: grey (sRGB byte), g: bone flag, b: muscle flag, a: dyn kind / 8
  uniform sampler2D tCol;     // rgb: 3D cap colour (sRGB bytes), a: flow kind (0 none, 1 artery, 2 vein, 3 chamber) / 4
  uniform sampler2D tFlow;    // rgb: flow direction encoded (d+1)/2, a: peak speed / 2 (m/s)
  uniform vec3 uOrigin;       // volume corner, world metres
  uniform vec3 uInvSize;      // 1 / (dims * voxel)
  uniform vec3 uVoxel;        // voxel size per axis, metres
  uniform vec3 uDims;
  uniform mat4 uProbe;        // probe local -> world
  uniform mat4 uProbeInv;     // world -> probe local
  uniform vec4 uView;         // cx, cy, halfW, halfH (panel frustum, probe-local metres)
  uniform float uLinear, uHalfAngle, uR0, uDepth, uHalfWidth;
  uniform float uFloor, uRind, uShadow, uMuscle;
  // Doppler
  uniform float uDoppler;     // 0 off, 1 colour, 2 power
  uniform float uNyquist;     // m/s
  uniform vec4 uBox;          // colour box, probe-local: x0, x1, y0, y1
  uniform vec3 uApexWorld;    // transducer apex, world (sector probes)
  uniform vec3 uBeamWorld;    // probe -Y in world (linear probes)
  uniform float uChamberFlow; // -1..1, sign along the heart axis
  uniform float uPulseFlow;   // artery(phi) for speed modulation
  uniform float uInspFlow;
  ${DYN_GLSL_UNIFORMS}
  ${DYN_GLSL_FIELD}

  vec4 palAt(float lab) { return texture(tPal, vec2((lab + 0.5) / 256.0, 0.5)); }
  vec4 colAt(float lab) { return texture(tCol, vec2((lab + 0.5) / 256.0, 0.5)); }
  vec4 flowAt(float lab) { return texture(tFlow, vec2((lab + 0.5) / 256.0, 0.5)); }

  float rawLabel(vec3 w) {
    vec3 t = (w - uOrigin) * uInvSize;
    if (any(lessThan(t, vec3(0.0))) || any(greaterThan(t, vec3(1.0)))) return 0.0;
    float lab = floor(texture(tVol, t).r * 255.0 + 0.5);
    if (uMuscle < 0.5 && palAt(lab).b > 0.5) return 0.0;
    return lab;
  }

  /** Undeformed sample position for display point w (inverse warp). */
  vec3 source(vec3 w) {
    if (uDynOn < 0.5) return w;
    float lab = rawLabel(w);
    float kind = floor(palAt(lab).a * 8.0 + 0.5);
    return w + dynDisplace(w, kind);
  }

  /** Trilinear argmax over the eight neighbours: sub-voxel boundaries. */
  float labelSmooth(vec3 w) {
    vec3 v = (w - uOrigin) / uVoxel - 0.5;
    vec3 i0 = floor(v);
    vec3 f = v - i0;
    float labs[8];
    float wts[8];
    int n = 0;
    for (int k = 0; k < 8; k++) {
      vec3 o = vec3(float(k & 1), float((k >> 1) & 1), float((k >> 2) & 1));
      vec3 tc = (i0 + o + 0.5) / uDims;
      float l = 0.0;
      if (all(greaterThanEqual(tc, vec3(0.0))) && all(lessThanEqual(tc, vec3(1.0)))) {
        l = floor(texture(tVol, tc).r * 255.0 + 0.5);
        if (uMuscle < 0.5 && palAt(l).b > 0.5) l = 0.0;
      }
      float wt = (o.x > 0.5 ? f.x : 1.0 - f.x) * (o.y > 0.5 ? f.y : 1.0 - f.y) * (o.z > 0.5 ? f.z : 1.0 - f.z);
      bool found = false;
      for (int j = 0; j < 8; j++) {
        if (j < n && labs[j] == l) { wts[j] += wt; found = true; }
      }
      if (!found) { labs[n] = l; wts[n] = wt; n++; }
    }
    float best = 0.0;
    float bw = -1.0;
    for (int j = 0; j < 8; j++) {
      if (j < n && wts[j] > bw) { bw = wts[j]; best = labs[j]; }
    }
    return best;
  }

  bool inSector(vec2 p) {
    if (uLinear > 0.5) return abs(p.x) <= uHalfWidth && p.y <= 0.0 && p.y >= -uDepth;
    vec2 d = p - vec2(0.0, uR0);
    float r = length(d);
    float a = atan(d.x, -d.y);
    return r >= uR0 && r <= uR0 + uDepth && abs(a) <= uHalfAngle;
  }

  /**
   * Doppler colour for a lumen label at world point w, or the input colour.
   * BART: red toward the transducer, blue away; saturation by speed up to the
   * Nyquist scale, above which it wraps (aliasing). Power: angle-independent.
   */
  vec3 doppler(vec3 base, float lab, vec3 w, vec2 local) {
    if (uDoppler < 0.5) return base;
    vec4 c = colAt(lab);
    float kind = floor(c.a * 4.0 + 0.5);
    if (kind < 0.5) return base;
    if (local.x < uBox.x || local.x > uBox.y || local.y < uBox.z || local.y > uBox.w) return base;
    vec4 fl = flowAt(lab);
    vec3 dir = fl.rgb * 2.0 - 1.0;
    float speed = fl.a * 2.0;
    if (kind == 1.0) speed *= 0.25 + 0.75 * uPulseFlow;
    else if (kind == 2.0) speed *= 0.7 + 0.3 * uInspFlow;
    else speed *= uChamberFlow;             // signed: outflow +, inflow -
    vec3 v = dir * speed;
    vec3 beam = uLinear > 0.5 ? uBeamWorld : normalize(w - uApexWorld);   // into the body
    float vax = dot(v, beam);                // + away from the transducer
    if (uDoppler > 1.5) {
      float p = clamp(length(v) / uNyquist, 0.0, 1.0);
      if (p < 0.05) return base;
      return mix(vec3(0.55, 0.2, 0.0), vec3(1.0, 0.75, 0.2), p);
    }
    if (abs(vax) < 0.04) return base;        // wall filter
    // Aliasing: wrap into (-N, N].
    float n = uNyquist;
    vax = mod(vax + n, 2.0 * n) - n;
    float m = clamp(abs(vax) / n, 0.0, 1.0);
    vec3 toward = mix(vec3(0.6, 0.0, 0.0), vec3(1.0, 0.95, 0.3), m);
    vec3 away = mix(vec3(0.0, 0.0, 0.6), vec3(0.3, 0.95, 1.0), m);
    return vax < 0.0 ? toward : away;
  }

  // Four taps a quarter-voxel apart, averaged: a cheap anti-alias.
  vec3 shade(vec2 local, bool colour, out float lab0, out vec3 w0) {
    vec3 w = (uProbe * vec4(local, 0.0, 1.0)).xyz;
    w0 = w;
    vec3 ws = source(w);
    vec3 dx = (uProbe * vec4(1.0, 0.0, 0.0, 0.0)).xyz * uVoxel.x * 0.25;
    vec3 dy = (uProbe * vec4(0.0, 1.0, 0.0, 0.0)).xyz * uVoxel.y * 0.25;
    lab0 = labelSmooth(ws);
    float l1 = labelSmooth(ws + dx + dy);
    float l2 = labelSmooth(ws - dx + dy);
    float l3 = labelSmooth(ws + dx - dy);
    float l4 = labelSmooth(ws - dx - dy);
    vec3 acc;
    if (colour) {
      acc = colAt(l1).rgb + colAt(l2).rgb + colAt(l3).rgb + colAt(l4).rgb;
    } else {
      acc = vec3(palAt(l1).r + palAt(l2).r + palAt(l3).r + palAt(l4).r);
    }
    return acc * 0.25;
  }

  float shadowAt(vec2 local) {
    if (uShadow < 0.5) return 0.0;
    vec2 apex = vec2(0.0, uR0);
    vec2 toApex = uLinear > 0.5 ? vec2(0.0, 1.0) : normalize(apex - local);
    float span = uLinear > 0.5 ? -local.y : (length(apex - local) - uR0);
    float hit = 0.0;
    if (span > uRind) {
      for (int i = 1; i <= ${SHADOW_STEPS}; i++) {
        float d = uRind + (span - uRind) * (float(i) / float(${SHADOW_STEPS}));
        vec2 q = local + toApex * d;
        float l = rawLabel((uProbe * vec4(q, 0.0, 1.0)).xyz);
        hit = max(hit, step(0.5, palAt(l).g));
      }
    }
    return hit;
  }

  // GLSL3: three.js does not alias gl_FragColor for explicit-version shaders.
  out vec4 fragColor;
`;

const PANEL_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const PANEL_FRAG = COMMON + /* glsl */`
  varying vec2 vUv;
  void main() {
    vec2 ndc = vUv * 2.0 - 1.0;
    // Inverse of Panel2D._map: probe-local +X is on the panel's LEFT.
    vec2 local = vec2(uView.x - ndc.x * uView.z, uView.y + ndc.y * uView.w);
    if (!inSector(local)) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    float lab; vec3 w;
    vec3 grey = shade(local, false, lab, w);
    float hit = shadowAt(local);
    vec3 col = grey * mix(1.0, uFloor, hit);
    col = doppler(col, lab, w, local);
    fragColor = vec4(col, 1.0);
  }
`;

const CUT_VERT = /* glsl */`
  varying vec3 vWorld;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const CUT_FRAG = COMMON + /* glsl */`
  varying vec3 vWorld;
  void main() {
    vec2 local = (uProbeInv * vec4(vWorld, 1.0)).xy;
    if (!inSector(local)) discard;
    float lab; vec3 w;
    vec3 col = shade(local, true, lab, w);
    if (lab < 0.5) discard;           // empty: let the 3D scene show through
    float hit = shadowAt(local);
    col = col * mix(1.0, uFloor, hit);
    col = doppler(col, lab, w, local);
    fragColor = vec4(col, 1.0);
  }
`;

export class VolumeEngine {
  /** @param {object} dynUniforms shared dynamics uniforms (dynamics.js) */
  constructor(dynUniforms) {
    this.ready = false;
    this.meta = null;
    this.texture = null;
    this.names = [];
    this.uniforms = {
      tVol: { value: null },
      tPal: { value: null },
      tCol: { value: null },
      tFlow: { value: null },
      uOrigin: { value: new THREE.Vector3() },
      uInvSize: { value: new THREE.Vector3() },
      uVoxel: { value: new THREE.Vector3() },
      uDims: { value: new THREE.Vector3(1, 1, 1) },
      uProbe: { value: new THREE.Matrix4() },
      uProbeInv: { value: new THREE.Matrix4() },
      uView: { value: new THREE.Vector4(0, 0, 0.1, 0.1) },
      uLinear: { value: 0 },
      uHalfAngle: { value: 0.5 },
      uR0: { value: 0.05 },
      uDepth: { value: 0.2 },
      uHalfWidth: { value: 0.02 },
      uFloor: { value: SHADOW_FLOOR },
      uRind: { value: SHADOW_RIND_M },
      uShadow: { value: 1 },
      uMuscle: { value: 0 },
      uDoppler: { value: 0 },
      uNyquist: { value: 0.6 },
      uBox: { value: new THREE.Vector4(-0.05, 0.05, -0.15, -0.04) },
      uApexWorld: { value: new THREE.Vector3() },
      uBeamWorld: { value: new THREE.Vector3(0, -1, 0) },
      uChamberFlow: { value: 0 },
      uPulseFlow: { value: 0 },
      uInspFlow: { value: 0 },
      ...dynUniforms,
    };

    this.panelMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: PANEL_VERT,
      fragmentShader: PANEL_FRAG,
      uniforms: this.uniforms,
      depthTest: false,
      depthWrite: false,
    });
    this.panelScene = new THREE.Scene();
    this.panelScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.panelMaterial));
    this.panelCamera = new THREE.Camera();

    // The 3D cut face: a quad on the scan plane, child of the probe, sized to
    // the sector each time the profile changes. Drawn after the opaque
    // surfaces; clipping planes none (it IS the cut).
    this.cutMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: CUT_VERT,
      fragmentShader: CUT_FRAG,
      uniforms: this.uniforms,
      side: THREE.DoubleSide,
    });
    this.cutQuad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.cutMaterial);
    this.cutQuad.name = 'volume-cut';
    this.cutQuad.renderOrder = 600;
    this.cutQuad.visible = false;
    this._profileKey = null;
    this._apex = new THREE.Vector3();
    this._beam = new THREE.Vector3();
  }

  /** Load `<prefix>.vol.json` + `<prefix>.vol.bin.gz`. `flow` is the
   *  dynamics flow table (Map name -> {dir, speed, kind}), may be empty. */
  async load(prefix, onProgress, flow = new Map()) {
    const meta = await (await fetch(`${prefix}.vol.json`)).json();
    const res = await fetch(`${prefix}.vol.bin.gz`);
    let bytes = new Uint8Array(await res.arrayBuffer());
    onProgress?.(0.5);
    // Workers Static Assets serve the .gz as-is; a server that transparently
    // decoded it would hand back the raw volume, so check the magic bytes
    // rather than assuming either.
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      const ds = new DecompressionStream('gzip');
      const stream = new Blob([bytes]).stream().pipeThrough(ds);
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    const [nx, ny, nz] = meta.dims;
    if (bytes.length !== nx * ny * nz) {
      throw new Error(`volume size mismatch: ${bytes.length} vs ${nx * ny * nz}`);
    }
    onProgress?.(0.9);

    const tex = new THREE.Data3DTexture(bytes, nx, ny, nz);
    tex.format = THREE.RedFormat;
    tex.type = THREE.UnsignedByteType;
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;

    this.dispose();
    this.meta = meta;
    this.names = meta.names;
    this.bytes = bytes;
    this.texture = tex;
    this.uniforms.tVol.value = tex;
    this.uniforms.uOrigin.value.fromArray(meta.origin);
    this.uniforms.uVoxel.value.set(meta.voxel, meta.voxel, meta.voxel);
    this.uniforms.uDims.value.set(nx, ny, nz);
    this.uniforms.uInvSize.value.set(1 / (nx * meta.voxel), 1 / (ny * meta.voxel), 1 / (nz * meta.voxel));
    this.setFlow(flow);
    this.ready = true;
    onProgress?.(1);
    return meta;
  }

  /** (Re)build the palettes; call again when the flow table changes. */
  setFlow(flow) {
    if (!this.meta) return;
    const pal = new Uint8Array(256 * 4);
    const col = new Uint8Array(256 * 4);
    const flo = new Uint8Array(256 * 4);
    this.meta.names.forEach((name, i) => {
      if (i === 0 || !name) return;
      const spec = classify(name);
      pal[i * 4] = Math.round(spec.grey * 255);
      pal[i * 4 + 1] = spec.bone ? 255 : 0;
      pal[i * 4 + 2] = spec.muscle ? 255 : 0;
      pal[i * 4 + 3] = Math.round((dynKindFor(name) / 8) * 255);
      col[i * 4] = (spec.cap >> 16) & 255;
      col[i * 4 + 1] = (spec.cap >> 8) & 255;
      col[i * 4 + 2] = spec.cap & 255;
      const f = flow.get(name);
      col[i * 4 + 3] = f ? Math.round((f.kind / 4) * 255) : 0;
      if (f) {
        flo[i * 4] = Math.round((f.dir.x + 1) / 2 * 255);
        flo[i * 4 + 1] = Math.round((f.dir.y + 1) / 2 * 255);
        flo[i * 4 + 2] = Math.round((f.dir.z + 1) / 2 * 255);
        flo[i * 4 + 3] = Math.round(Math.min(f.speed / 2, 1) * 255);
      }
    });
    const mk = (data) => {
      const t = new THREE.DataTexture(data, 256, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.minFilter = THREE.NearestFilter;
      t.magFilter = THREE.NearestFilter;
      t.needsUpdate = true;
      return t;
    };
    for (const k of ['tPal', 'tCol', 'tFlow']) this.uniforms[k].value?.dispose();
    this.uniforms.tPal.value = mk(pal);
    this.uniforms.tCol.value = mk(col);
    this.uniforms.tFlow.value = mk(flo);
  }

  /** Label at a world point from the CPU copy (nearest voxel), for the
   *  spectral Doppler gate. 0 outside the volume. */
  labelAtWorld(p) {
    if (!this.ready) return 0;
    const m = this.meta;
    const ix = Math.floor((p.x - m.origin[0]) / m.voxel);
    const iy = Math.floor((p.y - m.origin[1]) / m.voxel);
    const iz = Math.floor((p.z - m.origin[2]) / m.voxel);
    const [nx, ny, nz] = m.dims;
    if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return 0;
    return this.bytes[(iz * ny + iy) * nx + ix];
  }

  dispose() {
    this.texture?.dispose();
    for (const k of ['tPal', 'tCol', 'tFlow']) this.uniforms[k].value?.dispose();
    this.texture = null;
    this.ready = false;
  }

  /**
   * Per frame: the probe transform, the panel frustum, the beam profile, and
   * the Doppler state. `view` is Panel2D's {cx, cy, halfW, halfH}.
   */
  update(probe, profile, view, showMuscles = false, dopplerState = null) {
    const u = this.uniforms;
    u.uMuscle.value = showMuscles ? 1 : 0;
    u.uProbe.value.copy(probe.matrixWorld);
    u.uProbeInv.value.copy(probe.matrixWorld).invert();
    u.uView.value.set(view.cx, view.cy, view.halfW, view.halfH);
    const linear = profile.kind === 'linear';
    u.uLinear.value = linear ? 1 : 0;
    u.uDepth.value = profile.depth;
    u.uHalfWidth.value = profile.halfWidth ?? 0;
    u.uR0.value = linear ? 0 : profile.originOffset;
    u.uHalfAngle.value = linear ? 0 : profile.halfAngle;
    // Beam geometry in world space for the Doppler angle.
    this._apex.set(0, linear ? 0 : profile.originOffset, 0).applyMatrix4(probe.matrixWorld);
    u.uApexWorld.value.copy(this._apex);
    this._beam.set(0, -1, 0).transformDirection(probe.matrixWorld);
    u.uBeamWorld.value.copy(this._beam);
    if (dopplerState) {
      u.uDoppler.value = dopplerState.mode;
      u.uNyquist.value = dopplerState.nyquist;
      u.uChamberFlow.value = dopplerState.chamberFlow;
      u.uPulseFlow.value = dopplerState.pulse;
      u.uInspFlow.value = dopplerState.insp;
      // Colour box: the middle 60% of the sector width over 20-75% of depth.
      const d = profile.depth;
      const hw = linear ? (profile.halfWidth ?? 0.02) * 0.8 : Math.sin(profile.halfAngle) * (profile.originOffset + d * 0.5) * 0.6;
      u.uBox.value.set(-hw, hw, -d * 0.75, -d * 0.2);
    } else {
      u.uDoppler.value = 0;
    }

    const key = `${profile.label}:${profile.depth.toFixed(3)}`;
    if (key !== this._profileKey) {
      this._profileKey = key;
      const ext = sectorExtent(profile);
      this.cutQuad.position.set((ext.minX + ext.maxX) / 2, (ext.minY + ext.maxY) / 2, 0);
      this.cutQuad.scale.set(ext.width * 1.02, ext.height * 1.02, 1);
    }
  }

  /** The colour box in probe-local metres, for the overlay. */
  get box() {
    const b = this.uniforms.uBox.value;
    return { x0: b.x, x1: b.y, y0: b.z, y1: b.w };
  }

  /** Draw the panel: one quad, no scene traversal. */
  renderPanel(renderer, setViewport) {
    setViewport();
    renderer.clear(true, true, true);
    renderer.render(this.panelScene, this.panelCamera);
  }
}
