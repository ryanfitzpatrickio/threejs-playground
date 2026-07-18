/**
 * Horde navmesh (navcat) over arena colliders.
 *
 * Static bake excludes interactive doors so boxcar bays stay walkable on the
 * mesh. Closed doors are applied as **dynamic AABB obstacles** (navcat-style
 * non-walkable marks without a full re-bake) and can re-stamp the flow field.
 *
 * Uses tiled generation for the train-yard scale (better tile locality for
 * future partial rebuilds).
 */

import {
  DEFAULT_QUERY_FILTER,
  createFindNearestPolyResult,
  findNearestPoly,
  findPath,
  moveAlongSurface,
} from 'navcat';
import { generateTiledNavMesh } from 'navcat/blocks';

const DEFAULT_HALF_EXTENTS = Object.freeze([1.0, 1.5, 1.0]);

/** Door colliders are dynamic obstacles, not static bake input. */
export function isDoorCollider(collider) {
  const name = String(collider?.name ?? '');
  return /\bDoor\b/i.test(name);
}

/**
 * @param {object} opts
 * @param {Array<object>} opts.colliders
 * @param {{minX:number,maxX:number,minZ:number,maxZ:number}} opts.bounds
 * @param {number} [opts.floorY=0]
 * @param {number} [opts.agentRadius=0.35]
 * @param {number} [opts.agentHeight=1.8]
 * @param {number} [opts.floorEps=0.25]
 * @param {number} [opts.cellSize=0.3]
 * @param {boolean} [opts.includeDoors=false] — static bake usually omits doors
 */
export function bakeHordeNavMesh({
  colliders = [],
  bounds,
  floorY = 0,
  agentRadius = 0.35,
  agentHeight = 1.8,
  floorEps = 0.25,
  cellSize = 0.3,
  includeDoors = false,
} = {}) {
  if (!bounds) {
    return { ok: false, reason: 'missing-bounds', navMesh: null };
  }

  const positions = [];
  const indices = [];

  const pad = 1.0;
  appendBoxTriangles(positions, indices, {
    minX: bounds.minX - pad,
    maxX: bounds.maxX + pad,
    minY: floorY - 0.25,
    maxY: floorY,
    minZ: bounds.minZ - pad,
    maxZ: bounds.maxZ + pad,
  });

  const bandTop = floorY + agentHeight;
  const floorTop = floorY + floorEps;
  let obstacleCount = 0;
  let skippedDoors = 0;

  for (const collider of colliders) {
    if (!collider || collider.disabled) continue;
    if (!includeDoors && isDoorCollider(collider)) {
      skippedDoors += 1;
      continue;
    }
    const bottomY = Number(collider.bottomY);
    const topY = Number(collider.topY);
    const minX = Number(collider.minX);
    const maxX = Number(collider.maxX);
    const minZ = Number(collider.minZ);
    const maxZ = Number(collider.maxZ);
    if (![bottomY, topY, minX, maxX, minZ, maxZ].every(Number.isFinite)) continue;

    const intrudesBand = bottomY < bandTop && topY > floorTop;
    if (!intrudesBand) continue;

    appendBoxTriangles(positions, indices, {
      minX,
      maxX,
      minY: Math.max(floorY, bottomY),
      maxY: Math.min(bandTop + 0.5, topY),
      minZ,
      maxZ,
    });
    obstacleCount += 1;
  }

  if (positions.length < 9 || indices.length < 3) {
    return { ok: false, reason: 'empty-geometry', navMesh: null, obstacleCount, skippedDoors };
  }

  const cellHeight = 0.2;
  const walkableRadiusWorld = Math.max(0.15, agentRadius);
  const walkableHeightWorld = Math.max(1.2, agentHeight);
  const walkableClimbWorld = 0.45;
  const tileSizeVoxels = 40;
  const tileSizeWorld = tileSizeVoxels * cellSize;
  const borderSize = 3;

  const options = {
    cellSize,
    cellHeight,
    tileSizeVoxels,
    tileSizeWorld,
    walkableRadiusWorld,
    walkableRadiusVoxels: Math.ceil(walkableRadiusWorld / cellSize),
    walkableClimbWorld,
    walkableClimbVoxels: Math.ceil(walkableClimbWorld / cellHeight),
    walkableHeightWorld,
    walkableHeightVoxels: Math.ceil(walkableHeightWorld / cellHeight),
    walkableSlopeAngleDegrees: 50,
    borderSize,
    minRegionArea: 8,
    mergeRegionArea: 20,
    maxSimplificationError: 1.3,
    maxEdgeLength: 12,
    maxVerticesPerPoly: 5,
    detailSampleDistance: cellSize * 6,
    detailSampleMaxError: cellHeight,
  };

  let result;
  try {
    result = generateTiledNavMesh(
      {
        positions: new Float32Array(positions),
        indices: new Uint32Array(indices),
      },
      options,
    );
  } catch (error) {
    return {
      ok: false,
      reason: 'bake-threw',
      error: String(error?.message ?? error),
      navMesh: null,
      obstacleCount,
      skippedDoors,
    };
  }

  const navMesh = result?.navMesh ?? null;
  if (!navMesh) {
    return { ok: false, reason: 'bake-empty', navMesh: null, obstacleCount, skippedDoors };
  }

  return {
    ok: true,
    navMesh,
    obstacleCount,
    skippedDoors,
    triangleCount: indices.length / 3,
    vertexCount: positions.length / 3,
    cellSize,
    tileSizeWorld,
    agentRadius: walkableRadiusWorld,
    agentHeight: walkableHeightWorld,
    floorY,
    mode: 'tiled',
  };
}

/**
 * Closed-door (and other) AABBs treated as non-walkable without re-baking.
 * Mirrors navcat dynamic-obstacle intent for discrete toggles (doors).
 */
export class DynamicNavObstacles {
  constructor() {
    /** @type {Array<{minX:number,maxX:number,minZ:number,maxZ:number,bottomY?:number,topY?:number,id?:string}>} */
    this.boxes = [];
  }

  clear() {
    this.boxes.length = 0;
  }

  /**
   * @param {Array<object>} colliders live level colliders (doors use disabled when open)
   */
  setFromDoorColliders(colliders = []) {
    this.boxes.length = 0;
    for (const c of colliders) {
      if (!c || c.disabled || !isDoorCollider(c)) continue;
      const minX = Number(c.minX);
      const maxX = Number(c.maxX);
      const minZ = Number(c.minZ);
      const maxZ = Number(c.maxZ);
      if (![minX, maxX, minZ, maxZ].every(Number.isFinite)) continue;
      // Inflate slightly so agents don't skim the panel.
      const pad = 0.12;
      this.boxes.push({
        id: c.name,
        minX: minX - pad,
        maxX: maxX + pad,
        minZ: minZ - pad,
        maxZ: maxZ + pad,
        bottomY: Number(c.bottomY),
        topY: Number(c.topY),
      });
    }
    return this.boxes.length;
  }

  containsXZ(x, z) {
    for (const b of this.boxes) {
      if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) return true;
    }
    return false;
  }

  snapshot() {
    return { count: this.boxes.length, ids: this.boxes.map((b) => b.id).filter(Boolean) };
  }
}

/**
 * Query helper wrapping a baked navMesh + optional dynamic obstacles.
 */
export class HordeNavQuery {
  constructor(navMesh, {
    halfExtents = DEFAULT_HALF_EXTENTS,
    floorY = 0,
    dynamicObstacles = null,
  } = {}) {
    this.navMesh = navMesh;
    this.halfExtents = halfExtents;
    this.floorY = floorY;
    /** @type {DynamicNavObstacles|null} */
    this.dynamicObstacles = dynamicObstacles;
    this._nearest = createFindNearestPolyResult();
    this._filter = DEFAULT_QUERY_FILTER;
  }

  setDynamicObstacles(dynamicObstacles) {
    this.dynamicObstacles = dynamicObstacles;
  }

  /**
   * @returns {{ ok:boolean, x:number, y:number, z:number, nodeRef:number }}
   */
  project(x, z, y = this.floorY) {
    if (this.dynamicObstacles?.containsXZ(x, z)) {
      return { ok: false, x, y, z, nodeRef: 0 };
    }
    if (!this.navMesh) {
      return { ok: false, x, y, z, nodeRef: 0 };
    }
    findNearestPoly(
      this._nearest,
      this.navMesh,
      [x, y, z],
      this.halfExtents,
      this._filter,
    );
    if (!this._nearest.success) {
      return { ok: false, x, y, z, nodeRef: 0 };
    }
    const p = this._nearest.position;
    // Nearest poly might still land inside a closed door footprint — reject.
    if (this.dynamicObstacles?.containsXZ(p[0], p[2])) {
      return { ok: false, x, y, z, nodeRef: 0 };
    }
    return {
      ok: true,
      x: p[0],
      y: p[1],
      z: p[2],
      nodeRef: this._nearest.nodeRef,
    };
  }

  isWalkable(x, z, y = this.floorY) {
    if (this.dynamicObstacles?.containsXZ(x, z)) return false;
    return this.project(x, z, y).ok;
  }

  /**
   * @returns {{ ok:boolean, x:number, y:number, z:number, nodeRef:number }}
   */
  moveAlong(fromX, fromZ, toX, toZ, y = this.floorY) {
    if (this.dynamicObstacles?.containsXZ(toX, toZ)) {
      // Stay put if the destination is a closed door.
      return this.project(fromX, fromZ, y);
    }
    if (!this.navMesh) {
      return { ok: false, x: toX, y, z: toZ, nodeRef: 0 };
    }
    const start = this.project(fromX, fromZ, y);
    if (!start.ok || !start.nodeRef) {
      return this.project(toX, toZ, y);
    }
    try {
      const moved = moveAlongSurface(
        this.navMesh,
        start.nodeRef,
        [start.x, start.y, start.z],
        [toX, y, toZ],
        this._filter,
      );
      if (moved?.success && moved.position) {
        const mx = moved.position[0];
        const mz = moved.position[2];
        if (this.dynamicObstacles?.containsXZ(mx, mz)) {
          return start;
        }
        return {
          ok: true,
          x: mx,
          y: moved.position[1],
          z: mz,
          nodeRef: moved.nodeRef ?? start.nodeRef,
        };
      }
    } catch {
      // fall through
    }
    return this.project(toX, toZ, y);
  }

  /**
   * @returns {{ ok:boolean, points:Array<{x:number,y:number,z:number}> }}
   */
  findPath(startX, startZ, endX, endZ, y = this.floorY) {
    if (!this.navMesh) {
      return { ok: false, points: [] };
    }
    try {
      const path = findPath(
        this.navMesh,
        [startX, y, startZ],
        [endX, y, endZ],
        this.halfExtents,
        this._filter,
      );
      if (!path?.success || !path.path?.length) {
        return { ok: false, points: [] };
      }
      return {
        ok: true,
        points: path.path.map((entry) => {
          const p = entry.position ?? entry;
          return { x: p[0], y: p[1], z: p[2] };
        }),
      };
    } catch {
      return { ok: false, points: [] };
    }
  }

  snapshot() {
    return {
      ready: Boolean(this.navMesh),
      halfExtents: [...this.halfExtents],
      floorY: this.floorY,
      dynamicObstacles: this.dynamicObstacles?.snapshot?.() ?? { count: 0 },
    };
  }
}

/**
 * Append axis-aligned box as 12 triangles (CCW, right-handed).
 */
export function appendBoxTriangles(positions, indices, box) {
  const { minX, maxX, minY, maxY, minZ, maxZ } = box;
  if (!(maxX > minX && maxY > minY && maxZ > minZ)) return;

  const base = positions.length / 3;
  const verts = [
    [minX, minY, minZ],
    [maxX, minY, minZ],
    [maxX, minY, maxZ],
    [minX, minY, maxZ],
    [minX, maxY, minZ],
    [maxX, maxY, minZ],
    [maxX, maxY, maxZ],
    [minX, maxY, maxZ],
  ];
  for (const v of verts) {
    positions.push(v[0], v[1], v[2]);
  }

  const faces = [
    [4, 5, 6], [4, 6, 7],
    [0, 2, 1], [0, 3, 2],
    [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6],
    [3, 0, 4], [3, 4, 7],
  ];
  for (const f of faces) {
    indices.push(base + f[0], base + f[1], base + f[2]);
  }
}
