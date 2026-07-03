import { vertexKeyNum } from '../geometry/vertexKey.js';

const DEFAULT_MAX_HULL_POINTS = 768;
const DEFAULT_MIN_HALF_EXTENT = 0.035;

// Compound-sphere tuning. A sliced body part is a concave shell, so a single
// convex hull always lets the mesh sink through the floor at rest. We instead
// stack spheres along the piece's longest axis sized to its cross-section, so
// the mesh stays inside the collider union and can't clip.
const COMPOUND_RADIUS_PAD = 1.08; // grow cross-section radius so organic shapes stay contained between sphere centers
const COMPOUND_SPACING_FACTOR = 1.9; // adjacent centers spaced <= this * radius (forces overlap)
const COMPOUND_MAX_SPHERES = 6;

/**
 * Build collider descriptor(s) for a dynamic cut piece.
 *
 * The geometry MUST be centered on the local origin beforehand (the caller
 * translates it by -boundingBoxCenter), because every collider is attached to a
 * rigidbody whose translation equals that same center. Returned descs are in the
 * body's local space.
 *
 * modes:
 *  - 'compound'    (default) stack of spheres along the longest axis; a single
 *                  circumsphere is used for chunky pieces. Best balance: minimal
 *                  float, eliminates most visible floor sink on organic pieces.
 *  - 'hull'        single convex hull from sampled vertices (the old behavior).
 *                  Tightest fit, but concave pieces sink at rest.
 *  - 'containment' single axis-aligned cuboid sized to the bounding box.
 *                  Mathematically guarantees no clipping, at the cost of the
 *                  piece visibly floating inside the box.
 *
 * @returns {{ descs: object[], type: string, points: number }}
 */
export function createDynamicMeshColliderDesc({
  RAPIER,
  geometry,
  fallbackSize,
  minHalfExtent = DEFAULT_MIN_HALF_EXTENT,
  maxHullPoints = DEFAULT_MAX_HULL_POINTS,
  mode = 'compound',
} = {}) {
  if (mode === 'hull') {
    return buildHull(RAPIER, geometry, minHalfExtent, maxHullPoints);
  }

  if (mode === 'containment') {
    return buildContainmentCuboid(RAPIER, geometry, fallbackSize, minHalfExtent)
      ?? buildHull(RAPIER, geometry, minHalfExtent, maxHullPoints);
  }

  const compound = buildCompoundSpheres(RAPIER, geometry, fallbackSize, minHalfExtent);
  if (compound) {
    return compound;
  }

  // Degenerate geometry (no extents) — fall back to hull/cuboid.
  return buildHull(RAPIER, geometry, minHalfExtent, maxHullPoints);
}

function buildCompoundSpheres(RAPIER, geometry, fallbackSize, minHalfExtent) {
  const ext = readExtents(geometry, fallbackSize);
  if (!ext) {
    return null;
  }

  const { sx, sy, sz, cx, cy, cz } = ext;
  const sizes = [sx, sy, sz];

  let longAxis = 0;
  if (sy > sizes[longAxis]) longAxis = 1;
  if (sz > sizes[longAxis]) longAxis = 2;

  const longExtent = sizes[longAxis];
  const halfLong = longExtent * 0.5;

  // Circumscribed circle of the cross-section (the two non-long axes).
  const shortSizes = [];
  for (let axis = 0; axis < 3; axis += 1) {
    if (axis !== longAxis) {
      shortSizes.push(sizes[axis]);
    }
  }
  const crossR = 0.5 * Math.hypot(shortSizes[0], shortSizes[1]);
  // Full 3D circumsphere radius, used when one sphere must hold a chunky piece.
  const circumR = 0.5 * Math.hypot(sx, sy, sz);

  if (halfLong <= crossR * 1.02) {
    // Chunky piece: a single circumsphere is the smallest sphere that contains
    // the whole mesh, so it can't clip.
    const radius = Math.max(circumR, minHalfExtent);
    return makeSphereDescs(RAPIER, [{ x: cx, y: cy, z: cz }], radius);
  }

  // Elongated piece: stack cross-section spheres with the end spheres sitting
  // on the end faces (so the cut caps are contained), middle spheres bridging.
  const radius = Math.max(crossR * COMPOUND_RADIUS_PAD, minHalfExtent);
  let count = Math.ceil(longExtent / (COMPOUND_SPACING_FACTOR * radius)) + 1;
  count = Math.max(2, Math.min(count, COMPOUND_MAX_SPHERES));

  const axisKey = ['x', 'y', 'z'][longAxis];
  const centers = [];
  for (let index = 0; index < count; index += 1) {
    const t = index / (count - 1);
    const offset = (t * 2 - 1) * halfLong; // spans -halfLong..+halfLong (end faces)
    const center = { x: cx, y: cy, z: cz };
    center[axisKey] += offset;
    centers.push(center);
  }

  return makeSphereDescs(RAPIER, centers, radius);
}

function buildContainmentCuboid(RAPIER, geometry, fallbackSize, minHalfExtent) {
  const ext = readExtents(geometry, fallbackSize);
  if (!ext) {
    return null;
  }

  const desc = RAPIER.ColliderDesc.cuboid(
    Math.max(ext.sx * 0.5, minHalfExtent),
    Math.max(ext.sy * 0.5, minHalfExtent),
    Math.max(ext.sz * 0.5, minHalfExtent),
  ).setTranslation(ext.cx, ext.cy, ext.cz);

  return { descs: [desc], type: 'containment-cuboid', points: 8 };
}

function buildHull(RAPIER, geometry, minHalfExtent, maxHullPoints) {
  const hullVertices = collectHullVertices(geometry, maxHullPoints);

  if (typeof RAPIER?.ColliderDesc?.convexHull === 'function' && hullVertices.length >= 12) {
    try {
      const desc = RAPIER.ColliderDesc.convexHull(hullVertices);

      if (desc) {
        return { descs: [desc], type: 'convexHull', points: hullVertices.length / 3 };
      }
    } catch (error) {
      console.warn('Failed to create convex hull collider for cut mesh; falling back to cuboid.', error);
    }
  }

  const ext = readExtents(geometry, null);
  const desc = RAPIER.ColliderDesc.cuboid(
    Math.max(minHalfExtent, (ext ? ext.sx : 0) * 0.5),
    Math.max(minHalfExtent, (ext ? ext.sy : 0) * 0.5),
    Math.max(minHalfExtent, (ext ? ext.sz : 0) * 0.5),
  );

  return { descs: [desc], type: 'cuboid', points: 8 };
}

function makeSphereDescs(RAPIER, centers, radius) {
  const descs = centers.map((center) => RAPIER.ColliderDesc
    .ball(radius)
    .setTranslation(center.x, center.y, center.z));
  return { descs, type: 'compound-spheres', points: centers.length };
}

function readExtents(geometry, fallbackSize) {
  const box = geometry?.boundingBox;

  if (box && Number.isFinite(box.min.x) && Number.isFinite(box.max.x)) {
    return {
      sx: box.max.x - box.min.x,
      sy: box.max.y - box.min.y,
      sz: box.max.z - box.min.z,
      cx: (box.min.x + box.max.x) * 0.5,
      cy: (box.min.y + box.max.y) * 0.5,
      cz: (box.min.z + box.max.z) * 0.5,
    };
  }

  if (fallbackSize && Number.isFinite(fallbackSize.x)) {
    return { sx: fallbackSize.x, sy: fallbackSize.y, sz: fallbackSize.z, cx: 0, cy: 0, cz: 0 };
  }

  return null;
}

function collectHullVertices(geometry, maxHullPoints) {
  const positionAttribute = geometry?.getAttribute?.('position');

  if (!positionAttribute || positionAttribute.count < 4) {
    return new Float32Array();
  }

  const count = positionAttribute.count;
  const unique = [];
  const seen = new Set();

  const pushPoint = (x, y, z) => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return;
    }
    const key = vertexKeyNum(x, y, z);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    unique.push(x, y, z);
  };

  // Seed the hull with the per-axis extreme vertices (the actual mesh vertex at
  // min/max x, y, z). The convex hull of a point set ALWAYS contains every
  // generating point, so including the true axis extremes guarantees the hull
  // reaches the mesh's full extent on every axis — the mesh's lowest/highest
  // points are real hull vertices, so it can never sink through the floor. The
  // old "concave halves sink" bug was this: the stride below skipped the lowest
  // vertex, leaving the hull smaller than the mesh.
  for (const point of findAxisExtremePoints(positionAttribute)) {
    pushPoint(point.x, point.y, point.z);
  }

  if (count <= maxHullPoints) {
    // Small piece: use EVERY vertex → the exact convex hull of the mesh. Tightest
    // possible fit (flat parts no longer roll like balls), and still contains the
    // mesh since every vertex is a generating point.
    for (let index = 0; index < count; index += 1) {
      pushPoint(
        positionAttribute.getX(index),
        positionAttribute.getY(index),
        positionAttribute.getZ(index),
      );
    }
  } else {
    // Large piece: stride-sample the rest (the axis extremes are already seeded).
    const stride = Math.max(1, Math.ceil(count / maxHullPoints));
    for (let index = 0; index < count; index += stride) {
      pushPoint(
        positionAttribute.getX(index),
        positionAttribute.getY(index),
        positionAttribute.getZ(index),
      );
    }
  }

  return new Float32Array(unique);
}

// One pass to find the mesh vertices achieving the min/max on each axis. Returns
// up to 6 points (fewer if some extremes coincide). Tracked by index so no per-
// vertex allocation during the scan.
function findAxisExtremePoints(positionAttribute) {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let iMinX = 0;
  let iMaxX = 0;
  let iMinY = 0;
  let iMaxY = 0;
  let iMinZ = 0;
  let iMaxZ = 0;

  for (let index = 0; index < positionAttribute.count; index += 1) {
    const x = positionAttribute.getX(index);
    const y = positionAttribute.getY(index);
    const z = positionAttribute.getZ(index);
    if (x < minX) { minX = x; iMinX = index; }
    if (x > maxX) { maxX = x; iMaxX = index; }
    if (y < minY) { minY = y; iMinY = index; }
    if (y > maxY) { maxY = y; iMaxY = index; }
    if (z < minZ) { minZ = z; iMinZ = index; }
    if (z > maxZ) { maxZ = z; iMaxZ = index; }
  }

  return [
    { x: positionAttribute.getX(iMinX), y: positionAttribute.getY(iMinX), z: positionAttribute.getZ(iMinX) },
    { x: positionAttribute.getX(iMaxX), y: positionAttribute.getY(iMaxX), z: positionAttribute.getZ(iMaxX) },
    { x: positionAttribute.getX(iMinY), y: positionAttribute.getY(iMinY), z: positionAttribute.getZ(iMinY) },
    { x: positionAttribute.getX(iMaxY), y: positionAttribute.getY(iMaxY), z: positionAttribute.getZ(iMaxY) },
    { x: positionAttribute.getX(iMinZ), y: positionAttribute.getY(iMinZ), z: positionAttribute.getZ(iMinZ) },
    { x: positionAttribute.getX(iMaxZ), y: positionAttribute.getY(iMaxZ), z: positionAttribute.getZ(iMaxZ) },
  ];
}
