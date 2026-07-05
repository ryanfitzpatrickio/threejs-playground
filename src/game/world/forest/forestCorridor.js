/**
 * Corridor exclusion for forest zones — wider clearance than wilds blob trees
 * so pine limbs do not overhang the driving line.
 */

const SAMPLE_OFFSETS = [
  [0, 0],
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [0.707, 0.707], [-0.707, 0.707], [0.707, -0.707], [-0.707, -0.707],
];

function corridorWeightAt(x, z, corridor) {
  if (typeof corridor !== 'function') return 0;
  const sample = corridor(x, z);
  return sample?.weight ?? 0;
}

function maxCorridorWeight(x, z, roadCorridor, riverCorridor, margin) {
  let best = 0;
  for (const [ox, oz] of SAMPLE_OFFSETS) {
    const sx = x + ox * margin;
    const sz = z + oz * margin;
    best = Math.max(best, corridorWeightAt(sx, sz, roadCorridor));
    best = Math.max(best, corridorWeightAt(sx, sz, riverCorridor));
  }
  return best;
}

/** Pure predicate — exported for verify-forest-zone.mjs. */
export function isForestZoneCorridorExcluded(
  x,
  z,
  roadCorridor,
  riverCorridor,
  margin = 5,
) {
  return maxCorridorWeight(x, z, roadCorridor, riverCorridor, margin) > 0;
}
