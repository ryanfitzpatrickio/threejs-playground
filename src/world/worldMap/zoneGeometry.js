/**
 * zoneGeometry.js
 *
 * Spatial math for world-map zones, shared by the 2D editor and the runtime so the
 * rect/polygon logic lives in exactly one place. A zone is either:
 *   { shape: 'rect', rect: { minX, minZ, maxX, maxZ } }
 *   { shape: 'polygon', points: [{ x, z }, ...] }   // >= 3 points
 */

export function zoneBounds(zone) {
  if (zone.shape === 'polygon') {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const p of zone.points ?? []) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    return { minX, minZ, maxX, maxZ };
  }
  return zone.rect;
}

function pointInPolygon(points, x, z) {
  // Ray-cast (even-odd) test.
  let inside = false;
  const n = points.length;
  for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
    const xi = points[i].x, zi = points[i].z;
    const xj = points[j].x, zj = points[j].z;
    const intersects = (zi > z) !== (zj > z) &&
      x < ((xj - xi) * (z - zi)) / (zj - zi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function zoneContains(zone, x, z) {
  if (zone.shape === 'polygon') {
    const b = zoneBounds(zone);
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) return false; // bbox pre-reject
    return pointInPolygon(zone.points, x, z);
  }
  const r = zone.rect;
  return x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ;
}

function distanceToSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  let t = lenSq > 0 ? ((px - ax) * dx + (pz - az) * dz) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cz = az + t * dz;
  return Math.hypot(px - cx, pz - cz);
}

/** 0 if inside the zone, else the distance to the nearest edge. Drives blend ramps. */
export function zoneDistanceOutside(zone, x, z) {
  if (zoneContains(zone, x, z)) return 0;

  if (zone.shape === 'polygon') {
    const pts = zone.points;
    let best = Infinity;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
      const d = distanceToSegment(x, z, pts[j].x, pts[j].z, pts[i].x, pts[i].z);
      if (d < best) best = d;
    }
    return best;
  }

  const r = zone.rect;
  const dx = Math.max(r.minX - x, 0, x - r.maxX);
  const dz = Math.max(r.minZ - z, 0, z - r.maxZ);
  return Math.hypot(dx, dz);
}

export function polygonArea(points) {
  let area = 0;
  const n = points.length;
  for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
    area += (points[j].x + points[i].x) * (points[j].z - points[i].z);
  }
  return Math.abs(area) * 0.5;
}

function segmentsIntersect(ax, az, bx, bz, cx, cz, dx, dz) {
  const d1 = cross(cx, cz, dx, dz, ax, az);
  const d2 = cross(cx, cz, dx, dz, bx, bz);
  const d3 = cross(ax, az, bx, bz, cx, cz);
  const d4 = cross(ax, az, bx, bz, dx, dz);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

function cross(ox, oz, ax, az, bx, bz) {
  return (ax - ox) * (bz - oz) - (az - oz) * (bx - ox);
}

/** Does the zone overlap an axis-aligned rect { minX, minZ, maxX, maxZ }? */
export function zoneIntersectsRect(zone, rect) {
  if (zone.shape !== 'polygon') {
    const r = zone.rect;
    return r.minX <= rect.maxX && r.maxX >= rect.minX && r.minZ <= rect.maxZ && r.maxZ >= rect.minZ;
  }

  // Coarse bbox reject.
  const b = zoneBounds(zone);
  if (b.minX > rect.maxX || b.maxX < rect.minX || b.minZ > rect.maxZ || b.maxZ < rect.minZ) {
    return false;
  }

  const pts = zone.points;
  // Any polygon vertex inside the rect?
  for (const p of pts) {
    if (p.x >= rect.minX && p.x <= rect.maxX && p.z >= rect.minZ && p.z <= rect.maxZ) return true;
  }
  // Any rect corner inside the polygon?
  const corners = [
    [rect.minX, rect.minZ], [rect.maxX, rect.minZ],
    [rect.maxX, rect.maxZ], [rect.minX, rect.maxZ],
  ];
  for (const [cx, cz] of corners) {
    if (pointInPolygon(pts, cx, cz)) return true;
  }
  // Any edge crossing?
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    for (let k = 0; k < 4; k += 1) {
      const a = corners[k], c = corners[(k + 1) % 4];
      if (segmentsIntersect(pts[j].x, pts[j].z, pts[i].x, pts[i].z, a[0], a[1], c[0], c[1])) return true;
    }
  }
  return false;
}

export { pointInPolygon };
