// Verifies the blueprint-placement pipeline's pure logic:
//   - normalizeEntity rejects bad enum / missing blueprintId / non-finite pos,
//     wraps yaw, clamps scale, and prunes unknown blueprint ids.
//   - normalizeWorldMap prunes entities whose blueprint was deleted.
//   - blueprintLibrary round-trips a Map Builder project (chunks + objects).
//   - Platform ground resolution wins inside the footprint via Math.max and is
//     ignored outside it (the getGroundHeightAt contract createStreamingTerrainLevel
//     relies on for platform/object colliders).
//
// The merge/none runtime (createBlueprintEntities) needs a canvas + Rapier world,
// so it is covered by the manual /run pass, not here.
//
// Run: node scripts/verify-blueprint-placement.mjs

import assert from 'node:assert/strict';

// --- in-memory localStorage polyfill (blueprintLibrary reads/writes localStorage) ---
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => { store.clear(); },
};

const { normalizeEntity, normalizeWorldMap, ENTITY_GROUND_MODES } =
  await import('../src/world/worldMap/worldMapSchema.js');
const { saveBlueprint, getBlueprintProject, listBlueprints, getBlueprintIds, deleteBlueprint } =
  await import('../src/map/blueprintLibrary.js');
const { getGroundHeightAt } = await import('../src/game/world/createBaseLevel.js');

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

// ---------------------------------------------------------------- normalizeEntity
console.log('normalizeEntity');

{
  const e = normalizeEntity({ blueprintId: 'bp1', x: 10, z: -5, yaw: 370, scale: 2, groundMode: 'merge' });
  assert.equal(e.blueprintId, 'bp1');
  assert.equal(e.x, 10); assert.equal(e.z, -5);
  assert.equal(e.yaw, 10);          // 370 % 360
  assert.equal(e.scale, 2);
  assert.equal(e.groundMode, 'merge');
  assert.equal(e.id.startsWith('e_'), true);
  ok('accepts a well-formed entity, wraps yaw');
}

{
  assert.equal(normalizeEntity({ x: 1, z: 2 }), null);                 // missing blueprintId
  assert.equal(normalizeEntity({ blueprintId: '', x: 1, z: 2 }), null);// empty blueprintId
  assert.equal(normalizeEntity({ blueprintId: 'bp1', x: NaN, z: 2 }), null); // non-finite x
  assert.equal(normalizeEntity(null), null);
  ok('rejects missing/empty blueprintId and non-finite position');
}

{
  const e = normalizeEntity({ blueprintId: 'bp1', x: 0, z: 0, groundMode: 'bogus' });
  assert.equal(e.groundMode, 'none');   // unknown enum → default
  const tiny = normalizeEntity({ blueprintId: 'bp1', x: 0, z: 0, scale: -3 });
  assert.equal(tiny.scale, 0.01);       // clamped ≥ 0.01
  ok('defaults unknown groundMode to none, clamps scale');
}

{
  const known = new Set(['bp1']);
  const keptEntity = normalizeEntity({ blueprintId: 'bp1', x: 0, z: 0 }, known);
  assert.ok(keptEntity && keptEntity.blueprintId === 'bp1');
  assert.equal(normalizeEntity({ blueprintId: 'bpGone', x: 0, z: 0 }, known), null); // pruned
  ok('prunes entities whose blueprint id is not in knownBlueprintIds');
}

// ------------------------------------------------------- normalizeWorldMap pruning
console.log('normalizeWorldMap (pruning)');

{
  const json = {
    name: 't', spawn: { x: 0, z: 0 },
    zones: [], roads: [], pois: [],
    entities: [
      { blueprintId: 'bp1', x: 5, z: 5, groundMode: 'platform' },
      { blueprintId: 'bpDead', x: 9, z: 9 },
    ],
  };
  const kept = normalizeWorldMap(json);
  assert.equal(kept.entities.length, 2); // no pruning set → faithful round-trip
  const pruned = normalizeWorldMap(json, new Set(['bp1']));
  assert.equal(pruned.entities.length, 1);
  assert.equal(pruned.entities[0].blueprintId, 'bp1');
  assert.equal(pruned.entities[0].groundMode, 'platform');
  ok('prunes dead blueprint refs only when a known-id set is supplied');
}

// ----------------------------------------------------------- blueprintLibrary CRUD
console.log('blueprintLibrary');

{
  const project = {
    version: 1, chunkSize: 32, resolution: 33, seed: 1729, amplitude: 2.8, octaves: 5,
    chunks: [
      { cx: 0, cz: 0, heights: new Array(33 * 33).fill(0.25) },
      { cx: 1, cz: 0, heights: new Array(33 * 33).fill(-0.1) },
    ],
    objects: [
      { type: 'box', tileIndex: 3, position: [0, 0.5, 0], rotationDegrees: [0, 0, 0], scale: [4, 1, 4] },
      { type: 'box', tileIndex: 7, position: [0, 1.5, 0], rotationDegrees: [0, 45, 0], scale: [3, 1, 3] },
    ],
  };
  const id = saveBlueprint({ name: 'Test House', project }).id;
  assert.ok(typeof id === 'string' && id.length > 0);

  const round = getBlueprintProject(id);
  assert.equal(round.chunkSize, 32);
  assert.equal(round.chunks.length, 2);
  assert.equal(round.chunks[0].heights.length, 33 * 33);
  assert.equal(round.objects.length, 2);
  assert.deepEqual(round.objects[1].rotationDegrees, [0, 45, 0]);
  ok('saveBlueprint → getBlueprintProject preserves chunks + objects');

  const meta = listBlueprints().find((b) => b.id === id);
  assert.equal(meta.name, 'Test House');
  assert.equal(meta.chunks, 2);
  assert.equal(meta.objects, 2);
  ok('listBlueprints reports metadata + counts');

  assert.equal(getBlueprintIds().has(id), true);
  // Overwrite by name (same id) updates the project without duplicating.
  const id2 = saveBlueprint({ name: 'Test House', project: { ...project, chunks: project.chunks.slice(0, 1) } }).id;
  assert.equal(id2, id);
  assert.equal(getBlueprintProject(id).chunks.length, 1);
  assert.equal(listBlueprints().length, 1);
  ok('saveBlueprint overwrites by name (case-insensitive) without duplicating');

  deleteBlueprint(id);
  assert.equal(getBlueprintProject(id), null);
  assert.equal(getBlueprintIds().has(id), false);
  ok('deleteBlueprint removes the entry');
}

// ------------------------------------------------- platform Math.max ground resolution
console.log('platform ground resolution (getGroundHeightAt)');

{
  // A platform collider: flat top at y=10 over [-5,5]².
  const platform = {
    minX: -5, maxX: 5, minZ: -5, maxZ: 5,
    topY: 10, bottomY: 9,
    surfaceHeightAt: () => 10,
  };
  const terrainY = 2;

  // Inside the footprint, no step window → platform top wins (Math.max).
  const inside = getGroundHeightAt({
    position: { x: 0, y: 0, z: 0 }, radius: 0.28,
    colliders: [platform], baseHeight: terrainY,
  });
  assert.equal(inside, 10);
  ok('platform top wins inside its footprint');

  // Outside the footprint → collider not inside → terrain base wins.
  const outside = getGroundHeightAt({
    position: { x: 20, y: 0, z: 20 }, radius: 0.28,
    colliders: [platform], baseHeight: terrainY,
  });
  assert.equal(outside, terrainY);
  ok('terrain wins outside the footprint');

  // maxStepUp gating: a tall platform the player is far below must NOT snap them up.
  const gated = getGroundHeightAt({
    position: { x: 0, y: 0, z: 0 }, radius: 0.28,
    maxStepUp: 0.5,
    colliders: [platform], baseHeight: terrainY,
  });
  assert.equal(gated, terrainY);
  ok('tall platform is step-gated (no yank-up)');

  // ENTITY_GROUND_MODES sanity: every ordered mode has a colour.
  for (const m of ['none', 'merge', 'platform']) {
    assert.ok(typeof ENTITY_GROUND_MODES[m].color === 'string');
  }
  ok('all ground modes carry a colour for editor/minimap rendering');
}

console.log(`\nAll ${passed} blueprint-placement checks passed.`);
