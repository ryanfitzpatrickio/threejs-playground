/**
 * Caps volumetric cloud march reach and fades the composite into level haze /
 * height fog. Fade distances are fractions of the march cap (along-ray metres
 * to the cloud slab), NOT the level viewDistance — the deck sits at ~1200 m.
 */

import { uniform } from 'three/tsl';

/** Max ray distance (m) for the cloud march + hit pass. */
export const uCloudMaxMarchDist = uniform(16000);
/** Along-ray distance (m) where cloud opacity begins falling off. */
export const uCloudFadeStart = uniform(9000);
/** Along-ray distance (m) where clouds are fully dissolved into haze. */
export const uCloudFadeEnd = uniform(15000);
/** Height-fog march cap (m) — used for horizon haze tint strength. */
export const uCloudFogMaxDistance = uniform(165);

/**
 * @param {object} [opts]
 * @param {number} [opts.viewDistance] level / camera far (metres)
 * @param {number} [opts.fogMaxDistance] height-fog march cap (metres)
 * @param {object} [opts.environmentPreset] quality environment block
 */
export function syncCloudReach({
  viewDistance = 370,
  fogMaxDistance = 165,
  environmentPreset = {},
} = {}) {
  const vd = Number.isFinite(viewDistance) && viewDistance > 0 ? viewDistance : 370;
  const fogMax = Number.isFinite(fogMaxDistance) && fogMaxDistance > 0 ? fogMaxDistance : 165;
  const vc = environmentPreset.volumetricClouds ?? {};
  const reachScale = vc.reachScale ?? 2.15;
  // fadeStart/End are fractions of the march cap (0..1), not viewDistance.
  const fadeStartFrac = vc.fadeStart ?? 0.52;
  const fadeEndFrac = vc.fadeEnd ?? 0.94;
  const marchCap = vc.maxMarchDist ?? Math.min(Math.ceil(vd * reachScale), 22000);

  uCloudMaxMarchDist.value = marchCap;
  uCloudFadeStart.value = marchCap * fadeStartFrac;
  uCloudFadeEnd.value = marchCap * fadeEndFrac;
  uCloudFogMaxDistance.value = fogMax;
}
