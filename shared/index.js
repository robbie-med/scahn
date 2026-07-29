/**
 * Shared wire protocol between phone (sensor), relay, and viewer (display).
 *
 * Imported by all three so the message-type allowlist and the limits can never
 * drift apart. See spec section 4.
 */

export const PROTOCOL_VERSION = 1;

/** Message types a *client* is allowed to send. Validated at the relay before
 *  any other field of the frame is touched. */
export const CLIENT_MSG_TYPES = Object.freeze([
  'create',
  'join',
  'claim',
  'orient',
  'mode',
  'ping',
  'pong',
]);

/** Message types the relay emits. Listed for the clients' benefit. */
export const SERVER_MSG_TYPES = Object.freeze([
  'created',
  'joined',
  'roster',
  'orient',
  'mode',
  'ping',
  'pong',
  'error',
]);

export const ROLES = Object.freeze(['sensor', 'display']);

export const PROBE_TYPES = Object.freeze(['curvilinear', 'phased', 'linear']);

/** Named scan windows, spec section 8. Order is the order shown on the phone. */
export const PRESETS = Object.freeze([
  'subxiphoid',
  'parasternal-long',
  'parasternal-short',
  'apical-four-chamber',
  'ruq-morison',
  'luq-splenorenal',
  'suprapubic',
  'aorta-transverse',
]);

export const MODES = Object.freeze({ RAY: 1, CUT: 2, GHOST: 3 });

/**
 * Selectable imaging depth per transducer, in metres. Ranges follow what the
 * corresponding real probe can actually resolve — a linear probe has no
 * business at 20 cm, and a phased array is wasted at 4 cm.
 *
 * Shared rather than viewer-local so the phone's depth stepper and the viewer's
 * beam geometry cannot disagree about the limits.
 */
export const DEPTH_LIMITS = Object.freeze({
  curvilinear: { min: 0.08, max: 0.30, step: 0.02, default: 0.20 },
  phased: { min: 0.06, max: 0.24, step: 0.02, default: 0.18 },
  linear: { min: 0.02, max: 0.09, step: 0.01, default: 0.06 },
});

/** Clamp a depth to what the given transducer supports, snapped to its step. */
export function clampDepth(probeType, depth) {
  const lim = DEPTH_LIMITS[probeType];
  if (!lim) return depth;
  const snapped = Math.round(depth / lim.step) * lim.step;
  // Re-round to kill binary float dust so equality checks stay meaningful.
  return Math.round(Math.min(Math.max(snapped, lim.min), lim.max) * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Limits (spec section 7.5)
// ---------------------------------------------------------------------------

export const LIMITS = Object.freeze({
  /** Max inbound frames per second per socket. Sits above the 30 Hz orientation
   *  rate with headroom for control frames. */
  MSG_PER_SEC: 60,
  /** Max bytes per frame. Enforced by ws `maxPayload` *and* re-checked. */
  MAX_FRAME_BYTES: 4096,
  /** Orientation transmit cap on the phone. */
  SEND_HZ: 30,
  /** Heartbeat interval, both directions. */
  HEARTBEAT_MS: 20_000,
  /** Missed pongs before a socket is considered dropped. */
  MISSED_PONGS: 2,
  /** Room expires this long after creation if no sensor ever joins. */
  ROOM_EMPTY_TTL_MS: 10 * 60_000,
  /** Room is torn down this long after the last socket drops. */
  ROOM_GRACE_MS: 2 * 60_000,
  /** Rooms one IP may create per hour. */
  ROOMS_PER_IP_PER_HOUR: 30,
  /** Global ceiling on live rooms. */
  MAX_ROOMS: 200,
  /** Max sensors in one room. */
  MAX_SENSORS_PER_ROOM: 16,
});

export const ERRORS = Object.freeze({
  NO_SUCH_ROOM: 'no_such_room',
  BAD_FRAME: 'bad_frame',
  RATE_LIMITED: 'rate_limited',
  ROOM_FULL: 'room_full',
  SERVER_FULL: 'server_full',
  BAD_ROLE: 'bad_role',
  NOT_IN_ROOM: 'not_in_room',
});

// ---------------------------------------------------------------------------
// Room codes
// ---------------------------------------------------------------------------

/** Six digits, numeric. Numeric triggers the phone's numeric keypad on typed
 *  fallback and reads aloud cleanly across a room. Assigned by the relay only —
 *  server assignment makes uniqueness guaranteed rather than probabilistic. */
export const ROOM_CODE_RE = /^[0-9]{6}$/;

export function isRoomCode(x) {
  return typeof x === 'string' && ROOM_CODE_RE.test(x);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const isFiniteNum = (n) => typeof n === 'number' && Number.isFinite(n);

/** A quaternion is 4 finite numbers, XYZW, roughly unit length. */
export function isQuaternion(q) {
  if (!Array.isArray(q) || q.length !== 4 || !q.every(isFiniteNum)) return false;
  const len2 = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3];
  return len2 > 0.5 && len2 < 1.5;
}

/**
 * Validate a decoded client frame. Returns null if fine, else an ERRORS code.
 *
 * Deliberately checks `type` against the allowlist *first* — nothing else on the
 * object is read until the type is known-good.
 */
export function validateClientFrame(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return ERRORS.BAD_FRAME;
  if (!CLIENT_MSG_TYPES.includes(msg.type)) return ERRORS.BAD_FRAME;

  switch (msg.type) {
    case 'join':
      if (!ROLES.includes(msg.role)) return ERRORS.BAD_ROLE;
      if (msg.role === 'sensor' && !isRoomCode(msg.room)) return ERRORS.NO_SUCH_ROOM;
      if (msg.room != null && !isRoomCode(msg.room)) return ERRORS.NO_SUCH_ROOM;
      if (msg.name != null && typeof msg.name !== 'string') return ERRORS.BAD_FRAME;
      if (msg.token != null && typeof msg.token !== 'string') return ERRORS.BAD_FRAME;
      return null;

    case 'orient':
      if (!isQuaternion(msg.q)) return ERRORS.BAD_FRAME;
      if (msg.surf != null) {
        if (!Array.isArray(msg.surf) || msg.surf.length !== 2 || !msg.surf.every(isFiniteNum)) {
          return ERRORS.BAD_FRAME;
        }
      }
      if (msg.preset != null && !PRESETS.includes(msg.preset)) return ERRORS.BAD_FRAME;
      if (msg.probe != null && !PROBE_TYPES.includes(msg.probe)) return ERRORS.BAD_FRAME;
      // Optional physical-translation delta, metres, in the recentered frame.
      // Additive and optional, so v1 clients that never send it stay valid.
      // Imaging depth in metres. Range covers a 2 cm linear-probe window up to
      // a 40 cm deep abdominal sweep; anything outside is a bad frame.
      if (msg.depth != null) {
        if (!isFiniteNum(msg.depth) || msg.depth < 0.02 || msg.depth > 0.40) {
          return ERRORS.BAD_FRAME;
        }
      }
      if (msg.dpos != null) {
        if (!Array.isArray(msg.dpos) || msg.dpos.length !== 3 || !msg.dpos.every(isFiniteNum)) {
          return ERRORS.BAD_FRAME;
        }
        // A single 30 Hz frame can never legitimately carry a metre of travel;
        // reject rather than let an integration blow-up teleport the probe.
        if (msg.dpos.some((n) => Math.abs(n) > 1)) return ERRORS.BAD_FRAME;
      }
      return null;

    case 'mode':
      if (![MODES.RAY, MODES.CUT, MODES.GHOST].includes(msg.mode)) return ERRORS.BAD_FRAME;
      return null;

    case 'create':
    case 'claim':
    case 'ping':
    case 'pong':
      return null;

    default:
      return ERRORS.BAD_FRAME;
  }
}

/** Human-readable label for a preset id, for the viewer's window readout. */
export const PRESET_LABELS = Object.freeze({
  'subxiphoid': 'Subxiphoid',
  'parasternal-long': 'Parasternal Long Axis',
  'parasternal-short': 'Parasternal Short Axis',
  'apical-four-chamber': 'Apical 4-Chamber',
  'ruq-morison': "RUQ / Morison's Pouch",
  'luq-splenorenal': 'LUQ / Splenorenal',
  'suprapubic': 'Suprapubic',
  'aorta-transverse': 'Aorta (Transverse)',
});

/** Transducer that each window is normally performed with (spec section 9, P6). */
export const PRESET_PROBE = Object.freeze({
  'subxiphoid': 'phased',
  'parasternal-long': 'phased',
  'parasternal-short': 'phased',
  'apical-four-chamber': 'phased',
  'ruq-morison': 'curvilinear',
  'luq-splenorenal': 'curvilinear',
  'suprapubic': 'curvilinear',
  'aorta-transverse': 'curvilinear',
});
