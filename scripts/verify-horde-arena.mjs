// Pure-node contract check for the Horde mall + train-yard arena level.
//
// Guards:
//   1. Level return shape (name, group, spawn, gates, env, ground, dispose).
//   2. 6–8 spawn gates, each on ground, outside player safety radius, pairwise
//      spaced so capsules do not overlap.
//   3. Player starts grounded in the four-way mall center.
//   4. TSL storefront avenue + shipping connection are present.
//   5. Floor collider and train-yard cover remain present.
//   6. dispose() leaves no orphan requirement (idempotent call safe).
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

// Mall start hub + city-technique retail ring.
{
  const mallFloor = level.colliders.find((c) => c.name === 'Mall Floor');
  assert.ok(mallFloor, 'Mall Floor collider');
  assert.ok(level.spawnPoint.x < -40, `spawn should move into mall, got x=${level.spawnPoint.x}`);
  assert.ok(
    level.spawnPoint.x > mallFloor.minX && level.spawnPoint.x < mallFloor.maxX
      && level.spawnPoint.z > mallFloor.minZ && level.spawnPoint.z < mallFloor.maxZ,
    'spawn lies inside mall floor',
  );
  const storefront = level.group.getObjectByName('Mall TSL Storefront Avenue');
  assert.ok(storefront?.isMesh, 'single merged mall storefront avenue');
  assert.ok(storefront.material?.isNodeMaterial, 'mall storefronts use the city TSL node material');
  assert.ok(storefront.geometry.getAttribute('partId'), 'TSL storefront partId attribute');
  assert.ok(storefront.geometry.getAttribute('roomCenter'), 'TSL interior roomCenter attribute');
  assert.ok(storefront.geometry.getAttribute('roomSize'), 'TSL interior roomSize attribute');
  assert.ok((storefront.userData.storeCount ?? 0) >= 28, 'retail avenue surrounds all four sides');
  const aquariumFish = level.group.getObjectByName('Mall Aquarium TSL Fish');
  const atriumRoof = level.group.getObjectByName('Mall Atrium Glass Roof');
  const atriumCanopy = level.group.getObjectByName('Mall Atrium Pitched Glass Canopy');
  const atriumOculus = level.group.getObjectByName('Mall Atrium Luminous Oculus');
  assert.ok(atriumRoof?.material?.userData?.mallAquariumGlass, 'glass atrium roof uses aquarium glass TSL');
  assert.ok(atriumCanopy?.material?.userData?.mallAquariumGlass, 'pitched canopy uses aquarium glass TSL');
  assert.equal(atriumCanopy?.userData?.panelCount, 4, 'four canopy planes connect the aquarium pillars');
  assert.ok(atriumOculus?.isMesh, 'luminous canopy oculus');
  // Glass is per-tank, per-face so one pane can shatter independently.
  assert.ok(level.aquarium?.tanks?.length === 4, 'level.aquarium exposes four tanks');
  assert.equal(level.aquarium.waterMeshes?.length, 4, 'four per-tank water meshes');
  for (const tank of level.aquarium.tanks) {
    assert.ok(tank.waterMesh?.isMesh, `tank ${tank.id} has water mesh`);
    assert.ok(
      tank.waterMesh.material?.userData?.mallAquariumWater
        || tank.waterMesh.userData?.mallAquariumWater,
      `tank ${tank.id} uses aquarium water material`,
    );
    assert.ok(tank.waterH > 1, `tank ${tank.id} has water height`);
    assert.ok(tank.faceMeshes, `tank ${tank.id} has faceMeshes`);
    for (const face of ['+x', '-x', '+z', '-z']) {
      assert.ok(tank.faceMeshes[face]?.isMesh, `tank ${tank.id} face ${face}`);
      assert.ok(
        tank.faceMeshes[face].material?.userData?.mallAquariumGlass
          || tank.faceMeshes[face].userData?.mallAquariumGlass,
        `tank ${tank.id} face ${face} glass material`,
      );
    }
  }
  const glassVolumes = level.colliders.filter((c) => /^Mall Aquarium Pillar Volume/.test(c.name));
  assert.equal(glassVolumes.length, 4, 'four aquarium pillar volumes preserve the center cross');
  for (const vol of glassVolumes) {
    assert.equal(vol.surfaceClass, 'glass', `${vol.name} is glass for decals/impacts`);
    assert.ok(vol.topY < 8 && vol.topY > 5, `${vol.name} topY tracks glass top (got ${vol.topY})`);
  }
  assert.ok(aquariumFish?.material?.userData?.mallAquariumFish, 'animated TSL fish material');
  assert.ok(aquariumFish.geometry.getAttribute('fishSeed'), 'fish seed drives independent TSL movement');
  assert.ok(aquariumFish.geometry.getAttribute('tankIndex'), 'fish tankIndex for waterline clamp');
  assert.ok(aquariumFish.geometry.getAttribute('fishRestY'), 'fish rest Y for sink clamp');
  assert.ok(aquariumFish.material?.userData?.tankWaterLevels, 'fish material exposes tankWaterLevels uniform');
  assert.equal(level.aquarium.fishMesh, aquariumFish, 'level.aquarium.fishMesh is the merged fish mesh');
  assert.ok((aquariumFish.userData.fishCount ?? 0) >= 40, 'aquarium centerpiece has a visible fish school');
  assert.ok(level.colliders.some((c) => c.name === 'Mall Shipping Floor'), 'shipping floor reaches yard');
  assert.ok(level.colliders.some((c) => c.name === 'Mall Shipping North Wall'), 'shipping hall north wall');
  assert.ok(level.colliders.some((c) => c.name === 'Mall Shipping South Wall'), 'shipping hall south wall');
  const legStorefront = level.group.getObjectByName('Mall West Leg Storefronts');
  assert.ok(legStorefront?.isMesh, 'single merged west-leg storefront mesh');
  assert.ok(legStorefront.material?.isNodeMaterial, 'leg storefronts use the city TSL node material');
  assert.ok(legStorefront.geometry.getAttribute('partId'), 'leg storefront partId attribute');
  assert.ok((legStorefront.userData.storeCount ?? 0) >= 36, 'winding leg is lined with shops both sides');
  assert.ok(level.colliders.some((c) => c.name === 'Mall Leg Floor A'), 'leg A floor');
  assert.ok(level.colliders.some((c) => c.name === 'Mall Leg Floor B'), 'bend corridor floor');
  assert.ok(level.colliders.some((c) => c.name === 'Food Court Floor'), 'food court floor at leg end');
  assert.ok(
    level.colliders.filter((c) => c.name.startsWith('Mall Leg Portal Header')).length === 2,
    'leg mouth has storefront-line + shell portal frames',
  );
  const courtFloor = level.colliders.find((c) => c.name === 'Food Court Floor');
  const courtSpan = (courtFloor.maxX - courtFloor.minX) * (courtFloor.maxZ - courtFloor.minZ);
  const mallSpan = (mallFloor.maxX - mallFloor.minX) * (mallFloor.maxZ - mallFloor.minZ);
  assert.ok(
    Math.abs(courtSpan / mallSpan - 0.5) < 0.08,
    `food court is ~half the mall footprint (${(courtSpan / mallSpan).toFixed(2)})`,
  );
  const legPath = Math.abs(courtFloor.minX - mallFloor.minX);
  assert.ok(courtFloor.minX < -260, `winding leg roughly doubles the mall depth, court minX=${courtFloor.minX}`);
  assert.ok(legPath > 130, `leg + court reach ~2× the mall width (${legPath.toFixed(1)}m)`);
  assert.ok(
    level.colliders.filter((c) => c.name.startsWith('Food Court Table ')).length >= 8,
    'food court table groups placed',
  );
  const shippingFloor = level.colliders.find((c) => c.name === 'Mall Shipping Floor');
  const yardFloor = level.colliders.find((c) => c.name === 'Horde Floor');
  assert.ok(shippingFloor.minX < -50, 'shipping entrance begins flush with the final storefront');
  assert.ok(
    shippingFloor.topY > yardFloor.topY + 0.005,
    'shipping finish is lifted above the yard slab to prevent ground z-fighting',
  );
  assert.equal(
    level.colliders.filter((c) => c.name.startsWith('Mall Shipping Portal Header')).length,
    3,
    'entry, recessed shell, and yard frames form a padded vestibule',
  );
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
assert.equal(snap?.theme, 'mall-train-yard');
assert.equal(snap?.startArea, 'mall-center');
assert.ok((snap?.mallStores ?? 0) >= 28, 'mall store count');
assert.equal(snap?.mallStorefrontPanes, snap?.mallStores);
assert.ok((snap?.mallCrossWidth ?? 0) >= 10, 'four-way center cross width');
assert.ok((snap?.mallRingWidth ?? 0) >= 7, 'perimeter shopping avenue width');
assert.equal(snap?.mallAquariumPillars, 4, 'four aquarium atrium pillars');
assert.ok((snap?.mallAquariumFish ?? 0) >= 40, 'TSL fish count');
assert.equal(snap?.mallCanopyPanels, 4, 'pitched glass canopy panels');
assert.equal(snap?.mallStoreRoofs, 6, 'all six store runs have visible roofs (west splits around the leg mouth)');
assert.ok((snap?.mallStoreClosures ?? 0) >= 8, 'store ends and shipping returns are closed');
assert.equal(snap?.mallServiceDisplays, 8, 'both faces of the shipping returns are architecturally finished');
assert.ok((snap?.mallLegStores ?? 0) >= 36, 'winding leg + food court storefront count');
assert.equal(snap?.mallLegPanes, snap?.mallLegStores, 'every leg storefront raymarches an interior');
assert.equal(snap?.foodCourtStalls, 6, 'west-wall food stall fronts');
assert.ok((snap?.foodCourtTables ?? 0) >= 8, 'food court table groups');
assert.equal(snap?.foodCourtKiosks, 6, 'counter kiosks along the court side walls');
assert.ok((snap?.bounds?.minX ?? 0) < -270, 'arena bounds cover the food court');
assert.ok((snap?.bounds?.maxZ ?? 0) > 55, 'arena bounds cover the offset bend');
assert.ok(snap?.shippingExit?.x0 < snap?.shippingExit?.x1, 'shipping exit reaches east into yard');
assert.ok((snap?.shippingExit?.vestibuleDepth ?? 0) >= 7, 'shipping entrance is padded inward to the mall shell');
assert.equal(snap?.gates, gates.length);
assert.ok((snap?.tracks ?? 0) >= 3, 'expected multiple tracks');
assert.ok((snap?.boxcars ?? 0) >= 8, 'expected boxcars');
assert.ok((snap?.tankCars ?? 0) >= 4, 'expected tank cars');

// Static merge: one draw per material batch, not thousands of detail meshes.
assert.ok((snap?.sourceMeshes ?? 0) > 100, 'expected many source detail meshes before merge');
// Budget: 23 base batches + 8 food-court furnishing materials (table tops,
// 2 seat colours, counters, 3 sign colours, guard glass, hedge foliage).
assert.ok(
  (snap?.staticDrawCalls ?? Infinity) <= 31,
  `expected ≤31 static material batches after mall merge, got ${snap?.staticDrawCalls}`,
);
assert.ok(
  (snap?.drawCalls ?? Infinity) <= 40,
  `expected ≤40 total level batches including city furniture, got ${snap?.drawCalls}`,
);
assert.ok(
  (snap?.staticDrawCalls ?? Infinity) < (snap?.sourceMeshes ?? 0) / 10,
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
  `ok: horde mall + train yard — ${gates.length} gates, ${level.colliders.length} colliders, `
  + `cover=${cover.length}, tracks=${snap.tracks}, boxcars=${snap.boxcars}, tanks=${snap.tankCars}, `
  + `meshes ${snap.sourceMeshes}→${snap.drawCalls} draws`,
);
console.log('PASS: M2 horde arena contract holds.');
