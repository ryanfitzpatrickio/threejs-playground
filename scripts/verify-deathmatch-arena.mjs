/**
 * Rail Crucible arena contract checks (pure node, M1).
 *
 * Guards the offline arena and its shared descriptor:
 *   1. Level return shape (name, group, spawnPoint, colliders, ground/blocking
 *      queries, warmup, snapshot, env, idempotent dispose).
 *   2. 10–12 unique player spawns, each grounded at its tier, inside a valid
 *      player volume, and clear of solids.
 *   3. Unique pickup ids, each grounded, inside a valid volume, and not in a solid.
 *   4. At least four vertical connectors (two ramps + jump pad + teleporter) and
 *      a ramp whose surface interpolates between tiers.
 *   5. Shot-occluder ↔ collider agreement for the coarse solids the server rewinds
 *      against, and a broken central sightline (turntable machinery).
 *   6. Bounded static draw calls / material batches.
 *   7. Every spawn can reach a weapon and a health pickup within a short radius.
 *
 * Run: node scripts/verify-deathmatch-arena.mjs
 * Alias: npm run verify:deathmatch-arena
 */

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createDeathmatchArenaLevel } from '../src/game/world/createDeathmatchArenaLevel.js';
import {
  RAIL_CRUCIBLE,
  isInsideValidVolume,
  isInsideSolid,
} from '../src/game/config/deathmatch/railCrucibleMap.js';
import { isSightBlocked } from '../party/deathmatch/combat.js';
import { PICKUP_KIND } from '../src/game/config/deathmatch/deathmatchRules.js';

let passed = 0;
const ok = (message) => {
  passed += 1;
  console.log(`  ✓ ${message}`);
};

const GROUND_OPTS = { maxStepUp: 0.6, maxSnapDown: 0.6 };
const level = createDeathmatchArenaLevel();

// ── 1. Level return shape ─────────────────────────────────────────────────────
{
  assert.equal(level.name, 'Rail Crucible');
  assert.equal(level.arenaMapId, 'rail-crucible-v1');
  assert.ok(level.group instanceof THREE.Group);
  assert.ok(level.spawnPoint instanceof THREE.Vector3);
  assert.ok(Number.isFinite(level.spawnYaw));
  assert.ok(Array.isArray(level.colliders) && level.colliders.length > 8, 'colliders present');
  assert.equal(typeof level.getGroundHeightAt, 'function');
  assert.equal(typeof level.getBlockingColliderAt, 'function');
  assert.equal(level.isNearFieldReady(), true);
  assert.equal(level.deathmatchEnvironment.weather, 'clear');
  const warmup = level.createPipelineWarmupGroup();
  assert.ok(warmup instanceof THREE.Group && warmup.children.length > 0, 'warmup group');
  ok('level exposes the full arena contract (shape, queries, warmup, env)');
}

// ── 2. Player spawns ─────────────────────────────────────────────────────────
{
  const spawns = RAIL_CRUCIBLE.playerSpawns;
  assert.ok(spawns.length >= 10 && spawns.length <= 12, `expected 10–12 spawns, got ${spawns.length}`);
  const ids = new Set();
  for (const s of spawns) {
    assert.ok(s.id && !ids.has(s.id), `unique spawn id ${s.id}`);
    ids.add(s.id);
    assert.ok(Number.isFinite(s.yaw), `${s.id} yaw`);
    assert.ok(isInsideValidVolume(s.position), `${s.id} inside a valid volume`);
    assert.ok(!isInsideSolid(s.position), `${s.id} not inside a solid`);
    const g = level.getGroundHeightAt(new THREE.Vector3(...s.position), 0.35, GROUND_OPTS);
    assert.ok(Math.abs(g - s.position[1]) < 0.4, `${s.id} grounded (want ${s.position[1]}, got ${g.toFixed(2)})`);
  }
  ok(`all ${spawns.length} spawns are unique, grounded, in-volume, and clear of solids`);
}

// ── 3. Pickups ───────────────────────────────────────────────────────────────
{
  const pickups = RAIL_CRUCIBLE.pickupSpawns;
  const ids = new Set();
  for (const p of pickups) {
    assert.ok(p.id && !ids.has(p.id), `unique pickup id ${p.id}`);
    ids.add(p.id);
    assert.ok(Object.values(PICKUP_KIND).includes(p.kind), `${p.id} valid kind`);
    assert.ok(isInsideValidVolume(p.position), `${p.id} inside a valid volume`);
    assert.ok(!isInsideSolid(p.position), `${p.id} not inside a solid`);
    const g = level.getGroundHeightAt(new THREE.Vector3(...p.position), 0.35, GROUND_OPTS);
    assert.ok(Math.abs(g - p.position[1]) < 0.4, `${p.id} grounded (want ${p.position[1]}, got ${g.toFixed(2)})`);
  }
  // Required arsenal is present exactly once.
  const weapons = pickups.filter((p) => p.kind === 'weapon').map((p) => p.weaponId);
  for (const w of ['tactical-shotgun', 'desert-ar15', 'desert-sentinel']) {
    assert.equal(weapons.filter((x) => x === w).length, 1, `one ${w} pickup`);
  }
  ok(`all ${pickups.length} pickups unique/grounded/in-volume and the arsenal is complete`);
}

// ── 4. Vertical connectors + ramp interpolation ──────────────────────────────
{
  const snap = level.snapshot();
  assert.ok(snap.connectors >= 4, `at least 4 vertical connectors, got ${snap.connectors}`);
  assert.ok(RAIL_CRUCIBLE.jumpPads.length >= 1, 'a jump pad exists');
  assert.ok(RAIL_CRUCIBLE.teleporters.length >= 1, 'a teleporter exists');

  const low = level.getGroundHeightAt(new THREE.Vector3(-24, -3.5, -4), 0.3, GROUND_OPTS);
  const mid = level.getGroundHeightAt(new THREE.Vector3(-24, -1, 6), 0.3, GROUND_OPTS);
  const between = level.getGroundHeightAt(new THREE.Vector3(-24, -2, 1), 0.3, GROUND_OPTS);
  assert.ok(between > low - 0.5 && between < mid + 0.5, `ramp height interpolates (${low.toFixed(2)} < ${between.toFixed(2)} < ${mid.toFixed(2)})`);
  assert.ok(between > low + 0.3, 'ramp climbs above the lower floor');

  // Ramps must not act as solid walls when standing on the deck surface.
  for (const ramp of RAIL_CRUCIBLE.ramps) {
    const midZ = (ramp.z0 + ramp.z1) * 0.5;
    const midY = (ramp.lowY + ramp.highY) * 0.5;
    const g = level.getGroundHeightAt(new THREE.Vector3(ramp.x, midY, midZ), 0.3, GROUND_OPTS);
    assert.ok(Math.abs(g - midY) < 0.35, `${ramp.id} surface near mid-run (want ~${midY}, got ${g.toFixed(2)})`);
    const block = level.getBlockingColliderAt({
      position: { x: ramp.x, y: g, z: midZ },
      radius: 0.35,
      feetY: g,
      height: 1.8,
      stepHeight: 0.45,
    });
    assert.equal(block, null, `${ramp.id} must not block when standing on the deck (got ${block?.name})`);
  }
  ok('four+ vertical connectors and a ramp that interpolates between tiers');
}

// ── 5. Occluder ↔ collider agreement + broken centre sightline ───────────────
{
  // Every coarse solid the server occludes against has a matching level collider.
  for (const occ of RAIL_CRUCIBLE.shotOccluders) {
    if (occ.id.startsWith('occ-wall')) continue; // walls are floors/perimeter, checked via solids
    const key = occ.id.replace('occ-', '');
    const match = level.colliders.some((c) => c.name.includes(key));
    assert.ok(match, `occluder ${occ.id} has a matching collider`);
  }
  // The turntable machinery breaks a top-down sightline across the centre.
  const fromAbove = [0, 10, -12];
  const across = [0, 0.5, 12];
  assert.equal(isSightBlocked(fromAbove, across), true, 'central floor sightline is broken by machinery');
  // A clear side lane is NOT blocked.
  assert.equal(isSightBlocked([20, 1.6, -10], [20, 1.6, 10]), false, 'side lane stays open');
  ok('shot occluders match colliders and the centre lane is broken while side lanes stay open');
}

// ── 6. Draw / material budget ────────────────────────────────────────────────
{
  const snap = level.snapshot();
  assert.ok(snap.drawCalls <= 12, `static draw calls bounded (${snap.drawCalls})`);
  assert.ok(snap.materialBatches <= 12, `material batches bounded (${snap.materialBatches})`);
  assert.equal(snap.tiers, 3);
  ok(`static draws (${snap.drawCalls}) and material batches (${snap.materialBatches}) within budget`);
}

// ── 7. Route constraints: weapon + health reachable from every spawn ─────────
{
  const weaponPts = RAIL_CRUCIBLE.pickupSpawns.filter((p) => p.kind === 'weapon');
  const healthPts = RAIL_CRUCIBLE.pickupSpawns.filter((p) => p.kind === 'health');
  const near = (a, b, r) => Math.hypot(a[0] - b.position[0], a[1] - b.position[1], a[2] - b.position[2]) <= r;
  const REACH = 30;
  for (const s of RAIL_CRUCIBLE.playerSpawns) {
    assert.ok(weaponPts.some((w) => near(s.position, w, REACH)), `${s.id} has a weapon within ${REACH}m`);
    assert.ok(healthPts.some((h) => near(s.position, h, REACH)), `${s.id} has health within ${REACH}m`);
  }
  ok('every spawn has a weapon and a health pickup within reach');
}

// ── 8. Idempotent dispose ────────────────────────────────────────────────────
{
  level.dispose();
  level.dispose();
  ok('dispose is idempotent');
}

console.log(`\n✓ deathmatch arena: ${passed} checks passed`);
