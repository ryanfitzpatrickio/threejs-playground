import * as THREE from 'three';
import { zoneBounds, zoneContains, polygonArea } from '../../../world/worldMap/zoneGeometry.js';

export const DEFAULT_FOREST_DENSITY_PER_HA = 150; // trees per hectare (~0.015/m²)
export const FOREST_BASE_SINK = 0.25;
export const FOREST_MIN_FLATNESS = 0.45;
export const FOREST_CORRIDOR_MARGIN = 5;

export function hashZone(zone) {
  const b = zoneBounds(zone);
  return Math.abs((Math.round(b.minX) * 73856093) ^ (Math.round(b.minZ) * 19349663)) >>> 0;
}

export function mulberry32(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function zoneForestSeed(zone) {
  const zoneSeed = Number.isFinite(Number(zone.props?.seed)) ? Number(zone.props.seed) : 1;
  return (hashZone(zone) ^ (zoneSeed * 2654435761)) >>> 0;
}

export function densityNoise(x, z) {
  const n =
    Math.sin(x * 0.018 + 1.3) * Math.cos(z * 0.015 + 0.7) * 0.6 +
    Math.sin(x * 0.05 + z * 0.04) * 0.4;
  return THREE.MathUtils.clamp(n * 0.5 + 0.62, 0, 1);
}

export function slopeFlatnessAt(sampleHeight, x, z, epsilon = 3) {
  const hx = sampleHeight(x + epsilon, z) - sampleHeight(x - epsilon, z);
  const hz = sampleHeight(x, z + epsilon) - sampleHeight(x, z - epsilon);
  return (2 * epsilon) / Math.sqrt(hx * hx + 4 * epsilon * epsilon + hz * hz);
}

export function zoneAreaSqM(zone) {
  return zone.shape === 'polygon'
    ? polygonArea(zone.points)
    : Math.max(0, (zone.rect.maxX - zone.rect.minX) * (zone.rect.maxZ - zone.rect.minZ));
}

export function treesPerSqM(zone) {
  const perHa = Number.isFinite(Number(zone.props?.density))
    ? Math.max(1, Number(zone.props.density))
    : DEFAULT_FOREST_DENSITY_PER_HA;
  return perHa / 10000;
}

export function computeForestPlacementTarget(zones, cap) {
  // Sum each zone's OWN density × area. The old form applied zones[0]'s density
  // to every plot's area, so a 1000 trees/ha plot next to a 150/ha plot silently
  // inherited the lower rate — the per-plot density control didn't compose.
  let target = 0;
  for (const zone of zones) target += zoneAreaSqM(zone) * treesPerSqM(zone);
  return Math.min(cap, Math.max(0, Math.ceil(target)));
}

/**
 * Deterministic rejection scatter for forest zones.
 * @returns {Array<{ x, y, z, rotY, scale, archetypeIndex, zoneId }>}
 */
export function scatterForestPlacements({
  zones = [],
  sampleHeight,
  roadCorridor = null,
  riverCorridor = null,
  archetypeCount = 5,
  pickArchetypeIndex = null,
  cap = 250,
  corridorExcluded = () => false,
}) {
  if (!zones.length || cap <= 0) return [];

  const target = computeForestPlacementTarget(zones, cap);
  const placements = [];

  for (const zone of zones) {
    if (placements.length >= target) break;
    const b = zoneBounds(zone);
    const area = Math.max(1, zoneAreaSqM(zone));
    const zoneTarget = Math.min(
      target - placements.length,
      Math.max(1, Math.ceil(area * treesPerSqM(zone))),
    );
    const rng = mulberry32(zoneForestSeed(zone));
    let zonePlaced = 0;
    let attempts = 0;
    const maxAttempts = zoneTarget * 16;

    while (zonePlaced < zoneTarget && placements.length < target && attempts < maxAttempts) {
      attempts += 1;
      const x = b.minX + rng() * (b.maxX - b.minX);
      const z = b.minZ + rng() * (b.maxZ - b.minZ);
      if (!zoneContains(zone, x, z)) continue;
      if (corridorExcluded(x, z, roadCorridor, riverCorridor)) continue;

      const y = sampleHeight(x, z);
      if (slopeFlatnessAt(sampleHeight, x, z) < FOREST_MIN_FLATNESS) continue;
      const dens = densityNoise(x, z);
      if (rng() >= dens) continue;

      const rotY = rng() * Math.PI * 2;
      const s = 0.6 + rng() * rng() * 0.7;
      const archetypeIndex = typeof pickArchetypeIndex === 'function'
        ? pickArchetypeIndex(zone, rng)
        : Math.floor(rng() * archetypeCount);

      placements.push({
        x,
        y: y - FOREST_BASE_SINK,
        z,
        rotY,
        scale: s,
        archetypeIndex,
        zoneId: zone.id,
      });
      zonePlaced += 1;
    }
  }

  return placements;
}
