/**
 * Block scene.environment IBL on matte outdoor surfaces.
 *
 * In Three.js TSL, `material.envMapIntensity` only applies when `material.envMap`
 * is set; otherwise `scene.environmentIntensity` is used and envMapIntensity is
 * ignored. V-Rally-style exteriors skipped sky IBL on ground — Fresnel still
 * picks up a pale grazing sheen from a bright env map even at roughness 0.95.
 */
import * as THREE from 'three';
import { vec3 } from 'three/tsl';

let blackEnvironmentMap = null;

function getBlackEnvironmentMap() {
  if (blackEnvironmentMap) return blackEnvironmentMap;
  const data = new Uint8Array([0, 0, 0]);
  const faces = Array.from({ length: 6 }, () => {
    const face = new THREE.DataTexture(data, 1, 1, THREE.RGBFormat);
    face.needsUpdate = true;
    return face;
  });
  blackEnvironmentMap = new THREE.CubeTexture(faces);
  blackEnvironmentMap.needsUpdate = true;
  return blackEnvironmentMap;
}

/** @param {import('three').Material} material */
export function disablePbrEnvironment(material) {
  if (!material) return material;
  if (material.isNodeMaterial) {
    material.envNode = vec3(0);
  } else {
    material.envMap = getBlackEnvironmentMap();
    material.envMapIntensity = 0;
  }
  return material;
}
