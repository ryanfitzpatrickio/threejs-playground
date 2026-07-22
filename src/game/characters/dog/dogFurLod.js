/**
 * Distance LOD for shell fur — stable shell counts + hysteresis so coats
 * don't thrash into white coplanar / undercoat flashes at band boundaries.
 */

/** Default distance bands (metres). */
export const FUR_LOD_NEAR = 16;
export const FUR_LOD_MID = 32;
/** Hysteresis pad so levels don't chatter when the camera sits on a boundary. */
export const FUR_LOD_HYST = 3.5;

/**
 * Pick 0 | 1 | 2 with hysteresis relative to the previous level.
 *
 * @param {number} dist
 * @param {number} [prevLevel]
 * @param {{
 *   near?: number,
 *   mid?: number,
 *   hyst?: number,
 * }} [bands]
 * @returns {0|1|2}
 */
export function pickFurDetailLevel(dist, prevLevel = 2, bands = {}) {
  const near = bands.near ?? FUR_LOD_NEAR;
  const mid = bands.mid ?? FUR_LOD_MID;
  const hyst = bands.hyst ?? FUR_LOD_HYST;
  const d = Number.isFinite(dist) ? dist : mid;
  const prev = Math.max(0, Math.min(2, Math.floor(Number(prevLevel) || 0)));

  // Entering a higher-detail band uses the tight threshold; leaving uses +hyst
  // so borderline subjects stay put instead of flashing shell visibility.
  if (prev >= 2) {
    if (d > near + hyst) return d > mid + hyst ? 0 : 1;
    return 2;
  }
  if (prev === 1) {
    if (d < near) return 2;
    if (d > mid + hyst) return 0;
    return 1;
  }
  // prev === 0
  if (d < near) return 2;
  if (d < mid) return 1;
  return 0;
}

/**
 * How many consecutive shell layers to show for a detail level.
 *
 * Important: shell index 0 has layerT=0 (no extrusion). Showing only that
 * shell leaves a coplanar transparent skin that z-fights white. Sparse NPC
 * stacks (2–4 shells) never drop layers for that reason — cheapen them via
 * skipFurDynamics instead.
 *
 * @param {0|1|2} level
 * @param {number} shellCount
 * @returns {number}
 */
export function shellCountForDetailLevel(level, shellCount) {
  const n = Math.max(0, Math.floor(Number(shellCount) || 0));
  if (n <= 0) return 0;
  const detail = Math.max(0, Math.min(2, Math.floor(Number(level) || 0)));

  // Thin stacks: always keep every shell. Layer drops read as holes/flashes.
  if (n <= 4) return n;

  if (detail >= 2) return n;

  if (detail === 1) {
    // Mid: keep enough volume for a solid coat (never a single root shell).
    return Math.min(n, Math.max(4, Math.ceil(n * 0.5)));
  }

  // Far: keep a short dense base coat so undercoat never flashes bare cream.
  return Math.min(n, Math.max(3, Math.ceil(n * 0.22)));
}
