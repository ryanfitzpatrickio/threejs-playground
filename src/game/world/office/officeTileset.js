// officeTileset.js — WFC tiles for a single-floor office (docs/office-interior-wfc-plan.md).
//
// Every tile shares category 'office' so their sockets are actually compared
// (Adjacency treats cross-category pairs as permissive). Socket scheme, chosen so
// a plausible floor plan falls out of purely local adjacency:
//   - corridor : 'any' on all four sides — the universal connector.
//   - open     : 'open' — open-plan cells only touch open or corridor.
//   - meeting  : 'M'    — a room type; only touches its own kind or corridor.
//   - office   : 'O'    — another room type; same rule.
// So open / meeting / office form separate blobs that can only be stitched
// together through corridors → enclosed rooms off hallways, with open-plan areas.

import { TileDefinition } from './wfc/TileDefinition.js';
import { TileSet } from './wfc/TileSet.js';

// Fillable zones (the 'empty' tile is required by the solver but never placed in
// an occupied cell). ROOM_ZONES get walled off; corridor/open stay walkable.
export const OFFICE_ZONES = ['corridor', 'open', 'meeting', 'office'];
export const ROOM_ZONES = new Set(['meeting', 'office']);

function sides(socket) {
  return { PX: socket, NX: socket, PZ: socket, NZ: socket, PY: 'any', NY: 'any' };
}

export function createOfficeTileSet() {
  const tileSet = new TileSet();
  tileSet.register(new TileDefinition({ id: 'empty', category: 'office', sockets: sides('empty'), weight: 1 }));
  tileSet.register(new TileDefinition({ id: 'corridor', category: 'office', sockets: sides('any'), weight: 2 }));
  tileSet.register(new TileDefinition({ id: 'open', category: 'office', sockets: sides('open'), weight: 2 }));
  tileSet.register(new TileDefinition({ id: 'meeting', category: 'office', sockets: sides('M'), weight: 2 }));
  tileSet.register(new TileDefinition({ id: 'office', category: 'office', sockets: sides('O'), weight: 3 }));
  return tileSet;
}
