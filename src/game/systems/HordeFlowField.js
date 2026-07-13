/**
 * Grid flow field over a horde arena (docs/horde-flow-mob-plan.md, M0).
 *
 * Pure data structure — no `three` import, no renderer, no RAPIER. Must stay
 * importable from a plain-node verify script. Positions/directions are plain
 * `{x, z}` objects or parallel Float32Arrays; never THREE.Vector types.
 *
 * Pipeline:
 *   1. Rasterize `colliders` into a static walkable mask once (constructor).
 *      A collider blocks a cell iff it intrudes into the agent's vertical
 *      band `[floorY, floorY + agentHeight]` — this keeps the floor slab and
 *      high gate lintels/headers walkable while blocking walls/cover/pillars/
 *      gate posts. Obstacle AABBs are inflated by `agentRadius` for
 *      clearance before rasterizing.
 *   2. `update(goalX, goalZ)` runs an 8-connected Dijkstra/BFS integration
 *      field out from the goal cell (diagonal cost sqrt(2), no corner-cutting
 *      through a blocked orthogonal pair), then bakes a per-cell flow
 *      direction pointing down the distance gradient.
 *   3. `sampleDir` / `sampleDistance` read the baked field at a world
 *      position (nearest-cell).
 */

const SQRT2 = Math.SQRT2;
const DEFAULT_FLOOR_EPS = 0.25;

/** 8-connected neighbor offsets; index 0-3 are orthogonal, 4-7 are diagonal. */
const NEIGHBORS = [
  { dx: 1, dz: 0, cost: 1 },
  { dx: -1, dz: 0, cost: 1 },
  { dx: 0, dz: 1, cost: 1 },
  { dx: 0, dz: -1, cost: 1 },
  { dx: 1, dz: 1, cost: SQRT2 },
  { dx: 1, dz: -1, cost: SQRT2 },
  { dx: -1, dz: 1, cost: SQRT2 },
  { dx: -1, dz: -1, cost: SQRT2 },
];

export class HordeFlowField {
  /**
   * @param {object} opts
   * @param {Array<object>} opts.colliders - AABB colliders (minX/maxX/minZ/maxZ/bottomY/topY[/disabled]).
   * @param {{minX:number,maxX:number,minZ:number,maxZ:number}} opts.bounds - arena AABB (XZ).
   * @param {number} [opts.cellSize=1] - grid cell size in meters.
   * @param {number} [opts.agentRadius=0.4] - used to inflate obstacle AABBs for clearance.
   * @param {number} [opts.agentHeight=1.8] - vertical band height above floorY that counts as "in the way".
   * @param {number} [opts.floorY=0] - arena floor height.
   * @param {number} [opts.floorEps=0.25] - colliders whose topY <= floorY + floorEps are treated as floor, not obstacles.
   */
  constructor({
    colliders = [],
    bounds,
    cellSize = 1,
    agentRadius = 0.4,
    agentHeight = 1.8,
    floorY = 0,
    floorEps = DEFAULT_FLOOR_EPS,
  } = {}) {
    if (!bounds) throw new Error('HordeFlowField requires bounds {minX,maxX,minZ,maxZ}');
    this.cellSize = Math.max(0.05, Number(cellSize) || 1);
    this.agentRadius = Math.max(0, Number(agentRadius) || 0);
    this.agentHeight = Math.max(0.1, Number(agentHeight) || 1.8);
    this.floorY = Number(floorY) || 0;
    this.floorEps = Math.max(0, Number(floorEps) || DEFAULT_FLOOR_EPS);

    this.minX = bounds.minX;
    this.minZ = bounds.minZ;
    this.maxX = bounds.maxX;
    this.maxZ = bounds.maxZ;

    this.cols = Math.max(1, Math.ceil((this.maxX - this.minX) / this.cellSize));
    this.rows = Math.max(1, Math.ceil((this.maxZ - this.minZ) / this.cellSize));
    this.cellCount = this.cols * this.rows;

    // Static walkable mask: 1 = blocked, 0 = walkable.
    this.blocked = new Uint8Array(this.cellCount);

    // Per-cell integration distance (world units) + flow direction, baked by update().
    this.distToGoal = new Float32Array(this.cellCount).fill(Infinity);
    this.dirX = new Float32Array(this.cellCount);
    this.dirZ = new Float32Array(this.cellCount);

    this.goalCol = -1;
    this.goalRow = -1;
    this._blockedCount = 0;

    this._rasterize(colliders);

    // Dijkstra scratch reused across update() calls.
    this._visited = new Uint8Array(this.cellCount);
    this._heap = new MinHeap(this.cellCount);
  }

  // ── Grid <-> world ─────────────────────────────────────────────────────

  worldToCell(x, z) {
    const col = Math.floor((x - this.minX) / this.cellSize);
    const row = Math.floor((z - this.minZ) / this.cellSize);
    return {
      col: clampInt(col, 0, this.cols - 1),
      row: clampInt(row, 0, this.rows - 1),
    };
  }

  cellToWorld(col, row) {
    return {
      x: this.minX + (col + 0.5) * this.cellSize,
      z: this.minZ + (row + 0.5) * this.cellSize,
    };
  }

  cellIndex(col, row) {
    return row * this.cols + col;
  }

  isInBounds(col, row) {
    return col >= 0 && col < this.cols && row >= 0 && row < this.rows;
  }

  isBlockedCell(col, row) {
    if (!this.isInBounds(col, row)) return true;
    return this.blocked[this.cellIndex(col, row)] === 1;
  }

  // ── Rasterization ──────────────────────────────────────────────────────

  _rasterize(colliders) {
    this._blockedCount = 0;
    for (const collider of colliders) {
      if (!collider || collider.disabled) continue;
      const bottomY = Number(collider.bottomY);
      const topY = Number(collider.topY);
      if (!Number.isFinite(bottomY) || !Number.isFinite(topY)) continue;

      // Obstacle iff it intrudes into the agent's vertical band. This
      // excludes the floor slab (topY ~= floorY) and high gate headers
      // (bottomY well above floorY + agentHeight), and includes walls/cover/
      // pillars/gate posts that span through the band.
      const bandTop = this.floorY + this.agentHeight;
      const floorTop = this.floorY + this.floorEps;
      const intrudesBand = bottomY < bandTop && topY > floorTop;
      if (!intrudesBand) continue;

      const minX = Number(collider.minX) - this.agentRadius;
      const maxX = Number(collider.maxX) + this.agentRadius;
      const minZ = Number(collider.minZ) - this.agentRadius;
      const maxZ = Number(collider.maxZ) + this.agentRadius;
      if (!Number.isFinite(minX) || !Number.isFinite(maxX)
        || !Number.isFinite(minZ) || !Number.isFinite(maxZ)) continue;

      const c0 = this.worldToCell(minX, minZ);
      const c1 = this.worldToCell(maxX, maxZ);
      const colLo = Math.min(c0.col, c1.col);
      const colHi = Math.max(c0.col, c1.col);
      const rowLo = Math.min(c0.row, c1.row);
      const rowHi = Math.max(c0.row, c1.row);
      for (let row = rowLo; row <= rowHi; row += 1) {
        for (let col = colLo; col <= colHi; col += 1) {
          const idx = this.cellIndex(col, row);
          if (this.blocked[idx] === 0) {
            this.blocked[idx] = 1;
            this._blockedCount += 1;
          }
        }
      }
    }
  }

  // ── Integration field ──────────────────────────────────────────────────

  /**
   * Recompute the integration field (distance-to-goal) and bake per-cell
   * flow directions. Snaps the goal to the nearest walkable cell if the
   * requested position falls inside an obstacle.
   */
  update(goalX, goalZ) {
    this.distToGoal.fill(Infinity);
    this.dirX.fill(0);
    this.dirZ.fill(0);

    let { col: goalCol, row: goalRow } = this.worldToCell(goalX, goalZ);
    if (this.isBlockedCell(goalCol, goalRow)) {
      const snapped = this._findNearestWalkable(goalCol, goalRow);
      if (snapped) {
        goalCol = snapped.col;
        goalRow = snapped.row;
      }
    }
    this.goalCol = goalCol;
    this.goalRow = goalRow;

    if (this.isBlockedCell(goalCol, goalRow)) {
      // Entire grid is blocked (degenerate) — nothing reachable.
      return this;
    }

    const settled = this._visited;
    settled.fill(0);
    const heap = this._heap;
    heap.clear();

    const goalIdx = this.cellIndex(goalCol, goalRow);
    this.distToGoal[goalIdx] = 0;
    heap.push(goalIdx, 0);

    // Binary-heap Dijkstra: each cell is settled (popped) exactly once with
    // its final shortest distance, so this is correct for arbitrary
    // {1, sqrt2} edge costs (unlike a plain FIFO relaxation pass).
    while (heap.size > 0) {
      const idx = heap.pop();
      if (settled[idx]) continue;
      settled[idx] = 1;
      const col = idx % this.cols;
      const row = (idx - col) / this.cols;
      const dist = this.distToGoal[idx];

      for (const n of NEIGHBORS) {
        const ncol = col + n.dx;
        const nrow = row + n.dz;
        if (!this.isInBounds(ncol, nrow)) continue;
        const nIdx = this.cellIndex(ncol, nrow);
        if (this.blocked[nIdx] === 1 || settled[nIdx]) continue;

        // No corner-cutting: a diagonal step is disallowed if both
        // orthogonal neighbors it would cut across are blocked.
        if (n.dx !== 0 && n.dz !== 0) {
          const sideA = this.isBlockedCell(col + n.dx, row);
          const sideB = this.isBlockedCell(col, row + n.dz);
          if (sideA && sideB) continue;
        }

        const cand = dist + n.cost * this.cellSize;
        if (cand < this.distToGoal[nIdx] - 1e-9) {
          this.distToGoal[nIdx] = cand;
          heap.push(nIdx, cand);
        }
      }
    }

    this._bakeDirections();
    return this;
  }

  _bakeDirections() {
    for (let row = 0; row < this.rows; row += 1) {
      for (let col = 0; col < this.cols; col += 1) {
        const idx = this.cellIndex(col, row);
        if (this.blocked[idx] === 1) continue;
        const dist = this.distToGoal[idx];
        if (!Number.isFinite(dist)) continue;

        let bestDist = dist;
        let bestDx = 0;
        let bestDz = 0;
        for (const n of NEIGHBORS) {
          const ncol = col + n.dx;
          const nrow = row + n.dz;
          if (!this.isInBounds(ncol, nrow)) continue;
          const nIdx = this.cellIndex(ncol, nrow);
          if (this.blocked[nIdx] === 1) continue;
          if (n.dx !== 0 && n.dz !== 0) {
            const sideA = this.isBlockedCell(col + n.dx, row);
            const sideB = this.isBlockedCell(col, row + n.dz);
            if (sideA && sideB) continue;
          }
          const nDist = this.distToGoal[nIdx];
          if (nDist < bestDist) {
            bestDist = nDist;
            bestDx = n.dx;
            bestDz = n.dz;
          }
        }

        if (bestDx === 0 && bestDz === 0) {
          this.dirX[idx] = 0;
          this.dirZ[idx] = 0;
          continue;
        }
        const len = Math.hypot(bestDx, bestDz);
        this.dirX[idx] = bestDx / len;
        this.dirZ[idx] = bestDz / len;
      }
    }
  }

  _findNearestWalkable(col, row) {
    if (!this.isBlockedCell(col, row)) return { col, row };
    const maxRadius = Math.max(this.cols, this.rows);
    for (let radius = 1; radius <= maxRadius; radius += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
          const c = col + dx;
          const r = row + dz;
          if (!this.isInBounds(c, r)) continue;
          if (!this.isBlockedCell(c, r)) return { col: c, row: r };
        }
      }
    }
    return null;
  }

  // ── Sampling ────────────────────────────────────────────────────────────

  /** Normalized flow direction at a world position (nearest-cell). */
  sampleDir(x, z) {
    const { col, row } = this.worldToCell(x, z);
    const idx = this.cellIndex(col, row);
    if (this.blocked[idx] === 1) return { x: 0, z: 0 };
    return { x: this.dirX[idx], z: this.dirZ[idx] };
  }

  /** Integration distance-to-goal at a world position (nearest-cell). */
  sampleDistance(x, z) {
    const { col, row } = this.worldToCell(x, z);
    const idx = this.cellIndex(col, row);
    return this.distToGoal[idx];
  }

  // ── Debug ───────────────────────────────────────────────────────────────

  snapshot() {
    let reachable = 0;
    for (let i = 0; i < this.cellCount; i += 1) {
      if (this.blocked[i] === 0 && Number.isFinite(this.distToGoal[i])) reachable += 1;
    }
    return {
      cols: this.cols,
      rows: this.rows,
      cellCount: this.cellCount,
      cellSize: this.cellSize,
      blockedCells: this._blockedCount,
      reachableCells: reachable,
      goalCol: this.goalCol,
      goalRow: this.goalRow,
    };
  }
}

function clampInt(v, lo, hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/**
 * Minimal binary min-heap of (cellIndex, priority) pairs, backed by typed
 * arrays sized to the grid's cell count. Stale entries (a cell pushed more
 * than once with a smaller distance found later) are skipped on pop via the
 * caller's `settled` check rather than removed in place.
 */
class MinHeap {
  constructor(capacity) {
    // A cell can be re-pushed once per relaxing neighbor (<=8 directions),
    // so size generously to avoid growth checks in the hot path.
    const cap = Math.max(16, capacity * 8);
    this._idx = new Int32Array(cap);
    this._pri = new Float64Array(cap);
    this.size = 0;
  }

  clear() {
    this.size = 0;
  }

  push(idx, priority) {
    if (this.size >= this._idx.length) this._grow();
    let i = this.size;
    this._idx[i] = idx;
    this._pri[i] = priority;
    this.size += 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this._pri[parent] <= this._pri[i]) break;
      this._swap(parent, i);
      i = parent;
    }
  }

  pop() {
    const top = this._idx[0];
    this.size -= 1;
    if (this.size > 0) {
      this._idx[0] = this._idx[this.size];
      this._pri[0] = this._pri[this.size];
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = i * 2 + 2;
        let smallest = i;
        if (left < this.size && this._pri[left] < this._pri[smallest]) smallest = left;
        if (right < this.size && this._pri[right] < this._pri[smallest]) smallest = right;
        if (smallest === i) break;
        this._swap(smallest, i);
        i = smallest;
      }
    }
    return top;
  }

  _swap(a, b) {
    const ti = this._idx[a]; this._idx[a] = this._idx[b]; this._idx[b] = ti;
    const tp = this._pri[a]; this._pri[a] = this._pri[b]; this._pri[b] = tp;
  }

  _grow() {
    const grownIdx = new Int32Array(this._idx.length * 2);
    grownIdx.set(this._idx);
    this._idx = grownIdx;
    const grownPri = new Float64Array(this._pri.length * 2);
    grownPri.set(this._pri);
    this._pri = grownPri;
  }
}
