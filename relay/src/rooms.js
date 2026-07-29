/**
 * Room registry. Spec section 7.3-7.5.
 *
 * The relay does no computation — it is a pipe. This module holds the only
 * state that exists: who is in which room, and which sensor is driving.
 */

import { randomBytes } from 'node:crypto';
import { LIMITS } from '@scahn/protocol';

const now = () => Date.now();

function newToken() {
  return randomBytes(16).toString('hex');
}

export class RoomRegistry {
  constructor({ log = () => {} } = {}) {
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
    /** @type {Map<string, number[]>} ip -> creation timestamps */
    this.ipCreations = new Map();
    this.log = log;
  }

  get size() {
    return this.rooms.size;
  }

  /** Numeric 6-digit code, assigned here so uniqueness is guaranteed rather
   *  than probabilistic, and so a buggy client cannot squat on a live code. */
  allocateCode() {
    for (let attempt = 0; attempt < 500; attempt++) {
      // randomInt-free: 3 bytes is plenty of entropy for a 6-digit space.
      const n = randomBytes(4).readUInt32BE(0) % 1_000_000;
      const code = String(n).padStart(6, '0');
      if (!this.rooms.has(code)) return code;
    }
    return null;
  }

  /** Returns { room } or { error }. */
  createRoom(ip) {
    if (this.rooms.size >= LIMITS.MAX_ROOMS) return { error: 'server_full' };

    const hourAgo = now() - 3_600_000;
    const stamps = (this.ipCreations.get(ip) ?? []).filter((t) => t > hourAgo);
    if (stamps.length >= LIMITS.ROOMS_PER_IP_PER_HOUR) return { error: 'rate_limited' };
    stamps.push(now());
    this.ipCreations.set(ip, stamps);

    const code = this.allocateCode();
    if (!code) return { error: 'server_full' };

    const room = new Room(code);
    this.rooms.set(code, room);
    this.log(`room ${code} created by ${ip} (${this.rooms.size} live)`);
    return { room };
  }

  get(code) {
    return this.rooms.get(code) ?? null;
  }

  /** Drop expired rooms. Called on an interval by the server. */
  sweep() {
    const t = now();
    for (const [code, room] of this.rooms) {
      let reason = null;

      // Never used: expires TTL after creation if no sensor ever joined.
      if (!room.everHadSensor && t - room.createdAt > LIMITS.ROOM_EMPTY_TTL_MS) {
        reason = 'unused';
      }
      // Fully empty: torn down after the grace period. A display closing its
      // lid must NOT kill the room, which is why this counts *all* sockets and
      // only starts the clock when every one of them is gone.
      else if (room.emptySince != null && t - room.emptySince > LIMITS.ROOM_GRACE_MS) {
        reason = 'empty';
      }

      if (reason) {
        this.rooms.delete(code);
        this.log(`room ${code} torn down (${reason})`);
      }
    }
  }
}

export class Room {
  constructor(code) {
    this.code = code;
    /** @type {Set<object>} live display sockets */
    this.displaySockets = new Set();
    /** @type {Map<string, SensorEntry>} sensorId -> entry (survives disconnect) */
    this.sensors = new Map();
    this.activeSensorId = null;
    this.createdAt = now();
    this.lastActivity = now();
    this.everHadSensor = false;
    /** Timestamp at which the room became fully socket-less, or null. */
    this.emptySince = null;
    this._seq = 0;
  }

  touch() {
    this.lastActivity = now();
  }

  /** Sensors that currently hold a live socket. */
  liveSensors() {
    return [...this.sensors.values()].filter((s) => s.socket != null);
  }

  socketCount() {
    return this.displaySockets.size + this.liveSensors().length;
  }

  /** Re-evaluate whether the teardown clock should be running. */
  recomputeEmpty() {
    if (this.socketCount() === 0) {
      if (this.emptySince == null) this.emptySince = now();
    } else {
      this.emptySince = null;
    }
  }

  addDisplay(socket) {
    this.displaySockets.add(socket);
    this.recomputeEmpty();
    this.touch();
  }

  removeDisplay(socket) {
    this.displaySockets.delete(socket);
    this.recomputeEmpty();
  }

  /**
   * Join or *rejoin* a sensor. Token replay is what makes iOS survivable: Safari
   * suspends WebSockets whenever it backgrounds, and it will background every
   * time someone glances at a notification. Reconnecting must restore the same
   * sensor identity and control state, silently.
   *
   * Returns { entry } or { error }.
   */
  joinSensor({ socket, name, token }) {
    if (token) {
      const existing = [...this.sensors.values()].find((s) => s.token === token);
      if (existing) {
        // Drop any stale socket still attached under this identity.
        if (existing.socket && existing.socket !== socket) {
          try {
            existing.socket.close(4000, 'superseded');
          } catch { /* already gone */ }
        }
        existing.socket = socket;
        if (name) existing.name = name;
        existing.lastSeen = now();
        this.everHadSensor = true;
        this.recomputeEmpty();
        this.touch();
        this.claimIfUncontested(existing.id);
        return { entry: existing, resumed: true };
      }
    }

    if (this.sensors.size >= LIMITS.MAX_SENSORS_PER_ROOM) return { error: 'room_full' };

    const id = `s${++this._seq}`;
    const entry = {
      id,
      name: name || 'Phone',
      token: newToken(),
      socket,
      rtt: null,
      lastSeen: now(),
    };
    this.sensors.set(id, entry);
    this.everHadSensor = true;
    this.recomputeEmpty();
    this.touch();
    this.claimIfUncontested(id);
    return { entry, resumed: false };
  }

  /** First sensor into a room with nobody driving takes control automatically. */
  claimIfUncontested(id) {
    const active = this.activeSensorId ? this.sensors.get(this.activeSensorId) : null;
    if (!active || active.socket == null) this.activeSensorId = id;
  }

  /** Explicit handoff: a phone sends `claim` to take control. */
  claim(id) {
    if (!this.sensors.has(id)) return false;
    this.activeSensorId = id;
    this.touch();
    return true;
  }

  detachSensor(socket) {
    for (const entry of this.sensors.values()) {
      if (entry.socket === socket) {
        entry.socket = null;
        entry.lastSeen = now();
        // Deliberately does NOT clear activeSensorId. A brief background/resume
        // must not silently hand control to whoever else is holding a phone.
        this.recomputeEmpty();
        return entry;
      }
    }
    return null;
  }

  /** Purge sensor identities that have been socket-less past the grace period,
   *  so the roster does not accumulate ghosts across a teaching session. */
  pruneSensors() {
    const t = now();
    for (const [id, entry] of this.sensors) {
      if (entry.socket == null && t - entry.lastSeen > LIMITS.ROOM_GRACE_MS) {
        this.sensors.delete(id);
        if (this.activeSensorId === id) {
          const fallback = this.liveSensors()[0];
          this.activeSensorId = fallback ? fallback.id : null;
        }
      }
    }
  }

  rosterFrame() {
    return {
      type: 'roster',
      room: this.code,
      sensors: this.liveSensors().map((s) => ({
        id: s.id,
        name: s.name,
        active: s.id === this.activeSensorId,
        rtt: s.rtt,
      })),
      displays: this.displaySockets.size,
    };
  }
}
