/**
 * Remote player sample buffer + interpolation (M3, pure).
 *
 * Buffers timestamped server samples per player and interpolates a render pose
 * at `renderTime = serverTime - delayMs`. No Three.js dependency so node
 * verifiers can exercise join/leave, bounds, and latency smoothing without a
 * browser.
 */

/** Default render delay (ms) — hides jitter under ordinary latency. */
export const DEFAULT_INTERP_DELAY_MS = 100;

/** Max samples retained per player (bounded history). */
export const MAX_SAMPLES_PER_PLAYER = 32;

/** Drop samples older than this relative to the newest. */
export const SAMPLE_WINDOW_MS = 750;

/**
 * Consecutive samples farther apart than this snap (no multi-metre lerp slide).
 * Matches client hard-snap distance in deathmatchMovementReplication.
 */
export const SAMPLE_HARD_SNAP_M = 2.5;

/**
 * @typedef {{
 *   t: number,
 *   position: number[],
 *   velocity: number[],
 *   yaw: number,
 *   pitch: number,
 *   locomotionState: string,
 *   currentWeapon: string|null,
 *   animation: object|null,
 *   alive: boolean,
 * }} RemoteSample
 */

/**
 * @typedef {{
 *   playerId: string,
 *   displayName: string,
 *   samples: RemoteSample[],
 *   lastSeenAt: number,
 * }} RemoteTrack
 */

export function createRemotePlayerBuffer({
  maxSamples = MAX_SAMPLES_PER_PLAYER,
  windowMs = SAMPLE_WINDOW_MS,
  delayMs = DEFAULT_INTERP_DELAY_MS,
} = {}) {
  /** @type {Map<string, RemoteTrack>} */
  const tracks = new Map();
  return {
    maxSamples,
    windowMs,
    delayMs,
    tracks,

    /**
     * Upsert a track from a server player snapshot entry.
     * @param {object} player serialized player from snapshot/welcome
     * @param {number} serverTime
     * @param {{ displayName?: string }} [extra]
     */
    pushSample(player, serverTime, extra = {}) {
      if (!player?.playerId || !Array.isArray(player.position)) return;
      let track = tracks.get(player.playerId);
      if (!track) {
        track = {
          playerId: player.playerId,
          displayName: extra.displayName ?? player.displayName ?? 'Player',
          samples: [],
          lastSeenAt: serverTime,
        };
        tracks.set(player.playerId, track);
      } else {
        if (extra.displayName || player.displayName) {
          track.displayName = extra.displayName ?? player.displayName ?? track.displayName;
        }
        track.lastSeenAt = serverTime;
      }

      const sample = {
        t: serverTime,
        position: [player.position[0], player.position[1], player.position[2]],
        velocity: Array.isArray(player.velocity)
          ? [player.velocity[0], player.velocity[1], player.velocity[2]]
          : [0, 0, 0],
        yaw: Number.isFinite(player.yaw) ? player.yaw : 0,
        pitch: Number.isFinite(player.pitch) ? player.pitch : 0,
        locomotionState: typeof player.locomotionState === 'string' ? player.locomotionState : 'idle',
        currentWeapon: player.currentWeapon ?? null,
        animation: cloneAnimationState(player.animation),
        alive: player.alive !== false,
      };

      // Dedup: ignore identical or non-monotonic timestamps.
      const last = track.samples[track.samples.length - 1];
      if (last && sample.t <= last.t) {
        // Same tick refresh: replace the tail so weapon/alive flips still land.
        if (sample.t === last.t) {
          track.samples[track.samples.length - 1] = sample;
        }
        return;
      }
      track.samples.push(sample);
      trimTrack(track, maxSamples, windowMs);
    },

    /** Remove a player (leave / disconnect cleanup). */
    remove(playerId) {
      tracks.delete(playerId);
    },

    /** Drop tracks whose playerId is not in the live set. */
    retainOnly(playerIds) {
      const keep = new Set(playerIds);
      for (const id of tracks.keys()) {
        if (!keep.has(id)) tracks.delete(id);
      }
    },

    /**
     * Interpolated pose for rendering at `serverTime - delayMs`.
     * @returns {null | {
     *   position: number[],
     *   velocity: number[],
     *   yaw: number,
     *   pitch: number,
     *   locomotionState: string,
     *   currentWeapon: string|null,
     *   animation: object|null,
     *   alive: boolean,
     *   extrapolated: boolean,
     * }}
     */
    sampleAt(playerId, serverTime) {
      const track = tracks.get(playerId);
      if (!track || track.samples.length === 0) return null;
      const renderT = serverTime - delayMs;
      return interpolateSamples(track.samples, renderT);
    },

    /** Bounded debug view — no raw sample arrays. */
    snapshot() {
      return {
        trackCount: tracks.size,
        delayMs,
        players: [...tracks.values()].map((t) => ({
          playerId: t.playerId,
          displayName: t.displayName,
          sampleCount: t.samples.length,
          lastSeenAt: t.lastSeenAt,
        })),
      };
    },

    clear() {
      tracks.clear();
    },
  };
}

function trimTrack(track, maxSamples, windowMs) {
  while (track.samples.length > maxSamples) track.samples.shift();
  if (track.samples.length < 2) return;
  const newest = track.samples[track.samples.length - 1].t;
  const cutoff = newest - windowMs;
  while (track.samples.length > 2 && track.samples[0].t < cutoff) {
    track.samples.shift();
  }
}

/**
 * Find samples bracketing `t` and lerp. Extrapolates briefly past the newest
 * sample using velocity so motion doesn't freeze during a missed snapshot.
 */
export function interpolateSamples(samples, t) {
  if (!samples.length) return null;
  if (samples.length === 1) {
    return poseFromSample(samples[0], false);
  }

  // Before the oldest sample → clamp to oldest.
  if (t <= samples[0].t) {
    return poseFromSample(samples[0], false);
  }

  const newest = samples[samples.length - 1];
  // Past the newest → short velocity extrapolation (cap 100 ms).
  if (t >= newest.t) {
    const extraSec = Math.min(0.1, (t - newest.t) / 1000);
    if (extraSec <= 0) return poseFromSample(newest, false);
    return {
      position: [
        newest.position[0] + newest.velocity[0] * extraSec,
        newest.position[1] + newest.velocity[1] * extraSec,
        newest.position[2] + newest.velocity[2] * extraSec,
      ],
      velocity: [...newest.velocity],
      yaw: newest.yaw,
      pitch: newest.pitch,
      locomotionState: newest.locomotionState,
      currentWeapon: newest.currentWeapon,
      animation: cloneAnimationState(newest.animation),
      alive: newest.alive,
      extrapolated: true,
    };
  }

  // Binary-ish linear search (N is small, ≤ 32).
  let i = 1;
  while (i < samples.length && samples[i].t < t) i += 1;
  const a = samples[i - 1];
  const b = samples[i];
  // Teleports / large corrections: snap to the newer sample instead of sliding.
  const gap = Math.hypot(
    b.position[0] - a.position[0],
    b.position[1] - a.position[1],
    b.position[2] - a.position[2],
  );
  if (gap >= SAMPLE_HARD_SNAP_M) {
    return poseFromSample(b, false);
  }
  const span = b.t - a.t;
  const u = span > 0 ? (t - a.t) / span : 0;
  return {
    position: [
      a.position[0] + (b.position[0] - a.position[0]) * u,
      a.position[1] + (b.position[1] - a.position[1]) * u,
      a.position[2] + (b.position[2] - a.position[2]) * u,
    ],
    velocity: [
      a.velocity[0] + (b.velocity[0] - a.velocity[0]) * u,
      a.velocity[1] + (b.velocity[1] - a.velocity[1]) * u,
      a.velocity[2] + (b.velocity[2] - a.velocity[2]) * u,
    ],
    yaw: lerpAngle(a.yaw, b.yaw, u),
    pitch: a.pitch + (b.pitch - a.pitch) * u,
    locomotionState: u < 0.5 ? a.locomotionState : b.locomotionState,
    currentWeapon: u < 0.5 ? a.currentWeapon : b.currentWeapon,
    animation: cloneAnimationState(u < 0.5 ? a.animation : b.animation),
    alive: a.alive && b.alive,
    extrapolated: false,
  };
}

function poseFromSample(s, extrapolated) {
  return {
    position: [s.position[0], s.position[1], s.position[2]],
    velocity: [s.velocity[0], s.velocity[1], s.velocity[2]],
    yaw: s.yaw,
    pitch: s.pitch,
    locomotionState: s.locomotionState,
    currentWeapon: s.currentWeapon,
    animation: cloneAnimationState(s.animation),
    alive: s.alive,
    extrapolated,
  };
}

function cloneAnimationState(animation) {
  if (!animation || typeof animation !== 'object') return null;
  return {
    base: animation.base,
    upper: animation.upper ?? null,
    layered: animation.layered === true,
    attackLeg: animation.attackLeg ?? null,
    attackLegWeight: Number(animation.attackLegWeight) || 0,
    footwork: animation.footwork === true,
    footworkLeg: animation.footworkLeg ?? null,
    footworkBody: animation.footworkBody ?? null,
    mirrorX: animation.mirrorX === true,
    lean: Number(animation.lean) || 0,
  };
}

/** Shortest-path angle lerp. */
export function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
