/**
 * Integration tests against a running relay.
 *
 * Deliberately talks to the real service on the claimed port (3105) rather than
 * spinning up a server on an arbitrary one — ports on this host are centrally
 * governed and tests do not get to invent them.
 *
 *   npm start                       # in one shell
 *   npm test --workspace @scahn/relay
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { WebSocket } from 'ws';

const URL = process.env.SCAHN_TEST_URL || 'ws://127.0.0.1:3105/ws';

const sockets = [];

/**
 * Role and room ride in the query string: the Worker must resolve the room's
 * Durable Object before the upgrade completes. The Node relay ignores these and
 * reads the create/join frame instead, so this helper drives either backend.
 */
function open({ role = 'display', room = null } = {}) {
  const q = new URLSearchParams({ role });
  if (room) q.set('room', room);
  const ws = new WebSocket(`${URL}?${q}`);
  sockets.push(ws);
  ws.inbox = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    // Answer heartbeats so the relay does not terminate us mid-test.
    if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
    ws.inbox.push(msg);
  });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

const send = (ws, obj) => ws.send(JSON.stringify(obj));

/** Wait for the first inbound message matching `pred`. */
function until(ws, pred, timeout = 2000) {
  const found = ws.inbox.find(pred);
  if (found) return Promise.resolve(found);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`timeout waiting on ${URL}; inbox=${JSON.stringify(ws.inbox)}`));
    }, timeout);
    const onMsg = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (pred(msg)) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(msg);
      }
    };
    ws.on('message', onMsg);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ORIENT = { v: 1, type: 'orient', t: 0, seq: 0, q: [0, 0, 0, 1], probe: 'phased' };

after(() => {
  for (const ws of sockets) { try { ws.close(); } catch { /* ignore */ } }
});

describe('pairing', () => {
  it('the display creates the room and the relay assigns a 6-digit code', async () => {
    const display = await open({ role: 'display' });
    send(display, { type: 'create' });
    const created = await until(display, (m) => m.type === 'created');
    assert.match(created.room, /^[0-9]{6}$/);
    assert.ok(created.ttl > 0);
  });

  it('rejects a join to a room that does not exist', async () => {
    // The Worker refuses the upgrade outright (HTTP 404) because the room's
    // Durable Object has no `created` record; the Node relay accepts the socket
    // and replies with an error frame. Either is a correct refusal.
    let refused = false;
    try {
      const phone = await open({ role: 'sensor', room: '000000' });
      send(phone, { type: 'join', role: 'sensor', room: '000000', name: 'ghost' });
      const err = await until(phone, (m) => m.type === 'error');
      refused = err.code === 'no_such_room';
    } catch {
      refused = true; // connection rejected before upgrade
    }
    assert.ok(refused, 'joining a nonexistent room must be refused');
  });

  it('a sensor that joins appears on the roster and takes control uncontested', async () => {
    const display = await open({ role: 'display' });
    send(display, { type: 'create' });
    const { room } = await until(display, (m) => m.type === 'created');

    const phone = await open({ role: 'sensor', room });
    send(phone, { type: 'join', role: 'sensor', room, name: "Ken's iPhone" });
    const joined = await until(phone, (m) => m.type === 'joined');
    assert.equal(joined.active, true, 'first sensor into an empty room drives');
    assert.ok(joined.token, 'a session token is issued for reconnect');

    const roster = await until(display, (m) => m.type === 'roster' && m.sensors.length === 1);
    assert.equal(roster.sensors[0].name, "Ken's iPhone");
    assert.equal(roster.sensors[0].active, true);
  });
});

describe('single controller', () => {
  it('drops orientation frames from any sensor that is not driving', async () => {
    const display = await open({ role: 'display' });
    send(display, { type: 'create' });
    const { room } = await until(display, (m) => m.type === 'created');

    const first = await open({ role: 'sensor', room });
    send(first, { type: 'join', role: 'sensor', room, name: 'first' });
    await until(first, (m) => m.type === 'joined');

    const second = await open({ role: 'sensor', room });
    send(second, { type: 'join', role: 'sensor', room, name: 'second' });
    const secondJoined = await until(second, (m) => m.type === 'joined');
    assert.equal(secondJoined.active, false, 'a second phone must not seize control');

    // Only the driver's frames should reach the display.
    send(second, { ...ORIENT, seq: 1, q: [1, 0, 0, 0] });
    send(first, { ...ORIENT, seq: 2, q: [0, 1, 0, 0] });
    await sleep(150);

    const orients = display.inbox.filter((m) => m.type === 'orient');
    assert.equal(orients.length, 1, 'exactly one frame forwarded');
    assert.deepEqual(orients[0].q, [0, 1, 0, 0], 'the frame is the driver’s');

    // Explicit handoff.
    send(second, { type: 'claim' });
    await until(display, (m) => m.type === 'roster' && m.sensors.find((s) => s.name === 'second')?.active);

    send(first, { ...ORIENT, seq: 3, q: [0, 0, 1, 0] });
    send(second, { ...ORIENT, seq: 4, q: [0, 0, 0, 1] });
    await sleep(150);

    const after2 = display.inbox.filter((m) => m.type === 'orient');
    assert.equal(after2.length, 2, 'still exactly one driver after handoff');
    assert.deepEqual(after2[1].q, [0, 0, 0, 1], 'control moved to the claimer');
  });
});

describe('room isolation', () => {
  it('two simultaneous rooms do not leak frames to each other', async () => {
    const dA = await open({ role: 'display' });
    send(dA, { type: 'create' });
    const roomA = (await until(dA, (m) => m.type === 'created')).room;

    const dB = await open({ role: 'display' });
    send(dB, { type: 'create' });
    const roomB = (await until(dB, (m) => m.type === 'created')).room;
    assert.notEqual(roomA, roomB);

    const pA = await open({ role: 'sensor', room: roomA });
    send(pA, { type: 'join', role: 'sensor', room: roomA, name: 'A' });
    await until(pA, (m) => m.type === 'joined');

    const pB = await open({ role: 'sensor', room: roomB });
    send(pB, { type: 'join', role: 'sensor', room: roomB, name: 'B' });
    await until(pB, (m) => m.type === 'joined');

    send(pA, { ...ORIENT, seq: 10, q: [1, 0, 0, 0] });
    await sleep(200);

    assert.equal(dA.inbox.filter((m) => m.type === 'orient').length, 1);
    assert.equal(dB.inbox.filter((m) => m.type === 'orient').length, 0, 'no cross-room leak');
    for (const r of dB.inbox.filter((m) => m.type === 'roster')) {
      assert.equal(r.room, roomB);
    }
  });
});

describe('reconnect', () => {
  it('replaying the token restores the same sensor id and control', async () => {
    const display = await open({ role: 'display' });
    send(display, { type: 'create' });
    const { room } = await until(display, (m) => m.type === 'created');

    const phone = await open({ role: 'sensor', room });
    send(phone, { type: 'join', role: 'sensor', room, name: 'flaky' });
    const first = await until(phone, (m) => m.type === 'joined');

    phone.close();
    await sleep(120);

    const again = await open({ role: 'sensor', room });
    send(again, { type: 'join', role: 'sensor', room, name: 'flaky', token: first.token });
    const second = await until(again, (m) => m.type === 'joined');

    assert.equal(second.id, first.id, 'same identity across a background/resume');
    assert.equal(second.active, true, 'still driving');

    send(again, { ...ORIENT, seq: 99 });
    const fwd = await until(display, (m) => m.type === 'orient' && m.seq === 99);
    assert.ok(fwd);
  });
});

describe('hardening', () => {
  it('rejects frames whose type is not on the allowlist', async () => {
    const ws = await open({ role: 'display' });
    send(ws, { type: 'eval', payload: 'whatever' });
    const err = await until(ws, (m) => m.type === 'error');
    assert.equal(err.code, 'bad_frame');
  });

  it('rejects a malformed orientation quaternion', async () => {
    const display = await open({ role: 'display' });
    send(display, { type: 'create' });
    const { room } = await until(display, (m) => m.type === 'created');

    const phone = await open({ role: 'sensor', room });
    send(phone, { type: 'join', role: 'sensor', room, name: 'bad' });
    await until(phone, (m) => m.type === 'joined');

    send(phone, { v: 1, type: 'orient', t: 0, seq: 1, q: [0, 0, 0] });
    const err = await until(phone, (m) => m.type === 'error');
    assert.equal(err.code, 'bad_frame');
  });

  it('rate-limits a flooding socket', async () => {
    const ws = await open({ role: 'display' });
    for (let i = 0; i < 120; i++) send(ws, { type: 'ping', t: i });
    const err = await until(ws, (m) => m.type === 'error' && m.code === 'rate_limited');
    assert.ok(err);
  });
});
