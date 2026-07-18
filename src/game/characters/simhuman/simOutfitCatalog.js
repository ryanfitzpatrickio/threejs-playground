/**
 * Authored sim outfits.
 *
 * Each outfit ships two GLB variants:
 *   standard — no morph targets, small file (default for lots / many NPCs)
 *   morph    — essential bulk morphs only (mass/muscle/fat), sparse+Draco
 *
 * Showcase wardrobe (charcoal / executive / cocktail) is first-class here.
 * Peasant + Ranger stay as fantasy defaults.
 *
 * Rebuild morph packs: `npm run bake:outfit-morphs`
 */

export const SIM_OUTFIT_VARIANTS = Object.freeze(['standard', 'morph']);

export const SIM_OUTFIT_ESSENTIAL_MORPHS = Object.freeze([
  'id.body.global.mass.neg',
  'id.body.global.mass.pos',
  'id.body.global.muscle.neg',
  'id.body.global.muscle.pos',
  'id.body.global.fat.pos',
]);

/** Legacy Meshy / import ids → clean showcase ids. */
export const SIM_OUTFIT_ALIASES = Object.freeze({
  'meshy-ai-headless-executive-0715021035-t': 'executive-suit',
  'meshy-ai-rose-gold-sequin-cock-071610251': 'rose-sequin-cocktail',
  test: 'charcoal-suit',
  'meshy-ai-charcoal-business-sui-071409275': 'charcoal-suit',
});

export const SIM_OUTFIT_OPTIONS = Object.freeze([
  Object.freeze({
    id: 'fantasy-peasant',
    name: 'Peasant',
    description: 'Layered village clothing with boots and wrapped details.',
    bodies: Object.freeze({
      male: Object.freeze({
        standard: '/assets/simoutfits/standard/male-peasant.glb',
        morph: '/assets/simoutfits/morph/male-peasant.glb',
      }),
      female: Object.freeze({
        standard: '/assets/simoutfits/standard/female-peasant.glb',
        morph: '/assets/simoutfits/morph/female-peasant.glb',
      }),
    }),
  }),
  Object.freeze({
    id: 'fantasy-ranger',
    name: 'Ranger',
    description: 'Hooded leather ranger kit with belts, bracers, and pauldrons.',
    bodies: Object.freeze({
      male: Object.freeze({
        standard: '/assets/simoutfits/standard/male-ranger.glb',
        morph: '/assets/simoutfits/morph/male-ranger.glb',
      }),
      female: Object.freeze({
        standard: '/assets/simoutfits/standard/female-ranger.glb',
        morph: '/assets/simoutfits/morph/female-ranger.glb',
      }),
    }),
  }),
  Object.freeze({
    id: 'charcoal-suit',
    name: 'Charcoal Suit',
    description: 'Charcoal business suit (showcase male).',
    bodies: Object.freeze({
      male: Object.freeze({
        standard: '/assets/simoutfits/standard/charcoal-suit.glb',
        morph: '/assets/simoutfits/morph/charcoal-suit.glb',
      }),
    }),
  }),
  Object.freeze({
    id: 'executive-suit',
    name: 'Executive Suit',
    description: 'Headless executive suit for the Base (human5) body.',
    bodies: Object.freeze({
      human5: Object.freeze({
        standard: '/assets/simoutfits/standard/executive-suit.glb',
        morph: '/assets/simoutfits/morph/executive-suit.glb',
      }),
    }),
  }),
  Object.freeze({
    id: 'rose-sequin-cocktail',
    name: 'Rose Sequin Cocktail',
    description: 'Rose-gold sequin cocktail dress (showcase female).',
    bodies: Object.freeze({
      female: Object.freeze({
        standard: '/assets/simoutfits/standard/rose-sequin-cocktail.glb',
        morph: '/assets/simoutfits/morph/rose-sequin-cocktail.glb',
      }),
    }),
  }),
]);

const BY_ID = new Map(SIM_OUTFIT_OPTIONS.map((outfit) => [outfit.id, outfit]));

/** Draft imports from Outfit Import Studio (dev bake). Merged at runtime. */
const IMPORT_BY_ID = new Map();
const PROMOTED_BY_ID = new Map();
let importManifestPromise = null;
let promotedManifestPromise = null;

function normalizeOutfitId(id) {
  if (!id) return null;
  return SIM_OUTFIT_ALIASES[id] ?? id;
}

function normalizeImportEntry(raw) {
  if (!raw?.id || !raw?.bodies) return null;
  const id = normalizeOutfitId(raw.id) || raw.id;
  return Object.freeze({
    id,
    name: raw.name || id,
    description: raw.description || 'Imported draft',
    imported: true,
    bodies: raw.bodies,
  });
}

function normalizePromotedEntry(raw) {
  if (!raw?.id || !raw?.bodies) return null;
  const id = normalizeOutfitId(raw.id) || raw.id;
  return Object.freeze({
    id,
    name: raw.name || id,
    description: raw.description || 'Promoted import',
    promoted: true,
    bodies: raw.bodies,
  });
}

/**
 * Load /assets/simoutfits/_import/manifest.json once (browser).
 * Safe no-op in non-browser / missing file.
 */
export function loadSimOutfitImportManifest() {
  if (typeof fetch !== 'function') return Promise.resolve([]);
  if (importManifestPromise) return importManifestPromise;
  importManifestPromise = fetch('/assets/simoutfits/_import/manifest.json', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : { entries: [] }))
    .then((doc) => {
      IMPORT_BY_ID.clear();
      const entries = [];
      for (const raw of doc?.entries ?? []) {
        const entry = normalizeImportEntry(raw);
        if (!entry) continue;
        IMPORT_BY_ID.set(entry.id, entry);
        entries.push(entry);
      }
      return entries;
    })
    .catch(() => []);
  return importManifestPromise;
}

/** Load deployable outfits created by Import Studio's Promote action. */
export function loadSimOutfitPromotedManifest() {
  if (typeof fetch !== 'function') return Promise.resolve([]);
  if (promotedManifestPromise) return promotedManifestPromise;
  promotedManifestPromise = fetch('/assets/simoutfits/manifest.json', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : { entries: [] }))
    .then((doc) => {
      PROMOTED_BY_ID.clear();
      const entries = [];
      for (const raw of doc?.entries ?? []) {
        const entry = normalizePromotedEntry(raw);
        if (!entry) continue;
        PROMOTED_BY_ID.set(entry.id, entry);
        entries.push(entry);
      }
      return entries;
    })
    .catch(() => []);
  return promotedManifestPromise;
}

/** Inject / replace a single import entry after a bake (no full reload). */
export function registerSimOutfitImport(entry) {
  const normalized = normalizeImportEntry(entry);
  if (!normalized) return null;
  IMPORT_BY_ID.set(normalized.id, normalized);
  return normalized;
}

/** Inject / replace a promoted entry immediately after the server copies it. */
export function registerSimOutfitPromoted(entry) {
  const normalized = normalizePromotedEntry(entry);
  if (!normalized) return null;
  PROMOTED_BY_ID.set(normalized.id, normalized);
  return normalized;
}

export function listSimOutfitImports() {
  return [...IMPORT_BY_ID.values()];
}

export function listSimOutfitOptions() {
  const byId = new Map(SIM_OUTFIT_OPTIONS.map((outfit) => [outfit.id, outfit]));
  for (const outfit of PROMOTED_BY_ID.values()) byId.set(outfit.id, outfit);
  return [...byId.values()];
}

export function getSimOutfitDefinition(id) {
  const resolved = normalizeOutfitId(id);
  if (!resolved) return null;
  const catalog = BY_ID.get(resolved);
  const promoted = PROMOTED_BY_ID.get(resolved);
  const imported = IMPORT_BY_ID.get(resolved);
  if (!catalog && !promoted && !imported) return null;
  // Merge body maps so a Male promotion and a Base draft can share one logical id.
  const bodies = {
    ...(catalog?.bodies ?? {}),
    ...(promoted?.bodies ?? {}),
    ...(imported?.bodies ?? {}),
  };
  return {
    id: resolved,
    name: imported?.name || promoted?.name || catalog?.name || resolved,
    description: imported?.description || promoted?.description || catalog?.description || '',
    promoted: Boolean(promoted),
    imported: Boolean(imported),
    bodies,
  };
}

export function isSimOutfitId(id) {
  const resolved = normalizeOutfitId(id);
  return typeof resolved === 'string'
    && (PROMOTED_BY_ID.has(resolved) || BY_ID.has(resolved) || IMPORT_BY_ID.has(resolved));
}

export function isSimOutfitVariant(variant) {
  return variant === 'standard' || variant === 'morph';
}

/**
 * Resolve outfit asset URL for a body + variant.
 * @param {string} id
 * @param {string} body 'male' | 'female' | 'human5'
 * @param {{ variant?: 'standard'|'morph' }} [options]
 *   default variant is 'morph' (fit-enabled). Use 'standard' for small downloads.
 */
export function resolveSimOutfitAsset(id, body, options = {}) {
  const definition = getSimOutfitDefinition(id);
  const entry = definition?.bodies?.[body];
  if (!definition || !entry) return null;

  const variant = isSimOutfitVariant(options.variant) ? options.variant : 'morph';
  // Support legacy flat string URLs if a catalog entry was not migrated.
  let url = typeof entry === 'string' ? entry : (entry[variant] ?? entry.morph ?? entry.standard);
  if (!url) return null;
  // Strip cache-bust for morph detection; keep full url for load.
  const hasMorphTargets = variant === 'morph' && !String(url).includes('.raw.');

  return {
    ...definition,
    body,
    variant,
    url,
    hasMorphTargets,
  };
}

// Kick off manifest fetch early in the browser.
if (typeof window !== 'undefined') {
  loadSimOutfitImportManifest();
  loadSimOutfitPromotedManifest();
}
