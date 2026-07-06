import { bakeImpostor, disposeBillboard } from './seedthree/impostor.js';
import { buildLod1Tree, buildLod2Tree } from './forestTreeBuilder.js';
import { loadForestSpeciesAssets } from './forestAssets.js';
import {
  getForestSpecies,
  parseForestSpeciesMix,
  pickSpeciesFromMix,
} from './forestSpecies.js';
import { mulberry32 } from './forestPlacement.js';

const DEFAULT_ARCHETYPE_COUNT = 5;
const MAX_CACHED_ARCHETYPE_PACKS = 8;
const archetypeCache = new Map();

function cacheKey({ species, count, speciesSeed, castShadow }) {
  return JSON.stringify([species, count, speciesSeed, castShadow === true]);
}

function disposeArchetypes(archetypes) {
  for (const arch of archetypes) {
    for (const group of [arch.lod1Group, arch.lod2Group]) {
      group?.traverse((object) => {
        if (object.geometry && !object.geometry.userData?.shared) object.geometry.dispose();
      });
    }
    if (arch.impostorGroup) disposeBillboard(arch.impostorGroup);
  }
}

function trimArchetypeCache() {
  if (archetypeCache.size <= MAX_CACHED_ARCHETYPE_PACKS) return;
  const candidates = [...archetypeCache.values()]
    .filter((entry) => entry.refCount === 0 && !entry.bakePromise)
    .sort((a, b) => a.lastUsed - b.lastUsed);
  while (archetypeCache.size > MAX_CACHED_ARCHETYPE_PACKS && candidates.length) {
    const entry = candidates.shift();
    archetypeCache.delete(entry.key);
    disposeArchetypes(entry.archetypes);
  }
}

async function createCacheEntry(key, { species, count, speciesSeed, castShadow }) {
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
    archetypes.push({
      index: k,
      seed,
      speciesKey,
      speciesName: speciesPreset.name,
      lod1Group: lod1.lodGroup,
      lod2Group: lod2.lodGroup,
      branches: lod2.branches,
      foliage: lod2.foliage,
      impostorGroup: null,
      impostorHalfH: 0,
    });
  }

  return {
    key,
    archetypes,
    refCount: 0,
    lastUsed: performance.now(),
    bakePromise: null,
    impostorBakeMs: 0,
    bakeListeners: new Set(),
  };
}

async function acquireEntry(options) {
  const key = cacheKey(options);
  let pending = archetypeCache.get(key);
  const cacheHit = !!pending;
  if (!pending) {
    pending = createCacheEntry(key, options).catch((error) => {
      archetypeCache.delete(key);
      throw error;
    });
    archetypeCache.set(key, pending);
  }
  const entry = await pending;
  if (archetypeCache.get(key) !== entry) archetypeCache.set(key, entry);
  entry.refCount += 1;
  entry.lastUsed = performance.now();
  trimArchetypeCache();
  return { entry, cacheHit };
}

/** Build or acquire K deterministic tree variants. Impostors can be baked lazily. */
export async function buildForestArchetypes({
  species = 'pine',
  count = DEFAULT_ARCHETYPE_COUNT,
  speciesSeed = 1,
  renderer = null,
  castShadow = false,
  bakeImpostors = true,
} = {}) {
  const { entry, cacheHit } = await acquireEntry({ species, count, speciesSeed, castShadow });
  let released = false;
  const archetypes = entry.archetypes.map((archetype) => ({ ...archetype }));

  const ensureImpostors = async (targetRenderer = renderer, { onArchetype } = {}) => {
    if (!targetRenderer) return;
    const notify = typeof onArchetype === 'function'
      ? (shared, index) => {
        archetypes[index].impostorGroup = shared.impostorGroup;
        archetypes[index].impostorHalfH = shared.impostorHalfH;
        onArchetype(archetypes[index], index);
      }
      : null;
    if (notify) {
      entry.bakeListeners.add(notify);
      entry.archetypes.forEach((shared, index) => {
        if (shared.impostorGroup) notify(shared, index);
      });
    }
    if (!entry.bakePromise && entry.archetypes.some((arch) => !arch.impostorGroup)) {
      entry.bakePromise = (async () => {
        for (let index = 0; index < entry.archetypes.length; index += 1) {
          const archetype = entry.archetypes[index];
          if (archetype.impostorGroup) continue;
          const startedAt = performance.now();
          archetype.impostorGroup = await bakeImpostor(targetRenderer, archetype.lod1Group, {
            name: archetype.speciesName,
            lodName: 'LOD3',
            size: 512,
            yield: () => new Promise((resolve) => requestAnimationFrame(resolve)),
          });
          const card = archetype.impostorGroup.children.find((child) => child.userData?.isBillboardCard);
          card?.geometry?.computeBoundingBox?.();
          archetype.impostorHalfH = card?.geometry?.boundingBox?.max?.y ?? 8;
          entry.impostorBakeMs += performance.now() - startedAt;
          for (const listener of entry.bakeListeners) listener(archetype, index);
        }
      })().finally(() => {
        entry.bakePromise = null;
        trimArchetypeCache();
      });
    }

    try {
      await entry.bakePromise;
      for (let index = 0; index < archetypes.length; index += 1) {
        const shared = entry.archetypes[index];
        archetypes[index].impostorGroup = shared.impostorGroup;
        archetypes[index].impostorHalfH = shared.impostorHalfH;
      }
    } finally {
      if (notify) entry.bakeListeners.delete(notify);
    }
  };

  if (renderer && bakeImpostors) await ensureImpostors(renderer);

  return {
    archetypes,
    cacheHit,
    ensureImpostors,
    snapshot: () => ({
      forestArchetypeCacheHit: cacheHit,
      forestImpostorBakeMs: entry.impostorBakeMs,
      forestImpostorsReady: entry.archetypes.filter((arch) => !!arch.impostorGroup).length,
    }),
    dispose() {
      if (released) return;
      released = true;
      entry.refCount = Math.max(0, entry.refCount - 1);
      entry.lastUsed = performance.now();
      trimArchetypeCache();
    },
  };
}
