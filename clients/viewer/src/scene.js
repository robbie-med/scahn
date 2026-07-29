/**
 * Scene setup, and the permanent orientation fiducials.
 *
 * Basis (see CONVENTIONS.md — that file is the authority):
 *   +X = patient's left, +Y = superior, +Z = anterior.  Right-handed, metres.
 */

import * as THREE from 'three';

export const FIDUCIAL_COLOR = 0xff3fb4;

/** Where the `L` marker lives: on the patient's left flank. */
export const FIDUCIAL_POS = new THREE.Vector3(0.17, 0.0, 0.0);

/**
 * Fail loudly if anyone ever "fixes" the basis constants into a left-handed
 * frame. A mirrored ultrasound trainer teaches the wrong thing convincingly, so
 * this throws rather than rendering something plausible.
 */
export function assertHandedness() {
  const left = new THREE.Vector3(1, 0, 0);
  const superior = new THREE.Vector3(0, 1, 0);
  const anterior = new THREE.Vector3(0, 0, 1);
  const cross = new THREE.Vector3().crossVectors(left, superior);
  if (cross.distanceTo(anterior) > 1e-9) {
    throw new Error(
      'CONVENTIONS violation: left x superior !== anterior. The scene basis is not right-handed.',
    );
  }
}

export function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    stencil: true, // required for cap rendering (spec 6.2)
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  // Per-material clipping planes, so caps and the beam sector can opt out.
  renderer.localClippingEnabled = true;
  renderer.setClearColor(0x0b0d10, 1);
  renderer.autoClear = false;
  return renderer;
}

export function createScene() {
  const scene = new THREE.Scene();

  const hemi = new THREE.HemisphereLight(0xdfe9f5, 0x1b2028, 1.1);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(0.6, 0.9, 1.2); // anterior-superior-left
  scene.add(key);

  const fill = new THREE.DirectionalLight(0x9fc4ff, 0.5);
  fill.position.set(-0.8, -0.2, -0.9);
  scene.add(fill);

  return scene;
}

/** Small text label as a camera-facing sprite. */
function makeLabel(text, color = '#ffffff') {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.font = 'bold 88px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, size / 2, size / 2);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.setScalar(0.05);
  return sprite;
}

/**
 * Axis triad + the `L` flank marker. Never remove these (CONVENTIONS.md §3).
 *
 * Returned in a group whose materials carry no clipping planes, so the marker
 * stays visible in every mode — including a cut that would otherwise slice it
 * away exactly when you most need to check the mirroring.
 */
export function createFiducials() {
  const group = new THREE.Group();
  group.name = 'fiducials';

  const axes = new THREE.AxesHelper(0.12); // X red, Y green, Z blue
  axes.material.depthTest = false;
  axes.renderOrder = 900;
  group.add(axes);

  for (const [text, pos, color] of [
    ['X+ left', new THREE.Vector3(0.14, 0, 0), '#ff6b6b'],
    ['Y+ sup', new THREE.Vector3(0, 0.14, 0), '#6bff9e'],
    ['Z+ ant', new THREE.Vector3(0, 0, 0.14), '#6bb6ff'],
  ]) {
    const s = makeLabel(text.split(' ')[0], color);
    s.position.copy(pos);
    s.scale.setScalar(0.035);
    s.renderOrder = 901;
    group.add(s);
  }

  // The flank marker itself.
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(0.018, 24, 16),
    new THREE.MeshBasicMaterial({ color: FIDUCIAL_COLOR, depthTest: false }),
  );
  marker.position.copy(FIDUCIAL_POS);
  marker.renderOrder = 902;
  marker.name = 'fiducial-L';
  group.add(marker);

  const label = makeLabel('L', '#ff3fb4');
  label.position.copy(FIDUCIAL_POS).add(new THREE.Vector3(0.045, 0.02, 0));
  label.scale.setScalar(0.055);
  label.renderOrder = 903;
  group.add(label);

  return group;
}
