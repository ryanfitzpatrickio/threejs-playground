import { bakeImpostor } from './seedthree/impostor.js';
import { buildLod1Tree, buildLod2Tree } from './forestTreeBuilder.js';
import { loadForestSpeciesAssets } from './forestAssets.js';
import {
  getForestSpecies,
  parseForestSpeciesMix,
  pickSpeciesFromMix,
} from './forestSpecies.js';
import { mulberry32 } from './forestPlacement.js';

const DEFAULT_ARCHETYPE_COUNT = 5;

/**
 * Build K tree variants (LOD1 + LOD2 + baked impostor) per species mix.
 */
export async function buildForestArchetypes({
  species = 'pine',
  count = DEFAULT_ARCHETYPE_COUNT,
  speciesSeed = 1,
  renderer = null,
  castShadow = false,
  bakeImpostors = true,
} = {}) {
  const mix = parseForestSpeciesMix(species);
  const mixRng = mulberry32((speciesSeed * 1597334677) >>> 0);
  const assetsBySpecies = new Map();
  const archetypes = [];

  for (let k = 0; k < count; k += 1) {
    const speciesKey = pickSpeciesFromMix(mix, mixRng);
    if (!assetsBySpecies.has(speciesKey)) {
      assetsBySpecies.set(speciesKey, await loadForestSpeciesAssets(speciesKey));
    }
    const assets = assetsBySpecies.get(speciesKey);
    const speciesPreset = getForestSpecies(speciesKey);
    const seed = `${speciesKey}:${speciesSeed}:${k}`;

    const lod1 = buildLod1Tree(speciesPreset, seed, assets, { castShadow });
    const lod2 = buildLod2Tree(speciesPreset, seed, assets, { castShadow });

    let impostorGroup = null;
    let impostorHalfH = 0;
    if (renderer && bakeImpostors) {
      impostorGroup = await bakeImpostor(renderer, lod1.lodGroup, {
        name: speciesPreset.name,
        lodName: 'LOD3',
        size: 512,
        yield: () => new Promise((r) => requestAnimationFrame(r)),
      });
      const card = impostorGroup.children.find((c) => c.userData?.isBillboardCard);
      card?.geometry?.computeBoundingBox?.();
      impostorHalfH = card?.geometry?.boundingBox?.max?.y ?? 8;
    }

    archetypes.push({
      index: k,
      seed,
      speciesKey,
      lod1Group: lod1.lodGroup,
      lod2Group: lod2.lodGroup,
      branches: lod2.branches,
      foliage: lod2.foliage,
      impostorGroup,
      impostorHalfH,
    });
  }

  return {
    archetypes,
    dispose() {
      for (const arch of archetypes) {
        for (const g of [arch.lod1Group, arch.lod2Group, arch.impostorGroup]) {
          g?.traverse((obj) => {
            if (obj.geometry && !obj.geometry.userData?.shared) obj.geometry.dispose();
          });
        }
        if (arch.impostorGroup) {
          arch.impostorGroup.traverse((o) => {
            if (o.userData?.isBillboardCard) {
              o.material.map?.dispose();
              o.material.normalMap?.dispose();
              o.material.roughnessMap?.dispose();
              o.material.userData?.gltfDiffuseTransmission?.map?.dispose();
              o.material.dispose();
            }
          });
        }
      }
    },
  };
}
