/**
 * Viewer entry point.
 *
 * Layout is one WebGL context with two scissored viewports: the 3D scene and
 * the 2D panel, ~60/40, stacking on narrow screens with the panel on top.
 * The two are separated by render layer, not by scene, so the cut geometry is
 * shared and can never disagree between the panels — which is the entire point
 * of the tool.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { MODES, PRESET_LABELS, PRESET_PROBE } from '@scahn/protocol';

import { assertHandedness, createFiducials, createRenderer, createScene } from './scene.js';
import { WINDOWS, createTorsoMesh, surfaceFrame } from './torso.js';
import { BEAM_PROFILES, createBeam, createProbeModel } from './probe.js';
import { buildOrgans } from './organs.js';
import { CappedOrgan, LAYER_3D, updateScanPlane } from './capping.js';
import { Panel2D } from './panel2d.js';
import { ViewerLink } from './net.js';
import { Stats, phoneUrl, renderQr, renderRoster } from './ui.js';

assertHandedness();

// ---------------------------------------------------------------------------
// scene
// ---------------------------------------------------------------------------

const canvas = document.getElementById('stage');
const renderer = createRenderer(canvas);
const scene = createScene();

const camera3d = new THREE.PerspectiveCamera(42, 1, 0.01, 20);
// Default camera on +Z looking at the origin: patient's left on the viewer's
// right, matching radiological convention (CONVENTIONS.md §2).
camera3d.position.set(0.05, 0.12, 0.72);
camera3d.layers.set(LAYER_3D);

const controls = new OrbitControls(camera3d, canvas);
controls.target.set(0, 0.02, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.12;

scene.add(createFiducials());

const skin = createTorsoMesh();
scene.add(skin);

// The live scan plane and its negation, mutated in place each frame.
const scanPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const ghostPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);

const organs = buildOrgans().map((o, i) => new CappedOrgan(o, scanPlane, ghostPlane, i).addTo(scene));

// Probe assembly: model + one beam per transducer, visibility-switched.
const probe = new THREE.Object3D();
probe.add(createProbeModel());
const beams = {};
for (const name of Object.keys(BEAM_PROFILES)) {
  beams[name] = createBeam(name);
  beams[name].visible = false;
  probe.add(beams[name]);
}
scene.add(probe);

const panel = new Panel2D(document.getElementById('panel-overlay'));

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

const state = {
  mode: MODES.RAY,
  probeType: 'curvilinear',
  preset: null,
  u: 0.0,
  v: 0.53,
  spin: 0,
  tilt: 0,
  smoothing: 0.25,
  invertClip: false,
  showBeam: true,
  /** Latest orientation from the phone, and the smoothed value we render. */
  target: new THREE.Quaternion(),
  current: new THREE.Quaternion(),
};

const frame = {};
const qPreset = new THREE.Quaternion();
const qSpin = new THREE.Quaternion();
const qTilt = new THREE.Quaternion();
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);

function setProbeType(name) {
  if (!BEAM_PROFILES[name]) return;
  state.probeType = name;
  for (const [k, g] of Object.entries(beams)) g.visible = state.showBeam && k === name;
}

function applyPreset(name) {
  const w = WINDOWS[name];
  if (!w) return;
  state.preset = name;
  state.u = w.u;
  state.v = w.v;
  state.spin = w.spin;
  state.tilt = w.tilt;
  setProbeType(PRESET_PROBE[name] ?? state.probeType);
  windowNameEl.textContent = PRESET_LABELS[name] ?? name;
}

function setMode(mode) {
  state.mode = mode;
  for (const o of organs) o.setMode(mode);

  // Skin is clipped in the cut modes so you can see in, but never capped — it
  // is a shell, and a shell has no cross-section worth painting.
  const want = mode === MODES.RAY ? null : [scanPlane];
  if (skin.material.clippingPlanes !== want) {
    skin.material.clippingPlanes = want;
    skin.material.needsUpdate = true;
  }

  // Sector is a translucent surface in Mode 1, a thin outline in 2 and 3.
  for (const g of Object.values(beams)) {
    g.userData.fill.visible = mode === MODES.RAY;
  }
  modeNameEl.textContent = { 1: 'Mode 1 — Ray', 2: 'Mode 2 — Cut', 3: 'Mode 3 — Ghost' }[mode];
}

// ---------------------------------------------------------------------------
// layout
// ---------------------------------------------------------------------------

let rect3d = { x: 0, y: 0, w: 1, h: 1 };
let rect2d = { x: 0, y: 0, w: 1, h: 1 };

function layout() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  renderer.setSize(W, H, false);

  if (W >= 900) {
    const split = Math.round(W * 0.6);
    rect3d = { x: 0, y: 0, w: split, h: H };
    rect2d = { x: split, y: 0, w: W - split, h: H };
  } else {
    // Narrow: stack, 2D panel on top.
    const top = Math.round(H * 0.42);
    rect2d = { x: 0, y: 0, w: W, h: top };
    rect3d = { x: 0, y: top, w: W, h: H - top };
  }

  camera3d.aspect = rect3d.w / rect3d.h;
  camera3d.updateProjectionMatrix();
  panel.layout(rect2d);
}

window.addEventListener('resize', layout);

// Keep orbit input inside the 3D viewport, so dragging on the ultrasound panel
// does not spin the anatomy behind it.
canvas.addEventListener('pointerdown', (e) => {
  const inside =
    e.clientX >= rect3d.x && e.clientX <= rect3d.x + rect3d.w &&
    e.clientY >= rect3d.y && e.clientY <= rect3d.y + rect3d.h;
  controls.enabled = inside;
});

/** CSS-pixel rect (top-left origin) -> WebGL viewport (bottom-left origin). */
function applyViewport(r) {
  const glY = window.innerHeight - (r.y + r.h);
  renderer.setViewport(r.x, glY, r.w, r.h);
  renderer.setScissor(r.x, glY, r.w, r.h);
}

// ---------------------------------------------------------------------------
// render loop
// ---------------------------------------------------------------------------

const stats = new Stats(document.getElementById('stats'));

function tick() {
  requestAnimationFrame(tick);
  renderFrame();
}

/** One full frame. Split out from the rAF loop so headless checks can drive it
 *  directly — see scripts/smoke.md. */
function renderFrame() {
  stats.tick();
  controls.update();

  // Smoothing lives on the viewer, not the phone, so the constant is tunable
  // without redeploying to anyone's handset (spec section 3).
  state.current.slerp(state.target, state.smoothing);

  // probeWorld = surfaceFrame(u,v) . presetRotation . sensorQuaternion
  surfaceFrame(state.u, state.v, frame);
  probe.position.copy(frame.position);
  qSpin.setFromAxisAngle(AXIS_Y, state.spin);
  qTilt.setFromAxisAngle(AXIS_X, state.tilt);
  qPreset.copy(qSpin).multiply(qTilt);
  probe.quaternion.copy(frame.quaternion).multiply(qPreset).multiply(state.current);
  probe.updateMatrixWorld(true);

  updateScanPlane(probe, scanPlane, ghostPlane, state.invertClip);

  renderer.setScissorTest(true);

  // --- 3D pass ---
  for (const o of organs) o.update(camera3d);
  applyViewport(rect3d);
  renderer.clear(true, true, true);
  renderer.render(scene, camera3d);

  // --- 2D pass ---
  panel.update(probe, state.probeType);
  for (const o of organs) o.update(panel.camera);
  applyViewport(rect2d);
  renderer.clear(true, true, true);
  renderer.render(scene, panel.camera);

  renderer.setScissorTest(false);

  stats.render({
    mode: state.mode,
    probe: state.probeType,
    'u,v': `${state.u.toFixed(2)}, ${state.v.toFixed(2)}`,
  });
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------

const windowNameEl = document.getElementById('window-name');
const modeNameEl = document.getElementById('mode-name');
const pairingEl = document.getElementById('pairing');
const rosterEl = document.getElementById('roster');

document.getElementById('smooth').addEventListener('input', (e) => {
  state.smoothing = Number(e.target.value);
  document.getElementById('smooth-val').textContent = state.smoothing.toFixed(2);
});
document.getElementById('invert-clip').addEventListener('change', (e) => {
  state.invertClip = e.target.checked;
});
document.getElementById('show-beam').addEventListener('change', (e) => {
  state.showBeam = e.target.checked;
  setProbeType(state.probeType);
});

window.addEventListener('keydown', (e) => {
  if (e.key === '1' || e.key === '2' || e.key === '3') setMode(Number(e.key));
});

// ---------------------------------------------------------------------------
// relay link
// ---------------------------------------------------------------------------

const link = new ViewerLink({
  onCreated(room) {
    renderQr(document.getElementById('qr'), room);
    document.getElementById('code').textContent = room;
    document.getElementById('pair-url').textContent = phoneUrl(room).replace(/^https?:\/\//, '');
  },
  onRoster(roster) {
    renderRoster(rosterEl, roster);
    pairingEl.classList.toggle('paired', roster.sensors.length > 0);
  },
  onOrient(msg) {
    stats.noteOrient(msg);
    state.target.set(msg.q[0], msg.q[1], msg.q[2], msg.q[3]);
    if (msg.surf) {
      state.u = ((msg.surf[0] % 1) + 1) % 1;
      state.v = Math.min(Math.max(msg.surf[1], 0), 1);
      // A manual drag means the learner has left the named window.
      if (state.preset) {
        state.preset = null;
        windowNameEl.textContent = 'Free placement';
      }
    }
    if (msg.preset) applyPreset(msg.preset);
    if (msg.probe) setProbeType(msg.probe);
  },
  onMode: setMode,
  onStatus(s) {
    document.getElementById('pair-hint').classList.toggle('warn', s !== 'connected');
  },
});

setProbeType('curvilinear');
setMode(MODES.RAY);
applyPreset('aorta-transverse');
layout();
link.connect();
tick();

// Handy for the browser-console smoke tests in scripts/smoke.md.
window.scahn = {
  state, organs, probe, scanPlane, ghostPlane, panel, skin, beams,
  renderer, camera3d, scene, setMode, applyPreset, setProbeType,
  renderFrame, rect3d: () => rect3d, rect2d: () => rect2d, THREE,
};
