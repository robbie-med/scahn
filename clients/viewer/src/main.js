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
import { applyStatic, initLangToggle, onLangChange, t, tPreset } from '@scahn/protocol/i18n';

import { assertHandedness, createFiducials, createRenderer, createScene } from './scene.js';
import {
  TORSO, TORSO_DEFAULTS, WINDOWS, createTorsoMesh, fitTorsoTo, setTorso,
  setSkinSurface, surfaceFrame, torsoCircumference,
} from './torso.js';
import {
  BEAM_PROFILES, clampDepth, createBeam, createProbeModel, disposeBeam,
} from './probe.js';
import { buildOrgans } from './organs.js';
import { MODELS, loadModel } from './models.js';
import { CappedOrgan, LAYER_3D, updateScanPlane } from './capping.js';
import { Panel2D } from './panel2d.js';
import { ViewerLink } from './net.js';
import { Stats, phoneUrl, renderQr, renderRoster } from './ui.js';
import { initAbout } from './about.js';

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

/**
 * Per-class parent nodes: abdominal viscera, heart, and bone. Geometry is
 * baked into scene space at import, so these stay at identity — they exist so
 * capping and the bone shadow pass can treat the three classes separately.
 */
const GROUPS = {
  organs: new THREE.Group(),
  heart: new THREE.Group(),
  bones: new THREE.Group(),
  muscles: new THREE.Group(),
};
for (const [name, g] of Object.entries(GROUPS)) {
  g.name = `group-${name}`;
  scene.add(g);
}

// The live scan plane and its negation, mutated in place each frame.
const scanPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const ghostPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);

/** @type {CappedOrgan[]} */
let organs = [];
/** Which registry entry is live. Starts on the primitive set, which paints
 *  instantly and is watertight by construction, while the real anatomy
 *  downloads; it remains the reference against which a capping bug is
 *  distinguished from a geometry bug. */
let modelId = 'primitives';
let modelBusy = false;

function buildFrom(list, ownsGeometry) {
  GROUPS.muscles.visible = showMuscles;
  organs = list.map((o, i) => {
    const co = new CappedOrgan(o, scanPlane, ghostPlane, i);
    return co.addTo(GROUPS[co.group] ?? GROUPS.organs, scene);
  });
  for (const o of organs) o.setMode(state.mode);
  // The shadow pass costs two extra renders and a composite, so it only runs
  // for models that actually contain bone.
  panel.shadowEnabled = organs.some((o) => o.bone);
  organsOwnGeometry = ownsGeometry;
}
let organsOwnGeometry = false;

/** Muscle is an optional layer: it is near-field context a learner scans
 *  THROUGH, not a structure being measured, and it hides the viscera behind it.
 *  Off by default so the tool opens on what it is actually teaching. */
let showMuscles = false;

function setMuscles(on) {
  showMuscles = !!on;
  GROUPS.muscles.visible = showMuscles;
  const btn = document.getElementById('muscle-toggle');
  if (btn) {
    btn.classList.toggle('on', showMuscles);
    btn.setAttribute('aria-pressed', String(showMuscles));
  }
  renderFrame();
}

/** World-space bounds of the non-bone anatomy, for refitting the skin shell. */
function worldAnatomyBox() {
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  for (const o of organs) {
    if (o.bone) continue;
    o.geometry.computeBoundingBox();
    tmp.copy(o.geometry.boundingBox).applyMatrix4(o.surface.matrixWorld);
    box.union(tmp);
  }
  return box;
}

function tearDownOrgans() {
  for (const o of organs) o.dispose(scene, organsOwnGeometry);
  organs = [];
}

/**
 * Swap the anatomy. The imported model is fetched on demand, so the download
 * never blocks the first paint of the primitives.
 */
async function setModel(id) {
  if (modelBusy || id === modelId || !MODELS[id]) return;
  modelBusy = true;
  setModelStatus(MODELS[id].builtin ? '' : t('viewer.loading', { model: MODELS[id].label }));
  try {
    if (MODELS[id].builtin) {
      tearDownOrgans();
      // Primitives were authored to the default capsule; restore both. Clearing
      // the skin surface first puts surfaceFrame back on the analytic path
      // before setTorso disposes the mesh it would otherwise still be casting
      // rays against.
      setSkinSurface(null);
      buildFrom(buildOrgans(), true);
      setTorso(TORSO_DEFAULTS, skin);
      setModelStatus('');
    } else {
      const { organs: list, skinGeometry, credit, box } = await loadModel(id, {
        onProgress: (f) => setModelStatus(
          t('viewer.loadingPct', { model: MODELS[id].label, pct: Math.round(f * 100) })),
      });
      tearDownOrgans();
      buildFrom(list, true);
      if (skinGeometry) {
        // Ride the real body surface. setSkinSurface derives the radii from the
        // mesh, so the capsule fit is not just unnecessary here, it would
        // overwrite them with a guess.
        skin.geometry.dispose();
        skin.geometry = skinGeometry;
        skin.updateMatrixWorld(true);
        setSkinSurface(skin);
      } else {
        setSkinSurface(null);
        setTorso(fitTorsoTo(worldAnatomyBox()), skin);
      }
      // `credit` already leads with the model name; prefixing the label
      // again printed 'BodyParts3D — BodyParts3D — ...'.
      setModelStatus(credit);
    }
    modelId = id;
  } catch (err) {
    console.error('model load failed', err);
    setModelStatus(t('viewer.loadFailed',
      { model: MODELS[id].label, current: MODELS[modelId].label }));
  } finally {
    modelBusy = false;
    renderModelChips();
  }
}

// Probe assembly. The beam is rebuilt on transducer or depth change rather than
// prebuilt per type, because depth is continuous and the sector geometry, the
// 2D frustum and the depth graticule all have to be regenerated together.
const probe = new THREE.Object3D();
probe.add(createProbeModel());
/** @type {THREE.Group|null} */
let beam = null;
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
  /** Metres of phone travel per metre of probe travel on the skin. 1.0 is
   *  physically 1:1, which is the whole point of moving the phone in the air. */
  moveGain: 1.0,
  /** Imaging depth in metres, remembered per transducer. */
  depthByType: {
    curvilinear: BEAM_PROFILES.curvilinear.depth,
    phased: BEAM_PROFILES.phased.depth,
    linear: BEAM_PROFILES.linear.depth,
  },
  /** Depth-resolved profile for the current transducer; set by rebuildBeam(). */
  profile: null,
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

function rebuildBeam() {
  if (beam) {
    probe.remove(beam);
    disposeBeam(beam);
  }
  beam = createBeam(state.probeType, state.depthByType[state.probeType]);
  beam.visible = state.showBeam;
  beam.userData.fill.visible = state.mode === MODES.RAY;
  probe.add(beam);
  // The depth-resolved profile: the single object the 2D panel reads, so the
  // beam and the panel can never disagree about how deep the image goes.
  state.profile = beam.userData.profile;
}

function setProbeType(name) {
  if (!BEAM_PROFILES[name]) return;
  state.probeType = name;
  rebuildBeam();
}

/** Depth is remembered per transducer, as it is on a real machine — switching
 *  to the linear probe and back should not lose your abdominal depth. */
function setDepth(metres) {
  const next = clampDepth(state.probeType, metres);
  if (next === state.depthByType[state.probeType]) return;
  state.depthByType[state.probeType] = next;
  rebuildBeam();
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
  windowNameEl.textContent = PRESET_LABELS[name] ? tPreset(name) : name;
}

/** Any manual placement means the learner has left the named window. */
function leaveWindow() {
  if (!state.preset) return;
  state.preset = null;
  windowNameEl.textContent = t('viewer.freePlacement');
}

/**
 * Map a physical phone displacement onto the skin surface.
 *
 * The delta arrives in the recentered frame, which is Y-up, so:
 *   +Y (lift the phone)      -> superior, along v
 *   +X (move it to the right) -> the viewer's right, which is the patient's
 *                                LEFT given the camera sits on +Z, so u rises
 *   +Z is discarded entirely — that is the surface constraint. Throwing away
 *      the out-of-plane component removes a whole axis of dead-reckoning error
 *      and is why the probe cannot drift off the body no matter how badly the
 *      integration misbehaves.
 *
 * Lateral travel is divided by the torso circumference rather than a made-up
 * constant, so a 10 cm hand movement is about 10 cm of travel on the skin.
 */
function applyPhysicalMove([dx, dy]) {
  const du = (dx / torsoCircumference()) * state.moveGain;
  const dv = (dy / TORSO.height) * state.moveGain;

  state.u = (((state.u + du) % 1) + 1) % 1; // wraps around the body
  state.v = Math.min(Math.max(state.v + dv, 0), 1); // clamps at head and hips
  leaveWindow();
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
  if (beam) beam.userData.fill.visible = mode === MODES.RAY;
  modeNameEl.textContent = t(`mode.${mode}`);
}

// ---------------------------------------------------------------------------
// layout
// ---------------------------------------------------------------------------

let rect3d = { x: 0, y: 0, w: 1, h: 1 };
let rect2d = { x: 0, y: 0, w: 1, h: 1 };

function layout() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  // A browser can report a zero-size window during first paint. Laying out then
  // poisons the viewport rects with a negative width and nothing renders until
  // something happens to fire a resize, so retry instead of storing garbage.
  if (W <= 0 || H <= 0) {
    requestAnimationFrame(layout);
    return;
  }
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

  scene.updateMatrixWorld(true);

  updateScanPlane(probe, scanPlane, ghostPlane, state.invertClip);

  renderer.setScissorTest(true);

  // --- 3D pass ---
  for (const o of organs) o.update(camera3d);
  applyViewport(rect3d);
  renderer.clear(true, true, true);
  renderer.render(scene, camera3d);

  // --- 2D pass ---
  panel.update(probe, state.profile);
  for (const o of organs) o.update(panel.camera);
  panel.render(renderer, scene, () => applyViewport(rect2d));

  renderer.setScissorTest(false);

  stats.render({
    mode: state.mode,
    probe: state.probeType,
    'u,v': `${state.u.toFixed(2)}, ${state.v.toFixed(2)}`,
    depth: `${Math.round((state.profile?.depth ?? 0) * 100)} cm`,
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
function setModelStatus(text) {
  document.getElementById('model-status').textContent = text;
}

function renderModelChips() {
  const host = document.getElementById('model-chips');
  host.innerHTML = '';
  for (const m of Object.values(MODELS)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t(`viewer.model.${m.id}`);
    b.title = m.note;
    b.className = m.id === modelId ? 'on' : '';
    b.disabled = modelBusy;
    b.addEventListener('click', () => setModel(m.id));
    host.appendChild(b);
  }
}

document.getElementById('move-gain').addEventListener('input', (e) => {
  state.moveGain = Number(e.target.value);
  document.getElementById('move-gain-val').textContent = state.moveGain.toFixed(2);
});
document.getElementById('invert-clip').addEventListener('change', (e) => {
  state.invertClip = e.target.checked;
});
document.getElementById('show-beam').addEventListener('change', (e) => {
  state.showBeam = e.target.checked;
  if (beam) beam.visible = state.showBeam;
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
      leaveWindow();
    }
    if (msg.dpos) applyPhysicalMove(msg.dpos);
    if (msg.preset) applyPreset(msg.preset);
    if (msg.probe) setProbeType(msg.probe);
    if (msg.depth != null) setDepth(msg.depth);
  },
  onMode: setMode,
  onStatus(s) {
    document.getElementById('pair-hint').classList.toggle('warn', s !== 'connected');
  },
});

buildFrom(buildOrgans(), true);
setProbeType('curvilinear');
setMode(MODES.RAY);
applyStatic();
initLangToggle(document.getElementById('lang-toggle'), () => {
  // Everything the catalogue does not reach through data-i18n: labels built in
  // JS, and the two badges whose text is derived from live state.
  renderModelChips();
  setMuscles(showMuscles);
  windowNameEl.textContent = state.preset
    ? tPreset(state.preset) : t('viewer.freePlacement');
  modeNameEl.textContent = t(`mode.${state.mode}`);
  link.refreshRoster?.();
  initAbout();
});

renderModelChips();
document.getElementById('muscle-toggle')
  ?.addEventListener('click', () => setMuscles(!showMuscles));
setMuscles(false);
initAbout();
applyPreset('aorta-transverse');
layout();
link.connect();
tick();
// Primitives are already on screen; swap in the real anatomy as soon as the
// download finishes.
setModel('bodyparts3d');

// Handy for the browser-console smoke tests in scripts/smoke.md.
window.scahn = {
  state, get organs() { return organs; }, probe, scanPlane, ghostPlane, panel, skin,
  get beam() { return beam; }, setDepth,
  renderer, camera3d, scene, setMode, applyPreset, setProbeType,
  renderFrame, setModel, setMuscles, get showMuscles() { return showMuscles; },
  get modelId() { return modelId; }, torso: () => ({ ...TORSO }), circumference: torsoCircumference,
  rect3d: () => rect3d, rect2d: () => rect2d, THREE,
};
