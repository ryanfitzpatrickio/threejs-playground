// Guards plain-road bridges over rivers: the river carve must not punch through
// the bridged road floor after applyRoadCorridorHeight, and deck colliders must
// exist so characters/vehicles stand on the crossing.
//
// Run: node scripts/verify-road-river-bridge.mjs

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createStreamingTerrainLevel } from '../src/game/world/createStreamingTerrainLevel.js';
import { ROAD_SURFACE_LIFT } from '../src/game/world/createRoadworks.js';
import { applyRoadCorridorHeight, clampBridgedRoadFloor } from '../src/world/worldMap/roadProfile.js';
import { applyRiverCorridorHeight } from '../src/world/worldMap/riverProfile.js';

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

// Pure helper: river carve after road clamp must be undone under bridged decks.
{
  const corridor = { roadY: 6, grounded: false, weight: 1 };
  const clearance = 0.8;
  let h = applyRoadCorridorHeight(20, corridor, clearance);
  h = applyRiverCorridorHeight(h, { bedY: -14, waterY: -8, weight: 1 });
  assert.equal(h, -14, 'river alone trenches the bridged clamp');
  h = clampBridgedRoadFloor(h, corridor, clearance);
  assert.ok(Math.abs(h - (6 - clearance)) < 1e-9, 're-clamp restores the deck floor');
  ok('clampBridgedRoadFloor survives river carve');

  const grounded = { roadY: 0.5, grounded: true, weight: 1 };
  let g = applyRoadCorridorHeight(0.5, grounded, clearance);
  g = applyRiverCorridorHeight(g, { bedY: -13.5, waterY: -8, weight: 1 });
  g = clampBridgedRoadFloor(g, grounded, clearance);
  assert.equal(g, 0.5, 'grounded road crossing restores full roadY after river');
}

const worldMap = {
  name: 'road-river-bridge',
  spawn: { x: 0, z: 0 },
  zones: [],
  roads: [{
    id: 'main',
    width: 10,
    points: [{ x: -120, z: 0 }, { x: 120, z: 0 }],
  }],
  rivers: [{
    id: 'crossing',
    width: 24,
    depth: 14,
    points: [{ x: -30, z: 50 }, { x: 30, z: -50 }],
  }],
  pois: [],
};

const level = createStreamingTerrainLevel({}, { worldMap });
const decks = (level.colliders ?? []).filter((c) => c.name?.startsWith('Road Deck'));
assert.ok(decks.length > 0, 'plain road over river emits deck colliders');

const crossing = level.findNearestRoadPoint(0, 0, { maxDistance: 200 });
assert.ok(crossing, 'road point at origin crossing');
const pos = new THREE.Vector3(crossing.x, crossing.y + 2, crossing.z);
const groundY = level.getGroundHeightAt(pos, 0.5);
assert.ok(
  groundY >= crossing.y + ROAD_SURFACE_LIFT - 0.15,
  `analytic ground on deck (got ${groundY.toFixed(2)}, roadY ${crossing.y.toFixed(2)})`,
);

const terrainY = level._manager.getHeightAt(crossing.x, crossing.z);
assert.ok(
  terrainY >= crossing.y - 1.2,
  `heightfield under bridge stays near deck floor, not river bed (got ${terrainY.toFixed(2)})`,
);
ok('plain road bridge over river: deck colliders + shaped floor');

console.log(`\n${passed} checks passed.`);
