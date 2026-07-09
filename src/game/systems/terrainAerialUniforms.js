/**
 * terrainAerialUniforms.js
 *
 * Shared TSL uniforms for distance-based terrain aerial perspective (desaturation,
 * contrast rolloff, horizon haze tint). Written from the active quality preset and
 * the live level view distance; CloudSkyProvider may refresh `terrainHazeColor`
 * from the LUT sky ambient when volumetric clouds are active.
 */

import * as THREE from 'three';
import { uniform } from 'three/tsl';
import { normalizeAerialHazeColor } from '../config/photorealismPresets.js';
import { getSkyDaylightFactor } from './SkySystem.js';
import { uCloudAmbientColor } from '../render/cloud/cloudUniforms.js';

export const terrainAerialEnabled = uniform(1);
/** Horizontal fade distances (metres) — synced from level viewDistance. */
export const terrainAerialStart = uniform(70);
export const terrainAerialEnd = uniform(200);
export const terrainFadeRadius = uniform(220);
export const terrainLoadedReach = uniform(200);
export const terrainAerialStrength = uniform(1);
export const terrainAerialDesat = uniform(0.72);
export const terrainAerialContrast = uniform(0.48);
export const terrainHazeColor = uniform(new THREE.Color(0.62, 0.72, 0.78));
/** 0 = full day, 1 = full night — scales distant haze toward moonlit blue-grey. */
export const terrainNightFactor = uniform(0);

/**
 * Keep terrain haze aligned with the active sky (dome hemisphere or volumetric).
 * @param {import('./SkySystem.js').SkySystem | null} skySystem
 * @param {object} [environmentPreset]
 */
export function syncTerrainAtmosphereFromSky(skySystem, environmentPreset = {}) {
  syncTerrainAerialUniforms(environmentPreset);
  const timeOfDay = skySystem?.timeOfDay ?? environmentPreset.timeOfDay ?? 0.72;
  terrainNightFactor.value = 1 - getSkyDaylightFactor(timeOfDay);

  const haze = normalizeAerialHazeColor(environmentPreset.aerialHazeColor);
  terrainHazeColor.value.setRGB(haze[0], haze[1], haze[2]);
  if (skySystem?.provider) {
    terrainHazeColor.value.copy(uCloudAmbientColor.value);
  } else if (skySystem?.hemisphere) {
    const sky = new THREE.Color();
    skySystem.hemisphere.color.getRGB(sky);
    terrainHazeColor.value.lerp(sky, 0.42);
  }
}

/**
 * Push quality-preset aerial values into the terrain material uniforms.
 * @param {object} [environmentPreset]
 */
export function syncTerrainAerialUniforms(environmentPreset = {}) {
  const enabled = environmentPreset.aerialPerspective !== false && environmentPreset.terrainAerial !== false;
  terrainAerialEnabled.value = enabled ? 1 : 0;

  const terrain = environmentPreset.terrainAerial ?? {};
  terrainAerialStrength.value = terrain.strength ?? 1;
  terrainAerialDesat.value = terrain.desat ?? 0.72;
  terrainAerialContrast.value = terrain.contrast ?? 0.48;

  const haze = normalizeAerialHazeColor(environmentPreset.aerialHazeColor);
  terrainHazeColor.value.setRGB(haze[0], haze[1], haze[2]);
}

/**
 * Key material fade distances to the loaded terrain / camera far plane.
 * Post aerial uses kilometre-scale defaults that never reach a ~200 m far plane;
 * the terrain shader must fade inside the actual view distance.
 *
 * @param {number} viewDistance camera far / guaranteed terrain reach (metres)
 * @param {object} [environmentPreset]
 */
export function syncTerrainViewDistance(viewDistance, environmentPreset = {}) {
  if (!Number.isFinite(viewDistance) || viewDistance <= 0) return;
  syncTerrainAerialUniforms(environmentPreset);

  const terrain = environmentPreset.terrainAerial ?? {};
  const fadeEnd = terrain.fadeEnd ?? viewDistance * 0.94;
  const fadeStart = terrain.fadeStart ?? viewDistance * 0.38;
  terrainFadeRadius.value = viewDistance;
  terrainLoadedReach.value = environmentPreset.terrainReach ?? viewDistance * 0.91;
  terrainAerialStart.value = Math.max(48, fadeStart);
  terrainAerialEnd.value = Math.max(terrainAerialStart.value + 40, fadeEnd);
}
