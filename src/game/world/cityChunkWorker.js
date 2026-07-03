import {
  buildSkeletonColliderData,
  collectGeneratorCityChunkTransferables,
  createGeneratorCityLevel,
  serializeGeneratorCityChunk,
} from './createGeneratorCityLevel.js';
import { extractCityTraversal } from './extractCityTraversal.js';

// Trimesh collider data (expensive per-building vertex transform + triangle
// filtering) is created inside createGeneratorCityLevel and never touches
// the main thread during streaming attach.

self.onmessage = (event) => {
  const { id, type = 'build', options, chunkKey, buildings } = event.data ?? {};

  try {
    if (type === 'extractTraversal') {
      const traversal = extractCityTraversal({ buildings: buildings ?? [] });
      self.postMessage({ id, type: 'traversal', chunkKey, traversal });
      return;
    }

    // Phase 1 — fast skeleton: pure layout math, no geometry.
    // Posting this before the heavy city.build() call means the main thread can
    // register box colliders and show placeholder meshes while the worker is still
    // generating geometry, so swinging into an unloaded chunk feels solid immediately.
    const skeleton = buildSkeletonColliderData(options ?? {});
    self.postMessage({
      id,
      type: 'skeleton',
      colliders: skeleton.colliders,
      layout: skeleton.layout,
      floorW: skeleton.floorW,
      floorD: skeleton.floorD,
      originX: options?.originX ?? 0,
      originZ: options?.originZ ?? 0,
      chunkKey: options?.chunkKey,
      chunkX: options?.chunkX ?? 0,
      chunkZ: options?.chunkZ ?? 0,
      cityStyle: options?.cityStyle ?? 'downtown',
      cityZone: options?.cityZone ?? null,
    });

    // Phase 2 — full chunk: geometry + trimesh colliders.
    const chunk = createGeneratorCityLevel({
      ...options,
      includeDebugOverlay: false,
    });
    const payload = serializeGeneratorCityChunk(chunk);
    const transferables = collectGeneratorCityChunkTransferables(payload);
    chunk.dispose?.();
    self.postMessage({ id, type: 'complete', payload }, transferables);
  } catch (error) {
    self.postMessage({
      id,
      error: {
        message: error?.message ?? String(error),
        stack: error?.stack ?? null,
      },
    });
  }
};
