/**
 * editorTerrainMaterial.js
 *
 * The map editor's terrain material. By default it renders the flat slate-green
 * base the editor has always used. On top of that it can blend ONE global custom
 * texture (an uploaded image) uniformly across the whole terrain, controlled by a
 * blend amount (0..1) and a world-space tiling rate.
 *
 * It's a TSL node material because the editor renders with WebGPURenderer (the
 * same stack as the runtime biome material). Textures tile by WORLD xz so the
 * blend is continuous across the streamed chunk grid (no per-chunk seams).
 *
 * One material instance is shared by every terrain chunk so the texture/blend
 * applies "to the whole terrain" with a single uniform update. Because the
 * material is shared, callers must NOT free it when disposing an individual chunk
 * mesh (see MapBuilder.disposeChunkMesh) — dispose it once via dispose().
 */

import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { texture, uniform, positionWorld, mix, vec3 } from 'three/tsl';

const BASE_COLOR = new THREE.Color(0x9aa38f);
export const DEFAULT_TERRAIN_TILING = 0.08; // texture repeats roughly every ~12 m
export const DEFAULT_TERRAIN_BLEND = 0.6;

// Built-in PBR albedo textures available to blend over the editor terrain
// (the sets in /public/textures/pbr — same library the runtime biome uses).
const TERRAIN_TEX_BASE = '/textures/pbr';
// `ext` defaults to webp; entries whose albedo ships in another format override it.
export const TERRAIN_TEXTURE_LIBRARY = [
  { id: 'grass1', label: 'Grass' },
  { id: 'grass3', label: 'Grass 2' },
  { id: 'grass4', label: 'Grass 3' },
  { id: 'drygrass', label: 'Dry Grass' },
  { id: 'moss', label: 'Moss' },
  { id: 'dirt1', label: 'Dirt' },
  { id: 'mud', label: 'Mud' },
  { id: 'gravel', label: 'Gravel' },
  { id: 'sand1', label: 'Sand' },
  { id: 'salt', label: 'Salt', ext: 'png' },
  { id: 'rock1', label: 'Rock' },
  { id: 'cliffrock', label: 'Cliff Rock' },
  { id: 'snow', label: 'Snow' },
  { id: 'underwater1', label: 'Underwater' },
  { id: 'wateredge', label: 'Water Edge' },
];

/** Resolve a library texture id to its albedo image URL (null for unknown ids). */
export function terrainTextureUrl(id) {
  const entry = TERRAIN_TEXTURE_LIBRARY.find((t) => t.id === id);
  if (!entry) return null;
  return `${TERRAIN_TEX_BASE}/${entry.id}-albedo.${entry.ext ?? 'webp'}`;
}

export function createEditorTerrainMaterial() {
  const blend = uniform(0); // effective blend (forced to 0 until a texture is set)
  const tiling = uniform(DEFAULT_TERRAIN_TILING);

  // 1x1 white placeholder so the texture node has a valid binding before the
  // first upload (mix() falls back to the base color while blend is 0).
  const placeholder = new THREE.DataTexture(
    new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat,
  );
  placeholder.needsUpdate = true;

  const texNode = texture(placeholder, positionWorld.xz.mul(tiling));

  const base = vec3(BASE_COLOR.r, BASE_COLOR.g, BASE_COLOR.b);

  const material = new MeshStandardNodeMaterial();
  material.colorNode = mix(base, texNode.rgb, blend);
  material.roughness = 0.92;
  material.metalness = 0.02;
  material.shadowSide = THREE.DoubleSide;
  material.name = 'Editor Terrain';

  let customTexture = null;
  let wantBlend = DEFAULT_TERRAIN_BLEND;

  const applyBlend = () => { blend.value = customTexture ? wantBlend : 0; };

  return {
    material,
    hasTexture: () => !!customTexture,
    getTexture: () => customTexture,
    getBlend: () => wantBlend,
    getTiling: () => tiling.value,

    setBlend(v) {
      wantBlend = THREE.MathUtils.clamp(Number(v) || 0, 0, 1);
      applyBlend();
    },

    setTiling(v) {
      tiling.value = Math.max(0.001, Number(v) || DEFAULT_TERRAIN_TILING);
    },

    /** Swap the global texture. Pass null to clear back to the base color. */
    setTexture(tex) {
      if (customTexture && customTexture !== tex) customTexture.dispose();
      customTexture = tex || null;
      texNode.value = customTexture || placeholder;
      applyBlend();
      material.needsUpdate = true; // rebind the sampler in WebGPU
    },

    dispose() {
      if (customTexture) customTexture.dispose();
      placeholder.dispose();
      material.dispose();
    },
  };
}
