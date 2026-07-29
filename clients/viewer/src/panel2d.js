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
import { sectorExtent, sectorOutline } from './probe.js';
import { LAYER_2D, LAYER_BONE } from './capping.js';

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

/**
 * Acoustic shadowing behind bone.
 *
 * Cortical bone reflects almost the entire beam, so what you see is a bright
 * near surface and nothing at all beyond it. This is the one acoustic effect
 * worth having in a tool about probe placement, because rib shadows are the
 * reason the cardiac and RUQ windows exist at all — without them a learner
 * cannot tell why sliding one interspace makes an image appear.
 *
 * Implemented as a composite pass rather than in the geometry: the panel is
 * rendered to one target, bone alone to a second, and each pixel then marches
 * back along its own scan line toward the transducer. If it crosses bone on the
 * way, it is in shadow. Marching toward the apex rather than away from it means
 * the first bone encountered is the near cortex, so the bone's own far side is
 * shadowed too — which is what a rib actually looks like.
 */
const SHADOW_STEPS = 96;
/**
 * Bright rind, in UV. The march has to start a little way from the pixel it is
 * shading, or a bone pixel finds bone one step toward the transducer and
 * shadows itself — a rib collapses to a 1px outline instead of the bright
 * cortical line it should be. This is the thickness of that surviving line.
 */
const SHADOW_RIND = 0.014;
/** How dark the shadow goes. Not fully black: on a real machine a shadow still
 *  carries a little noise, and pure black reads as a rendering failure. */
const SHADOW_FLOOR = 0.06;

const SHADOW_FRAG = /* glsl */`
  uniform sampler2D tPanel;
  uniform sampler2D tBone;
  uniform vec2 uApex;      // transducer apex in UV space
  uniform float uLinear;   // 1.0 for a linear probe: parallel rays, no apex
  uniform float uFloor;
  uniform float uRind;
  varying vec2 vUv;

  void main() {
    vec4 panel = texture2D(tPanel, vUv);

    // Direction back toward the transducer. A sector converges on its apex; a
    // linear array's rays are parallel, so there is no apex to aim at.
    vec2 toApex = mix(normalize(uApex - vUv), vec2(0.0, 1.0), uLinear);
    float span = mix(distance(uApex, vUv), vUv.y, uLinear);

    // Nothing between here and the transducer can be shadowing us.
    float hit = 0.0;
    if (span > uRind) {
      for (int i = 1; i <= ${SHADOW_STEPS}; i++) {
        float d = uRind + (span - uRind) * (float(i) / float(${SHADOW_STEPS}));
        vec2 p = vUv + toApex * d;
        if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) break;
        hit = max(hit, step(0.5, texture2D(tBone, p).r));
      }
    }

    // Shadow multiplies rather than replaces, so the sector mask and graticule
    // drawn over the panel stay untouched.
    gl_FragColor = vec4(panel.rgb * mix(1.0, uFloor, hit), panel.a);
  }
`;

const SHADOW_VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

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

    // --- shadow compositing ---------------------------------------------------
    this.shadowEnabled = false;
    this.boneCamera = this.camera.clone();
    this.boneCamera.layers.set(LAYER_BONE);

    const rtOpts = { depthBuffer: true, stencilBuffer: true };
    this.rtPanel = new THREE.WebGLRenderTarget(2, 2, rtOpts);
    this.rtBone = new THREE.WebGLRenderTarget(2, 2, rtOpts);

    // ShaderMaterial, not RawShaderMaterial: Raw does not inject the `position`
    // and `uv` attribute declarations, so the shader fails to link and every
    // draw raises GL_INVALID_OPERATION.
    this.shadowMat = new THREE.ShaderMaterial({
      vertexShader: SHADOW_VERT,
      fragmentShader: SHADOW_FRAG,
      uniforms: {
        tPanel: { value: this.rtPanel.texture },
        tBone: { value: this.rtBone.texture },
        uApex: { value: new THREE.Vector2(0.5, 1.2) },
        uLinear: { value: 0 },
        uFloor: { value: SHADOW_FLOOR },
        uRind: { value: SHADOW_RIND },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.quadScene = new THREE.Scene();
    this.quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.shadowMat));
    this.quadCamera = new THREE.Camera();

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
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.rtPanel.setSize(Math.max(2, Math.round(w * dpr)), Math.max(2, Math.round(h * dpr)));
    this.rtBone.setSize(Math.max(2, Math.round(w * dpr)), Math.max(2, Math.round(h * dpr)));
    this._frustum = null; // force a redraw of the mask at the new size
  }

  /**
   * Re-aim the camera at the probe and, when the transducer or panel size has
   * changed, rebuild the SVG dressing.
   */
  /** @param {import('./probe.js').BeamProfile} profile already depth-resolved */
  update(probe, profile) {
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

    // Transducer apex in panel UV, for the shadow march. A sector converges on
    // a point behind its face; a linear array has no apex and parallel rays.
    const isLinear = profile.kind === 'linear';
    if (isLinear) {
      this.shadowMat.uniforms.uLinear.value = 1;
    } else {
      this.shadowMat.uniforms.uLinear.value = 0;
      const [ax, ay] = this._map(0, profile.originOffset);
      // _map is top-down pixels; texture UV is bottom-up.
      this.shadowMat.uniforms.uApex.value.set(ax / this.rect.w, 1 - ay / this.rect.h);
    }

    // Depth is part of the key: change it and the sector mask and the depth
    // graticule must both be redrawn, not just the frustum.
    const key = `${profile.label}:${profile.depth.toFixed(3)}:${this.rect.w}x${this.rect.h}`;
    if (key !== this._frustumKey) {
      this._frustumKey = key;
      this._drawDressing(profile);
    }
  }

  /**
   * Draw the panel, optionally with acoustic shadowing behind bone.
   *
   * @param {(x:number,y:number,w:number,h:number)=>void} setViewport
   */
  render(renderer, scene, setViewport) {
    if (!this.shadowEnabled) {
      setViewport();
      renderer.clear(true, true, true);
      renderer.render(scene, this.camera);
      return;
    }

    renderer.setRenderTarget(this.rtPanel);
    renderer.setScissorTest(false);
    renderer.clear(true, true, true);
    renderer.render(scene, this.camera);

    // `copy` brings the layer mask across with everything else, so the bone
    // camera has to be re-restricted or this pass renders the whole panel again
    // and every pixel ends up shadowed.
    this.boneCamera.copy(this.camera);
    this.boneCamera.layers.set(LAYER_BONE);
    this.boneCamera.updateProjectionMatrix();
    this.boneCamera.updateMatrixWorld(true);
    renderer.setRenderTarget(this.rtBone);
    renderer.clear(true, true, true);
    renderer.render(scene, this.boneCamera);

    renderer.setRenderTarget(null);
    renderer.setScissorTest(true);
    setViewport();
    renderer.clear(true, true, true);
    renderer.render(this.quadScene, this.quadCamera);
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

    // 2. Depth scale down the right edge.
    //
    // Tick spacing adapts to depth. A fixed 2 cm tick / 5 cm label works for an
    // abdominal sweep but leaves the linear probe's 6 cm window with no numbers
    // on it at all, which is worse than useless on a depth scale.
    // The label step MUST be a multiple of the tick step, or labels land only
    // where the two happen to coincide — a 2 cm tick with a 5 cm label prints
    // nothing but multiples of 10, so an 18 cm phased view gets exactly one
    // number on its scale. 1 cm ticks with 5 cm numbering is what real machines
    // do anyway.
    const depthCm = Math.round(profile.depth * 100);
    const tickCm = 1;
    const labelCm = depthCm <= 10 ? 2 : 5;
    const axisX = w - 26;
    el('line', {
      x1: axisX, y1: this._map(0, 0)[1], x2: axisX, y2: this._map(0, -profile.depth)[1],
      stroke: '#4b5a68', 'stroke-width': 1,
    });
    for (let cm = 0; cm <= depthCm; cm += tickCm) {
      const [, y] = this._map(0, -cm / 100);
      const major = cm % labelCm === 0;
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
    }, `${profile.label} · ${depthCm} cm`);
  }
}
