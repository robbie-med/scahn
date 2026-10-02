/**
 * Room Durable Object — the relay. Spec section 7, revised for Workers.
 *
 * One DO instance per room code, resolved by name, so Cloudflare's routing IS
 * the room map. The §7.5 `Map` is gone and isolation between rooms is
 * structural rather than something this code has to enforce.
 *
 * The same class also backs two kinds of bookkeeping instance, told apart by
 * name rather than by a second DO class (which would need its own migration):
 *   - `quota:<ip>`   per-IP room-creation window (LIMITS.ROOMS_PER_IP_PER_HOUR)
 *   - `quota:global` live-room counter (LIMITS.MAX_ROOMS)
 * Both are only ever reached through the internal `/__…` paths.
 *
 * Hibernation rules that shape everything below:
 *   - Sockets are accepted via `state.acceptWebSocket`, never `server.accept()`,
 *     or the DO can never hibernate.
 *   - No setInterval/setTimeout anywhere. The 20 s heartbeat is
 *     `setWebSocketAutoResponse`, which answers the clients' pings without
 *     waking the DO and is not billed for wall-clock. Room expiry is an Alarm,
 *     which survives hibernation as a timer would not.
 *   - In-memory state is lost on hibernation, so per-socket identity lives in
 *     `serializeAttachment` and room state in storage. Storage is written on
 *     join, claim and close ONLY — never per orientation frame, which at 30 Hz
 *     would be the one way to actually hit the free-tier write limit.
 */

import { ERRORS, LIMITS, PING_FRAME, validateClientFrame } from '../../shared/index.js';

const enc = (obj) => JSON.stringify(obj);
const encoder = new TextEncoder();

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
    // roster's per-sensor RTT is not measurable here — see README. The request
    // string must be byte-identical to what the clients send (PING_FRAME).
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(PING_FRAME, enc({ type: 'pong' })),
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

  /** Ids of sensors that hold a live socket right now. */
  liveSensorIds() {
    const ids = new Set();
    for (const ws of this.state.getWebSockets('sensor')) {
      const id = ws.deserializeAttachment()?.id;
      if (id) ids.add(id);
    }
    return ids;
  }

  // --- quota instances --------------------------------------------------------

  quotaStub(name) {
    return this.env.ROOMS.get(this.env.ROOMS.idFromName(`quota:${name}`));
  }

  /**
   * Internal, on a `quota:<ip>` instance: one more room for this IP within the
   * sliding hour, or 429. Stamps are swept by the alarm so an IP that stops
   * creating rooms costs nothing after an hour.
   */
  async quotaIp() {
    const now = Date.now();
    const stamps = ((await this.state.storage.get('stamps')) ?? [])
      .filter((t) => now - t < 3_600_000);
    if (stamps.length >= LIMITS.ROOMS_PER_IP_PER_HOUR) {
      return new Response('rate limited', { status: 429 });
    }
    stamps.push(now);
    await this.state.storage.put('kind', 'quota');
    await this.state.storage.put('stamps', stamps);
    await this.state.storage.setAlarm(now + 3_600_000);
    return new Response('ok');
  }

  /**
   * Internal, on `quota:global`: count a room in (503 when full) or out.
   *
   * Not a bare counter. A room that dies without its expiry alarm releasing
   * it — a lost alarm in production, or a `wrangler dev` killed before the
   * alarms fired — would leak a count forever, and 200 leaks later nobody
   * can create a room. So the record is {code: stamp}; a room renews its
   * stamp on every join, and stamps older than a day are dropped before
   * counting. A session longer than a day with no phone joining is pruned
   * from the count, which is harmless.
   */
  async quotaGlobal(delta, code) {
    const now = Date.now();
    const live = (await this.state.storage.get('live')) ?? {};
    const rooms = typeof live === 'object' && live !== null ? live : {};
    for (const [c, t] of Object.entries(rooms)) {
      if (now - t > 24 * 3_600_000) delete rooms[c];
    }
    if (delta > 0) {
      if (!rooms[code] && Object.keys(rooms).length >= LIMITS.MAX_ROOMS) {
        return new Response('server full', { status: 503 });
      }
      rooms[code] = now;
    } else {
      delete rooms[code];
    }
    await this.state.storage.put('kind', 'quota');
    await this.state.storage.put('live', rooms);
    return new Response('ok');
  }

  // --- lifecycle ------------------------------------------------------------

  /**
   * Internal: claim this code if unused. Returns 409 if the room already
   * exists, which is how the Worker guarantees code uniqueness rather than
   * hoping for it; 429 / 503 when the creating IP or the service is over
   * quota. `ip` is null when the Worker has already applied the per-IP check.
   */
  async claimCode(code, ip) {
    const created = await this.state.storage.get('created');
    if (created) return new Response('taken', { status: 409 });
    if (ip) {
      const q = await this.quotaStub(ip).fetch('https://scahn.internal/__quota');
      if (!q.ok) return q;
    }
    const g = await this.quotaStub('global').fetch(`https://scahn.internal/__acquire?room=${code}`);
    if (!g.ok) return g;
    await this.state.storage.put('created', Date.now());
    await this.state.storage.put('code', code);
    // Expire if no sensor ever joins.
    await this.state.storage.setAlarm(Date.now() + LIMITS.ROOM_EMPTY_TTL_MS);
    return new Response('ok');
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/__quota') return this.quotaIp();
    if (url.pathname === '/__acquire') return this.quotaGlobal(+1, url.searchParams.get('room'));
    if (url.pathname === '/__release') return this.quotaGlobal(-1, url.searchParams.get('room'));
    if (url.pathname === '/__claim') {
      const ip = url.searchParams.get('checked') ? null : (url.searchParams.get('ip') || null);
      return this.claimCode(url.searchParams.get('room'), ip);
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
    // The code is still unique — it *is* this Durable Object. Revival is a
    // creation for quota purposes, so it carries the caller's IP.
    if (role === 'display' && !created) {
      const res = await this.claimCode(code, request.headers.get('cf-connecting-ip'));
      if (!res.ok) return res;
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
    // `length` counts UTF-16 units, so a frame can pass that check and still
    // be three times the byte budget. Encode only when the cheap check passes.
    if (typeof raw !== 'string' || raw.length > LIMITS.MAX_FRAME_BYTES
        || encoder.encode(raw).length > LIMITS.MAX_FRAME_BYTES) {
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
        // Only a ping that is NOT byte-identical to PING_FRAME reaches here
        // (the auto-response answers the exact one without waking us).
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

      case 'freeze': {
        if (att.role !== 'sensor' || att.id !== (await this.active())) return;
        return this.toDisplays(enc({ type: 'freeze', on: msg.on }));
      }

      case 'state': {
        // The display's authoritative probe state, fanned out to every phone
        // so their controls mirror the screen. Displays only; no storage.
        if (att.role !== 'display') return;
        return this.toSensors(raw);
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
    const live = this.liveSensorIds();
    const now = Date.now();

    // Prune identities that have been socket-less past the grace period, so a
    // teaching session's worth of phones that lost their token (private tab,
    // another browser) cannot fill the room with ghosts. Every entry carries a
    // `lastSeen` from its join or close, so a socket that died without a close
    // event still ages out. Same policy as the Node relay's pruneSensors.
    for (const [id, s] of Object.entries(sensors)) {
      if (!live.has(id) && now - (s.lastSeen ?? 0) > LIMITS.ROOM_GRACE_MS) delete sensors[id];
    }

    let entry = null;
    if (msg.token) {
      const found = Object.entries(sensors).find(([, s]) => s.token === msg.token);
      if (found) entry = { id: found[0], ...found[1] };
    }

    if (!entry) {
      // The cap counts phones that are actually connected, not every identity
      // ever issued.
      if (live.size >= LIMITS.MAX_SENSORS_PER_ROOM) {
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

    sensors[entry.id] = { name: entry.name, token: entry.token, lastSeen: now };
    await this.putSensors(sensors);

    ws.serializeAttachment({ ...att, id: entry.id });

    // First sensor into a room with nobody driving takes control automatically.
    // "Nobody driving" includes a driver whose phone has gone for good: a brief
    // background/resume keeps control (webSocketClose leaves it alone), but a
    // phone that joins while the old driver has no socket must not be left
    // waving at a frozen screen. Same rule as the Node relay's
    // claimIfUncontested.
    const active = await this.active();
    if (!active || !sensors[active] || !live.has(active)) await this.setActive(entry.id);

    // The room is now in use; push expiry out to the idle-teardown window,
    // and renew the global live-room stamp (see quotaGlobal).
    await this.state.storage.setAlarm(Date.now() + LIMITS.ROOM_EMPTY_TTL_MS);
    await this.quotaStub('global').fetch(`https://scahn.internal/__acquire?room=${att.code}`);

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

  toSensors(payload) {
    for (const ws of this.state.getWebSockets('sensor')) {
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
    this.toSensors(frame);
  }

  // --- teardown -------------------------------------------------------------

  async webSocketClose(ws) {
    this._rate.delete(ws);
    // Deliberately does NOT clear activeSensorId: a brief background/resume
    // must not silently hand control to whoever else is holding a phone.
    // It does stamp the identity, so joinSensor can age it out later.
    const att = ws.deserializeAttachment();
    if (att?.role === 'sensor' && att.id) {
      const sensors = { ...(await this.sensors()) };
      if (sensors[att.id]) {
        sensors[att.id] = { ...sensors[att.id], lastSeen: Date.now() };
        await this.putSensors(sensors);
      }
    }
    await this.broadcastRoster();
    await this.scheduleTeardown();
  }

  async webSocketError(ws) {
    this._rate.delete(ws);
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
   *  wipes when nothing is connected. Quota instances just forget. */
  async alarm() {
    if ((await this.state.storage.get('kind')) === 'quota') {
      await this.state.storage.deleteAll();
      return;
    }
    const anyLive =
      this.state.getWebSockets('display').length + this.state.getWebSockets('sensor').length;
    if (anyLive > 0) {
      await this.state.storage.setAlarm(Date.now() + LIMITS.ROOM_EMPTY_TTL_MS);
      return;
    }
    if (await this.state.storage.get('created')) {
      const code = await this.state.storage.get('code');
      await this.quotaStub('global').fetch(`https://scahn.internal/__release?room=${code}`);
    }
    await this.state.storage.deleteAll();
    this._active = undefined;
    this._sensors = undefined;
  }
}
