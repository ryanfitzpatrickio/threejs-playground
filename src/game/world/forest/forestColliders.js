const TRUNK_HALF = 0.25;
const DEFAULT_TRUNK_HEIGHT = 12;
const ROAD_CLEARANCE_M = 30;

export function placementToTrunkCollider(p, index = 0, {
  trunkHeight = DEFAULT_TRUNK_HEIGHT,
} = {}) {
  const h = trunkHeight * (p.scale ?? 1);
  const bottomY = p.y;
  return {
    name: `Forest Trunk ${index}`,
    role: 'prop',
    vaultable: false,
    minX: p.x - TRUNK_HALF,
    maxX: p.x + TRUNK_HALF,
    minZ: p.z - TRUNK_HALF,
    maxZ: p.z + TRUNK_HALF,
    bottomY,
    topY: bottomY + h,
  };
}

/**
 * Static cuboid trunk colliders for trees near the rally line (M5).
 * Walls only — never treated as ground.
 */
export function buildForestTrunkColliders(placements, {
  findNearestRoadPoint = null,
  maxRoadDistance = ROAD_CLEARANCE_M,
  trunkHeight = DEFAULT_TRUNK_HEIGHT,
} = {}) {
  if (!findNearestRoadPoint || !placements?.length) {
    return { colliders: [], staticPlacementIndices: new Set() };
  }

  const colliders = [];
  const staticPlacementIndices = new Set();
  for (let i = 0; i < placements.length; i += 1) {
    const p = placements[i];
    const road = findNearestRoadPoint(p.x, p.z, { maxDistance: maxRoadDistance });
    if (!road || road.distance > maxRoadDistance) continue;
    staticPlacementIndices.add(i);
    colliders.push(placementToTrunkCollider(p, i, { trunkHeight }));
  }
  return { colliders, staticPlacementIndices };
}
