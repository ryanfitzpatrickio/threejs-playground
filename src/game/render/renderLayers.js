// Layer 0 is ordinary world geometry. Small instanced detail (city sidewalk
// furniture, office desks/chairs, etc.) lives on this layer so the main camera
// still renders it while the SSAO normal/depth prepass omits it.
export const CITY_FURNITURE_LAYER = 2;
