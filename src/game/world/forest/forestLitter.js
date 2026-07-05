import * as THREE from 'three';
import {
  texture,
  uniform,
  positionWorld,
  vec2,
  vec3,
  mix,
  clamp,
  float,
} from 'three/tsl';
import { zoneBounds } from '../../../world/worldMap/zoneGeometry.js';
import { densityNoise } from './forestPlacement.js';

const _zero = new Float32Array([0]);
const _placeholder = new THREE.DataTexture(_zero, 1, 1, THREE.RedFormat, THREE.FloatType);
_placeholder.needsUpdate = true;

export const forestLitterStrength = uniform(0);
export const forestLitterBounds = uniform(new THREE.Vector4(0, 0, 1, 1));
const litterUv = positionWorld.xz
  .sub(vec2(forestLitterBounds.x, forestLitterBounds.y))
  .mul(vec2(forestLitterBounds.z, forestLitterBounds.w));
const litterTexNode = texture(_placeholder, litterUv);

const LITTER_TINT = vec3(0.78, 0.82, 0.68);

/**
 * Bake a coarse canopy litter mask from tree placements + placement density noise.
 */
export function buildForestLitterMask(zones, placements, resolution = 384) {
  if (!zones?.length || !placements?.length) return null;

  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const zone of zones) {
    const b = zoneBounds(zone);
    minX = Math.min(minX, b.minX);
    minZ = Math.min(minZ, b.minZ);
    maxX = Math.max(maxX, b.maxX);
    maxZ = Math.max(maxZ, b.maxZ);
  }

  const width = Math.max(1, maxX - minX);
  const depth = Math.max(1, maxZ - minZ);
  const data = new Float32Array(resolution * resolution);
  const stampR = 4;

  for (const p of placements) {
    const u = (p.x - minX) / width;
    const v = (p.z - minZ) / depth;
    if (u < 0 || u > 1 || v < 0 || v > 1) continue;
    const noise = densityNoise(p.x, p.z);
    const strength = 0.28 + noise * 0.62;
    const cx = Math.round(u * (resolution - 1));
    const cz = Math.round(v * (resolution - 1));
    for (let dz = -stampR; dz <= stampR; dz += 1) {
      for (let dx = -stampR; dx <= stampR; dx += 1) {
        const x = cx + dx;
        const z = cz + dz;
        if (x < 0 || z < 0 || x >= resolution || z >= resolution) continue;
        const falloff = Math.exp(-(dx * dx + dz * dz) / (stampR * stampR * 0.55));
        const idx = z * resolution + x;
        data[idx] = Math.max(data[idx], strength * falloff);
      }
    }
  }

  const tex = new THREE.DataTexture(data, resolution, resolution, THREE.RedFormat, THREE.FloatType);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;

  return {
    texture: tex,
    bounds: { minX, minZ, width, depth },
    resolution,
    maxValue: data.reduce((m, v) => Math.max(m, v), 0),
  };
}

export function setForestLitterMask(mask) {
  if (!mask?.texture) {
    forestLitterStrength.value = 0;
    litterTexNode.value = _placeholder;
    return;
  }
  litterTexNode.value = mask.texture;
  forestLitterBounds.value.set(
    mask.bounds.minX,
    mask.bounds.minZ,
    1 / mask.bounds.width,
    1 / mask.bounds.depth,
  );
  forestLitterStrength.value = 1;
}

export function clearForestLitterMask() {
  setForestLitterMask(null);
}

/** Darken grass albedo under stamped canopy litter (terrain biome material hook). */
export function applyForestLitterTint(biomeColor) {
  const mask = litterTexNode.r.mul(forestLitterStrength);
  return mix(biomeColor, biomeColor.mul(LITTER_TINT), clamp(mask.mul(0.58), float(0), float(1)));
}
