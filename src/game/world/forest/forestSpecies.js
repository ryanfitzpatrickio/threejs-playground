import { pine } from './seedthree/species/pine.js';
import { douglasFir } from './seedthree/species/douglas-fir.js';
import { loblolly } from './seedthree/species/loblolly.js';
import {
  redSpruce,
  sitkaSpruce,
  westernHemlock,
  easternHemlock,
  deodarCedar,
  atlasCedar,
  hicksYew,
  japaneseYew,
  giantSequoia,
  californiaRedwood,
  baldCypress,
  spartanJuniper,
  sugarPine,
  redPine,
  nobleFir,
  westernLarch,
} from './seedthree/species/coniferPresets.js';

/** Species presets vendored from [SkyeShark/SeedThree](https://github.com/SkyeShark/SeedThree). */
export const FOREST_SPECIES = {
  pine: { label: 'Ponderosa Pine', preset: pine },
  'douglas-fir': { label: 'Douglas Fir', preset: douglasFir },
  loblolly: { label: 'Loblolly Pine', preset: loblolly },
  'red-spruce': { label: 'Red Spruce', preset: redSpruce },
  'sitka-spruce': { label: 'Sitka Spruce', preset: sitkaSpruce },
  'western-hemlock': { label: 'Western Hemlock', preset: westernHemlock },
  'eastern-hemlock': { label: 'Eastern Hemlock', preset: easternHemlock },
  'deodar-cedar': { label: 'Deodar Cedar', preset: deodarCedar },
  'atlas-cedar': { label: 'Atlas Cedar', preset: atlasCedar },
  'hicks-yew': { label: "Hick's Yew", preset: hicksYew },
  'japanese-yew': { label: 'Japanese Yew', preset: japaneseYew },
  'giant-sequoia': { label: 'Giant Sequoia', preset: giantSequoia },
  'california-redwood': { label: 'California Redwood', preset: californiaRedwood },
  'bald-cypress': { label: 'Bald Cypress', preset: baldCypress },
  'spartan-juniper': { label: 'Spartan Juniper', preset: spartanJuniper },
  'sugar-pine': { label: 'Sugar Pine', preset: sugarPine },
  'red-pine': { label: 'Red Pine', preset: redPine },
  'noble-fir': { label: 'Noble Fir', preset: nobleFir },
  'western-larch': { label: 'Western Larch', preset: westernLarch },
};

export const FOREST_SPECIES_ORDER = [
  'pine',
  'douglas-fir',
  'loblolly',
  'red-spruce',
  'sitka-spruce',
  'western-hemlock',
  'eastern-hemlock',
  'deodar-cedar',
  'atlas-cedar',
  'noble-fir',
  'sugar-pine',
  'red-pine',
  'giant-sequoia',
  'california-redwood',
  'western-larch',
  'bald-cypress',
  'spartan-juniper',
  'hicks-yew',
  'japanese-yew',
];

const ALIASES = {
  fir: 'douglas-fir',
  douglas_fir: 'douglas-fir',
  douglasfir: 'douglas-fir',
  spruce: 'red-spruce',
  hemlock: 'western-hemlock',
  cedar: 'deodar-cedar',
  yew: 'japanese-yew',
  sequoia: 'giant-sequoia',
  redwood: 'california-redwood',
  cypress: 'bald-cypress',
  juniper: 'spartan-juniper',
  larch: 'western-larch',
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
