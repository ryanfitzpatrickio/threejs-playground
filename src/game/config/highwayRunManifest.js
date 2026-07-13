/**
 * Matrix Highway run manifest (M0–M6).
 *
 * Longitudinal coordinate `s` is positive distance along the highway (world −Z).
 * Convert with helpers below — do not scatter sign flips through callers.
 *
 * M6: traffic cruises at FLOW_SPEED + dSpeed (m/s). Negative dSpeed is a
 * catch-up target; positive pulls ahead. Window front is sized for headroom.
 */

/** Number of travel lanes (excluding shoulders). */
export const LANE_COUNT = 5;

/** Nominal lane width in metres. */
export const LANE_WIDTH = 3.5;

/** Shoulder width on each side of the lane strip (metres). */
export const SHOULDER_WIDTH = 2.5;

/**
 * World X of each lane centre, index 0..LANE_COUNT-1.
 * Matches plan example: [-7, -3.5, 0, 3.5, 7].
 */
export const LANES = Object.freeze(
  Array.from({ length: LANE_COUNT }, (_, i) => (i - (LANE_COUNT - 1) / 2) * LANE_WIDTH),
);

/** Half-width of the asphalt ribbon including shoulders. */
export const ROAD_HALF_WIDTH = (LANE_COUNT * LANE_WIDTH) * 0.5 + SHOULDER_WIDTH;

/** Road-top height (elevated ribbon). */
export const HIGHWAY_Y = 12;

/** World-Z of s = 0 (spawn reference). Highway runs toward world −Z. */
export const HIGHWAY_ORIGIN_Z = 0;

/**
 * Half-length of the fixed physics road slab along Z, centred on origin.
 * Generous for a prototype session; increase here if testing hits the end.
 */
export const HIGHWAY_PHYSICAL_HALF_LENGTH = 2000;

/** Visual asphalt segment length (metres). */
export const ROAD_SEGMENT_LENGTH = 40;

/** How many visual segments treadmill around the focus. */
export const ROAD_SEGMENT_COUNT = 12;

/** Authored tile length along s (metres). Tiles repeat for infinite traffic. */
export const RUN_LENGTH = 400;

/** Baseline convoy speed (m/s, ~80 km/h). World velocity is along −Z. */
export const FLOW_SPEED = 22;

/**
 * Live traffic window ahead of focus along +s (metres).
 * Oversized vs catch-up headroom so targets appear before leap range.
 */
export const WINDOW_FRONT = 420;

/** Live traffic window behind focus along −s (metres). */
export const WINDOW_BACK = 180;

/**
 * Explicit spare/hijack headroom per archetype after exact max live demand.
 * Plan O1 gate: exact demand (18) + spare ≤ 22 for current manifest/window.
 */
export const POOL_SPARE_PER_ARCHETYPE = 4;

/** Default run seed (stable across boots unless overridden). */
export const DEFAULT_HIGHWAY_SEED = 0x4d485730; // 'MHW0'

/**
 * One tile of the run. `s` is offset within the tile (0 ≤ s < RUN_LENGTH).
 * dSpeed is relative to FLOW_SPEED (negative = catch-up target).
 * `type` selects the per-archetype pool + TSL shell (sedan | semi).
 * Semi `len` is cab+trailer footprint for spacing; physics is articulated
 * (cab BaseVehicle + trailer body + fifth-wheel joint — HighwaySemiRig).
 */
export const runPlatforms = Object.freeze([
  Object.freeze({ s: 30, lane: 1, type: 'sedan', len: 4.5, dSpeed: 0 }),
  Object.freeze({ s: 55, lane: 3, type: 'semi', len: 16.5, dSpeed: -1 }),
  Object.freeze({ s: 90, lane: 0, type: 'sedan', len: 4.5, dSpeed: 0 }),
  Object.freeze({ s: 120, lane: 2, type: 'sedan', len: 4.5, dSpeed: 1 }),
  Object.freeze({ s: 155, lane: 4, type: 'semi', len: 16.5, dSpeed: 0 }),
  Object.freeze({ s: 190, lane: 1, type: 'sedan', len: 4.5, dSpeed: 0 }),
  Object.freeze({ s: 225, lane: 3, type: 'sedan', len: 4.5, dSpeed: -3 }),
  Object.freeze({ s: 260, lane: 0, type: 'semi', len: 16.5, dSpeed: 1 }),
  Object.freeze({ s: 295, lane: 2, type: 'sedan', len: 4.5, dSpeed: 2 }),
  Object.freeze({ s: 330, lane: 4, type: 'sedan', len: 4.5, dSpeed: 0 }),
  Object.freeze({ s: 365, lane: 1, type: 'sedan', len: 4.5, dSpeed: -2 }),
]);

/** Archetypes that get a pre-created traffic pool + TSL shell. */
export const TRAFFIC_ARCHETYPES = Object.freeze(['sedan', 'semi']);

/**
 * Physics body footprint [width, height, length] per traffic archetype.
 * Semi is the tractor cab only — trailer is a second body (HighwaySemiRig).
 */
export const TRAFFIC_BODY_SIZE = Object.freeze({
  sedan: Object.freeze([2.0, 0.9, 4.2]),
  semi: Object.freeze([2.55, 1.85, 4.4]),
});

/** Simple body colours for visual variety (hex). */
export const TRAFFIC_COLORS = Object.freeze([
  0x3a4a5c,
  0x8a3030,
  0x2e5a3a,
  0xc4a84a,
  0x2a2a2e,
  0x4a6a8a,
  0x6a4a2a,
  0xb0b4b8,
]);

/** Player car spawn lane (centre-right of pack; clear of early traffic). */
export const PLAYER_SPAWN_LANE = 2;

/** Player car longitudinal s at boot (well clear of first traffic at s=40). */
export const PLAYER_SPAWN_S = 12;

// ── Coordinate helpers ──────────────────────────────────────────────────────

/** Longitudinal progress from a world position (or raw z). */
export function worldZToS(zOrPosition) {
  const z = typeof zOrPosition === 'number' ? zOrPosition : zOrPosition?.z;
  return HIGHWAY_ORIGIN_Z - (Number.isFinite(z) ? z : 0);
}

/** World Z from positive longitudinal s. */
export function sToWorldZ(s) {
  return HIGHWAY_ORIGIN_Z - s;
}

/** World X of a lane index (clamped). */
export function laneWorldX(laneIndex) {
  const i = Math.max(0, Math.min(LANE_COUNT - 1, laneIndex | 0));
  return LANES[i];
}

/** Stable slot identity: never key by post-variation array order. */
export function makeSlotId(tileIndex, entryIndex) {
  return `${tileIndex | 0}:${entryIndex | 0}`;
}

/** Parse `tileIndex:entryIndex` → { tileIndex, entryIndex } or null. */
export function parseSlotId(slotId) {
  if (typeof slotId !== 'string') return null;
  const parts = slotId.split(':');
  if (parts.length !== 2) return null;
  const tileIndex = Number(parts[0]);
  const entryIndex = Number(parts[1]);
  if (!Number.isInteger(tileIndex) || !Number.isInteger(entryIndex)) return null;
  return { tileIndex, entryIndex };
}

/**
 * Deterministic mulberry32 PRNG.
 * @param {number} seed
 * @returns {() => number} ∈ [0, 1)
 */
export function createHighwayRng(seed = DEFAULT_HIGHWAY_SEED) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mix global seed with tile index for per-tile variation. */
export function tileSeed(globalSeed, tileIndex) {
  const g = (globalSeed >>> 0) || 1;
  const k = tileIndex | 0;
  // simple 32-bit mix — independent of draw order beyond the mulberry stream
  return (Math.imul(g ^ (k * 0x9e3779b9), 0x85ebca6b) >>> 0) || 1;
}

/**
 * Resolve desired traffic slots overlapping [focusS - windowBack, focusS + windowFront].
 * Returns descriptors sorted by s then lane, with stable `id` keys.
 *
 * @param {{ focusS: number, seed?: number, windowFront?: number, windowBack?: number, platforms?: readonly object[] }} opts
 */
export function resolveWindowSlots({
  focusS,
  seed = DEFAULT_HIGHWAY_SEED,
  windowFront = WINDOW_FRONT,
  windowBack = WINDOW_BACK,
  platforms = runPlatforms,
} = {}) {
  const minS = focusS - windowBack;
  const maxS = focusS + windowFront;
  const firstTile = Math.floor(minS / RUN_LENGTH);
  const lastTile = Math.floor(maxS / RUN_LENGTH);
  const slots = [];

  for (let tileIndex = firstTile; tileIndex <= lastTile; tileIndex += 1) {
    const rng = createHighwayRng(tileSeed(seed, tileIndex));
    for (let entryIndex = 0; entryIndex < platforms.length; entryIndex += 1) {
      const entry = platforms[entryIndex];
      // Consume one draw per entry so future per-entry variation stays stable.
      const colorRoll = rng();
      const s = tileIndex * RUN_LENGTH + entry.s;
      if (s < minS || s > maxS) continue;

      const colorIndex = Math.floor(colorRoll * TRAFFIC_COLORS.length) % TRAFFIC_COLORS.length;
      slots.push({
        id: makeSlotId(tileIndex, entryIndex),
        tileIndex,
        entryIndex,
        s,
        lane: entry.lane,
        type: entry.type,
        len: entry.len,
        dSpeed: entry.dSpeed ?? 0,
        colorIndex,
        worldX: laneWorldX(entry.lane),
        worldZ: sToWorldZ(s),
        worldY: HIGHWAY_Y,
      });
    }
  }

  slots.sort((a, b) => (a.s - b.s) || (a.lane - b.lane) || a.id.localeCompare(b.id));
  return slots;
}

/**
 * Exact maximum simultaneous slots for the configured window.
 * Samples focus positions at every platform enter/exit event across a few tiles
 * so the pool matches authored demand instead of whole-tile overestimation.
 *
 * Pass `type` to count only that archetype (for per-pool sizing).
 */
export function estimateMaxLiveSlots({
  windowFront = WINDOW_FRONT,
  windowBack = WINDOW_BACK,
  platforms = runPlatforms,
  type = null,
} = {}) {
  const entries = type
    ? platforms.filter((p) => (p.type ?? 'sedan') === type)
    : platforms;
  if (!entries.length) return 0;
  const front = Math.max(0, windowFront);
  const back = Math.max(0, windowBack);

  // Focus values where a platform crosses the front or back window edge.
  const focusSamples = [0, RUN_LENGTH * 0.5];
  for (let tile = -2; tile <= 3; tile += 1) {
    for (const p of entries) {
      const absS = tile * RUN_LENGTH + p.s;
      focusSamples.push(absS - front);
      focusSamples.push(absS + back);
    }
  }

  let maxCount = 0;
  for (const focusS of focusSamples) {
    let count = 0;
    const minS = focusS - back;
    const maxS = focusS + front;
    const firstTile = Math.floor(minS / RUN_LENGTH) - 1;
    const lastTile = Math.floor(maxS / RUN_LENGTH) + 1;
    for (let tileIndex = firstTile; tileIndex <= lastTile; tileIndex += 1) {
      for (const entry of entries) {
        const s = tileIndex * RUN_LENGTH + entry.s;
        if (s >= minS && s <= maxS) count += 1;
      }
    }
    if (count > maxCount) maxCount = count;
  }
  return maxCount;
}

/**
 * Pool size for one archetype: exact max live + named spare/hijack budget.
 * Prefer `type: 'sedan' | 'semi'` so mixed fleets do not over-create pools.
 */
export function poolSizeForArchetype(options = {}) {
  return estimateMaxLiveSlots(options) + (options.spare ?? POOL_SPARE_PER_ARCHETYPE);
}

/** Sum of per-archetype pool sizes (total BaseVehicle count on the highway). */
export function totalTrafficPoolSize(options = {}) {
  return TRAFFIC_ARCHETYPES.reduce(
    (sum, type) => sum + poolSizeForArchetype({ ...options, type }),
    0,
  );
}

/**
 * Physical AABB of the fixed road slab (for snapshots / debug).
 */
export function physicalRoadBounds() {
  return {
    minX: -ROAD_HALF_WIDTH,
    maxX: ROAD_HALF_WIDTH,
    minZ: HIGHWAY_ORIGIN_Z - HIGHWAY_PHYSICAL_HALF_LENGTH,
    maxZ: HIGHWAY_ORIGIN_Z + HIGHWAY_PHYSICAL_HALF_LENGTH,
    y: HIGHWAY_Y,
    halfLength: HIGHWAY_PHYSICAL_HALF_LENGTH,
    halfWidth: ROAD_HALF_WIDTH,
  };
}

/**
 * Whether a world XZ sample (optionally expanded by radius) sits on the ribbon.
 */
export function isInsideRoad(position, radius = 0) {
  const x = position?.x ?? 0;
  const z = position?.z ?? 0;
  const r = Number.isFinite(radius) ? Math.max(0, radius) : 0;
  const bounds = physicalRoadBounds();
  return (
    x + r >= bounds.minX
    && x - r <= bounds.maxX
    && z + r >= bounds.minZ
    && z - r <= bounds.maxZ
  );
}

/**
 * Absolute cruise speed (m/s) for a manifest dSpeed.
 * @param {number} [dSpeed=0]
 */
export function cruiseSpeedForDSpeed(dSpeed = 0) {
  const d = Number.isFinite(dSpeed) ? dSpeed : 0;
  return Math.max(0, FLOW_SPEED + d);
}

/**
 * World-space linear velocity for highway cruise (+s is world −Z).
 * @param {number} [dSpeed=0]
 */
export function cruiseWorldVelocity(dSpeed = 0) {
  const speed = cruiseSpeedForDSpeed(dSpeed);
  return { x: 0, y: 0, z: -speed };
}

/** Player vehicle spawn world position (on road top; VehicleSystem snaps ride height). */
export function playerVehicleSpawnPosition() {
  return {
    x: laneWorldX(PLAYER_SPAWN_LANE),
    y: HIGHWAY_Y,
    z: sToWorldZ(PLAYER_SPAWN_S),
  };
}

/** Character spawn beside the player car (driver-side shoulder of the spawn lane). */
export function playerCharacterSpawnPosition() {
  const car = playerVehicleSpawnPosition();
  return {
    x: car.x - LANE_WIDTH * 0.55,
    y: HIGHWAY_Y,
    z: car.z + 1.2,
  };
}
