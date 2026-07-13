/**
 * Local movement sampling + reconciliation helpers (M3, pure).
 *
 * The client predicts freely; the server validates and publishes the canonical
 * capsule in snapshots. These helpers decide when to hard-snap vs soft-blend
 * a local correction, build outbound `player_state` messages, and apply
 * teleporter / jump-pad events without importing Three.js.
 */

import { CLIENT_MSG } from './deathmatchProtocol.js';
import { MOVEMENT } from '../config/deathmatch/deathmatchRules.js';

/** Distance (m) above which the client hard-snaps to the server pose. */
export const HARD_SNAP_DISTANCE_M = 2.5;

/** Distance (m) above which a soft correction starts. */
export const SOFT_CORRECT_DISTANCE_M = 0.35;

/** Soft blend factor per application (0–1). */
export const SOFT_CORRECT_BLEND = 0.35;

/**
 * Build the next `player_state` client message.
 * @param {object} opts
 * @param {number} opts.seq
 * @param {number} opts.clientTime estimated server-aligned client clock
 * @param {number[]} opts.position feet position [x,y,z]
 * @param {number[]} opts.velocity [vx,vy,vz]
 * @param {number} opts.yaw
 * @param {number} opts.pitch
 * @param {number} [opts.movementFlags]
 * @param {string} [opts.locomotionState]
 * @param {object|null} [opts.animation]
 */
export function buildPlayerStateMessage({
  seq,
  clientTime,
  position,
  velocity,
  yaw,
  pitch,
  movementFlags = 0,
  locomotionState = 'idle',
  animation = null,
}) {
  return {
    type: CLIENT_MSG.PLAYER_STATE,
    seq,
    clientTime,
    position: [position[0], position[1], position[2]],
    velocity: [velocity[0], velocity[1], velocity[2]],
    yaw,
    pitch,
    movementFlags,
    locomotionState,
    animation,
  };
}

/**
 * Decide how (if at all) to reconcile local predicted pose with the server.
 *
 * @param {number[]} localPos
 * @param {number[]} serverPos
 * @returns {{ kind: 'none'|'soft'|'hard', distance: number, position: number[]|null }}
 */
export function planCorrection(localPos, serverPos, {
  hardSnapM = HARD_SNAP_DISTANCE_M,
  softCorrectM = SOFT_CORRECT_DISTANCE_M,
  softBlend = SOFT_CORRECT_BLEND,
} = {}) {
  if (!localPos || !serverPos) {
    return { kind: 'none', distance: 0, position: null };
  }
  const dx = serverPos[0] - localPos[0];
  const dy = serverPos[1] - localPos[1];
  const dz = serverPos[2] - localPos[2];
  const distance = Math.hypot(dx, dy, dz);
  if (distance < softCorrectM) {
    return { kind: 'none', distance, position: null };
  }
  if (distance >= hardSnapM) {
    return {
      kind: 'hard',
      distance,
      position: [serverPos[0], serverPos[1], serverPos[2]],
    };
  }
  return {
    kind: 'soft',
    distance,
    position: [
      localPos[0] + dx * softBlend,
      localPos[1] + dy * softBlend,
      localPos[2] + dz * softBlend,
    ],
  };
}

/**
 * Apply a server teleport / jump-pad event to a plain pose object.
 * Mutates `pose` and returns a description of what was applied.
 *
 * @param {object} pose { position:number[], velocity:number[], yaw:number }
 * @param {object} payload event payload from EVENT_KIND.TELEPORT
 */
export function applyTeleportPayload(pose, payload) {
  if (!pose || !payload) return { applied: false };
  if (payload.kind === 'teleporter') {
    if (Array.isArray(payload.exitPosition)) {
      pose.position = [
        payload.exitPosition[0],
        payload.exitPosition[1],
        payload.exitPosition[2],
      ];
    }
    if (Number.isFinite(payload.exitYaw)) pose.yaw = payload.exitYaw;
    pose.velocity = [0, 0, 0];
    return { applied: true, kind: 'teleporter' };
  }
  if (payload.kind === 'jumpPad' && Array.isArray(payload.velocity)) {
    pose.velocity = [
      payload.velocity[0],
      payload.velocity[1],
      payload.velocity[2],
    ];
    return { applied: true, kind: 'jumpPad' };
  }
  return { applied: false };
}

/**
 * Cadence helper: true when enough real time has passed for the next sample.
 * @param {number} lastSampleAt wall clock ms
 * @param {number} now wall clock ms
 * @param {number} [intervalMs]
 */
export function shouldSample(lastSampleAt, now, intervalMs = MOVEMENT.sampleIntervalMs) {
  return now - lastSampleAt >= intervalMs;
}

/**
 * Estimate a clientTime aligned to the server clock.
 * @param {number} nowMs local wall clock
 * @param {number} clockOffsetMs from DeathmatchNetworkSystem
 */
export function estimateClientTime(nowMs, clockOffsetMs = 0) {
  return nowMs + (Number.isFinite(clockOffsetMs) ? clockOffsetMs : 0);
}
