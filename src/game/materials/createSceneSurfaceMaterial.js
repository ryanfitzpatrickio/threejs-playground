/**
 * Reusable outdoor / playground surface materials: world-space PBR maps with
 * practical hex tiling (same path as rally shoulders + streaming terrain).
 *
 * Use for ground planes, paths, sand pits, mud wallows, and any scene that
 * wants consistent tiled dirt/grass without inventing a one-off MeshStandard
 * flat color. Pass a quality preset so hextile follows ultra/high settings.
 */
import * as THREE from 'three';
import { float } from 'three/tsl';
import { getQualityLevel, getQualityPreset } from '../config/qualityPresets.js';
import {
  createRallySurfaceMaterial,
  loadRallySurfaceSet,
  RALLY_SURFACE_TILES_PER_METRE,
} from './rallySurfaceTextures.js';

const RANGE_ROOT = '/assets/textures/range';
const rangeCache = new Map();

/** Default hex blend when a quality preset has hextile disabled / missing. */
export const DEFAULT_SCENE_HEXTILE = Object.freeze({
  enabled: true,
  falloffContrast: 0.6,
  exponent: 7,
  roadRotStrength: 0.35,
  roadExponent: 2,
});

/**
 * @param {object | null} [qualityPreset]
 * @param {{ force?: boolean }} [opts] force=true always enables hex even on low presets
 */
export function resolveSceneHextile(qualityPreset = null, { force = true } = {}) {
  const preset = qualityPreset ?? getQualityPreset(getQualityLevel());
  const fromPreset = preset?.terrainHextile;
  if (fromPreset?.enabled) return fromPreset;
  if (force) return { ...DEFAULT_SCENE_HEXTILE, ...(fromPreset ?? {}) };
  return fromPreset ?? { enabled: false };
}

/**
 * Named outdoor surface kinds. Terrain kinds use rally grass/dirt atlases;
 * structural kinds reuse range wood/metal/concrete maps under the same hex PBR.
 */
const SURFACE_KINDS = Object.freeze({
  grass: {
    source: 'rally',
    set: 'grass',
    tilesPerMetre: 1 / 2.4,
  },
  dirt: {
    source: 'rally',
    set: 'dirt',
    tilesPerMetre: 1 / 2.8,
  },
  sand: {
    source: 'rally',
    set: 'dirt',
    tilesPerMetre: 1 / 2.1,
    // Warm sand over dirt grain (no dedicated sand atlas yet).
    albedoTint: 0xe8c98a,
    roughnessScale: 1.08,
  },
  mud: {
    source: 'rally',
    set: 'dirt',
    tilesPerMetre: RALLY_SURFACE_TILES_PER_METRE,
    mudSurface: true,
  },
  wood: {
    source: 'range',
    set: 'woodwall',
    tilesPerMetre: 1 / 1.8,
  },
  curb: {
    source: 'range',
    set: 'concrete',
    tilesPerMetre: 1 / 1.6,
    albedoTint: 0xc4b49a,
    roughnessScale: 1.05,
  },
  concrete: {
    source: 'range',
    set: 'concrete',
    tilesPerMetre: 1 / 2.8,
  },
  metal: {
    source: 'range',
    set: 'pillarmiddle',
    tilesPerMetre: 1 / 1.4,
    metalness: 0.55,
  },
  fence: {
    source: 'range',
    set: 'woodwall2',
    tilesPerMetre: 1 / 1.5,
    albedoTint: 0xe8dcc4,
  },
});

/**
 * @param {keyof typeof SURFACE_KINDS | string} kind
 * @param {{
 *   qualityPreset?: object | null,
 *   hextile?: object | null,
 *   forceHextile?: boolean,
 *   tilesPerMetre?: number,
 *   albedoTint?: number,
 *   roughnessScale?: number,
 *   mudSurface?: boolean,
 *   deformTexture?: object,
 *   orientationTexture?: object,
 *   deformTilesPerMetre?: number,
 *   deformSinkScale?: number,
 *   deformCenter?: object,
 *   deformFadeNear?: number,
 *   deformFadeFar?: number,
 *   rainWetness?: object,
 *   rainWind?: object,
 *   metalness?: number,
 * }} [options]
 */
export function createSceneSurfaceMaterial(kind, options = {}) {
  const preset = SURFACE_KINDS[kind] ?? SURFACE_KINDS.dirt;
  const hextile = options.hextile !== undefined
    ? options.hextile
    : resolveSceneHextile(options.qualityPreset, { force: options.forceHextile !== false });

  const maps = preset.source === 'range'
    ? loadRangeSurfaceSet(preset.set)
    : loadRallySurfaceSet(preset.set);

  const material = createRallySurfaceMaterial(maps, {
    tilesPerMetre: options.tilesPerMetre ?? preset.tilesPerMetre ?? RALLY_SURFACE_TILES_PER_METRE,
    hextile,
    albedoTint: options.albedoTint ?? preset.albedoTint ?? null,
    roughnessScale: options.roughnessScale ?? preset.roughnessScale ?? 1,
    mudSurface: options.mudSurface ?? preset.mudSurface === true,
    deformTexture: options.deformTexture,
    orientationTexture: options.orientationTexture,
    deformTilesPerMetre: options.deformTilesPerMetre,
    deformSinkScale: options.deformSinkScale,
    deformCenter: options.deformCenter,
    deformFadeNear: options.deformFadeNear,
    deformFadeFar: options.deformFadeFar,
    rainWetness: options.rainWetness,
    rainWind: options.rainWind,
  });

  const metalness = options.metalness ?? preset.metalness;
  if (Number.isFinite(metalness) && metalness > 0) {
    // createRallySurfaceMaterial defaults metalnessNode to 0 (roads). Structural
    // kinds need a non-zero metal response for steel props.
    material.metalnessNode = float(metalness);
    material.metalness = metalness;
  }

  material.userData.sceneSurface = kind;
  material.userData.hextile = Boolean(hextile?.enabled);
  return material;
}

/**
 * Convenience pack for outdoor lots / parks. Callers can still override mud
 * with deform-field options after the fact.
 *
 * @param {{ qualityPreset?: object | null }} [options]
 */
export function createSceneSurfaceMaterialPack(options = {}) {
  return {
    grass: createSceneSurfaceMaterial('grass', options),
    dirt: createSceneSurfaceMaterial('dirt', options),
    sand: createSceneSurfaceMaterial('sand', options),
    mud: createSceneSurfaceMaterial('mud', options),
    wood: createSceneSurfaceMaterial('wood', options),
    curb: createSceneSurfaceMaterial('curb', options),
    concrete: createSceneSurfaceMaterial('concrete', options),
    metal: createSceneSurfaceMaterial('metal', options),
    fence: createSceneSurfaceMaterial('fence', options),
  };
}

function loadRangeSurfaceSet(folder) {
  if (rangeCache.has(folder)) return rangeCache.get(folder);
  if (typeof document === 'undefined') {
    const empty = { map: null, normalMap: null, roughnessMap: null, heightMap: null };
    rangeCache.set(folder, empty);
    return empty;
  }
  const loader = new THREE.TextureLoader();
  const base = `${RANGE_ROOT}/${folder}`;
  const maps = {
    map: configureRangeMap(loader.load(`${base}/albedo.png`), { srgb: true }),
    normalMap: configureRangeMap(loader.load(`${base}/normal.png`)),
    roughnessMap: configureRangeMap(loader.load(`${base}/roughness.png`)),
    heightMap: configureRangeMap(loader.load(`${base}/height.png`)),
  };
  rangeCache.set(folder, maps);
  return maps;
}

function configureRangeMap(texture, { srgb = false } = {}) {
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export { SURFACE_KINDS };
