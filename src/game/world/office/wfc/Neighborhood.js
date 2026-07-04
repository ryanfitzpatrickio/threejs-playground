// Vendored from SkyeShark's level-maker (~/source/level-maker/src) — a socket-based
// 3D Wave Function Collapse engine (Three-independent). Kept verbatim; the office
// tileset + grid setup that drive it live alongside in ../. See
// docs/office-interior-wfc-plan.md.

export const DIRS = {
  PX: { x: 1, y: 0, z: 0, opposite: 'NX' },
  NX: { x: -1, y: 0, z: 0, opposite: 'PX' },
  PY: { x: 0, y: 1, z: 0, opposite: 'NY' },
  NY: { x: 0, y: -1, z: 0, opposite: 'PY' },
  PZ: { x: 0, y: 0, z: 1, opposite: 'NZ' },
  NZ: { x: 0, y: 0, z: -1, opposite: 'PZ' },
};

export const DIRECTIONS = Object.keys(DIRS);

export function isBoundary(grid, cell, dir) {
  const delta = DIRS[dir];
  return !grid.getCell(cell.x + delta.x, cell.y + delta.y, cell.z + delta.z);
}
