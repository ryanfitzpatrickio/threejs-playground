// Headless runtime smoke for the blueprint instantiator (createBlueprintEntities)
// across all three ground modes — exercising the merge-field math, per-mode
// branching, and mesh + collider derivation that the pure verify script can't
// reach (it needs a canvas + ChunkManager). The full terrain integration
// (createStreamingTerrainLevel) is build-verified; the merge seam is a visual
// check left for the manual /run pass.
//
// Run: node scripts/probe-blueprint-spawn.mjs

import assert from 'node:assert/strict';
import * as THREE from 'three';

// --- headless DOM stub: createAtlasMaterial paints a canvas texture per object ---
const ctx2d = new Proxy(function () {}, {
  get: (_t, prop) => (prop === 'data' ? new Uint8ClampedArray(4) : ctx2d),
  apply: () => ctx2d,
});
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }),
  createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, setAttribute() {}, style: {} }),
};
// --- in-memory localStorage for the blueprint library ---
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

import { saveBlueprint } from '../src/map/blueprintLibrary.js';
import { createBlueprintEntities } from '../src/game/world/createBlueprintEntities.js';

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

// A 2-chunk, 2-object blueprint: chunk (0,0) flat at 0.25, chunk (1,0) at 0.1.
// Footprint AABB (chunkSize 32) → x:[-16,48], z:[-16,16]; centre (0,0) inside.
const N = 33 * 33;
const project = {
  version: 1, chunkSize: 32, resolution: 33, seed: 1729, amplitude: 2.8, octaves: 5,
  chunks: [
    { cx: 0, cz: 0, heights: new Array(N).fill(0.25) },
    { cx: 1, cz: 0, heights: new Array(N).fill(0.1) },
  ],
  objects: [
    { type: 'box', tileIndex: 3, position: [0, 0.5, 0], rotationDegrees: [0, 0, 0], scale: [4, 1, 4] },
    { type: 'box', tileIndex: 7, position: [0, 1.5, 0], rotationDegrees: [0, 45, 0], scale: [3, 1, 3] },
  ],
};
const BP_ID = saveBlueprint({ name: 'Smoke House', project }).id;
const baseGroundAt = (/** @type {number} */ _x, /** @type {number} */ _z) => 5; // flat world ground y=5

console.log('createBlueprintEntities — Phase A (merge field + platform colliders)');

{
  const bp = createBlueprintEntities({}, {
    worldMap: { entities: [{ id: 'e1', name: 'E', blueprintId: BP_ID, x: 0, z: 0, yaw: 0, scale: 1, groundMode: 'merge' }] },
    baseGroundAt,
  });
  const center = bp.mergeField(0, 0);            // entity centre → inside footprint
  assert.ok(center.weight > 0.99, `centre weight ${center.weight}`);
  // stamped = baseGround(5) + authored local height (0.25) * scale(1) = 5.25
  assert.ok(Math.abs(center.height - 5.25) < 1e-6, `centre height ${center.height}`);
  const edge = bp.mergeField(0, 24);             // 8m past the z:+16 edge, inside the 16m feather
  assert.ok(edge.weight > 0 && edge.weight < 1, `feather weight ${edge.weight}`);
  const far = bp.mergeField(200, 200);
  assert.equal(far.weight, 0);
  ok('merge: weight 1 at centre, feathered at edge, 0 far outside');
}

{
  const bp = createBlueprintEntities({}, {
    worldMap: { entities: [{ id: 'e2', blueprintId: BP_ID, x: 0, z: 0, yaw: 0, scale: 1, groundMode: 'platform' }] },
    baseGroundAt,
  });
  assert.equal(bp.colliders.length, 1);
  const c = bp.colliders[0];
  assert.ok(c.name.startsWith('bp-platform'));
  assert.equal(typeof c.surfaceHeightAt, 'function');
  assert.ok(c.topY >= 5 && c.bottomY < c.topY, `platform slab ${c.bottomY}..${c.topY}`);
  // footprint spans the blueprint AABB (x:[-16,48] → world ~ same at scale 1)
  assert.ok(c.minX < 0 && c.maxX > 0 && c.minZ < 0 && c.maxZ > 0);
  ok('platform: one flat collider clearing base ground over the footprint');
}

{
  const bp = createBlueprintEntities({}, {
    worldMap: { entities: [{ id: 'e3', blueprintId: BP_ID, x: 0, z: 0, yaw: 0, scale: 1, groundMode: 'none' }] },
    baseGroundAt,
  });
  assert.equal(bp.colliders.length, 0);
  assert.equal(bp.mergeField(0, 0).weight, 0);     // none → never stamps terrain
  ok('none: no Phase-A colliders, no merge contribution');
}

console.log('createBlueprintEntities — Phase B (object meshes + colliders)');

for (const mode of ['none', 'merge', 'platform']) {
  const bp = createBlueprintEntities({}, {
    worldMap: { entities: [{ id: `e_${mode}`, blueprintId: BP_ID, x: 0, z: 0, yaw: 30, scale: 1.2, groundMode: mode }] },
    baseGroundAt,
  });
  bp.placeObjects({ sampleGround: (_x, _z) => 5 });
  // The two objects use distinct atlas tiles → one merged batch mesh per tile.
  assert.equal(bp.meshes.length, 2, `${mode}: expected 2 batch meshes`);
  for (const m of bp.meshes) {
    assert.ok(m instanceof THREE.Mesh, `${mode}: mesh is THREE.Mesh`);
    assert.ok(m.geometry && m.material, `${mode}: mesh has geometry + material`);
    // World transforms are baked into the merged geometry (mesh sits at identity):
    // both boxes ride the sampled ground (y=5), so world-space bounds sit above it.
    m.geometry.computeBoundingBox();
    assert.ok(m.geometry.boundingBox.min.y > 4 && m.geometry.boundingBox.max.y < 9,
      `${mode}: baked world bounds ride the sampled ground (got y ${m.geometry.boundingBox.min.y.toFixed(2)}..${m.geometry.boundingBox.max.y.toFixed(2)})`);
  }
  // platform carries its Phase-A collider + 2 object colliders; none/merge carry 2.
  const expectedColliders = mode === 'platform' ? 3 : 2;
  assert.equal(bp.colliders.length, expectedColliders, `${mode}: collider count ${bp.colliders.length}`);
  for (const c of bp.colliders) {
    assert.ok(c.minX <= c.maxX && c.minZ <= c.maxZ && c.bottomY <= c.topY, `${mode}: sane AABB`);
    assert.ok(c.physicsOwnerKey, `${mode}: collider tagged with physicsOwnerKey`);
  }
  ok(`${mode}: places 2 baked meshes + ${expectedColliders} colliders (yaw 30°, scale 1.2)`);
}

console.log('createBlueprintEntities — unknown blueprint id is skipped gracefully');

{
  const bp = createBlueprintEntities({}, {
    worldMap: { entities: [{ id: 'eX', blueprintId: 'does-not-exist', x: 0, z: 0, yaw: 0, scale: 1, groundMode: 'merge' }] },
    baseGroundAt,
  });
  bp.placeObjects({ sampleGround: () => 5 });
  assert.equal(bp.meshes.length, 0);
  assert.equal(bp.colliders.length, 0);
  assert.equal(bp.mergeField(0, 0).weight, 0);
  ok('missing blueprint → empty group, no throw');
}

console.log(`\nAll ${passed} blueprint-spawn runtime checks passed.`);
