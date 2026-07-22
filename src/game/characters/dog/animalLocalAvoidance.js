/**
 * Local multi-agent avoidance for park animals (ORCA-inspired, 2D discs).
 *
 * Pure math — no Three.js. Preferred velocities in → safe velocities out.
 * Designed for small N (park cast), not thousands of horde proxies.
 *
 * Model:
 * - Each agent is a disc (x, z, radius) with preferred velocity (px, pz)
 * - Pairwise: if relative motion would close inside timeHorizon, push velocity
 *   out of the collision cone (reciprocal: each takes ~half the responsibility)
 * - Soft separation when already overlapping
 * - Priority / mass bias so the player parts crowds without fighting the stick hard
 */

const EPS = 1e-6;

/**
 * @typedef {{
 *   id: string|number,
 *   x: number,
 *   z: number,
 *   vx?: number,
 *   vz?: number,
 *   preferredVx: number,
 *   preferredVz: number,
 *   radius: number,
 *   maxSpeed: number,
 *   priority?: number,
 *   group?: string|null,
 * }} AvoidanceAgent
 *
 * priority: higher = less yielding (player ~3, chase ~1).
 * group: agents that share a group skip each other (e.g. chase pair).
 */

/**
 * @param {AvoidanceAgent[]} agents
 * @param {number} dt
 * @param {{
 *   timeHorizon?: number,
 *   separationBoost?: number,
 * }} [opts]
 * @returns {Map<string|number, { vx: number, vz: number, speed: number }>}
 */
export function solveLocalAvoidance(agents, dt, opts = {}) {
  const timeHorizon = Math.max(0.15, opts.timeHorizon ?? 1.15);
  const separationBoost = opts.separationBoost ?? 1.35;
  const invDt = 1 / Math.max(dt || 1 / 60, 1e-4);
  /** @type {Map<string|number, { vx: number, vz: number, speed: number }>} */
  const out = new Map();
  if (!agents?.length) return out;

  // Snapshot preferred as starting point for iterative projection.
  const state = agents.map((a) => {
    const maxSpeed = Math.max(0.05, Number(a.maxSpeed) || 1);
    let px = Number(a.preferredVx) || 0;
    let pz = Number(a.preferredVz) || 0;
    const pLen = Math.hypot(px, pz);
    if (pLen > maxSpeed) {
      const s = maxSpeed / pLen;
      px *= s;
      pz *= s;
    }
    return {
      id: a.id,
      x: Number(a.x) || 0,
      z: Number(a.z) || 0,
      vx: px,
      vz: pz,
      maxSpeed,
      radius: Math.max(0.08, Number(a.radius) || 0.3),
      priority: Math.max(0.15, Number(a.priority) || 1),
      group: a.group ?? null,
    };
  });

  // 2–3 cheap iterations is enough for park N.
  const iterations = state.length > 8 ? 3 : 2;
  for (let iter = 0; iter < iterations; iter += 1) {
    for (let i = 0; i < state.length; i += 1) {
      const a = state[i];
      let vx = a.vx;
      let vz = a.vz;

      for (let j = 0; j < state.length; j += 1) {
        if (i === j) continue;
        const b = state[j];
        if (a.group != null && a.group === b.group) continue;

        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const dist = Math.hypot(dx, dz);
        const combined = a.radius + b.radius;
        // Responsibility: higher priority yields less.
        const resp = b.priority / (a.priority + b.priority);

        if (dist < combined - EPS) {
          // Soft depenetration — push away proportional to overlap.
          const nx = dist > EPS ? dx / dist : 1;
          const nz = dist > EPS ? dz / dist : 0;
          const overlap = combined - dist;
          const push = overlap * separationBoost * invDt * 0.35 * resp;
          vx -= nx * push;
          vz -= nz * push;
          continue;
        }

        // Relative position of B from A; relative velocity of B w.r.t. A.
        const rvx = b.vx - a.vx;
        const rvz = b.vz - a.vz;
        // Time to closest approach of B along relative motion.
        const relSpeedSq = rvx * rvx + rvz * rvz;
        if (relSpeedSq < EPS) continue;
        const t = -(dx * rvx + dz * rvz) / relSpeedSq;
        if (t < 0 || t > timeHorizon) continue;

        const cpx = dx + rvx * t;
        const cpz = dz + rvz * t;
        const cpDist = Math.hypot(cpx, cpz);
        if (cpDist >= combined) continue;

        // Escape direction for A: away from the closest-approach point of B.
        // Prefer pure lateral when nearly collinear so head-on pairs dodge sideway.
        let nx = cpDist > EPS ? cpx / cpDist : (dist > EPS ? dx / dist : 1);
        let nz = cpDist > EPS ? cpz / cpDist : (dist > EPS ? dz / dist : 0);
        if (cpDist < 0.08) {
          // Degenerate collinear approach — pick a stable perpendicular.
          const side = (i + j) % 2 === 0 ? 1 : -1;
          const len = Math.hypot(rvx, rvz) || 1;
          nx = (-rvz / len) * side;
          nz = (rvx / len) * side;
        }
        const urgency = 1 - t / timeHorizon;
        const deficit = combined - cpDist;
        // Reciprocal share: A changes velocity opposite the relative approach.
        // Since v_rel = vb - va, reducing approach means increasing va along +n
        // when n points from A toward B's CA point... actually push A opposite n
        // (away from B).
        const mag = (deficit / Math.max(t, 0.08)) * urgency * resp * 0.55;
        vx -= nx * mag;
        vz -= nz * mag;
      }

      // Clamp to max speed.
      const sp = Math.hypot(vx, vz);
      if (sp > a.maxSpeed) {
        const s = a.maxSpeed / sp;
        vx *= s;
        vz *= s;
      }
      a.vx = vx;
      a.vz = vz;
    }
  }

  for (const a of state) {
    const speed = Math.hypot(a.vx, a.vz);
    out.set(a.id, { vx: a.vx, vz: a.vz, speed });
  }
  return out;
}

/**
 * Map measured / commanded speed to walk vs trot intent. `trotMin` (legacy,
 * single threshold) still works for callers that don't track hysteresis;
 * pass `wasTrot` (previous frame's gait) to get a enter/exit band instead so
 * a speed hovering near the boundary doesn't chatter walk/trot every tick.
 * @param {number} speed m/s
 * @param {{
 *   walkMax?: number,
 *   trotMin?: number,
 *   trotEnter?: number,
 *   trotExit?: number,
 *   idleEps?: number,
 *   wasTrot?: boolean,
 * }} [opts]
 */
export function gaitFromSpeed(speed, opts = {}) {
  const idleEps = opts.idleEps ?? 0.08;
  const trotMin = opts.trotMin ?? 1.55;
  const trotEnter = opts.trotEnter ?? trotMin;
  const trotExit = opts.trotExit ?? trotEnter * 0.78;
  const s = Math.max(0, Number(speed) || 0);
  if (s < idleEps) return { moving: false, sprint: false, gait: 'idle' };
  const threshold = opts.wasTrot ? trotExit : trotEnter;
  if (s >= threshold) return { moving: true, sprint: true, gait: 'trot' };
  return { moving: true, sprint: false, gait: 'walk' };
}

/**
 * Accel-clamped speed ramp toward a target — bounded acceleration reads as
 * real momentum (an unbounded spring can jerk/overshoot instead of building
 * speed the way a running animal actually does). Dogs brake harder than
 * they accelerate, hence the asymmetric defaults.
 * @param {number} current m/s
 * @param {number} target m/s
 * @param {number} dt
 * @param {{ accel?: number, decel?: number }} [opts] m/s^2
 */
export function advanceLocomotionSpeed(current, target, dt, opts = {}) {
  const accel = opts.accel ?? 6.5;
  const decel = opts.decel ?? 9.5;
  const cur = Number(current) || 0;
  const tgt = Number(target) || 0;
  const rate = tgt > cur ? accel : decel;
  const maxDelta = Math.max(0, rate) * Math.max(0, Number(dt) || 0);
  const diff = tgt - cur;
  if (Math.abs(diff) <= maxDelta) return tgt;
  return cur + Math.sign(diff) * maxDelta;
}

/**
 * Build a preferred velocity from a unit direction and speed.
 * @param {number} dirX
 * @param {number} dirZ
 * @param {number} speed
 */
export function preferredVelocity(dirX, dirZ, speed) {
  const len = Math.hypot(dirX, dirZ);
  if (len < EPS || speed <= 0) return { vx: 0, vz: 0 };
  const s = speed / len;
  return { vx: dirX * s, vz: dirZ * s };
}
