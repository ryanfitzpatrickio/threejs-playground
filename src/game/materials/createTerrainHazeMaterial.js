/**
 * Unlit haze material for far-field terrain fakes (parallax cylinders, horizon
 * skirt). Must NOT use MeshStandardNodeMaterial — PBR + clip shadows reads as
 * flat black silhouettes at the load edge.
 */

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  cameraPosition,
  float,
  Fn,
  mix,
  mx_noise_float,
  positionWorld,
  smoothstep,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import {
  terrainAerialStart,
  terrainFadeRadius,
  terrainHazeColor,
  terrainLoadedReach,
  terrainNightFactor,
} from '../systems/terrainAerialUniforms.js';
import { uCloudAmbientColor } from '../render/cloud/cloudUniforms.js';
import { terrainParallaxWind } from '../systems/terrainParallaxUniforms.js';

/**
 * @param {object} [opts]
 * @param {number} [opts.noiseScale]
 * @param {number} [opts.alpha]
 * @param {number} [opts.heightFade] soften top/bottom of vertical extent (0..1)
 */
export function createTerrainHazeMaterial({
  noiseScale = 0.0014,
  alpha = 0.22,
  heightFade = 0.55,
} = {}) {
  const material = new MeshBasicNodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.BackSide;
  material.fog = true;

  material.colorNode = Fn(() => {
    const dist = positionWorld.xz.sub(cameraPosition.xz).length();
    // Only contribute beyond the loaded chunk ring — never over near terrain.
    const farBand = smoothstep(
      terrainLoadedReach.mul(0.68),
      terrainLoadedReach.mul(0.94),
      dist,
    );
    const windUv = positionWorld.xz
      .mul(float(noiseScale))
      .add(vec2(terrainParallaxWind, terrainParallaxWind.mul(0.31)));
    const ridge = mx_noise_float(windUv).mul(0.5).add(0.5);
    const v = uv().y;
    const hill = smoothstep(float(0.08), float(0.55), v)
      .mul(float(1).sub(smoothstep(float(0.72), float(0.98), v)));
    const silhouette = hill.mul(ridge.mul(0.35).add(0.65));
    // Vertical gradient: grey ground haze → sky blue higher up (not blue all the way down).
    const groundGrey = mix(vec3(0.62, 0.63, 0.64), terrainHazeColor, float(0.85));
    const skyBlue = mix(terrainHazeColor, uCloudAmbientColor, float(0.72));
    const heightTone = mix(groundGrey, skyBlue, smoothstep(float(0.22), float(0.9), v));
    const night = vec3(0.4, 0.44, 0.52);
    const tone = mix(heightTone, night, terrainNightFactor.mul(0.5));
    const heightMask = smoothstep(float(0), float(heightFade), v).mul(
      float(1).sub(smoothstep(float(1).sub(heightFade), float(1), v)),
    );
    const aerial = smoothstep(terrainAerialStart, terrainFadeRadius, dist);
    const a = silhouette
      .mul(float(alpha))
      .mul(farBand)
      .mul(heightMask)
      .mul(aerial.mul(0.55).add(0.45));
    return vec4(tone, a);
  })();

  return material;
}
