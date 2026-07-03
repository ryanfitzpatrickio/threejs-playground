/**
 * TerrainChunk.js
 *
 * Data contract (plain object):
 *   {
 *     cx: number,
 *     cz: number,
 *     size: number,          // world units along x and z (square)
 *     resolution: number,    // verts per side (e.g. 33 for 32 quads, 1m steps when size=32)
 *     heights: Float32Array  // length = resolution * resolution, row-major
 *                            // index = j * resolution + i
 *                            // world pos of vert:
 *                            // (cx*size - size/2 + i*step, heights[idx], cz*size - size/2 + j*step)
 *   }
 *
 * All chunks in a project share the same size + resolution.
 * Edge seam contract (enforced by ChunkManager after edits):
 *   Right edge (i = res-1) of (cx, cz) === Left edge (i = 0) of (cx+1, cz) for all rows j.
 *   Same for Bottom/Top, etc.
 */

import * as THREE from 'three';

const DEFAULT_CHUNK_SIZE = 32;
const DEFAULT_RESOLUTION = 33; // 32 quads, nice power-of-two-ish

/**
 * Create a chunk data object initialized to zeros (or caller passes heights).
 */
export function createChunkData({ cx, cz, size = DEFAULT_CHUNK_SIZE, resolution = DEFAULT_RESOLUTION, heights = null } = {}) {
  const res = resolution | 0;
  const data = {
    cx: cx | 0,
    cz: cz | 0,
    size: Number(size),
    resolution: res,
    heights: heights instanceof Float32Array && heights.length === res * res
      ? heights
      : new Float32Array(res * res),
  };
  return data;
}

/**
 * Compute world-space position of a specific vert inside the chunk.
 */
export function getChunkVertWorldPos(chunk, i, j, target = new THREE.Vector3()) {
  const step = chunk.size / (chunk.resolution - 1);
  const idx = j * chunk.resolution + i;
  const h = chunk.heights[idx] ?? 0;
  return target.set(
    chunk.cx * chunk.size - chunk.size * 0.5 + i * step,
    h,
    chunk.cz * chunk.size - chunk.size * 0.5 + j * step,
  );
}

/**
 * Returns the flat array indices along one edge of the chunk.
 * edge: 'left' | 'right' | 'top' | 'bottom'  (top = +Z in our layout, bottom = -Z)
 */
export function getSeamIndices(chunk, edge) {
  const res = chunk.resolution;
  const indices = [];
  if (edge === 'left') {
    for (let j = 0; j < res; j += 1) indices.push(j * res + 0);
  } else if (edge === 'right') {
    for (let j = 0; j < res; j += 1) indices.push(j * res + (res - 1));
  } else if (edge === 'bottom') { // low z
    for (let i = 0; i < res; i += 1) indices.push(0 * res + i);
  } else if (edge === 'top') { // high z
    for (let i = 0; i < res; i += 1) indices.push((res - 1) * res + i);
  }
  return indices;
}

export function hasTerrainHoleMask(mask) {
  if (!(mask instanceof Uint8Array)) return false;
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i]) return true;
  }
  return false;
}

export function hasTerrainHoles(chunkData) {
  return hasTerrainHoleMask(chunkData?.holeMask);
}

// Build the grid topology shared by the visual terrain and Rapier. holeMask is
// one byte per AUTHORITATIVE heightfield cell; a set byte removes both triangles
// in that cell. Coarser visual LOD cells are removed when they overlap any source
// hole, so a distant terrain mesh cannot put a low-resolution lid over a tunnel.
export function buildTerrainGridIndices(
  chunkData,
  gridResolution = chunkData.resolution,
  holeMask = chunkData.holeMask,
) {
  const sourceResolution = chunkData.resolution;
  const sourceCells = sourceResolution - 1;
  const gridCells = gridResolution - 1;
  const indices = [];

  const overlapsHole = (i, j) => {
    if (!(holeMask instanceof Uint8Array) || holeMask.length !== sourceCells * sourceCells) return false;
    const minI = Math.floor((i * sourceCells) / gridCells);
    const maxI = Math.min(sourceCells - 1, Math.ceil(((i + 1) * sourceCells) / gridCells) - 1);
    const minJ = Math.floor((j * sourceCells) / gridCells);
    const maxJ = Math.min(sourceCells - 1, Math.ceil(((j + 1) * sourceCells) / gridCells) - 1);
    for (let sj = minJ; sj <= maxJ; sj += 1) {
      for (let si = minI; si <= maxI; si += 1) {
        if (holeMask[sj * sourceCells + si]) return true;
      }
    }
    return false;
  };

  for (let j = 0; j < gridCells; j += 1) {
    for (let i = 0; i < gridCells; i += 1) {
      if (overlapsHole(i, j)) continue;
      const a = j * gridResolution + i;
      const b = a + 1;
      const c = a + gridResolution;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  return new Uint32Array(indices);
}

export function buildTerrainTrimeshData(chunkData) {
  const { size, resolution, heights } = chunkData;
  const step = size / (resolution - 1);
  const vertices = new Float32Array(resolution * resolution * 3);
  for (let j = 0; j < resolution; j += 1) {
    for (let i = 0; i < resolution; i += 1) {
      const vertex = (j * resolution + i) * 3;
      vertices[vertex] = i * step - size * 0.5;
      vertices[vertex + 1] = heights[j * resolution + i] ?? 0;
      vertices[vertex + 2] = j * step - size * 0.5;
    }
  }
  return { vertices, indices: buildTerrainGridIndices(chunkData, resolution) };
}

/**
 * Force the shared edge values between two adjacent chunks to be identical.
 * The "owner" chunk (the one whose data we treat as source) wins for that edge.
 * Typically called after a deformation that touched the seam.
 */
export function syncSeam(fromChunk, toChunk, edgeOnFrom) {
  if (!fromChunk || !toChunk) return;

  const res = fromChunk.resolution;
  if (toChunk.resolution !== res) return;

  let fromIndices;
  let toIndices;

  // Map which edge on "from" corresponds to which edge on "to"
  if (edgeOnFrom === 'right' && toChunk.cx === fromChunk.cx + 1 && toChunk.cz === fromChunk.cz) {
    fromIndices = getSeamIndices(fromChunk, 'right');
    toIndices = getSeamIndices(toChunk, 'left');
  } else if (edgeOnFrom === 'left' && toChunk.cx === fromChunk.cx - 1 && toChunk.cz === fromChunk.cz) {
    fromIndices = getSeamIndices(fromChunk, 'left');
    toIndices = getSeamIndices(toChunk, 'right');
  } else if (edgeOnFrom === 'top' && toChunk.cz === fromChunk.cz + 1 && toChunk.cx === fromChunk.cx) {
    fromIndices = getSeamIndices(fromChunk, 'top');
    toIndices = getSeamIndices(toChunk, 'bottom');
  } else if (edgeOnFrom === 'bottom' && toChunk.cz === fromChunk.cz - 1 && toChunk.cx === fromChunk.cx) {
    fromIndices = getSeamIndices(fromChunk, 'bottom');
    toIndices = getSeamIndices(toChunk, 'top');
  } else {
    return; // not adjacent on that edge
  }

  for (let k = 0; k < fromIndices.length; k += 1) {
    const f = fromIndices[k];
    const t = toIndices[k];
    toChunk.heights[t] = fromChunk.heights[f];
  }
}

/**
 * Create (or update) a Three.js mesh for the chunk.
 * Returns an object with the mesh and an update function.
 *
 * The mesh root is placed at (cx * size, 0, cz * size) so local geometry
 * lives in [0,size] x [0,size] in xz. This makes edge sharing trivial.
 */
export function createTerrainChunkMesh(chunkData, options = {}) {
  const { material = null, castShadow = true, receiveShadow = true, visualResolution = null } = options;
  const { size, resolution, heights } = chunkData;
  // Physics and editing retain the authoritative heightfield resolution. Outer
  // streaming rings can render a cheaper grid sampled from that same data.
  const meshResolution = Math.max(2, Math.min(resolution, visualResolution ?? resolution));
  const step = size / (meshResolution - 1);
  const sourceAt = (i, j) => {
    const si = Math.round((i / (meshResolution - 1)) * (resolution - 1));
    const sj = Math.round((j / (meshResolution - 1)) * (resolution - 1));
    return heights[sj * resolution + si] ?? 0;
  };

  // Build geometry (we keep a non-indexed or indexed plane; simple indexed grid)
  const geometry = new THREE.PlaneGeometry(size, size, meshResolution - 1, meshResolution - 1);
  geometry.rotateX(-Math.PI / 2); // +Y up in world, plane starts in xz

  if (hasTerrainHoleMask(chunkData.visualHoleMask)) {
    geometry.setIndex(new THREE.BufferAttribute(
      buildTerrainGridIndices(chunkData, meshResolution, chunkData.visualHoleMask),
      1,
    ));
  }

  const posAttr = geometry.attributes.position;
  const uvAttr = geometry.attributes.uv;

  // Apply heights + compute sensible UVs (0..1 across chunk is fine for now)
  for (let j = 0; j < meshResolution; j += 1) {
    for (let i = 0; i < meshResolution; i += 1) {
      const gIdx = j * meshResolution + i; // PlaneGeometry order: x varies fastest.
      // PlaneGeometry vertex order (for segments = res-1): (i + j * res)
      // Our heights are stored j * res + i  (j = z direction in our math)
      const h = sourceAt(i, j);

      // Position is already laid out by PlaneGeometry in [-size/2, +size/2].
      // We want local [0, size]. Shift everything.
      const px = i * step - size * 0.5;
      const pz = j * step - size * 0.5;

      posAttr.setXYZ(gIdx, px, h, pz);

      // UVs 0..1 across the chunk
      uvAttr.setXY(gIdx, i / (meshResolution - 1), j / (meshResolution - 1));
    }
  }

  posAttr.needsUpdate = true;
  uvAttr.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const meshMaterial = material || new THREE.MeshStandardMaterial({
    color: 0x9aa38f,
    roughness: 0.92,
    metalness: 0.02,
    flatShading: false,
  });

  const mesh = new THREE.Mesh(geometry, meshMaterial);
  mesh.name = `TerrainChunk_${chunkData.cx}_${chunkData.cz}`;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = receiveShadow;

  // Place the chunk root in world space
  mesh.position.set(chunkData.cx * size, 0, chunkData.cz * size);
  mesh.updateMatrixWorld(true);

  // Store a back-reference for raycast/identification
  mesh.userData.chunkRef = {
    cx: chunkData.cx,
    cz: chunkData.cz,
    size: chunkData.size,
    resolution: chunkData.resolution,
    visualResolution: meshResolution,
  };

  function updateHeights(newHeights) {
    if (!(newHeights instanceof Float32Array) || newHeights.length !== heights.length) {
      throw new Error('updateHeights expects a Float32Array of identical length');
    }

    // Copy into our data
    heights.set(newHeights);

    // Push into geometry
    const p = geometry.attributes.position;
    for (let j = 0; j < meshResolution; j += 1) {
      for (let i = 0; i < meshResolution; i += 1) {
        const gIdx = j * meshResolution + i;
        const h = sourceAt(i, j);
        const px = i * step - size * 0.5;
        const pz = j * step - size * 0.5;
        p.setXYZ(gIdx, px, h, pz);
      }
    }
    p.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    // boundingBox not strictly needed but keep fresh
    geometry.boundingBox = null;
  }

  return {
    mesh,
    updateHeights,
    geometry,
    material: meshMaterial,
    // Convenience for debug / external
    chunkData, // reference to the live data object
  };
}

/**
 * Utility to snapshot just the heights (for undo, export, etc).
 */
export function cloneHeights(heights) {
  return new Float32Array(heights);
}
