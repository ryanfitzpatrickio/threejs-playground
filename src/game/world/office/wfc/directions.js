// Vendored from SkyeShark's level-maker (~/source/level-maker/src) — a socket-based
// 3D Wave Function Collapse engine (Three-independent). Kept verbatim; the office
// tileset + grid setup that drive it live alongside in ../. See
// docs/office-interior-wfc-plan.md.

export const WFC_DIRECTIONS = [
  'PX',
  'NX',
  'PY',
  'NY',
  'PZ',
  'NZ',
];

export const OPPOSITE = {
  PX: 'NX',
  NX: 'PX',
  PY: 'NY',
  NY: 'PY',
  PZ: 'NZ',
  NZ: 'PZ',
};
