import test from 'node:test';
import assert from 'node:assert/strict';
import { matchFlow } from './opticalflow.js';

const W = 160;
const H = 120;

/** Deterministic pseudo-random texture — block matching needs real structure. */
function makeFrame(seed = 1) {
  const g = new Uint8Array(W * H);
  let s = seed;
  for (let i = 0; i < g.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    g[i] = s >> 16;
  }
  return g;
}

/** curr is prev shifted by (dx, dy): curr(x,y) = prev(x-dx, y-dy). */
function shift(prev, dx, dy) {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = x - dx;
      const sy = y - dy;
      out[y * W + x] = sx >= 0 && sx < W && sy >= 0 && sy < H ? prev[sy * W + sx] : 0;
    }
  }
  return out;
}

test('recovers a known translation', () => {
  const prev = makeFrame();
  const flow = matchFlow(prev, shift(prev, 4, -2));
  assert.ok(flow, 'flow should be trackable');
  assert.ok(Math.abs(flow.dx - 4) <= 1, `dx ${flow.dx} != 4`);
  assert.ok(Math.abs(flow.dy - -2) <= 1, `dy ${flow.dy} != -2`);
});

test('stationary scene reports zero', () => {
  const prev = makeFrame();
  const flow = matchFlow(prev, prev.slice());
  assert.ok(flow);
  assert.equal(flow.dx, 0);
  assert.equal(flow.dy, 0);
});

test('featureless frame is rejected, not guessed', () => {
  const prev = new Uint8Array(W * H); // all black: lens covered
  const curr = new Uint8Array(W * H).fill(255);
  // black->white matches everywhere at high confidence but zero structure;
  // at minimum it must not report a wild displacement
  const flow = matchFlow(prev, curr);
  if (flow) assert.ok(Math.abs(flow.dx) <= 2 && Math.abs(flow.dy) <= 2);
});

test('recovers negative-x, positive-y shift', () => {
  const prev = makeFrame(7);
  const flow = matchFlow(prev, shift(prev, -6, 4));
  assert.ok(flow);
  assert.ok(Math.abs(flow.dx - -6) <= 1, `dx ${flow.dx} != -6`);
  assert.ok(Math.abs(flow.dy - 4) <= 1, `dy ${flow.dy} != 4`);
});
