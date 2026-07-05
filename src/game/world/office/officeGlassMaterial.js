// Tiered frosted glass and architectural finish materials for office interiors.

import * as THREE from 'three';
import { MeshPhysicalNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';
import {
  color,
  float,
  mix,
  normalMap,
  normalView,
  positionLocal,
  positionViewDirection,
  sin,
  smoothstep,
  vec3,
} from 'three/tsl';
import { getQualityLevel } from '../../config/qualityPresets.js';

const cache = new Map();

function qualityTier(requested) {
  return requested ?? getQualityLevel();
}

export function createOfficeGlassMaterial({ quality = 'high', insert = false } = {}) {
  const ultra = quality === 'ultra';
  const material = new MeshPhysicalNodeMaterial({
    transparent: true,
    opacity: insert ? 0.66 : 0.48,
    depthWrite: false,
    side: THREE.DoubleSide,
    roughness: insert ? 0.58 : (ultra ? 0.42 : 0.46),
    metalness: 0,
    ior: 1.45,
    transmission: ultra ? 0.55 : 0,
    thickness: ultra ? 0.28 : 0,
  });
  const fresnel = float(1).sub(normalView.dot(positionViewDirection).abs()).pow(4);
  const frostBand = smoothstep(float(0.9), float(1.5), positionLocal.y)
    .mul(smoothstep(float(2.4), float(1.6), positionLocal.y));
  const frostTint = mix(color(0xe9f1f0), color(0xd8e4e8), frostBand.mul(0.85));
  const baseTint = mix(color(insert ? 0xdce8e8 : 0xa8c1c6), frostTint, float(0.55));
  material.colorNode = mix(baseTint, color(0xe9f1f0), fresnel.mul(0.62));
  const grainA = sin(positionLocal.x.mul(83).add(positionLocal.y.mul(137))).mul(0.018);
  const grainB = sin(positionLocal.z.mul(113).sub(positionLocal.y.mul(71))).mul(0.018);
  const frostGrain = frostBand.mul(0.04);
  material.normalNode = normalMap(vec3(
    grainA.add(frostGrain),
    grainB.add(frostGrain),
    float(1),
  ).normalize().mul(0.5).add(0.5));
  material.userData.officeGlass = true;
  material.userData.officeGlassTier = ultra ? 'transmission' : 'fresnel';
  material.userData.officeGlassInsert = insert;
  return material;
}

export function createOfficeAluminumMaterial() {
  const material = new MeshStandardNodeMaterial();
  const brush = sin(positionLocal.y.mul(310).add(positionLocal.x.mul(17))).mul(0.035);
  material.colorNode = color(0x252a2f).mul(float(0.96).add(brush));
  material.roughnessNode = float(0.38).add(brush.abs().mul(0.6));
  material.metalnessNode = float(0.86);
  material.userData.officeAluminum = true;
  return material;
}

export function createOfficeDoorMaterial() {
  const material = new MeshStandardNodeMaterial();
  const grain = sin(positionLocal.y.mul(36).add(sin(positionLocal.x.mul(9)).mul(2))).mul(0.055);
  material.colorNode = color(0x34302c).mul(float(0.92).add(grain));
  material.roughnessNode = float(0.58).sub(grain.mul(0.35));
  material.metalnessNode = float(0.02);
  material.userData.officeDoorFinish = 'matte-wood-laminate';
  return material;
}

export function getOfficeGlassMaterial({ quality, insert = false } = {}) {
  const tier = qualityTier(quality);
  const key = `glass|${tier}|${insert}`;
  if (!cache.has(key)) cache.set(key, createOfficeGlassMaterial({ quality: tier, insert }));
  return cache.get(key);
}

export function getOfficeAluminumMaterial() {
  if (!cache.has('aluminum')) cache.set('aluminum', createOfficeAluminumMaterial());
  return cache.get('aluminum');
}

export function getOfficeDoorMaterial() {
  if (!cache.has('door')) cache.set('door', createOfficeDoorMaterial());
  return cache.get('door');
}
