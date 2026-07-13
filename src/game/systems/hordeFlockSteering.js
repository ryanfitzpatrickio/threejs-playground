/**
 * Pure boids steering for the Horde flow-mob (M1 of docs/horde-flow-mob-plan.md).
 *
 * No `three`, no mesh/scene imports — operates on plain agent objects so it
 * stays testable from a pure-node verify script and keeps the strobe-sensitive
 * InstancedMesh code (HordeProxySystem) separate from this math.
 *
 * Blend (per agent, run at the proxy 12 Hz tick):
 *   desired = W_flow      * field.sampleDir(pos)          // route around walls to player
 *           + W_cohesion  * (neighborCentroid - pos)      // clump into a body
 *           + W_align     * neighborHeadingAvg(ahead)     // follow the carved path
 *           + W_separate  * separationPush                 // no interpenetration
 *           - W_suppress  * normalize(∇suppression)         // recoil from firepower (M3)
 *   speed   = baseSpeed * congestionFalloff(localDensity)  // pile up at chokes
 *
 * Alignment is weighted toward neighbors AHEAD (lower field.sampleDistance) so
 * stragglers inherit the heading of the front → snaking columns in corridors.
 *
 * Suppression (M3): an optional scalar field whose gradient points uphill into
 * the fire. Agents subtract W_suppress·normalize(∇) so sustained fire between
 * the mob and the player builds a wall the front recoils from; when it decays
 * the mob surges back.
 *
 * Agent shape (mutated in place): {
 *   position: {x, y, z},   // y untouched here; caller samples ground
 *   heading:  number,      // radians, atan2(dx, dz) convention (matches yaw)
 *   yaw:      number,      // kept in sync with heading for rendering
 *   speed:    number,      // base move speed (m/s)
 *   distToGoal: number,    // cached each tick for M2 front-election ranking
 *   anim:     string,      // 'advance' | 'attack' | 'idle' (label only)
 *   health, hitTimer, ...  // read to skip dead / reacting agents
 * }
 */

export const DEFAULT_FLOCK_WEIGHTS = Object.freeze({
  // Flow dominates so the mob keeps pouring toward the player; cohesion +
  // alignment shape it into a body; separation keeps it from collapsing.
  flow: 1.0,
  cohesion: 0.22,
  align: 0.45,
  separate: 1.4,
  /** Neighbor radius for cohesion/alignment (m). Also the grid cell size. */
  neighborRadius: 3.0,
  /** Desired center-to-center spacing; closer than this pushes apart (m). */
  separationDistance: 1.3,
  /** Attack/idle when within this range of the player (m). */
  attackRadius: 4.5,
  /** Density (neighbors) at/above which speed is fully throttled. */
  congestionFull: 16,
  /** Slowest fraction of base speed when fully congested. */
  congestionFloor: 0.55,
  /**
   * Suppression term (M3): weight on −normalize(∇suppression). Set high enough
   * that a sustained deposit wall between the mob and the player OVERPOWERS the
   * unit flow term (flow=1.0) on the front agents so their net desired flips to
   * retreat; a couple of shots (small, fast-decaying deposit) never crosses it.
   */
  suppress: 1.7,
  /**
   * Only fear suppression whose gradient magnitude exceeds this (world units of
   * scalar per metre) — kills jitter from tiny residual deposits.
   */
  suppressGradientDeadzone: 0.15,
});

const EPS = 1e-6;

/**
 * Advance every live agent one steering tick. Mutates `agent.position`,
 * `agent.heading`, `agent.yaw`, `agent.anim`, `agent.distToGoal`.
 *
 * @param {object} args
 * @param {Array<object>} args.agents
 * @param {{sampleDir(x,z):{x,z}, sampleDistance(x,z):number}} args.field
 * @param {import('./UniformSpatialGrid.js').UniformSpatialGrid} args.grid - reused broadphase.
 * @param {{x:number,z:number}} args.playerPos
 * @param {number} args.delta - tick seconds.
 * @param {{sampleGradient(x,z):{x,z}}} [args.suppression] - M3 suppression field (optional).
 * @param {object} [args.weights]
 * @returns {{moved:number, attacking:number}}
 */
export function stepFlockSteering({
  agents,
  field,
  grid,
  playerPos,
  delta,
  suppression = null,
  weights = DEFAULT_FLOCK_WEIGHTS,
}) {
  const w = weights;
  if (!agents?.length || !field || !playerPos || delta <= 0) {
    return { moved: 0, attacking: 0 };
  }

  // Cache distToGoal per agent (M2 promotion ranking reads this) and gather
  // the movable set once.
  const movable = [];
  for (const agent of agents) {
    if (agent.health <= 0 || agent.anim === 'fallen') {
      agent.distToGoal = Infinity;
      continue;
    }
    const d = field.sampleDistance(agent.position.x, agent.position.z);
    agent.distToGoal = Number.isFinite(d) ? d : Infinity;
    movable.push(agent);
  }
  if (movable.length === 0) return { moved: 0, attacking: 0 };

  const aggregates = accumulateNeighborAggregates(movable, grid, w);

  let moved = 0;
  let attacking = 0;
  for (let i = 0; i < movable.length; i += 1) {
    const agent = movable[i];

    // Agents mid-hit-reaction hold position (label only; caller decays timer).
    if (agent.hitTimer > 0) {
      agent.anim = 'hit';
      continue;
    }

    const px = agent.position.x;
    const pz = agent.position.z;
    const toPlayerX = playerPos.x - px;
    const toPlayerZ = playerPos.z - pz;
    const toPlayer = Math.hypot(toPlayerX, toPlayerZ);

    const agg = aggregates[i];

    // Flow term — route to player around walls.
    const flow = field.sampleDir(px, pz);
    const flowLen = Math.hypot(flow.x, flow.z);
    const hasFlow = flowLen > EPS;

    let dx = 0;
    let dz = 0;

    // Arrival damping: as agents reach the melee disc around the player, ramp
    // the forward seek toward 0 so the pile is governed by separation (which
    // keeps spacing) instead of everyone driving into the same point.
    const arrival = toPlayer >= w.attackRadius
      ? 1
      : clamp01(toPlayer / Math.max(EPS, w.attackRadius));
    const flowGain = w.flow * arrival;

    if (hasFlow) {
      dx += flowGain * (flow.x / flowLen);
      dz += flowGain * (flow.z / flowLen);
    } else if (toPlayer > EPS) {
      // Zero-flow fallback (unreachable/goal cell): steer straight at the
      // player so agents don't stall, and keep separation below.
      dx += flowGain * (toPlayerX / toPlayer);
      dz += flowGain * (toPlayerZ / toPlayer);
    }

    // Cohesion — pull toward the neighbor centroid.
    if (agg.count > 0) {
      const cx = agg.sumX / agg.count - px;
      const cz = agg.sumZ / agg.count - pz;
      const clen = Math.hypot(cx, cz);
      if (clen > EPS) {
        dx += w.cohesion * arrival * (cx / clen);
        dz += w.cohesion * arrival * (cz / clen);
      }
    }

    // Alignment — match the average heading of neighbors AHEAD of us.
    if (agg.alignWeight > EPS) {
      const ax = agg.headingX / agg.alignWeight;
      const az = agg.headingZ / agg.alignWeight;
      const alen = Math.hypot(ax, az);
      if (alen > EPS) {
        dx += w.align * (ax / alen);
        dz += w.align * (az / alen);
      }
    }

    // Separation — push out of close neighbors (already magnitude-weighted).
    dx += w.separate * agg.sepX;
    dz += w.separate * agg.sepZ;

    // Suppression (M3) — flee UP the fire gradient. Gradient points toward
    // higher suppression, so subtract it. Deadzone kills residual-deposit
    // jitter. Strong enough to flip the front's net desired to retreat.
    if (suppression && w.suppress > 0) {
      const grad = suppression.sampleGradient(px, pz);
      const glen = Math.hypot(grad.x, grad.z);
      if (glen > (w.suppressGradientDeadzone ?? 0)) {
        dx -= w.suppress * (grad.x / glen);
        dz -= w.suppress * (grad.z / glen);
      }
    }

    const desiredLen = Math.hypot(dx, dz);

    // Congestion-based speed falloff — dense clusters slow, so the mob piles
    // up at chokes instead of pouring through at full speed.
    const congestion = clamp01((agg.count - 0) / Math.max(1, w.congestionFull));
    const speedScale = 1 - (1 - w.congestionFloor) * congestion;
    const baseSpeed = agent.speed * speedScale;

    // Behaviour label + facing when in melee range of the player.
    if (toPlayer <= w.attackRadius) {
      if (toPlayer > EPS) {
        agent.heading = Math.atan2(toPlayerX, toPlayerZ);
        agent.yaw = agent.heading;
      }
      agent.anim = 'attack';
      attacking += 1;
      // Still allow a little settling motion so they pack against the player.
    }

    if (desiredLen > EPS) {
      const nx = dx / desiredLen;
      const nz = dz / desiredLen;
      const travel = baseSpeed * delta;
      agent.position.x += nx * travel;
      agent.position.z += nz * travel;
      if (toPlayer > w.attackRadius) {
        agent.heading = Math.atan2(nx, nz);
        agent.yaw = agent.heading;
        agent.anim = 'advance';
        moved += 1;
      }
    } else if (toPlayer > w.attackRadius) {
      agent.anim = 'idle';
    }

    agent.animTime = (agent.animTime ?? 0) + delta;
  }

  return { moved, attacking };
}

/**
 * Rebuild the broadphase grid and accumulate, per movable agent:
 *   - neighbor centroid sums (cohesion),
 *   - heading sums weighted toward neighbors ahead (alignment),
 *   - a separation push vector (sum of unit escape vectors scaled by overlap).
 *
 * Returns a parallel array indexed to `movable`. Reuses the grid's
 * forEachCandidatePair broadphase; each unordered pair is visited once and
 * contributed to BOTH agents.
 */
export function accumulateNeighborAggregates(movable, grid, weights = DEFAULT_FLOCK_WEIGHTS) {
  const w = weights;
  const n = movable.length;
  const agg = new Array(n);
  for (let i = 0; i < n; i += 1) {
    movable[i]._flockIndex = i;
    agg[i] = {
      count: 0,
      sumX: 0,
      sumZ: 0,
      headingX: 0,
      headingZ: 0,
      alignWeight: 0,
      sepX: 0,
      sepZ: 0,
    };
  }

  const radius = w.neighborRadius;
  const radiusSq = radius * radius;
  const sepDist = w.separationDistance;

  grid.rebuild(movable, positionOf, Math.max(radius, sepDist));
  grid.forEachCandidatePair((a, b) => {
    const ia = a._flockIndex;
    const ib = b._flockIndex;
    const dx = b.position.x - a.position.x;
    const dz = b.position.z - a.position.z;
    const distSq = dx * dx + dz * dz;
    if (distSq > radiusSq) return;
    const dist = Math.sqrt(distSq);

    const aggA = agg[ia];
    const aggB = agg[ib];

    // Cohesion: each agent samples the other's position.
    aggA.count += 1;
    aggA.sumX += b.position.x;
    aggA.sumZ += b.position.z;
    aggB.count += 1;
    aggB.sumX += a.position.x;
    aggB.sumZ += a.position.z;

    // Alignment weighted toward the neighbor AHEAD (lower distToGoal). A
    // straggler (higher distToGoal) leans on its forward neighbor's heading;
    // the leader gets little pull back from the straggler.
    if (b.distToGoal < a.distToGoal) {
      const weight = 1;
      aggA.headingX += Math.sin(b.heading) * weight;
      aggA.headingZ += Math.cos(b.heading) * weight;
      aggA.alignWeight += weight;
    } else if (a.distToGoal < b.distToGoal) {
      const weight = 1;
      aggB.headingX += Math.sin(a.heading) * weight;
      aggB.headingZ += Math.cos(a.heading) * weight;
      aggB.alignWeight += weight;
    }

    // Separation: push apart when closer than the desired spacing. Uses an
    // inverse falloff (sepDist/dist - 1) clamped so it stays gentle in the
    // comfort band but rises steeply as agents approach contact — this is
    // what keeps the mob from interpenetrating under strong flow/cohesion.
    if (dist < sepDist && dist > EPS) {
      const push = Math.min(4, sepDist / dist - 1);
      const ux = dx / dist;
      const uz = dz / dist;
      aggA.sepX -= ux * push;
      aggA.sepZ -= uz * push;
      aggB.sepX += ux * push;
      aggB.sepZ += uz * push;
    } else if (dist <= EPS) {
      // Perfectly coincident — nudge deterministically so they separate.
      const jitter = ((ia - ib) % 2 === 0) ? 1 : -1;
      aggA.sepX -= jitter;
      aggB.sepX += jitter;
    }
  });

  return agg;
}

function positionOf(agent) {
  return agent.position;
}

/** Nearest-neighbor mean distance over the movable set (verify/debug helper). */
export function meanNearestNeighborDistance(movable, grid, sampleRadius = 6) {
  const n = movable.length;
  if (n < 2) return 0;
  for (let i = 0; i < n; i += 1) {
    movable[i]._flockIndex = i;
    movable[i]._nnBest = Infinity;
  }
  grid.rebuild(movable, positionOf, sampleRadius);
  grid.forEachCandidatePair((a, b) => {
    const dx = b.position.x - a.position.x;
    const dz = b.position.z - a.position.z;
    const distSq = dx * dx + dz * dz;
    if (distSq < a._nnBest) a._nnBest = distSq;
    if (distSq < b._nnBest) b._nnBest = distSq;
  });
  let sum = 0;
  let counted = 0;
  for (let i = 0; i < n; i += 1) {
    if (Number.isFinite(movable[i]._nnBest) && movable[i]._nnBest < Infinity) {
      sum += Math.sqrt(movable[i]._nnBest);
      counted += 1;
    }
  }
  return counted > 0 ? sum / counted : Infinity;
}

function clamp01(v) {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
