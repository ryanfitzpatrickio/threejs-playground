// Verifies the Edit-editor road/river feature's pure logic:
//   - normalizeRoad/normalizeRiver (now exported) reject <2-point / non-finite
//     entries, clamp width/depth, stamp type + id — parity with the 2D editor.
//   - collectBlueprintRoads/collectBlueprintRivers transform each placed entity's
//     local polylines into WORLD frame (rotate +yaw, scale, translate) and scale
//     width/depth — so blueprint roads/rivers merge into the world pipeline.
//   - the combined-list contract: entities whose project lacks roads/rivers (or
//     whose blueprint was deleted) contribute nothing.
//
// The editor spline UI + 3D overlay need a canvas/WebGPU, so they are covered by
// the manual /run pass, not here.
//
// Run: node scripts/verify-edit-editor-roads-rivers.mjs

import assert from 'node:assert/strict';

// --- in-memory localStorage polyfill (blueprintLibrary reads/writes localStorage) ---
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => { store.clear(); },
};

const { normalizeRoad, normalizeRiver } = await import('../src/world/worldMap/worldMapSchema.js');
const { collectBlueprintRoads, collectBlueprintRivers } =
  await import('../src/game/world/createBlueprintEntities.js');
const { saveBlueprint, deleteBlueprint } = await import('../src/map/blueprintLibrary.js');

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// --------------------------------------------------------- normalizeRoad/River parity
console.log('normalizeRoad / normalizeRiver (exported parity)');

{
  const r = normalizeRoad({ points: [{ x: 0, z: 0 }, { x: 10, z: 0 }], width: 1 });
  assert.equal(r.width, 2);                 // clamped ≥ 2
  assert.equal(r.type, 'road');
  assert.equal(r.points.length, 2);
  assert.ok(r.id.startsWith('r_'));
  assert.equal(normalizeRoad({ points: [{ x: 0, z: 0 }] }), null);              // <2 pts
  assert.equal(normalizeRoad({ points: [{ x: NaN, z: 0 }, { x: 1, z: 0 }] }), null); // non-finite
  ok('normalizeRoad clamps width, stamps type+id, drops <2-point / non-finite');
}
{
  const r = normalizeRiver({ points: [{ x: 0, z: 0 }, { x: 1, z: 0 }], depth: 0 });
  assert.equal(r.depth, 1);                 // clamped ≥ 1
  assert.equal(r.type, 'river');
  assert.ok(r.id.startsWith('rv_'));
  assert.equal(normalizeRiver({ points: [{ x: 0, z: 0 }] }), null);
  ok('normalizeRiver clamps depth, stamps type+id, drops <2-point');
}

// --------------------------------------------------- a blueprint project with road+river
console.log('collectBlueprintRoads / collectBlueprintRivers (local → world)');

const project = {
  version: 1, chunkSize: 32, resolution: 33, seed: 1, amplitude: 2, octaves: 5,
  chunks: [{ cx: 0, cz: 0, heights: new Array(33 * 33).fill(0) }],
  roads: [
    { id: 'rA', points: [{ x: 0, z: 0 }, { x: 40, z: 0 }], width: 8, type: 'road' },
    // rB has a non-numeric point ('bad' survives JSON round-trip, then fails
    // Number() → filtered) alongside two valid points → kept as a 2-point road.
    { id: 'rB', points: [{ x: 'bad', z: 0 }, { x: 1, z: 1 }, { x: 2, z: 2 }], width: 5 },
  ],
  rivers: [
    { id: 'vA', points: [{ x: 0, z: 10 }, { x: 40, z: 10 }], width: 10, depth: 6, type: 'river' },
  ],
  objects: [],
};
const bpId = saveBlueprint({ name: 'Roady', project }).id;

// Entity placed at (100,50), yaw 90°, scale 2 → cos=0, sin=1.
const worldMap = {
  entities: [
    { id: 'e1', blueprintId: bpId, x: 100, z: 50, yaw: 90, scale: 2, groundMode: 'merge' },
  ],
};

{
  const roads = collectBlueprintRoads(worldMap);
  assert.equal(roads.length, 2);
  const a = roads.find((r) => r.id === 'e1:rA');
  assert.ok(a, 'rA road present');
  assert.equal(a.type, 'road');
  assert.equal(a.width, 16);                // 8 * scale 2
  // (0,0) → (100,50); (40,0) → (100,130)  [90°/×2 transform]
  assert.ok(near(a.points[0].x, 100) && near(a.points[0].z, 50));
  assert.ok(near(a.points[1].x, 100) && near(a.points[1].z, 130));
  // rB kept its 2 finite points (NaN point filtered), also world-transformed.
  const b = roads.find((r) => r.id === 'e1:rB');
  assert.equal(b.points.length, 2);
  ok('collectBlueprintRoads: world transform + width scale + bad-point filter');
}

{
  const rivers = collectBlueprintRivers(worldMap);
  assert.equal(rivers.length, 1);
  const v = rivers[0];
  assert.equal(v.type, 'river');
  assert.equal(v.width, 20);                // 10 * 2
  assert.equal(v.depth, 12);                // 6 * 2
  // yaw 90° (cos0,sin1) × scale 2 at (100,50): wx = 100 − 2·lz, wz = 50 + 2·lx
  // (0,10) → (80,50); (40,10) → (80,130)
  assert.ok(near(v.points[0].x, 80) && near(v.points[0].z, 50));
  assert.ok(near(v.points[1].x, 80) && near(v.points[1].z, 130));
  ok('collectBlueprintRivers: world transform + width/depth scale');
}

// ------------------------------------------------ combined-list contract + zero contributions
console.log('combined-list contract');

{
  // An entity whose project has NO roads/rivers contributes nothing.
  const plain = saveBlueprint({
    name: 'Plain',
    project: { ...project, roads: undefined, rivers: undefined },
  }).id;
  const wm = { entities: [
    { id: 'e1', blueprintId: bpId, x: 0, z: 0, yaw: 0, scale: 1, groundMode: 'merge' },
    { id: 'e2', blueprintId: plain, x: 0, z: 0, yaw: 0, scale: 1, groundMode: 'merge' },
  ] };
  assert.equal(collectBlueprintRoads(wm).length, 2);   // only e1's project roads
  assert.equal(collectBlueprintRivers(wm).length, 1);  // only e1's project river
  ok('entity with no project roads/rivers contributes nothing');

  // A deleted blueprint → loadProjectSafe null → contributes nothing.
  deleteBlueprint(bpId);
  assert.equal(collectBlueprintRoads(wm).length, 0);
  assert.equal(collectBlueprintRivers(wm).length, 0);
  ok('entity whose blueprint was deleted contributes nothing');

  // Combined list shape that createStreamingTerrainLevel builds.
  const local = { roads: [{ points: [{ x: 0, z: 0 }, { x: 1, z: 0 }], width: 8 }], rivers: [] };
  const combinedRoads = [...(local.roads ?? []), ...collectBlueprintRoads(wm)];
  assert.equal(combinedRoads.length, 1); // only the local road survives
  ok('combined [...worldMap.roads, ...bpRoads] list is well-formed');
}

console.log(`\nAll ${passed} edit-editor road/river checks passed.`);
