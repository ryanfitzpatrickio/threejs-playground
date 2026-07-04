export const ROAD_SURFACES = Object.freeze({
  asphalt: Object.freeze({ label: 'Asphalt' }),
  dirt: Object.freeze({ label: 'Dirt / gravel' }),
  mud: Object.freeze({ label: 'Mud (rally)' }),
});

export const ROAD_SURFACE_ORDER = Object.freeze(Object.keys(ROAD_SURFACES));

export function normalizeRoadSurface(value) {
  return typeof value === 'string' && ROAD_SURFACES[value] ? value : null;
}

export function surfaceForTrackStyle(trackStyle) {
  return trackStyle === 'rallyStage' || trackStyle === 'rallySpectator'
    ? 'dirt'
    : 'asphalt';
}

export function surfaceForRoad(road) {
  return normalizeRoadSurface(road?.surface) ?? surfaceForTrackStyle(road?.trackStyle);
}
