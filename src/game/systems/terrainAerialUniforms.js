/**
 * terrainAerialUniforms.js
 *
 * Shared TSL uniforms for distance-based terrain aerial perspective (desaturation,
 * contrast rolloff, horizon haze tint). Written from the active quality preset and
 * the live level view distance.
 *
 * Ground haze is deliberately greyer than zenith sky blue: distant terrain should
 * desaturate into neutral atmospheric haze, with blue reserved for the sky dome
 * (and a light cool cast only). Copying sky ambient onto the ground made mid/far
 * landscape read as painted blue.
 */

import * as THREE from 'three';
import { uniform } from 'three/tsl';
import { normalizeAerialHazeColor } from '../config/photorealismPresets.js';
import { getSkyDaylightFactor } from './SkySystem.js';
import { systemWrite } from '../debug/shaderDebugRegistry.js';

/** Neutral cool-grey default — not zenith sky blue. */
const DEFAULT_GROUND_HAZE = [0.58, 0.60, 0.62];

export const terrainAerialEnabled = uniform(1);
/** Horizontal fade distances (metres) — synced from level viewDistance. */
export const terrainAerialStart = uniform(70);
export const terrainAerialEnd = uniform(200);
export const terrainFadeRadius = uniform(220);
export const terrainLoadedReach = uniform(200);
export const terrainAerialStrength = uniform(1);
export const terrainAerialDesat = uniform(0.72);
export const terrainAerialContrast = uniform(0.48);
export const terrainHazeColor = uniform(new THREE.Color(...DEFAULT_GROUND_HAZE));
/** 0 = full day, 1 = full night — scales distant haze toward moonlit blue-grey. */
export const terrainNightFactor = uniform(0);

const _skyScratch = new THREE.Color();
const _groundScratch = new THREE.Color();

/**
 * Soft cool-grey derived from sky + ground hemisphere colors without becoming sky blue.
 * @param {THREE.Color} target
 * @param {THREE.Color} sky
 * @param {THREE.Color} ground
 */
function applyHorizonGreyHaze(target, sky, ground) {
  // Path-radiance style: mostly luminance, slight cool cast from sky, warm from ground.
  const skyLum = sky.r * 0.299 + sky.g * 0.587 + sky.b * 0.114;
  const groundLum = ground.r * 0.299 + ground.g * 0.587 + ground.b * 0.114;
  const lum = skyLum * 0.55 + groundLum * 0.45;
  target.setRGB(
    THREE.MathUtils.clamp(lum * 0.96 + sky.r * 0.08 + ground.r * 0.04, 0, 1),
    THREE.MathUtils.clamp(lum * 0.98 + sky.g * 0.07 + ground.g * 0.04, 0, 1),
    THREE.MathUtils.clamp(lum * 1.02 + sky.b * 0.10 + ground.b * 0.03, 0, 1),
  );
}

/**
 * Keep terrain haze aligned with the active sky (dome hemisphere or volumetric).
 * @param {import('./SkySystem.js').SkySystem | null} skySystem
 * @param {object} [environmentPreset]
 */
export function syncTerrainAtmosphereFromSky(skySystem, environmentPreset = {}) {
  syncTerrainAerialUniforms(environmentPreset);
  const timeOfDay = skySystem?.timeOfDay ?? environmentPreset.timeOfDay ?? 0.72;
  // nightFactor is sim-derived; not user-pinnable (monitor only if registered).
  terrainNightFactor.value = 1 - getSkyDaylightFactor(timeOfDay);

  systemWrite('aerial.hazeColor', () => {
    const haze = normalizeAerialHazeColor(environmentPreset.aerialHazeColor, DEFAULT_GROUND_HAZE);
    terrainHazeColor.value.setRGB(haze[0], haze[1], haze[2]);
    // Mild live re-key from hemisphere (grey horizon, not full sky blue).
    if (skySystem?.hemisphere) {
      skySystem.hemisphere.color.getRGB(_skyScratch);
      skySystem.hemisphere.groundColor.getRGB(_groundScratch);
      applyHorizonGreyHaze(_skyScratch, _skyScratch, _groundScratch);
      terrainHazeColor.value.lerp(_skyScratch, 0.28);
    }
  });
}

/**
 * Push quality-preset aerial values into the terrain material uniforms.
 * @param {object} [environmentPreset]
 */
export function syncTerrainAerialUniforms(environmentPreset = {}) {
  const enabled = environmentPreset.aerialPerspective !== false && environmentPreset.terrainAerial !== false;
  systemWrite('aerial.enabled', () => {
    terrainAerialEnabled.value = enabled ? 1 : 0;
  });

  const terrain = environmentPreset.terrainAerial ?? {};
  systemWrite('aerial.strength', () => {
    terrainAerialStrength.value = terrain.strength ?? 0.85;
  });
  systemWrite('aerial.desat', () => {
    terrainAerialDesat.value = terrain.desat ?? 0.55;
  });
  systemWrite('aerial.contrast', () => {
    terrainAerialContrast.value = terrain.contrast ?? 0.35;
  });

  systemWrite('aerial.hazeColor', () => {
    const haze = normalizeAerialHazeColor(environmentPreset.aerialHazeColor, DEFAULT_GROUND_HAZE);
    terrainHazeColor.value.setRGB(haze[0], haze[1], haze[2]);
  });
}

/**
 * Key material fade distances to the loaded terrain / camera far plane.
 * Horizon melt should only read on the outer ring — mid-field terrain keeps
 * its albedo. Defaults used to start at ~38% of view distance and washed
 * mountains white well before the load edge.
 *
 * @param {number} viewDistance camera far / guaranteed terrain reach (metres)
 * @param {object} [environmentPreset]
 */
export function syncTerrainViewDistance(viewDistance, environmentPreset = {}) {
  if (!Number.isFinite(viewDistance) || viewDistance <= 0) return;
  syncTerrainAerialUniforms(environmentPreset);

  const terrain = environmentPreset.terrainAerial ?? {};
  // Late start / late end: only the furthest terrain blends into horizon haze.
  const fadeEnd = terrain.fadeEnd ?? viewDistance * 0.97;
  const fadeStart = terrain.fadeStart ?? viewDistance * 0.78;
  // Reach helpers track the live view distance (sim); not debug-pinned.
  terrainFadeRadius.value = viewDistance;
  terrainLoadedReach.value = environmentPreset.terrainReach ?? viewDistance * 0.94;
  systemWrite('aerial.start', () => {
    terrainAerialStart.value = Math.max(120, fadeStart);
  });
  systemWrite('aerial.end', () => {
    terrainAerialEnd.value = Math.max(terrainAerialStart.value + 80, fadeEnd);
  });
}
