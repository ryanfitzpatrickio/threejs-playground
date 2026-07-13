/**
 * Deathmatch combat — fire validation, lag-compensated rewind, hit resolution.
 *
 * Pure and PartyKit-free (M0): operates on plain match/player state and returns
 * events + death intents. MatchRoom routes the returned deaths to the reducer so
 * this module never imports the reducer (keeps the dependency one-way; the
 * reducer imports the capsule/occlusion helpers here for spawn selection).
 *
 * The server owns damage. Clients send origin/direction/sequence only.
 */

import {
  add,
  distance,
  normalize,
  isUsableDirection,
  rayAabb,
  rayCapsule,
  raySphere,
} from '../../src/game/net/deathmatchGeometry.js';
import { computeShotgunPattern } from '../../src/game/net/deathmatchProtocol.js';
import {
  HIT_KIND,
  MATCH_PHASE,
  MOVEMENT,
  PLAYER_CAPSULE,
  ROOM_CONFIG,
  getWeaponBalance,
} from '../../src/game/config/deathmatch/deathmatchRules.js';
import { RAIL_CRUCIBLE } from '../../src/game/config/deathmatch/railCrucibleMap.js';

export const DEATH_CAUSE = Object.freeze({ KILL: 'kill', SUICIDE: 'suicide', WORLD: 'world' });

/** Max distance a shot origin may sit from the shooter's canonical head. */
const MAX_ORIGIN_OFFSET = 1.0;

/**
 * Clamp a client-reported shot time into the lag-comp history window.
 * Rejects (returns null) when the client timestamp is outside the skew envelope.
 * @param {number} clientTime
 * @param {number} now server wall time
 * @returns {number|null}
 */
export function resolveShotTime(clientTime, now, {
  maxSkewMs = MOVEMENT.maxTimestampSkewMs,
  historyWindowMs = ROOM_CONFIG.historyWindowMs,
} = {}) {
  if (typeof clientTime !== 'number' || !Number.isFinite(clientTime)) return null;
  if (Math.abs(clientTime - now) > maxSkewMs) return null;
  const earliest = now - historyWindowMs;
  return Math.min(now, Math.max(earliest, clientTime));
}

/**
 * Body + head capsule for a player standing with feet at `position`.
 * Body is the segment `[a, b]` with `radius`; head is a sphere.
 */
export function playerCapsule(position) {
  const { radius, height, headHeight, headRadius } = PLAYER_CAPSULE;
  return {
    a: add(position, [0, radius, 0]),
    b: add(position, [0, height - radius, 0]),
    radius,
    headCenter: add(position, [0, headHeight, 0]),
    headRadius,
  };
}

/**
 * Reconstruct a player's feet position at time `t` from bounded history.
 * Falls back to the current canonical position when history is empty/out of range.
 */
export function sampleHistory(player, t) {
  const hist = player.history;
  if (!hist || hist.length === 0) return player.position;
  if (t <= hist[0].t) return hist[0].position;
  const last = hist[hist.length - 1];
  if (t >= last.t) return player.position;
  for (let i = 1; i < hist.length; i += 1) {
    if (hist[i].t >= t) {
      const prev = hist[i - 1];
      const next = hist[i];
      const span = next.t - prev.t;
      const f = span > 0 ? (t - prev.t) / span : 0;
      return [
        prev.position[0] + (next.position[0] - prev.position[0]) * f,
        prev.position[1] + (next.position[1] - prev.position[1]) * f,
        prev.position[2] + (next.position[2] - prev.position[2]) * f,
      ];
    }
  }
  return player.position;
}

/** Nearest occluder hit distance along a ray within `maxT`, or Infinity. */
function nearestOccluder(origin, dir, maxT) {
  let best = Infinity;
  for (const occ of RAIL_CRUCIBLE.shotOccluders) {
    const t = rayAabb(origin, dir, occ.min, occ.max, maxT);
    if (t !== null && t < best) best = t;
  }
  return best;
}

/**
 * True when the straight segment from `from` to `to` is blocked by any occluder.
 * Used by spawn-visibility scoring and as a sanity check.
 */
export function isSightBlocked(from, to) {
  const delta = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const dist = Math.hypot(delta[0], delta[1], delta[2]);
  if (dist < 1e-6) return false;
  const dir = [delta[0] / dist, delta[1] / dist, delta[2] / dist];
  // Shrink slightly so touching endpoints don't self-occlude.
  return nearestOccluder(from, dir, dist - 1e-3) < dist - 1e-3;
}

/**
 * Cast one pellet against rewound opponents. Returns the nearest legal hit
 * `{ playerId, kind, t }` or null when the shot misses or is occluded first.
 */
function castPellet(origin, dir, shooterId, opponents, shotTime, maxRange) {
  let best = null;
  for (const opp of opponents) {
    if (opp.id === shooterId) continue;
    const feet = sampleHistory(opp.player, shotTime);
    const cap = playerCapsule(feet);
    const headT = raySphere(origin, dir, cap.headCenter, cap.headRadius, maxRange);
    const bodyT = rayCapsule(origin, dir, cap.a, cap.b, cap.radius, maxRange);
    let t = null;
    let kind = HIT_KIND.BODY;
    if (headT !== null && (bodyT === null || headT <= bodyT)) {
      t = headT;
      kind = HIT_KIND.HEAD;
    } else if (bodyT !== null) {
      t = bodyT;
      kind = HIT_KIND.BODY;
    }
    if (t === null) continue;
    if (best === null || t < best.t) best = { playerId: opp.id, kind, t };
  }
  if (best === null) return null;
  // Reject if a static occluder is closer than the body along this pellet.
  if (nearestOccluder(origin, dir, best.t) < best.t) return null;
  return best;
}

/**
 * Validate and resolve a fire request. Mutates shooter ammo/gates and victim
 * health. Never mutates score/death bookkeeping — that is returned as `deaths`
 * for the reducer to finalize.
 *
 * `shotTime` is the lag-compensated rewind time (caller should clamp via
 * `resolveShotTime`). When omitted, clientTime is resolved against `now`.
 *
 * @returns {{ shotResult: object, events: object[], deaths: object[] }}
 */
export function resolveFire(state, shooter, msg, now, shotTime = null) {
  const reject = (reason) => ({
    shotResult: {
      shotSeq: msg.shotSeq,
      accepted: false,
      reason,
      authoritativeAmmo: shooter.weapons[shooter.currentWeapon]?.ammo ?? 0,
    },
    events: [],
    deaths: [],
  });

  if (state.phase !== MATCH_PHASE.RUNNING) return reject('phase');
  if (!shooter.alive) return reject('dead');
  if (msg.weaponId !== shooter.currentWeapon) return reject('weapon_mismatch');
  const weapon = getWeaponBalance(msg.weaponId);
  if (!weapon) return reject('unknown_weapon');
  const inv = shooter.weapons[msg.weaponId];
  if (!inv) return reject('not_owned');
  if (shooter.reload.active) return reject('reloading');
  if (now < shooter.fire.nextFireAt) return reject('cadence');
  if (inv.ammo <= 0) return reject('no_ammo');
  // Monotonic shot sequences prevent replay / double-count of the same fire intent.
  if (!Number.isInteger(msg.shotSeq) || msg.shotSeq <= shooter.fire.lastShotSeq) {
    return reject('shot_seq');
  }
  if (!isUsableDirection(msg.direction)) return reject('bad_direction');
  if (distance(msg.origin, playerCapsule(shooter.position).headCenter) > MAX_ORIGIN_OFFSET) {
    return reject('origin_offset');
  }

  let effectiveShotTime = shotTime;
  if (effectiveShotTime == null || !Number.isFinite(effectiveShotTime)) {
    effectiveShotTime = resolveShotTime(msg.clientTime, now);
    if (effectiveShotTime === null) return reject('stale_time');
  }

  // Accepted: consume one round, gate cadence, drop spawn protection on fire.
  inv.ammo -= 1;
  shooter.fire.nextFireAt = now + weapon.fireIntervalMs;
  shooter.fire.lastShotSeq = msg.shotSeq;
  shooter.spawnProtectedUntil = 0;

  const forward = normalize(msg.direction);
  const pellets =
    weapon.pelletCount > 1
      ? computeShotgunPattern(state.roundId, shooter.playerId, msg.shotSeq, forward, weapon.pelletCount, weapon.spreadRadians)
      : [forward];

  const opponents = [];
  for (const [id, p] of state.players) {
    if (id === shooter.playerId || !p.alive) continue;
    if (p.spawnProtectedUntil > effectiveShotTime) continue; // protected → untargetable
    if (!p.connected) continue;
    opponents.push({ id, player: p });
  }

  // Accumulate damage per victim across pellets; a headshot pellet upgrades kind.
  const perVictim = new Map();
  for (const dir of pellets) {
    const hit = castPellet(msg.origin, dir, shooter.playerId, opponents, effectiveShotTime, weapon.rangeM);
    if (!hit) continue;
    const mult = hit.kind === HIT_KIND.HEAD ? weapon.headshotMultiplier : 1;
    const dmg = weapon.damage * mult;
    const acc = perVictim.get(hit.playerId) ?? { damage: 0, kind: HIT_KIND.BODY };
    acc.damage += dmg;
    if (hit.kind === HIT_KIND.HEAD) acc.kind = HIT_KIND.HEAD;
    perVictim.set(hit.playerId, acc);
  }

  const events = [];
  const deaths = [];
  let firstHitId = null;
  let firstHitKind = null;
  let firstHitDamage = 0;

  for (const [victimId, acc] of perVictim) {
    const victim = state.players.get(victimId);
    if (!victim || !victim.alive) continue;
    victim.health = Math.max(0, victim.health - acc.damage);
    victim.lastAttackerId = shooter.playerId;
    victim.lastAttackerAt = now;
    if (firstHitId === null) {
      firstHitId = victimId;
      firstHitKind = acc.kind;
      firstHitDamage = acc.damage;
    }
    events.push({ kind: 'damage', payload: { victimId, attackerId: shooter.playerId, amount: acc.damage, hitKind: acc.kind, weaponId: weapon.id } });
    if (victim.health <= 0) {
      deaths.push({ victimId, attackerId: shooter.playerId, cause: DEATH_CAUSE.KILL, weaponId: weapon.id });
    }
  }

  return {
    shotResult: {
      shotSeq: msg.shotSeq,
      accepted: true,
      hitPlayerId: firstHitId,
      hitKind: firstHitId ? firstHitKind : null,
      damage: firstHitId ? firstHitDamage : 0,
      authoritativeAmmo: inv.ammo,
    },
    events,
    deaths,
  };
}

/**
 * Begin a reload if legal. Returns true when started. Completion is applied in
 * `tickReloads` when the timer elapses.
 */
export function startReload(shooter, weaponId, now) {
  if (weaponId !== shooter.currentWeapon) return false;
  const weapon = getWeaponBalance(weaponId);
  const inv = shooter.weapons[weaponId];
  if (!weapon || !inv) return false;
  if (shooter.reload.active) return false;
  if (inv.reserve <= 0) return false;
  if (inv.ammo >= weapon.magazineSize) return false;
  shooter.reload.active = true;
  shooter.reload.weaponId = weaponId;
  shooter.reload.endsAt = now + weapon.reloadMs;
  return true;
}

/** Finish any reloads whose timers have elapsed. Returns emitted events. */
export function tickReloads(state, now) {
  const events = [];
  for (const [id, p] of state.players) {
    if (!p.reload.active || now < p.reload.endsAt) continue;
    const weapon = getWeaponBalance(p.reload.weaponId);
    const inv = p.weapons[p.reload.weaponId];
    if (weapon && inv) {
      const need = weapon.magazineSize - inv.ammo;
      const take = Math.min(need, inv.reserve);
      inv.ammo += take;
      inv.reserve -= take;
    }
    p.reload.active = false;
    events.push({
      kind: 'reload_complete',
      payload: {
        playerId: id,
        weaponId: p.reload.weaponId,
        ammo: inv?.ammo ?? 0,
        reserve: inv?.reserve ?? 0,
      },
    });
  }
  return events;
}
