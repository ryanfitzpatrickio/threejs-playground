// officeContemporaryMaterials.js — deterministic packed relief surfaces for the
// WFC office kit. R = height, G = emissive accent, B = material/tone selector.

import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  color,
  float,
  mix,
  normalMap,
  normalize,
  positionLocal,
  positionWorld,
  normalLocal,
  abs,
  textureLevel,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { parallaxOcclusionUV } from '../../../three-addons/tsl/utils/ParallaxOcclusion.js';
import { getQualityLevel, getQualityPreset } from '../../config/qualityPresets.js';

export const OFFICE_SURFACE_MAP_SIZE = 256;

const mapCache = new Map();
const materialCache = new Map();

function hash2(x, y, seed) {
  let value = Math.imul(x + seed * 1013, 374761393) ^ Math.imul(y + seed * 1619, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function writePixel(data, size, x, y, height, emissive = 0, tone = 0) {
  const offset = (y * size + x) * 4;
  data[offset] = Math.round(THREE.MathUtils.clamp(height, 0, 1) * 255);
  data[offset + 1] = Math.round(THREE.MathUtils.clamp(emissive, 0, 1) * 255);
  data[offset + 2] = Math.round(THREE.MathUtils.clamp(tone, 0, 1) * 255);
  data[offset + 3] = 255;
}

function generateWallMap(data, size) {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const edge = Math.min(u, 1 - u, v, 1 - v);
      const grain = (hash2(x >> 1, y >> 1, 11) - 0.5) * 0.035;
      let height = 0.76 + grain;
      let tone = 0.18 + hash2(x >> 4, y >> 4, 7) * 0.08;
      let emissive = 0;

      // Deep charcoal shadow gap around every architectural module.
      if (edge < 0.025) {
        height = 0.12;
        tone = 0.94;
      } else if (edge < 0.045) {
        height = 0.48;
        tone = 0.82;
      }

      writePixel(data, size, x, y, height, emissive, tone);
    }
  }
}

function generateTerrazzoMap(data, size) {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const seam = Math.min(u, 1 - u, v, 1 - v);
      const noise = hash2(x, y, 47);
      let height = 0.72 + (noise - 0.5) * 0.025;
      let tone = 0.18 + hash2(x >> 5, y >> 5, 19) * 0.12;
      if (seam < 0.012) {
        height = 0.28;
        tone = 0.9;
      } else if (noise > 0.975) {
        height = 0.8 + hash2(x, y, 53) * 0.12;
        tone = 0.42 + hash2(x, y, 59) * 0.42;
      } else if (noise < 0.018) {
        height = 0.66;
        tone = 0.76;
      }
      writePixel(data, size, x, y, height, 0, tone);
    }
  }
}

function generateColumnMap(data, size) {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const flute = (u * 12) % 1;
      const ring = (v * 3) % 1;
      let height = flute < 0.68 ? 0.82 : 0.3;
      let tone = flute < 0.68 ? 0.26 : 0.92;
      let emissive = 0;
      if (ring < 0.035 || ring > 0.965) {
        height = 0.94;
        tone = 0.7;
      }
      if (u > 0.47 && u < 0.53) {
        height = 0.35;
        tone = 0.74;
        emissive = 1;
      }
      writePixel(data, size, x, y, height, emissive, tone);
    }
  }
}

function generateCeilingMap(data, size) {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const edge = Math.min(u, 1 - u, v, 1 - v);
      const pore = hash2(x, y, 83);
      let height = 0.76 + (pore - 0.5) * 0.025;
      let tone = 0.14 + hash2(x >> 4, y >> 4, 89) * 0.08;
      if (edge < 0.022) {
        height = 0.16;
        tone = 0.96;
      } else if (edge < 0.04) {
        height = 0.48;
        tone = 0.68;
      } else if (pore < 0.018) {
        height = 0.66;
        tone = 0.34;
      }
      writePixel(data, size, x, y, height, 0, tone);
    }
  }
}

function generateFeatureWallMap(data, size) {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const groove = Math.min((u * 7) % 1, 1 - ((u * 7) % 1));
      const vein = Math.abs(Math.sin((u * 13 + v * 5 + hash2(x >> 3, y >> 3, 97)) * Math.PI));
      let height = 0.7 + vein * 0.12;
      let tone = 0.82 + vein * 0.14;
      if (groove < 0.035) {
        height = 0.18;
        tone = 0.98;
      }
      writePixel(data, size, x, y, height, 0, tone);
    }
  }
}

export function createOfficePackedSurfaceTexture(kind, size = OFFICE_SURFACE_MAP_SIZE) {
  const data = new Uint8Array(size * size * 4);
  if (kind === 'terrazzo') generateTerrazzoMap(data, size);
  else if (kind === 'column') generateColumnMap(data, size);
  else if (kind === 'ceiling') generateCeilingMap(data, size);
  else if (kind === 'featureWall') generateFeatureWallMap(data, size);
  else generateWallMap(data, size);

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.name = `office-${kind}-packed-relief`;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function getPackedMap(kind) {
  if (!mapCache.has(kind)) mapCache.set(kind, createOfficePackedSurfaceTexture(kind));
  return mapCache.get(kind);
}

const PALETTES = {
  wall: {
    base: 0xeeeeeb,
    accent: 0xd8dcde,
    dark: 0x34393d,
    emissive: 0xffd9a3,
    roughLow: 0.72,
    roughHigh: 0.92,
    metalness: 0.01,
  },
  terrazzo: {
    base: 0xc9c5bb,
    accent: 0x8d9697,
    dark: 0x343a3e,
    emissive: 0xffffff,
    roughLow: 0.48,
    roughHigh: 0.72,
    metalness: 0.02,
  },
  column: {
    base: 0x5e6469,
    accent: 0x9da5a8,
    dark: 0x202429,
    emissive: 0xffc77d,
    roughLow: 0.3,
    roughHigh: 0.64,
    metalness: 0.34,
  },
  ceiling: {
    base: 0xe4e2dc,
    accent: 0xc9c8c3,
    dark: 0x3d4145,
    emissive: 0xffffff,
    roughLow: 0.8,
    roughHigh: 0.97,
    metalness: 0,
  },
  featureWall: {
    base: 0x52575a,
    accent: 0x353b3e,
    dark: 0x161a1d,
    emissive: 0xffffff,
    roughLow: 0.38,
    roughHigh: 0.66,
    metalness: 0.08,
  },
};

export function createOfficePackedReliefMaterial({
  kind = 'wall',
  uvNode = uv(),
  scale = 0.035,
  minLayers = 8,
  maxLayers = 32,
} = {}) {
  const packedMap = getPackedMap(kind);
  const palette = PALETTES[kind] ?? PALETTES.wall;
  const opts = { uvNode, scale: float(scale), minLayers, maxLayers, silhouette: false };
  const pom = parallaxOcclusionUV(packedMap, opts);
  const packed = pom.sample(packedMap);
  const relief = packed.r;
  const glow = packed.g;
  const tone = packed.b;
  const accentMix = tone.smoothstep(0.38, 0.64);
  const darkMix = tone.smoothstep(0.78, 0.94);

  const material = new MeshStandardNodeMaterial();
  let surface = mix(color(palette.base), color(palette.accent), accentMix);
  surface = mix(surface, color(palette.dark), darkMix);
  material.colorNode = surface.mul(mix(float(0.78), float(1.04), relief));
  material.emissiveNode = color(palette.emissive).mul(glow.pow(2)).mul(2.2);
  material.roughnessNode = mix(float(palette.roughHigh), float(palette.roughLow), relief);
  material.metalnessNode = float(palette.metalness);
  material.side = THREE.DoubleSide;

  const pomNormal = parallaxOcclusionUV(packedMap, opts);
  const coord = pomNormal.uv;
  const texel = float(1 / OFFICE_SURFACE_MAP_SIZE);
  const hL = textureLevel(packedMap, vec2(coord.x.sub(texel), coord.y), 0).r;
  const hR = textureLevel(packedMap, vec2(coord.x.add(texel), coord.y), 0).r;
  const hD = textureLevel(packedMap, vec2(coord.x, coord.y.sub(texel)), 0).r;
  const hU = textureLevel(packedMap, vec2(coord.x, coord.y.add(texel)), 0).r;
  const tangentNormal = normalize(vec3(hL.sub(hR).mul(3.0), hD.sub(hU).mul(3.0), float(1)));
  material.normalNode = normalMap(tangentNormal.mul(0.5).add(0.5));
  material.userData.officeSurfaceKind = kind;
  material.userData.packedReliefMap = packedMap;
  return material;
}

export function officeWallUV() {
  const across = positionWorld.x.mul(abs(normalLocal.z)).add(positionWorld.z.mul(abs(normalLocal.x)));
  return vec2(across.div(1.8), positionWorld.y.div(1.35));
}

export function officeColumnUV() {
  const across = positionLocal.x.mul(abs(normalLocal.z)).add(positionLocal.z.mul(abs(normalLocal.x)));
  return vec2(across.div(0.42), positionLocal.y.div(0.82));
}

export function officeCeilingUV() {
  return vec2(positionWorld.x.div(1.2), positionWorld.z.div(0.6));
}

export function createOfficeTerrazzoMaterial({ cellW = 3.2, cellD = 3.2, scale = 0.024 } = {}) {
  return createOfficePackedReliefMaterial({
    kind: 'terrazzo',
    uvNode: uv().mul(vec2(Math.max(1, cellW / 1.6), Math.max(1, cellD / 1.6))),
    scale,
    minLayers: 8,
    maxLayers: 24,
  });
}

export function createOfficeColumnMaterial({ scale = 0.035 } = {}) {
  return createOfficePackedReliefMaterial({
    kind: 'column',
    uvNode: officeColumnUV(),
    scale,
    minLayers: 8,
    maxLayers: 28,
  });
}

export function createOfficeCeilingMaterial({ scale = 0.018 } = {}) {
  return createOfficePackedReliefMaterial({
    kind: 'ceiling',
    uvNode: officeCeilingUV(),
    scale,
    minLayers: 6,
    maxLayers: 18,
  });
}

export function createOfficeFeatureWallMaterial({ scale = 0.03 } = {}) {
  return createOfficePackedReliefMaterial({
    kind: 'featureWall',
    uvNode: officeWallUV(),
    scale,
    minLayers: 8,
    maxLayers: 28,
  });
}

export function getOfficeTerrazzoMaterial({ cellW = 3.2, cellD = 3.2 } = {}) {
  const key = `terrazzo|${cellW}|${cellD}`;
  if (materialCache.has(key)) return materialCache.get(key);
  const preset = getQualityPreset(getQualityLevel());
  const material = typeof document !== 'undefined' && preset.parallaxOcclusion?.enabled
    ? createOfficeTerrazzoMaterial({ cellW, cellD })
    : new THREE.MeshStandardMaterial({ color: 0xc9c5bb, roughness: 0.62, metalness: 0.02 });
  materialCache.set(key, material);
  return material;
}

export function getOfficeColumnMaterial() {
  const key = 'column';
  if (materialCache.has(key)) return materialCache.get(key);
  const preset = getQualityPreset(getQualityLevel());
  const material = typeof document !== 'undefined' && preset.parallaxOcclusion?.enabled
    ? createOfficeColumnMaterial()
    : new THREE.MeshStandardMaterial({ color: 0x5e6469, roughness: 0.54, metalness: 0.3 });
  materialCache.set(key, material);
  return material;
}

export function getOfficeCeilingMaterial() {
  const key = 'ceiling';
  if (materialCache.has(key)) return materialCache.get(key);
  const preset = getQualityPreset(getQualityLevel());
  const material = typeof document !== 'undefined' && preset.parallaxOcclusion?.enabled
    ? createOfficeCeilingMaterial()
    : new THREE.MeshStandardMaterial({ color: 0xe4e2dc, roughness: 0.96, metalness: 0 });
  material.userData.officeCeilingTile = true;
  materialCache.set(key, material);
  return material;
}
