/** Gitignored local needle PBR (see data/forest-leaves/, npm run pull:forest-textures). */
export const FOREST_LEAVES_URL = '/assets/forest-leaves/';

export function forestBarkUrl(speciesId) {
  return `/assets/textures/forest/${speciesId}/`;
}

/** Per-species PBR filenames (underscore prefix derived from species id). */
export function speciesTexturePrefix(speciesId) {
  return String(speciesId).replace(/-/g, '_');
}

export function speciesTextureFiles(speciesId) {
  const p = speciesTexturePrefix(speciesId);
  return {
    bark: `${p}_albedo.png`,
    leaf: `${p}_needle_albedo.png`,
  };
}

/**
 * Per-species PBR install profiles. `sourceFamily` selects which SeedThree
 * upstream bark + needle set to pull (pine | douglas-fir | loblolly).
 * Optional leaf/bark hue/sat/scale tweaks differentiate catalog species.
 */
export const FOREST_SPECIES_TEXTURE_PROFILES = {
  pine: { sourceFamily: 'pine' },
  'douglas-fir': { sourceFamily: 'douglas-fir' },
  loblolly: { sourceFamily: 'loblolly' },
  'red-spruce': {
    sourceFamily: 'douglas-fir',
    leaf: { hue: 108, saturation: 0.82, brightness: 0.95 },
  },
  'sitka-spruce': {
    sourceFamily: 'douglas-fir',
    leaf: { hue: 112, saturation: 0.78, brightness: 1.02, scale: 1.06 },
  },
  'western-hemlock': {
    sourceFamily: 'douglas-fir',
    leaf: { hue: 118, saturation: 0.72, brightness: 1.0 },
  },
  'eastern-hemlock': {
    sourceFamily: 'douglas-fir',
    leaf: { hue: 105, saturation: 0.68, brightness: 0.94 },
    bark: { hue: 8, saturation: 0.9, brightness: 0.88 },
  },
  'deodar-cedar': {
    sourceFamily: 'douglas-fir',
    leaf: { hue: 125, saturation: 0.7, brightness: 1.05, scale: 1.08 },
  },
  'atlas-cedar': {
    sourceFamily: 'pine',
    leaf: { hue: 138, saturation: 0.62, brightness: 1.04, scale: 1.1 },
    bark: { hue: 20, saturation: 0.75, brightness: 0.9 },
  },
  'hicks-yew': {
    sourceFamily: 'douglas-fir',
    leaf: { hue: 95, saturation: 1.15, brightness: 0.62, scale: 0.82 },
  },
  'japanese-yew': {
    sourceFamily: 'douglas-fir',
    leaf: { hue: 92, saturation: 1.2, brightness: 0.58, scale: 0.8 },
  },
  'giant-sequoia': {
    sourceFamily: 'loblolly',
    leaf: { hue: 88, saturation: 0.75, brightness: 0.98, scale: 1.14 },
    bark: { hue: 12, saturation: 0.95, brightness: 0.85 },
  },
  'california-redwood': {
    sourceFamily: 'loblolly',
    leaf: { hue: 82, saturation: 0.7, brightness: 0.92, scale: 1.18 },
    bark: { hue: 18, saturation: 0.88, brightness: 0.82 },
  },
  'bald-cypress': {
    sourceFamily: 'douglas-fir',
    leaf: { hue: 100, saturation: 0.65, brightness: 1.08, scale: 0.92 },
  },
  'spartan-juniper': {
    sourceFamily: 'pine',
    leaf: { hue: 98, saturation: 1.1, brightness: 0.55, scale: 0.78 },
  },
  'sugar-pine': {
    sourceFamily: 'pine',
    leaf: { hue: 104, saturation: 0.85, brightness: 1.06, scale: 1.12 },
  },
  'red-pine': {
    sourceFamily: 'pine',
    leaf: { hue: 96, saturation: 0.9, brightness: 0.96, scale: 1.05 },
    bark: { hue: 6, saturation: 0.92, brightness: 0.9 },
  },
  'noble-fir': {
    sourceFamily: 'douglas-fir',
    leaf: { hue: 115, saturation: 0.8, brightness: 1.0, scale: 1.04 },
  },
  'western-larch': {
    sourceFamily: 'pine',
    leaf: { hue: 48, saturation: 0.55, brightness: 1.12, scale: 0.95 },
  },
};
