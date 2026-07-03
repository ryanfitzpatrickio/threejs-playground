// Incrementally-maintained spatial index over a streaming set of axis-aligned
// city colliders. Replaces four independent O(all-colliders) / GC-churning
// paths (hook raycast, getGroundHeightAt, getBlockingColliderAt, vault) with one
// structure updated only on streaming add/remove.
//
// The flat `colliders` array remains the source of truth for legacy consumers
// (PhysicsSystem.loadLevel one-time iteration, snapshot .length). The cell grid
// is a Map<numericCellKey, collider[]> maintained alongside it; queries are
// allocation-free (callback + generation-stamp dedup, no Set/string keys).

const CELL_SIZE = 32; // mirrors COLLIDER_GRID_CELL_SIZE in createBaseLevel.js
const MAX_CELLS = 64; // colliders spanning more cells than this go in `global`
const CELL_OFFSET = 32768; // keep cell coords non-negative for unique numeric keys

// Per-collider generation stamp for zero-allocation dedup across overlapping cells.
const GEN = Symbol('csGen');

function cellKey(cx, cz) {
  // Unique for |cx|, |cz| < 32768 (±1M m at 32 m cells) — far beyond any drive.
  return (cx + CELL_OFFSET) * 65536 + (cz + CELL_OFFSET);
}

export class ColliderSpatialIndex {
  constructor() {
    this.colliders = [];
    this._cells = new Map();
    this._global = [];
    // collider -> number[] of cell keys it occupies (null when it lives in _global)
    this._colliderCells = new Map();
    this._gen = 0;
  }

  // Add a chunk's colliders. `chunkKey` is the string every collider already
  // carries (worker/serialize tags it); removal matches on it. Arr may be null.
  addChunk(chunkKey, arr) {
    if (!arr) return;
    for (let i = 0; i < arr.length; i += 1) {
      this._addCollider(arr[i], chunkKey);
    }
  }

  _addCollider(collider, chunkKey) {
    if (!collider) return;
    if (collider.chunkKey == null) collider.chunkKey = chunkKey;
    this.colliders.push(collider);

    const { minX, maxX, minZ, maxZ } = collider;
    const finite =
      Number.isFinite(minX) && Number.isFinite(maxX) && Number.isFinite(minZ) && Number.isFinite(maxZ);

    if (!finite) {
      this._global.push(collider);
      this._colliderCells.set(collider, null);
      return;
    }

    const minCX = Math.floor(minX / CELL_SIZE);
    const maxCX = Math.floor(maxX / CELL_SIZE);
    const minCZ = Math.floor(minZ / CELL_SIZE);
    const maxCZ = Math.floor(maxZ / CELL_SIZE);
    const count = (maxCX - minCX + 1) * (maxCZ - minCZ + 1);

    if (count > MAX_CELLS) {
      this._global.push(collider);
      this._colliderCells.set(collider, null);
      return;
    }

    const keys = [];
    for (let cx = minCX; cx <= maxCX; cx += 1) {
      for (let cz = minCZ; cz <= maxCZ; cz += 1) {
        const key = cellKey(cx, cz);
        let bucket = this._cells.get(key);
        if (!bucket) {
          bucket = [];
          this._cells.set(key, bucket);
        }
        bucket.push(collider);
        keys.push(key);
      }
    }
    this._colliderCells.set(collider, keys);
  }

  // Remove every collider whose `chunkKey` matches. Swap-removes from the flat
  // array and from each cell bucket — O(colliders-in-chunk) not O(total).
  removeChunk(chunkKey) {
    const arr = this.colliders;
    for (let i = arr.length - 1; i >= 0; i -= 1) {
      const collider = arr[i];
      if (collider?.chunkKey !== chunkKey) continue;
      this._removeCollider(collider);
      // Swap-remove: the element at the end has already been visited (index > i).
      arr[i] = arr[arr.length - 1];
      arr.pop();
    }
  }

  _removeCollider(collider) {
    const keys = this._colliderCells.get(collider);
    if (keys) {
      for (let i = 0; i < keys.length; i += 1) {
        const bucket = this._cells.get(keys[i]);
        if (!bucket) continue;
        const idx = bucket.indexOf(collider);
        if (idx >= 0) {
          bucket[idx] = bucket[bucket.length - 1];
          bucket.pop();
        }
        if (bucket.length === 0) this._cells.delete(keys[i]);
      }
    } else {
      const idx = this._global.indexOf(collider);
      if (idx >= 0) {
        this._global[idx] = this._global[this._global.length - 1];
        this._global.pop();
      }
    }
    this._colliderCells.delete(collider);
  }

  // Visit every collider overlapping a horizontal disc (x,z ± radius). Calls
  // `fn(collider)` once per collider. Zero allocation.
  forEachInPointRadius(x, z, radius, fn) {
    const gen = (this._gen += 1);
    const global = this._global;
    for (let i = 0; i < global.length; i += 1) {
      const c = global[i];
      c[GEN] = gen;
      fn(c);
    }
    const minCX = Math.floor((x - radius) / CELL_SIZE);
    const maxCX = Math.floor((x + radius) / CELL_SIZE);
    const minCZ = Math.floor((z - radius) / CELL_SIZE);
    const maxCZ = Math.floor((z + radius) / CELL_SIZE);
    for (let cx = minCX; cx <= maxCX; cx += 1) {
      for (let cz = minCZ; cz <= maxCZ; cz += 1) {
        const bucket = this._cells.get(cellKey(cx, cz));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i += 1) {
          const c = bucket[i];
          if (c[GEN] === gen) continue;
          c[GEN] = gen;
          fn(c);
        }
      }
    }
  }

  // Visit every collider whose cell overlaps the XZ footprint of a ray segment
  // [origin, origin+dir*far]. The per-collider 3D slab test (caller) does the
  // real hit/clip math; this is just the broad phase. Zero allocation.
  forEachInRaySegmentXZ(ox, oz, dx, dz, far, fn) {
    const gen = (this._gen += 1);
    const global = this._global;
    for (let i = 0; i < global.length; i += 1) {
      const c = global[i];
      c[GEN] = gen;
      fn(c);
    }
    const ex = ox + dx * far;
    const ez = oz + dz * far;
    const minX = Math.min(ox, ex);
    const maxX = Math.max(ox, ex);
    const minZ = Math.min(oz, ez);
    const maxZ = Math.max(oz, ez);
    const minCX = Math.floor(minX / CELL_SIZE);
    const maxCX = Math.floor(maxX / CELL_SIZE);
    const minCZ = Math.floor(minZ / CELL_SIZE);
    const maxCZ = Math.floor(maxZ / CELL_SIZE);
    for (let cx = minCX; cx <= maxCX; cx += 1) {
      for (let cz = minCZ; cz <= maxCZ; cz += 1) {
        const bucket = this._cells.get(cellKey(cx, cz));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i += 1) {
          const c = bucket[i];
          if (c[GEN] === gen) continue;
          c[GEN] = gen;
          fn(c);
        }
      }
    }
  }

  // Dev-only: assert the cell grid is consistent with the flat array. Throws on
  // mismatch so a pageerror assertion in the verify harness catches it.
  assertConsistent() {
    let counted = this._global.length;
    for (const bucket of this._cells.values()) counted += bucket.length;
    // Multi-cell colliders inflate `counted` above colliders.length, so bound
    // the check the other way: every flat-array collider must be tracked.
    for (const collider of this.colliders) {
      const keys = this._colliderCells.get(collider);
      if (keys == null && !this._global.includes(collider)) {
        throw new Error('ColliderSpatialIndex: collider missing from global and cells');
      }
      if (keys) {
        for (const key of keys) {
          if (!this._cells.get(key)?.includes(collider)) {
            throw new Error('ColliderSpatialIndex: collider missing from a recorded cell');
          }
        }
      }
    }
  }

  clear() {
    this.colliders.length = 0;
    this._cells.clear();
    this._global.length = 0;
    this._colliderCells.clear();
  }
}
