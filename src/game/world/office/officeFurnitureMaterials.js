// officeFurnitureMaterials.js — POM relief materials for furniture (when POM enabled).

import * as THREE from 'three';
import { getQualityLevel, getQualityPreset } from '../../config/qualityPresets.js';
import { createOfficePackedReliefMaterial } from './officeContemporaryMaterials.js';

const cache = new Map();

const FALLBACK = {
  desk: new THREE.MeshStandardMaterial({ color: 0x6d5a42, roughness: 0.7, metalness: 0.05 }),
  table: new THREE.MeshStandardMaterial({ color: 0x3c3c44, roughness: 0.5, metalness: 0.15 }),
  coffee: new THREE.MeshStandardMaterial({ color: 0x3a3028, roughness: 0.65, metalness: 0.05 }),
  monitor: new THREE.MeshStandardMaterial({
    color: 0x1a1a22, roughness: 0.35, metalness: 0.2,
    emissive: 0x3a6a8a, emissiveIntensity: 1.1,
  }),
  tv: new THREE.MeshStandardMaterial({
    color: 0x12141a, roughness: 0.4, metalness: 0.15,
    emissive: 0x3a6a8a, emissiveIntensity: 1.0,
  }),
};

function pomMaterial(kind, scale) {
  const key = `${kind}|${scale}`;
  if (cache.has(key)) return cache.get(key);
  const mat = createOfficePackedReliefMaterial({ kind, scale, minLayers: 6, maxLayers: 20 });
  cache.set(key, mat);
  return mat;
}

export function getOfficeFurnitureMaterials(buildOnly = false) {
  if (buildOnly) return { ...FALLBACK };
  const preset = getQualityPreset(getQualityLevel());
  if (!preset.parallaxOcclusion?.enabled) return { ...FALLBACK };
  return {
    desk: pomMaterial('terrazzo', 0.022),
    table: pomMaterial('wall', 0.028),
    coffee: pomMaterial('terrazzo', 0.024),
    monitor: FALLBACK.monitor,
    tv: FALLBACK.tv,
  };
}
