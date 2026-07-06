import { placementToTrunkCollider } from './forestColliders.js';
import { buildForestSpatialIndex, queryForestSpatialIndex } from './forestSpatialIndex.js';

const DEFAULT_POOL_SIZE = 20;
const DEFAULT_RADIUS = 32;
const CELL_SIZE = 10;
const UPDATE_INTERVAL_MS = 120;
const MOVE_THRESHOLD_SQ = 16;

/**
 * Small recycled trunk-collider pool that follows the vehicle off-road (M7 stretch).
 * Road-adjacent trunks stay in the static level.colliders set from M5.
 */
export function createForestOffRoadPool(placements, {
  staticPlacementIndices = new Set(),
  poolSize = DEFAULT_POOL_SIZE,
  radius = DEFAULT_RADIUS,
} = {}) {
  if (!placements?.length) {
    return {
      update() {},
      dispose() {},
      snapshot: () => ({ forestOffRoadPool: 0 }),
    };
  }

  const grid = buildForestSpatialIndex(placements, { cellSize: CELL_SIZE });
  const slots = new Array(poolSize).fill(-1);
  const _lastPos = { x: 1e9, z: 0 };
  let lastUpdateAt = 0;
  let activeCount = 0;

  const ownerKey = (slot) => `forest:offroad:${slot}`;

  const applySlot = (physics, slot, placementIndex) => {
    const key = ownerKey(slot);
    physics.removeStaticBodiesForOwner(key);
    if (placementIndex < 0) return;
    const collider = placementToTrunkCollider(placements[placementIndex], placementIndex);
    physics.createStaticCollider(collider, key);
  };

  return {
    update(position, physics) {
      if (!physics || !position) return;
      const now = performance.now();
      const dx = position.x - _lastPos.x;
      const dz = position.z - _lastPos.z;
      if (
        now - lastUpdateAt < UPDATE_INTERVAL_MS
        && dx * dx + dz * dz < MOVE_THRESHOLD_SQ
      ) {
        return;
      }
      lastUpdateAt = now;
      _lastPos.x = position.x;
      _lastPos.z = position.z;

      const nearby = queryForestSpatialIndex(grid, position.x, position.z, radius, { withDistance: true });
      nearby.sort((a, b) => a.distSq - b.distSq);
      const chosen = [];
      for (let i = 0; i < nearby.length && chosen.length < poolSize; i += 1) {
        const { index } = nearby[i];
        if (staticPlacementIndices.has(index)) continue;
        chosen.push(index);
      }

      activeCount = chosen.length;
      for (let slot = 0; slot < poolSize; slot += 1) {
        const next = slot < chosen.length ? chosen[slot] : -1;
        if (slots[slot] === next) continue;
        slots[slot] = next;
        applySlot(physics, slot, next);
      }
    },

    dispose(physics) {
      for (let slot = 0; slot < poolSize; slot += 1) {
        physics?.removeStaticBodiesForOwner?.(ownerKey(slot));
        slots[slot] = -1;
      }
      activeCount = 0;
    },

    snapshot: () => ({ forestOffRoadPool: activeCount }),
  };
}
