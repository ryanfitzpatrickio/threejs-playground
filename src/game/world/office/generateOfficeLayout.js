// generateOfficeLayout.js — run the office WFC over a footprint and return the
// zone grid plus interior partition-wall segments (docs/office-interior-wfc-plan.md).
//
// Pure/deterministic (seed → identical layout), node-testable. The interior level
// factory consumes `walls` (local metres, room-centred) to build partition
// geometry + colliders, turning the placeholder box into a real floor plan.

import { Grid3D } from './wfc/Grid3D.js';
import { WFCSolver } from './wfc/WFCSolver.js';
import { createOfficeTileSet, OFFICE_ZONES, ROOM_ZONES } from './officeTileset.js';

const CELL_TARGET = 3.2; // ~metres per grid cell (office module scale)

function entryCell(cols, rows, doorFacade) {
  switch (doorFacade) {
    case 'PZ': return { x: (cols - 1) >> 1, z: rows - 1 };
    case 'NX': return { x: 0, z: (rows - 1) >> 1 };
    case 'PX': return { x: cols - 1, z: (rows - 1) >> 1 };
    default: return { x: (cols - 1) >> 1, z: 0 }; // NZ
  }
}

/**
 * @returns {{ cols, rows, cellW, cellD, zones: string[][], walls: Array, solved: boolean }}
 * `zones[x][z]` is a zone id; `walls` are `{ cx, cz, sx, sz }` boxes in local
 * (origin-centred) metres.
 */
export function generateOfficeLayout({ width, depth, doorFacade = 'NZ', seed = 1 } = {}) {
  const cols = Math.max(2, Math.round(width / CELL_TARGET));
  const rows = Math.max(2, Math.round(depth / CELL_TARGET));
  const cellW = width / cols;
  const cellD = depth / rows;

  const grid = new Grid3D({ width: cols, height: 1, depth: rows });
  const tileSet = createOfficeTileSet();

  for (const cell of grid.getAllCells()) {
    cell.occupancy = 'floor';
    cell.possibleTiles = new Set(OFFICE_ZONES);
  }

  // Constrain the entry cell to open floor so you always arrive somewhere
  // walkable — but leave it for the SOLVER to collapse (min entropy → it goes
  // first) rather than pre-collapsing it, so its incompatibility with adjacent
  // rooms actually propagates. (A pre-collapsed cell never filters its neighbours.)
  const entry = entryCell(cols, rows, doorFacade);
  const ec = grid.getCell(entry.x, 0, entry.z);
  if (ec) ec.possibleTiles = new Set(['open']);

  const solver = new WFCSolver({ seed: seed || 1, maxIterations: cols * rows * 6 });
  const solved = solver.run(grid, tileSet);

  // Read the zone grid (fall back to walkable 'open' anywhere unresolved).
  const zones = [];
  for (let x = 0; x < cols; x += 1) {
    zones[x] = [];
    for (let z = 0; z < rows; z += 1) {
      const c = grid.getCell(x, 0, z);
      const t = c?.collapsedTile;
      zones[x][z] = t && t !== 'empty' ? t : 'open';
    }
  }

  const doorEdges = pickRoomDoors(zones, cols, rows);
  const walls = buildInteriorWalls(zones, cols, rows, cellW, cellD, width, depth, doorEdges);
  return { cols, rows, cellW, cellD, zones, walls, solved };
}

function edgeKey(ax, az, bx, bz) {
  // Order-independent key for the shared edge between two cells.
  return ax < bx || az < bz ? `${ax},${az}|${bx},${bz}` : `${bx},${bz}|${ax},${az}`;
}

// Flood-fill each connected room region and pick ONE boundary edge (to a
// corridor where possible) to leave open as a door, so every room is enterable.
function pickRoomDoors(zones, cols, rows) {
  const doors = new Set();
  const seen = Array.from({ length: cols }, () => new Array(rows).fill(false));
  const neigh = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  for (let x = 0; x < cols; x += 1) {
    for (let z = 0; z < rows; z += 1) {
      if (seen[x][z] || !ROOM_ZONES.has(zones[x][z])) continue;
      const zone = zones[x][z];
      const stack = [[x, z]];
      seen[x][z] = true;
      const boundary = []; // candidate door edges for this region
      while (stack.length) {
        const [cx, cz] = stack.pop();
        for (const [dx, dz] of neigh) {
          const nx = cx + dx;
          const nz = cz + dz;
          if (nx < 0 || nx >= cols || nz < 0 || nz >= rows) continue;
          if (zones[nx][nz] === zone) {
            if (!seen[nx][nz]) { seen[nx][nz] = true; stack.push([nx, nz]); }
          } else {
            boundary.push({ ax: cx, az: cz, bx: nx, bz: nz, corridor: zones[nx][nz] === 'corridor' });
          }
        }
      }
      if (boundary.length === 0) continue;
      // Prefer a corridor-facing edge; deterministic pick (stable sort by key).
      boundary.sort((a, b) => (b.corridor - a.corridor)
        || edgeKey(a.ax, a.az, a.bx, a.bz).localeCompare(edgeKey(b.ax, b.az, b.bx, b.bz)));
      const d = boundary[0];
      doors.add(edgeKey(d.ax, d.az, d.bx, d.bz));
    }
  }
  return doors;
}

// Emit a wall on every room↔non-room boundary between two in-bounds cells,
// except the chosen door edges. (Perimeter enclosure is the outer wall's job.)
function buildInteriorWalls(zones, cols, rows, cellW, cellD, width, depth, doorEdges) {
  const walls = [];
  const halfW = width / 2;
  const halfD = depth / 2;
  const t = 0.22;

  const consider = (ax, az, bx, bz, axis) => {
    const roomA = ROOM_ZONES.has(zones[ax][az]);
    const roomB = ROOM_ZONES.has(zones[bx][bz]);
    // Exactly one side is a room, and they differ → a room perimeter edge.
    if (roomA === roomB) return;
    if (doorEdges.has(edgeKey(ax, az, bx, bz))) return;
    const zone = roomA ? zones[ax][az] : zones[bx][bz]; // the enclosed room's zone
    if (axis === 'x') {
      // Shared edge is the vertical plane between (ax,az) and (ax+1,az).
      walls.push({
        cx: -halfW + (ax + 1) * cellW,
        cz: -halfD + (az + 0.5) * cellD,
        sx: t,
        sz: cellD,
        zone,
      });
    } else {
      walls.push({
        cx: -halfW + (ax + 0.5) * cellW,
        cz: -halfD + (az + 1) * cellD,
        sx: cellW,
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
  return walls;
}
