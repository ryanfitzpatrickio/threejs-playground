// generateOfficeLayout.js — run the office WFC over a footprint and return the
// zone grid plus interior partition-wall segments (docs/office-interior-wfc-plan.md).
//
// Pure/deterministic (seed → identical layout), node-testable. The interior level
// factory consumes `walls` (local metres, room-centred) to build partition
// geometry + colliders, turning the placeholder box into a real floor plan.

import { Grid3D } from './wfc/Grid3D.js';
import { WFCSolver } from './wfc/WFCSolver.js';
import {
  BASE_OFFICE_ZONES,
  ROOM_ZONES,
  createOfficeTileSet,
  elevatorTileId,
  lobbySideFromCell,
  zoneFromTile,
} from './officeTileset.js';

/** ~metres per grid cell (office module scale). */
export const CELL_TARGET = 3.2;
export const ELEVATOR_SIZE = 1;
const NEIGH = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function entryCell(cols, rows, doorFacade) {
  switch (doorFacade) {
    case 'PZ': return { x: (cols - 1) >> 1, z: rows - 1 };
    case 'NX': return { x: 0, z: (rows - 1) >> 1 };
    case 'PX': return { x: cols - 1, z: (rows - 1) >> 1 };
    default: return { x: (cols - 1) >> 1, z: 0 }; // NZ
  }
}

function elevatorGridCell(cols, rows) {
  return {
    gx: Math.max(1, Math.min(cols - 2, cols >> 1)),
    gz: Math.max(1, Math.min(rows - 2, rows >> 1)),
  };
}

function elevatorLobbyCandidates(gx, gz, cols, rows) {
  const candidates = [];
  if (gz > 0) candidates.push({ gx, gz: gz - 1 });
  if (gz + 1 < rows) candidates.push({ gx, gz: gz + 1 });
  if (gx > 0) candidates.push({ gx: gx - 1, gz });
  if (gx + 1 < cols) candidates.push({ gx: gx + 1, gz });
  return candidates;
}

function cellHash(seed, x, z) {
  let h = (seed | 0) ^ Math.imul(x + 1, 374761393) ^ Math.imul(z + 1, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function edgeKey(ax, az, bx, bz) {
  return ax < bx || az < bz ? `${ax},${az}|${bx},${bz}` : `${bx},${bz}|${ax},${az}`;
}

/** World-space centre + yaw for a door edge between two adjacent grid cells. */
export function doorEdgeWorld(door, originMinX, originMinZ, cw, cd) {
  if (door.bx !== door.ax) {
    const wallX = originMinX + Math.max(door.ax, door.bx) * cw;
    const z0 = originMinZ + Math.min(door.az, door.bz) * cd;
    const z1 = originMinZ + (Math.max(door.az, door.bz) + 1) * cd;
    return {
      x: wallX,
      z: (z0 + z1) * 0.5,
      yaw: Math.atan2(door.bx - door.ax, door.bz - door.az),
    };
  }
  const wallZ = originMinZ + Math.max(door.az, door.bz) * cd;
  const x0 = originMinX + Math.min(door.ax, door.bx) * cw;
  const x1 = originMinX + (Math.max(door.ax, door.bx) + 1) * cw;
  return {
    x: (x0 + x1) * 0.5,
    z: wallZ,
    yaw: Math.atan2(door.bx - door.ax, door.bz - door.az),
  };
}

/** Grid cells that must stay clear of furniture near door openings. */
export function buildDoorClearanceSet(doorEdges, margin = 1) {
  const blocked = new Set();
  for (const d of doorEdges) {
    blocked.add(`${d.roomGx},${d.roomGz}`);
    blocked.add(`${d.corridorGx},${d.corridorGz}`);
    for (let m = -margin; m <= margin; m += 1) {
      if (d.axis === 'x') {
        blocked.add(`${d.roomGx},${d.roomGz + m}`);
        blocked.add(`${d.corridorGx},${d.corridorGz + m}`);
      } else {
        blocked.add(`${d.roomGx + m},${d.roomGz}`);
        blocked.add(`${d.corridorGx + m},${d.corridorGz}`);
      }
    }
  }
  return blocked;
}

function lockDirectionalElevator(grid, gx, gz, lobbySide) {
  const c = grid.getCell(gx, 0, gz);
  if (c) c.possibleTiles = new Set([elevatorTileId(lobbySide)]);
}

function finalizeZones(grid, cols, rows, elevatorCells, elevatorLobby) {
  const zones = [];
  for (let x = 0; x < cols; x += 1) {
    zones[x] = [];
    for (let z = 0; z < rows; z += 1) {
      const c = grid.getCell(x, 0, z);
      zones[x][z] = zoneFromTile(c?.collapsedTile);
    }
  }
  for (const { gx, gz } of elevatorCells) zones[gx][gz] = 'elevator';
  if (elevatorLobby) zones[elevatorLobby.gx][elevatorLobby.gz] = 'corridor';
  return zones;
}

function ensureCorridorAccess(zones, cols, rows, skipKeys) {
  const seen = Array.from({ length: cols }, () => new Array(rows).fill(false));
  for (let x = 0; x < cols; x += 1) {
    for (let z = 0; z < rows; z += 1) {
      const zone = zones[x][z];
      if (zone !== 'office' && zone !== 'meeting') continue;
      if (seen[x][z]) continue;
      const stack = [[x, z]];
      seen[x][z] = true;
      let hasCorridor = false;
      let carve = null;
      while (stack.length) {
        const [cx, cz] = stack.pop();
        for (const [dx, dz] of NEIGH) {
          const nx = cx + dx;
          const nz = cz + dz;
          if (nx < 0 || nx >= cols || nz < 0 || nz >= rows) continue;
          const nzZone = zones[nx][nz];
          if (nzZone === zone) {
            if (!seen[nx][nz]) { seen[nx][nz] = true; stack.push([nx, nz]); }
          } else if (nzZone === 'corridor') {
            hasCorridor = true;
          } else if (!carve && nzZone !== 'elevator' && !skipKeys.has(`${nx},${nz}`)) {
            carve = { gx: nx, gz: nz };
          }
        }
      }
      if (!hasCorridor && carve) zones[carve.gx][carve.gz] = 'corridor';
    }
  }
}

function findElevatorDoorEdge(elevatorCells, elevatorLobby) {
  if (!elevatorLobby) return null;
  for (const { gx, gz } of elevatorCells) {
    for (const [dx, dz] of NEIGH) {
      const bx = gx + dx;
      const bz = gz + dz;
      if (bx === elevatorLobby.gx && bz === elevatorLobby.gz) {
        return {
          ax: gx, az: gz, bx, bz,
          zone: 'elevator',
          roomGx: gx,
          roomGz: gz,
          corridorGx: bx,
          corridorGz: bz,
          axis: bx !== gx ? 'x' : 'z',
        };
      }
    }
  }
  return null;
}

function pickRoomDoors(zones, cols, rows, elevatorCells, elevatorLobby) {
  const doorKeys = new Set();
  const doorEdges = [];
  const elevDoor = findElevatorDoorEdge(elevatorCells, elevatorLobby);
  if (elevDoor) {
    doorKeys.add(edgeKey(elevDoor.ax, elevDoor.az, elevDoor.bx, elevDoor.bz));
    doorEdges.push(elevDoor);
  }

  const elevSkip = new Set(elevatorCells.map(({ gx, gz }) => `${gx},${gz}`));
  const seen = Array.from({ length: cols }, () => new Array(rows).fill(false));

  for (let x = 0; x < cols; x += 1) {
    for (let z = 0; z < rows; z += 1) {
      if (seen[x][z] || elevSkip.has(`${x},${z}`)) continue;
      const zone = zones[x][z];
      if (zone !== 'office' && zone !== 'meeting') continue;
      const stack = [[x, z]];
      seen[x][z] = true;
      const boundary = [];
      while (stack.length) {
        const [cx, cz] = stack.pop();
        for (const [dx, dz] of NEIGH) {
          const nx = cx + dx;
          const nz = cz + dz;
          if (nx < 0 || nx >= cols || nz < 0 || nz >= rows) continue;
          if (zones[nx][nz] === zone) {
            if (!seen[nx][nz]) { seen[nx][nz] = true; stack.push([nx, nz]); }
          } else {
            boundary.push({
              ax: cx, az: cz, bx: nx, bz: nz,
              corridor: zones[nx][nz] === 'corridor',
            });
          }
        }
      }
      if (boundary.length === 0) continue;
      boundary.sort((a, b) => (b.corridor - a.corridor)
        || edgeKey(a.ax, a.az, a.bx, a.bz).localeCompare(edgeKey(b.ax, b.az, b.bx, b.bz)));
      const corridorEdges = boundary.filter((b) => b.corridor);
      const picks = zone === 'meeting' && corridorEdges.length > 0
        ? corridorEdges
        : [corridorEdges[0] ?? boundary[0]];
      for (const d of picks) {
        const key = edgeKey(d.ax, d.az, d.bx, d.bz);
        if (doorKeys.has(key)) continue;
        doorKeys.add(key);
        doorEdges.push({
          ax: d.ax, az: d.az, bx: d.bx, bz: d.bz,
          zone,
          roomGx: d.ax,
          roomGz: d.az,
          corridorGx: d.bx,
          corridorGz: d.bz,
          axis: d.bx !== d.ax ? 'x' : 'z',
        });
      }
    }
  }
  return doorEdges;
}

export const DOOR_OPENING_RATIO = 0.56;
export const PARTITION_THICKNESS = 0.22;

/** Corridor-facing mount point for a partition door frame + room plate. */
export function doorMountFrame(door, originMinX, originMinZ, cw, cd, wallHeight, wallT = PARTITION_THICKNESS) {
  const dw = doorEdgeWorld(door, originMinX, originMinZ, cw, cd);
  const nx = Math.sin(dw.yaw);
  const nz = Math.cos(dw.yaw);
  const faceX = dw.x + nx * (wallT * 0.5 + 0.008);
  const faceZ = dw.z + nz * (wallT * 0.5 + 0.008);
  const edgeLen = door.axis === 'x' ? cd : cw;
  const opening = edgeLen * DOOR_OPENING_RATIO;
  const doorH = Math.min(2.15, wallHeight - 0.25);
  const jambW = (edgeLen - opening) * 0.5;
  const headerH = wallHeight - doorH;
  const frameFront = 0.062;
  return {
    ...dw,
    faceX,
    faceZ,
    nx,
    nz,
    edgeLen,
    opening,
    doorH,
    jambW,
    headerH,
    wallT,
    plateX: faceX + nx * frameFront,
    plateZ: faceZ + nz * frameFront,
  };
}

function partitionEdge(zones, doorKeys, ax, az, bx, bz) {
  if (doorKeys.has(edgeKey(ax, az, bx, bz))) return false;
  const roomA = ROOM_ZONES.has(zones[ax][az]);
  const roomB = ROOM_ZONES.has(zones[bx][bz]);
  return roomA !== roomB;
}

function addInteriorWallCorners(walls, zones, cols, rows, cellW, cellD, halfW, halfD, t, doorKeys) {
  const hasXWall = (ix, iz) => ix > 0 && ix < cols && iz >= 0 && iz < rows
    && partitionEdge(zones, doorKeys, ix - 1, iz, ix, iz);
  const hasZWall = (ix, iz) => iz > 0 && iz < rows && ix >= 0 && ix < cols
    && partitionEdge(zones, doorKeys, ix, iz - 1, ix, iz);

  for (let ix = 1; ix < cols; ix += 1) {
    for (let iz = 1; iz < rows; iz += 1) {
      const xNear = hasXWall(ix, iz) || hasXWall(ix, iz - 1);
      const zNear = hasZWall(ix, iz) || hasZWall(ix - 1, iz);
      if (!xNear || !zNear) continue;

      let zone = 'office';
      for (const [gx, gz] of [[ix - 1, iz - 1], [ix, iz - 1], [ix - 1, iz], [ix, iz]]) {
        if (ROOM_ZONES.has(zones[gx][gz])) {
          zone = zones[gx][gz];
          break;
        }
      }

      walls.push({
        cx: -halfW + ix * cellW,
        cz: -halfD + iz * cellD,
        sx: t,
        sz: t,
        zone,
      });
    }
  }
}

function addDoorJambs(walls, door, cellW, cellD, halfW, halfD, t) {
  const opening = Math.min(cellW, cellD) * DOOR_OPENING_RATIO;
  const { ax, az, axis, zone } = door;
  const edgeLen = axis === 'x' ? cellD : cellW;
  const jamb = (edgeLen - opening) * 0.5;
  if (jamb < 0.06) return;
  const jambLen = jamb + t;

  if (axis === 'x') {
    const cx = -halfW + (ax + 1) * cellW;
    walls.push({
      cx,
      cz: -halfD + az * cellD + jambLen * 0.5,
      sx: t,
      sz: jambLen,
      zone,
    });
    walls.push({
      cx,
      cz: -halfD + (az + 1) * cellD - jambLen * 0.5,
      sx: t,
      sz: jambLen,
      zone,
    });
  } else {
    const cz = -halfD + (az + 1) * cellD;
    walls.push({
      cx: -halfW + ax * cellW + jambLen * 0.5,
      cz,
      sx: jambLen,
      sz: t,
      zone,
    });
    walls.push({
      cx: -halfW + (ax + 1) * cellW - jambLen * 0.5,
      cz,
      sx: jambLen,
      sz: t,
      zone,
    });
  }
}

function buildInteriorWalls(zones, cols, rows, cellW, cellD, width, depth, doorEdges) {
  const doorKeys = new Set(doorEdges.map((d) => edgeKey(d.ax, d.az, d.bx, d.bz)));
  const walls = [];
  const halfW = width / 2;
  const halfD = depth / 2;
  const t = PARTITION_THICKNESS;

  const consider = (ax, az, bx, bz, axis) => {
    const roomA = ROOM_ZONES.has(zones[ax][az]);
    const roomB = ROOM_ZONES.has(zones[bx][bz]);
    if (roomA === roomB) return;
    if (doorKeys.has(edgeKey(ax, az, bx, bz))) return;
    const zone = roomA ? zones[ax][az] : zones[bx][bz];
    if (axis === 'x') {
      walls.push({
        cx: -halfW + (ax + 1) * cellW,
        cz: -halfD + (az + 0.5) * cellD,
        sx: t,
        sz: cellD + t,
        zone,
      });
    } else {
      walls.push({
        cx: -halfW + (ax + 0.5) * cellW,
        cz: -halfD + (az + 1) * cellD,
        sx: cellW + t,
        sz: t,
        zone,
      });
    }
  };

  for (let x = 0; x < cols; x += 1) {
    for (let z = 0; z < rows; z += 1) {
      if (x + 1 < cols) consider(x, z, x + 1, z, 'x');
      if (z + 1 < rows) consider(x, z, x, z + 1, 'z');
    }
  }
  for (const d of doorEdges) {
    if (d.zone === 'elevator') continue;
    addDoorJambs(walls, d, cellW, cellD, halfW, halfD, t);
  }
  addInteriorWallCorners(walls, zones, cols, rows, cellW, cellD, halfW, halfD, t, doorKeys);
  return walls;
}

function ensureEntryLobbyRoute(zones, cols, rows, entry, lobby, elevator) {
  if (!entry || !lobby) return;
  const startKey = `${entry.x},${entry.z}`;
  const goalKey = `${lobby.gx},${lobby.gz}`;
  const blockedKey = `${elevator.gx},${elevator.gz}`;
  const distance = new Map([[startKey, 0]]);
  const previous = new Map();
  const queue = [{ x: entry.x, z: entry.z, cost: 0 }];
  while (queue.length > 0) {
    queue.sort((a, b) => a.cost - b.cost || a.x - b.x || a.z - b.z);
    const current = queue.shift();
    const key = `${current.x},${current.z}`;
    if (current.cost !== distance.get(key)) continue;
    if (key === goalKey) break;
    for (const [dx, dz] of NEIGH) {
      const x = current.x + dx;
      const z = current.z + dz;
      if (x < 0 || z < 0 || x >= cols || z >= rows) continue;
      const nextKey = `${x},${z}`;
      if (nextKey === blockedKey) continue;
      const zone = zones[x][z];
      // Prefer existing circulation; crossing a room is allowed only when it is
      // the minimum deterministic carve needed to connect entrance and lobby.
      const stepCost = zone === 'open' || zone === 'corridor' ? 1 : 5;
      const nextCost = current.cost + stepCost;
      if (nextCost >= (distance.get(nextKey) ?? Infinity)) continue;
      distance.set(nextKey, nextCost);
      previous.set(nextKey, key);
      queue.push({ x, z, cost: nextCost });
    }
  }
  if (!distance.has(goalKey)) return;
  let key = goalKey;
  while (key !== startKey) {
    const [x, z] = key.split(',').map(Number);
    if (key !== goalKey && zones[x][z] !== 'open') zones[x][z] = 'corridor';
    key = previous.get(key);
    if (!key) break;
  }
}

/**
 * @returns {{
 *   cols, rows, cellW, cellD, zones: string[][], walls: Array,
 *   doorEdges: Array, elevatorCell: {x,z}, elevatorCells: Array,
 *   elevatorLobby: {gx,gz}|null, elevatorLobbySide: string,
 *   entryCell: {x,z}, solved: boolean,
 * }}
 */
export function generateOfficeLayout({
  width,
  depth,
  doorFacade = 'NZ',
  seed = 1,
  buildingSeed = seed,
  floorIndex = 0,
} = {}) {
  const cols = Math.max(ELEVATOR_SIZE + 2, Math.round(width / CELL_TARGET));
  const rows = Math.max(ELEVATOR_SIZE + 2, Math.round(depth / CELL_TARGET));
  const cellW = width / cols;
  const cellD = depth / rows;

  const grid = new Grid3D({ width: cols, height: 1, depth: rows });
  const tileSet = createOfficeTileSet();

  for (const cell of grid.getAllCells()) {
    cell.occupancy = 'floor';
    cell.possibleTiles = new Set(BASE_OFFICE_ZONES);
  }

  const entry = entryCell(cols, rows, doorFacade);
  if (floorIndex === 0) {
    const ec = grid.getCell(entry.x, 0, entry.z);
    if (ec) ec.possibleTiles = new Set(['open']);
  }

  const elev = elevatorGridCell(cols, rows);
  const elevatorCells = [{ gx: elev.gx, gz: elev.gz }];

  const lobbyCandidates = elevatorLobbyCandidates(elev.gx, elev.gz, cols, rows);
  let elevatorLobby = null;
  if (lobbyCandidates.length > 0) {
    const pick = lobbyCandidates[Math.floor(cellHash(buildingSeed, elev.gx, elev.gz) * lobbyCandidates.length)];
    elevatorLobby = { gx: pick.gx, gz: pick.gz };
    const lobby = grid.getCell(pick.gx, 0, pick.gz);
    if (lobby) lobby.possibleTiles = new Set(['corridor']);
  }

  const elevatorLobbySide = lobbySideFromCell(elev.gx, elev.gz, elevatorLobby);
  lockDirectionalElevator(grid, elev.gx, elev.gz, elevatorLobbySide);

  const solver = new WFCSolver({ seed: seed || 1, maxIterations: cols * rows * 8 });
  const solved = solver.run(grid, tileSet);

  let zones = finalizeZones(grid, cols, rows, elevatorCells, elevatorLobby);

  const elevSkip = new Set(elevatorCells.map(({ gx, gz }) => `${gx},${gz}`));
  if (elevatorLobby) elevSkip.add(`${elevatorLobby.gx},${elevatorLobby.gz}`);
  ensureCorridorAccess(zones, cols, rows, elevSkip);
  if (floorIndex === 0) ensureEntryLobbyRoute(zones, cols, rows, entry, elevatorLobby, elev);

  const doorEdges = pickRoomDoors(zones, cols, rows, elevatorCells, elevatorLobby);
  const walls = buildInteriorWalls(zones, cols, rows, cellW, cellD, width, depth, doorEdges);

  return {
    cols,
    rows,
    cellW,
    cellD,
    zones,
    walls,
    doorEdges,
    elevatorCell: { x: elev.gx, z: elev.gz },
    elevatorCells,
    elevatorLobby,
    elevatorLobbySide,
    entryCell: entry,
    solved,
  };
}

export function floorSeed(buildingSeed, floorIndex) {
  return ((buildingSeed ^ Math.imul(floorIndex + 1, 2654435761)) >>> 0) || 1;
}

export const STORY_HEIGHT = 3.2;

export function floorCountFromBuilding(building, storyHeight = STORY_HEIGHT) {
  const h = (building?.topY ?? storyHeight) - (building?.bottomY ?? 0);
  return Math.max(1, Math.min(6, Math.round(h / storyHeight)));
}
