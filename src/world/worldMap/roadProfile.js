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

import { buildRoadIntersections, levelIntersectionApproaches } from './roadIntersections.js';
import { surfaceForRoad } from './roadSurface.js';
import { roadElevationMode } from './worldMapSchema.js';

const SAMPLE_SPACING = 2;     // metres between centerline samples
const SMOOTH_RADIUS = 16;     // moving-average half-window (samples) → ~64 m window
const MAX_GRADE = 0.12;       // max |dy/ds| the road allows
export const BRIDGE_THRESH = 2.5; // roadY above terrain by more than this → bridge
const EDGE_BLEND = 6;         // corridor falloff (m) beyond the road half-width
const GENTLE_SLOPE_EDGE_BLEND_MIN = 20; // wider cut/fill feather for graded roads
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

// Uniform Catmull-Rom basis, one axis. Shared by the arc-length probe and the
// emit loop so they can't drift.
function crAxis(a, b, c, d, t, t2, t3) {
  return 0.5 * ((2 * b) + (-a + c) * t +
    (2 * a - 5 * b + 4 * c - d) * t2 +
    (-a + 3 * b - 3 * c + d) * t3);
}

// Centripetal Catmull-Rom through control points (clamped endpoints).
function catmull(points, out, spacing = SAMPLE_SPACING) {
  const n = points.length;
  if (n < 2) return;
  const P = (i) => points[Math.max(0, Math.min(n - 1, i))];
  for (let i = 0; i < n - 1; i += 1) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    // Step by the curve's TRUE arc length, not the straight chord between control
    // points: on a tight bend the spline bulges well past its chord, so a
    // chord-based count under-tessellates exactly where facets show most. Probe
    // the segment coarsely, sum the chords, then divide by the target spacing.
    let arc = 0, px = p1.x, pz = p1.z;
    const PROBE = 8;
    for (let k = 1; k <= PROBE; k += 1) {
      const t = k / PROBE, t2 = t * t, t3 = t2 * t;
      const x = crAxis(p0.x, p1.x, p2.x, p3.x, t, t2, t3);
      const z = crAxis(p0.z, p1.z, p2.z, p3.z, t, t2, t3);
      arc += Math.hypot(x - px, z - pz);
      px = x; pz = z;
    }
    const steps = Math.max(1, Math.round(arc / spacing));
    for (let s = 0; s < steps; s += 1) {
      const t = s / steps, t2 = t * t, t3 = t2 * t;
      out.push({
        x: crAxis(p0.x, p1.x, p2.x, p3.x, t, t2, t3),
        z: crAxis(p0.z, p1.z, p2.z, p3.z, t, t2, t3),
      });
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
 * For junctions whose approaches are free (terrain-follow, not fixed elevation),
 * re-seat floating pads onto the heightfield and clamp nearby samples so grade-
 * smoothing cannot leave bridge decks under the junction (cars clipping under a
 * floating slab). Fixed / overpass approaches are left alone.
 */
function pinTerrainFollowJunctions(built, intersections) {
  // Stay under BRIDGE_THRESH so re-grounded samples never spawn deck colliders.
  const maxClearance = BRIDGE_THRESH * 0.85;

  for (const intersection of intersections) {
    if (!intersection.connections?.length) continue;
    const anyFixed = intersection.connections.some((ref) => built[ref.roadIndex]?.fixed);
    if (anyFixed) continue;

    let sumTerrain = 0;
    let count = 0;
    for (const ref of intersection.connections) {
      const road = built[ref.roadIndex];
      if (!road) continue;
      const k = Math.max(0, Math.min(road.n - 1, Math.round(ref.at)));
      sumTerrain += road.terrainY[k];
      count += 1;
    }
    if (count === 0) continue;

    const terrainY = sumTerrain / count;
    // Re-pin the flat pad when it would float as a bridge surface.
    if (intersection.y - terrainY > BRIDGE_THRESH * 0.45) {
      intersection.y = terrainY;
      levelIntersectionApproaches(intersection, built);
    }

    // Clamp every free approach sample inside the junction influence zone so
    // intermediate grade-smoothed samples can't leave a deck under the pad.
    for (const ref of intersection.connections) {
      const road = built[ref.roadIndex];
      if (!road || road.fixed) continue;
      const transition = ref.transition ?? 12;
      const influence = (intersection.radius ?? 4) + transition;
      for (let i = 0; i < road.n; i += 1) {
        const dx = road.samples[i].x - intersection.x;
        const dz = road.samples[i].z - intersection.z;
        if (dx * dx + dz * dz > influence * influence) continue;
        const ceiling = road.terrainY[i] + maxClearance;
        if (road.roadY[i] > ceiling) road.roadY[i] = ceiling;
      }
    }
  }
}

/** Constant grade from terrain at the road start to terrain at the road end. */
function buildGentleSlopeRoadY(terrainY, s) {
  const n = terrainY.length;
  const roadY = new Float64Array(n);
  const total = Math.max(1e-6, s[n - 1]);
  const y0 = terrainY[0];
  const y1 = terrainY[n - 1];
  const delta = y1 - y0;
  for (let k = 0; k < n; k += 1) {
    roadY[k] = y0 + delta * (s[k] / total);
  }
  return roadY;
}

function gentleSlopeEdgeBlend(terrainY) {
  let minT = terrainY[0];
  let maxT = terrainY[0];
  for (let i = 1; i < terrainY.length; i += 1) {
    if (terrainY[i] < minT) minT = terrainY[i];
    if (terrainY[i] > maxT) maxT = terrainY[i];
  }
  return Math.max(EDGE_BLEND, GENTLE_SLOPE_EDGE_BLEND_MIN, (maxT - minT) * 0.85);
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
  // Metres between centerline samples. Finer spacing → the ribbon follows the
  // spline (and terrain) more smoothly on curves at the cost of more verts. The
  // vertical smoothing window (`smoothRadius`) is counted in SAMPLES, so a caller
  // that halves this should roughly double smoothRadius to keep the same
  // metre-window, or the road will hug terrain bumps more tightly.
  sampleSpacing = SAMPLE_SPACING,
}) {
  const built = [];

  for (const road of roads) {
    if (!road?.points || road.points.length < 2) continue;
    const samples = [];
    catmull(road.points, samples, sampleSpacing);
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
    const gentleSlope = roadElevationMode(road) === 'gentleSlope';
    const conforms = fixedY !== null || gentleSlope;
    const terrainY = new Float64Array(n);
    const wilds = new Uint8Array(n);
    const cityPin = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) {
      terrainY[i] = sampleHeight(samples[i].x, samples[i].z);
      // Conforming roads (fixed / gentle slope) grade terrain even inside wilds.
      wilds[i] = conforms ? 0 : (isWilds(samples[i].x, samples[i].z) ? 1 : 0);
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
    } else if (gentleSlope) {
      roadY = buildGentleSlopeRoadY(terrainY, s);
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
      grounded[k] = conforms || (!wilds[k] && roadY[k] - terrainY[k] <= BRIDGE_THRESH) ? 1 : 0;
    }

    built.push({
      road, samples, n, width, half, roadY, terrainY, grounded, wilds, s,
      edgeBlend: gentleSlope ? gentleSlopeEdgeBlend(terrainY) : EDGE_BLEND,
      fixed: conforms,
      // 1 outside junctions, eased to 0 inside. The ribbon shader uses this to
      // stop ordinary lane/edge lines before intersection-specific decals.
      intersectionMask: new Float32Array(n).fill(1),
    });
  }

  const intersections = buildRoadIntersections(built);

  // Terrain-follow seams that grade-smoothing left high above the heightfield
  // otherwise spawn floating intersection pads + deck colliders (cars clip under
  // the slab). Re-seat those at-grade junctions onto local terrain so the pad,
  // ribbon, and ground conform share one elevation.
  pinTerrainFollowJunctions(built, intersections);

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

  // Spatial hash: bucket segment/intersection candidates by every cell their
  // inflated corridor bounds touch. That makes corridorAt a single-cell lookup
  // instead of scanning outward through mostly-empty rings for every terrain
  // vertex at high driving speeds.
  const segmentGrid = new Map();
  const intersectionGrid = new Map();
  const key = (cx, cz) => (cx + 0x8000) * 0x10000 + (cz + 0x8000);
  const addToGrid = (target, minX, minZ, maxX, maxZ, value) => {
    const minCx = Math.floor(minX / CELL);
    const maxCx = Math.floor(maxX / CELL);
    const minCz = Math.floor(minZ / CELL);
    const maxCz = Math.floor(maxZ / CELL);
    for (let cx = minCx; cx <= maxCx; cx += 1) {
      for (let cz = minCz; cz <= maxCz; cz += 1) {
        const kk = key(cx, cz);
        let arr = target.get(kk);
        if (!arr) { arr = []; target.set(kk, arr); }
        arr.push(value);
      }
    }
  };
  for (let r = 0; r < built.length; r += 1) {
    const b = built[r];
    const reach = b.half + (b.edgeBlend ?? EDGE_BLEND);
    for (let k = 0; k < b.n - 1; k += 1) {
      const a = b.samples[k];
      const c = b.samples[k + 1];
      addToGrid(
        segmentGrid,
        Math.min(a.x, c.x) - reach,
        Math.min(a.z, c.z) - reach,
        Math.max(a.x, c.x) + reach,
        Math.max(a.z, c.z) + reach,
        r * 1e7 + k, // pack (road, segment)
      );
    }
  }

  for (let i = 0; i < intersections.length; i += 1) {
    const intersection = intersections[i];
    // Tunnel portal/intersection terrain must remain governed by the tunnel road
    // corridor so portal carving, buried cover and hole-mask tagging survive.
    // A generic flat pad reports tunnel:false and otherwise plugs the bore.
    if (!intersection.grounded || intersection.tunnelConnection) continue;
    const connected = built[intersection.connections?.[0]?.roadIndex];
    const blend = connected?.edgeBlend ?? EDGE_BLEND;
    const bounds = polygonBounds(intersection.footprint);
    addToGrid(
      intersectionGrid,
      bounds.minX - blend,
      bounds.minZ - blend,
      bounds.maxX + blend,
      bounds.maxZ + blend,
      i,
    );
  }

  // Nearest-on-segment query over candidates pre-bucketed into the query cell.
  const corridorAt = (x, z) => {
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    const kk = key(cx, cz);
    let best = null;
    let bestDist = Infinity;
    let bestWeight = 0;

    // Junction discs claim their whole pad at full strength: the roadworks
    // intersection surface is a flat disc of `radius` at intersection.y, and
    // the corners between arms aren't guaranteed to fall inside any single
    // road's corridor (nor at full weight near unequal-width joins).
    const intersectionCandidates = intersectionGrid.get(kk);
    if (intersectionCandidates) for (const intersectionIndex of intersectionCandidates) {
      const intersection = intersections[intersectionIndex];
      const connected = built[intersection.connections?.[0]?.roadIndex];
      const blend = connected?.edgeBlend ?? EDGE_BLEND;
      const signedDistance = signedDistanceToPolygon(x, z, intersection.footprint);
      if (signedDistance > blend) continue;
      const d = Math.max(0, signedDistance);
      const w = signedDistance <= 0 ? 1 : 1 - signedDistance / blend;
      if (w <= 0 || w < bestWeight || (w === bestWeight && d >= bestDist)) continue;
      bestWeight = w;
      bestDist = d;
      const connectedRoad = built[intersection.connections?.[0]?.roadIndex]?.road;
      best = {
        roadY: intersection.y,
        grounded: true,
        half: intersection.radius,
        tunnel: false,
        portalDist: Infinity,
        withinRoad: true,
        surface: surfaceForRoad(connectedRoad),
      };
    }

    const segmentCandidates = segmentGrid.get(kk);
    if (segmentCandidates) for (const packed of segmentCandidates) {
      const r = Math.floor(packed / 1e7);
      const seg = packed - r * 1e7;
      const b = built[r];
      const a = b.samples[seg], c = b.samples[seg + 1];
      const abx = c.x - a.x, abz = c.z - a.z;
      const lenSq = abx * abx + abz * abz;
      const rawT = lenSq > 0 ? ((x - a.x) * abx + (z - a.z) * abz) / lenSq : 0;
      let t = rawT;
      t = Math.max(0, Math.min(1, t));
      const px = a.x + t * abx, pz = a.z + t * abz;
      const dx = x - px, dz = z - pz;
      const blend = b.edgeBlend ?? EDGE_BLEND;
      const reach = b.half + blend;
      const dSq = dx * dx + dz * dz;
      if (dSq > reach * reach) continue;
      const d = Math.sqrt(dSq);
      // Strongest corridor claims the point, nearest wins ties. Pure
      // nearest-centerline selection let a narrow road's weak feather
      // shadow a wider road's full-strength corridor beside a junction —
      // an unconformed (collision) hole under the flat junction pad.
      const w = d <= b.half ? 1 : 1 - (d - b.half) / blend;
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
          surface: surfaceForRoad(b.road),
        };
      }
    }
    if (!best || bestWeight <= 0) return null;
    return {
      roadY: best.roadY,
      grounded: !!best.grounded,
      tunnel: !!best.tunnel,
      withinRoad: best.withinRoad !== false,
      portalDist: best.portalDist ?? Infinity,
      surface: best.surface ?? 'asphalt',
      weight: Math.max(0, Math.min(1, bestWeight)),
    };
  };

  return { roads: built, intersections, corridorAt };
}

function polygonBounds(points = []) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x); minZ = Math.min(minZ, point.z);
    maxX = Math.max(maxX, point.x); maxZ = Math.max(maxZ, point.z);
  }
  return Number.isFinite(minX) ? { minX, minZ, maxX, maxZ } : { minX: 0, minZ: 0, maxX: 0, maxZ: 0 };
}

function signedDistanceToPolygon(x, z, points = []) {
  let inside = false;
  let distanceSq = Infinity;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const a = points[j], b = points[i];
    if (((a.z > z) !== (b.z > z)) && x < (b.x - a.x) * (z - a.z) / ((b.z - a.z) || 1e-9) + a.x) inside = !inside;
    const dx = b.x - a.x, dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1)));
    const qx = a.x + dx * t, qz = a.z + dz * t;
    distanceSq = Math.min(distanceSq, (x - qx) ** 2 + (z - qz) ** 2);
  }
  const distance = Math.sqrt(distanceSq);
  return inside ? -distance : distance;
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

/** Re-clamp terrain under a bridged road deck. Call after river (or other) carves
 *  that run later in the shaping stack — otherwise a channel trench punches through
 *  the crossing and the heightfield no longer backs the deck colliders. */
export function clampBridgedRoadFloor(h, corridor, bridgeClearance) {
  if (!corridor || corridor.weight <= 0 || corridor.tunnel) return h;
  if (corridor.weight < 0.999) return h;
  const floor = corridor.grounded ? corridor.roadY : corridor.roadY - bridgeClearance;
  if (!corridor.grounded) return floor;
  return h < floor ? floor : h;
}

/**
 * Nearest drivable point on any authored road centerline (world XZ).
 * Returns { x, z, y, rotationY, distance } or null when nothing is in range.
 */
export function findNearestRoadPoint(profile, x, z, { maxDistance = 160 } = {}) {
  const built = profile?.roads;
  if (!built?.length) return null;

  const maxDistSq = maxDistance * maxDistance;
  let best = null;

  for (const road of built) {
    const { samples, n, roadY } = road;
    if (!samples || n < 2) continue;
    for (let seg = 0; seg < n - 1; seg += 1) {
      const a = samples[seg];
      const c = samples[seg + 1];
      const abx = c.x - a.x;
      const abz = c.z - a.z;
      const lenSq = abx * abx + abz * abz;
      if (lenSq < 1e-6) continue;
      const t = Math.max(0, Math.min(1, ((x - a.x) * abx + (z - a.z) * abz) / lenSq));
      const px = a.x + abx * t;
      const pz = a.z + abz * t;
      const dx = x - px;
      const dz = z - pz;
      const distSq = dx * dx + dz * dz;
      if (distSq > maxDistSq) continue;
      if (!best || distSq < best.distSq) {
        best = {
          x: px,
          z: pz,
          y: roadY[seg] + (roadY[seg + 1] - roadY[seg]) * t,
          distSq,
          rotationY: Math.atan2(-abx, -abz),
        };
      }
    }
  }

  if (!best) return null;
  return {
    x: best.x,
    z: best.z,
    y: best.y,
    rotationY: best.rotationY,
    distance: Math.sqrt(best.distSq),
  };
}
