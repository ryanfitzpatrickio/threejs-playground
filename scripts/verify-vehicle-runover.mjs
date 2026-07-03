// Verifies the vehicle run-over detection + launch math against a REAL spawned
// BaseVehicle (real getRunOverFrame) and the pure runOver helpers. The full-body
// ragdoll spawn itself needs a skinned soldier asset (browser-only), so here we
// assert the targeting/launch/cap/iteration-safety that drives it.
//
// Run: node scripts/verify-vehicle-runover.mjs

const ctx2d = new Proxy(function () {}, {
  get: (_t, p) => (p === 'data' ? new Uint8ClampedArray(4) : ctx2d),
  apply: () => ctx2d,
});
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }),
  createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, setAttribute() {}, style: {} }),
};

import assert from 'node:assert/strict';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { BaseVehicle, makeNeutralControls } from '../src/game/vehicles/BaseVehicle.js';
import { DEFAULT_VEHICLE_CONFIG } from '../src/game/config/vehicleConfig.js';
import { computeRunOverHits, computeRunOverLaunch } from '../src/game/vehicles/runOver.js';

const GRAVITY = { x: 0, y: -9.81, z: 0 };
const cfg = DEFAULT_VEHICLE_CONFIG.runOver;
await RAPIER.init();

// --- Spawn a real car on flat ground and drive it forward (toward -Z) to ~10 m/s.
const world = new RAPIER.World(GRAVITY);
const gb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -2, 0));
world.createCollider(RAPIER.ColliderDesc.cuboid(400, 2, 400).setFriction(0.7).setRestitution(0), gb);
const physics = { RAPIER, world, getFreshBody: (h) => world.bodies.get(h) };
const scene = new THREE.Scene();
const car = new BaseVehicle({ position: new THREE.Vector3(0, 0, 0) });
car.spawnPosition.y = car.getGroundSpawnClearance();
await car.spawn({ scene, physics });
car.status = 'ready';
const controls = makeNeutralControls();
controls.throttle = 1;
for (let i = 0; i < 180; i += 1) {
  car.update({ dt: 1 / 60, controls, physics });
  world.step();
}

const frame = car.getRunOverFrame();
assert.ok(frame, 'getRunOverFrame returned null for a ground vehicle');
console.log(`car speed=${frame.horizSpeed.toFixed(1)} m/s travelDirZ=${(frame.velocity.z / frame.horizSpeed).toFixed(2)} (should be ~ -1, driving -Z)`);
assert.ok(frame.horizSpeed > cfg.minSpeed + 2, `car should be moving fast: ${frame.horizSpeed.toFixed(1)}`);
assert.ok(frame.velocity.z < -1, 'car should travel toward -Z');

const cz = frame.position.z;
const cx = frame.position.x;
const cy = frame.position.y;
const fakeEnemy = (id, x, z, extra = {}) => ({
  id,
  model: { position: new THREE.Vector3(x, cy - frame.halfHeight, z) },
  collisionRadius: 0.5,
  collisionHeight: 1.8,
  ...extra,
});

// In front (a couple metres ahead in -Z), one to the far side, one behind, one corpse.
const ahead = fakeEnemy('ahead', cx, cz - 3);
const aheadLeft = fakeEnemy('aheadLeft', cx - 0.6, cz - 2.5);
const farSide = fakeEnemy('farSide', cx + 6, cz - 3);
const behind = fakeEnemy('behind', cx, cz + 6);
const corpse = fakeEnemy('corpse', cx, cz - 2, { pendingCorpse: true });
const enemies = [ahead, aheadLeft, farSide, behind, corpse];

// --- (1) Targeting: only the in-front, in-footprint, live enemies are hit.
const hits = computeRunOverHits({ frame, enemies, cfg });
const hitIds = hits.map((h) => h.enemy.id).sort();
console.log('hits:', hitIds.join(', '), `(cap ${cfg.maxPerFrame})`);
assert.ok(hits.length <= cfg.maxPerFrame, `cap exceeded: ${hits.length}`);
assert.ok(hitIds.includes('ahead') || hitIds.includes('aheadLeft'), 'an in-front enemy should be hit');
assert.ok(!hitIds.includes('farSide'), 'a far-to-the-side enemy must NOT be hit');
assert.ok(!hitIds.includes('behind'), 'an enemy behind the car must NOT be hit');
assert.ok(!hitIds.includes('corpse'), 'a pending-corpse must NOT be hit');

// --- (2) Cap: many enemies in front -> at most maxPerFrame hits.
const crowd = [];
for (let i = 0; i < 8; i += 1) crowd.push(fakeEnemy(`c${i}`, cx - 0.6 + i * 0.15, cz - 2 - i * 0.1));
assert.equal(computeRunOverHits({ frame, enemies: crowd, cfg }).length, cfg.maxPerFrame, 'crowd not capped to maxPerFrame');

// --- (3) Speed gate: a crawling car hits nothing.
const slow = { ...frame, horizSpeed: cfg.minSpeed - 0.5 };
assert.equal(computeRunOverHits({ frame: slow, enemies, cfg }).length, 0, 'slow car should hit nothing');

// --- (4) Launch direction: up dominant + carried along travel (-Z), sidekick sign.
const launch = computeRunOverLaunch({ frame, sideSign: -1, cfg });
console.log(`launch=(${launch.x.toFixed(1)}, ${launch.y.toFixed(1)}, ${launch.z.toFixed(1)})`);
assert.ok(launch.y > cfg.upBase, `up launch too weak: ${launch.y.toFixed(1)}`);
assert.ok(launch.z < -cfg.forwardBase, `forward launch should follow travel (-Z): ${launch.z.toFixed(1)}`);
assert.ok(launch.x < 0, 'sideSign -1 should kick toward -X (car right is +X)');
// Faster impact -> bigger launch.
const fast = { ...frame, horizSpeed: frame.horizSpeed + 10 };
assert.ok(computeRunOverLaunch({ fast, frame: fast, sideSign: 1, cfg }).y > launch.y, 'faster impact should launch higher');

// --- (5) Iteration safety: removing hit enemies mid-loop (as the real flow does)
//     must not skip the other in-range enemy.
const a = fakeEnemy('A', cx - 0.4, cz - 2);
const b = fakeEnemy('B', cx + 0.4, cz - 2.4);
const list = [a, b];
const cfg1 = { ...cfg, maxPerFrame: 1 };
const round1 = computeRunOverHits({ frame, enemies: list, cfg: cfg1 });
assert.equal(round1.length, 1, 'first pass should hit exactly one (cap 1)');
list.splice(list.indexOf(round1[0].enemy), 1); // simulate removeEnemy
const round2 = computeRunOverHits({ frame, enemies: list, cfg: cfg1 });
assert.equal(round2.length, 1, 'second pass should still find the remaining enemy');
assert.notEqual(round2[0].enemy.id, round1[0].enemy.id, 'should not re-hit the removed enemy');

console.log('\nvehicle run-over targeting/launch regression passed');
