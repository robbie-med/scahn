/**
 * Phone entry point. The phone is purely an inertial sensor plus a small
 * control surface: orientation, probe placement, window presets, mode.
 */

import { applyStatic, initLangToggle, t, tPreset } from '@scahn/protocol/i18n';
import {
  DEPTH_LIMITS, LIMITS, MODES, PRESETS, PRESET_LABELS, PRESET_PROBE, PROBE_TYPES,
  clampDepth,
} from '@scahn/protocol';
import { OrientationSource, guessDeviceName } from './orientation.js';
import { TranslationSource } from './translation.js';
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
/** @type {SensorLink|null} */
let link = null;

const state = {
  driving: false,
  /** 'drag' = the original touch-pad placement; 'space' = physically moving
   *  the phone. Mutually exclusive so the two cannot fight over (u,v). */
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
  pendingPreset: null,
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
}

// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------

$('recenter').addEventListener('click', () => {
  orientation.recenter();
  translation.release();
  statusEl.textContent = t('phone.recentred');
});

// --- placement mode toggle --------------------------------------------------

let translationAvailable = true;

function setPlacement(mode) {
  if (mode === 'space' && !translationAvailable) return;
  state.placement = mode;
  // Leaving space mode must drop the clutch, or a stroke in progress keeps
  // integrating with no visible control to stop it.
  if (mode !== 'space') releaseMove();
  $('pane-drag').classList.toggle('hidden', mode !== 'drag');
  $('pane-space').classList.toggle('hidden', mode !== 'space');
  renderPlacementMode();
}

function renderPlacementMode() {
  const host = $('placement-mode');
  host.innerHTML = '';
  for (const [id, label] of [['drag', t('phone.dragPad')], ['space', t('phone.moveInSpace')]]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.className = state.placement === id ? 'on' : '';
    b.disabled = id === 'space' && !translationAvailable;
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
  translation.engage();
  moveBtn.classList.add('engaged');
  try { moveBtn.setPointerCapture(e.pointerId); } catch { /* not a pointer */ }
}

function releaseMove() {
  if (!translation.enabled) return;
  translation.release();
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

chips(
  $('presets'),
  PRESETS.map((id) => ({ id, label: PRESET_LABELS[id] ? tPreset(id) : id })),
  (id) => {
    state.pendingPreset = id;
    // A window implies its usual transducer. The phone has to adopt it too:
    // it sends `probe` on every frame, so leaving it stale would immediately
    // clobber the transducer the preset just selected on the viewer.
    state.probe = PRESET_PROBE[id] ?? state.probe;
    repaintProbes();
    renderDepth();
  },
  (id) => id === state.pendingPreset,
);

const repaintProbes = chips(
  $('probes'),
  PROBE_TYPES.map((id) => ({ id, label: t(`probe.${id}`) })),
  (id) => { state.probe = id; renderDepth(); },
  (id) => id === state.probe,
);

// --- depth ------------------------------------------------------------------

function currentDepth() {
  return state.depthByType[state.probe];
}

function stepDepth(dir) {
  const lim = DEPTH_LIMITS[state.probe];
  state.depthByType[state.probe] = clampDepth(state.probe, currentDepth() + dir * lim.step);
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

chips(
  $('modes'),
  [
    { id: String(MODES.RAY), label: t('mode.short.1') },
    { id: String(MODES.CUT), label: t('mode.short.2') },
    { id: String(MODES.GHOST), label: t('mode.short.3') },
  ],
  (id) => {
    state.mode = Number(id);
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

function startSending() {
  setInterval(() => {
    if (!link?.open || !orientation.running) return;

    const payload = {
      q: orientation.read(),
      surf: state.surfDirty ? [state.u, state.v] : null,
      // Displacement since the last frame, metres, recentered frame. Null
      // unless the clutch is engaged and the phone actually moved — the viewer
      // maps it onto the torso surface, since only the viewer knows the body.
      dpos: translation.read(),
      preset: state.pendingPreset,
      probe: state.probe,
      depth: currentDepth(),
    };
    link.sendOrient(payload);

    state.surfDirty = false;
    if (state.pendingPreset) {
      // A preset also implies its usual transducer; mirror the viewer's choice
      // locally so the chip highlight does not lie.
      state.pendingPreset = null;
    }
  }, Math.round(1000 / LIMITS.SEND_HZ));
}

// ---------------------------------------------------------------------------
// language
// ---------------------------------------------------------------------------

applyStatic();
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
  for (const [id, key] of [['drag', 'phone.dragPad'], ['space', 'phone.moveInSpace']]) {
    const b = document.querySelector(`[data-id="${id}"]`);
    if (b) b.textContent = t(key);
  }
  paintControl();
  renderDepth();
});
