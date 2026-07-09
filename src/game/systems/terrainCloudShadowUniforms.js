/**
 * Optional volumetric cloud shadow map projected onto terrain (ultra + LUT sky).
 * GameRuntime binds the live CloudShadowNode texture each frame when available.
 *
 * Dual-source policy (shader-debug PR3):
 * - Extent: source of truth is CloudShadowNode.projection.extent (`shadow.extent`).
 *   Frame sync ALWAYS copies node → terrainCloudShadowExtent (no pin skip on the
 *   terrain copy — UVs must match the shadow map RT).
 * - Intensity: pin lives on terrainCloudShadowIntensity (`shadow.intensity`) via
 *   systemWrite; freezes terrain darkening.
 * - Center: camera-follow sim — never user-pinnable.
 */

import * as THREE from 'three';
import { texture, uniform } from 'three/tsl';
import { systemWrite } from '../debug/shaderDebugRegistry.js';

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
  // Center is sim (camera follow) — always stamp.
  terrainCloudShadowCenter.value.copy(proj.center?.value ?? terrainCloudShadowCenter.value);
  // Extent: ALWAYS mirror source node → terrain UV scale (no systemWrite skip).
  // Pin lives on CloudShadowNode.projection.extent (registry id shadow.extent).
  if (proj.extent?.value != null) {
    terrainCloudShadowExtent.value = proj.extent.value;
  }
  // Intensity: pin freezes terrain darkening only.
  systemWrite('shadow.intensity', () => {
    terrainCloudShadowIntensity.value = proj.intensity?.value ?? terrainCloudShadowIntensity.value;
  });
  const tex = cloudShadow.texture.value ?? cloudShadow.texture;
  if (tex?.isTexture) terrainCloudShadowMap.value = tex;
}
