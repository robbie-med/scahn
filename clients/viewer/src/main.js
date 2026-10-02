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
import { MODES, PRESETS, PRESET_LABELS, PRESET_PROBE } from '@scahn/protocol';
import { applyStatic, initLangToggle, t, tPreset } from '@scahn/protocol/i18n';

import { assertHandedness, createFiducials, createRenderer, createScene } from './scene.js';
import {
  TORSO, TORSO_DEFAULTS, createTorsoMesh, fitTorsoTo, setTorso,
  setSkinSurface, surfaceFrame, torsoCircumference, windowsFor,
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
import { initAbout, renderAbout } from './about.js';

assertHandedness();

// ---------------------------------------------------------------------------
// scene
// ---------------------------------------------------------------------------

const canvas = document.getElementById('stage');
const renderer = createRenderer(canvas);
const scene = createScene();

const camera3d = new THREE.PerspectiveCamera(42, 1, 0.01, 20);
// Default camera on +Z looking at the origin: patient's left on the viewer's
// right, matching radiological convention (CONVENTIONS.md §2). frameTorso()
// moves it to fit whatever body is loaded.
camera3d.position.set(0.05, 0.12, 0.72);
camera3d.layers.set(LAYER_3D);

const controls = new OrbitControls(camera3d, canvas);
controls.target.set(0, 0.02, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.12;

const fiducials = createFiducials();
scene.add(fiducials);

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

/** World-space bounds of the non-bone anatomy, for refitting the skin shell
 *  and framing the camera. */
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

/**
 * Put the camera where the whole trunk is in view.
 *
 * Framed on the anatomy's lateral/AP extent and the skin's full height, so
 * the arms on the BodyParts3D skin do not push the camera back, and the
 * 25 cm pelvis model does not sit as a small lump in the middle of a torso-
 * sized frame. Run on every model swap: the old fixed position cropped the
 * trunk and parked the cardiac probe positions under the top chrome.
 */
function frameTorso() {
  const box = worldAnatomyBox();
  skin.geometry.computeBoundingBox();
  const sb = skin.geometry.boundingBox;
  if (box.isEmpty()) box.copy(sb);
  box.min.y = Math.min(box.min.y, sb.min.y);
  box.max.y = Math.max(box.max.y, sb.max.y);
  const centre = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const fov = (camera3d.fov * Math.PI) / 180;
  // Fit the larger of height and (width / aspect), with a margin, plus the
  // half-depth so the near face is not what gets measured.
  const span = Math.max(size.y, size.x / camera3d.aspect) * 1.2;
  const dist = span / 2 / Math.tan(fov / 2) + size.z / 2;
  controls.target.copy(centre);
  camera3d.position.copy(centre)
    .add(new THREE.Vector3(0.12, 0.3, 1).normalize().multiplyScalar(dist));
  controls.update();
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
      const { organs: list, skinGeometry, credit } = await loadModel(id, {
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
    // Windows are per model: re-seat the current one on the new body, or
    // report it unavailable.
    if (state.preset) applyPreset(state.preset);
    frameTorso();
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
  /** While in the future, incoming phone depth is ignored (see applyPreset). */
  depthLockUntil: 0,
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

/** Idempotent. The phone sends `probe` in every 30 Hz frame, so without the
 *  early return the sector geometry was disposed and reallocated thirty times
 *  a second for as long as anyone was driving. */
function setProbeType(name) {
  if (!BEAM_PROFILES[name]) return;
  if (beam && name === state.probeType) return;
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

/**
 * Snap to a named window ON THE CURRENT MODEL.
 *
 * A window the loaded model has no placement for (the pelvis has no heart)
 * says so in the badge and leaves the probe where it is, rather than moving
 * it to a spot tuned against a different body.
 */
function applyPreset(name) {
  const w = windowsFor(modelId)[name];
  if (!w) {
    if (PRESETS.includes(name)) {
      state.preset = null;
      windowNameEl.textContent = t('viewer.windowUnavailable', { window: tPreset(name) });
    }
    return;
  }
  state.preset = name;
  state.u = w.u;
  state.v = w.v;
  state.spin = w.spin;
  state.tilt = w.tilt;
  setProbeType(PRESET_PROBE[name] ?? state.probeType);
  if (w.depth != null) {
    setDepth(w.depth);
    // The phone keeps sending its own depth until the state echo reaches it
    // (≤ 100 ms throttle plus a round trip, and it ignores echoes of a value
    // it changed itself for 600 ms). Hold the window's depth over incoming
    // frames for that long, or the phone's stale value wins the next frame.
    state.depthLockUntil = performance.now() + 1500;
  }
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

const appEl = document.getElementById('app');
const bannerEl = document.getElementById('prealpha');
const topbarEl = document.getElementById('topbar');
const debugEl = document.getElementById('debug');

/**
 * Viewports and chrome.
 *
 * The disclaimer strip is reserved above both viewports, so it can never sit
 * on the image. In the wide layout the rest of the chrome (badges, model
 * chips, pairing card, debug drawer) is confined to the 3D viewport's width,
 * so nothing is ever drawn over the ultrasound panel — the mode badge used
 * to cover the panel's depth-scale label. In the narrow layout the chrome is
 * a strip under the disclaimer and the panels start below it.
 */
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

  const narrow = W < 900;
  appEl.classList.toggle('narrow', narrow);
  const bannerH = bannerEl.offsetHeight;
  topbarEl.style.top = `${bannerH}px`;
  let top = bannerH;
  if (narrow) top += topbarEl.offsetHeight;
  const avail = Math.max(H - top, 1);

  if (!narrow) {
    const split = Math.round(W * 0.6);
    rect3d = { x: 0, y: top, w: split, h: avail };
    rect2d = { x: split, y: top, w: W - split, h: avail };
    topbarEl.style.width = `${split}px`;
    debugEl.style.right = `${W - split + 12}px`;
  } else {
    // Narrow: stack, 2D panel on top.
    const panelH = Math.round(avail * 0.42);
    rect2d = { x: 0, y: top, w: W, h: panelH };
    rect3d = { x: 0, y: top + panelH, w: W, h: avail - panelH };
    topbarEl.style.width = '';
    debugEl.style.right = '';
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
 *  directly — see CLAUDE.md, "Verifying changes". */
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

  publishState();
}

// ---------------------------------------------------------------------------
// state echo to the phones
// ---------------------------------------------------------------------------

let lastStateJson = '';
let lastStateAt = 0;

/**
 * Tell every phone where the probe actually is.
 *
 * The display is the authority: presets move the probe, physical moves move
 * it, another phone may be driving. Without this each phone kept its own
 * (u, v) from the last pad drag, so the first drag after a preset teleported
 * the probe out of the window; and a phone taking control overwrote the
 * transducer and depth with whatever it last had. Sent only on change, at
 * most ten times a second, and in full whenever the roster changes so a phone
 * that just joined starts in sync.
 */
function publishState(force = false) {
  const snap = {
    u: Number(state.u.toFixed(4)),
    v: Number(state.v.toFixed(4)),
    preset: state.preset,
    probe: state.probeType,
    depth: state.depthByType[state.probeType],
    mode: state.mode,
  };
  const json = JSON.stringify(snap);
  const now = performance.now();
  if (!force && (json === lastStateJson || now - lastStateAt < 100)) return;
  lastStateJson = json;
  lastStateAt = now;
  link.sendState(snap);
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
document.getElementById('show-fiducials').addEventListener('change', (e) => {
  fiducials.visible = e.target.checked;
});
document.getElementById('show-qr').addEventListener('click', (e) => {
  const on = pairingEl.classList.toggle('expanded');
  e.currentTarget.setAttribute('aria-pressed', String(on));
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
    const paired = roster.sensors.length > 0;
    pairingEl.classList.toggle('paired', paired);
    if (!paired) {
      pairingEl.classList.remove('expanded');
      document.getElementById('show-qr').setAttribute('aria-pressed', 'false');
    }
    // A phone just joined or left: make sure everyone has the full picture.
    publishState(true);
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
    if (msg.depth != null && performance.now() > (state.depthLockUntil ?? 0)) setDepth(msg.depth);
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
  link.refreshRoster();
  renderAbout();
  layout(); // the disclaimer strip may have wrapped differently
});

renderModelChips();
document.getElementById('muscle-toggle')
  ?.addEventListener('click', () => setMuscles(!showMuscles));
setMuscles(false);
initAbout();
applyPreset('aorta-transverse');
layout();
frameTorso();
link.connect();
tick();
// Primitives are already on screen; swap in the real anatomy as soon as the
// download finishes.
setModel('bodyparts3d');

// Handy for the browser-console smoke tests (CLAUDE.md, "Verifying changes").
window.scahn = {
  state, get organs() { return organs; }, probe, scanPlane, ghostPlane, panel, skin,
  get beam() { return beam; }, setDepth,
  renderer, camera3d, controls, scene, fiducials, setMode, applyPreset, setProbeType,
  renderFrame, setModel, setMuscles, frameTorso, get showMuscles() { return showMuscles; },
  get modelId() { return modelId; }, torso: () => ({ ...TORSO }), circumference: torsoCircumference,
  windowsFor, rect3d: () => rect3d, rect2d: () => rect2d, THREE,
};
