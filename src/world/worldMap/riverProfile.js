/**
 * riverProfile.js
 *
 * The inverse of roadProfile.js: pure math (no THREE) shared by the terrain-carve
 * pass and the riverworks builder. Each river polyline becomes a sampled centerline
 * that carves terrain DOWN into a channel:
 *   - sample the Catmull-Rom centerline (reuses roadProfile's sampleCenterline),
 *   - bedY  = terrain − depth        (the channel floor the heightfield carves to),
 *   - waterY = terrain − depth*FILL  (the water surface, partway up the channel),
 *   - heavy smoothing of the terrain sample so the channel bed/grade is gentle.
 * Exposes a spatial-hash corridorAt(x,z) → { bedY, waterY, weight } for cheap
 * per-vertex queries. applyRiverCorridorHeight is pure + exported so the baked
 * shapeChunk pass and the continuous sampleShapedHeight pass share ONE carve
 * implementation (they MUST agree exactly — divergence breaks seamless normals).
 *
 * Recursion guard (same pattern as roads): corridorAt is null until
 * buildRiverProfile returns, so the sampleHeight it samples (base + road + blueprint)
 * never includes the river carve itself.
 */

import { sampleCenterline } from './roadProfile.js';

const SMOOTH_RADIUS = 16;   // moving-average half-window over centerline samples
const EDGE_BLEND = 6;       // corridor falloff (m) beyond the river half-width
const CELL = 16;            // spatial-hash cell size (m)
const FILL_RATIO = 0.6;     // water surface sits this fraction of `depth` below terrain
// Samples are ~2m apart (sampleCenterline's default spacing); the ocean-fill
// far-field fallback below only needs ~50m granularity (precision doesn't
// matter once weight is pinned at 1), so it walks every 25th sample instead of
// every sample.
const COARSE_STRIDE = 25;

function smooth(values, radius) {
  const n = values.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    let sum = 0, count = 0;
    for (let j = i - radius; j <= i + radius; j += 1) {
      if (j < 0 || j >= n) continue;
      sum += values[j];
      count += 1;
    }
    out[i] = count > 0 ? sum / count : values[i];
  }
  return out;
}

/**
 * @param {Object} opts
 * @param {Array}   opts.rivers       world-map rivers ([{ points, width, depth }])
 * @param {Function} opts.sampleHeight (x,z) => terrain height (pre-river surface)
 * @param {number} [opts.smoothRadius] moving-average half-window in samples
 *   (default SMOOTH_RADIUS). The editor / placed-blueprint path passes a small
 *   radius so the channel is carved into the actual surface instead of an
 *   over-smoothed average (which misplaces the bed on steep hills).
 */
export function buildRiverProfile({ rivers = [], sampleHeight, smoothRadius = SMOOTH_RADIUS }) {
  const built = [];

  for (const river of rivers) {
    if (!river?.points || river.points.length < 2) continue;
    const samples = sampleCenterline(river.points);
    const n = samples.length;
    if (n < 2) continue;

    // Inflate the surface span like roads (×1.5) so the channel banks taper.
    const width = Math.max(2, river.width ?? 10) * 1.5;
    const half = width * 0.5;
    const depth = Math.max(1, river.depth ?? 6);

    const terrainY = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      terrainY[i] = sampleHeight(samples[i].x, samples[i].z);
    }
    // Smooth the terrain sample so the channel bed/grade is gentle (mirrors the
    // road's smoothing), then derive bed + water from the smoothed surface.
    const smoothed = smooth(terrainY, smoothRadius);
    const bedY = new Float64Array(n);
    const waterY = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      bedY[i] = smoothed[i] - depth;
      waterY[i] = smoothed[i] - depth * FILL_RATIO;
    }

    // Visual half-width of the water ribbon. The carve corridor is flat at bedY
    // out to `half`, then the bank slopes back up to natural across EDGE_BLEND. The
    // water surface (waterY) sits partway up that slope, so its natural waterline
    // lands BEYOND `half` — a ribbon built at `half` leaves an exposed ring of dry
    // channel floor. Extending the ribbon to the full carve extent lets the flat
    // water plane meet the bank: opaque terrain (rendered first) depth-occludes the
    // overshoot, so the visible edge forms cleanly where waterY intersects the bank.
    const surfaceHalf = half + EDGE_BLEND;

    built.push({
      river, samples, n, width, half, surfaceHalf, bedY, waterY,
      oceanLeft: river.oceanLeft === true,
      oceanRight: river.oceanRight === true,
    });
  }

  // Spatial hash: bucket sample indices by cell (identical scheme to roadProfile).
  const grid = new Map();
  // Numeric keys — string keys allocate on every lookup, and corridorAt runs
  // per terrain vertex (same discipline as roadProfile.js).
  const key = (cx, cz) => (cx + 0x8000) * 0x10000 + (cz + 0x8000);
  for (let r = 0; r < built.length; r += 1) {
    const b = built[r];
    for (let k = 0; k < b.n; k += 1) {
      const cx = Math.floor(b.samples[k].x / CELL);
      const cz = Math.floor(b.samples[k].z / CELL);
      const kk = key(cx, cz);
      let arr = grid.get(kk);
      if (!arr) { arr = []; grid.set(kk, arr); }
      arr.push(r * 1e7 + k); // pack (river, sample)
    }
  }

  // Rivers with an ocean-fill side, for the long-range fallback search below.
  // Ocean fill's whole point is to cover a huge area (a real coastline runs the
  // entire map), so "far from the river" is the COMMON case there, not a rare
  // edge case — a fallback scanning every ~2m-spaced sample (COARSE_STRIDE=1
  // would be hundreds of points for a long coastline) measured as a severe,
  // sustained per-frame hitch (~70% of frame time in a real trace) once an
  // ocean-fill river existed, since every far terrain vertex during chunk
  // shaping pays for it. Precision doesn't matter out there (weight is always
  // 1, no blend), so the fallback walks a STRIDED subsample instead of every
  // sample — ~50m spacing regardless of how densely the river itself is
  // sampled, bounding the fallback's cost independent of river length/detail.
  const oceanBuilt = built
    .filter((b) => b.oceanLeft || b.oceanRight)
    .map((b) => {
      const coarseIndices = [];
      for (let i = 0; i < b.n; i += COARSE_STRIDE) coarseIndices.push(i);
      if (coarseIndices[coarseIndices.length - 1] !== b.n - 1) coarseIndices.push(b.n - 1);
      return { ...b, coarseIndices };
    });

  // Project (x,z) onto the segment from sample index `ia` to sample index `ic`
  // of river `b` (adjacent for the fine near-field search, strided for the
  // coarse far-field fallback): nearest point, its distance, the SIGNED
  // lateral offset (>0 = left, matching createRiverworks' tangent/normal
  // convention), and the interpolated bedY/waterY there.
  function projectSegment(b, ia, ic, x, z) {
    const a = b.samples[ia], c = b.samples[ic];
    const abx = c.x - a.x, abz = c.z - a.z;
    const lenSq = abx * abx + abz * abz;
    const invLen = lenSq > 0 ? 1 / Math.sqrt(lenSq) : 0;
    let t = lenSq > 0 ? ((x - a.x) * abx + (z - a.z) * abz) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const px = a.x + t * abx, pz = a.z + t * abz;
    const d = Math.hypot(x - px, z - pz);
    const tx = abx * invLen, tz = abz * invLen; // unit tangent
    const nx = -tz, nz = tx;                    // unit normal (left)
    const sign = (x - px) * nx + (z - pz) * nz;
    return {
      d, sign,
      bedY: b.bedY[ia] + (b.bedY[ic] - b.bedY[ia]) * t,
      waterY: b.waterY[ia] + (b.waterY[ic] - b.waterY[ia]) * t,
      half: b.half,
      oceanLeft: b.oceanLeft,
      oceanRight: b.oceanRight,
    };
  }

  const isOceanSide = (m) => !!m && ((m.sign > 0 && m.oceanLeft) || (m.sign < 0 && m.oceanRight));

  // Search range: enough whole cells to reach the widest river's corridor edge
  // from any query point — samples sit on the CENTERLINE, so a corridor point can
  // be half + EDGE_BLEND away from the nearest sample. A fixed 3x3 neighbourhood
  // only guarantees ~CELL (16 m) of lateral reach and silently truncates the
  // carve for wide rivers (same bug as wide roads in roadProfile.js).
  let maxReach = 0;
  for (const b of built) maxReach = Math.max(maxReach, b.half + EDGE_BLEND);
  const cellRange = Math.max(1, Math.ceil(maxReach / CELL));

  // Nearest-on-segment query over candidate samples, scanned ring-by-ring
  // outward with the same early-stop as roadProfile.js: a cell on Chebyshev
  // ring r is at least (r-1)*CELL away, so once a ring starts beyond the
  // running best the scan stops.
  const corridorAt = (x, z) => {
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    let best = null;
    let bestDist = Infinity;
    for (let ring = 0; ring <= cellRange; ring += 1) {
      if (best && bestDist <= (ring - 1) * CELL) break;
      for (let dx = -ring; dx <= ring; dx += 1) {
        for (let dz = -ring; dz <= ring; dz += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          const arr = grid.get(key(cx + dx, cz + dz));
          if (!arr) continue;
          for (const packed of arr) {
            const r = Math.floor(packed / 1e7);
            const k = packed - r * 1e7;
            const b = built[r];
            for (const seg of [k - 1, k]) {
              if (seg < 0 || seg >= b.n - 1) continue;
              const m = projectSegment(b, seg, seg + 1, x, z);
              if (m.d < bestDist) { bestDist = m.d; best = m; }
            }
          }
        }
      }
    }

    if (best && (isOceanSide(best) || bestDist <= best.half + EDGE_BLEND)) {
      const weight = bestDist <= best.half
        ? 1
        : isOceanSide(best) ? 1 : Math.max(0, 1 - (bestDist - best.half) / EDGE_BLEND);
      return { bedY: best.bedY, waterY: best.waterY, weight };
    }

    // The local spatial hash only searches a 3x3 neighbourhood of CELL-sized
    // buckets around (x,z), so it can't find a river's samples once genuinely
    // far away — exactly the case an ocean-fill side needs (its whole point is
    // extending past the normal EDGE_BLEND cutoff). Only paid for maps that
    // actually have an ocean-fill river, and only when the fast path above
    // found nothing usable.
    if (oceanBuilt.length === 0) return null;
    let oBest = null;
    let oBestDist = Infinity;
    for (const b of oceanBuilt) {
      const idx = b.coarseIndices;
      for (let j = 0; j < idx.length - 1; j += 1) {
        const m = projectSegment(b, idx[j], idx[j + 1], x, z);
        if (m.d < oBestDist) { oBestDist = m.d; oBest = m; }
      }
    }
    if (!oBest || !isOceanSide(oBest)) return null;
    return { bedY: oBest.bedY, waterY: oBest.waterY, weight: 1 };
  };

  return { rivers: built, corridorAt };
}

// Carve terrain DOWN to the river bed across the corridor weight falloff. Pure +
// exported so the baked shapeChunk pass and the continuous sampleShapedHeight pass
// share ONE implementation (seamless-normal discipline — same invariant as roads).
// `river` is the { bedY, waterY, weight } from corridorAt (or null/weight<=0 outside).
export function applyRiverCorridorHeight(h, river) {
  if (!river || river.weight <= 0) return h;
  return h * (1 - river.weight) + river.bedY * river.weight;
}
