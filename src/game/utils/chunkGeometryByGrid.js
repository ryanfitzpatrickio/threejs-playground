import * as THREE from 'three';

/**
 * Splits a list of BufferGeometries into per-chunk BufferGeometries, bucketing
 * each TRIANGLE by the (x,z) grid cell its centroid falls in. Used to turn one
 * giant merged mesh (a whole road network's ribbon, or a river/ocean's water
 * plane) into many chunk-sized meshes, so Three.js's ordinary per-object
 * frustum culling (already automatic — every Mesh has `frustumCulled = true`
 * by default) can skip whole chunks that are off-screen instead of always
 * submitting the entire network/ocean every frame.
 *
 * Every input geometry must share the same attribute set (name + itemSize) —
 * true for geometries about to be merged with mergeGeometries anyway. Existing
 * attributes (including `normal`, if already computed) are carried over
 * per-vertex; nothing is recomputed here.
 *
 * This duplicates vertices at chunk-internal triangle boundaries (each
 * triangle's 3 corners are copied independently, not shared/indexed across the
 * whole chunk) — simpler and more robust than trying to preserve the original
 * strip's shared-vertex indexing across an arbitrary chunk split, at the cost
 * of somewhat more vertex data per chunk (typically well under 2x for a ribbon
 * strip, since indexed ribbons already share few vertices between triangles).
 *
 * @param {THREE.BufferGeometry[]} geoms
 * @param {number} chunkSize world-space grid cell size (metres)
 * @returns {Map<string, THREE.BufferGeometry>} chunkKey ("cx:cz") -> geometry
 */
export function chunkGeometriesByGrid(geoms, chunkSize) {
  const result = new Map();
  if (geoms.length === 0) return result;

  const attrNames = Object.keys(geoms[0].attributes);
  const buckets = new Map(); // chunkKey -> { attrs: { name: number[] }, vertCount }

  const getBucket = (key) => {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { attrs: {}, vertCount: 0 };
      for (const name of attrNames) bucket.attrs[name] = [];
      buckets.set(key, bucket);
    }
    return bucket;
  };

  for (const geom of geoms) {
    const pos = geom.attributes.position;
    const index = geom.index;
    const triCount = index ? index.count / 3 : pos.count / 3;
    const vertIndex = index ? (t) => index.getX(t) : (t) => t;

    for (let t = 0; t < triCount; t += 1) {
      const i0 = vertIndex(t * 3), i1 = vertIndex(t * 3 + 1), i2 = vertIndex(t * 3 + 2);
      const cx = (pos.getX(i0) + pos.getX(i1) + pos.getX(i2)) / 3;
      const cz = (pos.getZ(i0) + pos.getZ(i1) + pos.getZ(i2)) / 3;
      // Underscore, not a colon: GameRuntime's debug sceneStats() tally buckets
      // meshes by stripping a trailing run of [\d\w-] chars off the name, so a
      // key usable directly as a name suffix (e.g. "Road Ribbon -3_2") groups
      // cleanly under "Road Ribbon" instead of one entry per chunk.
      const key = `${Math.floor(cx / chunkSize)}_${Math.floor(cz / chunkSize)}`;
      const bucket = getBucket(key);
      for (const vi of [i0, i1, i2]) {
        for (const name of attrNames) {
          const attr = geom.attributes[name];
          for (let c = 0; c < attr.itemSize; c += 1) bucket.attrs[name].push(attr.getComponent(vi, c));
        }
        bucket.vertCount += 1;
      }
    }
  }

  for (const [key, bucket] of buckets) {
    const g = new THREE.BufferGeometry();
    for (const name of attrNames) {
      const itemSize = geoms[0].attributes[name].itemSize;
      g.setAttribute(name, new THREE.Float32BufferAttribute(bucket.attrs[name], itemSize));
    }
    // Non-indexed (triangle-soup) — index buffers add complexity for no real
    // win here since chunking already dropped shared-vertex indexing.
    result.set(key, g);
  }
  return result;
}
