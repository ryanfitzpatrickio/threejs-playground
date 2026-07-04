// officeWallMaterial.js — P2 parallax-occlusion wall relief for office interiors
// (docs/office-interior-wfc-plan.md). Walls seen at grazing angles are exactly
// where POM earns its keep (a flat road was its weakest case — [[silhouette-pom-plan]]).
//
// A shared MeshStandardNodeMaterial that marches a procedural paneled-concrete
// height field (baked once to a DataTexture, the mud-field pattern) so the wall
// grooves self-occlude and parallax-shift with the view. Gated behind the same
// `parallaxOcclusion` quality flag as the rally roads (ultra); off elsewhere the
// interior falls back to the plain wall material.

import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  uv, vec2, vec3, float, textureLevel, normalize, normalMap, mix, color,
} from 'three/tsl';
import { parallaxOcclusionUV } from '../../../three-addons/tsl/utils/ParallaxOcclusion.js';
import { getQualityPreset, getQualityLevel } from '../../config/qualityPresets.js';

// Procedural paneled-concrete height: vertical panel joints + horizontal reveals
// + a little grain. Red channel is the height POM marches (white = proud).
function makeWallHeightTexture(size = 256) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      let h = 1.0;
      const gx = (u * 6) % 1; // 6 vertical panels across the tile
      if (gx < 0.05 || gx > 0.95) h -= 0.55; // panel joints
      const gy = (v * 3) % 1; // 3 horizontal reveals
      if (gy < 0.045) h -= 0.35;
      const n = (Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1;
      h += (n - 0.5) * 0.08; // fine grain
      h = Math.max(0, Math.min(1, h));
      const i = (y * size + x) * 4;
      const val = Math.round(h * 255);
      data[i] = val; data[i + 1] = val; data[i + 2] = val; data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Build the POM wall node material for a given quality preset. Exported for
 * testing; production goes through the cached getOfficeWallMaterial().
 */
export function createOfficeWallMaterial(preset = {}) {
  const scaleValue = preset.parallaxOcclusion?.scale ?? 0.03;
  const heightTex = makeWallHeightTexture();
  const tiles = vec2(3, 2);
  const uvNode = uv().mul(tiles);
  const scale = float(scaleValue);
  const base = color(0xcdcdd2);
  const opts = { uvNode, scale, minLayers: 8, maxLayers: 24, silhouette: false };

  const material = new MeshStandardNodeMaterial();
  material.side = THREE.DoubleSide;

  // Colour: darken in the parallax-marched grooves.
  const pom = parallaxOcclusionUV(heightTex, opts);
  material.colorNode = base.mul(mix(float(0.5), float(1.0), pom.sample(heightTex).r));
  material.roughnessNode = float(0.9);
  material.metalnessNode = float(0);

  // Normal: a dedicated POM call (addon requires its own sub-build), then a
  // central-difference bump from the height at the marched UV. textureLevel at
  // LOD 0 (not sample()) per the addon's normal-pass guidance.
  const pomN = parallaxOcclusionUV(heightTex, opts);
  const uc = pomN.uv;
  const e = float(1 / 256);
  const hL = textureLevel(heightTex, vec2(uc.x.sub(e), uc.y), 0).r;
  const hR = textureLevel(heightTex, vec2(uc.x.add(e), uc.y), 0).r;
  const hD = textureLevel(heightTex, vec2(uc.x, uc.y.sub(e)), 0).r;
  const hU = textureLevel(heightTex, vec2(uc.x, uc.y.add(e)), 0).r;
  const strength = float(2.5);
  const tangentNormal = normalize(vec3(hL.sub(hR).mul(strength), hD.sub(hU).mul(strength), float(1)));
  material.normalNode = normalMap(tangentNormal.mul(0.5).add(0.5));

  return material;
}

let cached;

// Cached POM wall material for the active quality; null when POM is disabled
// (low/high) so the interior factory falls back to plain walls. Under node
// (no document) the DataTexture/material still construct fine.
export function getOfficeWallMaterial() {
  if (cached !== undefined) return cached;
  const preset = getQualityPreset(getQualityLevel());
  cached = preset.parallaxOcclusion?.enabled ? createOfficeWallMaterial(preset) : null;
  return cached;
}
