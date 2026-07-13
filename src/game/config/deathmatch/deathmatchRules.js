/**
 * Deathmatch V1 rules and server balance table (M0 — Contracts before networking).
 *
 * Pure data only: no Three.js, DOM, or PartyKit imports. Both the browser client
 * and the PartyKit server import this module. The server treats WEAPON_BALANCE as
 * the sole authority for damage/cadence/ammo — never client-supplied Gunsmith
 * profile values (see docs/multiplayer-deathmatch-partykit-plan.md, M0 + M4).
 *
 * Time is milliseconds unless a name ends in `Ms`/`Hz`. Positions are metres.
 */

/** Match phases owned by the server. */
export const MATCH_PHASE = Object.freeze({
  WAITING: 'waiting',
  COUNTDOWN: 'countdown',
  RUNNING: 'running',
  INTERMISSION: 'intermission',
});

/** Pickup kinds the server understands. */
export const PICKUP_KIND = Object.freeze({
  WEAPON: 'weapon',
  AMMO: 'ammo',
  HEALTH: 'health',
});

/** Where a shot capsule was struck (drives headshot multiplier). */
export const HIT_KIND = Object.freeze({
  BODY: 'body',
  HEAD: 'head',
});

/** Room-level configuration. All values remain server-tunable. */
export const ROOM_CONFIG = Object.freeze({
  capacity: 8,
  minPlayersToStart: 2,
  fragLimit: 20,
  matchDurationMs: 10 * 60 * 1000,
  countdownMs: 5000,
  intermissionMs: 10000,
  /** Server simulation tick while at least one player is connected. */
  tickHz: 20,
  /** Snapshot cadence while running vs. idle (waiting/intermission). */
  runningSnapshotHz: 20,
  idleSnapshotHz: 5,
  /** Delay from death to earliest respawn. */
  respawnDelayMs: 3000,
  /** Spawn protection window; ends early on fire/weapon pickup. */
  spawnProtectionMs: 1000,
  /** Disconnected players are held (resumable) before removal. */
  resumeWindowMs: 15000,
  /** Bounded per-player transform history for lag-compensated hitscan. */
  historyWindowMs: 500,
  /** Max snapshots/messages queued for a slow client before dropping stale. */
  maxOutboundQueue: 64,
  /** Max inbound messages processed per connection per tick. */
  maxInboundPerTick: 32,
});

/** Player health rules. */
export const HEALTH = Object.freeze({
  max: 100,
  spawn: 100,
});

/**
 * Canonical server player capsule. `position` is the feet point on the ground.
 * The body is a vertical capsule (segment between the two sphere centres, plus
 * radius); the head is a separate sphere used for headshot resolution.
 */
export const PLAYER_CAPSULE = Object.freeze({
  radius: 0.35,
  /** Total stand height, feet → crown. */
  height: 1.8,
  /** Head sphere centre height above feet. */
  headHeight: 1.62,
  headRadius: 0.16,
});

/**
 * Movement validation envelope. The client owns responsive local movement; the
 * server clamps/rejects samples that exceed these bounds (see plan §Movement).
 * Jump pads raise the allowed vertical speed for a bounded window via events.
 */
export const MOVEMENT = Object.freeze({
  maxHorizontalSpeed: 12,
  maxVerticalSpeed: 22,
  /** Extra slack multiplier applied to displacement checks for jitter. */
  displacementSlack: 1.35,
  /** Sample interval expected from clients (20 Hz). */
  sampleIntervalMs: 50,
  /** Acceptable clock skew (past/future) for a client timestamp. */
  maxTimestampSkewMs: 1500,
});

/** Starting inventory granted on every spawn. */
export const STARTING_WEAPON = 'midnight-glock';

/**
 * Authoritative weapon balance keyed by weapon id. `damage` is per pellet.
 * `fireIntervalMs` is the minimum spacing between accepted shots. `ammoType`
 * groups reserve ammo so ammo pickups can target a family.
 */
export const WEAPON_BALANCE = Object.freeze({
  'midnight-glock': Object.freeze({
    id: 'midnight-glock',
    ammoType: 'pistol',
    damage: 18,
    headshotMultiplier: 1.8,
    fireIntervalMs: 150,
    magazineSize: 15,
    reserveMax: 90,
    startingReserve: 45,
    pelletCount: 1,
    spreadRadians: 0.008,
    rangeM: 60,
    reloadMs: 1200,
  }),
  'tactical-shotgun': Object.freeze({
    id: 'tactical-shotgun',
    ammoType: 'shell',
    damage: 9,
    headshotMultiplier: 1.5,
    fireIntervalMs: 700,
    magazineSize: 6,
    reserveMax: 36,
    startingReserve: 12,
    pelletCount: 8,
    spreadRadians: 0.12,
    rangeM: 25,
    reloadMs: 2600,
  }),
  'desert-ar15': Object.freeze({
    id: 'desert-ar15',
    ammoType: 'rifle',
    damage: 14,
    headshotMultiplier: 2.0,
    fireIntervalMs: 90,
    magazineSize: 30,
    reserveMax: 150,
    startingReserve: 60,
    pelletCount: 1,
    spreadRadians: 0.02,
    rangeM: 90,
    reloadMs: 1800,
  }),
  'desert-sentinel': Object.freeze({
    id: 'desert-sentinel',
    ammoType: 'sniper',
    damage: 80,
    headshotMultiplier: 1.5,
    fireIntervalMs: 1100,
    magazineSize: 5,
    reserveMax: 25,
    startingReserve: 15,
    pelletCount: 1,
    spreadRadians: 0.0015,
    rangeM: 200,
    reloadMs: 2400,
  }),
});

/** Weapon ids that may be spawned/held in V1, in HUD/priority order. */
export const WEAPON_IDS = Object.freeze(Object.keys(WEAPON_BALANCE));

/** Amount of reserve ammo granted by an ammo pickup, keyed by ammoType. */
export const AMMO_PICKUP_AMOUNT = Object.freeze({
  pistol: 30,
  shell: 8,
  rifle: 30,
  sniper: 5,
});

/** Health pickup amounts by tier id. */
export const HEALTH_PICKUP_AMOUNT = Object.freeze({
  small: 25,
  large: 50,
});

/**
 * Spawn selection tuning. Distance dominates; visibility is a penalty; a safe
 * point always exists via a farthest-point fallback (see plan §Authored data).
 */
export const SPAWN_SELECTION = Object.freeze({
  /** Opponents inside this radius of a candidate disqualify it. */
  safetyRadiusM: 8,
  /** Score penalty subtracted when a candidate is visible to an opponent. */
  visiblePenalty: 1000,
});

/** Look up authoritative stats for a weapon id, or null if unknown. */
export function getWeaponBalance(weaponId) {
  return WEAPON_BALANCE[weaponId] ?? null;
}

/** True when a weapon id is part of the V1 allow-list. */
export function isKnownWeapon(weaponId) {
  return Object.prototype.hasOwnProperty.call(WEAPON_BALANCE, weaponId);
}

/** Build the starting inventory map: one full magazine plus starting reserve. */
export function createStartingInventory() {
  const b = WEAPON_BALANCE[STARTING_WEAPON];
  return {
    [STARTING_WEAPON]: { ammo: b.magazineSize, reserve: b.startingReserve },
  };
}
