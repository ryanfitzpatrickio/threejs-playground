export const ROAD_SURFACES = Object.freeze({
  asphalt: Object.freeze({ label: 'Asphalt' }),
  dirt: Object.freeze({ label: 'Dirt / gravel' }),
  // Between dirt and mud: slick + persistent puddles, no bog/dig-in
  // (docs/advanced-wet-roads-plan.md).
  wet: Object.freeze({ label: 'Wet (rally)' }),
  mud: Object.freeze({ label: 'Mud (rally)' }),
});

export const ROAD_SURFACE_ORDER = Object.freeze(Object.keys(ROAD_SURFACES));

// Demo wear for mud/wet roads: fresh = clean stage; preWorn = ~3 prior laps of
// dual-wheel tread that fade much slower than live tyre stamps.
export const ROAD_SURFACE_WEAR = Object.freeze({
  fresh: Object.freeze({ label: 'Fresh' }),
  preWorn: Object.freeze({ label: 'Pre-worn (3 laps)' }),
});

export const ROAD_SURFACE_WEAR_ORDER = Object.freeze(Object.keys(ROAD_SURFACE_WEAR));

export function normalizeRoadSurface(value) {
  return typeof value === 'string' && ROAD_SURFACES[value] ? value : null;
}

export function normalizeRoadSurfaceWear(value) {
  return typeof value === 'string' && ROAD_SURFACE_WEAR[value] ? value : null;
}

export function surfaceForTrackStyle(trackStyle) {
  return trackStyle === 'rallyStage' || trackStyle === 'rallySpectator'
    ? 'dirt'
    : 'asphalt';
}

export function surfaceForRoad(road) {
  return normalizeRoadSurface(road?.surface) ?? surfaceForTrackStyle(road?.trackStyle);
}

/** Mud always has tread; wet defaults to tread on unless `road.tread === false`. */
export function roadWantsTread(road) {
  const surface = surfaceForRoad(road);
  if (surface === 'mud') return true;
  if (surface === 'wet') return road?.tread !== false;
  return false;
}

/** `fresh` | `preWorn` — only meaningful for mud/wet. */
export function surfaceWearForRoad(road) {
  const surface = surfaceForRoad(road);
  if (surface !== 'mud' && surface !== 'wet') return 'fresh';
  return normalizeRoadSurfaceWear(road?.surfaceWear) ?? 'fresh';
}

/** Rally deform field is built when any mud/wet-with-tread road exists. */
export function roadNeedsDeformField(road) {
  return roadWantsTread(road);
}
