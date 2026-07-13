// Shared runtime constants extracted from GameRuntime.

// Office interiors live persistently far below the map, one slot per building,
// built lazily on first entry and cached for the session. Entering is then a pure
// teleport (no rebuild / no material recompile) — the swap only reassigns the
// LevelSystem facade pointer. See InteriorRuntimeFeature.
export const OFFICE_INTERIOR_OWNER = 'office-interior';
export const INTERIOR_BASE_Y = -1000;
export const INTERIOR_SLOT_SPACING = 300;
export const INTERIOR_SLOTS_PER_ROW = 24;
export const SNAPSHOT_INTERVAL_NORMAL_MS = 100;
export const SNAPSHOT_INTERVAL_HEAVY_MS = 250;
export const SNAPSHOT_HEAVY_VEHICLE_SPEED = 18;
export const FULL_SNAPSHOT_INTERVAL_MS = 1000;
// Pipeline prewarming is an optimization, not a play-ready requirement. Some
// WebGPU driver/browser combinations leave compileAsync pending indefinitely;
// fail open so the visible character never remains input-locked in a T-pose.
export const INITIAL_PIPELINE_COMPILE_TIMEOUT_MS = 8_000;

// Deterministic seed for a building's interior so the same building regenerates
// the same office each time (P1 WFC will consume it).
export function buildingSeed(building) {
  const key = `${building?.name ?? ''}:${Math.round(building?.minX ?? 0)}:${Math.round(building?.minZ ?? 0)}`;
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) || 1;
}
