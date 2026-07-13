/**
 * Allocation-light 2D uniform grid for broad-phase neighbor queries.
 *
 * `forEachCandidatePair` visits every same/adjacent-cell pair exactly once.
 * When cellSize is at least the largest interaction distance, every potentially
 * interacting pair is included without the O(n^2) full-list scan.
 */
export class UniformSpatialGrid {
  constructor(cellSize = 1) {
    this.cellSize = Math.max(0.001, Number(cellSize) || 1);
    this.cells = new Map();
    this._bucketPool = [];
    this._activeBuckets = 0;
    this.itemCount = 0;
    this.candidatePairs = 0;
  }

  rebuild(items, positionOf, cellSize = this.cellSize) {
    this.cellSize = Math.max(0.001, Number(cellSize) || this.cellSize);
    this.cells.clear();
    this._activeBuckets = 0;
    this.itemCount = items.length;
    this.candidatePairs = 0;

    const inverseCellSize = 1 / this.cellSize;
    for (const item of items) {
      const position = positionOf(item);
      if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.z)) {
        continue;
      }
      const x = Math.floor(position.x * inverseCellSize);
      const z = Math.floor(position.z * inverseCellSize);
      const key = cellKey(x, z);
      let cell = this.cells.get(key);
      if (!cell) {
        const bucket = this._bucketPool[this._activeBuckets] ?? [];
        bucket.length = 0;
        this._bucketPool[this._activeBuckets] = bucket;
        this._activeBuckets += 1;
        cell = { x, z, items: bucket };
        this.cells.set(key, cell);
      }
      cell.items.push(item);
    }
    return this;
  }

  forEachCandidatePair(callback) {
    for (const cell of this.cells.values()) {
      const items = cell.items;
      for (let a = 0; a < items.length; a += 1) {
        for (let b = a + 1; b < items.length; b += 1) {
          this.candidatePairs += 1;
          callback(items[a], items[b]);
        }
      }

      // Half of the eight neighboring cells. This covers each cross-cell pair
      // exactly once regardless of Map insertion order.
      visitCrossCell(this, cell, 1, -1, callback);
      visitCrossCell(this, cell, 1, 0, callback);
      visitCrossCell(this, cell, 1, 1, callback);
      visitCrossCell(this, cell, 0, 1, callback);
    }
    return this.candidatePairs;
  }

  /**
   * Visit every item whose XZ position is within `radius` of (x, z).
   * Uses the grid for broadphase; `positionOf` must match rebuild() placement.
   * Callback receives `(item, distanceSq)`.
   */
  forEachInRadius(x, z, radius, positionOf, callback) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || radius < 0) {
      return 0;
    }
    const r = radius;
    const rSq = r * r;
    const inverseCellSize = 1 / this.cellSize;
    const minCx = Math.floor((x - r) * inverseCellSize);
    const maxCx = Math.floor((x + r) * inverseCellSize);
    const minCz = Math.floor((z - r) * inverseCellSize);
    const maxCz = Math.floor((z + r) * inverseCellSize);
    let visited = 0;
    for (let cx = minCx; cx <= maxCx; cx += 1) {
      for (let cz = minCz; cz <= maxCz; cz += 1) {
        const cell = this.cells.get(cellKey(cx, cz));
        if (!cell) continue;
        for (const item of cell.items) {
          const position = positionOf(item);
          if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.z)) {
            continue;
          }
          const dx = position.x - x;
          const dz = position.z - z;
          const distanceSq = dx * dx + dz * dz;
          if (distanceSq > rSq) continue;
          visited += 1;
          callback(item, distanceSq);
        }
      }
    }
    return visited;
  }

  snapshot() {
    return {
      cellSize: Number(this.cellSize.toFixed(3)),
      cells: this.cells.size,
      items: this.itemCount,
      candidatePairs: this.candidatePairs,
    };
  }
}

function visitCrossCell(grid, cell, offsetX, offsetZ, callback) {
  const neighbor = grid.cells.get(cellKey(cell.x + offsetX, cell.z + offsetZ));
  if (!neighbor) return;
  for (const first of cell.items) {
    for (const second of neighbor.items) {
      grid.candidatePairs += 1;
      callback(first, second);
    }
  }
}

function cellKey(x, z) {
  return `${x},${z}`;
}
