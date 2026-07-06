import assert from 'node:assert/strict';
import {
  buildTerrainVisualIndices,
  createChunkData,
  createTerrainChunkMesh,
} from '../src/world/terrain/TerrainChunk.js';

const first = createChunkData({ cx: 0, cz: 0, size: 32, resolution: 5 });
for (let i = 0; i < first.heights.length; i += 1) first.heights[i] = i * 0.1;

const handle = createTerrainChunkMesh(first, { visualResolution: 3 });
const mesh = handle.mesh;
const geometry = handle.geometry;
const position = geometry.getAttribute('position');
const normal = geometry.getAttribute('normal');
const index = geometry.getIndex();

assert.equal(geometry.drawRange.count, 24, '3x3 visual grid renders four cells');
assert.deepEqual(
  [...buildTerrainVisualIndices(first, 3).slice(0, 6)],
  [0, 10, 2, 2, 10, 12],
  'coarse indices address the stable authoritative vertex grid',
);

const second = createChunkData({ cx: 7, cz: -3, size: 32, resolution: 5 });
second.heights.fill(4);
second.visualHoleMask = new Uint8Array(16);
second.visualHoleMask[0] = 1;
handle.updateChunkData(second, { visualResolution: 5, castShadow: true, receiveShadow: true });

assert.strictEqual(handle.mesh, mesh, 'retarget preserves Mesh identity');
assert.strictEqual(handle.geometry, geometry, 'retarget preserves Geometry identity');
assert.strictEqual(geometry.getAttribute('position'), position, 'retarget preserves position buffer identity');
assert.strictEqual(geometry.getAttribute('normal'), normal, 'retarget preserves normal buffer identity');
assert.strictEqual(geometry.getIndex(), index, 'retarget preserves index buffer identity');
assert.strictEqual(handle.chunkData, second, 'handle points at the retargeted chunk');
assert.equal(mesh.position.x, 7 * 32);
assert.equal(mesh.position.z, -3 * 32);
assert.equal(mesh.userData.chunkRef.visualResolution, 5);
assert.equal(geometry.drawRange.count, 15 * 6, 'hole mask removes one full-resolution cell');
assert.equal(position.getY(0), 4, 'retarget updates vertex heights in place');

handle.updateVisualResolution(2, { castShadow: false });
assert.equal(geometry.drawRange.count, 0, 'coarse cell is removed when it overlaps a source hole');
assert.strictEqual(geometry.getIndex(), index, 'LOD changes preserve index buffer identity');

second.visualHoleMask.fill(0);
handle.updateVisualResolution(5);
for (let i = 0; i < normal.count; i += 1) {
  assert.ok(
    Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i)) > 0.5,
    `fine LOD vertex ${i} must have a usable normal after topology promotion`,
  );
}

geometry.dispose();
console.log('terrain render reuse verification passed');
