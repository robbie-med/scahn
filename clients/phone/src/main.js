/**
 * Phone entry point. The phone is purely an inertial sensor plus a small
 * control surface: orientation, probe placement, window presets, mode.
 */

import { LIMITS, MODES, PRESETS, PRESET_LABELS, PROBE_TYPES } from '@scahn/protocol';
import { OrientationSource, guessDeviceName } from './orientation.js';
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
/** @type {SensorLink|null} */
let link = null;

const state = {
  driving: false,
  probe: 'curvilinear',
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
    gateMsg.textContent = 'Enter the six-digit code shown on the display.';
    gateMsg.classList.add('err');
    return;
  }

  if (!window.isSecureContext) {
    gateMsg.textContent =
      'This page must be served over HTTPS for motion access. Open the tunnelled URL, not a LAN address.';
    gateMsg.classList.add('err');
    return;
  }

  gateMsg.classList.remove('err');
  gateMsg.textContent = 'Requesting motion access…';

  try {
    const backend = await orientation.start();
    orientation.recenter();
    gateMsg.textContent = '';
    connect(room, backend);
  } catch (err) {
    gateMsg.classList.add('err');
    gateMsg.textContent = err?.message ?? 'Could not start motion sensors.';
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
  statePill.textContent = state.driving ? 'You are driving' : 'Viewing only';
  statePill.classList.toggle('driving', state.driving);
  claimBtn.classList.toggle('hidden', state.driving);
}

// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------

$('recenter').addEventListener('click', () => {
  orientation.recenter();
  statusEl.textContent = 'Recentred.';
});

claimBtn.addEventListener('click', () => link?.claim());

function chips(container, items, onPick, isOn) {
  container.innerHTML = '';
  for (const { id, label } of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.dataset.id = id;
    b.addEventListener('click', () => {
      onPick(id);
      for (const c of container.children) c.classList.toggle('on', isOn(c.dataset.id));
    });
    container.appendChild(b);
  }
  for (const c of container.children) c.classList.toggle('on', isOn(c.dataset.id));
}

chips(
  $('presets'),
  PRESETS.map((id) => ({ id, label: PRESET_LABELS[id] ?? id })),
  (id) => { state.pendingPreset = id; },
  (id) => id === state.pendingPreset,
);

chips(
  $('probes'),
  PROBE_TYPES.map((id) => ({ id, label: id })),
  (id) => { state.probe = id; },
  (id) => id === state.probe,
);

chips(
  $('modes'),
  [
    { id: String(MODES.RAY), label: '1 · Ray' },
    { id: String(MODES.CUT), label: '2 · Cut' },
    { id: String(MODES.GHOST), label: '3 · Ghost' },
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
      preset: state.pendingPreset,
      probe: state.probe,
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
