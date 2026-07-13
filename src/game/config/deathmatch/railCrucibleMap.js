/**
 * Rail Crucible — pure arena descriptor (M0/M1 shared contract).
 *
 * This module is the single source of truth for deathmatch gameplay geometry.
 * The browser (`createDeathmatchArenaLevel.js`) builds render meshes and level
 * colliders from it; the PartyKit server consumes the same spawn/trigger/bounds/
 * occluder data for validation and hitscan. Keeping both sides on one versioned
 * descriptor is what stops the client map and the server hit model from drifting.
 *
 * MUST NOT import Three.js or DOM APIs. Positions are `[x, y, z]` metres; `y` is
 * up. A spawn/pickup `position` is the feet point on that tier's floor.
 *
 * Rough layout (see plan §Rail Crucible arena):
 *   - Lower "service undercroft" floor at y = -4 (teleporter chamber, +50 health).
 *   - Mid "transfer floor" at y = 0 (turntable machinery breaks the centre lane).
 *   - Upper "gantries" at y = 6 (crane bridge, signal room, sentinel overlook).
 */

import { pointInAabb, aabbOverlap } from '../../net/deathmatchGeometry.js';

const HALF_PI = Math.PI / 2;

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

export const RAIL_CRUCIBLE = deepFreeze({
  id: 'rail-crucible-v1',
  revision: 2,
  bounds: { min: [-34, -6, -34], max: [34, 18, 34], killY: -5 },

  // Authored ramps (client builds oriented walkable decks; server uses the
  // matching connector volumes below). Keep spawns clear of these footprints.
  ramps: [
    { id: 'ramp-lower-mid', x: -24, z0: -6, z1: 8, lowY: -4, highY: 0, width: 4 },
    // Starts clear of spawn-m2 (z≈0); lands on east gantry south of the signal room.
    { id: 'ramp-mid-upper', x: 22, z0: 2, z1: 14, lowY: 0, highY: 6, width: 4 },
  ],

  // 12 spawns across three tiers (capacity is 8; extras give the server safe
  // selection headroom). yaw faces roughly toward the arena centre.
  // Mid-edge spawns sit off the ramp shafts so boots are not inside a deck.
  playerSpawns: [
    { id: 'spawn-l1', position: [-22, -4, -22], yaw: Math.PI * 0.25, tier: 'lower', weight: 1 },
    { id: 'spawn-l2', position: [22, -4, -22], yaw: Math.PI * 0.75, tier: 'lower', weight: 1 },
    { id: 'spawn-l3', position: [-22, -4, 22], yaw: -Math.PI * 0.25, tier: 'lower', weight: 1 },
    { id: 'spawn-l4', position: [22, -4, 22], yaw: -Math.PI * 0.75, tier: 'lower', weight: 1 },
    { id: 'spawn-m1', position: [-28, 0, 14], yaw: Math.PI * 0.65, tier: 'mid', weight: 1.2 },
    { id: 'spawn-m2', position: [28, 0, -14], yaw: -Math.PI * 0.35, tier: 'mid', weight: 1.2 },
    { id: 'spawn-m3', position: [0, 0, -24], yaw: Math.PI, tier: 'mid', weight: 1.2 },
    { id: 'spawn-m4', position: [0, 0, 24], yaw: 0, tier: 'mid', weight: 1.2 },
    { id: 'spawn-u1', position: [-20, 6, -20], yaw: Math.PI * 0.25, tier: 'upper', weight: 0.8 },
    { id: 'spawn-u2', position: [20, 6, -20], yaw: Math.PI * 0.75, tier: 'upper', weight: 0.8 },
    { id: 'spawn-u3', position: [-20, 6, 20], yaw: -Math.PI * 0.25, tier: 'upper', weight: 0.8 },
    { id: 'spawn-u4', position: [8, 6, 20], yaw: -Math.PI * 0.75, tier: 'upper', weight: 0.8 },
  ],

  pickupSpawns: [
    // Weapons
    { id: 'pk-shotgun', kind: 'weapon', weaponId: 'tactical-shotgun', position: [10, 0, 10], respawnMs: 20000 },
    { id: 'pk-ar15', kind: 'weapon', weaponId: 'desert-ar15', position: [-14, -4, 10], respawnMs: 25000 },
    { id: 'pk-sentinel', kind: 'weapon', weaponId: 'desert-sentinel', position: [0, 6, -20], respawnMs: 30000 },
    // Ammo (routed away from the matching weapon where practical)
    { id: 'pk-ammo-pistol', kind: 'ammo', ammoType: 'pistol', position: [12, 0, -12], respawnMs: 15000 },
    { id: 'pk-ammo-rifle-a', kind: 'ammo', ammoType: 'rifle', position: [-12, 0, 12], respawnMs: 15000 },
    { id: 'pk-ammo-rifle-b', kind: 'ammo', ammoType: 'rifle', position: [18, 0, 18], respawnMs: 15000 },
    { id: 'pk-ammo-shell', kind: 'ammo', ammoType: 'shell', position: [-18, -4, -18], respawnMs: 15000 },
    { id: 'pk-ammo-sniper', kind: 'ammo', ammoType: 'sniper', position: [20, 6, -18], respawnMs: 15000 },
    // Health
    { id: 'pk-health-a', kind: 'health', healthTier: 'small', position: [-8, 0, 20], respawnMs: 20000 },
    { id: 'pk-health-b', kind: 'health', healthTier: 'small', position: [8, 0, -20], respawnMs: 20000 },
    { id: 'pk-health-c', kind: 'health', healthTier: 'small', position: [-20, -4, 0], respawnMs: 20000 },
    { id: 'pk-health-d', kind: 'health', healthTier: 'small', position: [20, -4, 0], respawnMs: 20000 },
    { id: 'pk-health-mega', kind: 'health', healthTier: 'large', position: [0, -4, -22], respawnMs: 35000 },
  ],

  // Route mechanics. Jump pad launches mid → upper; teleporter lifts the lower
  // chamber back to the mid floor.
  jumpPads: [
    { id: 'jp-mid', bounds: { min: [-12, 0, 8], max: [-8, 0.6, 12] }, velocity: [0, 15, 0] },
  ],
  teleporters: [
    {
      id: 'tp-undercroft',
      bounds: { min: [-2, -4, -24], max: [2, -2, -20] },
      exitPosition: [0, 0, 18],
      exitYaw: 0,
    },
  ],

  // Coarse solids for movement penetration checks (perimeter walls + machinery).
  solidVolumes: [
    { id: 'wall-n', min: [-34, -6, 32], max: [34, 18, 34] },
    { id: 'wall-s', min: [-34, -6, -34], max: [34, 18, -32] },
    { id: 'wall-e', min: [32, -6, -34], max: [34, 18, 34] },
    { id: 'wall-w', min: [-34, -6, -34], max: [-32, 18, 34] },
    { id: 'turntable-machinery', min: [-6, -4, -6], max: [6, 4, 6] },
    { id: 'half-boxcar', min: [8, 0, -3], max: [18, 3, 3] },
    { id: 'signal-room', min: [16, 6, 16], max: [24, 10, 24] },
  ],

  // Where a player capsule may legally be (tier walkable envelopes). Floor meshes
  // are built only from these; connector shafts live in `connectorVolumes`.
  validPlayerVolumes: [
    { id: 'vol-lower', min: [-26, -4, -26], max: [26, -1, 26] },
    { id: 'vol-mid', min: [-30, 0, -30], max: [30, 3, 30] },
    { id: 'vol-upper-n', min: [-24, 6, -24], max: [24, 9, -16] },
    { id: 'vol-upper-s', min: [-24, 6, 16], max: [24, 9, 24] },
    { id: 'vol-upper-e', min: [16, 6, -24], max: [24, 9, 24] },
    { id: 'vol-upper-w', min: [-24, 6, -24], max: [-16, 9, 24] },
    { id: 'vol-bridge', min: [-24, 6, -2], max: [24, 9, 2] },
  ],

  // Non-floor legal envelopes: ramp travel + jump-pad flight so the server does
  // not reject feet between tier slabs or airborne after a pad launch.
  connectorVolumes: [
    { id: 'vol-ramp-lower-mid', min: [-27, -4, -7], max: [-21, 2.2, 9] },
    { id: 'vol-ramp-mid-upper', min: [19, 0, 1], max: [25, 8.2, 15] },
    { id: 'vol-jump-shaft', min: [-14, 0, 6], max: [-6, 14, 14] },
  ],

  // Static blockers for hitscan occlusion. The turntable machinery deliberately
  // breaks the central floor into a non-hitscan lane when viewed from above.
  shotOccluders: [
    { id: 'occ-turntable', min: [-6, -4, -6], max: [6, 4, 6] },
    { id: 'occ-boxcar', min: [8, 0, -3], max: [18, 3, 3] },
    { id: 'occ-signal-room', min: [16, 6, 16], max: [24, 10, 24] },
    { id: 'occ-crane-bridge', min: [-24, 9, -1.5], max: [24, 11, 1.5] },
    { id: 'occ-wall-n', min: [-34, -6, 32], max: [34, 18, 34] },
    { id: 'occ-wall-s', min: [-34, -6, -34], max: [34, 18, -32] },
    { id: 'occ-wall-e', min: [32, -6, -34], max: [34, 18, 34] },
    { id: 'occ-wall-w', min: [-34, -6, -34], max: [-32, 18, 34] },
  ],
});

/** Look up a player spawn by id. */
export function getSpawnById(id) {
  return RAIL_CRUCIBLE.playerSpawns.find((s) => s.id === id) ?? null;
}

/** Look up a pickup spawn by id. */
export function getPickupById(id) {
  return RAIL_CRUCIBLE.pickupSpawns.find((p) => p.id === id) ?? null;
}

/** True when a point is within the arena bounds box. */
export function isInsideBounds(p) {
  return pointInAabb(p, RAIL_CRUCIBLE.bounds.min, RAIL_CRUCIBLE.bounds.max);
}

/** True when a point has fallen below the kill plane. */
export function isBelowKillPlane(p) {
  return p[1] < RAIL_CRUCIBLE.bounds.killY;
}

/** True when a point lies inside any legal player volume or connector shaft. */
export function isInsideValidVolume(p) {
  if (RAIL_CRUCIBLE.validPlayerVolumes.some((v) => pointInAabb(p, v.min, v.max))) return true;
  return (RAIL_CRUCIBLE.connectorVolumes ?? []).some((v) => pointInAabb(p, v.min, v.max));
}

/**
 * Floor cutouts for a tier slab at `floorY`. Opens the approach shaft so a
 * higher deck does not seal over the climb, while leaving a landing lip at the
 * high end of the ramp.
 * @param {number} floorY
 * @returns {{ minX: number, maxX: number, minZ: number, maxZ: number }[]}
 */
export function getRampFloorCutouts(floorY) {
  const out = [];
  for (const r of RAIL_CRUCIBLE.ramps ?? []) {
    // Only floors the ramp climbs up to (or through) need openings.
    if (!(floorY > r.lowY + 0.25 && floorY <= r.highY + 0.05)) continue;
    const half = r.width * 0.5 + 0.35;
    const zLo = Math.min(r.z0, r.z1);
    const zHi = Math.max(r.z0, r.z1);
    // Keep a short landing lip only where the ramp surface is already within a
    // step of the floor — any larger lip seals the climb from below.
    const clearUntilY = floorY - 0.5;
    const tClear = Math.max(0.55, Math.min(0.94, (clearUntilY - r.lowY) / Math.max(0.01, r.highY - r.lowY)));
    const zAt = (t) => r.z0 + t * (r.z1 - r.z0);
    const approachEnd = Math.max(zAt(tClear), zAt(0.55));
    // approachEnd is along the ramp direction; normalise to min/max Z.
    const cutZ0 = Math.min(zLo - 0.35, approachEnd);
    const cutZ1 = Math.max(zLo - 0.35, approachEnd);
    out.push({
      minX: r.x - half,
      maxX: r.x + half,
      minZ: cutZ0,
      maxZ: cutZ1 + 0.2,
    });
  }
  return out;
}

/** True when a point lies inside any coarse solid. */
export function isInsideSolid(p) {
  return RAIL_CRUCIBLE.solidVolumes.some((v) => pointInAabb(p, v.min, v.max));
}

/** True when an AABB overlaps any coarse solid (capsule-vs-solid coarse test). */
export function overlapsSolid(min, max) {
  return RAIL_CRUCIBLE.solidVolumes.some((v) => aabbOverlap(min, max, v.min, v.max));
}

/** The trigger volume the point is inside, if any (jump pad or teleporter). */
export function findTriggerAt(p) {
  for (const pad of RAIL_CRUCIBLE.jumpPads) {
    if (pointInAabb(p, pad.bounds.min, pad.bounds.max)) return { type: 'jumpPad', trigger: pad };
  }
  for (const tp of RAIL_CRUCIBLE.teleporters) {
    if (pointInAabb(p, tp.bounds.min, tp.bounds.max)) return { type: 'teleporter', trigger: tp };
  }
  return null;
}
