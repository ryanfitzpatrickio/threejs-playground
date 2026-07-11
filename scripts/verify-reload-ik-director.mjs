// AR3 regression for the reload left-hand IK director
// (docs/advanced-reload-system-plan.md). The dual-IK solver already moves the
// arm; this only steers the left-hand target through the magazine-change path.
// Asserts the world-space waypoint sampler:
//   - starts and ends at the foregrip rest,
//   - reaches mag_socket at mag_release (grab) and again at mag_seat,
//   - visits the belt source around mag_drop,
//   - moves continuously (no teleport between adjacent frames).
//
// The in-game arm solve (right hand stays on grip, left bone tracks target) is a
// browser-only concern (probe-reload-ik, snapshot-based — Playwright can't
// screenshot runtime WebGPU); this covers the path math in pure node.
//
// Run: node scripts/verify-reload-ik-director.mjs

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { sampleReloadLeftHand } from '../src/game/weapons/reloadIkDirector.js';
import { normalizeReloadPhaseTiming } from '../src/game/weapons/BaseGun.js';

// Distinct, well-separated waypoints so proximity assertions are unambiguous.
const rest = new THREE.Vector3(0.12, 1.30, -0.35); // support hand on the foregrip
const magSocket = new THREE.Vector3(0.00, 1.15, -0.10); // magazine well
const belt = new THREE.Vector3(0.00, 0.77, -0.10); // pouch below the well
const waypoints = { rest, magSocket, belt };

const timing = normalizeReloadPhaseTiming(null, 'rifle'); // rifle defaults
const out = new THREE.Vector3();
const at = (t) => sampleReloadLeftHand(t, timing, waypoints, out).clone();

const TOL = 0.02; // 2 cm, per the plan's tolerance

// --- Endpoints rest at the foregrip -----------------------------------------
assert.ok(at(0).distanceTo(rest) < 1e-6, 't=0 starts at the foregrip rest');
assert.ok(at(1).distanceTo(rest) < 1e-6, 't=1 returns to the foregrip rest');
assert.ok(at(-0.5).distanceTo(rest) < 1e-6, 't<0 clamps to rest');
assert.ok(at(1.5).distanceTo(rest) < 1e-6, 't>1 clamps to rest');

// --- Grab + seat land on the magazine well ----------------------------------
assert.ok(at(timing.mag_release).distanceTo(magSocket) < TOL,
  'reaches mag_socket at mag_release (grab)');
assert.ok(at(timing.mag_seat).distanceTo(magSocket) < TOL,
  'arrives at mag_socket at mag_seat (within ~2 cm)');

// --- The path visits the belt source around mag_drop ------------------------
assert.ok(at(timing.mag_drop).distanceTo(belt) < TOL,
  'at the belt source when the old mag drops / new spawns');

// Sample the whole timeline: the closest approach to the belt is near mag_drop,
// and the hand does dip to (near) belt height.
let minBeltDist = Infinity;
let minBeltT = 0;
let lowestY = Infinity;
for (let i = 0; i <= 200; i += 1) {
  const t = i / 200;
  const p = at(t);
  const d = p.distanceTo(belt);
  if (d < minBeltDist) { minBeltDist = d; minBeltT = t; }
  lowestY = Math.min(lowestY, p.y);
}
assert.ok(minBeltDist < TOL, 'path passes through the belt source');
assert.ok(Math.abs(minBeltT - timing.mag_drop) < 0.05, 'belt approach is at the drop phase');
assert.ok(lowestY <= belt.y + 1e-3, 'hand dips to belt height mid-reload');

// --- Motion is continuous (no teleport between adjacent frames) --------------
let maxStep = 0;
let prev = at(0);
for (let i = 1; i <= 240; i += 1) {
  const p = at(i / 240);
  maxStep = Math.max(maxStep, p.distanceTo(prev));
  prev = p;
}
// Total path length is well under 3 m; a 1/240 step should never jump far.
assert.ok(maxStep < 0.06, `no teleport between frames (max step ${(maxStep * 100).toFixed(1)} cm)`);

// --- Pistol timing seats earlier, still ends at rest ------------------------
{
  const pistol = normalizeReloadPhaseTiming(null, 'pistol');
  assert.ok(at(1).distanceTo(rest) < 1e-6);
  const p = sampleReloadLeftHand(pistol.mag_seat, pistol, waypoints, new THREE.Vector3());
  assert.ok(p.distanceTo(magSocket) < TOL, 'pistol seats at mag_socket on its own timing');
}

// --- Degenerate waypoints don't throw ---------------------------------------
{
  const o = sampleReloadLeftHand(0.5, timing, { rest: null, magSocket, belt }, new THREE.Vector3());
  assert.ok(o.x === 0 && o.y === 0 && o.z === 0, 'missing waypoint returns the untouched out vector');
}

// --- Debug offsets shift the path without breaking continuity ---------------
{
  const opts = {
    handPosition: [0.1, 0, 0],
    beltOffset: [0, -0.05, 0],
    extractDrop: 0.08,
  };
  const base = sampleReloadLeftHand(timing.mag_drop, timing, waypoints, new THREE.Vector3());
  const shifted = sampleReloadLeftHand(timing.mag_drop, timing, waypoints, new THREE.Vector3(), opts);
  assert.ok(Math.abs(shifted.x - base.x - 0.1) < 1e-6, 'global hand offset applies on X');
  assert.ok(Math.abs(shifted.y - (belt.y - 0.05)) < TOL, 'belt waypoint offset + extractDrop still near belt');
  // Continuity with offsets still holds.
  let maxStep = 0;
  let prev = sampleReloadLeftHand(0, timing, waypoints, new THREE.Vector3(), opts);
  for (let i = 1; i <= 120; i += 1) {
    const p = sampleReloadLeftHand(i / 120, timing, waypoints, new THREE.Vector3(), opts);
    maxStep = Math.max(maxStep, p.distanceTo(prev));
    prev = p;
  }
  assert.ok(maxStep < 0.08, 'offset path stays continuous');
}

console.log('verify-reload-ik-director: all checks passed');
