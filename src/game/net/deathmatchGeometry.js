/**
 * Pure geometry-intersection helpers for deathmatch (M0).
 *
 * Dependency-free vector math over plain `[x, y, z]` arrays — the same shape
 * used on the wire (protocol) and in the arena descriptor. Shared by the server
 * hitscan/movement modules and, later, by the client for matching tracers and
 * pickup-overlap prediction. No Three.js so Node verifiers can import it.
 *
 * An AABB is `{ min: [x,y,z], max: [x,y,z] }`. A capsule is a segment `a`–`b`
 * plus a `radius`. Rays are `(origin, dir)` with `dir` normalized by the caller.
 */

const EPS = 1e-9;

export function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function scale(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function lengthSq(a) {
  return dot(a, a);
}

export function length(a) {
  return Math.sqrt(lengthSq(a));
}

export function distance(a, b) {
  return length(sub(a, b));
}

export function distanceSq(a, b) {
  return lengthSq(sub(a, b));
}

/** Normalize; returns `[0,0,0]` for a degenerate input rather than NaN. */
export function normalize(a) {
  const len = length(a);
  if (len < EPS) return [0, 0, 0];
  return [a[0] / len, a[1] / len, a[2] / len];
}

/** True when a vector is finite and non-zero (a usable direction). */
export function isUsableDirection(a) {
  return (
    Number.isFinite(a[0]) &&
    Number.isFinite(a[1]) &&
    Number.isFinite(a[2]) &&
    lengthSq(a) > EPS
  );
}

/** Inclusive point-in-AABB test. */
export function pointInAabb(p, min, max) {
  return (
    p[0] >= min[0] && p[0] <= max[0] &&
    p[1] >= min[1] && p[1] <= max[1] &&
    p[2] >= min[2] && p[2] <= max[2]
  );
}

/** True when two AABBs overlap (touching counts). */
export function aabbOverlap(aMin, aMax, bMin, bMax) {
  return (
    aMin[0] <= bMax[0] && aMax[0] >= bMin[0] &&
    aMin[1] <= bMax[1] && aMax[1] >= bMin[1] &&
    aMin[2] <= bMax[2] && aMax[2] >= bMin[2]
  );
}

/**
 * Slab-method ray/AABB intersection over `[0, maxT]`.
 * @returns {number|null} nearest entry distance along `dir`, or null.
 */
export function rayAabb(origin, dir, min, max, maxT = Infinity) {
  let tMin = 0;
  let tMax = maxT;
  for (let i = 0; i < 3; i += 1) {
    const d = dir[i];
    if (Math.abs(d) < EPS) {
      // Ray parallel to slab: miss if origin is outside it.
      if (origin[i] < min[i] || origin[i] > max[i]) return null;
    } else {
      const inv = 1 / d;
      let t1 = (min[i] - origin[i]) * inv;
      let t2 = (max[i] - origin[i]) * inv;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tMin) tMin = t1;
      if (t2 < tMax) tMax = t2;
      if (tMin > tMax) return null;
    }
  }
  return tMin;
}

/**
 * Ray/sphere intersection.
 * @returns {number|null} nearest non-negative distance along `dir`, or null.
 */
export function raySphere(origin, dir, center, radius, maxT = Infinity) {
  const m = sub(origin, center);
  const b = dot(m, dir);
  const c = lengthSq(m) - radius * radius;
  // Origin outside sphere and pointing away: miss.
  if (c > 0 && b > 0) return null;
  const disc = b * b - c;
  if (disc < 0) return null;
  const sqrtD = Math.sqrt(disc);
  let t = -b - sqrtD;
  if (t < 0) t = -b + sqrtD; // origin inside sphere
  if (t < 0 || t > maxT) return null;
  return t;
}

/**
 * Ray/capsule intersection (segment `a`–`b`, radius `r`). Uses the nearest
 * approach between the ray and the segment axis, falling back to the end caps.
 * @returns {number|null} nearest non-negative distance along `dir`, or null.
 */
export function rayCapsule(origin, dir, a, b, radius, maxT = Infinity) {
  const axis = sub(b, a);
  const axisLenSq = lengthSq(axis);
  if (axisLenSq < EPS) return raySphere(origin, dir, a, radius, maxT);

  // Find candidate t on the ray closest to the infinite line, then clamp to the
  // segment and shrink to a cylinder + end-cap test. For gameplay-scale capsules
  // an end-cap-aware sampling of the nearest sphere is accurate and robust.
  const invAxisLen = 1 / axisLenSq;
  let best = null;

  // Cylinder body: solve |(origin + t*dir) - proj_onto_axis|^2 = r^2.
  const m = sub(origin, a);
  const mDotAxis = dot(m, axis);
  const dDotAxis = dot(dir, axis);
  // Quadratic coefficients for radial distance to the axis line.
  const A = lengthSq(dir) - (dDotAxis * dDotAxis) * invAxisLen;
  const B = dot(m, dir) - (mDotAxis * dDotAxis) * invAxisLen;
  const C = lengthSq(m) - (mDotAxis * mDotAxis) * invAxisLen - radius * radius;
  if (Math.abs(A) > EPS) {
    const disc = B * B - A * C;
    if (disc >= 0) {
      const sqrtD = Math.sqrt(disc);
      for (const t of [(-B - sqrtD) / A, (-B + sqrtD) / A]) {
        if (t < 0 || t > maxT) continue;
        const s = (mDotAxis + t * dDotAxis) * invAxisLen; // param along axis
        if (s >= 0 && s <= 1) {
          if (best === null || t < best) best = t;
          break;
        }
      }
    }
  }

  // End caps (spheres at a and b) catch hits beyond the cylinder extent.
  for (const cap of [a, b]) {
    const t = raySphere(origin, dir, cap, radius, maxT);
    if (t !== null && (best === null || t < best)) best = t;
  }

  return best;
}
