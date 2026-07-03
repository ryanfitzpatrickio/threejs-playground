/**
 * ChunkManager.js
 *
 * Single source of truth for authored + procedural chunk terrain.
 * - Manages a set of authored chunk data (the "same chunks" you save/edit).
 * - Lazily provides procedural chunks when no authored data exists for a coord.
 * - Exposes brush application that mutates heights + maintains seam contract across loaded neighbors.
 * - Serialization for project save/load and runtime JSON export.
 *
 * The manager itself is pure-ish (no Three). The caller (MapBuilder) owns the live meshes
 * and calls update after the manager mutates data.
 */

import { createProceduralSampler, sampleChunkHeights } from './Procedural.js';
import { createChunkData, cloneHeights, syncSeam } from './TerrainChunk.js';

const DEFAULT_CHUNK_SIZE = 32;
const DEFAULT_RESOLUTION = 33;
const PROJECT_VERSION = 1;

function chunkKey(cx, cz) {
  return `${cx | 0},${cz | 0}`;
}

function parseKey(key) {
  const [cx, cz] = key.split(',').map(Number);
  return { cx, cz };
}

function coordForWorld(value, size) {
  return Math.floor((value + size * 0.5) / size);
}

function chunkMin(coord, size) {
  return coord * size - size * 0.5;
}

export class ChunkManager {
  constructor(options = {}) {
    const {
      chunkSize = DEFAULT_CHUNK_SIZE,
      resolution = DEFAULT_RESOLUTION,
      seed = 1337,
      amplitude = 2.4,
      octaves = 5,
    } = options;

    this.chunkSize = chunkSize;
    this.resolution = resolution;

    this.procedural = createProceduralSampler({ seed, amplitude, octaves });

    // Authored chunks: key -> chunkData (the only ones that get saved)
    this.authored = new Map(); // Map<string, chunkData>

    // Currently "live" chunks (authored or virtual procedural copies).
    // We keep procedural copies in memory only while the builder needs them for editing/viewing.
    // On export we only emit authored.
    this.liveChunks = new Map(); // Map<string, chunkData>

    // Track which live chunks are purely procedural (not yet deformed)
    this.proceduralOnly = new Set();

    this.projectMeta = {
      version: PROJECT_VERSION,
      seed,
      amplitude,
      octaves,
      createdAt: Date.now(),
    };
  }

  // ------------------------------------------------------------------
  // Project / authored lifecycle
  // ------------------------------------------------------------------

  createProject(metaOverrides = {}) {
    this.authored.clear();
    this.liveChunks.clear();
    this.proceduralOnly.clear();

    this.projectMeta = {
      ...this.projectMeta,
      ...metaOverrides,
      createdAt: Date.now(),
    };

    // Rebuild sampler if seed/amplitude changed
    this.procedural = createProceduralSampler({
      seed: this.projectMeta.seed,
      amplitude: this.projectMeta.amplitude,
      octaves: this.projectMeta.octaves,
    });
  }

  loadProject(projectJson) {
    if (!projectJson || projectJson.version !== PROJECT_VERSION) {
      throw new Error(`Unsupported or missing project version (expected ${PROJECT_VERSION})`);
    }

    this.chunkSize = projectJson.chunkSize ?? this.chunkSize;
    this.resolution = projectJson.resolution ?? this.resolution;

    this.projectMeta = {
      version: projectJson.version,
      seed: projectJson.seed ?? 1337,
      amplitude: projectJson.amplitude ?? 2.4,
      octaves: projectJson.octaves ?? 5,
      createdAt: projectJson.createdAt ?? Date.now(),
    };

    this.procedural = createProceduralSampler({
      seed: this.projectMeta.seed,
      amplitude: this.projectMeta.amplitude,
      octaves: this.projectMeta.octaves,
    });

    this.authored.clear();
    this.liveChunks.clear();
    this.proceduralOnly.clear();

    const incoming = projectJson.chunks ?? projectJson.authoredChunks ?? [];
    for (const raw of incoming) {
      const data = createChunkData({
        cx: raw.cx,
        cz: raw.cz,
        size: this.chunkSize,
        resolution: this.resolution,
        heights: raw.heights instanceof Float32Array
          ? raw.heights
          : new Float32Array(raw.heights),
      });
      const key = chunkKey(data.cx, data.cz);
      this.authored.set(key, data);
      this.liveChunks.set(key, data);
      // These are explicitly authored
      this.proceduralOnly.delete(key);
    }
  }

  toJSON(options = {}) {
    const { includeLoaded = false } = options;
    const chunks = [];
    const source = includeLoaded ? this.liveChunks : this.authored;
    for (const data of source.values()) {
      chunks.push({
        cx: data.cx,
        cz: data.cz,
        heights: Array.from(data.heights), // portable
      });
    }

    return {
      version: PROJECT_VERSION,
      chunkSize: this.chunkSize,
      resolution: this.resolution,
      seed: this.projectMeta.seed,
      amplitude: this.projectMeta.amplitude,
      octaves: this.projectMeta.octaves,
      createdAt: this.projectMeta.createdAt,
      chunks,
    };
  }

  // ------------------------------------------------------------------
  // Live chunk access (what the editor sees)
  // ------------------------------------------------------------------

  /**
   * Get or create a live chunk at (cx, cz).
   * If we have authored data, return it.
   * Otherwise create a procedural sample (and remember it is procedural-only until deformed).
   */
  getOrCreateChunk(cx, cz) {
    const key = chunkKey(cx, cz);
    if (this.liveChunks.has(key)) {
      return this.liveChunks.get(key);
    }

    let data;
    if (this.authored.has(key)) {
      data = this.authored.get(key);
    } else {
      const heights = sampleChunkHeights(this.procedural, cx, cz, this.chunkSize, this.resolution);
      data = createChunkData({
        cx,
        cz,
        size: this.chunkSize,
        resolution: this.resolution,
        heights,
      });
      this.proceduralOnly.add(key);
    }

    this.liveChunks.set(key, data);
    return data;
  }

  /**
   * Mark a live chunk as authored (i.e. it now participates in saves).
   * Called automatically the first time a procedural chunk is deformed.
   */
  ensureAuthored(chunk) {
    const key = chunkKey(chunk.cx, chunk.cz);
    if (!this.authored.has(key)) {
      // Clone so future procedural resets don't affect the saved copy
      const clone = createChunkData({
        cx: chunk.cx,
        cz: chunk.cz,
        size: chunk.size,
        resolution: chunk.resolution,
        heights: cloneHeights(chunk.heights),
      });
      this.authored.set(key, clone);
      // Replace live reference with the clone? Keep same object for live mesh binding.
      // Instead just move the existing mutated object into authored.
      this.authored.set(key, chunk);
    }
    this.proceduralOnly.delete(key);
  }

  getAuthoredChunk(cx, cz) {
    return this.authored.get(chunkKey(cx, cz)) ?? null;
  }

  hasAuthored(cx, cz) {
    return this.authored.has(chunkKey(cx, cz));
  }

  getLoadedChunks() {
    return Array.from(this.liveChunks.values());
  }

  unloadChunk(cx, cz) {
    const key = chunkKey(cx, cz);
    // Never unload authored data from the manager (it is the save source).
    // We only drop the live entry if it was purely procedural.
    if (this.proceduralOnly.has(key) && !this.authored.has(key)) {
      this.liveChunks.delete(key);
      this.proceduralOnly.delete(key);
    }
  }

  // ------------------------------------------------------------------
  // Deformation + seam maintenance (the heart of "edit many + edges")
  // ------------------------------------------------------------------

  /**
   * Apply a brush centered at a world-space point.
   * Mutates height data for all affected live chunks (creating them if needed).
   * Always syncs seams for any loaded neighbors after the stroke.
   *
   * brush: {
   *   radius: number (world units),
   *   strength: number,
   *   mode: 'raise' | 'lower' | 'smooth' | 'flatten' | 'noise' | 'set',
   *   falloff: 'smooth' | 'linear' | 'none',
   *   targetHeight?: number (for flatten/set),
   * }
   *
   * Returns array of the chunk data objects that were mutated.
   */
  applyBrush(worldPoint, brush) {
    const { x, z } = worldPoint;
    const { radius = 6, strength = 1.0, mode = 'raise', falloff = 'smooth' } = brush;

    const affected = new Set();
    const step = this.chunkSize / (this.resolution - 1);
    const radiusSq = radius * radius;

    // Compute a conservative chunk range around the point
    const minCX = coordForWorld(x - radius, this.chunkSize);
    const maxCX = coordForWorld(x + radius, this.chunkSize);
    const minCZ = coordForWorld(z - radius, this.chunkSize);
    const maxCZ = coordForWorld(z + radius, this.chunkSize);

    for (let cx = minCX; cx <= maxCX; cx += 1) {
      for (let cz = minCZ; cz <= maxCZ; cz += 1) {
        const chunk = this.getOrCreateChunk(cx, cz);
        const localMinX = chunkMin(cx, this.chunkSize);
        const localMinZ = chunkMin(cz, this.chunkSize);
        const localMaxX = localMinX + this.chunkSize;
        const localMaxZ = localMinZ + this.chunkSize;

        // Quick reject if brush circle can't touch this chunk bbox
        const closestX = Math.max(localMinX, Math.min(x, localMaxX));
        const closestZ = Math.max(localMinZ, Math.min(z, localMaxZ));
        if ((closestX - x) ** 2 + (closestZ - z) ** 2 > radiusSq) continue;

        let mutated = false;
        const centerLocalX = x - localMinX;
        const centerLocalZ = z - localMinZ;

        for (let j = 0; j < this.resolution; j += 1) {
          for (let i = 0; i < this.resolution; i += 1) {
            const idx = j * this.resolution + i;
            const vertWorldX = localMinX + i * step;
            const vertWorldZ = localMinZ + j * step;

            const dx = vertWorldX - x;
            const dz = vertWorldZ - z;
            const distSq = dx * dx + dz * dz;
            if (distSq > radiusSq) continue;

            const dist = Math.sqrt(distSq);
            let factor = 1.0;
            if (falloff === 'smooth') {
              const t = Math.min(dist / radius, 1);
              factor = 1 - t * t * (3 - 2 * t); // smoothstep
            } else if (falloff === 'linear') {
              factor = 1 - Math.min(dist / radius, 1);
            } else if (falloff === 'none') {
              factor = 1;
            }

            if (factor <= 0.0001) continue;

            const oldH = chunk.heights[idx];
            let newH = oldH;

            if (mode === 'raise') {
              newH = oldH + strength * factor;
            } else if (mode === 'lower') {
              newH = oldH - strength * factor;
            } else if (mode === 'smooth') {
              // Simple neighbor average (4-connected) blended by factor
              const avg = this._neighborAverage(chunk, i, j);
              newH = oldH + (avg - oldH) * strength * factor * 0.6;
            } else if (mode === 'flatten') {
              const target = brush.targetHeight ?? oldH;
              newH = oldH + (target - oldH) * strength * factor * 0.7;
            } else if (mode === 'noise') {
              // Small high-freq perturbation using the procedural as cheap RNG
              const n = (this.procedural(vertWorldX * 7.3, vertWorldZ * 7.3) - 0.5) * 0.6;
              newH = oldH + n * strength * factor;
            } else if (mode === 'set') {
              const target = brush.targetHeight ?? 0;
              newH = oldH + (target - oldH) * strength * factor;
            }

            if (Math.abs(newH - oldH) > 0.0001) {
              chunk.heights[idx] = newH;
              mutated = true;
            }
          }
        }

        if (mutated) {
          affected.add(chunk);
          if (this.proceduralOnly.has(chunkKey(cx, cz))) {
            this.ensureAuthored(chunk);
          }
        }
      }
    }

    const mutatedList = Array.from(affected);

    // Critical: keep seams watertight for every loaded neighbor
    this._syncAllSeams(mutatedList);

    return mutatedList;
  }

  _neighborAverage(chunk, i, j) {
    const res = this.resolution;
    let sum = 0;
    let count = 0;

    const sample = (ii, jj) => {
      if (ii < 0 || ii >= res || jj < 0 || jj >= res) return null;
      return chunk.heights[jj * res + ii];
    };

    const add = (ii, jj) => {
      const v = sample(ii, jj);
      if (v != null) { sum += v; count += 1; }
    };

    add(i - 1, j);
    add(i + 1, j);
    add(i, j - 1);
    add(i, j + 1);

    if (count === 0) return chunk.heights[j * res + i];
    return sum / count;
  }

  /**
   * After any edit that may have touched edges, make sure any *currently live*
   * adjacent chunks have identical values on the shared seam.
   * Public for use by undo/restore and external tools.
   */
  reconcileSeams(mutatedChunks) {
    this._syncAllSeams(mutatedChunks);
  }

  _syncAllSeams(mutatedChunks) {
    const liveKeys = new Set(this.liveChunks.keys());

    for (const chunk of mutatedChunks) {
      const key = chunkKey(chunk.cx, chunk.cz);
      // Check the four possible neighbors — only if they are loaded right now
      const neighbors = [
        { dcx: 1, dcz: 0, myEdge: 'right', theirEdge: 'left' },
        { dcx: -1, dcz: 0, myEdge: 'left', theirEdge: 'right' },
        { dcx: 0, dcz: 1, myEdge: 'top', theirEdge: 'bottom' },
        { dcx: 0, dcz: -1, myEdge: 'bottom', theirEdge: 'top' },
      ];

      for (const n of neighbors) {
        const nk = chunkKey(chunk.cx + n.dcx, chunk.cz + n.dcz);
        if (!liveKeys.has(nk)) continue;
        const neighbor = this.liveChunks.get(nk);
        // Use syncSeam (from → to). We treat the mutated chunk as source for its outgoing edge.
        syncSeam(chunk, neighbor, n.myEdge);
      }
    }
  }

  /**
   * Force the perimeter of one or more chunks back to the pure procedural value.
   * This is the main tool for "keep edges compatible with procedural infinity".
   */
  resetEdgesToProcedural(chunks) {
    const list = Array.isArray(chunks) ? chunks : [chunks];
    const affected = new Set();

    for (const chunk of list) {
      if (!chunk) continue;
      const res = this.resolution;
      const step = this.chunkSize / (res - 1);

      const edges = ['left', 'right', 'top', 'bottom'];
      for (const edge of edges) {
        const indices = []; // reuse get logic without import cycle
        if (edge === 'left') {
          for (let j = 0; j < res; j += 1) indices.push(j * res);
        } else if (edge === 'right') {
          for (let j = 0; j < res; j += 1) indices.push(j * res + (res - 1));
        } else if (edge === 'bottom') {
          for (let i = 0; i < res; i += 1) indices.push(i);
        } else if (edge === 'top') {
          for (let i = 0; i < res; i += 1) indices.push((res - 1) * res + i);
        }

        for (const idx of indices) {
          const j = Math.floor(idx / res);
          const i = idx % res;
          const wx = chunkMin(chunk.cx, this.chunkSize) + i * step;
          const wz = chunkMin(chunk.cz, this.chunkSize) + j * step;
          chunk.heights[idx] = this.procedural(wx, wz);
        }
      }
      affected.add(chunk);
      // If it was procedural-only before, it still is (we just rewrote the edges to match procedural)
    }

    // Re-sync any live neighbors after edge reset (so their side also gets the new procedural value)
    this._syncAllSeams(Array.from(affected));

    return Array.from(affected);
  }

  // ------------------------------------------------------------------
  // Queries (useful for brush preview, future game consumption, etc.)
  // ------------------------------------------------------------------

  getHeightAt(worldX, worldZ) {
    const cx = coordForWorld(worldX, this.chunkSize);
    const cz = coordForWorld(worldZ, this.chunkSize);
    const chunk = this.liveChunks.get(chunkKey(cx, cz)) || this.authored.get(chunkKey(cx, cz));

    if (chunk) {
      const localX = worldX - chunkMin(cx, this.chunkSize);
      const localZ = worldZ - chunkMin(cz, this.chunkSize);
      const res = this.resolution;
      const step = this.chunkSize / (res - 1);

      // Use bilinear interpolation so the sampled height exactly matches the
      // triangulated surface used by the visual mesh and the Rapier heightfield.
      // This prevents the character controller / ground snap from fighting the
      // actual collider surface (common cause of "stuck in the ground").
      let fi = localX / step;
      let fj = localZ / step;

      let i0 = Math.floor(fi);
      let j0 = Math.floor(fj);
      let i1 = Math.min(i0 + 1, res - 1);
      let j1 = Math.min(j0 + 1, res - 1);

      i0 = Math.max(0, Math.min(res - 1, i0));
      j0 = Math.max(0, Math.min(res - 1, j0));

      const tx = fi - i0;
      const ty = fj - j0;

      const h00 = chunk.heights[j0 * res + i0];
      const h10 = chunk.heights[j0 * res + i1];
      const h01 = chunk.heights[j1 * res + i0];
      const h11 = chunk.heights[j1 * res + i1];

      const hx0 = h00 + (h10 - h00) * tx;
      const hx1 = h01 + (h11 - h01) * tx;
      return hx0 + (hx1 - hx0) * ty;
    }

    // Outside any loaded authored — pure procedural (the infinity case)
    return this.procedural(worldX, worldZ);
  }

  // ------------------------------------------------------------------
  // Utility
  // ------------------------------------------------------------------

  getStats() {
    return {
      authoredCount: this.authored.size,
      liveCount: this.liveChunks.size,
      proceduralOnly: this.proceduralOnly.size,
      chunkSize: this.chunkSize,
      resolution: this.resolution,
    };
  }
}
