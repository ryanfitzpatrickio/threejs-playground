import { pine } from './seedthree/species/pine.js';
import { douglasFir } from './seedthree/species/douglas-fir.js';
import { loblolly } from './seedthree/species/loblolly.js';

/** Species presets vendored from [SkyeShark/SeedThree](https://github.com/SkyeShark/SeedThree). */
export const FOREST_SPECIES = {
  pine: { label: 'Ponderosa Pine', preset: pine },
  'douglas-fir': { label: 'Douglas Fir', preset: douglasFir },
  loblolly: { label: 'Loblolly Pine', preset: loblolly },
};

export const FOREST_SPECIES_ORDER = ['pine', 'douglas-fir', 'loblolly'];

const ALIASES = {
  fir: 'douglas-fir',
  douglas_fir: 'douglas-fir',
  douglasfir: 'douglas-fir',
};

export function normalizeForestSpecies(key = 'pine') {
  const raw = String(key ?? 'pine').trim().toLowerCase();
  const aliased = ALIASES[raw] ?? raw;
  return FOREST_SPECIES[aliased] ? aliased : 'pine';
}

export function getForestSpecies(key = 'pine') {
  return FOREST_SPECIES[normalizeForestSpecies(key)].preset;
}

/**
 * Parse zone.props.species — single key or mix like `pine:0.7,douglas-fir:0.3`.
 * @returns {Array<{ key: string, weight: number }>}
 */
export function parseForestSpeciesMix(speciesProp) {
  if (!speciesProp || typeof speciesProp !== 'string' || !speciesProp.includes(':')) {
    return [{ key: normalizeForestSpecies(speciesProp), weight: 1 }];
  }
  const entries = [];
  for (const part of speciesProp.split(',')) {
    const [rawKey, rawWeight] = part.split(':').map((s) => s.trim());
    const weight = Number(rawWeight);
    if (!rawKey || !Number.isFinite(weight) || weight <= 0) continue;
    entries.push({ key: normalizeForestSpecies(rawKey), weight });
  }
  return entries.length ? entries : [{ key: 'pine', weight: 1 }];
}

export function pickSpeciesFromMix(mix, rng) {
  const total = mix.reduce((s, e) => s + e.weight, 0);
  let roll = rng() * total;
  for (const entry of mix) {
    roll -= entry.weight;
    if (roll <= 0) return entry.key;
  }
  return mix[mix.length - 1].key;
}
