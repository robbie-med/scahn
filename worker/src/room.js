/**
 * Room Durable Object — the relay. Spec section 7, revised for Workers.
 *
 * One DO instance per room code, resolved by name, so Cloudflare's routing IS
 * the room map. The §7.5 `Map` is gone and isolation between rooms is
 * structural rather than something this code has to enforce.
 *
 * Hibernation rules that shape everything below:
 *   - Sockets are accepted via `state.acceptWebSocket`, never `server.accept()`,
 *     or the DO can never hibernate.
 *   - No setInterval/setTimeout anywhere. The 20 s heartbeat is
 *     `setWebSocketAutoResponse`, which answers pings without waking the DO and
 *     is not billed for wall-clock. Room expiry is an Alarm, which survives
 *     hibernation as a timer would not.
 *   - In-memory state is lost on hibernation, so per-socket identity lives in
 *     `serializeAttachment` and room state in storage. Storage is written on
 *     join and claim ONLY — never per orientation frame, which at 30 Hz would
 *     be the one way to actually hit the free-tier write limit.
 */

import { ERRORS, LIMITS, validateClientFrame } from '../../shared/index.js';

const enc = (obj) => JSON.stringify(obj);

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    /** Lazily loaded caches; may be dropped by hibernation at any time. */
    this._active = undefined;
    this._sensors = undefined;
    /** Per-socket inbound rate windows. In-memory only: hibernation drops this,
     *  which is harmless because a hibernating DO is by definition not being
     *  flooded. This endpoint is public, so the cap is not optional. */
    this._rate = new Map();

    // Fixed-string heartbeat. It cannot echo a timestamp, which is why the
    // roster's per-sensor RTT is not measurable here — see README.
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(enc({ type: 'ping' }), enc({ type: 'pong' })),
    );
  }

  // --- persisted room state -------------------------------------------------

  async sensors() {
    if (this._sensors === undefined) {
      this._sensors = (await this.state.storage.get('sensors')) ?? {};
    }
    return this._sensors;
  }

  async active() {
    if (this._active === undefined) {
      this._active = (await this.state.storage.get('active')) ?? null;
    }
    return this._active;
  }

  async setActive(id) {
    this._active = id;
    await this.state.storage.put('active', id);
  }

  async putSensors(sensors) {
    this._sensors = sensors;
    await this.state.storage.put('sensors', sensors);
  }

  // --- lifecycle ------------------------------------------------------------

  /**
   * Internal: claim this code if unused. Returns 409 if the room already
   * exists, which is how the Worker guarantees code uniqueness rather than
   * hoping for it.
   */
  async claimCode(code) {
    const created = await this.state.storage.get('created');
    if (created) return new Response('taken', { status: 409 });
    await this.state.storage.put('created', Date.now());
    await this.state.storage.put('code', code);
    // Expire if no sensor ever joins.
    await this.state.storage.setAlarm(Date.now() + LIMITS.ROOM_EMPTY_TTL_MS);
    return new Response('ok');
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/__claim') {
      return this.claimCode(url.searchParams.get('room'));
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }

    const role = url.searchParams.get('role');
    const code = url.searchParams.get('room');
    if (role !== 'display' && role !== 'sensor') {
      return new Response('bad role', { status: 400 });
    }
    const created = await this.state.storage.get('created');
    // A sensor may only join a room that exists.
    if (role === 'sensor' && !created) {
      return new Response('no such room', { status: 404 });
    }
    // A display reconnecting to a code that has since expired revives it rather
    // than being handed a live-looking room that no phone can actually join.
    // The code is still unique — it *is* this Durable Object.
    if (role === 'display' && !created) {
      await this.claimCode(code);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Tagged so getWebSockets('display') survives hibernation.
    this.state.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, id: null, code });

    if (role === 'display') {
      server.send(enc({
        type: 'created',
        room: code,
        ttl: Math.round(LIMITS.ROOM_EMPTY_TTL_MS / 1000),
      }));
      await this.broadcastRoster();
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // --- messaging ------------------------------------------------------------

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > LIMITS.MAX_FRAME_BYTES) {
      return ws.send(enc({ type: 'error', code: ERRORS.BAD_FRAME }));
    }

    const now = Date.now();
    let win = this._rate.get(ws);
    if (!win || now - win.start >= 1000) {
      win = { start: now, n: 0 };
      this._rate.set(ws, win);
    }
    if (++win.n > LIMITS.MSG_PER_SEC) {
      return ws.send(enc({ type: 'error', code: ERRORS.RATE_LIMITED }));
    }

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return ws.send(enc({ type: 'error', code: ERRORS.BAD_FRAME }));
    }

    // Validate type against the allowlist before touching any other field.
    const bad = validateClientFrame(msg);
    if (bad) return ws.send(enc({ type: 'error', code: bad }));

    const att = ws.deserializeAttachment() ?? {};

    switch (msg.type) {
      case 'ping':
        return ws.send(enc({ type: 'pong', t: msg.t }));
      case 'pong':
        return;

      case 'join': {
        if (att.role !== 'sensor') return;
        return this.joinSensor(ws, att, msg);
      }

      case 'claim': {
        if (att.role !== 'sensor' || !att.id) return;
        await this.setActive(att.id);
        return this.broadcastRoster();
      }

      case 'orient': {
        // The single check that prevents last-writer-wins chaos when two people
        // move at once. No storage write on this path.
        if (att.role !== 'sensor' || att.id !== (await this.active())) return;
        return this.toDisplays(raw);
      }

      case 'mode': {
        if (att.role !== 'sensor' || att.id !== (await this.active())) return;
        return this.toDisplays(enc({ type: 'mode', mode: msg.mode }));
      }
    }
  }

  /**
   * Join or rejoin. Token replay is what makes iOS survivable: Safari suspends
   * sockets whenever it backgrounds, and reconnecting must restore the same
   * identity and control state silently.
   */
  async joinSensor(ws, att, msg) {
    const sensors = { ...(await this.sensors()) };

    let entry = null;
    if (msg.token) {
      const found = Object.entries(sensors).find(([, s]) => s.token === msg.token);
      if (found) entry = { id: found[0], ...found[1] };
    }

    if (!entry) {
      if (Object.keys(sensors).length >= LIMITS.MAX_SENSORS_PER_ROOM) {
        return ws.send(enc({ type: 'error', code: ERRORS.ROOM_FULL }));
      }
      const seq = ((await this.state.storage.get('seq')) ?? 0) + 1;
      await this.state.storage.put('seq', seq);
      entry = {
        id: `s${seq}`,
        name: typeof msg.name === 'string' ? msg.name.slice(0, 40) : 'Phone',
        token: crypto.randomUUID().replace(/-/g, ''),
      };
    }
    if (typeof msg.name === 'string' && msg.name) entry.name = msg.name.slice(0, 40);

    sensors[entry.id] = { name: entry.name, token: entry.token };
    await this.putSensors(sensors);

    ws.serializeAttachment({ ...att, id: entry.id });

    // First sensor into a room with nobody driving takes control automatically.
    const active = await this.active();
    if (!active || !sensors[active]) await this.setActive(entry.id);

    // The room is now in use; push expiry out to the idle-teardown window.
    await this.state.storage.setAlarm(Date.now() + LIMITS.ROOM_EMPTY_TTL_MS);

    ws.send(enc({
      type: 'joined',
      id: entry.id,
      token: entry.token,
      active: (await this.active()) === entry.id,
      room: att.code,
    }));
    await this.broadcastRoster();
  }

  // --- fan-out --------------------------------------------------------------

  toDisplays(payload) {
    for (const ws of this.state.getWebSockets('display')) {
      try {
        ws.send(payload);
      } catch { /* closing */ }
    }
  }

  async broadcastRoster() {
    const sensors = await this.sensors();
    const activeId = await this.active();

    // Only sockets that are actually connected appear on the roster.
    const live = new Map();
    for (const ws of this.state.getWebSockets('sensor')) {
      const att = ws.deserializeAttachment();
      if (att?.id && sensors[att.id]) live.set(att.id, sensors[att.id]);
    }

    const frame = enc({
      type: 'roster',
      room: await this.state.storage.get('code'),
      sensors: [...live.entries()].map(([id, s]) => ({
        id,
        name: s.name,
        active: id === activeId,
        // Not measurable under setWebSocketAutoResponse: the auto-pong never
        // wakes the DO, so it cannot time a round trip. Left null deliberately.
        rtt: null,
      })),
      displays: this.state.getWebSockets('display').length,
    });

    this.toDisplays(frame);
    for (const ws of this.state.getWebSockets('sensor')) {
      try {
        ws.send(frame);
      } catch { /* closing */ }
    }
  }

  // --- teardown -------------------------------------------------------------

  async webSocketClose(ws) {
    // Deliberately does NOT clear activeSensorId: a brief background/resume
    // must not silently hand control to whoever else is holding a phone.
    await this.broadcastRoster();
    await this.scheduleTeardown();
  }

  async webSocketError() {
    await this.broadcastRoster();
  }

  async scheduleTeardown() {
    const anyLive =
      this.state.getWebSockets('display').length + this.state.getWebSockets('sensor').length;
    if (anyLive === 0) {
      await this.state.storage.setAlarm(Date.now() + LIMITS.ROOM_GRACE_MS);
    }
  }

  /** Room expiry. A closing laptop lid must not kill the room, so this only
   *  wipes when nothing is connected. */
  async alarm() {
    const anyLive =
      this.state.getWebSockets('display').length + this.state.getWebSockets('sensor').length;
    if (anyLive > 0) {
      await this.state.storage.setAlarm(Date.now() + LIMITS.ROOM_EMPTY_TTL_MS);
      return;
    }
    await this.state.storage.deleteAll();
    this._active = undefined;
    this._sensors = undefined;
  }
}
