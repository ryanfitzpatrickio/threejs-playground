import assert from 'node:assert/strict';
import { zoneContains } from '../src/world/worldMap/zoneGeometry.js';
import { buildRoadProfile } from '../src/world/worldMap/roadProfile.js';
import { buildRiverProfile } from '../src/world/worldMap/riverProfile.js';
import {
  scatterForestPlacements,
  computeForestPlacementTarget,
  zoneForestSeed,
  mulberry32,
  treesPerSqM,
  DEFAULT_FOREST_DENSITY_PER_HA,
} from '../src/game/world/forest/forestPlacement.js';
import {
  isForestZoneCorridorExcluded,
} from '../src/game/world/forest/forestCorridor.js';
import { FOREST_CORRIDOR_MARGIN } from '../src/game/world/forest/forestPlacement.js';
import { isForestCorridorExcluded } from '../src/game/world/createZoneForest.js';
import { parseForestSpeciesMix } from '../src/game/world/forest/forestSpecies.js';

const flatGround = () => 12;

const testZone = {
  id: 'forest_test',
  type: 'forest',
  shape: 'rect',
  rect: { minX: 0, minZ: 0, maxX: 100, maxZ: 100 },
  props: { species: 'pine', density: 150, seed: 42 },
};

const polyZone = {
  id: 'forest_poly',
  type: 'forest',
  shape: 'polygon',
  points: [
    { x: 200, z: 200 },
    { x: 260, z: 200 },
    { x: 240, z: 260 },
  ],
  props: { species: 'pine', density: 200, seed: 7 },
};

const road = buildRoadProfile({
  roads: [{
    points: [{ x: 40, z: 50 }, { x: 60, z: 50 }],
    width: 8,
  }],
  sampleHeight: flatGround,
  isWilds: () => false,
  smoothRadius: 2,
  maxGrade: Infinity,
}).corridorAt;

const river = buildRiverProfile({
  rivers: [{
    points: [{ x: 80, z: 80 }, { x: 90, z: 80 }],
    width: 10,
    depth: 5,
  }],
  sampleHeight: flatGround,
  smoothRadius: 2,
}).corridorAt;

// Deterministic seeding
const seedA = zoneForestSeed(testZone);
const seedB = zoneForestSeed({ ...testZone, props: { ...testZone.props, seed: 99 } });
assert.equal(seedA, zoneForestSeed(testZone), 'zone forest seed is stable');
assert.notEqual(seedA, seedB, 'zone forest seed changes with props.seed');

const rng1 = mulberry32(seedA);
const rng2 = mulberry32(seedA);
assert.equal(rng1(), rng2(), 'mulberry32 is deterministic');

// Density math: 100×100 m @ 150 trees/ha → 150 trees before cap
const areaTarget = computeForestPlacementTarget([testZone], 10000);
assert.equal(areaTarget, 150, 'density-to-count math matches trees/hectare');

assert.equal(treesPerSqM(testZone), DEFAULT_FOREST_DENSITY_PER_HA / 10000);

const mix = parseForestSpeciesMix('pine:0.6,douglas-fir:0.4');
assert.equal(mix.length, 2);
assert.equal(mix[0].key, 'pine');

// Corridor exclusion
assert.equal(isForestZoneCorridorExcluded(50, 50, road, null, FOREST_CORRIDOR_MARGIN), true,
  'forest corridor margin rejects road center');
assert.equal(isForestCorridorExcluded(50, 50, road, null), true,
  'wilds corridor rejects road center');
assert.equal(isForestZoneCorridorExcluded(5, 5, road, null, FOREST_CORRIDOR_MARGIN), false,
  'forest corridor allows points away from vectors');
assert.equal(isForestCorridorExcluded(5, 5, road, null), false,
  'wilds corridor allows points away from vectors');

// Widened margin rejects shoulder points that wilds weight>0 alone still allows.
assert.equal(isForestCorridorExcluded(50, 62, road, null), false);
assert.equal(isForestZoneCorridorExcluded(50, 62, road, null, FOREST_CORRIDOR_MARGIN), true,
  'forest corridor margin extends beyond wilds weight>0 feather');

const placements = scatterForestPlacements({
  zones: [testZone, polyZone],
  sampleHeight: flatGround,
  roadCorridor: road,
  riverCorridor: river,
  archetypeCount: 5,
  cap: 250,
  corridorExcluded: isForestZoneCorridorExcluded,
});

assert.ok(placements.length > 0, 'scatter produces trees');
assert.ok(placements.length <= 250, 'scatter respects cap');

for (const p of placements) {
  const zone = p.zoneId === testZone.id ? testZone : polyZone;
  assert.ok(zoneContains(zone, p.x, p.z), 'every tree lies inside its zone polygon');
  assert.equal(isForestZoneCorridorExcluded(p.x, p.z, road, river), false,
    'scattered trees avoid widened corridors');
  assert.ok(p.archetypeIndex >= 0 && p.archetypeIndex < 5, 'archetype index in range');
}

// Repeat scatter → identical placements (determinism)
const placements2 = scatterForestPlacements({
  zones: [testZone],
  sampleHeight: flatGround,
  roadCorridor: road,
  riverCorridor: river,
  archetypeCount: 5,
  cap: 80,
  corridorExcluded: isForestZoneCorridorExcluded,
});
const placements3 = scatterForestPlacements({
  zones: [testZone],
  sampleHeight: flatGround,
  roadCorridor: road,
  riverCorridor: river,
  archetypeCount: 5,
  cap: 80,
  corridorExcluded: isForestZoneCorridorExcluded,
});
assert.equal(placements2.length, placements3.length);
for (let i = 0; i < placements2.length; i += 1) {
  assert.equal(placements2[i].x, placements3[i].x);
  assert.equal(placements2[i].z, placements3[i].z);
  assert.equal(placements2[i].archetypeIndex, placements3[i].archetypeIndex);
}

console.log(`Forest zone verification passed (${placements.length} placements checked).`);
