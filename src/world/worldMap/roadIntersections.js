/**
 * Detects junctions between independently-authored road splines and levels the
 * connected approaches. This module is deliberately THREE-free so the editor,
 * terrain carve, renderer, and regression tests all consume the same result.
 */

const SNAP_DISTANCE = 2.5;
const MAX_HEIGHT_DELTA = 1.75; // larger crossings are overpasses, not junctions
const CLUSTER_DISTANCE = 7;
const MIN_LEVEL_TRANSITION = 12;
// smoothstep's peak derivative is 1.5, so a 6% sizing target keeps the actual
// eased ribbon near 9% even on abrupt terrain steps.
const TARGET_APPROACH_GRADE = 0.06;

export function buildRoadIntersections(roads) {
  const hits = [];

  for (let ra = 0; ra < roads.length; ra += 1) {
    const a = roads[ra];
    for (let rb = ra; rb < roads.length; rb += 1) {
      const b = roads[rb];
      const snap = Math.max(SNAP_DISTANCE, Math.min(a.half, b.half) * 0.45);
      for (let ia = 0; ia < a.n - 1; ia += 1) {
        const a0 = a.samples[ia], a1 = a.samples[ia + 1];
        // On one self-crossing spline, only compare non-neighbouring segments.
        // Nearby segments are the normal continuous ribbon, not a junction.
        const firstB = rb === ra ? ia + 4 : 0;
        for (let ib = firstB; ib < b.n - 1; ib += 1) {
          const b0 = b.samples[ib], b1 = b.samples[ib + 1];
          if (!expandedBoxesOverlap(a0, a1, b0, b1, snap)) continue;
          const closest = closestSegments2D(a0, a1, b0, b1);
          if (closest.distance > snap) continue;
          const alongA = ia + closest.ta;
          const alongB = ib + closest.tb;
          if (ra === rb) {
            // Sampling is ~2.5 m, so the old fixed four-segment skip still made a
            // wide bend collide with itself only 10 m farther along the same
            // ribbon. A real self-crossing has substantial arc separation.
            const arcA = distanceAtFraction(a.s, alongA);
            const arcB = distanceAtFraction(a.s, alongB);
            if (Math.abs(arcA - arcB) < Math.max(30, a.width * 2.5)) continue;
          }
          const aLength = Math.hypot(a1.x - a0.x, a1.z - a0.z) || 1;
          const bLength = Math.hypot(b1.x - b0.x, b1.z - b0.z) || 1;
          const parallel = Math.abs(((a1.x - a0.x) * (b1.x - b0.x) + (a1.z - a0.z) * (b1.z - b0.z)) / (aLength * bLength)) > 0.966;
          const joinsAtRoadEnd = alongA < 1.25 || alongA > a.n - 2.25 || alongB < 1.25 || alongB > b.n - 2.25;
          // A tunnel may join another road at a portal, but an interior crossing
          // is grade-separated even when their sampled centreline heights happen
          // to match. Treating it as a junction blocks the bore with pad terrain.
          if ((a.road?.trackStyle === 'tunnel' || b.road?.trackStyle === 'tunnel') && !joinsAtRoadEnd) continue;
          if (parallel && !joinsAtRoadEnd) continue;
          const ay = lerp(a.roadY[ia], a.roadY[ia + 1], closest.ta);
          const by = lerp(b.roadY[ib], b.roadY[ib + 1], closest.tb);
          if (Math.abs(ay - by) > MAX_HEIGHT_DELTA) continue;
          hits.push({
            x: (closest.ax + closest.bx) * 0.5,
            z: (closest.az + closest.bz) * 0.5,
            y: (ay + by) * 0.5,
            refs: [
              { roadIndex: ra, at: alongA },
              { roadIndex: rb, at: alongB },
            ],
          });
        }
      }
    }
  }

  const clusters = clusterHits(hits);
  const intersections = clusters
    .map((cluster, index) => finalizeIntersection(cluster, roads, index))
    .filter((intersection) => intersection.wayCount >= 2);

  // Level every connected centerline before corridorAt captures the road arrays.
  // Samples in the junction core are exactly horizontal; approaches ease onto it.
  for (const intersection of intersections) {
    levelIntersectionApproaches(intersection, roads);
  }

  return intersections;
}

/**
 * Re-level every free (non-fixed) approach onto `intersection.y`. Shared by the
 * initial build and the terrain-pin pass so at-grade junctions can be re-seated
 * onto the heightfield without floating bridge decks.
 */
export function levelIntersectionApproaches(intersection, roads) {
  for (const ref of intersection.connections) {
    const road = roads[ref.roadIndex];
    const along = cumulativeDistances(road.samples);
    const atDistance = distanceAtFraction(along, ref.at);
    for (let i = 0; i < road.n; i += 1) {
      const d = Math.abs(along[i] - atDistance);
      const transition = ref.transition ?? MIN_LEVEL_TRANSITION;
      if (d > intersection.radius + transition) continue;
      const weight = d <= intersection.radius
        ? 1
        : 1 - smoothstep(intersection.radius, intersection.radius + transition, d);
      if (!road.fixed) road.roadY[i] = lerp(road.roadY[i], intersection.y, weight);
      if (intersection.kind !== 'continuation') {
        road.intersectionMask[i] = Math.min(road.intersectionMask[i], 1 - weight);
      }
    }
  }
}

function finalizeIntersection(cluster, roads, index) {
  const connectionsByRoad = new Map();
  for (const hit of cluster.hits) {
    for (const ref of hit.refs) {
      let values = connectionsByRoad.get(ref.roadIndex);
      if (!values) { values = []; connectionsByRoad.set(ref.roadIndex, values); }
      values.push(ref.at);
    }
  }
  const connections = [];
  for (const [roadIndex, unsorted] of connectionsByRoad) {
    const values = [...unsorted].sort((a, b) => a - b);
    let group = [];
    for (const value of values) {
      if (group.length && value - group[group.length - 1] > 3) {
        connections.push({ roadIndex, at: group.reduce((sum, item) => sum + item, 0) / group.length });
        group = [];
      }
      group.push(value);
    }
    if (group.length) connections.push({ roadIndex, at: group.reduce((sum, item) => sum + item, 0) / group.length });
  }

  const x = cluster.x;
  const z = cluster.z;
  const fixedConnection = connections.find((ref) => roads[ref.roadIndex].fixed);
  const fixedRoad = fixedConnection ? roads[fixedConnection.roadIndex] : null;
  const y = fixedRoad
    ? fixedRoad.roadY[Math.max(0, Math.min(fixedRoad.n - 1, Math.round(fixedConnection.at)))]
    : cluster.hits.reduce((sum, hit) => sum + hit.y, 0) / cluster.hits.length;
  const maxHalf = Math.max(...connections.map((ref) => roads[ref.roadIndex].half));
  const arms = [];

  for (const ref of connections) {
    const road = roads[ref.roadIndex];
    const at = Math.max(0, Math.min(road.n - 1, ref.at));
    const i = Math.min(road.n - 2, Math.floor(at));
    const t = at - i;
    const px = lerp(road.samples[i].x, road.samples[i + 1].x, t);
    const pz = lerp(road.samples[i].z, road.samples[i + 1].z, t);
    const startDistance = polylineDistance(road.samples, 0, at);
    const endDistance = polylineDistance(road.samples, at, road.n - 1);
    if (startDistance > maxHalf * 0.65) {
      const dir = directionAway(road.samples, at, -1);
      addUniqueArm(arms, { ...dir, width: road.width, half: road.half, roadIndex: ref.roadIndex, direction: -1 });
    }
    if (endDistance > maxHalf * 0.65) {
      const dir = directionAway(road.samples, at, 1);
      addUniqueArm(arms, { ...dir, width: road.width, half: road.half, roadIndex: ref.roadIndex, direction: 1 });
    }
    // A very short terminating piece still contributes one approach.
    if (!arms.some((arm) => arm.roadIndex === ref.roadIndex)) {
      const endpoint = startDistance >= endDistance ? road.samples[0] : road.samples[road.n - 1];
      const dx = endpoint.x - px, dz = endpoint.z - pz;
      const length = Math.hypot(dx, dz) || 1;
      addUniqueArm(arms, { x: dx / length, z: dz / length, width: road.width, half: road.half, roadIndex: ref.roadIndex, direction: startDistance >= endDistance ? -1 : 1 });
    }
  }

  const sourceWidth = Math.max(...connections.map((ref) => roads[ref.roadIndex].road?.width ?? roads[ref.roadIndex].width / 1.5));
  const sizeClass = sourceWidth < 8 ? 'small' : (sourceWidth <= 14 ? 'medium' : 'large');
  const kind = arms.length === 2 ? 'continuation' : (arms.length === 3 ? 't' : (arms.length === 4 ? 'cross' : 'multi'));
  // Large junctions need room for a painted left-turn pocket, a right-turn slip
  // lane and its triangular refuge island. Other junctions stay compact and
  // width-driven instead of inheriting one arbitrary circular radius.
  const radius = Math.max(4, maxHalf + (sizeClass === 'large' ? 10 : sizeClass === 'medium' ? 4 : 2));
  const footprint = buildFootprint({ x, z, arms, maxHalf, radius, kind, sizeClass });

  // Make each approach long enough to meet the level pad at a civil-looking
  // grade. Terrain is cut to the resulting road profile later; this protects the
  // ribbon itself from the abrupt fixed-length ramp that used to form a cliff.
  for (const ref of connections) {
    const road = roads[ref.roadIndex];
    const along = cumulativeDistances(road.samples);
    const atDistance = distanceAtFraction(along, ref.at);
    let required = Math.max(MIN_LEVEL_TRANSITION, road.half * 2);
    for (let i = 0; i < road.n; i += 1) {
      const d = Math.abs(along[i] - atDistance);
      if (d < radius || d > 120) continue;
      required = Math.max(required, Math.abs(road.roadY[i] - y) / TARGET_APPROACH_GRADE - radius);
    }
    ref.transition = Math.min(120, required);
  }

  return {
    id: `intersection-${index}`,
    x, z, y, radius,
    connections,
    arms,
    wayCount: arms.length,
    kind,
    sizeClass,
    footprint,
    tunnelConnection: connections.some((ref) => roads[ref.roadIndex].road?.trackStyle === 'tunnel'),
  };
}

function buildFootprint({ x, z, arms, maxHalf, radius, kind, sizeClass }) {
  const coreHalf = maxHalf;
  const armReach = radius + (sizeClass === 'large' ? 5 : 1);
  const primary = arms[0] ?? { x: 1, z: 0 };
  const basisX = primary.x, basisZ = primary.z;
  const inside = (px, pz) => {
    // A square/rectangular core gives a T its requested flat back side. Approach
    // rectangles then make the outline follow the actual topology rather than a
    // disc occupying corners where no road exists.
    const coreAlong = px * basisX + pz * basisZ;
    const coreLateral = px * -basisZ + pz * basisX;
    if (Math.abs(coreAlong) <= coreHalf && Math.abs(coreLateral) <= coreHalf) return true;
    return arms.some((arm) => {
      const along = px * arm.x + pz * arm.z;
      const lateral = Math.abs(px * -arm.z + pz * arm.x);
      // Eight metres at the throat leaves a usable ~3 m bypass outside the
      // 2.5 m-wide refuge island, so the right slip lane is actual asphalt rather
      // than paint squeezed against the ordinary ribbon edge.
      const flare = sizeClass === 'large' ? Math.min(8, along * 0.3) : 0;
      return along >= 0 && along <= armReach && lateral <= arm.half + flare;
    });
  };
  const points = [];
  const maxReach = armReach + maxHalf + 5;
  for (let i = 0; i < 96; i += 1) {
    const angle = (i / 96) * Math.PI * 2;
    const dx = Math.cos(angle), dz = Math.sin(angle);
    let low = 0, high = maxReach;
    for (let step = 0; step < 12; step += 1) {
      const mid = (low + high) * 0.5;
      if (inside(dx * mid, dz * mid)) low = mid;
      else high = mid;
    }
    points.push({ x: x + dx * low, z: z + dz * low });
  }
  return points;
}

function clusterHits(hits) {
  const clusters = [];
  for (const hit of hits) {
    let cluster = clusters.find((item) => Math.hypot(item.x - hit.x, item.z - hit.z) <= CLUSTER_DISTANCE
      && Math.abs(item.y - hit.y) <= MAX_HEIGHT_DELTA);
    if (!cluster) {
      cluster = { x: hit.x, z: hit.z, y: hit.y, hits: [] };
      clusters.push(cluster);
    }
    cluster.hits.push(hit);
    const count = cluster.hits.length;
    cluster.x += (hit.x - cluster.x) / count;
    cluster.z += (hit.z - cluster.z) / count;
    cluster.y += (hit.y - cluster.y) / count;
  }
  return clusters;
}

function addUniqueArm(arms, arm) {
  // Multiple almost-collinear road pieces form one physical approach.
  const duplicate = arms.some((other) => other.x * arm.x + other.z * arm.z > 0.94);
  if (!duplicate) arms.push(arm);
}

function directionAway(points, at, sign) {
  const i = Math.max(0, Math.min(points.length - 2, Math.floor(at)));
  let dx = points[i + 1].x - points[i].x;
  let dz = points[i + 1].z - points[i].z;
  if (sign < 0) { dx = -dx; dz = -dz; }
  const length = Math.hypot(dx, dz) || 1;
  return { x: dx / length, z: dz / length };
}

function cumulativeDistances(points) {
  const out = new Float64Array(points.length);
  for (let i = 1; i < points.length; i += 1) out[i] = out[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  return out;
}

function distanceAtFraction(distances, at) {
  const i = Math.max(0, Math.min(distances.length - 2, Math.floor(at)));
  return lerp(distances[i], distances[i + 1], at - i);
}

function polylineDistance(points, from, to) {
  const distances = cumulativeDistances(points);
  return Math.abs(distanceAtFraction(distances, Math.min(to, points.length - 1 - 1e-9)) - distanceAtFraction(distances, Math.min(from, points.length - 1 - 1e-9)));
}

function expandedBoxesOverlap(a0, a1, b0, b1, pad) {
  return Math.max(a0.x, a1.x) + pad >= Math.min(b0.x, b1.x)
    && Math.max(b0.x, b1.x) + pad >= Math.min(a0.x, a1.x)
    && Math.max(a0.z, a1.z) + pad >= Math.min(b0.z, b1.z)
    && Math.max(b0.z, b1.z) + pad >= Math.min(a0.z, a1.z);
}

// Closest points on two 2D segments (ported from the standard finite-segment
// formulation; handles endpoint joins and nearly parallel overlaps).
function closestSegments2D(a0, a1, b0, b1) {
  const ux = a1.x - a0.x, uz = a1.z - a0.z;
  const vx = b1.x - b0.x, vz = b1.z - b0.z;
  const wx = a0.x - b0.x, wz = a0.z - b0.z;
  const aa = ux * ux + uz * uz;
  const bb = ux * vx + uz * vz;
  const cc = vx * vx + vz * vz;
  const dd = ux * wx + uz * wz;
  const ee = vx * wx + vz * wz;
  const denom = aa * cc - bb * bb;
  let ta = denom > 1e-9 ? clamp01((bb * ee - cc * dd) / denom) : 0;
  let tb = cc > 1e-9 ? clamp01((bb * ta + ee) / cc) : 0;
  ta = aa > 1e-9 ? clamp01((bb * tb - dd) / aa) : 0;
  tb = cc > 1e-9 ? clamp01((bb * ta + ee) / cc) : 0;
  const ax = a0.x + ux * ta, az = a0.z + uz * ta;
  const bx = b0.x + vx * tb, bz = b0.z + vz * tb;
  return { ta, tb, ax, az, bx, bz, distance: Math.hypot(ax - bx, az - bz) };
}

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, value) => {
  const t = clamp01((value - a) / (b - a));
  return t * t * (3 - 2 * t);
};
