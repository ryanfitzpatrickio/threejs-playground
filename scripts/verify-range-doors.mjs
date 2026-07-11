// Regression for the Shooting Range CQB shoot-house: coherent room layout,
// decision-making target placements, and knockable breach doors.
//
// The range was rebuilt from a loose gallery into a room-by-room breach course
// (reception -> corridor + flanking rooms -> warehouse -> hostage room ->
// office). Each solid divider is punched with one doorway whose gap must match a
// RANGE_DOOR_SPECS entry, and ShootingRangeSystem drops a knockable leaf into
// each. This guards:
//
//   1. Every doorway gap is actually clear (no wall collider crosses a door
//      centre) so a breached room is reachable.
//   2. No target silhouette is buried inside a ground-level cover collider.
//   3. A closed door blocks its doorway; pressing interact (E) tips it flat,
//      settles it, and disables the gating collider so the player can pass.
//   4. Doors always fall AWAY from the player (both X-axis cross walls and
//      Z-axis corridor side walls).
//   5. resetRound restores every door to closed + blocking.
//
// Run: node scripts/verify-range-doors.mjs

import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  createShootingRangeLevel,
  RANGE_TARGET_SPAWNS,
  RANGE_DOOR_SPECS,
} from '../src/game/world/createShootingRangeLevel.js';
import { ShootingRangeSystem } from '../src/game/systems/ShootingRangeSystem.js';
import { getBlockingColliderAt } from '../src/game/world/createBaseLevel.js';

// ── 1. Layout: doorway gaps are clear ──────────────────────────────────────
const level = createShootingRangeLevel();
assert.equal(level.rangeDoors.length, RANGE_DOOR_SPECS.length, 'level exposes door specs');
assert.ok(level.rangeDoors.length >= 5, 'shoot-house has multiple breach doors');

const MID_Y = 1.2;
for (const door of RANGE_DOOR_SPECS) {
  const crossing = level.colliders.filter((c) => (
    c.name !== 'Range Floor Slab'
    && c.bottomY < MID_Y && c.topY > MID_Y
    && c.minX <= door.x && c.maxX >= door.x
    && c.minZ <= door.z && c.maxZ >= door.z
  ));
  assert.equal(
    crossing.length, 0,
    `doorway ${door.id} is blocked by [${crossing.map((c) => c.name).join(', ')}]`,
  );
}

// ── 2. Targets are not buried in ground-level cover ────────────────────────
const hostiles = RANGE_TARGET_SPAWNS.filter((t) => !t.friendly).length;
const friendlies = RANGE_TARGET_SPAWNS.filter((t) => t.friendly).length;
assert.ok(hostiles >= 10, 'enough hostiles to make a course');
assert.ok(friendlies >= 4, 'enough friendlies to force discrimination');

for (const t of RANGE_TARGET_SPAWNS) {
  const buried = level.colliders.find((c) => (
    c.name !== 'Range Floor Slab' && c.bottomY < 1.0 && c.topY > 0.5
    && t.x > c.minX && t.x < c.maxX && t.z > c.minZ && t.z < c.maxZ
  ));
  assert.ok(!buried, `target ${t.id} buried inside ${buried?.name}`);
}

// A hostage-style pairing exists: a friendly with a hostile within ~2.5 m.
const hasTightPair = RANGE_TARGET_SPAWNS.some((f) => f.friendly
  && RANGE_TARGET_SPAWNS.some((h) => !h.friendly
    && Math.hypot(h.x - f.x, h.z - f.z) < 2.5));
assert.ok(hasTightPair, 'a friendly sits at a tight angle to a hostile (decision test)');

// ── 3–5. Door system: block -> breach -> settle -> reset ───────────────────
const scene = new THREE.Scene();
const colliders = [];
const runtimeLevel = { colliders, spawnPoint: new THREE.Vector3(0, 0, -2), spawnYaw: 0 };
const sys = new ShootingRangeSystem();
sys.start(scene, { spawns: [], doors: RANGE_DOOR_SPECS, level: runtimeLevel });
assert.equal(sys.doors.length, RANGE_DOOR_SPECS.length, 'a leaf per spec');
assert.equal(colliders.length, RANGE_DOOR_SPECS.length, 'gating colliders pushed to level');
sys.phase = 'running';

const HALF_PI = Math.PI / 2;
const blockedAt = (x, z) => Boolean(getBlockingColliderAt({
  position: { x, z }, radius: 0.3, feetY: 0, height: 1.7, stepHeight: 0.4, colliders,
}));

function drivePhysics(door, character) {
  for (let i = 0; i < 360 && door.state !== 'down'; i += 1) {
    sys.update({ delta: 1 / 60, input: { mountPressed: false }, gunId: 't', character, level: runtimeLevel });
  }
}

// X-axis cross door (reception, z=12) — player approaches from the south.
const reception = sys.doors.find((d) => d.id === 'd-reception');
assert.ok(blockedAt(reception.x, reception.z), 'reception doorway blocks before breach');
const chSouth = { group: { position: new THREE.Vector3(0, 0, 10.6), rotation: { y: 0 } } };
sys.update({ delta: 1 / 60, input: { mountPressed: false }, gunId: 't', character: chSouth, level: runtimeLevel });
assert.equal(sys._nearDoorId, 'd-reception', 'breach prompt raised at the doorway');
sys.update({ delta: 1 / 60, input: { mountPressed: true }, gunId: 't', character: chSouth, level: runtimeLevel });
assert.equal(reception.state, 'falling', 'E tips the door');
assert.equal(reception.collider.disabled, true, 'doorway opens the instant it is knocked');
drivePhysics(reception, chSouth);
assert.equal(reception.state, 'down', 'door settles flat');
assert.ok(Math.abs(Math.abs(reception.angle) - HALF_PI) < 1e-3, 'door lies flat (±90°)');
assert.ok(reception.angle > 0, 'reception door falls +z, away from a south player');
assert.ok(!blockedAt(reception.x, reception.z), 'doorway is passable after breach');

// Z-axis corridor doors fall away on both sides.
const west = sys.doors.find((d) => d.id === 'd-breakroom'); // wall x=-2.8
const chWest = { group: { position: new THREE.Vector3(-1, 0, 44), rotation: { y: 0 } } };
sys.update({ delta: 1 / 60, input: { mountPressed: true }, gunId: 't', character: chWest, level: runtimeLevel });
drivePhysics(west, chWest);
assert.ok(west.pivot.rotation.z > 0, 'west corridor door falls -x, away from the corridor');

const east = sys.doors.find((d) => d.id === 'd-records'); // wall x=+2.8
const chEast = { group: { position: new THREE.Vector3(1, 0, 44), rotation: { y: 0 } } };
sys.update({ delta: 1 / 60, input: { mountPressed: true }, gunId: 't', character: chEast, level: runtimeLevel });
drivePhysics(east, chEast);
assert.ok(east.pivot.rotation.z < 0, 'east corridor door falls +x, away from the corridor');

// Reset restores every door.
sys.resetRound({ countdown: true });
for (const door of sys.doors) {
  assert.equal(door.state, 'closed', `${door.id} reset to closed`);
  assert.equal(door.angle, 0, `${door.id} reset upright`);
  assert.equal(door.collider.disabled, false, `${door.id} blocks again after reset`);
}
assert.ok(blockedAt(reception.x, reception.z), 'reception doorway blocks again after reset');

console.log('verify-range-doors: OK');
console.log(`  rooms wired with ${RANGE_DOOR_SPECS.length} knockable doors`);
console.log(`  ${hostiles} hostiles / ${friendlies} friendlies, tight hostage pairing present`);
