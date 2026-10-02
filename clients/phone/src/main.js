/**
 * Phone entry point. The phone is purely an inertial sensor plus a small
 * control surface: orientation, probe placement, window presets, mode.
 *
 * The DISPLAY is the authority on probe state. It echoes (u, v, window,
 * transducer, depth, mode) to every phone as a `state` frame, and this file
 * adopts it — so the pad always drags from where the probe actually is, a
 * phone that takes control does not overwrite the screen with stale settings,
 * and a viewing-only phone's chips show what is on screen, not what it last
 * tapped. The one subtlety is latency: an echo of our own change arrives a
 * few frames late, so a value we changed ourselves in the last half second is
 * not overwritten by the echo of its predecessor.
 */

import { applyStatic, initLangToggle, t, tPreset } from '@scahn/protocol/i18n';
import {
  DEPTH_LIMITS, LIMITS, MODES, PRESETS, PRESET_LABELS, PRESET_PROBE, PROBE_TYPES, TUTORIALS,
  clampDepth,
} from '@scahn/protocol';
import { OrientationSource, guessDeviceName } from './orientation.js';
import { TranslationSource } from './translation.js';
import { FlowSource } from './opticalflow.js';
import { SensorLink } from './net.js';

const $ = (id) => document.getElementById(id);

const gate = $('gate');
const main = $('main');
const roomInput = $('room-input');
const gateMsg = $('gate-msg');
const statePill = $('state-pill');
const roomPill = $('room-pill');
const claimBtn = $('claim');
const statusEl = $('status');
const pad = $('pad');

const orientation = new OrientationSource();
const translation = new TranslationSource(orientation);
const flow = new FlowSource(orientation);
/** @type {SensorLink|null} */
let link = null;

/** How long a local change wins over an echo from the display. Covers one
 *  round trip plus the display's 100 ms echo throttle with room to spare. */
const LOCAL_WINS_MS = 600;

const state = {
  driving: false,
  /** 'drag' = the original touch-pad placement; 'space' = dead reckoning from
   *  the IMU; 'flow' = optical flow from the front camera. Mutually exclusive
   *  so no two sources can fight over (u,v). */
  placement: 'drag',
  probe: 'curvilinear',
  /** Imaging depth in metres, remembered per transducer as on a real machine. */
  depthByType: {
    curvilinear: DEPTH_LIMITS.curvilinear.default,
    phased: DEPTH_LIMITS.phased.default,
    linear: DEPTH_LIMITS.linear.default,
  },
  mode: MODES.RAY,
  u: 0.0,
  v: 0.53,
  surfDirty: false,
  /** Window to send once, on the next frame. */
  pendingPreset: null,
  /** Window the display says it is showing (null = free placement). */
  shownPreset: null,
  /** Display is frozen (echoed); we can only ask to toggle it while driving. */
  frozen: false,
  /** When each thing was last changed HERE, for the echo guard. */
  touched: { surf: 0, probe: 0, depth: 0, mode: 0, preset: 0, freeze: 0 },
};

// Pre-fill from the QR deep link (?room=418306) so scanning lands paired.
const roomFromUrl = new URLSearchParams(location.search).get('room');
if (roomFromUrl && /^[0-9]{6}$/.test(roomFromUrl)) roomInput.value = roomFromUrl;

roomInput.addEventListener('input', () => {
  roomInput.value = roomInput.value.replace(/\D/g, '').slice(0, 6);
});

// ---------------------------------------------------------------------------
// gate: permission + connect, from a single user gesture
// ---------------------------------------------------------------------------

$('start').addEventListener('click', async () => {
  const room = roomInput.value.trim();
  if (!/^[0-9]{6}$/.test(room)) {
    gateMsg.textContent = t('phone.enterCode');
    gateMsg.classList.add('err');
    return;
  }

  if (!window.isSecureContext) {
    gateMsg.textContent = t('phone.httpsRequired');
    gateMsg.classList.add('err');
    return;
  }

  gateMsg.classList.remove('err');
  gateMsg.textContent = t('phone.requestingMotion');

  try {
    const backend = await orientation.start();
    orientation.recenter();
    // Physical translation is a bonus, not a prerequisite: if devicemotion is
    // unavailable the drag pad still works, so a failure here must not block
    // the whole session.
    try {
      await translation.start();
    } catch (err) {
      console.warn('translation unavailable:', err?.message ?? err);
      translationAvailable = false;
      $('move').disabled = true;
      $('move-hint').textContent = t('phone.motionUnavailable');
    }
    renderPlacementMode();
    gateMsg.textContent = '';
    connect(room, backend);
  } catch (err) {
    gateMsg.classList.add('err');
    gateMsg.textContent = err?.message ?? t('phone.motionFailed');
  }
});

function connect(room, backend) {
  link = new SensorLink({
    room,
    name: guessDeviceName(),
    onJoined(msg) {
      state.driving = !!msg.active;
      paintControl();
    },
    onRoster(roster) {
      const me = roster.sensors.find((s) => s.id === link.id);
      state.driving = !!me?.active;
      paintControl();
    },
    onState: adoptState,
    onStatus(s) {
      statusEl.textContent = `${s} · ${backend}`;
    },
  });
  link.connect();

  gate.classList.add('hidden');
  main.classList.remove('hidden');
  roomPill.textContent = room;
  startSending();
}

/**
 * Explicit driving/viewing state. Ambiguity here produces a learner waving a
 * phone at a frozen screen and concluding the tool is broken (spec 7.4).
 */
function paintControl() {
  statePill.textContent = t(state.driving ? 'phone.youAreDriving' : 'phone.viewingOnly');
  statePill.classList.toggle('driving', state.driving);
  claimBtn.classList.toggle('hidden', state.driving);
  paintFreeze();
}

/** Freeze is the display's state; only the driver may change it. */
function paintFreeze() {
  const b = $('freeze');
  b.textContent = t(state.frozen ? 'phone.unfreeze' : 'phone.freeze');
  b.setAttribute('aria-pressed', String(state.frozen));
  b.disabled = !state.driving;
}

$('freeze').addEventListener('click', () => {
  if (!state.driving) return;
  state.frozen = !state.frozen;
  state.touched.freeze = Date.now();
  link?.send({ type: 'freeze', on: state.frozen });
  paintFreeze();
});

/** Readouts the display measured; the phone only lists them. */
function renderCalipers(list) {
  const host = $('calipers');
  host.innerHTML = '';
  $('calipers-group').classList.toggle('hidden', list.length === 0);
  for (const c of list) {
    const cm = Math.hypot(c.a[0] - c.b[0], c.a[1] - c.b[1], c.a[2] - c.b[2]) * 100;
    const row = document.createElement('div');
    row.innerHTML = '<span></span>';
    row.firstChild.textContent = `${c.id}  ${cm.toFixed(1)} cm`;
    host.appendChild(row);
  }
}

/** A link to the tutorial for the window on screen, opened on the phone. */
function paintTutorial() {
  const a = $('tutorial');
  const tut = state.shownPreset ? TUTORIALS[state.shownPreset] : null;
  if (!tut) { a.classList.add('hidden'); return; }
  a.href = tut.pocus101 ?? Object.values(tut)[0];
  a.classList.remove('hidden');
}

/** Take the display's word for it, except where we changed it ourselves just
 *  now (see LOCAL_WINS_MS) or a drag is in progress. */
function adoptState(msg) {
  const now = Date.now();
  const stale = (k) => now - state.touched[k] > LOCAL_WINS_MS;
  if (msg.u != null && msg.v != null && !dragging && stale('surf')) {
    state.u = msg.u;
    state.v = msg.v;
  }
  if (msg.probe && stale('probe')) state.probe = msg.probe;
  if (msg.depth != null && stale('depth') && stale('probe')) {
    state.depthByType[state.probe] = clampDepth(state.probe, msg.depth);
  }
  if (msg.mode && stale('mode')) state.mode = msg.mode;
  if ('preset' in msg && stale('preset')) state.shownPreset = msg.preset;
  if ('frozen' in msg && stale('freeze')) state.frozen = !!msg.frozen;
  if (Array.isArray(msg.calipers)) renderCalipers(msg.calipers);
  paintFreeze();
  paintTutorial();
  repaintPresets();
  repaintProbes();
  repaintModes();
  renderDepth();
}

// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------

$('recenter').addEventListener('click', () => {
  orientation.recenter();
  // Both clutches: a stroke in progress on either source must not survive a
  // recentre, or the probe keeps sliding from a reference that just moved.
  translation.release();
  flow.release();
  statusEl.textContent = t('phone.recentred');
});

// --- placement mode toggle --------------------------------------------------

let translationAvailable = true;
let flowAvailable = true;

/** The translation source behind the Move clutch for the current mode. */
function activeSource() {
  return state.placement === 'flow' ? flow : translation;
}

async function setPlacement(mode) {
  if (mode === 'space' && !translationAvailable) return;
  if (mode === 'flow' && !flowAvailable) return;

  // The camera is requested lazily here rather than at the gate: it is a
  // second permission prompt, and only flow mode needs it. The chip click is
  // the user gesture getUserMedia requires.
  if (mode === 'flow' && !flow.running) {
    try {
      await flow.start();
    } catch (err) {
      console.warn('optical flow unavailable:', err?.message ?? err);
      flowAvailable = false;
      $('move-hint').textContent = t('phone.cameraUnavailable');
      renderPlacementMode();
      return;
    }
  }
  // Leaving flow mode releases the camera — an idle lens is a privacy and
  // battery cost nobody asked for.
  if (mode !== 'flow' && flow.running) flow.stop();

  state.placement = mode;
  // Leaving a clutch mode must drop the clutch, or a stroke in progress keeps
  // accumulating with no visible control to stop it.
  if (mode === 'drag') releaseMove();
  $('pane-drag').classList.toggle('hidden', mode !== 'drag');
  $('pane-space').classList.toggle('hidden', mode === 'drag');
  $('move').disabled =
    (mode === 'space' && !translationAvailable) || (mode === 'flow' && !flowAvailable);
  $('move-hint').textContent =
    mode === 'flow' ? t('phone.flowHint') : t('phone.spaceHint');
  renderPlacementMode();
}

function renderPlacementMode() {
  const host = $('placement-mode');
  host.innerHTML = '';
  for (const [id, label] of [
    ['drag', t('phone.dragPad')],
    ['space', t('phone.moveInSpace')],
    ['flow', t('phone.glideCam')],
  ]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.className = state.placement === id ? 'on' : '';
    b.disabled =
      (id === 'space' && !translationAvailable) || (id === 'flow' && !flowAvailable);
    b.addEventListener('click', () => setPlacement(id));
    host.appendChild(b);
  }
}

// --- hold-to-move clutch ----------------------------------------------------
// Press and hold, move the phone, release. Release zeroes velocity so drift
// cannot carry across strokes. Pointer capture keeps the release event even if
// the finger slides off the button mid-gesture, which otherwise leaves the
// clutch stuck engaged and the probe sliding away on its own.
const moveBtn = $('move');

function engageMove(e) {
  if (moveBtn.disabled) return;
  e.preventDefault();
  activeSource().engage();
  moveBtn.classList.add('engaged');
  try { moveBtn.setPointerCapture(e.pointerId); } catch { /* not a pointer */ }
}

function releaseMove() {
  // Release both sources — cheap, and immune to the mode having been switched
  // mid-stroke.
  translation.release();
  flow.release();
  moveBtn.classList.remove('engaged');
}

moveBtn.addEventListener('pointerdown', engageMove);
for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  moveBtn.addEventListener(ev, releaseMove);
}
// Backgrounding mid-stroke must not leave the clutch engaged.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') releaseMove();
});

claimBtn.addEventListener('click', () => link?.claim());

/** @returns {() => void} a repaint fn, so one control can restyle another. */
function chips(container, items, onPick, isOn) {
  const repaint = () => {
    for (const c of container.children) c.classList.toggle('on', isOn(c.dataset.id));
  };
  container.innerHTML = '';
  for (const { id, label } of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.dataset.id = id;
    b.addEventListener('click', () => { onPick(id); repaint(); });
    container.appendChild(b);
  }
  repaint();
  return repaint;
}

const repaintPresets = chips(
  $('presets'),
  PRESETS.map((id) => ({ id, label: PRESET_LABELS[id] ? tPreset(id) : id })),
  (id) => {
    state.pendingPreset = id;
    state.shownPreset = id;
    state.touched.preset = Date.now();
    // A window implies its usual transducer. The phone has to adopt it too:
    // it sends `probe` on every frame, so leaving it stale would immediately
    // clobber the transducer the preset just selected on the viewer.
    state.probe = PRESET_PROBE[id] ?? state.probe;
    state.touched.probe = Date.now();
    repaintProbes();
    renderDepth();
    paintTutorial();
  },
  (id) => id === state.shownPreset,
);

const repaintProbes = chips(
  $('probes'),
  PROBE_TYPES.map((id) => ({ id, label: t(`probe.${id}`) })),
  (id) => { state.probe = id; state.touched.probe = Date.now(); renderDepth(); },
  (id) => id === state.probe,
);

// --- depth ------------------------------------------------------------------

function currentDepth() {
  return state.depthByType[state.probe];
}

function stepDepth(dir) {
  const lim = DEPTH_LIMITS[state.probe];
  state.depthByType[state.probe] = clampDepth(state.probe, currentDepth() + dir * lim.step);
  state.touched.depth = Date.now();
  renderDepth();
}

function renderDepth() {
  const lim = DEPTH_LIMITS[state.probe];
  const d = currentDepth();
  $('depth-val').textContent = `${Math.round(d * 100)} cm`;
  // Disable at the ends so the range of the transducer is discoverable rather
  // than something you find by mashing the button.
  $('depth-down').disabled = d <= lim.min + 1e-9;
  $('depth-up').disabled = d >= lim.max - 1e-9;
}

$('depth-down').addEventListener('click', () => stepDepth(-1));
$('depth-up').addEventListener('click', () => stepDepth(1));
renderDepth();

const repaintModes = chips(
  $('modes'),
  [
    { id: String(MODES.RAY), label: t('mode.short.1') },
    { id: String(MODES.CUT), label: t('mode.short.2') },
    { id: String(MODES.GHOST), label: t('mode.short.3') },
  ],
  (id) => {
    state.mode = Number(id);
    state.touched.mode = Date.now();
    link?.send({ type: 'mode', mode: state.mode });
  },
  (id) => Number(id) === state.mode,
);

// --- probe placement: drag to slide along the skin --------------------------
// The phone is already in hand and already streaming, so a drag costs nothing
// and keeps the learner's eyes on the viewer screen rather than on the phone.

let dragging = null;

pad.addEventListener('pointerdown', (e) => {
  dragging = { x: e.clientX, y: e.clientY };
  pad.setPointerCapture(e.pointerId);
  pad.classList.add('dragging');
});

pad.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const rect = pad.getBoundingClientRect();
  // Full pad width sweeps half the circumference; full height sweeps most of
  // the torso. Slow enough to place a window, fast enough to cross the body.
  state.u = (((state.u + ((e.clientX - dragging.x) / rect.width) * 0.5) % 1) + 1) % 1;
  state.v = Math.min(Math.max(state.v - ((e.clientY - dragging.y) / rect.height) * 0.6, 0), 1);
  dragging = { x: e.clientX, y: e.clientY };
  state.surfDirty = true;
  state.touched.surf = Date.now();
});

for (const ev of ['pointerup', 'pointercancel']) {
  pad.addEventListener(ev, () => {
    dragging = null;
    pad.classList.remove('dragging');
  });
}

// ---------------------------------------------------------------------------
// transmit loop — capped at 30 Hz; the viewer renders at 60 and interpolates
// ---------------------------------------------------------------------------

/** A viewing-only phone's orientation is dropped by the relay anyway, but
 *  every frame still wakes the room's Durable Object. Keep the socket warm at
 *  2 Hz instead and go to full rate the moment control arrives. */
const IDLE_DIVISOR = 15;
let frameNo = 0;

function startSending() {
  setInterval(() => {
    if (!link?.open || !orientation.running) return;
    frameNo++;
    if (!state.driving && frameNo % IDLE_DIVISOR !== 0) {
      // Still drain the clutch so a stroke made while viewing does not land
      // as one giant jump when control arrives.
      activeSource().read();
      return;
    }

    const payload = {
      q: orientation.read(),
      surf: state.surfDirty ? [state.u, state.v] : null,
      // Displacement since the last frame, metres, recentered frame. Null
      // unless the clutch is engaged and the source actually measured travel —
      // the viewer maps it onto the torso surface, since only the viewer
      // knows the body.
      dpos: activeSource().read(),
      preset: state.pendingPreset,
      probe: state.probe,
      depth: currentDepth(),
    };
    link.sendOrient(payload);

    state.surfDirty = false;
    state.pendingPreset = null;
  }, Math.round(1000 / LIMITS.SEND_HZ));
}

// ---------------------------------------------------------------------------
// language
// ---------------------------------------------------------------------------

applyStatic();
// Paint the JS-driven labels once at startup too. On a fresh load in a language
// the browser already prefers, setLang() short-circuits (the language is
// already current) and no listener fires — so anything whose text comes from
// paintControl rather than from data-i18n would keep the English in the HTML.
paintControl();
renderDepth();
initLangToggle($('lang-toggle'), () => {
  // The chip rows are built once from static arrays, so their labels have to be
  // rewritten in place rather than re-rendered — re-running chips() would drop
  // the click handlers the control rows depend on.
  for (const [host, labels] of [
    ['presets', PRESETS.map((id) => (PRESET_LABELS[id] ? tPreset(id) : id))],
    ['probes', PROBE_TYPES.map((id) => t(`probe.${id}`))],
    ['modes', [t('mode.short.1'), t('mode.short.2'), t('mode.short.3')]],
  ]) {
    const btns = $(host)?.querySelectorAll('button') ?? [];
    btns.forEach((b, i) => { if (labels[i] != null) b.textContent = labels[i]; });
  }
  for (const [id, key] of [
    ['drag', 'phone.dragPad'],
    ['space', 'phone.moveInSpace'],
    ['flow', 'phone.glideCam'],
  ]) {
    const b = document.querySelector(`[data-id="${id}"]`);
    if (b) b.textContent = t(key);
  }
  if (!$('move').disabled) {
    $('move-hint').textContent =
      state.placement === 'flow' ? t('phone.flowHint') : t('phone.spaceHint');
  }
  paintControl();
  renderDepth();
  paintTutorial();
});
