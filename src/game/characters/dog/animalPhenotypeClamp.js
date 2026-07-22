/**
 * AI Animal Compiler: validate, clamp, and merge AnimalPhenotype recipes
 * onto the shared quadruped runtime phenotype.
 *
 * Clamps apply only to recipe / AI input — never to catalog
 * `resolveDogPhenotype({ breedId })` reads.
 */

import { getDogBreed } from './dogCatalog.js';
import { DOG_PHENOTYPE_PROFILES, normalizeDogSeed } from './dogPhenotypes.js';
import {
  ANIMAL_COAT_FIBERS,
  ANIMAL_COAT_PATTERNS,
  ANIMAL_EAR_FOLDS,
  ANIMAL_EAR_TYPES,
  ANIMAL_EYE_STYLES,
  ANIMAL_FOOT_TYPES,
  ANIMAL_GROOMING,
  ANIMAL_HEADGEAR_TYPES,
  ANIMAL_NUMERIC_RANGES,
  ANIMAL_SCHEMA_VERSION,
  ANIMAL_TAIL_TYPES,
  ANIMAL_TEMPLATES,
  PATTERN_ALIASES,
  TEMPLATE_BASE_ID,
  TEMPLATE_DEFAULT_PATTERN,
  TEMPLATE_FAMILY,
  TEMPLATE_SPECIES,
} from './animalPhenotypeEnums.js';
import { getDogFamily } from './dogCatalog.js';

const COAT_PATTERN_SET = new Set(ANIMAL_COAT_PATTERNS);
const EAR_TYPE_SET = new Set(ANIMAL_EAR_TYPES);
const EAR_FOLD_SET = new Set(ANIMAL_EAR_FOLDS);
const TAIL_TYPE_SET = new Set(ANIMAL_TAIL_TYPES);
const GROOMING_SET = new Set(ANIMAL_GROOMING);
const TEMPLATE_SET = new Set(ANIMAL_TEMPLATES);
const FOOT_TYPE_SET = new Set(ANIMAL_FOOT_TYPES);
const EYE_STYLE_SET = new Set(ANIMAL_EYE_STYLES);
const HEADGEAR_TYPE_SET = new Set(ANIMAL_HEADGEAR_TYPES);
const FIBER_SET = new Set(ANIMAL_COAT_FIBERS);

const SECTION_KEYS = Object.freeze([
  'skeleton',
  'geometry',
  'ears',
  'tail',
  'face',
  'coat',
  'furnishings',
  'motion',
  'variation',
  'extremities',
  'headgear',
]);

const FACE_COLOR_KEYS = Object.freeze([
  'irisColor',
  'irisColorL',
  'irisColorR',
  'lidColor',
  'lidDarkColor',
  'noseColor',
  'noseBlendColor',
]);

const DEFAULT_PERSONALITY = Object.freeze({
  energy: 3,
  trainability: 3,
  sociability: 3,
  vigilance: 3,
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function cloneSection(section) {
  if (!section || typeof section !== 'object') return {};
  const out = { ...section };
  if (section.palette && typeof section.palette === 'object') {
    out.palette = { ...section.palette };
  }
  return out;
}

function diag(diagnostics, level, code, message) {
  diagnostics.push({ level, code, message });
}

/** @returns {boolean} */
export function isAnimalRefusal(obj) {
  return Boolean(obj && typeof obj === 'object' && obj.refuse === true);
}

/**
 * Parse #rrggbb / 0xrrggbb / number → 0xRRGGBB integer, or null if invalid.
 * @param {unknown} input
 * @returns {number | null}
 */
export function parseColorToHex(input) {
  if (input == null || input === '') return null;
  if (typeof input === 'number' && Number.isFinite(input)) {
    const n = Math.trunc(input);
    if (n < 0 || n > 0xffffff) return null;
    return n >>> 0;
  }
  const raw = String(input).trim();
  if (/^0x[0-9a-fA-F]{1,6}$/.test(raw)) {
    return Number.parseInt(raw.slice(2), 16) >>> 0;
  }
  const hex = raw.startsWith('#') ? raw.slice(1) : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  return Number.parseInt(hex, 16) >>> 0;
}

/** Author-facing hex string for export. */
export function colorToCssHex(value) {
  const n = parseColorToHex(value);
  if (n == null) return null;
  return `#${n.toString(16).padStart(6, '0')}`;
}

/**
 * @param {string} requested
 * @param {string} [template]
 * @returns {{ pattern: string, aliasedFrom?: string }}
 */
export function nearestCoatPattern(requested, template = 'generic-quad') {
  const raw = String(requested ?? '').trim().toLowerCase().replace(/_/g, '-');
  if (!raw) {
    return { pattern: TEMPLATE_DEFAULT_PATTERN[template] ?? 'solid' };
  }
  if (COAT_PATTERN_SET.has(raw)) return { pattern: raw };
  if (PATTERN_ALIASES[raw]) {
    return { pattern: PATTERN_ALIASES[raw], aliasedFrom: raw };
  }
  // Soft nearest: substring match against known patterns / aliases.
  for (const [alias, pattern] of Object.entries(PATTERN_ALIASES)) {
    if (raw.includes(alias) || alias.includes(raw)) {
      return { pattern, aliasedFrom: raw };
    }
  }
  for (const pattern of ANIMAL_COAT_PATTERNS) {
    if (raw.includes(pattern) || pattern.includes(raw)) {
      return { pattern, aliasedFrom: raw };
    }
  }
  return {
    pattern: TEMPLATE_DEFAULT_PATTERN[template] ?? 'solid',
    aliasedFrom: raw,
  };
}

/**
 * Kebab-case slug for recipe name / breedId (no colon; store-id safe).
 * @param {unknown} value
 * @param {string} [fallback]
 */
export function slugifyAnimalName(value, fallback = 'custom-animal') {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return raw || fallback;
}

function titleCaseSlug(slug) {
  return String(slug)
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function rangeFor(path) {
  return ANIMAL_NUMERIC_RANGES[path] ?? null;
}

function clampPath(section, key, path, fallback, diagnostics) {
  const r = rangeFor(path);
  if (!r) {
    const n = Number(section[key]);
    return Number.isFinite(n) ? n : fallback;
  }
  const raw = section[key];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    diag(diagnostics, 'warn', 'invalid_number', `${path} invalid; using base`);
    return fallback;
  }
  const clamped = Math.min(r.max, Math.max(r.min, n));
  if (clamped !== n) {
    diag(diagnostics, 'info', 'clamped_number', `${path}: ${n} → ${clamped}`);
  }
  return clamped;
}

function mergeNumericSection(baseSection, recipeSection, sectionName, diagnostics) {
  const out = cloneSection(baseSection);
  if (!recipeSection || typeof recipeSection !== 'object') return out;

  for (const [key, value] of Object.entries(recipeSection)) {
    if (value === undefined) continue;
    if (key === 'palette' || key === 'type' || key === 'fold' || key === 'pattern' || key === 'grooming') {
      continue;
    }
    if (FACE_COLOR_KEYS.includes(key)) continue;
    const path = `${sectionName}.${key}`;
    const fallback = out[key];
    if (typeof fallback === 'number' || rangeFor(path)) {
      out[key] = clampPath(recipeSection, key, path, fallback ?? 1, diagnostics);
    } else if (typeof value === 'number') {
      out[key] = value;
    }
  }
  return out;
}

function resolveTemplate(rawTemplate, diagnostics) {
  const t = String(rawTemplate ?? '').trim().toLowerCase();
  if (TEMPLATE_SET.has(t)) return t;
  diag(diagnostics, 'warn', 'unknown_template', `Unknown template "${rawTemplate}"; using generic-quad`);
  return 'generic-quad';
}

function resolveEarType(type, baseType, diagnostics) {
  const t = String(type ?? '').trim().toLowerCase();
  if (EAR_TYPE_SET.has(t)) return t;
  if (type != null) {
    diag(diagnostics, 'warn', 'unknown_ear_type', `Unknown ear type "${type}"; using ${baseType}`);
  }
  return EAR_TYPE_SET.has(baseType) ? baseType : 'floppy';
}

function resolveEarFold(fold, baseFold, diagnostics) {
  if (fold == null || fold === '') return baseFold;
  const t = String(fold).trim().toLowerCase();
  if (EAR_FOLD_SET.has(t)) return t;
  diag(diagnostics, 'warn', 'unknown_ear_fold', `Unknown ear fold "${fold}"; using ${baseFold ?? 'drop'}`);
  return baseFold ?? 'drop';
}

function resolveTailType(type, baseType, diagnostics) {
  const t = String(type ?? '').trim().toLowerCase();
  if (TAIL_TYPE_SET.has(t)) return t;
  if (type != null) {
    diag(diagnostics, 'warn', 'unknown_tail_type', `Unknown tail type "${type}"; using ${baseType}`);
  }
  return TAIL_TYPE_SET.has(baseType) ? baseType : 'plume';
}

function resolveGrooming(grooming, baseGrooming, diagnostics) {
  if (grooming == null || grooming === '') return baseGrooming;
  const t = String(grooming).trim().toLowerCase();
  if (GROOMING_SET.has(t)) return t;
  diag(diagnostics, 'warn', 'unknown_grooming', `Unknown grooming "${grooming}"; using ${baseGrooming}`);
  return baseGrooming ?? 'smooth';
}

function resolveEnum(value, allowed, fallback, diagnostics, code, label) {
  if (value == null || value === '') return fallback;
  const t = String(value).trim().toLowerCase();
  if (allowed.has(t)) return t;
  diag(diagnostics, 'warn', code, `Unknown ${label} "${value}"; using ${fallback}`);
  return fallback;
}

function mergePalette(basePalette, recipePalette, diagnostics) {
  const out = { ...basePalette };
  if (!recipePalette || typeof recipePalette !== 'object') return out;
  for (const [key, value] of Object.entries(recipePalette)) {
    if (value === undefined || value === null) continue;
    const parsed = parseColorToHex(value);
    if (parsed == null) {
      diag(diagnostics, 'warn', 'invalid_color', `coat.palette.${key} invalid; keeping base`);
      continue;
    }
    out[key] = parsed;
  }
  return out;
}

function mergeFace(baseFace, recipeFace, diagnostics) {
  const out = mergeNumericSection(baseFace, recipeFace, 'face', diagnostics);
  out.eyeStyle = resolveEnum(
    recipeFace?.eyeStyle ?? baseFace.eyeStyle,
    EYE_STYLE_SET,
    baseFace.eyeStyle ?? 'canid',
    diagnostics,
    'unknown_eye_style',
    'eyeStyle',
  );
  if (!recipeFace || typeof recipeFace !== 'object') return out;

  for (const key of FACE_COLOR_KEYS) {
    if (!(key in recipeFace)) continue;
    const value = recipeFace[key];
    if (value === null || value === undefined || value === '') {
      // Explicit null drops dual-iris override so base/single iris applies.
      if (key === 'irisColorL' || key === 'irisColorR') {
        delete out[key];
      }
      continue;
    }
    const parsed = parseColorToHex(value);
    if (parsed == null) {
      diag(diagnostics, 'warn', 'invalid_color', `face.${key} invalid; keeping base`);
      continue;
    }
    out[key] = parsed;
  }

  // Dual iris only when both sides valid after merge.
  const hasL = out.irisColorL != null && Number.isFinite(out.irisColorL);
  const hasR = out.irisColorR != null && Number.isFinite(out.irisColorR);
  if (hasL !== hasR) {
    diag(diagnostics, 'info', 'partial_dual_iris', 'Only one of irisColorL/R set; using single irisColor');
    if (!hasL) delete out.irisColorL;
    if (!hasR) delete out.irisColorR;
  }

  return out;
}

function resolvePersonality(recipe, baseBreedId, diagnostics) {
  if (recipe.personality && typeof recipe.personality === 'object') {
    const p = recipe.personality;
    return {
      energy: clampNumber(p.energy, 1, 5, DEFAULT_PERSONALITY.energy),
      trainability: clampNumber(p.trainability, 1, 5, DEFAULT_PERSONALITY.trainability),
      sociability: clampNumber(p.sociability, 1, 5, DEFAULT_PERSONALITY.sociability),
      vigilance: clampNumber(p.vigilance, 1, 5, DEFAULT_PERSONALITY.vigilance),
    };
  }
  if (baseBreedId) {
    const breedInfo = getDogBreed(baseBreedId);
    if (breedInfo?.behavior) {
      return {
        energy: breedInfo.behavior.energy ?? 3,
        trainability: breedInfo.behavior.trainability ?? 3,
        sociability: breedInfo.behavior.sociability ?? 3,
        vigilance: breedInfo.behavior.vigilance ?? 3,
      };
    }
  }
  return { ...DEFAULT_PERSONALITY };
}

function seededValues(seed, count) {
  if (seed === 1) return Array(count).fill(0);
  let state = seed || 0x6d2b79f5;
  const values = [];
  for (let i = 0; i < count; i += 1) {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    values.push((((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1);
  }
  return values;
}

function tintHex(hex, amount) {
  const r = (hex >> 16) & 255;
  const g = (hex >> 8) & 255;
  const b = hex & 255;
  const factor = 1 + amount;
  return ((Math.max(0, Math.min(255, Math.round(r * factor))) << 16)
    | (Math.max(0, Math.min(255, Math.round(g * factor))) << 8)
    | Math.max(0, Math.min(255, Math.round(b * factor))));
}

/**
 * Author-facing recipe with hex palette for export / multipass feedback.
 */
export function phenotypeToAuthorRecipe(phenotype) {
  if (!phenotype) return null;
  const palette = phenotype.coat?.palette ?? {};
  const face = phenotype.face ?? {};
  const faceOut = { ...face };
  for (const key of FACE_COLOR_KEYS) {
    if (face[key] == null) {
      delete faceOut[key];
      continue;
    }
    const css = colorToCssHex(face[key]);
    if (css) faceOut[key] = css;
    else delete faceOut[key];
  }
  return {
    schemaVersion: ANIMAL_SCHEMA_VERSION,
    template: phenotype.template ?? 'generic-quad',
    name: phenotype.recipeName ?? phenotype.breedId,
    label: phenotype.label ?? titleCaseSlug(phenotype.breedId),
    familyId: phenotype.familyId,
    baseBreedId: phenotype.baseBreedId ?? undefined,
    seed: phenotype.seed ?? 1,
    skeleton: { ...phenotype.skeleton },
    geometry: { ...phenotype.geometry },
    ears: { ...phenotype.ears },
    tail: { ...phenotype.tail },
    face: faceOut,
    coat: {
      ...phenotype.coat,
      palette: {
        undercoat: colorToCssHex(palette.undercoat) ?? '#888888',
        ...(palette.midcoat != null ? { midcoat: colorToCssHex(palette.midcoat) } : {}),
        guard: colorToCssHex(palette.guard) ?? '#444444',
        root: colorToCssHex(palette.root) ?? '#666666',
        tip: colorToCssHex(palette.tip) ?? '#aaaaaa',
      },
    },
    furnishings: { ...phenotype.furnishings },
    extremities: { ...(phenotype.extremities ?? {}) },
    headgear: (() => {
      const hg = { ...(phenotype.headgear ?? {}) };
      if (hg.color != null) hg.color = colorToCssHex(hg.color) ?? hg.color;
      if (hg.tipColor != null) hg.tipColor = colorToCssHex(hg.tipColor) ?? hg.tipColor;
      return hg;
    })(),
    motion: { ...phenotype.motion },
    personality: { ...phenotype.personality },
    variation: { ...phenotype.variation },
  };
}

/**
 * Resolve merge base without normalizeRenderableDogBreedId.
 * @returns {{
 *   baseProfile: object,
 *   mergeBaseId: string,
 *   requestedBaseBreedId: string | null,
 *   template: string,
 * }}
 */
function resolveMergeBase(recipe, diagnostics) {
  const template = resolveTemplate(recipe.template, diagnostics);
  let baseProfile = null;
  let mergeBaseId = TEMPLATE_BASE_ID[template] ?? 'golden-retriever';
  let requestedBaseBreedId = null;

  if (recipe.baseBreedId != null && String(recipe.baseBreedId).trim()) {
    const key = String(recipe.baseBreedId).trim().toLowerCase();
    requestedBaseBreedId = key;
    baseProfile = DOG_PHENOTYPE_PROFILES[key] ?? null;
    if (baseProfile) {
      mergeBaseId = key;
    } else {
      diag(
        diagnostics,
        'warn',
        'unknown_baseBreedId',
        `baseBreedId "${recipe.baseBreedId}" not in DOG_PHENOTYPE_PROFILES; using template base`,
      );
    }
  }

  if (!baseProfile) {
    baseProfile = DOG_PHENOTYPE_PROFILES[mergeBaseId]
      ?? DOG_PHENOTYPE_PROFILES['golden-retriever'];
    if (!DOG_PHENOTYPE_PROFILES[mergeBaseId]) {
      mergeBaseId = 'golden-retriever';
    }
  }

  return { baseProfile, mergeBaseId, requestedBaseBreedId, template };
}

/**
 * Core merge algorithm (§1.4). Never calls normalizeRenderableDogBreedId.
 *
 * @param {object} rawRecipe
 * @param {{ seed?: number }} [opts]
 */
export function resolveDogPhenotypeFromRecipe(rawRecipe, opts = {}) {
  const diagnostics = [];
  if (!rawRecipe || typeof rawRecipe !== 'object') {
    throw new Error('resolveDogPhenotypeFromRecipe: recipe must be an object');
  }
  if (isAnimalRefusal(rawRecipe)) {
    throw new Error(rawRecipe.error || 'Animal recipe refused');
  }

  const name = slugifyAnimalName(rawRecipe.name ?? rawRecipe.id, 'custom-animal');
  const label = rawRecipe.label != null && String(rawRecipe.label).trim()
    ? String(rawRecipe.label).trim().slice(0, 64)
    : titleCaseSlug(name);

  const { baseProfile, mergeBaseId, requestedBaseBreedId, template } = resolveMergeBase(
    rawRecipe,
    diagnostics,
  );

  // Deep-merge sections: recipe wins when present.
  const skeleton = mergeNumericSection(baseProfile.skeleton, rawRecipe.skeleton, 'skeleton', diagnostics);
  const geometry = mergeNumericSection(baseProfile.geometry, rawRecipe.geometry, 'geometry', diagnostics);

  const earsBase = cloneSection(baseProfile.ears);
  const earsRecipe = rawRecipe.ears && typeof rawRecipe.ears === 'object' ? rawRecipe.ears : null;
  const ears = mergeNumericSection(earsBase, earsRecipe, 'ears', diagnostics);
  ears.type = resolveEarType(earsRecipe?.type ?? earsBase.type, earsBase.type, diagnostics);
  if (ears.type === 'folded' || earsRecipe?.fold != null || earsBase.fold != null) {
    const fold = resolveEarFold(earsRecipe?.fold, earsBase.fold, diagnostics);
    if (fold) ears.fold = fold;
  }

  const tailBase = cloneSection(baseProfile.tail);
  const tailRecipe = rawRecipe.tail && typeof rawRecipe.tail === 'object' ? rawRecipe.tail : null;
  const tail = mergeNumericSection(tailBase, tailRecipe, 'tail', diagnostics);
  tail.type = resolveTailType(tailRecipe?.type ?? tailBase.type, tailBase.type, diagnostics);

  const face = mergeFace(baseProfile.face, rawRecipe.face, diagnostics);

  const coatBase = cloneSection(baseProfile.coat);
  const coatRecipe = rawRecipe.coat && typeof rawRecipe.coat === 'object' ? rawRecipe.coat : {};
  const coat = mergeNumericSection(coatBase, coatRecipe, 'coat', diagnostics);
  coat.grooming = resolveGrooming(coatRecipe.grooming, coatBase.grooming, diagnostics);
  const patternSource = coatRecipe.pattern ?? coatBase.pattern;
  const patternResult = nearestCoatPattern(patternSource, template);
  if (patternResult.aliasedFrom && patternResult.pattern !== patternResult.aliasedFrom) {
    diag(
      diagnostics,
      'info',
      'pattern_alias',
      `pattern "${patternResult.aliasedFrom}" → "${patternResult.pattern}"`,
    );
  }
  coat.pattern = patternResult.pattern;
  coat.palette = mergePalette(coatBase.palette, coatRecipe.palette, diagnostics);
  coat.fiber = resolveEnum(
    coatRecipe.fiber ?? coatBase.fiber,
    FIBER_SET,
    coatBase.fiber ?? 'soft',
    diagnostics,
    'unknown_coat_fiber',
    'coat.fiber',
  );

  const furnishings = mergeNumericSection(
    baseProfile.furnishings,
    rawRecipe.furnishings,
    'furnishings',
    diagnostics,
  );

  const extremitiesBase = cloneSection(baseProfile.extremities ?? {
    foot: 'paw', hoofSize: 1, dewclaw: 0, bareBelow: 0.75,
  });
  const extremitiesRecipe = rawRecipe.extremities && typeof rawRecipe.extremities === 'object'
    ? rawRecipe.extremities
    : null;
  const extremities = mergeNumericSection(
    extremitiesBase,
    extremitiesRecipe,
    'extremities',
    diagnostics,
  );
  extremities.foot = resolveEnum(
    extremitiesRecipe?.foot ?? extremitiesBase.foot,
    FOOT_TYPE_SET,
    extremitiesBase.foot ?? 'paw',
    diagnostics,
    'unknown_foot_type',
    'extremities.foot',
  );

  const headgearBase = cloneSection(baseProfile.headgear ?? {
    type: 'none', length: 1, curl: 0.5, spread: 1, thickness: 1,
    color: 0xe8dcc8, tipColor: 0xc4b49a,
  });
  const headgearRecipe = rawRecipe.headgear && typeof rawRecipe.headgear === 'object'
    ? rawRecipe.headgear
    : null;
  const headgear = mergeNumericSection(headgearBase, headgearRecipe, 'headgear', diagnostics);
  headgear.type = resolveEnum(
    headgearRecipe?.type ?? headgearBase.type,
    HEADGEAR_TYPE_SET,
    headgearBase.type ?? 'none',
    diagnostics,
    'unknown_headgear_type',
    'headgear.type',
  );
  for (const colorKey of ['color', 'tipColor']) {
    if (headgearRecipe?.[colorKey] != null) {
      const parsed = parseColorToHex(headgearRecipe[colorKey]);
      if (parsed != null) headgear[colorKey] = parsed;
    } else if (headgearBase[colorKey] != null) {
      headgear[colorKey] = headgearBase[colorKey];
    }
  }

  const motion = mergeNumericSection(baseProfile.motion, rawRecipe.motion, 'motion', diagnostics);
  const variation = mergeNumericSection(
    baseProfile.variation,
    rawRecipe.variation,
    'variation',
    diagnostics,
  );

  let personality = resolvePersonality(rawRecipe, mergeBaseId, diagnostics);

  const resolvedSeed = normalizeDogSeed(opts.seed ?? rawRecipe.seed ?? 1);
  const [sizeV, buildV, shadeV, coatV, energyV, trainV] = seededValues(resolvedSeed, 6);
  const v = variation;

  // Seed noise (same contract as catalog): types never mutated; continuous only.
  skeleton.scale = skeleton.scale * (1 + sizeV * v.scale);
  skeleton.chestWidth = skeleton.chestWidth * (1 + buildV * v.build);
  skeleton.hipWidth = skeleton.hipWidth * (1 + buildV * v.build * 0.75);
  geometry.torsoWidth = geometry.torsoWidth * (1 + buildV * v.build);
  geometry.torsoDepth = geometry.torsoDepth * (1 + buildV * v.build * 0.6);
  coat.length = coat.length * (1 + coatV * v.coatLength);
  coat.palette = Object.fromEntries(
    Object.entries(coat.palette).map(([key, hex]) => [key, tintHex(hex, shadeV * v.coatShade)]),
  );
  personality = {
    ...personality,
    energy: Math.max(1, Math.min(5, personality.energy + energyV * v.energy)),
    trainability: Math.max(1, Math.min(5, personality.trainability + trainV * v.trainability)),
  };

  // Re-clamp scale/zones after seed noise so extremes stay in recipe band.
  skeleton.scale = clampNumber(
    skeleton.scale,
    ANIMAL_NUMERIC_RANGES['skeleton.scale'].min,
    ANIMAL_NUMERIC_RANGES['skeleton.scale'].max,
    skeleton.scale,
  );
  coat.length = clampNumber(
    coat.length,
    ANIMAL_NUMERIC_RANGES['coat.length'].min,
    ANIMAL_NUMERIC_RANGES['coat.length'].max,
    coat.length,
  );

  const familyId = rawRecipe.familyId != null && String(rawRecipe.familyId).trim()
    ? String(rawRecipe.familyId).trim().toLowerCase()
    : (TEMPLATE_FAMILY[template] ?? 'retriever-sporting');
  const familyInfo = getDogFamily(familyId);
  const speciesId = rawRecipe.speciesId != null && String(rawRecipe.speciesId).trim()
    ? String(rawRecipe.speciesId).trim().toLowerCase()
    : (familyInfo?.speciesId ?? TEMPLATE_SPECIES[template] ?? 'canidae');

  const phenotype = {
    breedId: name,
    variantId: 'default',
    familyId,
    speciesId,
    seed: resolvedSeed,
    label,
    source: 'recipe',
    template,
    baseBreedId: requestedBaseBreedId,
    recipeName: name,
    skeleton,
    geometry,
    ears,
    tail,
    face,
    coat,
    furnishings,
    extremities,
    headgear,
    motion,
    personality,
    variation,
    diagnostics: diagnostics.length ? diagnostics.slice() : undefined,
  };

  return deepFreeze(phenotype);
}

/**
 * @param {unknown} raw
 * @param {{ seed?: number }} [opts]
 * @returns {{ ok: true, recipe: object, phenotype: object, diagnostics: array }
 *   | { ok: false, refuse?: true, error: string, suggestion?: string, diagnostics?: array }}
 */
export function validateAndClampAnimalRecipe(raw, opts = {}) {
  if (raw == null || typeof raw !== 'object') {
    return { ok: false, error: 'Recipe must be a JSON object', diagnostics: [] };
  }
  if (isAnimalRefusal(raw)) {
    return {
      ok: false,
      refuse: true,
      error: String(raw.error || 'Refused'),
      suggestion: raw.suggestion != null ? String(raw.suggestion) : undefined,
      diagnostics: [],
    };
  }

  // Unwrap common wrappers.
  let body = raw;
  if (raw.recipe && typeof raw.recipe === 'object' && !raw.template) {
    body = raw.recipe;
  } else if (raw.phenotype && typeof raw.phenotype === 'object' && raw.phenotype.template) {
    body = raw.phenotype;
  }

  if (!body.template && !body.name && !body.skeleton) {
    return {
      ok: false,
      error: 'Not an AnimalPhenotype recipe (missing template/name/skeleton)',
      diagnostics: [],
    };
  }

  try {
    const phenotype = resolveDogPhenotypeFromRecipe(body, opts);
    const recipe = phenotypeToAuthorRecipe(phenotype);
    const diagnostics = phenotype.diagnostics ? [...phenotype.diagnostics] : [];
    return { ok: true, recipe, phenotype, diagnostics };
  } catch (err) {
    return {
      ok: false,
      error: err?.message || String(err),
      diagnostics: [],
    };
  }
}

/** Alias for design naming. */
export function recipeToResolvedPhenotype(recipe, opts = {}) {
  return resolveDogPhenotypeFromRecipe(recipe, opts);
}

/**
 * Always-non-null breed summary for UI / factory return value.
 * Catalog entry when present; otherwise a virtual recipe breed.
 */
export function getBreedOrVirtual(phenotype) {
  if (!phenotype) {
    return {
      id: 'unknown',
      label: 'Unknown',
      familyId: 'retriever-sporting',
      authored: false,
      akc: { group: null },
      popularity: { year: null, rank: null, source: null },
      summary: { size: 'Custom', build: 'Recipe', coat: '—', energy: 3, trainability: 3 },
      behavior: { ...DEFAULT_PERSONALITY },
      generatorLineage: null,
      conformationFlags: ['recipe'],
      variants: [{ id: 'default', label: 'Standard', kind: 'type' }],
      defaultVariantId: 'default',
    };
  }
  const existing = getDogBreed(phenotype.breedId);
  if (existing) return existing;
  return {
    id: phenotype.breedId,
    label: phenotype.label ?? phenotype.breedId,
    familyId: phenotype.familyId ?? 'retriever-sporting',
    speciesId: phenotype.speciesId
      ?? getDogFamily(phenotype.familyId)?.speciesId
      ?? 'canidae',
    authored: false,
    akc: { group: null },
    popularity: { year: null, rank: null, source: null },
    summary: {
      size: 'Custom',
      build: 'Recipe',
      coat: phenotype.coat?.pattern ?? '—',
      energy: phenotype.personality?.energy ?? 3,
      trainability: phenotype.personality?.trainability ?? 3,
    },
    behavior: {
      energy: phenotype.personality?.energy ?? 3,
      trainability: phenotype.personality?.trainability ?? 3,
      sociability: phenotype.personality?.sociability ?? 3,
      vigilance: phenotype.personality?.vigilance ?? 3,
    },
    generatorLineage: null,
    conformationFlags: ['recipe'],
    variants: [{ id: 'default', label: 'Standard', kind: 'type' }],
    defaultVariantId: 'default',
  };
}

/**
 * Integrity check for a pre-built phenotype object (not a recipe).
 * Does not re-clamp catalog-shaped data — only requires core sections.
 */
export function normalizeDirectPhenotype(phenotype, opts = {}) {
  if (!phenotype || typeof phenotype !== 'object') {
    throw new Error('phenotype option must be an object');
  }
  if (!phenotype.skeleton || !phenotype.coat) {
    throw new Error('phenotype must include skeleton and coat sections');
  }
  const seed = normalizeDogSeed(opts.seed ?? phenotype.seed ?? 1);
  if (phenotype.source === 'recipe' && Object.isFrozen(phenotype) && phenotype.seed === seed) {
    return phenotype;
  }
  const out = {
    ...phenotype,
    skeleton: { ...phenotype.skeleton },
    geometry: { ...(phenotype.geometry ?? {}) },
    ears: { ...(phenotype.ears ?? { type: 'floppy', length: 1, width: 1 }) },
    tail: { ...(phenotype.tail ?? { type: 'plume', thickness: 1 }) },
    face: { ...(phenotype.face ?? {}) },
    coat: {
      ...phenotype.coat,
      palette: { ...(phenotype.coat.palette ?? {}) },
    },
    furnishings: { ...(phenotype.furnishings ?? {}) },
    extremities: { ...(phenotype.extremities ?? { foot: 'paw', hoofSize: 1, dewclaw: 0, bareBelow: 0.75 }) },
    headgear: { ...(phenotype.headgear ?? { type: 'none', length: 1, curl: 0.5, spread: 1, thickness: 1 }) },
    motion: { ...(phenotype.motion ?? {}) },
    personality: { ...(phenotype.personality ?? DEFAULT_PERSONALITY) },
    variation: { ...(phenotype.variation ?? {}) },
    breedId: phenotype.breedId ?? 'custom-animal',
    variantId: phenotype.variantId ?? 'default',
    familyId: phenotype.familyId ?? 'retriever-sporting',
    speciesId: phenotype.speciesId
      ?? getDogFamily(phenotype.familyId)?.speciesId
      ?? 'canidae',
    seed,
    label: phenotype.label ?? phenotype.breedId ?? 'Custom',
    source: phenotype.source ?? 'phenotype',
  };
  return deepFreeze(out);
}

export { SECTION_KEYS, deepFreeze as freezeAnimalValue };
