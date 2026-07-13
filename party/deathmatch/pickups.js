/**
 * Deathmatch pickups — availability and inventory rules (M0).
 *
 * The server owns pickup availability and inventory outcomes. Clients only send
 * `pickup_request`; the server checks availability, alive state, distance to the
 * canonical capsule, and inventory caps, then marks the pickup unavailable until
 * an absolute `availableAt` timestamp (see plan §Pickups). Contention resolves
 * to exactly one player because MatchRoom processes requests sequentially.
 *
 * Pure and PartyKit-free.
 */

import { distance } from '../../src/game/net/deathmatchGeometry.js';
import {
  PICKUP_KIND,
  HEALTH,
  WEAPON_BALANCE,
  AMMO_PICKUP_AMOUNT,
  HEALTH_PICKUP_AMOUNT,
  getWeaponBalance,
} from '../../src/game/config/deathmatch/deathmatchRules.js';
import { RAIL_CRUCIBLE } from '../../src/game/config/deathmatch/railCrucibleMap.js';

/** Max distance from the canonical feet position to a pickup to collect it. */
export const PICKUP_REACH_M = 2.0;

/** Build the initial (all available) pickup state map from the descriptor. */
export function createPickupState() {
  const map = new Map();
  for (const spec of RAIL_CRUCIBLE.pickupSpawns) {
    map.set(spec.id, {
      id: spec.id,
      kind: spec.kind,
      weaponId: spec.weaponId ?? null,
      ammoType: spec.ammoType ?? null,
      healthTier: spec.healthTier ?? null,
      position: spec.position,
      respawnMs: spec.respawnMs,
      available: true,
      availableAt: 0,
    });
  }
  return map;
}

/** Grant a weapon: add it with a fresh magazine, or top up ammo if already owned. */
function grantWeapon(player, weaponId) {
  const weapon = getWeaponBalance(weaponId);
  if (!weapon) return false;
  const inv = player.weapons[weaponId];
  if (!inv) {
    player.weapons[weaponId] = { ammo: weapon.magazineSize, reserve: weapon.startingReserve };
    player.currentWeapon = weaponId; // auto-switch to a freshly collected weapon
    return true;
  }
  // Already owned → grant one magazine of reserve up to the cap.
  const before = inv.reserve;
  inv.reserve = Math.min(weapon.reserveMax, inv.reserve + weapon.magazineSize);
  return inv.reserve > before;
}

/** Grant reserve ammo of a type to every owned weapon of that type. */
function grantAmmo(player, ammoType) {
  const amount = AMMO_PICKUP_AMOUNT[ammoType] ?? 0;
  let granted = false;
  for (const [weaponId, inv] of Object.entries(player.weapons)) {
    const weapon = WEAPON_BALANCE[weaponId];
    if (!weapon || weapon.ammoType !== ammoType) continue;
    const before = inv.reserve;
    inv.reserve = Math.min(weapon.reserveMax, inv.reserve + amount);
    if (inv.reserve > before) granted = true;
  }
  return granted;
}

/** Heal up to the health cap. */
function grantHealth(player, healthTier) {
  const amount = HEALTH_PICKUP_AMOUNT[healthTier] ?? 0;
  if (player.health >= HEALTH.max) return false;
  player.health = Math.min(HEALTH.max, player.health + amount);
  return true;
}

/**
 * Attempt to collect a pickup for a player.
 * @returns {{ granted: boolean, reason?: string, events: object[] }}
 */
export function requestPickup(state, player, pickupId, now) {
  const events = [];
  const pickup = state.pickups.get(pickupId);
  if (!pickup) return { granted: false, reason: 'unknown', events };
  if (!pickup.available) return { granted: false, reason: 'unavailable', events };
  if (!player.alive) return { granted: false, reason: 'dead', events };
  if (distance(player.position, pickup.position) > PICKUP_REACH_M) {
    return { granted: false, reason: 'too_far', events };
  }

  let granted = false;
  if (pickup.kind === PICKUP_KIND.WEAPON) {
    granted = grantWeapon(player, pickup.weaponId);
    if (granted) player.spawnProtectedUntil = 0; // collecting a weapon ends protection
  } else if (pickup.kind === PICKUP_KIND.AMMO) {
    granted = grantAmmo(player, pickup.ammoType);
  } else if (pickup.kind === PICKUP_KIND.HEALTH) {
    granted = grantHealth(player, pickup.healthTier);
  }

  if (!granted) return { granted: false, reason: 'no_effect', events };

  pickup.available = false;
  pickup.availableAt = now + pickup.respawnMs;
  events.push({
    kind: 'pickup_taken',
    payload: { pickupId, playerId: player.playerId, kind: pickup.kind, availableAt: pickup.availableAt },
  });
  return { granted: true, events };
}

/** Respawn any pickups whose absolute `availableAt` has elapsed. */
export function tickPickups(state, now) {
  const events = [];
  for (const pickup of state.pickups.values()) {
    if (!pickup.available && now >= pickup.availableAt) {
      pickup.available = true;
      events.push({ kind: 'pickup_respawn', payload: { pickupId: pickup.id } });
    }
  }
  return events;
}

/** Reset all pickups to available (round reset). */
export function resetPickups(state) {
  for (const pickup of state.pickups.values()) {
    pickup.available = true;
    pickup.availableAt = 0;
  }
}
