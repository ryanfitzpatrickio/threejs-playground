/**
 * roadProfile.js
 *
 * Pure math (no THREE) shared by the terrain-conform pass and the roadworks builder.
 * Turns each road spline into a sampled centerline with an auto-graded height profile:
 *   - sample the Catmull-Rom centerline at ~SAMPLE_SPACING,
 *   - follow the terrain where supported, INTERPOLATE across wilds spans (so they
 *     bridge) and pin city ends to 0,
 *   - heavy smoothing + max-grade clamp → roadY per sample,
 *   - flag each sample grounded (terrain conforms) vs bridged (road floats / wilds).
 * Exposes a spatial-hash corridorAt(x,z) for cheap per-vertex queries.
 */

import { buildRoadIntersections } from './roadIntersections.js';

const SAMPLE_SPACING = 2;     // metres between centerline samples
const SMOOTH_RADIUS = 16;     // moving-average half-window (samples) → ~64 m window
const MAX_GRADE = 0.12;       // max |dy/ds| the road allows
export const BRIDGE_THRESH = 2.5; // roadY above terrain by more than this → bridge
const EDGE_BLEND = 6;         // corridor falloff (m) beyond the road half-width
const CELL = 16;              // spatial-hash cell size (m)
// Tunnel-style roads (trackStyle: 'tunnel') need the OPPOSITE of the grounded
// carve: terrain must stay ABOVE the bore, not graded down to meet it. These two
// numbers must match the visual bore height in trackCrossSection.js's `tunnel`
// preset (wallHeight + archRise) + a minimum rock/soil cover.
export const TUNNEL_INTERIOR_HEIGHT = 5.2; // wallHeight + archRise (bore clear height)
export const TUNNEL_ROCK_COVER = 4;        // minimum cover above the bore shell
// Arc-length (m) from each end of a tunnel road treated as the portal approach:
// terrain is carved DOWN toward roadY there (an open cutting exposing the bore
// mouth) instead of raised to bury it. Buried behavior only eases in AFTER this
// distance — blending bury into the portal zone itself bermed terrain up over the
// headwall arch and hid the entrance.
export const TUNNEL_PORTAL_LENGTH = 14;
// Metres beyond TUNNEL_PORTAL_LENGTH over which buried cover eases in (after the
// open portal cutting, so the headwall stays visible through the full portal zone).
const TUNNEL_PORTAL_BURY_BLEND = 8;

// Centripetal Catmull-Rom through control points (clamped endpoints).
function catmull(points, out, spacing = SAMPLE_SPACING) {
  const n = points.length;
  if (n < 2) return;
  const P = (i) => points[Math.max(0, Math.min(n - 1, i))];
  for (let i = 0; i < n - 1; i += 1) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const segLen = Math.hypot(p2.x - p1.x, p2.z - p1.z);
    const steps = Math.max(1, Math.round(segLen / spacing));
    for (let s = 0; s < steps; s += 1) {
      const t = s / steps;
      const t2 = t * t, t3 = t2 * t;
      const x = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
      const z = 0.5 * ((2 * p1.z) + (-p0.z + p2.z) * t +
        (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 +
        (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3);
      out.push({ x, z });
    }
  }
  out.push({ x: points[n - 1].x, z: points[n - 1].z });
}

// Public: sample a road's Catmull-Rom centerline (shared by editor render + runtime).
export function sampleCenterline(points, spacing = SAMPLE_SPACING) {
  const out = [];
  catmull(points, out, spacing);
  return out;
}

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
 * @param {Array}  opts.roads     world-map roads ([{ points, width }])
 * @param {Function} opts.sampleHeight (x,z) => terrain height (biome-aware)
 * @param {Function} [opts.isWilds]  (x,z) => boolean
 * @param {Function} [opts.isCity]   (x,z) => boolean
 * @param {number} [opts.smoothRadius] moving-average half-window in samples
 *   (default SMOOTH_RADIUS). Lower = the road follows terrain more faithfully;
 *   the editor passes a small radius so roads conform to sculpted hills.
 * @param {number} [opts.maxGrade] max |dy/ds| the road allows (default MAX_GRADE).
 *   The editor / placed-blueprint path passes Infinity so a road follows the
 *   terrain grade exactly (spirals up a steep hill) instead of being clamped to
 *   a shallow grade and sinking below the spline.
 */
export function buildRoadProfile({
  roads = [],
  sampleHeight,
  isWilds = () => false,
  isCity = () => false,
  smoothRadius = SMOOTH_RADIUS,
  maxGrade = MAX_GRADE,
}) {
  const built = [];

  for (const road of roads) {
    if (!road?.points || road.points.length < 2) continue;
    const samples = [];
    catmull(road.points, samples);
    const n = samples.length;
    if (n < 2) continue;

    const width = Math.max(2, road.width ?? 8) * 1.5;
    const half = width * 0.5;

    // Cumulative arc length.
    const s = new Float64Array(n);
    for (let i = 1; i < n; i += 1) {
      s[i] = s[i - 1] + Math.hypot(samples[i].x - samples[i - 1].x, samples[i].z - samples[i - 1].z);
    }

    const fixedY = Number.isFinite(road.elevation) ? road.elevation : null;
    const terrainY = new Float64Array(n);
    const wilds = new Uint8Array(n);
    const cityPin = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) {
      terrainY[i] = sampleHeight(samples[i].x, samples[i].z);
      // Fixed roads conform even inside wilds; do not classify those samples as
      // unsupported bridge gaps.
      wilds[i] = fixedY === null && isWilds(samples[i].x, samples[i].z) ? 1 : 0;
      cityPin[i] = isCity(samples[i].x, samples[i].z) ? 1 : 0;
    }

    // Raw target: city → 0, supported → terrain, wilds → gap (filled below).
    const raw = new Float64Array(n);
    const isGap = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) {
      if (cityPin[i]) { raw[i] = 0; }
      else if (wilds[i]) { isGap[i] = 1; }
      else { raw[i] = terrainY[i]; }
    }
    // Fill wilds gaps by linear interpolation between supported neighbours.
    let i = 0;
    while (i < n) {
      if (!isGap[i]) { i += 1; continue; }
      let j = i;
      while (j < n && isGap[j]) j += 1;
      const left = i - 1 >= 0 ? raw[i - 1] : (j < n ? raw[j] : 0);
      const right = j < n ? raw[j] : left;
      const span = Math.max(1, j - i + 1);
      for (let k = i; k < j; k += 1) raw[k] = left + ((right - left) * (k - i + 1)) / span;
      i = j;
    }

    let roadY;
    if (fixedY !== null) {
      roadY = new Float64Array(n).fill(fixedY);
    } else if (road.trackStyle === 'tunnel') {
      // A bore goes STRAIGHT through, ignoring whatever the terrain does in
      // between — a single straight-line grade from portal to portal (flat if
      // both ends sit at the same elevation), not a smoothed trace of the hill.
      roadY = new Float64Array(n);
      const yStart = terrainY[0];
      const yEnd = terrainY[n - 1];
      const total = Math.max(1e-3, s[n - 1]);
      for (let k = 0; k < n; k += 1) roadY[k] = yStart + (yEnd - yStart) * (s[k] / total);
    } else {
      // Heavy smoothing for a graded profile, then re-pin city samples to 0.
      roadY = smooth(raw, smoothRadius);
      for (let k = 0; k < n; k += 1) if (cityPin[k]) roadY[k] = 0;

      // Clamp grade (forward then backward) so the road never exceeds maxGrade.
      for (let k = 1; k < n; k += 1) {
        const ds = Math.max(0.01, s[k] - s[k - 1]);
        const maxd = maxGrade * ds;
        if (roadY[k] - roadY[k - 1] > maxd) roadY[k] = roadY[k - 1] + maxd;
        else if (roadY[k - 1] - roadY[k] > maxd) roadY[k] = roadY[k - 1] - maxd;
      }
      for (let k = n - 2; k >= 0; k -= 1) {
        const ds = Math.max(0.01, s[k + 1] - s[k]);
        const maxd = maxGrade * ds;
        if (roadY[k] - roadY[k + 1] > maxd) roadY[k] = roadY[k + 1] + maxd;
        else if (roadY[k + 1] - roadY[k] > maxd) roadY[k] = roadY[k + 1] - maxd;
      }
    }

    const grounded = new Uint8Array(n);
    for (let k = 0; k < n; k += 1) {
      grounded[k] = fixedY !== null || (!wilds[k] && roadY[k] - terrainY[k] <= BRIDGE_THRESH) ? 1 : 0;
    }

    built.push({
      road, samples, n, width, half, roadY, terrainY, grounded, wilds, s,
      fixed: fixedY !== null,
      // 1 outside junctions, eased to 0 inside. The ribbon shader uses this to
      // stop ordinary lane/edge lines before intersection-specific decals.
      intersectionMask: new Float32Array(n).fill(1),
    });
  }

  const intersections = buildRoadIntersections(built);
  for (const b of built) {
    for (let k = 0; k < b.n; k += 1) {
      b.grounded[k] = b.fixed || (!b.wilds[k] && b.roadY[k] - b.terrainY[k] <= BRIDGE_THRESH) ? 1 : 0;
    }
  }
  // A junction whose every approach is grounded gets its own conform disc in
  // corridorAt (below) so the flat intersection pad visual is always backed by
  // level terrain. Bridged junctions keep arm-only conform — raising terrain to
  // a mid-air crossing would fill the canyon under it.
  for (const intersection of intersections) {
    intersection.grounded = intersection.connections.every((ref) => {
      const b = built[ref.roadIndex];
      const k = Math.max(0, Math.min(b.n - 1, Math.round(ref.at)));
      return !!b.grounded[k];
    });
  }

  // Spatial hash: bucket sample indices by cell. Numeric keys — string keys
  // allocate on every lookup, and corridorAt runs per terrain vertex.
  const grid = new Map();
  const key = (cx, cz) => (cx + 0x8000) * 0x10000 + (cz + 0x8000);
  for (let r = 0; r < built.length; r += 1) {
    const b = built[r];
    for (let k = 0; k < b.n; k += 1) {
      const cx = Math.floor(b.samples[k].x / CELL);
      const cz = Math.floor(b.samples[k].z / CELL);
      const kk = key(cx, cz);
      let arr = grid.get(kk);
      if (!arr) { arr = []; grid.set(kk, arr); }
      arr.push(r * 1e7 + k); // pack (road, sample)
    }
  }

  // Search range: enough whole cells to reach the widest road's corridor edge
  // from any query point — samples sit on the CENTERLINE, so a corridor point
  // can be half + EDGE_BLEND away from the nearest sample. The old fixed 3x3
  // neighbourhood only guaranteed ~CELL (16 m) of lateral reach: any road wider
  // than ~21 m authored (x1.5 profile scale) lost terrain conform + collision
  // beyond that, while the full-width ribbon still drew.
  let maxReach = 0;
  for (const b of built) maxReach = Math.max(maxReach, b.half + EDGE_BLEND);
  const cellRange = Math.max(1, Math.ceil(maxReach / CELL));

  // Nearest-on-segment query over candidate samples, scanned ring-by-ring
  // outward. A cell on Chebyshev ring r is at least (r-1)*CELL away, so once a
  // ring starts beyond the running best the remaining rings can't win and the
  // scan stops — points on/near a road resolve in the innermost rings and wide
  // maps keep ~3x3 cost despite the larger worst-case reach.
  const corridorAt = (x, z) => {
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    let best = null;
    let bestDist = Infinity;
    let bestWeight = 0;

    // Junction discs claim their whole pad at full strength: the roadworks
    // intersection surface is a flat disc of `radius` at intersection.y, and
    // the corners between arms aren't guaranteed to fall inside any single
    // road's corridor (nor at full weight near unequal-width joins).
    for (const intersection of intersections) {
      if (!intersection.grounded) continue;
      const reach = intersection.radius + EDGE_BLEND;
      const ddx = x - intersection.x;
      if (ddx > reach || ddx < -reach) continue;
      const ddz = z - intersection.z;
      if (ddz > reach || ddz < -reach) continue;
      const d = Math.hypot(ddx, ddz);
      const w = d <= intersection.radius ? 1 : 1 - (d - intersection.radius) / EDGE_BLEND;
      if (w <= 0 || w < bestWeight || (w === bestWeight && d >= bestDist)) continue;
      bestWeight = w;
      bestDist = d;
      best = { roadY: intersection.y, grounded: true, half: intersection.radius, tunnel: false, portalDist: Infinity, withinRoad: true };
    }

    for (let ring = 0; ring <= cellRange; ring += 1) {
      // Stop once no farther candidate can win: rings at r are ≥ (r-1)*CELL
      // away, which can neither beat a full-strength claim on distance nor
      // out-weigh it.
      if (best && bestWeight >= 1 && bestDist <= (ring - 1) * CELL) break;
      for (let dx = -ring; dx <= ring; dx += 1) {
      for (let dz = -ring; dz <= ring; dz += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
        const arr = grid.get(key(cx + dx, cz + dz));
        if (!arr) continue;
        for (const packed of arr) {
          const r = Math.floor(packed / 1e7);
          const k = packed - r * 1e7;
          const b = built[r];
          // Project onto the two adjacent segments.
          for (const seg of [k - 1, k]) {
            if (seg < 0 || seg >= b.n - 1) continue;
            const a = b.samples[seg], c = b.samples[seg + 1];
            const abx = c.x - a.x, abz = c.z - a.z;
            const lenSq = abx * abx + abz * abz;
            const rawT = lenSq > 0 ? ((x - a.x) * abx + (z - a.z) * abz) / lenSq : 0;
            let t = rawT;
            t = Math.max(0, Math.min(1, t));
            const px = a.x + t * abx, pz = a.z + t * abz;
            const d = Math.hypot(x - px, z - pz);
            // Strongest corridor claims the point, nearest wins ties. Pure
            // nearest-centerline selection let a narrow road's weak feather
            // shadow a wider road's full-strength corridor beside a junction —
            // an unconformed (collision) hole under the flat junction pad.
            const w = d <= b.half ? 1 : 1 - (d - b.half) / EDGE_BLEND;
            if (w > 0 && (w > bestWeight || (w === bestWeight && d < bestDist))) {
              bestWeight = w;
              bestDist = d;
              const roadY = b.roadY[seg] + (b.roadY[seg + 1] - b.roadY[seg]) * t;
              const grounded = b.grounded[seg] && b.grounded[seg + 1];
              // Arc-length distance to the NEAREST end of this road — used by
              // tunnel roads to find the portal approach (see TUNNEL_PORTAL_LENGTH).
              const segS = b.s[seg] + (b.s[seg + 1] - b.s[seg]) * t;
              const portalDist = Math.min(segS, b.s[b.n - 1] - segS);
              best = {
                roadY,
                grounded,
                half: b.half,
                tunnel: b.road?.trackStyle === 'tunnel',
                portalDist,
                withinRoad: rawT >= -1e-6 && rawT <= 1 + 1e-6,
              };
            }
          }
        }
      }
      }
    }
    if (!best || bestWeight <= 0) return null;
    return {
      roadY: best.roadY,
      grounded: !!best.grounded,
      tunnel: !!best.tunnel,
      withinRoad: best.withinRoad !== false,
      portalDist: best.portalDist ?? Infinity,
      weight: Math.max(0, Math.min(1, bestWeight)),
    };
  };

  return { roads: built, intersections, corridorAt };
}

// Apply the road corridor's height transform to a sampled terrain height `h` at a
// point the corridor covers. `corridor` is the { roadY, grounded, weight } returned
// by corridorAt (or null/weight<=0 outside the corridor).
//   - GROUNDED corridor: grade terrain toward roadY, tapering roadY <-> natural
//     terrain across the weight falloff (so the road meets the surrounding surface).
//   - BRIDGED corridor: HARD-clamp to roadY - bridgeClearance, INDEPENDENT of
//     weight, so the heightfield can never punch up through the thin deck box. A
//     weighted blend (cap*w + h*(1-w)) does NOT bound the result — it exceeds the
//     cap whenever h > cap and w < 1, which left terrain far above the deck across
//     the corridor edge in tall alpine/wilds terrain. Only a hard min bounds it for
//     every weight. Deep gorges (h already below roadY-clearance) are untouched.
//
// Pure + exported so the baked shapeChunk pass and the continuous sampleShapedHeight
// pass share ONE implementation — they MUST agree exactly, or seamless normals,
// tree placement, and the road-profile terrainY input drift from the baked
// heightfield. bridgeClearance is passed in (defined by the terrain level).
export function applyRoadCorridorHeight(h, corridor, bridgeClearance) {
  if (!corridor || corridor.weight <= 0) return h;
  if (corridor.tunnel) {
    // Deep inside the bore: raise-only clamp — never lower terrain (can't carve
    // a hollow overhang in a heightfield), only guarantee a minimum cover. Where
    // a real hill already exceeds that, this is a no-op — the mountain hides the
    // tube for free. Where it doesn't (open ground), terrain berms up to meet
    // the minimum, feathered by weight like the grounded case below.
    const minH = corridor.roadY + TUNNEL_INTERIOR_HEIGHT + TUNNEL_ROCK_COVER;
    const buried = h >= minH ? h : h * (1 - corridor.weight) + minH * corridor.weight;
    // Near each end (the portal approach): carve DOWN toward roadY, exposing the
    // bore mouth. Keep the full portal zone open — do NOT blend toward buried
    // cover inside TUNNEL_PORTAL_LENGTH or terrain berms up over the headwall.
    // Buried behavior eases in only after the portal zone ends.
    const carved = h * (1 - corridor.weight) + corridor.roadY * corridor.weight;
    if (corridor.portalDist < TUNNEL_PORTAL_LENGTH) return carved;
    if (corridor.portalDist >= TUNNEL_PORTAL_LENGTH + TUNNEL_PORTAL_BURY_BLEND) return buried;
    const buryT = (corridor.portalDist - TUNNEL_PORTAL_LENGTH) / TUNNEL_PORTAL_BURY_BLEND;
    return carved * (1 - buryT) + buried * buryT;
  }
  if (corridor.grounded) {
    return h * (1 - corridor.weight) + corridor.roadY * corridor.weight;
  }
  return Math.min(h, corridor.roadY - bridgeClearance);
}
