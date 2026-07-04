// Vendored from SkyeShark's level-maker (~/source/level-maker/src) — a socket-based
// 3D Wave Function Collapse engine (Three-independent). Kept verbatim; the office
// tileset + grid setup that drive it live alongside in ../. See
// docs/office-interior-wfc-plan.md.

import { Cell } from './Cell.js';
import { DIRECTIONS, DIRS } from './Neighborhood.js';

export class Grid3D {
  constructor({ width = 40, height = 4, depth = 40, cellSize = 1, originX = 0, originZ = 0 } = {}) {
    this.width = width;
    this.height = height;
    this.depth = depth;
    this.cellSize = cellSize;
    this.originX = originX;
    this.originZ = originZ;
    this.cells = [];

    for (let y = 0; y < height; y++) {
      for (let z = 0; z < depth; z++) {
        for (let x = 0; x < width; x++) {
          this.cells.push(new Cell(x, y, z));
        }
      }
    }
  }

  _index(x, y, z) {
    return (y * this.depth + z) * this.width + x;
  }

  inBounds(x, y, z) {
    return x >= 0 && x < this.width && y >= 0 && y < this.height && z >= 0 && z < this.depth;
  }

  getCell(x, y, z) {
    if (!this.inBounds(x, y, z)) return null;
    return this.cells[this._index(x, y, z)] || null;
  }

  cellAtWorld(x, y, z) {
    const gx = Math.floor((x - this.originX) / this.cellSize);
    const gz = Math.floor((z - this.originZ) / this.cellSize);
    const gy = Math.max(0, Math.min(this.height - 1, Math.round(y / this.cellSize)));
    return this.getCell(gx, gy, gz);
  }

  getNeighbor(cell, dir) {
    const d = DIRS[dir];
    return this.getCell(cell.x + d.x, cell.y + d.y, cell.z + d.z);
  }

  neighbors(cell) {
    const out = {};
    for (const dir of DIRECTIONS) {
      out[dir] = this.getNeighbor(cell, dir);
    }
    return out;
  }

  getAllCells() {
    return this.cells;
  }

  getWorldPosition(cell) {
    return {
      x: this.originX + (cell.x + 0.5) * this.cellSize,
      y: cell.y * this.cellSize,
      z: this.originZ + (cell.z + 0.5) * this.cellSize,
    };
  }

  worldToCell(x, z, y = 0) {
    return {
      x: Math.floor((x - this.originX) / this.cellSize),
      y: Math.max(0, Math.min(this.height - 1, Math.round(y / this.cellSize))),
      z: Math.floor((z - this.originZ) / this.cellSize),
    };
  }

  forEach(callback) {
    for (const cell of this.cells) callback(cell);
  }

  clearGeneratedData(changedRegion = null) {
    for (const cell of this.cells) {
      if (changedRegion && !this.cellInBoundsRegion(cell, changedRegion)) continue;
      if (!cell.lockedByUser) {
        cell.clearGeneratedData();
      }
    }
  }

  cellInBoundsRegion(cell, region) {
    return (
      cell.x >= region.minX && cell.x <= region.maxX &&
      cell.y >= region.minY && cell.y <= region.maxY &&
      cell.z >= region.minZ && cell.z <= region.maxZ
    );
  }

  getBounds() {
    return {
      minX: 0,
      minY: 0,
      minZ: 0,
      maxX: this.width - 1,
      maxY: this.height - 1,
      maxZ: this.depth - 1,
    };
  }
}
