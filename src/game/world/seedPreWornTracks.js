// Build pre-worn dual-wheel stamp points from a road profile — as if another
// car had driven the stage ~3 times. Used by MudDeformField.installPreWornPoints
// (docs/advanced-wet-roads-plan.md + demo wear for mud/wet).
//
// Each "lap" is a dual-track offset (left/right of centreline) with slight
// lateral jitter so three passes don't sit in the exact same groove.

import { surfaceForRoad, surfaceWearForRoad, roadWantsTread } from '../../world/worldMap/roadSurface.js';

/** Typical rally track half-width offsets for left/right tyre lines (m). */
const WHEEL_LATERAL = 0.72;
/** Spacing along the centerline between stamp points (m). */
const ALONG_SPACING = 0.55;
/** Number of prior-lap passes to lay down. */
const DEFAULT_LAPS = 3;

/**
 * @param {object} roadProfile - from buildRoadProfile
 * @param {object} [opts]
 * @param {number} [opts.laps=3]
 * @param {'mud'|'wet'|null} [opts.surfaceFilter] - only seed roads of this surface
 * @returns {Array<{x,z,directionX,directionZ,depth,wetness,tread,radius}>}
 */
export function buildPreWornStampPoints(roadProfile, {
  laps = DEFAULT_LAPS,
  surfaceFilter = null,
} = {}) {
  const roads = roadProfile?.roads;
  if (!Array.isArray(roads) || roads.length === 0) return [];

  const points = [];
  for (const b of roads) {
    const road = b.road;
    if (!roadWantsTread(road)) continue;
    if (surfaceWearForRoad(road) !== 'preWorn') continue;
    const surface = surfaceForRoad(road);
    if (surfaceFilter && surface !== surfaceFilter) continue;

    const samples = b.samples;
    const n = b.n ?? samples?.length ?? 0;
    if (!samples || n < 2) continue;

    const half = b.half ?? (b.width ?? 6) * 0.5;
    const wheelLat = Math.min(WHEEL_LATERAL, half * 0.55);
    // Wet pre-wear is shallower than mud but deep enough to clear the atlas /
    // vertex-sink thresholds (normalized rut ≳ 0.2 of maxDepth).
    const isWet = surface === 'wet';
    const baseDepth = isWet ? 0.055 : 0.09;
    const baseWet = isWet ? 0.85 : 0.65;
    const baseTread = 1;
    const brushR = isWet ? 0.2 : 0.24;

    for (let lap = 0; lap < laps; lap += 1) {
      // Each lap drifts slightly — like a previous car choosing a line.
      const lapBias = (lap - (laps - 1) * 0.5) * 0.09;
      const depthScale = 1 - lap * 0.08; // older laps slightly shallower
      let alongCarry = 0;

      for (let i = 0; i < n - 1; i += 1) {
        const a = samples[i];
        const c = samples[i + 1];
        const segLen = Math.hypot(c.x - a.x, c.z - a.z);
        if (!(segLen > 1e-4)) continue;
        const tx = (c.x - a.x) / segLen;
        const tz = (c.z - a.z) / segLen;
        // Road-right perpendicular (flat).
        const rx = -tz;
        const rz = tx;

        alongCarry += segLen;
        // Emit stamps at ~ALONG_SPACING along the segment (plus lap phase offset).
        const phase = (lap * 0.17) % ALONG_SPACING;
        let s = phase;
        while (s < segLen) {
          const t = s / segLen;
          const cx = a.x + (c.x - a.x) * t;
          const cz = a.z + (c.z - a.z) * t;
          // Tiny high-frequency wobble so tracks don't look laser-straight.
          const wobble = Math.sin((alongCarry + s) * 0.35 + lap * 1.7) * 0.04;

          for (const side of [-1, 1]) {
            const lat = side * (wheelLat + lapBias) + wobble * side;
            points.push({
              x: cx + rx * lat,
              z: cz + rz * lat,
              directionX: tx,
              directionZ: tz,
              depth: baseDepth * depthScale,
              wetness: baseWet,
              tread: baseTread,
              radius: brushR,
            });
          }
          s += ALONG_SPACING;
        }
      }
    }
  }
  return points;
}

/**
 * Install pre-worn points on a mud/wet deform field and seed the initial
 * footprint around `center` (usually the map spawn).
 */
export function seedPreWornOnField(mudField, roadProfile, {
  centerX = 0,
  centerZ = 0,
  laps = DEFAULT_LAPS,
} = {}) {
  if (!mudField || !roadProfile) return { points: 0, stamped: 0 };
  const points = buildPreWornStampPoints(roadProfile, { laps });
  mudField.installPreWornPoints(points);
  // First paint around spawn so the player sees prior tracks immediately.
  const stamped = mudField.refreshPreWorn?.(centerX, centerZ) ?? 0;
  return { points: points.length, stamped };
}
