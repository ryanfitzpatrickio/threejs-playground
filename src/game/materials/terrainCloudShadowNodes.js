import { clamp, float, mix, texture, vec2 } from 'three/tsl';
import {
  terrainCloudShadowCenter,
  terrainCloudShadowEnabled,
  terrainCloudShadowExtent,
  terrainCloudShadowIntensity,
  terrainCloudShadowMap,
} from '../systems/terrainCloudShadowUniforms.js';

/**
 * @param {import('three').Node<vec3>} color
 * @param {import('three').Node<vec2>} worldXZ positionWorld.xz
 */
export function applyTerrainCloudShadow(color, worldXZ) {
  const mapUv = worldXZ.sub(terrainCloudShadowCenter).div(terrainCloudShadowExtent).mul(0.5).add(0.5);
  const transmission = texture(terrainCloudShadowMap, clamp(mapUv, 0.01, 0.99)).r;
  const shadow = mix(float(1), transmission, terrainCloudShadowIntensity.mul(terrainCloudShadowEnabled));
  return color.mul(shadow);
}
