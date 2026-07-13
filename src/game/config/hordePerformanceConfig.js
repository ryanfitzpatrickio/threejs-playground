// Horde scaling budgets.
//   M1–M4: 250 default / 24 full
//   M5: 750 stretch (sectors + GPU walk)
//   M6: spectacle presets 1k/1.5k + 2k debug ceiling; default gameplay stays 250

/** Shipped gameplay gate — combat readability over raw count. */
export const HORDE_DEFAULT_ENEMY_COUNT = 250;
/** M5 stretch gate — sector culling + amortized sim. */
export const HORDE_STRETCH_ENEMY_COUNT = 750;
/** M6 spectacle gate — dense but still a readable spear tip. */
export const HORDE_SPECTACLE_ENEMY_COUNT = 1000;
/** M6 heavy spectacle — stress preset for knee-finding. */
export const HORDE_SPECTACLE_HEAVY_COUNT = 1500;
/** Absolute debug/benchmark ceiling (not a shipped default). */
export const HORDE_BENCHMARK_MAX_COUNT = 2000;
/**
 * Active hard cap for clamp / spawn / proxy capacity allocation.
 * Renderer hosts up to the benchmark ceiling; gameplay defaults still spawn 250.
 */
export const HORDE_MAX_ENEMY_COUNT = HORDE_BENCHMARK_MAX_COUNT;

export const HORDE_FULL_ACTOR_LIMIT = 24;
/** Closest/most-dangerous full actors allowed to submit into shadow maps. */
export const HORDE_FULL_SHADOW_CASTER_LIMIT = 6;
export const HORDE_IMMEDIATE_SPAWN_LIMIT = 18;
export const HORDE_INITIAL_SPAWN_BURST = 12;
export const HORDE_SPAWN_BATCH_PER_FRAME = 24;
export const HORDE_FULL_SPAWN_BATCH_PER_FRAME = 2;
export const HORDE_PROXY_TICK_STEP = 1 / 12;
export const HORDE_PROXY_PROMOTION_RADIUS = 18;
/** Demotion uses a larger radius so actors near the promote band are not thrashing. */
export const HORDE_PROXY_DEMOTION_RADIUS = 28;
export const HORDE_PROXY_PROMOTIONS_PER_TICK = 2;
export const HORDE_PROXY_DEMOTIONS_PER_TICK = 2;
/** Minimum time a full actor must stay promoted before it may demote (seconds). */
export const HORDE_FULL_ACTOR_MIN_RESIDENCE = 0.75;
/** Shorter residence when a proxy must steal a full slot for a direct hit. */
export const HORDE_EMERGENCY_MIN_RESIDENCE = 0.2;
/** Max vertices for a baked proxy pose before falling back to low-poly buckets. */
export const HORDE_PROXY_VERTEX_LIMIT = 18_000;
/** Lightweight corpse lifetime (seconds) when a proxy dies without full promotion. */
export const HORDE_PROXY_CORPSE_LIFETIME = 2.4;

// ── M4 combat / death budgets ────────────────────────────────────────────────
/** Simultaneous full-actor attackers (attack tokens), separate from Tier A cap. */
export const HORDE_ATTACK_TOKEN_LIMIT = 4;
/** Max articulated skinned ragdolls (rigRagdoll props) alive at once in Horde. */
export const HORDE_MAX_DETAILED_RAGDOLLS = 8;
/**
 * When a mass explosion / area kill fires, only this many nearest targets may
 * promote or spawn a detailed ragdoll; the rest use instanced fallen corpses.
 */
export const HORDE_EXPLOSION_MAX_DETAILED = 4;
/** Default explosion radius used by debug / grenade-style mass kills (metres). */
export const HORDE_EXPLOSION_DEFAULT_RADIUS = 6.5;
/** Cell size for proxy combat spatial queries (hit candidates + explosions). */
export const HORDE_COMBAT_GRID_CELL = 2.0;

// ── M5 sector / GPU animation ────────────────────────────────────────────────
/** Arena sectors per axis (NxN). Each sector owns InstancedMesh draws per archetype. */
export const HORDE_SECTOR_GRID = 4;
/** Headroom fraction per sector so migration imbalance does not overflow. */
export const HORDE_SECTOR_CAPACITY_SLACK = 0.35;
/** GPU walk cycle rate (cycles/second) for advance anim family. */
export const HORDE_GPU_WALK_CPS = 1.35;
/** Instance attribute upload amortization: max dirty anim slots written per tick. */
export const HORDE_ANIM_ATTR_UPLOAD_BUDGET = 96;
/** Default arena half-extent used when level bounds are unavailable. */
export const HORDE_DEFAULT_ARENA_HALF = 36;

// ── M3 suppression / pushback ────────────────────────────────────────────────
/**
 * Suppression deposited per point of combat damage. Tuned with the field decay
 * (~1.6/s) + W_suppress (1.7) so a SUSTAINED stream on the front builds a wall
 * the tip recoils from, while a couple of stray shots fade before they bite.
 */
export const HORDE_SUPPRESSION_PER_DAMAGE = 0.9;
/** Base physics knockback impulse (m/s) on any full-actor tip hit. */
export const HORDE_KNOCKBACK_BASE = 3.0;
/** Extra knockback per point of damage, added on top of the base. */
export const HORDE_KNOCKBACK_PER_DAMAGE = 0.12;
/** Cap on the damage-scaled knockback so a big hit can't launch an actor. */
export const HORDE_KNOCKBACK_DAMAGE_CAP = 4.0;

/**
 * Quality-derived budgets. Desktop default keeps stretch available;
 * lower presets reduce proxy capacity and sector density.
 */
export const HORDE_QUALITY_PRESETS = Object.freeze({
  low: Object.freeze({
    maxEnemyCount: 180,
    fullActorLimit: 12,
    sectorGrid: 3,
    proxyTickHz: 10,
    gpuWalk: false,
    fogDensity: 0.012,
  }),
  medium: Object.freeze({
    maxEnemyCount: HORDE_DEFAULT_ENEMY_COUNT,
    fullActorLimit: 18,
    sectorGrid: 4,
    proxyTickHz: 12,
    gpuWalk: true,
    fogDensity: 0.008,
  }),
  high: Object.freeze({
    maxEnemyCount: HORDE_STRETCH_ENEMY_COUNT,
    fullActorLimit: HORDE_FULL_ACTOR_LIMIT,
    sectorGrid: HORDE_SECTOR_GRID,
    proxyTickHz: 12,
    gpuWalk: true,
    fogDensity: 0.006,
  }),
  spectacle: Object.freeze({
    maxEnemyCount: HORDE_SPECTACLE_ENEMY_COUNT,
    fullActorLimit: HORDE_FULL_ACTOR_LIMIT,
    sectorGrid: 5,
    proxyTickHz: 12,
    gpuWalk: true,
    fogDensity: 0.0075,
  }),
});

/**
 * M6 named density presets for debug fill / knee-finding.
 * `default` is the shipped readable gate; higher tiers are opt-in.
 */
export const HORDE_SPECTACLE_PRESETS = Object.freeze({
  default: Object.freeze({
    id: 'default',
    label: 'Default (250)',
    count: HORDE_DEFAULT_ENEMY_COUNT,
    fullActorLimit: HORDE_FULL_ACTOR_LIMIT,
    attackTokens: HORDE_ATTACK_TOKEN_LIMIT,
    sectorGrid: HORDE_SECTOR_GRID,
    /** Flock readability — slightly looser pack, clearer tip. */
    flock: Object.freeze({
      separationDistance: 1.35,
      neighborRadius: 3.1,
      attackRadius: 4.6,
      congestionFull: 14,
      congestionFloor: 0.5,
      cohesion: 0.2,
      separate: 1.5,
    }),
    /** Default combat: no distance fog (keeps empty-yard FPS). */
    fogEnabled: false,
    fogDensity: 0.0065,
    fogColor: 0xb8c0c8,
    farWalkWeight: 0.35,
    farWalkDistance: 28,
  }),
  stretch: Object.freeze({
    id: 'stretch',
    label: 'Stretch (750)',
    count: HORDE_STRETCH_ENEMY_COUNT,
    fullActorLimit: HORDE_FULL_ACTOR_LIMIT,
    attackTokens: HORDE_ATTACK_TOKEN_LIMIT,
    sectorGrid: HORDE_SECTOR_GRID,
    flock: Object.freeze({
      separationDistance: 1.28,
      neighborRadius: 3.0,
      attackRadius: 4.5,
      congestionFull: 16,
      congestionFloor: 0.52,
      cohesion: 0.22,
      separate: 1.45,
    }),
    fogEnabled: false,
    fogDensity: 0.007,
    fogColor: 0xb0b8c0,
    farWalkWeight: 0.25,
    farWalkDistance: 32,
  }),
  spectacle: Object.freeze({
    id: 'spectacle',
    label: 'Spectacle (1000)',
    count: HORDE_SPECTACLE_ENEMY_COUNT,
    fullActorLimit: HORDE_FULL_ACTOR_LIMIT,
    attackTokens: 5,
    sectorGrid: 5,
    flock: Object.freeze({
      // Stronger separation + earlier congestion → columns/front, not a paste blob.
      separationDistance: 1.22,
      neighborRadius: 2.9,
      attackRadius: 4.4,
      congestionFull: 18,
      congestionFloor: 0.48,
      cohesion: 0.24,
      separate: 1.55,
    }),
    fogEnabled: true,
    fogDensity: 0.0085,
    fogColor: 0xa8b0ba,
    farWalkWeight: 0.15,
    farWalkDistance: 36,
  }),
  heavy: Object.freeze({
    id: 'heavy',
    label: 'Heavy (1500)',
    count: HORDE_SPECTACLE_HEAVY_COUNT,
    fullActorLimit: 20,
    attackTokens: 5,
    sectorGrid: 5,
    flock: Object.freeze({
      separationDistance: 1.18,
      neighborRadius: 2.8,
      attackRadius: 4.3,
      congestionFull: 20,
      congestionFloor: 0.45,
      cohesion: 0.26,
      separate: 1.6,
    }),
    fogEnabled: true,
    fogDensity: 0.01,
    fogColor: 0x9aa4b0,
    farWalkWeight: 0.1,
    farWalkDistance: 40,
  }),
  extreme: Object.freeze({
    id: 'extreme',
    label: 'Extreme (2000)',
    count: HORDE_BENCHMARK_MAX_COUNT,
    fullActorLimit: 16,
    attackTokens: 4,
    sectorGrid: 6,
    flock: Object.freeze({
      separationDistance: 1.12,
      neighborRadius: 2.6,
      attackRadius: 4.2,
      congestionFull: 22,
      congestionFloor: 0.42,
      cohesion: 0.28,
      separate: 1.65,
    }),
    fogEnabled: true,
    fogDensity: 0.012,
    fogColor: 0x909aa6,
    farWalkWeight: 0,
    farWalkDistance: 24,
  }),
});

export const HORDE_PERFORMANCE_DEFAULTS = Object.freeze({
  maxEnemyCount: HORDE_DEFAULT_ENEMY_COUNT,
  stretchEnemyCount: HORDE_STRETCH_ENEMY_COUNT,
  spectacleEnemyCount: HORDE_SPECTACLE_ENEMY_COUNT,
  benchmarkMax: HORDE_BENCHMARK_MAX_COUNT,
  fullActorLimit: HORDE_FULL_ACTOR_LIMIT,
  immediateSpawnLimit: HORDE_IMMEDIATE_SPAWN_LIMIT,
  initialSpawnBurst: HORDE_INITIAL_SPAWN_BURST,
  spawnBatchPerFrame: HORDE_SPAWN_BATCH_PER_FRAME,
  fullSpawnBatchPerFrame: HORDE_FULL_SPAWN_BATCH_PER_FRAME,
  sectorGrid: HORDE_SECTOR_GRID,
});

export function clampHordeEnemyCount(value, max = HORDE_MAX_ENEMY_COUNT) {
  const count = Math.floor(Number(value) || 0);
  const ceiling = Math.max(0, Math.floor(Number(max) || HORDE_MAX_ENEMY_COUNT));
  return Math.max(0, Math.min(ceiling, count));
}

/** Resolve a spectacle preset by id (default if unknown). */
export function getHordeSpectaclePreset(id = 'default') {
  return HORDE_SPECTACLE_PRESETS[id] ?? HORDE_SPECTACLE_PRESETS.default;
}

/** Ordered preset ids for UI. */
export function listHordeSpectaclePresetIds() {
  return Object.keys(HORDE_SPECTACLE_PRESETS);
}

/** Per-sector instance capacity with slack for migration imbalance. */
export function hordeSectorCapacity(totalCapacity, sectorGrid = HORDE_SECTOR_GRID) {
  const n = Math.max(1, Math.floor(sectorGrid) ** 2);
  const base = Math.ceil(Math.max(1, totalCapacity) / n);
  const slack = Math.ceil(base * HORDE_SECTOR_CAPACITY_SLACK);
  return Math.max(16, base + slack);
}
