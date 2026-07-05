// officeWallMaterial.js — P2 parallax-occlusion wall relief for office interiors
// (docs/office-interior-wfc-plan.md). Walls seen at grazing angles are exactly
// where POM earns its keep (a flat road was its weakest case — [[silhouette-pom-plan]]).
//
// A shared MeshStandardNodeMaterial that marches a procedural paneled-concrete
// height field (baked once to a DataTexture, the mud-field pattern) so the wall
// grooves self-occlude and parallax-shift with the view. Gated behind the same
// `parallaxOcclusion` quality flag as the rally roads (ultra); off elsewhere the
// interior falls back to the plain wall material.

const INTERIOR_WALL_SCALE = 0.038;
import * as THREE from 'three';
import { color, float, mix } from 'three/tsl';
import { getQualityPreset, getQualityLevel } from '../../config/qualityPresets.js';
import {
  createOfficePackedReliefMaterial,
  officeWallUV,
} from './officeContemporaryMaterials.js';

/**
 * Build the POM wall node material for a given quality preset. Exported for
 * testing; production goes through the cached getOfficeWallMaterial().
 */
export function createOfficeWallMaterial(preset = {}) {
  const scaleValue = preset.interiorWallScale ?? INTERIOR_WALL_SCALE;
  return createOfficePackedReliefMaterial({
    kind: 'wall',
    uvNode: officeWallUV(),
    scale: scaleValue,
    minLayers: 8,
    maxLayers: 32,
  });
}

export function createOfficeFeatureWallMaterial(preset = {}, accentHex = null) {
  const scaleValue = preset.interiorWallScale ?? 0.03;
  const mat = createOfficePackedReliefMaterial({
    kind: 'featureWall',
    uvNode: officeWallUV(),
    scale: scaleValue,
    minLayers: 8,
    maxLayers: 28,
  });
  if (accentHex != null) {
    const accent = new THREE.Color(accentHex);
    mat.colorNode = mix(mat.colorNode, color(accent), float(0.38));
  }
  return mat;
}

let cached;
const cachedFeature = new Map();

// Cached POM wall material for the active quality; null when POM is disabled
// (low/high) so the interior factory falls back to plain walls. Under node
// (no document) the DataTexture/material still construct fine.
export function getOfficeWallMaterial() {
  if (cached !== undefined) return cached;
  const preset = getQualityPreset(getQualityLevel());
  cached = preset.parallaxOcclusion?.enabled ? createOfficeWallMaterial(preset) : null;
  return cached;
}

export function getOfficeFeatureWallMaterial(accentHex = null) {
  const key = accentHex ?? 'default';
  if (cachedFeature.has(key)) return cachedFeature.get(key);
  const preset = getQualityPreset(getQualityLevel());
  const mat = preset.parallaxOcclusion?.enabled
    ? createOfficeFeatureWallMaterial(preset, accentHex)
    : null;
  cachedFeature.set(key, mat);
  return mat;
}
