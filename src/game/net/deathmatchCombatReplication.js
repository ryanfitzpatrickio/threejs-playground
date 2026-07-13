/**
 * Pure deathmatch combat helpers (M4) — fire/reload messages + presentation state.
 *
 * No Three.js. Shared by the runtime combat adapter and node verifiers.
 * Damage/score stay server-owned; these helpers only build intents and apply
 * authoritative feedback fields.
 */

import { CLIENT_MSG } from './deathmatchProtocol.js';
import { estimateClientTime } from './deathmatchMovementReplication.js';
import {
  HEALTH,
  STARTING_WEAPON,
  createStartingInventory,
  getWeaponBalance,
} from '../config/deathmatch/deathmatchRules.js';

/**
 * Build a protocol `fire` client message.
 * @param {object} opts
 * @param {number} opts.shotSeq
 * @param {number} opts.clientTime server-aligned wall clock
 * @param {string} opts.weaponId
 * @param {number[]} opts.origin head/muzzle origin [x,y,z]
 * @param {number[]} opts.direction aim direction [x,y,z] (need not be unit)
 */
export function buildFireMessage({
  shotSeq,
  clientTime,
  weaponId,
  origin,
  direction,
}) {
  return {
    type: CLIENT_MSG.FIRE,
    shotSeq,
    clientTime,
    weaponId,
    origin: [origin[0], origin[1], origin[2]],
    direction: [direction[0], direction[1], direction[2]],
  };
}

/**
 * Build a protocol `reload` client message.
 */
export function buildReloadMessage({ actionSeq, weaponId }) {
  return {
    type: CLIENT_MSG.RELOAD,
    actionSeq,
    weaponId,
  };
}

/**
 * Build a protocol `respawn_ready` client message (intent only; server times spawn).
 */
export function buildRespawnReadyMessage({ actionSeq }) {
  return {
    type: CLIENT_MSG.RESPAWN_READY,
    actionSeq,
  };
}

/**
 * Estimate clientTime for a fire/reload intent (same domain as movement samples).
 */
export function estimateCombatClientTime(nowMs, clockOffsetMs = 0) {
  return estimateClientTime(nowMs, clockOffsetMs);
}

/**
 * Apply SHOT_RESULT fields to a local presentation inventory view.
 * Mutates `inventory` when provided: `{ ammo, reserve }` for current weapon.
 *
 * @returns {{ ammo: number|null, accepted: boolean, hit: boolean, reason: string|null }}
 */
export function applyShotResult(result, inventory = null) {
  if (!result) {
    return { ammo: null, accepted: false, hit: false, reason: 'missing' };
  }
  const ammo = typeof result.authoritativeAmmo === 'number'
    ? result.authoritativeAmmo
    : null;
  if (inventory && ammo != null) {
    inventory.ammo = ammo;
  }
  return {
    ammo,
    accepted: Boolean(result.accepted),
    hit: Boolean(result.accepted && result.hitPlayerId),
    reason: result.accepted ? null : (result.reason ?? 'rejected'),
    hitPlayerId: result.hitPlayerId ?? null,
    hitKind: result.hitKind ?? null,
    damage: result.damage ?? 0,
    shotSeq: result.shotSeq,
  };
}

/**
 * Deep-copy a weapons inventory map from a server payload.
 * @param {object|null|undefined} raw
 * @returns {object}
 */
export function cloneWeaponsInventory(raw) {
  if (!raw || typeof raw !== 'object') return createStartingInventory();
  const out = {};
  for (const [id, inv] of Object.entries(raw)) {
    if (!inv || typeof inv !== 'object') continue;
    out[id] = {
      ammo: typeof inv.ammo === 'number' ? inv.ammo : 0,
      reserve: typeof inv.reserve === 'number' ? inv.reserve : 0,
    };
  }
  return Object.keys(out).length > 0 ? out : createStartingInventory();
}

/**
 * Derive local loadout view after an authoritative respawn.
 * Prefers server-stamped weapons/ammo on the RESPAWN payload; falls back to
 * starting inventory only when the payload omits weapons (legacy).
 * @returns {{ health: number, weaponId: string, weapons: object, spawnProtectedUntil: number, lifeSeq: number }}
 */
export function loadoutFromRespawn(payload) {
  const weapons = cloneWeaponsInventory(payload?.weapons);
  const weaponId = payload?.currentWeapon
    || (weapons[STARTING_WEAPON] ? STARTING_WEAPON : Object.keys(weapons)[0])
    || STARTING_WEAPON;
  return {
    health: typeof payload?.health === 'number' ? payload.health : HEALTH.spawn,
    weaponId,
    weapons,
    spawnProtectedUntil: typeof payload?.spawnProtectedUntil === 'number'
      ? payload.spawnProtectedUntil
      : 0,
    lifeSeq: typeof payload?.lifeSeq === 'number' ? payload.lifeSeq : 0,
    position: Array.isArray(payload?.position) ? [...payload.position] : null,
    yaw: Number.isFinite(payload?.yaw) ? payload.yaw : 0,
  };
}

/**
 * True when the local player should be treated as spawn-protected at `serverTime`.
 */
export function isSpawnProtected(spawnProtectedUntil, serverTime) {
  return typeof spawnProtectedUntil === 'number'
    && spawnProtectedUntil > 0
    && serverTime < spawnProtectedUntil;
}

/**
 * Server balance row for a weapon, or null.
 */
export function authoritativeWeapon(weaponId) {
  return getWeaponBalance(weaponId);
}
