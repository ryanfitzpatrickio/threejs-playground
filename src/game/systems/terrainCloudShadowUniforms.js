/**
 * Optional volumetric cloud shadow map projected onto terrain (ultra + LUT sky).
 * GameRuntime binds the live CloudShadowNode texture each frame when available.
 */

import * as THREE from 'three';
import { texture, uniform } from 'three/tsl';

const placeholder = /*@__PURE__*/ new THREE.DataTexture(
  new Uint8Array([255, 255, 255, 255]),
  1,
  1,
);
placeholder.needsUpdate = true;

export const terrainCloudShadowEnabled = uniform(0);
export const terrainCloudShadowCenter = uniform(new THREE.Vector2());
export const terrainCloudShadowExtent = uniform(3200);
export const terrainCloudShadowIntensity = uniform(0.58);
// TextureNode (not uniform(texture)) — TSL texture() rejects generic uniforms.
export const terrainCloudShadowMap = texture(placeholder);

/**
 * @param {{texture?:import('three').Texture, projection?:object}|null} cloudShadow
 */
export function syncTerrainCloudShadow(cloudShadow = null) {
  if (!cloudShadow?.texture) {
    terrainCloudShadowEnabled.value = 0;
    terrainCloudShadowMap.value = placeholder;
    return;
  }
  const proj = cloudShadow.projection ?? {};
  terrainCloudShadowEnabled.value = proj.enabled?.value ?? 1;
  terrainCloudShadowCenter.value.copy(proj.center?.value ?? terrainCloudShadowCenter.value);
  terrainCloudShadowExtent.value = proj.extent?.value ?? terrainCloudShadowExtent.value;
  terrainCloudShadowIntensity.value = proj.intensity?.value ?? terrainCloudShadowIntensity.value;
  const tex = cloudShadow.texture.value ?? cloudShadow.texture;
  if (tex?.isTexture) terrainCloudShadowMap.value = tex;
}
