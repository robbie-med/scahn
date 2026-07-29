/**
 * Scahn Worker.
 *
 * Routes /ws to the room's Durable Object and serves the built clients from the
 * same origin. Room code -> DO is `idFromName(code)`, so Cloudflare's routing is
 * the room map and cross-room isolation is structural.
 */

import { Room } from './room.js';

export { Room };

/** Six digits, numeric: triggers the phone's numeric keypad on typed fallback
 *  and reads aloud cleanly across a room. */
function candidateCode() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return String(n).padStart(6, '0');
}

const ROOM_CODE_RE = /^[0-9]{6}$/;

/**
 * Allocate an unused code.
 *
 * The DO itself is the authority on whether its code is taken, so uniqueness is
 * guaranteed rather than probabilistic — a colliding candidate is rejected by
 * the DO and we try again.
 */
async function allocateRoom(env) {
  for (let i = 0; i < 8; i++) {
    const code = candidateCode();
    const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
    const res = await stub.fetch(`https://scahn.internal/__claim?room=${code}`);
    if (res.ok) return code;
  }
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/healthz') {
      return new Response('ok', { headers: { 'content-type': 'text/plain' } });
    }

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected websocket', { status: 426 });
      }

      const role = url.searchParams.get('role');
      if (role !== 'display' && role !== 'sensor') {
        return new Response('bad role', { status: 400 });
      }

      let code = url.searchParams.get('room');

      if (role === 'display' && !code) {
        // A fresh display asks for a room; the relay assigns the code.
        code = await allocateRoom(env);
        if (!code) return new Response('server full', { status: 503 });
      }

      if (!code || !ROOM_CODE_RE.test(code)) {
        return new Response('no such room', { status: 404 });
      }

      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      const forward = new URL(request.url);
      forward.searchParams.set('room', code);
      return stub.fetch(new Request(forward, request));
    }

    // Everything else is the static bundle (viewer at /, phone at /phone/).
    return env.ASSETS.fetch(request);
  },
};
