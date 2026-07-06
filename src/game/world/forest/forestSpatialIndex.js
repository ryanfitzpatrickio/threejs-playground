const DEFAULT_CELL_SIZE = 32;

function cellKey(cx, cz) {
  return `${cx},${cz}`;
}

export function buildForestSpatialIndex(items, { cellSize = DEFAULT_CELL_SIZE } = {}) {
  const cells = new Map();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const cx = Math.floor(item.x / cellSize);
    const cz = Math.floor(item.z / cellSize);
    const key = cellKey(cx, cz);
    const cell = cells.get(key) ?? [];
    cell.push(index);
    cells.set(key, cell);
  }
  return { items, cells, cellSize };
}

export function queryForestSpatialIndex(index, x, z, radius, { withDistance = false } = {}) {
  if (!index?.items?.length || radius < 0) return [];
  const { items, cells, cellSize } = index;
  const cellRadius = Math.ceil(radius / cellSize);
  const centerX = Math.floor(x / cellSize);
  const centerZ = Math.floor(z / cellSize);
  const radiusSq = radius * radius;
  const result = [];

  for (let dz = -cellRadius; dz <= cellRadius; dz += 1) {
    for (let dx = -cellRadius; dx <= cellRadius; dx += 1) {
      const cell = cells.get(cellKey(centerX + dx, centerZ + dz));
      if (!cell) continue;
      for (const itemIndex of cell) {
        const item = items[itemIndex];
        const ddx = item.x - x;
        const ddz = item.z - z;
        const distSq = ddx * ddx + ddz * ddz;
        if (distSq > radiusSq) continue;
        result.push(withDistance ? { index: itemIndex, item, distSq } : item);
      }
    }
  }
  return result;
}
