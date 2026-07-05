// officeElevatorMaterial.js — stainless elevator doors + POM diamond-plate frame.

import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  vec2, vec3, float, textureLevel, normalize, normalMap, mix, color, positionLocal, normalLocal, abs,
} from 'three/tsl';
import { parallaxOcclusionUV } from '../../../three-addons/tsl/utils/ParallaxOcclusion.js';
import { getQualityPreset, getQualityLevel } from '../../config/qualityPresets.js';

const FRAME_DIAMOND_M = 0.22;
const FRAME_POM_SCALE = 0.055;

// Bright brushed stainless — avoid metalness 1.0 (reads black without IBL).
const STAINLESS_DOOR = new THREE.MeshStandardMaterial({
  color: 0xe8eef4,
  roughness: 0.1,
  metalness: 0.88,
  envMapIntensity: 1.2,
});

const FALLBACK_FRAME = new THREE.MeshStandardMaterial({
  color: 0x5a6068, roughness: 0.55, metalness: 0.35,
});

function bakeHeightTexture(size, fn) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      let h = fn(u, v, x, y);
      h = Math.max(0, Math.min(1, h));
      const i = (y * size + x) * 4;
      const val = Math.round(h * 255);
      data[i] = val;
      data[i + 1] = val;
      data[i + 2] = val;
      data[i + 3] = 255;
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

function makeElevatorFrameHeightTexture(size = 256) {
  return bakeHeightTexture(size, (u, v) => {
    let h = 0.86;
    const du = ((u + v) / FRAME_DIAMOND_M) % 1;
    const dv = ((u - v) / FRAME_DIAMOND_M) % 1;
    if (du < 0.11 || dv < 0.11) h -= 0.58;
    const beadU = (u * 14) % 1;
    const beadV = (v * 6) % 1;
    if (beadU < 0.04 || beadV < 0.04) h -= 0.28;
    return h;
  });
}

function faceUV(acrossDiv, upDiv) {
  const across = positionLocal.x.mul(abs(normalLocal.z)).add(positionLocal.z.mul(abs(normalLocal.x)));
  return vec2(across.div(float(acrossDiv)), positionLocal.y.div(float(upDiv)));
}

function assignPomMetal(material, heightTex, uvNode, scaleValue, baseColor, metalLow, metalHigh, roughLow, roughHigh) {
  const scale = float(scaleValue);
  const opts = { uvNode, scale, minLayers: 10, maxLayers: 36, silhouette: false };
  const pom = parallaxOcclusionUV(heightTex, opts);
  const relief = pom.sample(heightTex).r;
  material.colorNode = baseColor.mul(mix(float(0.72), float(1.08), relief));
  material.metalnessNode = mix(float(metalLow), float(metalHigh), relief);
  material.roughnessNode = mix(float(roughLow), float(roughHigh), relief);
  const pomN = parallaxOcclusionUV(heightTex, opts);
  const uc = pomN.uv;
  const e = float(1 / 256);
  const hL = textureLevel(heightTex, vec2(uc.x.sub(e), uc.y), 0).r;
  const hR = textureLevel(heightTex, vec2(uc.x.add(e), uc.y), 0).r;
  const hD = textureLevel(heightTex, vec2(uc.x, uc.y.sub(e)), 0).r;
  const hU = textureLevel(heightTex, vec2(uc.x, uc.y.add(e)), 0).r;
  const strength = float(3.2);
  const tangentNormal = normalize(vec3(hL.sub(hR).mul(strength), hD.sub(hU).mul(strength), float(1)));
  material.normalNode = normalMap(tangentNormal.mul(0.5).add(0.5));
}

export function createElevatorDoorMaterial() {
  return STAINLESS_DOOR;
}

export function createElevatorFrameMaterial(preset = {}) {
  const heightTex = makeElevatorFrameHeightTexture();
  const material = new MeshStandardNodeMaterial();
  material.side = THREE.DoubleSide;
  assignPomMetal(
    material,
    heightTex,
    faceUV(FRAME_DIAMOND_M, FRAME_DIAMOND_M),
    preset.elevatorFrameScale ?? FRAME_POM_SCALE,
    color(0x707880),
    0.45,
    0.78,
    0.55,
    0.22,
  );
  return material;
}

let frameCached;

export function getElevatorDoorMaterial() {
  return STAINLESS_DOOR;
}

export function getElevatorFrameMaterial() {
  if (frameCached !== undefined) return frameCached;
  const preset = getQualityPreset(getQualityLevel());
  frameCached = preset.parallaxOcclusion?.enabled ? createElevatorFrameMaterial(preset) : FALLBACK_FRAME;
  return frameCached;
}
