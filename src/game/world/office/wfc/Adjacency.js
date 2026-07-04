// Vendored from SkyeShark's level-maker (~/source/level-maker/src) — a socket-based
// 3D Wave Function Collapse engine (Three-independent). Kept verbatim; the office
// tileset + grid setup that drive it live alongside in ../. See
// docs/office-interior-wfc-plan.md.

import { OPPOSITE } from './directions.js';

export function areCompatible(a, b, dir) {
  if (!a || !b) return true;
  if (a.category !== b.category) return true;

  const aSock = a?.sockets?.[dir] || 'any';
  const bSock = b?.sockets?.[OPPOSITE[dir]] || 'any';

  if (aSock === 'any' || bSock === 'any') return true;
  return aSock === bSock;
}
