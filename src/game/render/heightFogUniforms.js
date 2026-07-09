/**
 * Module-scope TSL uniforms for volumetric height fog (RendererSystem).
 *
 * Density scale, alpha clamp, and street/high fog colors are live-tweakable.
 * fogMarchSteps stays structural (Loop count) — not registered as a slider.
 *
 * Defaults match createHeightFogOutputNode literals for haze [0.54, 0.62, 0.59].
 */

import * as THREE from 'three';
import { uniform } from 'three/tsl';
import { systemWrite } from '../debug/shaderDebugRegistry.js';

/** Multiplier on per-step density (was hard-coded 0.117). */
export const uHeightFogDensityScale = uniform(0.117);
/** Max fog alpha clamp (was hard-coded 0.68). */
export const uHeightFogAlphaMax = uniform(0.68);

const DEFAULT_HAZE = [0.54, 0.62, 0.59];

export const uHeightFogStreetColor = uniform(new THREE.Color(
  DEFAULT_HAZE[0] * 0.92,
  DEFAULT_HAZE[1] * 0.94,
  DEFAULT_HAZE[2] * 0.96,
));
export const uHeightFogHighColor = uniform(new THREE.Color(
  DEFAULT_HAZE[0] * 1.08 + 0.12,
  DEFAULT_HAZE[1] * 1.1 + 0.14,
  DEFAULT_HAZE[2] * 1.12 + 0.14,
));

/**
 * Derive street/high fog colors from a haze RGB triple (pipeline build / haze sync).
 * Respects user pins via systemWrite.
 * @param {number[]|{r:number,g:number,b:number}} hazeColor
 */
export function syncHeightFogColorsFromHaze(hazeColor = DEFAULT_HAZE) {
  let r;
  let g;
  let b;
  if (Array.isArray(hazeColor)) {
    r = hazeColor[0] ?? DEFAULT_HAZE[0];
    g = hazeColor[1] ?? DEFAULT_HAZE[1];
    b = hazeColor[2] ?? DEFAULT_HAZE[2];
  } else if (hazeColor && typeof hazeColor === 'object') {
    r = hazeColor.r ?? DEFAULT_HAZE[0];
    g = hazeColor.g ?? DEFAULT_HAZE[1];
    b = hazeColor.b ?? DEFAULT_HAZE[2];
  } else {
    [r, g, b] = DEFAULT_HAZE;
  }

  systemWrite('fog.streetColor', () => {
    uHeightFogStreetColor.value.setRGB(r * 0.92, g * 0.94, b * 0.96);
  });
  systemWrite('fog.highColor', () => {
    uHeightFogHighColor.value.setRGB(r * 1.08 + 0.12, g * 1.1 + 0.14, b * 1.12 + 0.14);
  });
}
