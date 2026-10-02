/**
 * The Volume engine: the cross-section from a labelled voxel volume.
 *
 * ROADMAP.md Part C. The mesh engine derives the scan plane's cross-section
 * from the organ meshes with stencil capping, which needs closed surfaces and
 * up to seven passes per organ. This engine samples a label volume
 * (pipeline/voxelize.py: one byte per 2 mm voxel naming the mesh it fell
 * inside) with ONE fragment shader:
 *
 *   panel pixel -> probe-local (lx, ly) -> world point on the scan plane
 *               -> voxel -> label -> grey (or colour, for the 3D cut face)
 *
 * The acoustic shadow is the same shader marching from the pixel toward the
 * transducer through the volume and stopping at a bone label, so the bone
 * mask render target and its camera do not exist here. Nothing has to be
 * watertight: a leaky mesh voxelises to a slightly wrong column, not to a
 * cap painted across the whole panel.
 *
 * Both views sample the SAME volume at the SAME plane. The panel is a
 * screen-space quad; the 3D cut face is a quad riding the probe on the scan
 * plane, drawn where the clipped organ surfaces leave the interior open. They
 * share the fragment code (one #define apart) and the uniform object, so they
 * cannot disagree, which is the whole point of the tool.
 */

import * as THREE from 'three';
import { classify } from './models.js';
import { sectorExtent } from './probe.js';

const SHADOW_STEPS = 64;
/** Metres. Same role as Panel2D's SHADOW_RIND (which is in UV): the bright
 *  cortical line a bone keeps before it shadows itself. */
const SHADOW_RIND_M = 0.003;
const SHADOW_FLOOR = 0.06;

const COMMON = /* glsl */`
  precision highp float;
  precision highp sampler3D;
  uniform sampler3D tVol;
  uniform sampler2D tPal;     // r: grey (sRGB byte), g: bone flag
  uniform sampler2D tCol;     // rgb: 3D cap colour (sRGB bytes)
  uniform vec3 uOrigin;       // volume corner, world metres
  uniform vec3 uInvSize;      // 1 / (dims * voxel)
  uniform vec3 uVoxel;        // voxel size per axis, metres
  uniform mat4 uProbe;        // probe local -> world
  uniform mat4 uProbeInv;     // world -> probe local
  uniform vec4 uView;         // cx, cy, halfW, halfH (panel frustum, probe-local metres)
  uniform float uLinear, uHalfAngle, uR0, uDepth, uHalfWidth;
  uniform float uFloor, uRind, uColour, uShadow;
  uniform float uMuscle;      // 1 = muscle layer shown, 0 = treated as empty

  float labelAtWorld(vec3 w) {
    vec3 t = (w - uOrigin) * uInvSize;
    if (any(lessThan(t, vec3(0.0))) || any(greaterThan(t, vec3(1.0)))) return 0.0;
    float lab = floor(texture(tVol, t).r * 255.0 + 0.5);
    // Muscle was painted before the organs, so a muscle voxel has nothing
    // underneath it: with the layer off it is simply empty, as in the mesh
    // engine where the group is hidden.
    if (uMuscle < 0.5 && texture(tPal, vec2((lab + 0.5) / 256.0, 0.5)).b > 0.5) return 0.0;
    return lab;
  }
  float labelAt(vec2 local) {
    return labelAtWorld((uProbe * vec4(local, 0.0, 1.0)).xyz);
  }
  vec4 palAt(float lab) { return texture(tPal, vec2((lab + 0.5) / 256.0, 0.5)); }
  vec3 colAt(float lab) { return texture(tCol, vec2((lab + 0.5) / 256.0, 0.5)).rgb; }

  bool inSector(vec2 p) {
    if (uLinear > 0.5) return abs(p.x) <= uHalfWidth && p.y <= 0.0 && p.y >= -uDepth;
    vec2 d = p - vec2(0.0, uR0);
    float r = length(d);
    float a = atan(d.x, -d.y);
    return r >= uR0 && r <= uR0 + uDepth && abs(a) <= uHalfAngle;
  }

  // Four taps a quarter-voxel apart, averaged: a cheap anti-alias that turns
  // 2 mm voxel stair-steps into soft edges at the panel's scale.
  vec3 shade(vec2 local, bool colour, out float lab0) {
    vec3 w = (uProbe * vec4(local, 0.0, 1.0)).xyz;
    vec3 dx = (uProbe * vec4(1.0, 0.0, 0.0, 0.0)).xyz * uVoxel.x * 0.25;
    vec3 dy = (uProbe * vec4(0.0, 1.0, 0.0, 0.0)).xyz * uVoxel.y * 0.25;
    vec3 acc = vec3(0.0);
    lab0 = labelAtWorld(w);
    float l1 = labelAtWorld(w + dx + dy);
    float l2 = labelAtWorld(w - dx + dy);
    float l3 = labelAtWorld(w + dx - dy);
    float l4 = labelAtWorld(w - dx - dy);
    if (colour) {
      acc = colAt(l1) + colAt(l2) + colAt(l3) + colAt(l4);
    } else {
      acc = vec3(palAt(l1).r + palAt(l2).r + palAt(l3).r + palAt(l4).r);
    }
    return acc * 0.25;
  }

  // GLSL3: three.js does not alias gl_FragColor for explicit-version shaders.
  out vec4 fragColor;

  float shadowAt(vec2 local) {
    if (uShadow < 0.5) return 0.0;
    vec2 apex = vec2(0.0, uR0);
    vec2 toApex = uLinear > 0.5 ? vec2(0.0, 1.0) : normalize(apex - local);
    float span = uLinear > 0.5 ? -local.y : (length(apex - local) - uR0);
    float hit = 0.0;
    if (span > uRind) {
      for (int i = 1; i <= ${SHADOW_STEPS}; i++) {
        float d = uRind + (span - uRind) * (float(i) / float(${SHADOW_STEPS}));
        float l = labelAt(local + toApex * d);
        hit = max(hit, step(0.5, palAt(l).g));
      }
    }
    return hit;
  }
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
    float lab;
    vec3 grey = shade(local, false, lab);
    float hit = shadowAt(local);
    fragColor = vec4(grey * mix(1.0, uFloor, hit), 1.0);
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
    float lab;
    vec3 col = shade(local, true, lab);
    if (lab < 0.5) discard;           // empty: let the 3D scene show through
    float hit = shadowAt(local);
    fragColor = vec4(col * mix(1.0, uFloor * 4.0, hit), 1.0);
  }
`;

export class VolumeEngine {
  constructor() {
    this.ready = false;
    this.meta = null;
    this.texture = null;
    this.names = [];
    this.uniforms = {
      tVol: { value: null },
      tPal: { value: null },
      tCol: { value: null },
      uOrigin: { value: new THREE.Vector3() },
      uInvSize: { value: new THREE.Vector3() },
      uVoxel: { value: new THREE.Vector3() },
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
      uColour: { value: 0 },
      uShadow: { value: 1 },
      uMuscle: { value: 0 },
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
  }

  /** Load `<prefix>.vol.json` + `<prefix>.vol.bin.gz`. */
  async load(prefix, onProgress) {
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

    // Palettes from the SAME classifier the mesh engine uses, by mesh name.
    const pal = new Uint8Array(256 * 4);
    const col = new Uint8Array(256 * 4);
    meta.names.forEach((name, i) => {
      if (i === 0 || !name) return;
      const spec = classify(name);
      pal[i * 4] = Math.round(spec.grey * 255);
      pal[i * 4 + 1] = spec.bone ? 255 : 0;
      pal[i * 4 + 2] = spec.muscle ? 255 : 0;
      pal[i * 4 + 3] = 255;
      col[i * 4] = (spec.cap >> 16) & 255;
      col[i * 4 + 1] = (spec.cap >> 8) & 255;
      col[i * 4 + 2] = spec.cap & 255;
      col[i * 4 + 3] = 255;
    });
    const mk = (data) => {
      const t = new THREE.DataTexture(data, 256, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.minFilter = THREE.NearestFilter;
      t.magFilter = THREE.NearestFilter;
      t.needsUpdate = true;
      return t;
    };

    this.dispose();
    this.meta = meta;
    this.names = meta.names;
    this.texture = tex;
    this.uniforms.tVol.value = tex;
    this.uniforms.tPal.value = mk(pal);
    this.uniforms.tCol.value = mk(col);
    this.uniforms.uOrigin.value.fromArray(meta.origin);
    this.uniforms.uVoxel.value.set(meta.voxel, meta.voxel, meta.voxel);
    this.uniforms.uInvSize.value.set(1 / (nx * meta.voxel), 1 / (ny * meta.voxel), 1 / (nz * meta.voxel));
    this.ready = true;
    onProgress?.(1);
    return meta;
  }

  dispose() {
    this.texture?.dispose();
    this.uniforms.tPal.value?.dispose();
    this.uniforms.tCol.value?.dispose();
    this.texture = null;
    this.ready = false;
  }

  /**
   * Per frame: the probe transform, the panel frustum and the beam profile.
   * `view` is Panel2D's {cx, cy, halfW, halfH}.
   */
  update(probe, profile, view, showMuscles = false) {
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

    const key = `${profile.label}:${profile.depth.toFixed(3)}`;
    if (key !== this._profileKey) {
      this._profileKey = key;
      const ext = sectorExtent(profile);
      this.cutQuad.position.set((ext.minX + ext.maxX) / 2, (ext.minY + ext.maxY) / 2, 0);
      this.cutQuad.scale.set(ext.width * 1.02, ext.height * 1.02, 1);
    }
  }

  /** Draw the panel: one quad, no scene traversal. */
  renderPanel(renderer, setViewport) {
    setViewport();
    renderer.clear(true, true, true);
    renderer.render(this.panelScene, this.panelCamera);
  }
}
