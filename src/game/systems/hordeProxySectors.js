/**
 * Pure sector grid math for Horde M5 crowd batches.
 * Arena AABB → NxN cells; each cell can own InstancedMesh draws that frustum-cull
 * independently so off-screen robots do not submit work.
 */

/**
 * @param {{ minX: number, maxX: number, minZ: number, maxZ: number }} bounds
 * @param {number} grid
 * @returns {Array<{
 *   index: number, ix: number, iz: number,
 *   minX: number, maxX: number, minZ: number, maxZ: number,
 *   cx: number, cz: number, radius: number,
 * }>}
 */
export function buildHordeSectors(bounds, grid = 4) {
  const n = Math.max(1, Math.floor(grid));
  const minX = Number(bounds?.minX);
  const maxX = Number(bounds?.maxX);
  const minZ = Number(bounds?.minZ);
  const maxZ = Number(bounds?.maxZ);
  if (![minX, maxX, minZ, maxZ].every(Number.isFinite) || maxX <= minX || maxZ <= minZ) {
    return [];
  }
  const spanX = maxX - minX;
  const spanZ = maxZ - minZ;
  const cellW = spanX / n;
  const cellD = spanZ / n;
  const sectors = [];
  for (let iz = 0; iz < n; iz += 1) {
    for (let ix = 0; ix < n; ix += 1) {
      const sMinX = minX + ix * cellW;
      const sMaxX = ix === n - 1 ? maxX : sMinX + cellW;
      const sMinZ = minZ + iz * cellD;
      const sMaxZ = iz === n - 1 ? maxZ : sMinZ + cellD;
      const cx = (sMinX + sMaxX) * 0.5;
      const cz = (sMinZ + sMaxZ) * 0.5;
      const radius = Math.hypot(sMaxX - sMinX, sMaxZ - sMinZ) * 0.5 + 2.5;
      sectors.push({
        index: iz * n + ix,
        ix,
        iz,
        minX: sMinX,
        maxX: sMaxX,
        minZ: sMinZ,
        maxZ: sMaxZ,
        cx,
        cz,
        radius,
      });
    }
  }
  return sectors;
}

/**
 * Sector index for a world XZ position. Clamps to the edge cell when outside.
 * @param {number} x
 * @param {number} z
 * @param {{ minX: number, maxX: number, minZ: number, maxZ: number }} bounds
 * @param {number} grid
 */
export function sectorIndexAt(x, z, bounds, grid = 4) {
  const n = Math.max(1, Math.floor(grid));
  const minX = bounds.minX;
  const maxX = bounds.maxX;
  const minZ = bounds.minZ;
  const maxZ = bounds.maxZ;
  const spanX = maxX - minX;
  const spanZ = maxZ - minZ;
  if (spanX <= 0 || spanZ <= 0) return 0;
  const fx = (x - minX) / spanX;
  const fz = (z - minZ) / spanZ;
  const ix = Math.max(0, Math.min(n - 1, Math.floor(fx * n)));
  const iz = Math.max(0, Math.min(n - 1, Math.floor(fz * n)));
  return iz * n + ix;
}

/**
 * Prefer the natural sector; if full, spiral outward to a neighbor with capacity.
 * @param {number} preferredIndex
 * @param {number} grid
 * @param {(index: number) => boolean} hasRoom
 */
export function findSectorWithRoom(preferredIndex, grid, hasRoom) {
  const n = Math.max(1, Math.floor(grid));
  const total = n * n;
  if (preferredIndex < 0 || preferredIndex >= total) {
    preferredIndex = 0;
  }
  if (hasRoom(preferredIndex)) return preferredIndex;

  const px = preferredIndex % n;
  const pz = Math.floor(preferredIndex / n);
  for (let radius = 1; radius < n; radius += 1) {
    for (let dz = -radius; dz <= radius; dz += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
        const x = px + dx;
        const z = pz + dz;
        if (x < 0 || z < 0 || x >= n || z >= n) continue;
        const index = z * n + x;
        if (hasRoom(index)) return index;
      }
    }
  }
  return -1;
}

export function sectorMeshKey(archetype, sectorIndex) {
  return `${archetype}@${sectorIndex}`;
}
