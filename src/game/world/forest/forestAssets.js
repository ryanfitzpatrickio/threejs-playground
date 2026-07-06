import {
  TextureLoader,
  RepeatWrapping,
  SRGBColorSpace,
  NoColorSpace,
} from 'three';
import { makeBarkMaterial } from './seedthree/barkMaterial.js';
import { makeFoliageMaterial } from './seedthree/leaf-cards.js';
import { getForestSpecies, normalizeForestSpecies } from './forestSpecies.js';
import { FOREST_LEAVES_URL, forestBarkUrl } from './forestSpeciesTextures.js';

const assetCache = new Map();

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
      (err) => reject(new Error(`forest texture failed: ${url} (${err?.message ?? err})`)),
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
  const barkRoot = forestBarkUrl(key);
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
    loadTex(loader, `${barkRoot}${species.bark}`, true),
    optTex(loader, `${barkRoot}${barkBase}_normal.png`, false),
    optTex(loader, `${barkRoot}${barkBase}_roughness.png`, false),
    loadTex(loader, `${FOREST_LEAVES_URL}${species.leaf}`, true),
    optTex(loader, `${FOREST_LEAVES_URL}${leafBase}_translucency.png`, false),
    optTex(loader, `${FOREST_LEAVES_URL}${leafBase}_normal.png`, false),
    optTex(loader, `${FOREST_LEAVES_URL}${leafBase}_roughness.png`, false),
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
