/**
 * Gentle-slope elevation for world-map `terrain` zones (props.elevationType =
 * 'gentleSlope'). Samples the existing procedural+biome height inside the zone,
 * finds the lowest and highest points, then reshapes the surface into the planar
 * ramp between them.
 */

import { zoneBounds, zoneContains, zoneDistanceOutside } from './zoneGeometry.js';

export const GENTLE_SLOPE_ELEVATION_MARGIN = 24;

/**
 * Scan the zone on a coarse grid and return the world positions + heights of the
 * lowest and highest existing terrain samples.
 */
export function findGentleSlopeExtents(zone, sampleHeight) {
  const bounds = zoneBounds(zone);
  const width = bounds.maxX - bounds.minX;
  const depth = bounds.maxZ - bounds.minZ;
  const step = Math.max(4, Math.min(16, Math.min(width, depth) / 24));

  let lowX = bounds.minX;
  let lowZ = bounds.minZ;
  let lowH = Infinity;
  let highX = bounds.minX;
  let highZ = bounds.minZ;
  let highH = -Infinity;
  let samples = 0;

  for (let x = bounds.minX; x <= bounds.maxX + 1e-6; x += step) {
    for (let z = bounds.minZ; z <= bounds.maxZ + 1e-6; z += step) {
      if (!zoneContains(zone, x, z)) continue;
      const h = sampleHeight(x, z);
      samples += 1;
      if (h < lowH) {
        lowH = h;
        lowX = x;
        lowZ = z;
      }
      if (h > highH) {
        highH = h;
        highX = x;
        highZ = z;
      }
    }
  }

  if (samples === 0 || !Number.isFinite(lowH) || !Number.isFinite(highH)) return null;

  const dx = highX - lowX;
  const dz = highZ - lowZ;
  const lenSq = dx * dx + dz * dz;

  return {
    zone,
    lowX,
    lowZ,
    lowH,
    highX,
    highZ,
    highH,
    dx,
    dz,
    lenSq,
  };
}

/** Height of the planar ramp through the low/high sample points at world (x, z). */
export function gentleSlopeHeightAt(profile, x, z) {
  if (!profile) return 0;
  const { lowX, lowZ, lowH, highH, dx, dz, lenSq } = profile;
  if (lenSq < 1e-6) return (lowH + highH) * 0.5;
  const t = ((x - lowX) * dx + (z - lowZ) * dz) / lenSq;
  return lowH + t * (highH - lowH);
}

/**
 * Blend the gentle-slope ramp over the incoming height. Winner-take-all by blend
 * weight (mirrors elevation min/max zones).
 */
export function applyGentleSlopeProfiles(x, z, h, profiles, margin = GENTLE_SLOPE_ELEVATION_MARGIN) {
  if (!profiles?.length) return h;
  let bestW = 0;
  let target = h;
  for (const profile of profiles) {
    const d = zoneDistanceOutside(profile.zone, x, z);
    const w = d <= 0 ? 1 : d >= margin ? 0 : 1 - d / margin;
    if (w <= bestW) continue;
    bestW = w;
    target = gentleSlopeHeightAt(profile, x, z);
  }
  if (bestW <= 0) return h;
  return h * (1 - bestW) + target * bestW;
}

export function buildGentleSlopeProfiles(zones, sampleHeight) {
  return (zones ?? [])
    .filter((z) => z?.type === 'terrain' && z.props?.elevationType === 'gentleSlope')
    .map((zone) => findGentleSlopeExtents(zone, sampleHeight))
    .filter(Boolean);
}
