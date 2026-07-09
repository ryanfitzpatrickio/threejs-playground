/**
 * Low-frequency macro variation for terrain (TSL). Fades in with horizontal
 * view distance so distant hills read alive without extra geometry.
 */

import { float, mx_noise_float, smoothstep, vec3 } from 'three/tsl';
import { terrainAerialStart, terrainFadeRadius } from '../systems/terrainAerialUniforms.js';

/**
 * @param {import('three').Node<vec2>} worldXZ positionWorld.xz
 * @param {import('three').Node<float>} horizontalDist distance from camera (XZ)
 * @param {{frequency?:number, colorStrength?:number, enabled?:boolean}} [opts]
 */
export function applyTerrainMacroTint(color, worldXZ, horizontalDist, opts = {}) {
  if (opts.enabled === false) return color;
  const frequency = opts.frequency ?? 0.0045;
  const colorStrength = opts.colorStrength ?? 0.14;
  const macro = mx_noise_float(worldXZ.mul(float(frequency)))
    .mul(0.5)
    .add(0.5);
  const macroWeight = smoothstep(
    terrainAerialStart,
    terrainFadeRadius.mul(0.82),
    horizontalDist,
  ).mul(float(colorStrength));
  const macroTint = vec3(0.92, 0.96, 1.02).mul(macro.mul(0.22).add(0.89));
  return color.mul(float(1).sub(macroWeight)).add(macroTint.mul(macroWeight));
}
