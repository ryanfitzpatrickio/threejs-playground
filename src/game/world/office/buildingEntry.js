// buildingEntry.js — pure geometry for "walk up to any building and enter".
//
// City buildings are axis-aligned collider AABBs
// ({ minX, maxX, minZ, maxZ, topY, bottomY, name }). These helpers pick the
// nearest enterable building near the player and synthesise a door on the facade
// facing them — no pre-placed door metadata required (see
// docs/office-interior-wfc-plan.md). Pure + deterministic so the door math is
// node-testable (verify:office-entry); the runtime BuildingEntrySystem gathers
// candidate colliders (via the spatial index) and feeds them in.

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Horizontal distance from a point to an AABB (0 when the point is inside it). */
export function distanceToAabbXZ(position, b) {
  const dx = Math.max(b.minX - position.x, 0, position.x - b.maxX);
  const dz = Math.max(b.minZ - position.z, 0, position.z - b.maxZ);
  return Math.hypot(dx, dz);
}

/** A collider is treated as an enterable building if it is a big-enough box. */
export function isEnterableBuilding(b, { minFootprint = 6, minHeight = 8 } = {}) {
  if (!b) return false;
  if (![b.minX, b.maxX, b.minZ, b.maxZ, b.topY, b.bottomY].every(Number.isFinite)) return false;
  const width = b.maxX - b.minX;
  const depth = b.maxZ - b.minZ;
  const height = b.topY - b.bottomY;
  return width >= minFootprint && depth >= minFootprint && height >= minHeight;
}

/**
 * Nearest enterable building whose footprint is within `range` metres of the
 * player (edge distance, so standing against a wall reads as 0). Returns
 * `{ building, distance }` or null.
 */
export function findNearestEnterableBuilding({
  colliders = [],
  position,
  range = 6,
  minFootprint = 6,
  minHeight = 8,
}) {
  let best = null;
  let bestDist = range;
  for (const b of colliders) {
    if (!isEnterableBuilding(b, { minFootprint, minHeight })) continue;
    const dist = distanceToAabbXZ(position, b);
    if (dist <= bestDist) {
      bestDist = dist;
      best = b;
    }
  }
  return best ? { building: best, distance: bestDist } : null;
}

/**
 * Door on the facade of `building` nearest the player: the player's XZ projected
 * onto that face (clamped to the facade span, with `edgeMargin` kept off the
 * corners), at `groundY` (falls back to the building base). Returns the facade
 * id, the door `anchor`, and inward/outward unit normals.
 */
export function computeDoorAnchor({ building: b, position, groundY = null, edgeMargin = 1.2 }) {
  const cx = clamp(position.x, b.minX, b.maxX);
  const cz = clamp(position.z, b.minZ, b.maxZ);
  const faces = [
    { facade: 'NX', dist: Math.abs(position.x - b.minX), point: { x: b.minX, z: cz }, inward: { x: 1, z: 0 } },
    { facade: 'PX', dist: Math.abs(position.x - b.maxX), point: { x: b.maxX, z: cz }, inward: { x: -1, z: 0 } },
    { facade: 'NZ', dist: Math.abs(position.z - b.minZ), point: { x: cx, z: b.minZ }, inward: { x: 0, z: 1 } },
    { facade: 'PZ', dist: Math.abs(position.z - b.maxZ), point: { x: cx, z: b.maxZ }, inward: { x: 0, z: -1 } },
  ];
  const best = faces.reduce((a, c) => (c.dist < a.dist ? c : a));

  // Keep the door off the corners: clamp the free axis into the facade span.
  const point = { x: best.point.x, z: best.point.z };
  if (best.facade === 'NX' || best.facade === 'PX') {
    point.z = clamp(point.z, b.minZ + edgeMargin, b.maxZ - edgeMargin);
  } else {
    point.x = clamp(point.x, b.minX + edgeMargin, b.maxX - edgeMargin);
  }

  const anchorY = Number.isFinite(groundY) ? groundY : b.bottomY;
  return {
    facade: best.facade,
    anchor: { x: point.x, y: anchorY, z: point.z },
    inwardNormal: { x: best.inward.x, z: best.inward.z },
    outwardNormal: { x: -best.inward.x, z: -best.inward.z },
    footprint: { width: b.maxX - b.minX, depth: b.maxZ - b.minZ },
  };
}

/**
 * Whether the player is facing the building enough to show an enter prompt.
 * `facingXZ` is the player's (or camera's) forward as {x,z}; the prompt shows
 * when it points roughly along the door's inward normal.
 */
export function isFacingDoor(facingXZ, inwardNormal, minDot = 0.2) {
  const len = Math.hypot(facingXZ.x, facingXZ.z);
  if (len < 1e-5) return false;
  const dot = (facingXZ.x * inwardNormal.x + facingXZ.z * inwardNormal.z) / len;
  return dot >= minDot;
}
