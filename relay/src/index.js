/**
 * Scahn relay. Spec section 7.
 *
 * A pipe, not a computer. Room-code pairing and fan-out from the active sensor
 * to the room's displays. All math happens on the phone (sensor fusion,
 * recentering) or the viewer (plane derivation, rendering).
 *
 * Serves both static clients from the same origin as the WS endpoint.
 */

import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { ERRORS, LIMITS, validateClientFrame } from '@scahn/protocol';
import { RoomRegistry } from './rooms.js';
import { makeStaticHandler } from './static.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

// Port 3105 is claimed for scahn-relay in /home/user/Projects/PORTS.md.
// Bind 127.0.0.1 — public reach comes from the Cloudflare Tunnel, not from
// binding 0.0.0.0 (see scripts/tunnel.sh).
const PORT = Number(process.env.SCAHN_PORT || 3105);
const HOST = process.env.SCAHN_HOST || '127.0.0.1';

const ts = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(`[${ts()}]`, ...a);

const registry = new RoomRegistry({ log });

const staticHandler = makeStaticHandler({
  viewerDist: resolve(repoRoot, 'clients/viewer/dist'),
  phoneDist: resolve(repoRoot, 'clients/phone/dist'),
});

const server = createServer((req, res) => {
  staticHandler(req, res).catch((err) => {
    log('static error', err.message);
    if (!res.headersSent) res.writeHead(500);
    res.end('internal error');
  });
});

const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: LIMITS.MAX_FRAME_BYTES,
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sendJson(socket, obj) {
  if (socket.readyState !== socket.OPEN) return;
  try {
    socket.send(JSON.stringify(obj));
  } catch (err) {
    log('send failed', err.message);
  }
}

function sendError(socket, code) {
  sendJson(socket, { type: 'error', code });
}

/** Fan-out is restricted to room members (spec 7.5). */
function toDisplays(room, obj) {
  const payload = JSON.stringify(obj);
  for (const s of room.displaySockets) {
    if (s.readyState === s.OPEN) s.send(payload);
  }
}

function toSensors(room, obj) {
  const payload = JSON.stringify(obj);
  for (const entry of room.liveSensors()) {
    if (entry.socket.readyState === entry.socket.OPEN) entry.socket.send(payload);
  }
}

/**
 * Roster goes to displays *and* sensors. The spec frames it as relay->display,
 * but section 7.4 also requires each phone to show an unambiguous
 * "you are driving" / "viewing only" state, and control can change without that
 * phone having sent anything. Deriving it from the roster keeps one source of
 * truth instead of a second per-phone control message that could disagree.
 */
function broadcastRoster(room) {
  const frame = room.rosterFrame();
  toDisplays(room, frame);
  toSensors(room, frame);
}

function clientIp(req) {
  // Behind the Cloudflare Tunnel the socket address is the tunnel's, so prefer
  // the forwarded header for the per-IP room-creation cap.
  const fwd = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

// ---------------------------------------------------------------------------
// connection handling
// ---------------------------------------------------------------------------

wss.on('connection', (socket, req) => {
  const meta = {
    ip: clientIp(req),
    role: null,
    roomCode: null,
    sensorId: null,
    // sliding one-second window for the inbound rate cap
    windowStart: Date.now(),
    windowCount: 0,
    missedPongs: 0,
    lastPingAt: null,
  };
  socket.scahn = meta;

  socket.on('message', (raw) => {
    // 1. rate limit before any parsing work
    const t = Date.now();
    if (t - meta.windowStart >= 1000) {
      meta.windowStart = t;
      meta.windowCount = 0;
    }
    if (++meta.windowCount > LIMITS.MSG_PER_SEC) {
      sendError(socket, ERRORS.RATE_LIMITED);
      return;
    }

    // 2. size (ws maxPayload already enforces, this is belt-and-braces)
    if (raw.length > LIMITS.MAX_FRAME_BYTES) {
      sendError(socket, ERRORS.BAD_FRAME);
      return;
    }

    // 3. parse
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      sendError(socket, ERRORS.BAD_FRAME);
      return;
    }

    // 4. validate type against the allowlist before touching any other field
    const bad = validateClientFrame(msg);
    if (bad) {
      sendError(socket, bad);
      return;
    }

    handleFrame(socket, meta, msg);
  });

  socket.on('close', () => {
    const room = meta.roomCode ? registry.get(meta.roomCode) : null;
    if (!room) return;
    if (meta.role === 'display') {
      room.removeDisplay(socket);
    } else if (meta.role === 'sensor') {
      room.detachSensor(socket);
    }
    broadcastRoster(room);
  });

  socket.on('error', (err) => log('socket error', err.message));
});

function handleFrame(socket, meta, msg) {
  switch (msg.type) {
    case 'ping':
      sendJson(socket, { type: 'pong', t: msg.t });
      return;

    case 'pong': {
      if (typeof msg.t === 'number' && meta.lastPingAt) {
        const rtt = Date.now() - msg.t;
        meta.missedPongs = 0;
        const room = meta.roomCode ? registry.get(meta.roomCode) : null;
        if (room && meta.sensorId) {
          const entry = room.sensors.get(meta.sensorId);
          if (entry) entry.rtt = rtt;
        }
      }
      return;
    }

    case 'create': {
      const { room, error } = registry.createRoom(meta.ip);
      if (error) return sendError(socket, error);
      meta.role = 'display';
      meta.roomCode = room.code;
      room.addDisplay(socket);
      sendJson(socket, {
        type: 'created',
        room: room.code,
        ttl: Math.round(LIMITS.ROOM_EMPTY_TTL_MS / 1000),
      });
      broadcastRoster(room);
      return;
    }

    case 'join': {
      // A display may rejoin an existing room by code (lid reopened).
      if (msg.role === 'display') {
        const room = registry.get(msg.room);
        if (!room) return sendError(socket, ERRORS.NO_SUCH_ROOM);
        meta.role = 'display';
        meta.roomCode = room.code;
        room.addDisplay(socket);
        sendJson(socket, { type: 'joined', id: null, token: null, active: false, room: room.code });
        broadcastRoster(room);
        return;
      }

      const room = registry.get(msg.room);
      if (!room) return sendError(socket, ERRORS.NO_SUCH_ROOM);

      const { entry, error, resumed } = room.joinSensor({
        socket,
        name: typeof msg.name === 'string' ? msg.name.slice(0, 40) : null,
        token: msg.token,
      });
      if (error) return sendError(socket, error);

      meta.role = 'sensor';
      meta.roomCode = room.code;
      meta.sensorId = entry.id;

      sendJson(socket, {
        type: 'joined',
        id: entry.id,
        token: entry.token,
        active: room.activeSensorId === entry.id,
        room: room.code,
      });
      log(`room ${room.code}: sensor ${entry.id} ${resumed ? 'resumed' : 'joined'} (${entry.name})`);
      broadcastRoster(room);
      return;
    }

    case 'claim': {
      const room = meta.roomCode ? registry.get(meta.roomCode) : null;
      if (!room || meta.role !== 'sensor') return sendError(socket, ERRORS.NOT_IN_ROOM);
      // A phone may only claim control for itself.
      if (room.claim(meta.sensorId)) {
        log(`room ${room.code}: control -> ${meta.sensorId}`);
        broadcastRoster(room);
      }
      return;
    }

    case 'orient': {
      const room = meta.roomCode ? registry.get(meta.roomCode) : null;
      if (!room || meta.role !== 'sensor') return;
      // Silently drop frames from any sensor that is not driving. This is the
      // single line that prevents last-writer-wins chaos when two people move
      // at once (spec 7.4).
      if (room.activeSensorId !== meta.sensorId) return;
      room.touch();
      toDisplays(room, msg);
      return;
    }

    case 'mode': {
      const room = meta.roomCode ? registry.get(meta.roomCode) : null;
      if (!room || meta.role !== 'sensor') return;
      if (room.activeSensorId !== meta.sensorId) return;
      room.touch();
      toDisplays(room, { type: 'mode', mode: msg.mode });
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// heartbeat + sweeper
// ---------------------------------------------------------------------------

setInterval(() => {
  const t = Date.now();
  for (const socket of wss.clients) {
    const meta = socket.scahn;
    if (!meta) continue;
    if (meta.lastPingAt && meta.missedPongs >= LIMITS.MISSED_PONGS) {
      log('dropping unresponsive socket');
      socket.terminate();
      continue;
    }
    meta.missedPongs++;
    meta.lastPingAt = t;
    sendJson(socket, { type: 'ping', t });
  }
}, LIMITS.HEARTBEAT_MS);

setInterval(() => {
  for (const room of registry.rooms.values()) room.pruneSensors();
  registry.sweep();
}, 15_000);

server.listen(PORT, HOST, () => {
  log(`scahn relay on http://${HOST}:${PORT}  (ws://${HOST}:${PORT}/ws)`);
  log(`viewer: http://${HOST}:${PORT}/    phone: http://${HOST}:${PORT}/phone`);
});

process.on('SIGINT', () => {
  log('shutting down');
  wss.close();
  server.close(() => process.exit(0));
});
