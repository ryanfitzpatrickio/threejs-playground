import {
  TextureLoader,
  RepeatWrapping,
  SRGBColorSpace,
  NoColorSpace,
} from 'three';
import { makeBarkMaterial } from './seedthree/barkMaterial.js';
import { makeFoliageMaterial } from './seedthree/leaf-cards.js';
import { getForestSpecies, normalizeForestSpecies } from './forestSpecies.js';

const assetCache = new Map();

function texRoot(speciesKey) {
  return `/assets/textures/forest/${normalizeForestSpecies(speciesKey)}/`;
}

function loadTex(loader, url, srgb = true) {
  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (tex) => {
        tex.wrapS = tex.wrapT = RepeatWrapping;
        tex.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
        tex.anisotropy = 8;
        resolve(tex);
      },
      undefined,
      reject,
    );
  });
}

function optTex(loader, url, srgb) {
  return loadTex(loader, url, srgb).catch(() => null);
}

/** Load bark + needle PBR textures and shared materials for one species. */
export async function loadForestSpeciesAssets(speciesKey = 'pine') {
  const key = normalizeForestSpecies(speciesKey);
  const cached = assetCache.get(key);
  if (cached) return cached;

  const species = getForestSpecies(key);
  const root = texRoot(key);
  const loader = new TextureLoader();
  const barkBase = species.bark.replace('_albedo.png', '');
  const leafBase = species.leaf.replace(/(_albedo)?\.png$/, '');

  const [
    barkTexture,
    barkNormal,
    barkRoughness,
    leafTexture,
    leafTranslucency,
    leafNormal,
    leafRoughness,
  ] = await Promise.all([
    loadTex(loader, `${root}${species.bark}`, true),
    optTex(loader, `${root}${barkBase}_normal.png`, false),
    optTex(loader, `${root}${barkBase}_roughness.png`, false),
    loadTex(loader, `${root}${species.leaf}`, true),
    optTex(loader, `${root}${leafBase}_translucency.png`, false),
    optTex(loader, `${root}${leafBase}_normal.png`, false),
    optTex(loader, `${root}${leafBase}_roughness.png`, false),
  ]);

  const assets = {
    barkTexture,
    barkNormal,
    barkRoughness,
    leafTexture,
    leafTranslucency,
    leafNormal,
    leafRoughness,
  };
  assets.barkMat = makeBarkMaterial(assets);
  const leafFol = makeFoliageMaterial(assets, { ...species.foliage, mode: 'leaves' });
  assets.leafMat = leafFol.material;
  assets.leafCenter = leafFol.centerUniform;
  const clusterFol = makeFoliageMaterial(assets, { ...species.foliage, mode: 'clusters' });
  assets.clusterMat = clusterFol.material;
  assets.clusterCenter = clusterFol.centerUniform;

  assetCache.set(key, assets);
  return assets;
}

export function disposeForestAssetCache() {
  for (const assets of assetCache.values()) {
    assets.barkTexture?.dispose();
    assets.barkNormal?.dispose();
    assets.barkRoughness?.dispose();
    assets.leafTexture?.dispose();
    assets.leafTranslucency?.dispose();
    assets.leafNormal?.dispose();
    assets.leafRoughness?.dispose();
    assets.barkMat?.dispose();
    assets.leafMat?.dispose();
    assets.clusterMat?.dispose();
  }
  assetCache.clear();
}
