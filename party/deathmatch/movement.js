/**
 * Deathmatch movement validation (M0).
 *
 * V1 is client-predicted movement with a server *validator*, not a full server
 * simulator (see plan §Movement). The server clamps/rejects samples that break
 * the movement envelope, leave the legal player volumes, penetrate coarse
 * solids, or fall below the kill plane, and records bounded transform history
 * for lag-compensated hitscan. Trigger volumes (jump pad / teleporter) emit
 * events and, for teleporters, snap the canonical position.
 *
 * Pure and PartyKit-free: returns `{ corrected, events, deaths }`.
 */

import { PLAYER_CAPSULE, MOVEMENT, ROOM_CONFIG } from '../../src/game/config/deathmatch/deathmatchRules.js';
import {
  RAIL_CRUCIBLE,
  isInsideValidVolume,
  isBelowKillPlane,
  overlapsSolid,
  findTriggerAt,
} from '../../src/game/config/deathmatch/railCrucibleMap.js';
import { DEATH_CAUSE } from './combat.js';

/** Coarse AABB around a player capsule standing at `position`. */
function capsuleAabb(position) {
  const r = PLAYER_CAPSULE.radius;
  return {
    min: [position[0] - r, position[1], position[2] - r],
    max: [position[0] + r, position[1] + PLAYER_CAPSULE.height, position[2] + r],
  };
}

/** Push a bounded transform sample into a player's history ring. */
export function recordHistory(player, position, now) {
  player.history.push({ t: now, position: [position[0], position[1], position[2]] });
  const cutoff = now - ROOM_CONFIG.historyWindowMs;
  while (player.history.length > 2 && player.history[0].t < cutoff) {
    player.history.shift();
  }
}

/**
 * Validate an incoming player_state sample and apply it (clamped) to `player`.
 * @returns {{ corrected: boolean, events: object[], deaths: object[] }}
 */
export function applyMovementSample(state, player, msg, now) {
  const events = [];
  const deaths = [];

  // Ignore samples while dead or with stale/duplicate sequence numbers.
  if (!player.alive) return { corrected: false, events, deaths };
  if (msg.seq <= player.lastInputSeq) return { corrected: false, events, deaths };

  // Reject implausible client timestamps outright.
  if (Math.abs(msg.clientTime - now) > MOVEMENT.maxTimestampSkewMs) {
    return { corrected: true, events, deaths };
  }

  const prev = player.position;
  const elapsedMs = Math.max(now - player.lastSampleAt, MOVEMENT.sampleIntervalMs);
  let next = [msg.position[0], msg.position[1], msg.position[2]];
  let corrected = false;

  // Horizontal speed envelope (jump pads raise the vertical allowance via events,
  // handled below; the horizontal cap always applies).
  const dx = next[0] - prev[0];
  const dz = next[2] - prev[2];
  const horiz = Math.hypot(dx, dz);
  const maxHoriz = (MOVEMENT.maxHorizontalSpeed * MOVEMENT.displacementSlack * elapsedMs) / 1000;
  if (horiz > maxHoriz && horiz > 1e-6) {
    const s = maxHoriz / horiz;
    next = [prev[0] + dx * s, msg.position[1], prev[2] + dz * s];
    corrected = true;
  }

  // Kill plane → world death, snap handled by respawn later.
  if (isBelowKillPlane(next)) {
    deaths.push({ victimId: player.playerId, attackerId: player.lastAttackerId ?? null, cause: DEATH_CAUSE.WORLD, weaponId: null });
    player.lastInputSeq = msg.seq;
    player.lastSampleAt = now;
    return { corrected: true, events, deaths };
  }

  // Must stay inside a legal volume (unless standing in a trigger volume).
  const trigger = findTriggerAt(next);
  if (!isInsideValidVolume(next) && !trigger) {
    // Reject: keep the previous canonical position.
    player.lastInputSeq = msg.seq;
    player.lastSampleAt = now;
    return { corrected: true, events, deaths };
  }

  // Coarse solid penetration → reject.
  const box = capsuleAabb(next);
  if (overlapsSolid(box.min, box.max)) {
    player.lastInputSeq = msg.seq;
    player.lastSampleAt = now;
    return { corrected: true, events, deaths };
  }

  // Accept the (possibly clamped) sample.
  player.position = next;
  player.velocity = [msg.velocity[0], msg.velocity[1], msg.velocity[2]];
  player.yaw = msg.yaw;
  player.pitch = msg.pitch;
  player.lastInputSeq = msg.seq;
  player.lastSampleAt = now;
  player.locomotionState = typeof msg.locomotionState === 'string' ? msg.locomotionState : player.locomotionState;
  player.movementFlags = Number.isInteger(msg.movementFlags) ? msg.movementFlags : 0;
  player.animation = msg.animation ?? player.animation ?? null;
  recordHistory(player, next, now);

  // Resolve trigger effects after the sample is accepted.
  // Jump pads are one-shot until the player leaves the volume (no re-fire spam).
  if (trigger?.type === 'jumpPad') {
    const padId = trigger.trigger.id;
    if (player.activeJumpPadId !== padId) {
      player.activeJumpPadId = padId;
      events.push({
        kind: 'teleport',
        payload: {
          playerId: player.playerId,
          triggerId: padId,
          kind: 'jumpPad',
          velocity: trigger.trigger.velocity,
        },
      });
    }
  } else {
    player.activeJumpPadId = null;
  }

  if (trigger?.type === 'teleporter') {
    const exit = trigger.trigger.exitPosition;
    player.position = [exit[0], exit[1], exit[2]];
    player.yaw = trigger.trigger.exitYaw;
    player.activeJumpPadId = null;
    recordHistory(player, player.position, now);
    events.push({
      kind: 'teleport',
      payload: {
        playerId: player.playerId,
        triggerId: trigger.trigger.id,
        kind: 'teleporter',
        exitPosition: player.position,
        exitYaw: player.yaw,
      },
    });
    corrected = true; // exit is an authoritative snap
  }

  return { corrected, events, deaths };
}

/** Exposed for verifiers: the arena descriptor this validator is bound to. */
export const MOVEMENT_MAP_ID = RAIL_CRUCIBLE.id;
