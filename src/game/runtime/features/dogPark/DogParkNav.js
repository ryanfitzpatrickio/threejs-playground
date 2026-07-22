/**
 * Dog-park navigation: navcat bake (same stack as horde) + path following.
 *
 * Not full Polyanya (any-angle search on triangulation) — navcat already gives
 * poly-path + string-pull quality corridors. For a finite park lot this is the
 * right reuse; swap the query backend later if Polyanya is required.
 */

import {
  bakeHordeNavMesh,
  HordeNavQuery,
  appendBoxTriangles,
} from '../../../systems/HordeNavMesh.js';

const DEFAULT_AGENT_RADIUS = 0.32;
const DEFAULT_AGENT_HEIGHT = 0.95;
const DEFAULT_CELL = 0.35;

/**
 * Approximate an ellipse as a ring of boxes for nav bake (lake hole).
 * @param {number[]} positions
 * @param {number[]} indices
 * @param {{ x: number, z: number, radiusX: number, radiusZ: number }} lake
 * @param {number} floorY
 * @param {number} [segments]
 */
export function appendLakeObstacle(positions, indices, lake, floorY = 0, segments = 16) {
  if (!lake) return 0;
  const rx = (lake.radiusX ?? 4) + 0.9;
  const rz = (lake.radiusZ ?? 3) + 0.9;
  const cx = lake.x ?? 0;
  const cz = lake.z ?? 0;
  // Fan of trapezoid boxes around the shore — coarse but blocks paths through water.
  let count = 0;
  for (let i = 0; i < segments; i += 1) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const x0 = cx + Math.cos(a0) * rx;
    const z0 = cz + Math.sin(a0) * rz;
    const x1 = cx + Math.cos(a1) * rx;
    const z1 = cz + Math.sin(a1) * rz;
    const minX = Math.min(cx * 0.15 + x0 * 0.85, cx * 0.15 + x1 * 0.85, x0, x1);
    const maxX = Math.max(cx * 0.15 + x0 * 0.85, cx * 0.15 + x1 * 0.85, x0, x1);
    const minZ = Math.min(cz * 0.15 + z0 * 0.85, cz * 0.15 + z1 * 0.85, z0, z1);
    const maxZ = Math.max(cz * 0.15 + z0 * 0.85, cz * 0.15 + z1 * 0.85, z0, z1);
    if (maxX - minX < 0.2 || maxZ - minZ < 0.2) continue;
    appendBoxTriangles(positions, indices, {
      minX,
      maxX,
      minY: floorY,
      maxY: floorY + 1.2,
      minZ,
      maxZ,
    });
    count += 1;
  }
  // Solid center disc so the middle is non-walkable even if ring is thin.
  appendBoxTriangles(positions, indices, {
    minX: cx - rx * 0.72,
    maxX: cx + rx * 0.72,
    minY: floorY,
    maxY: floorY + 1.2,
    minZ: cz - rz * 0.72,
    maxZ: cz + rz * 0.72,
  });
  return count + 1;
}

/**
 * Bake a walkable mesh for the fenced park lot.
 * Lake is injected as synthetic colliders so navcat carves a water hole.
 * @param {{
 *   colliders?: object[],
 *   bounds: { minX: number, maxX: number, minZ: number, maxZ: number },
 *   lake?: { x: number, z: number, radiusX?: number, radiusZ?: number } | null,
 *   floorY?: number,
 *   agentRadius?: number,
 *   cellSize?: number,
 * }} opts
 */
export function bakeDogParkNavMesh(opts) {
  const {
    colliders = [],
    bounds,
    lake = null,
    floorY = 0,
    agentRadius = DEFAULT_AGENT_RADIUS,
    cellSize = DEFAULT_CELL,
  } = opts;

  const lakeColliders = lake ? lakeToColliders(lake, floorY) : [];
  const bake = bakeHordeNavMesh({
    colliders: [...colliders, ...lakeColliders],
    bounds,
    floorY,
    agentRadius,
    agentHeight: DEFAULT_AGENT_HEIGHT,
    cellSize,
    includeDoors: true,
  });
  if (bake.ok) {
    bake.lakeObstacles = lakeColliders.length;
  }
  return bake;
}

/**
 * @param {{ x: number, z: number, radiusX?: number, radiusZ?: number }} lake
 * @param {number} floorY
 */
export function lakeToColliders(lake, floorY = 0) {
  if (!lake) return [];
  const rx = (lake.radiusX ?? 4) + 0.85;
  const rz = (lake.radiusZ ?? 3) + 0.85;
  const cx = lake.x ?? 0;
  const cz = lake.z ?? 0;
  const boxes = [];
  const segments = 14;
  for (let i = 0; i < segments; i += 1) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const x0 = cx + Math.cos(a0) * rx;
    const z0 = cz + Math.sin(a0) * rz;
    const x1 = cx + Math.cos(a1) * rx;
    const z1 = cz + Math.sin(a1) * rz;
    const midX = (x0 + x1) * 0.5;
    const midZ = (z0 + z1) * 0.5;
    // Box from center toward mid — fills disc as a pie of AABBs.
    boxes.push({
      name: `Lake Obstacle ${i}`,
      minX: Math.min(cx, midX) - 0.35,
      maxX: Math.max(cx, midX) + 0.35,
      minZ: Math.min(cz, midZ) - 0.35,
      maxZ: Math.max(cz, midZ) + 0.35,
      bottomY: floorY,
      topY: floorY + 1.4,
    });
  }
  boxes.push({
    name: 'Lake Obstacle Core',
    minX: cx - rx * 0.65,
    maxX: cx + rx * 0.65,
    minZ: cz - rz * 0.65,
    maxZ: cz + rz * 0.65,
    bottomY: floorY,
    topY: floorY + 1.4,
  });
  return boxes;
}

/**
 * Steer toward the next path waypoint (string-pulled corridor).
 * @param {{ x: number, z: number }} from
 * @param {Array<{ x: number, z: number }>} points
 * @param {{ arrive?: number, lookahead?: number }} [opts]
 * @returns {{
 *   ok: boolean,
 *   dirX: number,
 *   dirZ: number,
 *   waypointIndex: number,
 *   remaining: number,
 *   arrived: boolean,
 * }}
 */
export function pathSteer(from, points, opts = {}) {
  const arrive = opts.arrive ?? 0.55;
  const lookahead = opts.lookahead ?? 0.85;
  if (!points?.length) {
    return {
      ok: false, dirX: 0, dirZ: 0, waypointIndex: 0, remaining: 0, arrived: true,
    };
  }
  // Skip waypoints already reached.
  let i = 0;
  while (i < points.length - 1) {
    const dx = points[i].x - from.x;
    const dz = points[i].z - from.z;
    if (Math.hypot(dx, dz) > arrive) break;
    i += 1;
  }
  const goal = points[points.length - 1];
  const distGoal = Math.hypot(goal.x - from.x, goal.z - from.z);
  if (distGoal < arrive) {
    return {
      ok: true, dirX: 0, dirZ: 0, waypointIndex: points.length - 1, remaining: distGoal, arrived: true,
    };
  }

  // Look ahead along the polyline for smoother steering.
  let target = points[i];
  let acc = 0;
  for (let j = i; j < points.length - 1 && acc < lookahead; j += 1) {
    const seg = Math.hypot(points[j + 1].x - points[j].x, points[j + 1].z - points[j].z);
    acc += seg;
    target = points[j + 1];
  }
  let dx = target.x - from.x;
  let dz = target.z - from.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-5) {
    return {
      ok: true, dirX: 0, dirZ: 0, waypointIndex: i, remaining: distGoal, arrived: false,
    };
  }
  dx /= len;
  dz /= len;
  return {
    ok: true,
    dirX: dx,
    dirZ: dz,
    waypointIndex: i,
    remaining: distGoal,
    arrived: false,
  };
}

/**
 * Runtime nav helper for the dog park.
 */
export class DogParkNav {
  /**
   * @param {{
   *   colliders?: object[],
   *   bounds: object,
   *   lake?: object|null,
   *   floorY?: number,
   * }} opts
   */
  constructor(opts) {
    this.bounds = opts.bounds;
    this.lake = opts.lake ?? null;
    this.floorY = opts.floorY ?? 0;
    this.bake = bakeDogParkNavMesh({
      colliders: opts.colliders ?? [],
      bounds: opts.bounds,
      lake: opts.lake,
      floorY: this.floorY,
    });
    this.query = this.bake.ok
      ? new HordeNavQuery(this.bake.navMesh, { floorY: this.floorY })
      : null;
    /** @type {Map<string, { points: Array<{x:number,y:number,z:number}>, goal: {x:number,z:number}, version: number }>} */
    this._paths = new Map();
    this._version = 0;
  }

  get ready() {
    return Boolean(this.query?.navMesh);
  }

  isWalkable(x, z) {
    if (!this.query) {
      return this._fallbackWalkable(x, z);
    }
    return this.query.isWalkable(x, z, this.floorY);
  }

  /**
   * Project onto mesh; fallback clamps into bounds away from lake.
   * @returns {{ ok: boolean, x: number, z: number }}
   */
  project(x, z) {
    if (this.query) {
      const p = this.query.project(x, z, this.floorY);
      if (p.ok) return { ok: true, x: p.x, z: p.z };
    }
    if (!this._fallbackWalkable(x, z)) return { ok: false, x, z };
    return { ok: true, x, z };
  }

  /**
   * Find a path; caches per agent id until goal moves.
   * @param {string} agentId
   * @param {{ x: number, z: number }} from
   * @param {{ x: number, z: number }} goal
   * @param {{ force?: boolean, goalEps?: number }} [opts]
   */
  ensurePath(agentId, from, goal, opts = {}) {
    const goalEps = opts.goalEps ?? 0.75;
    const cached = this._paths.get(agentId);
    if (
      !opts.force
      && cached
      && Math.hypot(cached.goal.x - goal.x, cached.goal.z - goal.z) < goalEps
      && cached.points.length
    ) {
      return cached;
    }

    let points = [];
    if (this.query) {
      const path = this.query.findPath(from.x, from.z, goal.x, goal.z, this.floorY);
      if (path.ok && path.points.length) {
        points = path.points;
      }
    }
    if (!points.length) {
      // Straight-line fallback (still better with walkable goal projection).
      const g = this.project(goal.x, goal.z);
      points = [
        { x: from.x, y: this.floorY, z: from.z },
        { x: g.ok ? g.x : goal.x, y: this.floorY, z: g.ok ? g.z : goal.z },
      ];
    }
    const entry = {
      points,
      goal: { x: goal.x, z: goal.z },
      version: (this._version += 1),
    };
    this._paths.set(agentId, entry);
    return entry;
  }

  /**
   * @param {string} agentId
   * @param {{ x: number, z: number }} from
   * @param {{ x: number, z: number }} goal
   * @param {{ force?: boolean }} [opts]
   */
  steerTo(agentId, from, goal, opts = {}) {
    const path = this.ensurePath(agentId, from, goal, opts);
    return {
      ...pathSteer(from, path.points),
      pathVersion: path.version,
      pointCount: path.points.length,
    };
  }

  /** Pick a random walkable point in bounds (for wander). */
  randomPoint(rng = Math.random, pad = 2.5, attempts = 24) {
    const { minX, maxX, minZ, maxZ } = this.bounds;
    for (let i = 0; i < attempts; i += 1) {
      const x = minX + pad + rng() * Math.max(0.1, maxX - minX - pad * 2);
      const z = minZ + pad + rng() * Math.max(0.1, maxZ - minZ - pad * 2);
      if (this.isWalkable(x, z)) return { x, z };
    }
    return {
      x: (minX + maxX) * 0.5,
      z: (minZ + maxZ) * 0.5,
    };
  }

  _fallbackWalkable(x, z) {
    const { minX, maxX, minZ, maxZ } = this.bounds ?? {};
    if (![minX, maxX, minZ, maxZ].every(Number.isFinite)) return true;
    if (x < minX + 1.5 || x > maxX - 1.5 || z < minZ + 1.5 || z > maxZ - 1.5) return false;
    if (this.lake) {
      const dx = (x - this.lake.x) / ((this.lake.radiusX ?? 4) + 1.1);
      const dz = (z - this.lake.z) / ((this.lake.radiusZ ?? 3) + 1.1);
      if (dx * dx + dz * dz < 1) return false;
    }
    return true;
  }

  snapshot() {
    return {
      ready: this.ready,
      bake: this.bake?.ok
        ? {
            ok: true,
            obstacles: this.bake.obstacleCount,
            triangles: this.bake.triangleCount,
            cellSize: this.bake.cellSize,
          }
        : { ok: false, reason: this.bake?.reason ?? 'none' },
      cachedPaths: this._paths.size,
      query: this.query?.snapshot?.() ?? null,
    };
  }

  dispose() {
    this._paths.clear();
    this.query = null;
    this.bake = null;
  }
}
