/**
 * Gunsmith material profiles.
 *
 * Profiles are data-only and therefore persist with a gun annotation. Texture
 * loading and material construction live here so preview and runtime use the
 * exact same result.
 */
import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { color as colorTSL, float, normalMap, texture, triplanarTexture } from 'three/tsl';

export const GUN_MATERIAL_MODES = Object.freeze([
  Object.freeze({ id: 'baked', label: 'Baked texture PBR', description: 'Original GLB maps and base color with its authored PBR response.' }),
  Object.freeze({ id: 'baked_flat', label: 'Baked texture / no PBR', description: 'Original GLB albedo and base color, but unlit.' }),
  Object.freeze({ id: 'flat', label: 'Flat / no PBR', description: 'Unlit neutral finish; ignores GLB maps.' }),
  Object.freeze({ id: 'pbr', label: 'Clean PBR', description: 'Neutral physical finish; ignores GLB maps.' }),
  Object.freeze({ id: 'metal_tsl', label: 'Metal TSL', description: 'Neutral TSL metallic finish; ignores GLB maps.' }),
  Object.freeze({ id: 'texture_pbr', label: 'Texture-set PBR', description: 'Selected supplied albedo, normal, roughness, and AO maps.' }),
  Object.freeze({ id: 'texture_metal_tsl', label: 'Texture-set + Metal TSL', description: 'Selected PBR maps on a highly metallic TSL material.' }),
]);

export const GUN_PBR_TEXTURE_SETS = Object.freeze([
  Object.freeze({ id: 'field-panel', label: 'Field panel', baseUrl: '/assets/textures/guns/field-panel' }),
  Object.freeze({ id: 'weathered-sand', label: 'Weathered sand', baseUrl: '/assets/textures/guns/weathered-sand' }),
  Object.freeze({ id: 'weathered-white', label: 'Weathered white', baseUrl: '/assets/textures/guns/weathered-white' }),
  Object.freeze({ id: 'weathered-black', label: 'Weathered black', baseUrl: '/assets/textures/guns/weathered-black' }),
]);

const MODE_IDS = new Set(GUN_MATERIAL_MODES.map((entry) => entry.id));
const TEXTURE_SET_IDS = new Set(GUN_PBR_TEXTURE_SETS.map((entry) => entry.id));
const textureSetCache = new Map();

const SURFACE_DEFAULTS = Object.freeze({
  metal: Object.freeze({ color: 0x545961, metalness: 0.78, roughness: 0.34 }),
  polymer: Object.freeze({ color: 0x262a2e, metalness: 0.08, roughness: 0.58 }),
  wood: Object.freeze({ color: 0x6b4423, metalness: 0.02, roughness: 0.62 }),
  rubber: Object.freeze({ color: 0x141518, metalness: 0, roughness: 0.88 }),
  glass: Object.freeze({ color: 0x8ca3ad, metalness: 0.05, roughness: 0.2 }),
});

function surfaceDefaults(surfaceClass = 'metal') {
  return SURFACE_DEFAULTS[surfaceClass] ?? SURFACE_DEFAULTS.metal;
}

export function createDefaultGunAppearance(surfaceClass = 'metal') {
  const defaults = surfaceDefaults(surfaceClass);
  return {
    mode: 'pbr',
    textureSet: 'field-panel',
    uvScale: 1,
    metalness: defaults.metalness,
    roughness: defaults.roughness,
  };
}

export function normalizeGunAppearance(raw, surfaceClass = 'metal') {
  const defaults = createDefaultGunAppearance(surfaceClass);
  const mode = MODE_IDS.has(raw?.mode) ? raw.mode : defaults.mode;
  const textureSet = TEXTURE_SET_IDS.has(raw?.textureSet) ? raw.textureSet : defaults.textureSet;
  const metalDefault = mode === 'texture_metal_tsl' || mode === 'metal_tsl' ? 0.9 : defaults.metalness;
  return {
    mode,
    textureSet,
    uvScale: THREE.MathUtils.clamp(Number(raw?.uvScale) || defaults.uvScale, 0.1, 16),
    metalness: THREE.MathUtils.clamp(Number.isFinite(Number(raw?.metalness)) ? Number(raw.metalness) : metalDefault, 0, 1),
    roughness: THREE.MathUtils.clamp(Number.isFinite(Number(raw?.roughness)) ? Number(raw.roughness) : defaults.roughness, 0.02, 1),
  };
}

export function gunMaterialModeUsesTextureSet(mode) {
  return mode === 'texture_pbr' || mode === 'texture_metal_tsl';
}

export function getGunPbrTextureSet(id) {
  return GUN_PBR_TEXTURE_SETS.find((entry) => entry.id === id) ?? GUN_PBR_TEXTURE_SETS[0];
}

function configureMap(map, { color = false } = {}) {
  map.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = Math.max(map.anisotropy ?? 1, 4);
  map.needsUpdate = true;
  return map;
}

async function loadTextureSet(id) {
  if (textureSetCache.has(id)) return textureSetCache.get(id);
  const definition = getGunPbrTextureSet(id);
  const load = Promise.all([
    new THREE.TextureLoader().loadAsync(`${definition.baseUrl}/albedo.png`),
    new THREE.TextureLoader().loadAsync(`${definition.baseUrl}/normal.png`),
    new THREE.TextureLoader().loadAsync(`${definition.baseUrl}/roughness.png`),
    new THREE.TextureLoader().loadAsync(`${definition.baseUrl}/ao.png`),
  ]).then(([albedo, normal, roughness, ao]) => ({
    albedo: configureMap(albedo, { color: true }),
    normal: configureMap(normal),
    roughness: configureMap(roughness),
    ao: configureMap(ao),
  })).catch((error) => {
    textureSetCache.delete(id);
    throw error;
  });
  textureSetCache.set(id, load);
  return load;
}

function cloneSourceMaterials(mesh) {
  if (!mesh.userData._gunsmithBakedMaterials) {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    mesh.userData._gunsmithBakedMaterials = materials.map((material) => material?.clone?.() ?? null);
  }
  return mesh.userData._gunsmithBakedMaterials;
}

function configureOpaque(material) {
  material.transparent = false;
  material.opacity = 1;
  material.depthWrite = true;
  material.side = THREE.DoubleSide;
  material.shadowSide = THREE.DoubleSide;
  return material;
}

function createBakedMaterial(source) {
  const material = source?.clone?.() ?? new THREE.MeshStandardMaterial();
  const maps = ['map', 'emissiveMap'];
  for (const key of maps) {
    if (material[key]) material[key].colorSpace = THREE.SRGBColorSpace;
  }
  return configureOpaque(material);
}

function createBakedFlatMaterial(source) {
  const material = new THREE.MeshBasicMaterial({
    name: 'Gun baked texture (no PBR)',
    color: source?.color?.clone?.() ?? 0xffffff,
    map: source?.map ?? null,
  });
  if (material.map) material.map.colorSpace = THREE.SRGBColorSpace;
  return configureOpaque(material);
}

function createFlatMaterial(appearance, surfaceClass) {
  const defaults = surfaceDefaults(surfaceClass);
  return configureOpaque(new THREE.MeshBasicMaterial({
    name: 'Gun flat finish',
    color: defaults.color,
  }));
}

function createPbrMaterial(appearance, surfaceClass) {
  const defaults = surfaceDefaults(surfaceClass);
  return configureOpaque(new THREE.MeshStandardMaterial({
    name: 'Gun clean PBR finish',
    color: defaults.color,
    metalness: appearance.metalness,
    roughness: appearance.roughness,
    envMapIntensity: 0.9,
  }));
}

function createMetalTslMaterial(appearance, surfaceClass) {
  const defaults = surfaceDefaults(surfaceClass);
  const material = new MeshStandardNodeMaterial();
  material.name = 'Gun TSL metal finish';
  material.color.setHex(defaults.color);
  material.metalness = Math.max(0.7, appearance.metalness);
  material.roughness = appearance.roughness;
  material.colorNode = colorTSL(defaults.color);
  material.metalnessNode = float(material.metalness);
  material.roughnessNode = float(material.roughness);
  material.envMapIntensity = 1.05;
  return configureOpaque(material);
}

/** UV-less Meshy gun parts use local-space triplanar TSL projection. */
function applyTextureSet(material, textures, appearance) {
  const scale = float(appearance.uvScale);
  const albedo = triplanarTexture(texture(textures.albedo), null, null, scale);
  const normal = triplanarTexture(texture(textures.normal), null, null, scale);
  const roughness = triplanarTexture(texture(textures.roughness), null, null, scale);
  const ao = triplanarTexture(texture(textures.ao), null, null, scale);
  // AO should darken indirect light rather than crush the albedo. A 45% floor
  // keeps the supplied weathered maps readable in the first-person lighting.
  material.colorNode = albedo.rgb.mul(ao.r.mul(0.55).add(0.45));
  material.normalNode = normalMap(normal.rgb);
  material.roughnessNode = roughness.r;
  material.metalnessNode = float(material.metalness);
  material.needsUpdate = true;
  return material;
}

async function createAppearanceMaterial({ source, appearance, surfaceClass }) {
  if (appearance.mode === 'baked') return createBakedMaterial(source);
  if (appearance.mode === 'baked_flat') return createBakedFlatMaterial(source);
  if (appearance.mode === 'flat') return createFlatMaterial(appearance, surfaceClass);
  if (appearance.mode === 'pbr') return createPbrMaterial(appearance, surfaceClass);
  if (appearance.mode === 'metal_tsl') return createMetalTslMaterial(appearance, surfaceClass);

  const textures = await loadTextureSet(appearance.textureSet);
  if (appearance.mode === 'texture_metal_tsl') {
    const material = createMetalTslMaterial(appearance, surfaceClass);
    material.name = 'Gun texture-set + TSL metal finish';
    material.metalness = Math.max(0.75, appearance.metalness);
    return applyTextureSet(material, textures, appearance);
  }
  const material = new MeshStandardNodeMaterial();
  material.name = 'Gun texture-set PBR finish';
  material.metalness = appearance.metalness;
  material.roughness = appearance.roughness;
  material.envMapIntensity = 0.9;
  configureOpaque(material);
  return applyTextureSet(material, textures, appearance);
}

/** Apply all persisted per-part Gunsmith appearances to a loaded gun root. */
export async function applyGunProfileMaterials(root, profile) {
  if (!root) return;
  const parts = new Map((profile?.parts ?? []).map((part) => [part.meshName, part]));
  const jobs = [];
  root.traverse((mesh) => {
    if (!mesh.isMesh) return;
    const part = parts.get(mesh.name) ?? { surfaceClass: 'metal' };
    const appearance = normalizeGunAppearance(part.appearance, part.surfaceClass);
    const sourceMaterials = cloneSourceMaterials(mesh);
    const source = sourceMaterials[0];
    const nextMaterial = (appearance.mode === 'baked' || appearance.mode === 'baked_flat') && sourceMaterials.length > 1
      ? Promise.resolve(sourceMaterials.map((item) => (
        appearance.mode === 'baked_flat' ? createBakedFlatMaterial(item) : createBakedMaterial(item)
      )))
      : createAppearanceMaterial({
        source,
        appearance,
        surfaceClass: part.surfaceClass,
      });
    jobs.push(nextMaterial.then((material) => {
      const previous = mesh.material;
      mesh.material = material;
      mesh.userData.gunsmithAppearance = appearance;
      const materials = Array.isArray(previous) ? previous : [previous];
      const nextMaterials = Array.isArray(material) ? material : [material];
      for (const item of materials) {
        if (item && !sourceMaterials.includes(item) && !nextMaterials.includes(item)) item.dispose?.();
      }
    }));
  });
  await Promise.all(jobs);
}

export function clearGunMaterialTextureCache() {
  for (const pending of textureSetCache.values()) {
    void pending.then((textures) => Object.values(textures).forEach((texture) => texture.dispose()));
  }
  textureSetCache.clear();
}
