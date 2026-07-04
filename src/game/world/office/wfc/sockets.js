// Vendored from SkyeShark's level-maker (~/source/level-maker/src) — a socket-based
// 3D Wave Function Collapse engine (Three-independent). Kept verbatim; the office
// tileset + grid setup that drive it live alongside in ../. See
// docs/office-interior-wfc-plan.md.

export const SOCKET_EMPTY = 'empty';
export const SOCKET_ANY = 'any';

export const defaultSockets = {
  PX: SOCKET_ANY,
  NX: SOCKET_ANY,
  PY: SOCKET_ANY,
  NY: SOCKET_ANY,
  PZ: SOCKET_ANY,
  NZ: SOCKET_ANY,
};
