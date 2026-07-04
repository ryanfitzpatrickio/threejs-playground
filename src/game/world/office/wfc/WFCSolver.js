// Vendored from SkyeShark's level-maker (~/source/level-maker/src) — a socket-based
// 3D Wave Function Collapse engine (Three-independent). Kept verbatim; the office
// tileset + grid setup that drive it live alongside in ../. See
// docs/office-interior-wfc-plan.md.

import { OPPOSITE } from './directions.js';
import { areCompatible } from './Adjacency.js';

function cloneSets(grid) {
  return grid.getAllCells().map((cell) => ({
    key: cell.key(),
    possible: Array.from(cell.possibleTiles || []),
    collapsed: cell.collapsedTile,
    contradiction: cell.contradiction,
  }));
}

function restoreClone(grid, clone) {
  const index = new Map(grid.getAllCells().map((cell) => [cell.key(), cell]));
  for (const saved of clone) {
    const cell = index.get(saved.key);
    if (!cell) continue;
    cell.possibleTiles = new Set(saved.possible);
    cell.collapsedTile = saved.collapsed;
    cell.contradiction = saved.contradiction;
  }
}

export class WFCSolver {
  constructor({ seed = 1, maxIterations = 2000 } = {}) {
    this.seed = seed || 1;
    this.maxIterations = maxIterations;
    this.iterations = 0;
    this.solved = false;
    this.statistics = { steps: 0, backtracks: 0 };
  }

  _rand() {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 0xffffffff;
  }

  run(grid, tileSet, context = {}) {
    this.iterations = 0;
    this.statistics = { steps: 0, backtracks: 0 };
    tileSet.get('empty');

    for (const cell of grid.getAllCells()) {
      if (cell.possibleTiles.size === 0) {
        cell.possibleTiles = new Set([tileSet.get('empty')?.id || 'empty']);
      }
    }

    while (this.iterations < this.maxIterations) {
      const unresolved = this._pickMostConstrained(grid);
      if (!unresolved) {
        this.solved = true;
        return true;
      }

      const candidates = this._orderedCandidates(unresolved, tileSet);
      let assigned = false;
      for (const tileId of candidates) {
        const snapshot = cloneSets(grid);
        if (this._assign(grid, unresolved, tileId, tileSet)) {
          assigned = true;
          break;
        }
        restoreClone(grid, snapshot);
        this.statistics.backtracks += 1;
      }

      if (!assigned) {
        unresolved.contradiction = true;
        this.solved = false;
        return false;
      }

      this.iterations += 1;
    }

    this.solved = false;
    return false;
  }

  _search(grid, tileSet, depthLeft) {
    if (this.iterations >= this.maxIterations) return false;
    this.iterations += 1;

    const unresolved = this._pickMostConstrained(grid);
    if (!unresolved) return true;

    const candidates = this._orderedCandidates(unresolved, tileSet);
    if (candidates.length === 0) return false;

    for (const tileId of candidates) {
      const snapshot = cloneSets(grid);
      if (!this._assign(grid, unresolved, tileId, tileSet)) {
        restoreClone(grid, snapshot);
        this.statistics.backtracks += 1;
        continue;
      }

      if (depthLeft <= 0 || this._search(grid, tileSet, depthLeft - 1)) {
        return true;
      }

      restoreClone(grid, snapshot);
      this.statistics.backtracks += 1;
    }

    return false;
  }

  _pickMostConstrained(grid) {
    let best = null;
    let bestEntropy = Number.POSITIVE_INFINITY;

    for (const cell of grid.getAllCells()) {
      if (cell.occupancy === 'empty') continue;
      if (cell.collapsedTile) continue;
      const entropy = cell.possibleTiles.size;
      if (entropy === 0) return null;
      if (entropy < bestEntropy) {
        bestEntropy = entropy;
        best = cell;
      }
    }

    return best;
  }

  _orderedCandidates(cell) {
    const arr = Array.from(cell.possibleTiles);
    // Deterministic weighted random: just stable ascending id for now.
    return arr.sort();
  }

  _orderedCandidates(cell, tileSet) {
    const arr = Array.from(cell.possibleTiles).map((id) => ({ id, w: tileSet.get(id)?.weight || 1 }));
    const sum = arr.reduce((acc, item) => acc + item.w, 0);
    const order = [];
    for (const item of arr) {
      for (let i = 0; i < item.w; i++) order.push(item.id);
    }
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(this._rand() * (i + 1));
      const t = order[i];
      order[i] = order[j];
      order[j] = t;
    }

    if (order.length > 0) return [...new Set(order)];

    return arr.sort((a, b) => a.id.localeCompare(b.id)).map((item) => item.id);
  }

  _assign(grid, cell, tileId, tileSet) {
    if (cell.lockedByUser && cell.fixedTile && cell.fixedTile !== tileId) return false;
    const tile = tileSet.get(tileId);
    if (!tile) return false;

    cell.possibleTiles = new Set([tileId]);
    cell.collapsedTile = tileId;
    this.statistics.steps += 1;

    const queue = [cell];
    while (queue.length > 0) {
      const current = queue.pop();
      const currentTile = tileSet.get(current.collapsedTile);
      if (!currentTile) continue;

      for (const dir of Object.keys(OPPOSITE)) {
        const delta = this._dirOffset(dir);
        const neighbor = grid.getCell(current.x + delta.x, current.y + delta.y, current.z + delta.z);
        if (!neighbor || neighbor.occupancy === 'empty' || neighbor.collapsedTile) continue;

        let changed = false;
        for (const nid of Array.from(neighbor.possibleTiles)) {
          const nTile = tileSet.get(nid);
          if (!areCompatible(currentTile, nTile, dir)) {
            neighbor.possibleTiles.delete(nid);
            changed = true;
          }
        }

        if (neighbor.possibleTiles.size === 0) return false;
        if (neighbor.possibleTiles.size === 1) {
          neighbor.collapsedTile = [...neighbor.possibleTiles][0];
          queue.push(neighbor);
          changed = false;
        }

        if (changed && !queue.includes(neighbor)) queue.push(neighbor);
      }
    }

    return true;
  }

  _dirOffset(dir) {
    switch (dir) {
      case 'PX':
        return { x: 1, y: 0, z: 0 };
      case 'NX':
        return { x: -1, y: 0, z: 0 };
      case 'PY':
        return { x: 0, y: 1, z: 0 };
      case 'NY':
        return { x: 0, y: -1, z: 0 };
      case 'PZ':
        return { x: 0, y: 0, z: 1 };
      default:
        return { x: 0, y: 0, z: -1 };
    }
  }
}
