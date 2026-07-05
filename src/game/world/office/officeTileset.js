// officeTileset.js — WFC tiles for a single-floor office (docs/office-interior-wfc-plan.md).
//
// Socket scheme:
//   corridor : 'any' on all four sides — universal connector.
//   open     : 'open' — open-plan only touches open or corridor.
//   meeting  : 'M'    — room blob; touches M or corridor.
//   office   : 'O'    — room blob; touches O or corridor.
//   elev_*   : 1×1 shaft — 'W' solid on three sides, 'any' on the lobby side.

import { TileDefinition } from './wfc/TileDefinition.js';
import { TileSet } from './wfc/TileSet.js';

export const WALL_SOCKET = 'W';

export const BASE_OFFICE_ZONES = ['corridor', 'open', 'meeting', 'office'];
export const OFFICE_ZONES = [...BASE_OFFICE_ZONES, 'elevator'];
export const ROOM_ZONES = new Set(['meeting', 'office', 'elevator']);

const LOBBY_SIDES = ['NZ', 'PZ', 'NX', 'PX'];

function sides(socket) {
  return { PX: socket, NX: socket, PZ: socket, NZ: socket, PY: 'any', NY: 'any' };
}

/** Sockets for a 1×1 elevator cell; lobbySide is the corridor door facade. */
export function elevatorSockets(lobbySide) {
  return {
    NZ: lobbySide === 'NZ' ? 'any' : WALL_SOCKET,
    PZ: lobbySide === 'PZ' ? 'any' : WALL_SOCKET,
    NX: lobbySide === 'NX' ? 'any' : WALL_SOCKET,
    PX: lobbySide === 'PX' ? 'any' : WALL_SOCKET,
    PY: 'any',
    NY: 'any',
  };
}

export function elevatorTileId(lobbySide) {
  return `elev_${lobbySide.toLowerCase()}`;
}

export function lobbySideFromCell(gx, gz, lobby) {
  if (!lobby) return 'NZ';
  if (lobby.gz === gz - 1) return 'NZ';
  if (lobby.gz === gz + 1) return 'PZ';
  if (lobby.gx === gx - 1) return 'NX';
  if (lobby.gx === gx + 1) return 'PX';
  return 'NZ';
}

export function zoneFromTile(tileId) {
  if (!tileId || tileId === 'empty') return 'open';
  if (tileId.startsWith('elev_')) return 'elevator';
  return tileId;
}

export function isElevatorTile(tileId) {
  return tileId?.startsWith('elev_') ?? false;
}

export function createOfficeTileSet() {
  const tileSet = new TileSet();
  tileSet.register(new TileDefinition({ id: 'empty', category: 'office', sockets: sides('empty'), weight: 1 }));
  tileSet.register(new TileDefinition({ id: 'corridor', category: 'office', sockets: sides('any'), weight: 2 }));
  tileSet.register(new TileDefinition({ id: 'open', category: 'office', sockets: sides('open'), weight: 2 }));
  tileSet.register(new TileDefinition({ id: 'meeting', category: 'office', sockets: sides('M'), weight: 2 }));
  tileSet.register(new TileDefinition({ id: 'office', category: 'office', sockets: sides('O'), weight: 3 }));

  for (const lobbySide of LOBBY_SIDES) {
    const id = elevatorTileId(lobbySide);
    tileSet.register(new TileDefinition({
      id,
      category: 'office',
      sockets: elevatorSockets(lobbySide),
      weight: 1,
    }));
  }
  return tileSet;
}
