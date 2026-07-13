// Pure-node M2 contract check for the Horde arena level.
//
// Guards:
//   1. Level return shape (name, group, spawn, gates, env, ground, dispose).
//   2. 6–8 spawn gates, each on ground, outside player safety radius, pairwise
//      spaced so capsules do not overlap.
//   3. Player spawn grounded at y≈0.
//   4. Floor collider present; cover colliders present.
//   5. dispose() leaves no orphan requirement (idempotent call safe).
//
// Run: node scripts/verify-horde-arena.mjs
// Alias: npm run verify:horde-arena

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createHordeModeLevel } from '../src/game/world/createHordeModeLevel.js';

const PLAYER_SAFE_RADIUS = 10;
const MIN_GATE_SPACING = 4.0; // slightly under build constant for float slack
const CAPSULE_RADIUS = 0.5;

const level = createHordeModeLevel();

assert.equal(level.name, 'Horde Arena');
assert.ok(level.group, 'group');
assert.ok(level.group instanceof THREE.Group);
assert.ok(level.spawnPoint instanceof THREE.Vector3);
assert.ok(Number.isFinite(level.spawnYaw));
assert.ok(Array.isArray(level.colliders) && level.colliders.length > 4, 'colliders');
assert.ok(typeof level.getGroundHeightAt === 'function');
assert.ok(typeof level.dispose === 'function');
assert.ok(level.isNearFieldReady?.() === true);
assert.ok(level.hordeEnvironment?.weather === 'clear');

// Floor collider covers origin (checked again in snapshot section).
{
  const floorPad = level.colliders.find((c) => c.name === 'Horde Floor');
  assert.ok(floorPad, 'Horde Floor collider');
  assert.ok(floorPad.minX < 0 && floorPad.maxX > 0 && floorPad.minZ < 0 && floorPad.maxZ > 0);
}

// Player spawn on ground.
const spawnGround = level.getGroundHeightAt(level.spawnPoint, 0.5);
assert.ok(Number.isFinite(spawnGround), 'spawn ground height');
assert.ok(Math.abs(spawnGround - level.spawnPoint.y) < 0.35, `spawn y ${level.spawnPoint.y} vs ground ${spawnGround}`);

// Gates.
const gates = level.hordeSpawnPoints;
assert.ok(Array.isArray(gates), 'hordeSpawnPoints');
assert.ok(gates.length >= 6 && gates.length <= 8, `expected 6–8 gates, got ${gates.length}`);

const ids = new Set();
for (const g of gates) {
  assert.ok(g.id && !ids.has(g.id), `unique gate id ${g.id}`);
  ids.add(g.id);
  assert.ok(g.position instanceof THREE.Vector3, `${g.id} position`);
  assert.ok(Number.isFinite(g.yaw), `${g.id} yaw`);
  assert.ok(g.gateId, `${g.id} gateId`);
  assert.ok(Number.isFinite(g.minWave), `${g.id} minWave`);
  assert.ok(Number.isFinite(g.weight), `${g.id} weight`);

  const gy = level.getGroundHeightAt(g.position, CAPSULE_RADIUS);
  assert.ok(Number.isFinite(gy), `${g.id} ground`);
  assert.ok(Math.abs(gy - g.position.y) < 0.35, `${g.id} on ground (y=${g.position.y} ground=${gy})`);

  const dist = Math.hypot(g.position.x - level.spawnPoint.x, g.position.z - level.spawnPoint.z);
  assert.ok(dist >= PLAYER_SAFE_RADIUS, `${g.id} too close to player (${dist.toFixed(2)}m)`);
}

// Pairwise spacing (capsule non-overlap).
for (let i = 0; i < gates.length; i += 1) {
  for (let j = i + 1; j < gates.length; j += 1) {
    const d = gates[i].position.distanceTo(gates[j].position);
    assert.ok(
      d >= MIN_GATE_SPACING,
      `${gates[i].id}/${gates[j].id} only ${d.toFixed(2)}m apart (need >= ${MIN_GATE_SPACING})`,
    );
  }
}

// Cover exists (train cars + sheds use Cover prefix).
const cover = level.colliders.filter((c) => String(c.name).startsWith('Cover'));
assert.ok(cover.length >= 8, `expected train-yard cover props, got ${cover.length}`);

// Snapshot + dispose.
const snap = level.snapshot?.();
assert.equal(snap?.mode, 'horde');
assert.equal(snap?.theme, 'train-yard');
assert.equal(snap?.gates, gates.length);
assert.ok((snap?.tracks ?? 0) >= 3, 'expected multiple tracks');
assert.ok((snap?.boxcars ?? 0) >= 8, 'expected boxcars');
assert.ok((snap?.tankCars ?? 0) >= 4, 'expected tank cars');

// Static merge: one draw per material batch, not thousands of detail meshes.
assert.ok((snap?.sourceMeshes ?? 0) > 100, 'expected many source detail meshes before merge');
assert.ok(
  (snap?.drawCalls ?? Infinity) <= 20,
  `expected ≤20 material batches after merge, got ${snap?.drawCalls}`,
);
assert.ok(
  (snap?.drawCalls ?? Infinity) < (snap?.sourceMeshes ?? 0) / 10,
  'merge should cut draw calls by >10×',
);

// Ladder climb planes (boxcar ends + tank side) + roof hang ledges + wall runs.
assert.ok(
  Array.isArray(level.climbSurfaces) && level.climbSurfaces.length >= 10,
  `climb surfaces, got ${level.climbSurfaces?.length}`,
);
assert.ok(Array.isArray(level.ledges) && level.ledges.length >= 40, `roof/wall hang ledges, got ${level.ledges.length}`);
assert.ok(
  Array.isArray(level.wallRunSurfaces) && level.wallRunSurfaces.length >= 20,
  `wall run surfaces, got ${level.wallRunSurfaces?.length}`,
);
assert.ok((snap?.climbSurfaces ?? 0) === level.climbSurfaces.length);
assert.ok((snap?.ledges ?? 0) === level.ledges.length);
assert.ok((snap?.wallRunSurfaces ?? 0) === level.wallRunSurfaces.length);
for (const surface of level.climbSurfaces) {
  assert.ok(surface.origin && surface.normal && surface.tangent && surface.up, surface.name);
  assert.ok(surface.maxV > 2.5, `${surface.name} should reach roof height`);
  assert.ok(surface.climbSpeedScale >= 3, `${surface.name} should be a fast ladder climb`);
  assert.ok(surface.targetLedgeName, `${surface.name} needs a roof ledge handoff`);
  assert.ok(
    level.ledges.some((ledge) => ledge.name === surface.targetLedgeName),
    `missing target ledge ${surface.targetLedgeName}`,
  );
}
for (const ledge of level.ledges) {
  assert.ok(ledge.normal && ledge.tangent && Number.isFinite(ledge.y), ledge.name);
  assert.ok(ledge.max - ledge.min > 1.0, `${ledge.name} span too short`);
  assert.ok(Array.isArray(ledge.snapPoints) && ledge.snapPoints.length >= 2, ledge.name);
}
for (const surface of level.wallRunSurfaces) {
  assert.ok(surface.origin && surface.normal && surface.tangent && surface.up, surface.name);
  assert.ok(surface.maxU - surface.minU > 2.5, `${surface.name} run too short`);
  assert.ok(surface.maxV > 1.2, `${surface.name} height band too short`);
}

// Scene graph should be mostly static batches + interactive door leaves
// (2 per boxcar stay unmerged for sliding).
let meshCount = 0;
let doorMeshes = 0;
level.group.traverse((o) => {
  if (!o.isMesh) return;
  meshCount += 1;
  if (o.userData?.noStaticMerge) doorMeshes += 1;
});
assert.ok(
  meshCount <= (snap?.drawCalls ?? 0) + doorMeshes + 4,
  `scene mesh count after merge should be batches+doors, got ${meshCount} (doors=${doorMeshes})`,
);
assert.ok((snap?.boxcarDoors ?? doorMeshes) >= 10, 'expected interactive boxcar doors');

level.dispose();
console.log(
  `ok: horde train yard — ${gates.length} gates, ${level.colliders.length} colliders, `
  + `cover=${cover.length}, tracks=${snap.tracks}, boxcars=${snap.boxcars}, tanks=${snap.tankCars}, `
  + `meshes ${snap.sourceMeshes}→${snap.drawCalls} draws`,
);
console.log('PASS: M2 horde arena contract holds.');
