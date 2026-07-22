/** Data-authored phenotype profiles and deterministic seeded resolution. */

import {
  AUTHORED_DOG_BREED_IDS,
  getDogBreed,
  getDogFamily,
  normalizeDogVariantId,
  normalizeRenderableDogBreedId,
} from './dogCatalog.js';
import { applyDogVariantOverride } from './dogVariantProfiles.js';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

const golden = {
  skeleton: { scale: 1, bodyLength: 1, legLength: 1, chestWidth: 1, hipWidth: 1, neckLength: 1, headSize: 1, muzzleLength: 1, tailLength: 1 },
  geometry: { torsoWidth: 1, torsoDepth: 1, neckWidth: 1, skullWidth: 1, skullHeight: 1, skullLength: 1, muzzleWidth: 1, legThickness: 1, pawSize: 1 },
  ears: { type: 'floppy', length: 1, width: 1, dynamics: 1 },
  tail: { type: 'plume', thickness: 1, curl: 0, motion: 1 },
  face: {
    eyeScale: 1, eyeSpacing: 1, eyeHeight: 1, eyeForward: 1, noseScale: 1, brow: 0,
    eyeStyle: 'canid', pupilAspect: 1, scleraAmount: 0,
  },
  coat: {
    length: 1, body: 1, head: 1, muzzle: 1, ears: 1, legs: 1, paws: 1, tail: 1,
    grooming: 'feathered', fiber: 'soft', pattern: 'golden-shade',
    palette: { undercoat: 0xecd6a4, guard: 0xcf9440, root: 0xd8b57e, tip: 0xf2d9a4 },
    gravityDroop: 0.58, density: 420, sheen: 0.12, lean: 1,
  },
  // beard drives chin goatee; mustache + neckSkirt default from beard when omitted.
  // mane: dedicated flared lion-mane collar loft (ruffed longhair cats).
  furnishings: { brows: 0, beard: 0, mustache: 0, neckSkirt: 0, ruff: 0.35, mane: 0, crestMane: 0 },
  motion: { stride: 1, speed: 1, sitDepth: 1, earDynamics: 1, tailMotion: 1 },
  extremities: { foot: 'paw', hoofSize: 1, dewclaw: 0, bareBelow: 0.75 },
  headgear: {
    type: 'none', length: 1, curl: 0.5, spread: 1, thickness: 1,
    color: 0xe8dcc8, tipColor: 0xc4b49a,
  },
  variation: { scale: 0.035, build: 0.045, coatShade: 0.12, coatLength: 0.08, energy: 0.3, trainability: 0.2 },
};

function mergeProfile(overrides) {
  const out = {};
  for (const key of Object.keys(golden)) {
    out[key] = { ...golden[key], ...(overrides[key] ?? {}) };
    if (key === 'coat') out[key].palette = { ...golden.coat.palette, ...(overrides.coat?.palette ?? {}) };
  }
  return out;
}

// Shared domestic-cat silhouette (tortoiseshell numbers). Breed profiles
// override per-section; palette merges over the feline base palette so a
// breed only states the colors its reference board actually changes.
const felineBase = {
  skeleton: {
    scale: 0.52, bodyLength: 0.88, legLength: 0.86, chestWidth: 0.72, hipWidth: 0.7,
    neckLength: 0.72, headSize: 0.96, muzzleLength: 0.52, tailLength: 1.05,
  },
  // Domestic cats carry most mass through the haunches — base legThickness was
  // reading stick-thin on the loft. hindLegThickness is applied only to the
  // back chain in dogBodyGeometry (powerful thigh → hock taper).
  geometry: {
    torsoWidth: 0.78, torsoDepth: 0.9, neckWidth: 0.68, skullWidth: 0.98, skullHeight: 1.02,
    skullLength: 0.88, cheekFullness: 0.7, muzzleWidth: 0.62,
    legThickness: 0.82, hindLegThickness: 1.08, pawSize: 0.74,
  },
  ears: { type: 'erect', length: 1.05, width: 0.95, dynamics: 0.35 },
  tail: { type: 'straight', thickness: 0.62, curl: 0.05, motion: 0.85 },
  face: {
    eyeScale: 1.28, eyeSpacing: 0.98, eyeHeight: 1.06, eyeForward: 1.08, noseScale: 0.72, brow: 0.05,
    eyeStyle: 'feline', pupilAspect: 0.32, scleraAmount: 0.04,
    irisColor: 0xc9a24a, lidColor: 0x2a2420, lidDarkColor: 0x1a1614,
  },
  coat: {
    length: 0.28, body: 0.3, head: 0.24, muzzle: 0.16, ears: 0.18, legs: 0.34, paws: 0.22, tail: 0.32,
    grooming: 'short', pattern: 'solid',
    palette: { undercoat: 0xc9a077, guard: 0x6b4c30, root: 0xa07850, tip: 0xe0c298 },
    earInnerTint: [0.05, 0.032, 0.028],
    gravityDroop: 0.14, density: 640,
  },
  furnishings: { ruff: 0.05 },
  motion: { stride: 0.58, speed: 0.88, sitDepth: 0.55, earDynamics: 0.32, tailMotion: 0.9 },
  variation: { scale: 0.04, build: 0.04, coatShade: 0.1, coatLength: 0.04, energy: 0.22, trainability: 0.18 },
};

/** Proportional haunch bulk when a breed only authors front-ish legThickness. */
function felineHindLegThickness(legThickness) {
  return Math.min(1.35, (legThickness ?? 0.82) * 1.32);
}

function felineProfile(overrides = {}) {
  const merged = {};
  for (const key of new Set([...Object.keys(felineBase), ...Object.keys(overrides)])) {
    merged[key] = { ...(felineBase[key] ?? {}), ...(overrides[key] ?? {}) };
    if (key === 'coat') {
      merged.coat.palette = { ...felineBase.coat.palette, ...(overrides.coat?.palette ?? {}) };
    }
  }
  // Keep haunches thicker than the front column even when a breed thins legs.
  if (overrides.geometry?.hindLegThickness == null) {
    merged.geometry = {
      ...merged.geometry,
      hindLegThickness: felineHindLegThickness(merged.geometry?.legThickness),
    };
  }
  return mergeProfile(merged);
}

/** Shared rodent silhouette — small, pointed muzzle, short skinny stilts. */
const rodentBase = {
  skeleton: {
    // Short legs (shared dog bone chain still has 5 segments; length scale
    // keeps the whole column short under the body).
    scale: 0.36, bodyLength: 0.9, legLength: 0.58, chestWidth: 0.7, hipWidth: 0.68,
    neckLength: 0.58, headSize: 0.92, muzzleLength: 0.9, tailLength: 1.1,
  },
  geometry: {
    torsoWidth: 0.72, torsoDepth: 0.86, neckWidth: 0.62, skullWidth: 0.9, skullHeight: 0.95,
    skullLength: 0.98, cheekFullness: 0.55, muzzleWidth: 0.58,
    // Thin columns; distal limb + foot shaped by extremities.foot = rodent-paw.
    legThickness: 0.48, hindLegThickness: 0.62, pawSize: 0.48,
  },
  ears: { type: 'erect', length: 0.8, width: 0.82, dynamics: 0.3 },
  tail: { type: 'straight', thickness: 0.4, taper: 0.8, curl: 0.04, motion: 0.75 },
  face: {
    eyeScale: 1.1, eyeSpacing: 0.94, eyeHeight: 1.02, eyeForward: 1.05, noseScale: 0.68, brow: 0.04,
    irisColor: 0x2a2218, lidColor: 0x3a3228, lidDarkColor: 0x1e1812,
  },
  coat: {
    // Bare distal limbs / pink paws — keep coat.paws/legs short so rodent-paw
    // bareBelow can reveal the skinny ankle and sole.
    length: 0.24, body: 0.26, head: 0.2, muzzle: 0.12, ears: 0.12, legs: 0.14, paws: 0.05, tail: 0.2,
    grooming: 'short', pattern: 'solid',
    palette: { undercoat: 0xa09080, guard: 0x4a4038, root: 0x6a5e52, tip: 0xc0b0a0 },
    gravityDroop: 0.12, density: 680,
  },
  furnishings: { ruff: 0 },
  extremities: { foot: 'rodent-paw', hoofSize: 1, dewclaw: 0, bareBelow: 0.9 },
  motion: { stride: 0.48, speed: 1.05, sitDepth: 0.48, earDynamics: 0.3, tailMotion: 0.75 },
  variation: { scale: 0.04, build: 0.035, coatShade: 0.12, coatLength: 0.04, energy: 0.25, trainability: 0.15 },
};

function rodentProfile(overrides = {}) {
  const merged = {};
  for (const key of new Set([...Object.keys(rodentBase), ...Object.keys(overrides)])) {
    merged[key] = { ...(rodentBase[key] ?? {}), ...(overrides[key] ?? {}) };
    if (key === 'coat') {
      merged.coat.palette = { ...rodentBase.coat.palette, ...(overrides.coat?.palette ?? {}) };
    }
  }
  if (overrides.geometry?.hindLegThickness == null && merged.geometry?.legThickness != null) {
    merged.geometry = {
      ...merged.geometry,
      hindLegThickness: Math.min(1.2, merged.geometry.legThickness * 1.3),
    };
  }
  return mergeProfile(merged);
}

/** Shared plantigrade ursid prior — massive body, short stub tail, rounded ears. */
const ursidBase = {
  skeleton: {
    scale: 1.12, bodyLength: 0.92, legLength: 0.78, chestWidth: 1.18, hipWidth: 1.12,
    neckLength: 0.62, headSize: 1.12, muzzleLength: 0.92, tailLength: 0.22,
  },
  geometry: {
    torsoWidth: 1.2, torsoDepth: 1.18, backArch: 0.02, frontTaper: 0.9,
    neckWidth: 1.12, skullWidth: 1.14, skullHeight: 1.08,
    skullLength: 1.02, cheekFullness: 0.85, muzzleWidth: 0.95,
    legThickness: 1.18, hindLegThickness: 1.28, pawSize: 1.2,
  },
  ears: { type: 'rounded', length: 0.48, width: 0.7, dynamics: 0.18 },
  tail: { type: 'straight', thickness: 0.85, taper: 0.55, curl: 0.04, motion: 0.2 },
  face: {
    eyeScale: 0.88, eyeSpacing: 0.96, eyeHeight: 1.0, eyeForward: 1.02, noseScale: 1.05, brow: 0.12,
    irisColor: 0x1a1410, lidColor: 0x4a3830, lidDarkColor: 0x2a1e18,
    hideTeeth: true,
    noseColor: 0x1a1210, noseBlendColor: 0x3a2820,
  },
  coat: {
    length: 0.7, body: 0.78, head: 0.55, muzzle: 0.22, ears: 0.35, legs: 0.55, paws: 0.22, tail: 0.35,
    grooming: 'dense-double', pattern: 'solid',
    palette: { undercoat: 0x6a5040, guard: 0x3a2818, root: 0x5a4030, tip: 0x8a6a50 },
    gravityDroop: 0.2, density: 480,
  },
  furnishings: { ruff: 0.15 },
  motion: { stride: 0.72, speed: 0.62, sitDepth: 0.7, earDynamics: 0.2, tailMotion: 0.22 },
  variation: { scale: 0.04, build: 0.035, coatShade: 0.12, coatLength: 0.06, energy: 0.2, trainability: 0.15 },
};

function ursidProfile(overrides = {}) {
  const merged = {};
  for (const key of new Set([...Object.keys(ursidBase), ...Object.keys(overrides)])) {
    merged[key] = { ...(ursidBase[key] ?? {}), ...(overrides[key] ?? {}) };
    if (key === 'coat') {
      merged.coat.palette = { ...ursidBase.coat.palette, ...(overrides.coat?.palette ?? {}) };
    }
  }
  if (overrides.geometry?.hindLegThickness == null && merged.geometry?.legThickness != null) {
    merged.geometry = {
      ...merged.geometry,
      hindLegThickness: Math.min(1.45, merged.geometry.legThickness * 1.12),
    };
  }
  return mergeProfile(merged);
}

/**
 * Shared mustelid prior — long low tube body, short legs, semi-plantigrade,
 * pointed muzzle, small rounded ears. Otter-ish neutral brown; breeds (badger /
 * weasel / skunk-adjacent) override proportions, coat, and extremities.
 */
const mustelidBase = {
  skeleton: {
    scale: 0.6, bodyLength: 1.18, legLength: 0.6, chestWidth: 0.74, hipWidth: 0.72,
    neckLength: 0.68, headSize: 0.9, muzzleLength: 0.8, tailLength: 0.82,
  },
  geometry: {
    torsoWidth: 0.72, torsoDepth: 0.82, neckWidth: 0.64, skullWidth: 0.84, skullHeight: 0.88,
    skullLength: 0.96, cheekFullness: 0.58, muzzleWidth: 0.54,
    legThickness: 0.54, hindLegThickness: 0.64, pawSize: 0.62,
  },
  ears: { type: 'rounded', length: 0.46, width: 0.66, dynamics: 0.3 },
  tail: { type: 'straight', thickness: 0.55, taper: 0.7, curl: 0.04, motion: 0.7 },
  face: {
    eyeScale: 1.0, eyeSpacing: 0.94, eyeHeight: 1.02, eyeForward: 1.04, noseScale: 0.7, brow: 0.06,
    irisColor: 0x2a2018, lidColor: 0x2a221a, lidDarkColor: 0x1a1410,
    noseColor: 0x1a1410, noseBlendColor: 0x2a201a,
  },
  coat: {
    length: 0.3, body: 0.34, head: 0.26, muzzle: 0.16, ears: 0.18, legs: 0.22, paws: 0.12, tail: 0.3,
    grooming: 'short', pattern: 'solid',
    palette: { undercoat: 0x6a5240, guard: 0x3a2a1c, root: 0x5a4434, tip: 0x7a5e48 },
    gravityDroop: 0.16, density: 620,
  },
  furnishings: { ruff: 0.05 },
  extremities: { foot: 'paw', hoofSize: 1, dewclaw: 0, bareBelow: 0.7 },
  motion: { stride: 0.6, speed: 0.92, sitDepth: 0.55, earDynamics: 0.3, tailMotion: 0.7 },
  variation: { scale: 0.04, build: 0.04, coatShade: 0.12, coatLength: 0.04, energy: 0.25, trainability: 0.18 },
};

function mustelidProfile(overrides = {}) {
  const merged = {};
  for (const key of new Set([...Object.keys(mustelidBase), ...Object.keys(overrides)])) {
    merged[key] = { ...(mustelidBase[key] ?? {}), ...(overrides[key] ?? {}) };
    if (key === 'coat') {
      merged.coat.palette = { ...mustelidBase.coat.palette, ...(overrides.coat?.palette ?? {}) };
    }
  }
  if (overrides.geometry?.hindLegThickness == null && merged.geometry?.legThickness != null) {
    merged.geometry = {
      ...merged.geometry,
      hindLegThickness: Math.min(1.25, merged.geometry.legThickness * 1.18),
    };
  }
  return mergeProfile(merged);
}

export const DOG_PHENOTYPE_PROFILES = deepFreeze({
  'golden-retriever': mergeProfile({}),
  'labrador-retriever': mergeProfile({
    skeleton: { scale: 1.02, bodyLength: 1.02, legLength: 1, chestWidth: 1.08, hipWidth: 1.04, neckLength: 0.96, headSize: 1.06, muzzleLength: 1.02, tailLength: 0.94 },
    geometry: { torsoWidth: 1.08, torsoDepth: 1.06, neckWidth: 1.08, skullWidth: 1.07, skullHeight: 1.01, skullLength: 1.02, muzzleWidth: 1.08, legThickness: 1.06, pawSize: 1.06 },
    ears: { type: 'floppy', length: 0.75, width: 0.86, dynamics: 0.8 },
    tail: { type: 'straight', thickness: 1.3, curl: 0, motion: 0.94 },
    face: { eyeScale: 0.94, eyeSpacing: 1.01, eyeHeight: 0.98, eyeForward: 0.98, noseScale: 1.08, brow: 0.08 },
    coat: { length: 0.28, body: 0.3, head: 0.26, muzzle: 0.22, ears: 0.24, legs: 0.24, paws: 0.22, tail: 0.28, grooming: 'short-double', pattern: 'solid', palette: { undercoat: 0x24231f, guard: 0x080807, root: 0x171612, tip: 0x383630 }, gravityDroop: 0.18, density: 720 },
    furnishings: { ruff: 0 },
    motion: { stride: 1.05, speed: 1.06, sitDepth: 1.02, earDynamics: 0.8, tailMotion: 1.02 },
  }),
  'german-shepherd-dog': mergeProfile({
    skeleton: { scale: 1.04, bodyLength: 1.08, legLength: 1.08, chestWidth: 0.94, hipWidth: 0.9, neckLength: 1.08, headSize: 1.01, muzzleLength: 1.28, tailLength: 1.1 },
    geometry: { torsoWidth: 0.94, torsoDepth: 1.03, neckWidth: 0.9, skullWidth: 0.93, skullHeight: 1.02, skullLength: 1.08, muzzleWidth: 0.86, legThickness: 0.92, pawSize: 1.02 },
    ears: { type: 'erect', length: 0.9, width: 0.86, dynamics: 0.28 },
    tail: { type: 'saber', thickness: 0.92, motion: 0.72 },
    face: { eyeScale: 0.9, eyeSpacing: 0.94, eyeHeight: 1.05, eyeForward: 1.06, noseScale: 1.05, brow: 0.25 },
    coat: { length: 0.72, body: 0.8, head: 0.7, muzzle: 0.65, ears: 0.6, legs: 0.7, paws: 0.65, tail: 0.85, grooming: 'double', pattern: 'saddle', palette: { undercoat: 0xb47738, guard: 0x17130f, root: 0x9c6b36, tip: 0xd2a067 }, gravityDroop: 0.38, density: 500 },
    furnishings: { ruff: 0.28 },
    motion: { stride: 1.13, speed: 1.12, sitDepth: 1.02, earDynamics: 0.28, tailMotion: 0.78 },
  }),
  dachshund: mergeProfile({
    skeleton: { scale: 0.69, bodyLength: 1.48, legLength: 0.56, chestWidth: 0.88, hipWidth: 0.9, neckLength: 0.9, headSize: 0.92, muzzleLength: 1.12, tailLength: 1.02 },
    geometry: { torsoWidth: 0.92, torsoDepth: 1.12, neckWidth: 0.85, skullWidth: 0.9, skullHeight: 0.9, skullLength: 1.03, muzzleWidth: 0.78, legThickness: 0.88, pawSize: 0.9 },
    ears: { type: 'floppy', length: 1.1, width: 1.02, dynamics: 1.12 },
    tail: { type: 'straight', thickness: 0.68, motion: 0.88 },
    face: { eyeScale: 1.04, eyeSpacing: 0.92, eyeHeight: 1, eyeForward: 1.06, noseScale: 0.96, brow: 0.08 },
    coat: { length: 0.24, body: 0.24, head: 0.2, muzzle: 0.2, ears: 0.3, legs: 0.2, paws: 0.2, tail: 0.2, grooming: 'smooth', pattern: 'black-tan', palette: { undercoat: 0x241811, guard: 0xb56b31, root: 0x3a2518, tip: 0x4a3020 }, gravityDroop: 0.18, density: 680 },
    furnishings: { ruff: 0 },
    motion: { stride: 0.72, speed: 0.72, sitDepth: 0.58, earDynamics: 1.15, tailMotion: 0.9 },
    variation: { scale: 0.04, build: 0.035, coatShade: 0.1, coatLength: 0.04, energy: 0.25, trainability: 0.2 },
  }),
  poodle: mergeProfile({
    skeleton: { scale: 0.96, bodyLength: 0.88, legLength: 1.16, chestWidth: 0.78, hipWidth: 0.78, neckLength: 1.12, headSize: 0.92, muzzleLength: 1.24, tailLength: 0.72 },
    geometry: { torsoWidth: 0.8, torsoDepth: 0.9, neckWidth: 0.78, skullWidth: 0.86, skullHeight: 1.02, skullLength: 1.02, muzzleWidth: 0.68, legThickness: 0.76, pawSize: 0.82 },
    ears: { type: 'floppy', length: 0.92, width: 0.78, dynamics: 0.82 },
    tail: { type: 'upright', thickness: 0.65, curl: 0.18, motion: 0.82 },
    face: { eyeScale: 0.88, eyeSpacing: 0.9, eyeHeight: 1.08, eyeForward: 1.04, noseScale: 0.92, brow: 0.12 },
    coat: { length: 0.82, body: 0.88, head: 0.9, muzzle: 0.52, ears: 0.82, legs: 0.78, paws: 0.68, tail: 0.55, grooming: 'curly', pattern: 'solid', palette: { undercoat: 0xe9e5dc, guard: 0xbdb9b0, root: 0xd4d0c6, tip: 0xf7f4ed }, gravityDroop: 0.2, density: 430 },
    furnishings: { topknot: 1, anklePuffs: 1, tailPom: 0.9, ruff: 0.2 },
    motion: { stride: 1.14, speed: 1.12, sitDepth: 1, earDynamics: 0.82, tailMotion: 0.82 },
  }),
  beagle: mergeProfile({
    skeleton: { scale: 0.78, bodyLength: 0.94, legLength: 0.8, chestWidth: 0.96, hipWidth: 0.94, neckLength: 0.86, headSize: 0.96, muzzleLength: 0.98, tailLength: 0.82 },
    geometry: { torsoWidth: 0.98, torsoDepth: 1.04, neckWidth: 0.94, skullWidth: 0.98, skullHeight: 0.96, skullLength: 1.02, muzzleWidth: 0.9, legThickness: 0.96, pawSize: 0.94 },
    ears: { type: 'floppy', length: 1.2, width: 1.02, dynamics: 1.18 },
    tail: { type: 'upright', thickness: 0.75, curl: 0.08, motion: 1.08 },
    face: { eyeScale: 1.02, eyeSpacing: 0.96, eyeHeight: 0.98, eyeForward: 1.04, noseScale: 1.02, brow: 0.12 },
    coat: { length: 0.22, body: 0.22, head: 0.2, muzzle: 0.18, ears: 0.2, legs: 0.18, paws: 0.16, tail: 0.18, grooming: 'smooth', pattern: 'hound-saddle', palette: { undercoat: 0xb66b31, guard: 0x211812, root: 0x8f5127, tip: 0xd69a61 }, gravityDroop: 0.14, density: 760 },
    furnishings: { ruff: 0 },
    motion: { stride: 0.84, speed: 0.9, sitDepth: 0.8, earDynamics: 1.18, tailMotion: 1.12 },
  }),
  rottweiler: mergeProfile({
    skeleton: { scale: 1.08, bodyLength: 1.02, legLength: 1.02, chestWidth: 1.16, hipWidth: 1.12, neckLength: 0.88, headSize: 1.13, muzzleLength: 0.9, tailLength: 0.82 },
    geometry: { torsoWidth: 1.18, torsoDepth: 1.13, neckWidth: 1.18, skullWidth: 1.16, skullHeight: 1.05, skullLength: 1.02, muzzleWidth: 1.14, legThickness: 1.18, pawSize: 1.13 },
    ears: { type: 'folded', fold: 'drop', length: 0.68, width: 0.6, dynamics: 0.72 },
    tail: { type: 'straight', thickness: 1.18, motion: 0.72 },
    face: { eyeScale: 0.86, eyeSpacing: 1.05, eyeHeight: 0.96, eyeForward: 0.94, noseScale: 1.2, brow: 0.3 },
    coat: { length: 0.22, body: 0.22, head: 0.18, muzzle: 0.16, ears: 0.18, legs: 0.18, paws: 0.16, tail: 0.2, grooming: 'smooth-double', pattern: 'black-tan', palette: { undercoat: 0x151311, guard: 0xa75b27, root: 0x211c18, tip: 0x33271f }, gravityDroop: 0.16, density: 720 },
    furnishings: { ruff: 0 },
    motion: { stride: 0.96, speed: 0.94, sitDepth: 1.08, earDynamics: 0.7, tailMotion: 0.76 },
  }),
  'german-shorthaired-pointer': mergeProfile({
    skeleton: { scale: 1, bodyLength: 0.98, legLength: 1.14, chestWidth: 0.84, hipWidth: 0.78, neckLength: 1.08, headSize: 0.94, muzzleLength: 1.28, tailLength: 0.72 },
    geometry: { torsoWidth: 0.84, torsoDepth: 0.98, neckWidth: 0.82, skullWidth: 0.88, skullHeight: 0.94, skullLength: 1.08, muzzleWidth: 0.76, legThickness: 0.78, pawSize: 0.88 },
    ears: { type: 'floppy', length: 0.98, width: 0.82, dynamics: 1.04 },
    tail: { type: 'straight', thickness: 0.62, curl: 0, motion: 0.9 },
    face: { eyeScale: 0.9, eyeSpacing: 0.9, eyeHeight: 1.04, eyeForward: 1.06, noseScale: 1, brow: 0.08 },
    coat: { length: 0.18, body: 0.18, head: 0.16, muzzle: 0.14, ears: 0.16, legs: 0.14, paws: 0.12, tail: 0.14, grooming: 'smooth', pattern: 'liver-roan', palette: { undercoat: 0xe2ddd2, guard: 0x553125, root: 0xbeafa0, tip: 0xf0ece3 }, gravityDroop: 0.1, density: 800 },
    furnishings: { ruff: 0 },
    motion: { stride: 1.2, speed: 1.2, sitDepth: 1.02, earDynamics: 1.06, tailMotion: 0.92 },
  }),
  bulldog: mergeProfile({
    skeleton: { scale: 0.82, bodyLength: 0.76, legLength: 0.62, chestWidth: 1.28, hipWidth: 1.05, neckLength: 0.56, headSize: 1.3, muzzleLength: 0.28, tailLength: 0.28 },
    geometry: { torsoWidth: 1.3, torsoDepth: 1.22, neckWidth: 1.3, skullWidth: 1.36, skullHeight: 1.14, skullLength: 0.86, muzzleWidth: 1.28, legThickness: 1.22, pawSize: 1.12 },
    ears: { type: 'folded', fold: 'rose', length: 0.58, width: 0.8, dynamics: 0.5 },
    tail: { type: 'curled', thickness: 1, curl: 1, motion: 0.26 },
    face: { eyeScale: 1.02, eyeSpacing: 1.12, eyeHeight: 0.98, eyeForward: 1.03, noseScale: 1.3, brow: 0.36 },
    coat: { length: 0.16, body: 0.16, head: 0.14, muzzle: 0.1, ears: 0.12, legs: 0.13, paws: 0.12, tail: 0.12, grooming: 'smooth', pattern: 'pied', palette: { undercoat: 0xf0e6d3, guard: 0xa96f48, root: 0xd2b18e, tip: 0xf7efe3 }, gravityDroop: 0.1, density: 800 },
    furnishings: { ruff: 0 },
    motion: { stride: 0.58, speed: 0.58, sitDepth: 0.68, earDynamics: 0.48, tailMotion: 0.24 },
    variation: { scale: 0.03, build: 0.03, coatShade: 0.12, coatLength: 0.025, energy: 0.18, trainability: 0.18 },
  }),
  'cane-corso': mergeProfile({
    skeleton: { scale: 1.18, bodyLength: 1.04, legLength: 1.08, chestWidth: 1.22, hipWidth: 1.12, neckLength: 0.9, headSize: 1.2, muzzleLength: 0.78, tailLength: 0.9 },
    geometry: { torsoWidth: 1.23, torsoDepth: 1.15, neckWidth: 1.25, skullWidth: 1.2, skullHeight: 1.05, skullLength: 1, muzzleWidth: 1.2, legThickness: 1.15, pawSize: 1.16 },
    ears: { type: 'folded', fold: 'drop', length: 0.7, width: 0.82, dynamics: 0.64 },
    tail: { type: 'straight', thickness: 1.14, curl: 0, motion: 0.62 },
    face: { eyeScale: 0.84, eyeSpacing: 1.02, eyeHeight: 0.96, eyeForward: 0.96, noseScale: 1.24, brow: 0.35 },
    coat: { length: 0.18, body: 0.18, head: 0.16, muzzle: 0.13, ears: 0.14, legs: 0.15, paws: 0.13, tail: 0.16, grooming: 'smooth', pattern: 'solid', palette: { undercoat: 0x494c50, guard: 0x17191c, root: 0x33363a, tip: 0x62666b }, gravityDroop: 0.11, density: 780 },
    furnishings: { ruff: 0 },
    motion: { stride: 1.02, speed: 0.92, sitDepth: 1.12, earDynamics: 0.62, tailMotion: 0.66 },
  }),
  'cavalier-king-charles-spaniel': mergeProfile({
    skeleton: { scale: 0.64, bodyLength: 0.8, legLength: 0.72, chestWidth: 0.8, hipWidth: 0.8, neckLength: 0.76, headSize: 0.94, muzzleLength: 0.7, tailLength: 0.96 },
    geometry: { torsoWidth: 0.84, torsoDepth: 0.94, neckWidth: 0.76, skullWidth: 1.02, skullHeight: 1, skullLength: 0.94, muzzleWidth: 0.82, legThickness: 0.76, pawSize: 0.74 },
    ears: { type: 'floppy', length: 1.34, width: 1.08, dynamics: 1.18 },
    tail: { type: 'plume', thickness: 0.7, curl: 0.12, motion: 1.08 },
    face: { eyeScale: 1.18, eyeSpacing: 1.02, eyeHeight: 1.02, eyeForward: 1.08, noseScale: 0.88, brow: 0.04 },
    coat: { length: 0.9, body: 0.72, head: 0.52, muzzle: 0.28, ears: 1.45, legs: 0.78, paws: 0.7, tail: 1.25, grooming: 'silky', pattern: 'blenheim', palette: { undercoat: 0xf3e7cf, guard: 0xa94f24, root: 0xd7b58f, tip: 0xf8f0df }, gravityDroop: 0.72, density: 390 },
    furnishings: { ruff: 0.35 },
    motion: { stride: 0.74, speed: 0.82, sitDepth: 0.7, earDynamics: 1.2, tailMotion: 1.12 },
  }),
  'yorkshire-terrier': mergeProfile({
    skeleton: { scale: 0.46, bodyLength: 0.68, legLength: 0.66, chestWidth: 0.7, hipWidth: 0.68, neckLength: 0.78, headSize: 0.82, muzzleLength: 0.62, tailLength: 0.6 },
    geometry: { torsoWidth: 0.74, torsoDepth: 0.86, neckWidth: 0.68, skullWidth: 0.9, skullHeight: 0.94, skullLength: 0.9, muzzleWidth: 0.64, legThickness: 0.62, pawSize: 0.6 },
    ears: { type: 'erect', length: 0.72, width: 0.68, dynamics: 0.32 },
    tail: { type: 'upright', thickness: 0.56, curl: 0.12, motion: 0.82 },
    face: { eyeScale: 1.14, eyeSpacing: 0.94, eyeHeight: 1.04, eyeForward: 1.08, noseScale: 0.72, brow: 0.2 },
    coat: { length: 1.12, body: 1.35, head: 0.92, muzzle: 0.7, ears: 0.42, legs: 1.3, paws: 1.1, tail: 0.85, grooming: 'silky', pattern: 'blue-tan', palette: { undercoat: 0xb6793f, guard: 0x4e5963, root: 0x8b715b, tip: 0xc8a476 }, gravityDroop: 0.85, density: 340 },
    furnishings: { topknot: 0.65, beard: 0.42, mustache: 0.55, neckSkirt: 0.48, ruff: 0.18 },
    motion: { stride: 0.62, speed: 0.78, sitDepth: 0.56, earDynamics: 0.32, tailMotion: 0.88 },
    variation: { scale: 0.04, build: 0.035, coatShade: 0.12, coatLength: 0.08, energy: 0.25, trainability: 0.2 },
  }),
  'french-bulldog': mergeProfile({
    skeleton: { scale: 0.68, bodyLength: 0.76, legLength: 0.72, chestWidth: 1.18, hipWidth: 1.03, neckLength: 0.6, headSize: 1.22, muzzleLength: 0.36, tailLength: 0.26 },
    geometry: { torsoWidth: 1.22, torsoDepth: 1.17, neckWidth: 1.2, skullWidth: 1.24, skullHeight: 1.16, skullLength: 0.92, muzzleWidth: 1.2, legThickness: 1.1, pawSize: 1.04 },
    ears: { type: 'bat', length: 1.04, width: 1.25, dynamics: 0.24 },
    tail: { type: 'curled', thickness: 0.95, curl: 0.95, motion: 0.3 },
    face: { eyeScale: 1.18, eyeSpacing: 1.08, eyeHeight: 1.03, eyeForward: 1.04, noseScale: 1.24, brow: 0.2 },
    coat: { length: 0.18, body: 0.18, head: 0.16, muzzle: 0.12, ears: 0.12, legs: 0.15, paws: 0.14, tail: 0.14, grooming: 'smooth', pattern: 'brindle-mask', palette: { undercoat: 0xb9956d, guard: 0x594234, root: 0xa37d58, tip: 0xc5aa88 }, gravityDroop: 0.12, density: 760 },
    furnishings: { ruff: 0 },
    motion: { stride: 0.66, speed: 0.68, sitDepth: 0.72, earDynamics: 0.22, tailMotion: 0.3 },
    variation: { scale: 0.035, build: 0.035, coatShade: 0.14, coatLength: 0.03, energy: 0.2, trainability: 0.2 },
  }),
  'australian-shepherd': mergeProfile({
    skeleton: { scale: 0.92, bodyLength: 0.94, legLength: 0.94, chestWidth: 0.94, hipWidth: 0.92, neckLength: 0.92, headSize: 0.96, muzzleLength: 1.04, tailLength: 0.3 },
    geometry: { torsoWidth: 0.96, torsoDepth: 1.02, neckWidth: 0.92, skullWidth: 0.96, skullHeight: 1, skullLength: 1.02, muzzleWidth: 0.86, legThickness: 0.9, pawSize: 0.94 },
    ears: { type: 'folded', fold: 'semi-prick', length: 0.6, width: 0.72, dynamics: 0.74 },
    tail: { type: 'upright', thickness: 0.82, curl: 0.18, motion: 0.72 },
    face: { eyeScale: 0.96, eyeSpacing: 0.96, eyeHeight: 1.03, eyeForward: 1.03, noseScale: 0.98, brow: 0.15 },
    coat: { length: 0.92, body: 0.98, head: 0.72, muzzle: 0.42, ears: 0.68, legs: 0.82, paws: 0.7, tail: 0.9, grooming: 'medium-double', pattern: 'blue-merle', palette: { undercoat: 0xaeb5bb, guard: 0x282b2f, root: 0x7d8388, tip: 0xd3d7da }, gravityDroop: 0.42, density: 450 },
    furnishings: { ruff: 0.65 },
    motion: { stride: 1.04, speed: 1.12, sitDepth: 0.94, earDynamics: 0.76, tailMotion: 0.78 },
  }),
  'doberman-pinscher': mergeProfile({
    skeleton: { scale: 1.08, bodyLength: 0.98, legLength: 1.18, chestWidth: 0.86, hipWidth: 0.78, neckLength: 1.12, headSize: 0.96, muzzleLength: 1.28, tailLength: 0.78 },
    geometry: { torsoWidth: 0.88, torsoDepth: 1.02, neckWidth: 0.84, skullWidth: 0.86, skullHeight: 1, skullLength: 1.08, muzzleWidth: 0.76, legThickness: 0.78, pawSize: 0.9 },
    ears: { type: 'folded', fold: 'drop', length: 0.74, width: 0.7, dynamics: 0.7 },
    tail: { type: 'straight', thickness: 0.62, curl: 0, motion: 0.82 },
    face: { eyeScale: 0.86, eyeSpacing: 0.9, eyeHeight: 1.06, eyeForward: 1.06, noseScale: 1, brow: 0.28 },
    coat: { length: 0.16, body: 0.16, head: 0.14, muzzle: 0.12, ears: 0.12, legs: 0.13, paws: 0.11, tail: 0.13, grooming: 'smooth', pattern: 'black-tan', palette: { undercoat: 0x151311, guard: 0xa45727, root: 0x25201c, tip: 0x3b2c22 }, gravityDroop: 0.08, density: 820 },
    furnishings: { ruff: 0 },
    motion: { stride: 1.18, speed: 1.18, sitDepth: 1.06, earDynamics: 0.7, tailMotion: 0.86 },
  }),
  'pembroke-welsh-corgi': mergeProfile({
    skeleton: { scale: 0.64, bodyLength: 1.28, legLength: 0.52, chestWidth: 0.94, hipWidth: 0.96, neckLength: 0.8, headSize: 0.94, muzzleLength: 0.86, tailLength: 0.24 },
    geometry: { torsoWidth: 0.98, torsoDepth: 1.1, neckWidth: 0.88, skullWidth: 0.98, skullHeight: 0.98, skullLength: 0.96, muzzleWidth: 0.8, legThickness: 0.92, pawSize: 0.88 },
    ears: { type: 'erect', length: 0.9, width: 0.86, dynamics: 0.28 },
    tail: { type: 'upright', thickness: 0.82, curl: 0.16, motion: 0.55 },
    face: { eyeScale: 1.02, eyeSpacing: 0.96, eyeHeight: 1.04, eyeForward: 1.04, noseScale: 0.9, brow: 0.08 },
    coat: { length: 0.68, body: 0.76, head: 0.58, muzzle: 0.34, ears: 0.45, legs: 0.55, paws: 0.48, tail: 0.7, grooming: 'double', pattern: 'red-white', palette: { undercoat: 0xf0dfbd, guard: 0xb85e24, root: 0xd39a61, tip: 0xf5e7cb }, gravityDroop: 0.3, density: 520 },
    furnishings: { ruff: 0.42 },
    motion: { stride: 0.68, speed: 0.82, sitDepth: 0.56, earDynamics: 0.28, tailMotion: 0.6 },
    variation: { scale: 0.04, build: 0.035, coatShade: 0.12, coatLength: 0.06, energy: 0.25, trainability: 0.2 },
  }),
  boxer: mergeProfile({
    // Studio refs: square athletic working frame, long lean legs, tucked waist,
    // blunt square muzzle with black mask only on face (ears stay fawn).
    skeleton: { scale: 1.04, bodyLength: 0.94, legLength: 1.14, chestWidth: 1.12, hipWidth: 0.86, neckLength: 0.92, headSize: 1.08, muzzleLength: 0.48, tailLength: 0.55 },
    geometry: { torsoWidth: 1.06, torsoDepth: 1.02, neckWidth: 1.08, skullWidth: 1.08, skullHeight: 1.0, skullLength: 0.96, muzzleWidth: 1.16, legThickness: 0.92, pawSize: 0.96 },
    ears: { type: 'folded', fold: 'drop', length: 0.56, width: 0.7, dynamics: 0.52 },
    tail: { type: 'upright', thickness: 0.68, curl: 0.22, motion: 0.82 },
    face: { eyeScale: 0.88, eyeSpacing: 1.0, eyeHeight: 0.96, eyeForward: 0.98, noseScale: 1.24, brow: 0.38 },
    coat: { length: 0.14, body: 0.14, head: 0.12, muzzle: 0.08, ears: 0.1, legs: 0.11, paws: 0.1, tail: 0.11, grooming: 'smooth', pattern: 'fawn-mask', palette: { undercoat: 0xc17a3a, guard: 0x14100e, root: 0xa85e28, tip: 0xd49258 }, gravityDroop: 0.08, density: 860 },
    furnishings: { ruff: 0 },
    motion: { stride: 1.1, speed: 1.14, sitDepth: 1.04, earDynamics: 0.52, tailMotion: 0.86 },
  }),
  'bernese-mountain-dog': mergeProfile({
    skeleton: { scale: 1.22, bodyLength: 1.08, legLength: 1.06, chestWidth: 1.18, hipWidth: 1.14, neckLength: 0.98, headSize: 1.12, muzzleLength: 1.02, tailLength: 1.08 },
    geometry: { torsoWidth: 1.2, torsoDepth: 1.16, neckWidth: 1.18, skullWidth: 1.12, skullHeight: 1.04, skullLength: 1.04, muzzleWidth: 1.06, legThickness: 1.16, pawSize: 1.18 },
    ears: { type: 'floppy', length: 0.78, width: 0.9, dynamics: 0.76 },
    tail: { type: 'plume', thickness: 1.08, curl: 0.08, motion: 0.72 },
    face: { eyeScale: 0.9, eyeSpacing: 1, eyeHeight: 1, eyeForward: 0.98, noseScale: 1.12, brow: 0.2 },
    coat: { length: 1.18, body: 1.22, head: 0.92, muzzle: 0.48, ears: 0.9, legs: 1.02, paws: 0.8, tail: 1.38, grooming: 'long-double', pattern: 'black-tan', palette: { undercoat: 0x171513, guard: 0xb6642d, root: 0x29231f, tip: 0x4b392d }, gravityDroop: 0.58, density: 380 },
    furnishings: { ruff: 0.72 },
    motion: { stride: 1.02, speed: 0.86, sitDepth: 1.14, earDynamics: 0.76, tailMotion: 0.76 },
  }),
  'shih-tzu': mergeProfile({
    skeleton: { scale: 0.48, bodyLength: 0.68, legLength: 0.56, chestWidth: 0.78, hipWidth: 0.78, neckLength: 0.56, headSize: 0.98, muzzleLength: 0.34, tailLength: 0.82 },
    geometry: { torsoWidth: 0.86, torsoDepth: 0.98, neckWidth: 0.78, skullWidth: 1.08, skullHeight: 1.06, skullLength: 0.88, muzzleWidth: 0.9, legThickness: 0.72, pawSize: 0.68 },
    ears: { type: 'floppy', length: 0.92, width: 0.96, dynamics: 0.9 },
    tail: { type: 'curled', thickness: 0.66, curl: 0.92, motion: 0.72 },
    face: { eyeScale: 1.24, eyeSpacing: 1.06, eyeHeight: 1.02, eyeForward: 1.05, noseScale: 0.8, brow: 0.1 },
    coat: { length: 1.28, body: 1.55, head: 1.12, muzzle: 0.72, ears: 1.2, legs: 1.42, paws: 1.18, tail: 1.35, grooming: 'silky', pattern: 'parti', palette: { undercoat: 0xeee2ca, guard: 0xa96936, root: 0xd0af86, tip: 0xf5ecdc }, gravityDroop: 0.88, density: 320 },
    furnishings: { topknot: 0.78, beard: 0.4, mustache: 0.48, neckSkirt: 0.42, ruff: 0.35 },
    motion: { stride: 0.54, speed: 0.66, sitDepth: 0.5, earDynamics: 0.9, tailMotion: 0.76 },
    variation: { scale: 0.04, build: 0.035, coatShade: 0.12, coatLength: 0.09, energy: 0.2, trainability: 0.18 },
  }),
  'great-dane': mergeProfile({
    skeleton: { scale: 1.38, bodyLength: 1.02, legLength: 1.34, chestWidth: 0.94, hipWidth: 0.82, neckLength: 1.2, headSize: 1.06, muzzleLength: 1.2, tailLength: 1.1 },
    geometry: { torsoWidth: 0.96, torsoDepth: 1.08, neckWidth: 0.92, skullWidth: 0.96, skullHeight: 1.04, skullLength: 1.1, muzzleWidth: 0.9, legThickness: 0.86, pawSize: 1.08 },
    ears: { type: 'folded', fold: 'drop', length: 0.82, width: 0.82, dynamics: 0.72 },
    tail: { type: 'straight', thickness: 0.76, curl: 0, motion: 0.74 },
    face: { eyeScale: 0.82, eyeSpacing: 0.96, eyeHeight: 1.04, eyeForward: 1.02, noseScale: 1.12, brow: 0.2 },
    coat: { length: 0.15, body: 0.15, head: 0.13, muzzle: 0.11, ears: 0.11, legs: 0.12, paws: 0.11, tail: 0.12, grooming: 'smooth', pattern: 'solid', palette: { undercoat: 0x636b73, guard: 0x333941, root: 0x4b535b, tip: 0x858d94 }, gravityDroop: 0.08, density: 840 },
    furnishings: { ruff: 0 },
    motion: { stride: 1.28, speed: 1.02, sitDepth: 1.22, earDynamics: 0.72, tailMotion: 0.78 },
    variation: { scale: 0.025, build: 0.035, coatShade: 0.1, coatLength: 0.025, energy: 0.2, trainability: 0.2 },
  }),
  'boston-terrier': mergeProfile({
    skeleton: { scale: 0.58, bodyLength: 0.7, legLength: 0.74, chestWidth: 1.06, hipWidth: 0.9, neckLength: 0.56, headSize: 1.14, muzzleLength: 0.34, tailLength: 0.24 },
    geometry: { torsoWidth: 1.1, torsoDepth: 1.08, neckWidth: 1.08, skullWidth: 1.18, skullHeight: 1.12, skullLength: 0.9, muzzleWidth: 1.08, legThickness: 0.96, pawSize: 0.9 },
    ears: { type: 'bat', length: 0.82, width: 0.88, dynamics: 0.22 },
    tail: { type: 'curled', thickness: 0.72, curl: 0.92, motion: 0.28 },
    face: { eyeScale: 1.18, eyeSpacing: 1.08, eyeHeight: 1.02, eyeForward: 1.06, noseScale: 1.12, brow: 0.16 },
    coat: { length: 0.15, body: 0.15, head: 0.13, muzzle: 0.1, ears: 0.1, legs: 0.12, paws: 0.11, tail: 0.1, grooming: 'smooth', pattern: 'tuxedo', palette: { undercoat: 0xf1eee6, guard: 0x171719, root: 0x696666, tip: 0xffffff }, gravityDroop: 0.08, density: 840 },
    furnishings: { ruff: 0 },
    motion: { stride: 0.66, speed: 0.76, sitDepth: 0.62, earDynamics: 0.22, tailMotion: 0.3 },
    variation: { scale: 0.035, build: 0.035, coatShade: 0.08, coatLength: 0.02, energy: 0.22, trainability: 0.2 },
  }),
  'miniature-schnauzer': mergeProfile({
    skeleton: { scale: 0.72, bodyLength: 0.88, legLength: 0.84, chestWidth: 0.9, hipWidth: 0.88, neckLength: 0.9, headSize: 0.91, muzzleLength: 0.98, tailLength: 0.55 },
    geometry: { torsoWidth: 0.9, torsoDepth: 0.96, neckWidth: 0.86, skullWidth: 0.9, skullHeight: 0.94, skullLength: 1, muzzleWidth: 0.82, legThickness: 0.84, pawSize: 0.84 },
    ears: { type: 'folded', fold: 'button', length: 0.66, width: 0.8, dynamics: 0.78 },
    tail: { type: 'upright', thickness: 0.72, motion: 0.8 },
    face: { eyeScale: 0.92, eyeSpacing: 0.94, eyeHeight: 1.02, eyeForward: 1.02, noseScale: 0.96, brow: 0.8 },
    coat: { length: 0.54, body: 0.5, head: 0.48, muzzle: 0.62, ears: 0.35, legs: 0.66, paws: 0.54, tail: 0.42, grooming: 'wire', pattern: 'salt-pepper', palette: { undercoat: 0xbbb9b2, guard: 0x4c4c49, root: 0x918f89, tip: 0xd6d3ca }, gravityDroop: 0.48, density: 520 },
    furnishings: { brows: 0.85, beard: 0.72, mustache: 0.68, neckSkirt: 0.55, ruff: 0.12 },
    motion: { stride: 0.86, speed: 0.92, sitDepth: 0.82, earDynamics: 0.8, tailMotion: 0.9 },
  }),
  pomeranian: mergeProfile({
    skeleton: { scale: 0.54, bodyLength: 0.72, legLength: 0.64, chestWidth: 0.87, hipWidth: 0.82, neckLength: 0.72, headSize: 0.83, muzzleLength: 0.7, tailLength: 0.82 },
    geometry: { torsoWidth: 0.9, torsoDepth: 1, neckWidth: 0.88, skullWidth: 0.92, skullHeight: 0.94, skullLength: 0.9, muzzleWidth: 0.67, legThickness: 0.72, pawSize: 0.68 },
    ears: { type: 'erect', length: 0.58, width: 0.62, dynamics: 0.32 },
    tail: { type: 'curled', thickness: 0.78, curl: 1, motion: 0.52 },
    face: { eyeScale: 1.06, eyeSpacing: 0.92, eyeHeight: 1.04, eyeForward: 1.08, noseScale: 0.78, brow: 0.05 },
    coat: { length: 1.32, body: 1.45, head: 1.25, muzzle: 0.45, ears: 0.78, legs: 1.05, paws: 0.85, tail: 1.65, grooming: 'stand-off-double', pattern: 'solid', palette: { undercoat: 0xe2a25d, guard: 0xa95822, root: 0xd4823e, tip: 0xf1c27a }, gravityDroop: 0.32, density: 340 },
    furnishings: { ruff: 1 },
    motion: { stride: 0.68, speed: 0.82, sitDepth: 0.64, earDynamics: 0.3, tailMotion: 0.56 },
    variation: { scale: 0.045, build: 0.04, coatShade: 0.16, coatLength: 0.12, energy: 0.25, trainability: 0.2 },
  }),
  'siberian-husky': mergeProfile({
    skeleton: { scale: 0.94, bodyLength: 0.98, legLength: 1.04, chestWidth: 0.9, hipWidth: 0.88, neckLength: 1.02, headSize: 0.96, muzzleLength: 1.12, tailLength: 1.12 },
    geometry: { torsoWidth: 0.92, torsoDepth: 1.02, neckWidth: 0.92, skullWidth: 0.94, skullHeight: 1.02, skullLength: 1.02, muzzleWidth: 0.82, legThickness: 0.88, pawSize: 0.98 },
    ears: { type: 'erect', length: 0.76, width: 0.7, dynamics: 0.28 },
    tail: { type: 'sickle', thickness: 1.2, curl: 0.72, motion: 0.76 },
    face: { eyeScale: 0.94, eyeSpacing: 0.94, eyeHeight: 1.05, eyeForward: 1.04, noseScale: 0.96, brow: 0.12, irisColor: 0x76bde5, lidColor: 0x737b82, lidDarkColor: 0x30353a },
    coat: { length: 0.88, body: 0.96, head: 0.7, muzzle: 0.36, ears: 0.52, legs: 0.76, paws: 0.62, tail: 1.7, grooming: 'dense-double', pattern: 'husky-mask', palette: { undercoat: 0xf0eee7, guard: 0x4a535c, root: 0xa9adb0, tip: 0xf7f6f1 }, gravityDroop: 0.3, density: 470 },
    furnishings: { ruff: 0.62 },
    motion: { stride: 1.12, speed: 1.16, sitDepth: 0.96, earDynamics: 0.28, tailMotion: 0.8 },
    variation: { scale: 0.035, build: 0.04, coatShade: 0.12, coatLength: 0.07, energy: 0.22, trainability: 0.2 },
  }),
  chihuahua: mergeProfile({
    skeleton: { scale: 0.43, bodyLength: 0.62, legLength: 0.7, chestWidth: 0.68, hipWidth: 0.66, neckLength: 0.7, headSize: 0.86, muzzleLength: 0.58, tailLength: 0.82 },
    geometry: { torsoWidth: 0.72, torsoDepth: 0.83, neckWidth: 0.65, skullWidth: 1.04, skullHeight: 1.03, skullLength: 0.88, muzzleWidth: 0.65, legThickness: 0.57, pawSize: 0.58 },
    ears: { type: 'erect', length: 1.02, width: 1.12, dynamics: 0.42 },
    tail: { type: 'sickle', thickness: 0.58, curl: 0.68, motion: 0.9 },
    face: { eyeScale: 1.24, eyeSpacing: 1.04, eyeHeight: 1.04, eyeForward: 1.05, noseScale: 0.7, brow: 0 },
    coat: { length: 0.16, body: 0.16, head: 0.14, muzzle: 0.1, ears: 0.1, legs: 0.12, paws: 0.1, tail: 0.16, grooming: 'smooth', pattern: 'tan-points', palette: { undercoat: 0xc99a61, guard: 0x7a4827, root: 0xb57c45, tip: 0xddb47d }, gravityDroop: 0.1, density: 800 },
    furnishings: { ruff: 0 },
    motion: { stride: 0.6, speed: 0.76, sitDepth: 0.58, earDynamics: 0.4, tailMotion: 0.98 },
    variation: { scale: 0.05, build: 0.035, coatShade: 0.16, coatLength: 0.03, energy: 0.3, trainability: 0.2 },
  }),
  // First non-canine profile — same shared skeleton/gait rig, a procyonid
  // silhouette: small, low, long-bodied, rounded head, short pointed
  // muzzle (kept >= 0.5 so it never trips the brachycephalic checks), thick
  // ringed tail. `coat.pattern: 'raccoon-mask'` (dogCoatFields.js) does the
  // actual bandit-mask/ring/grizzled-body work — palette here only sets the
  // two colors that pattern blends between (pale undercoat / near-black guard).
  raccoon: mergeProfile({
    skeleton: { scale: 0.6, bodyLength: 0.9, legLength: 0.78, chestWidth: 0.76, hipWidth: 0.84, neckLength: 0.62, headSize: 1, muzzleLength: 1.04, tailLength: 1.02 },
    geometry: { torsoWidth: 0.9, torsoDepth: 0.98, backArch: 0.024, frontTaper: 0.84, neckWidth: 0.72, skullWidth: 0.9, skullHeight: 0.96, skullLength: 1.08, cheekFullness: 0.72, muzzleWidth: 0.48, legThickness: 0.58, pawSize: 0.72 },
    ears: { type: 'rounded', length: 0.52, width: 0.66, dynamics: 0.5 },
    tail: { type: 'saber', thickness: 1.3, taper: 0.68, curl: 0.1, motion: 0.5 },
    face: {
      eyeScale: 0.86, eyeSpacing: 0.86, eyeHeight: 1.08, eyeForward: 1.04, noseScale: 0.82, brow: 0.08,
      irisColor: 0x17130f, lidColor: 0x777b77, lidDarkColor: 0x303431,
    },
    coat: {
      length: 0.72, body: 0.82, head: 0.64, muzzle: 0.3, ears: 0.48, legs: 0.56, paws: 0.3, tail: 1.05,
      grooming: 'grizzled', pattern: 'raccoon-mask',
      palette: { undercoat: 0xb0b4b2, guard: 0x242826, root: 0x858a88, tip: 0x9a9f9d },
      earInnerTint: [0.025, 0.03, 0.028],
      gravityDroop: 0.22, density: 560,
    },
    furnishings: { ruff: 0 },
    motion: { stride: 0.7, speed: 0.68, sitDepth: 0.75, earDynamics: 0.5, tailMotion: 0.5 },
    variation: { scale: 0.04, build: 0.04, coatShade: 0.12, coatLength: 0.08, energy: 0.25, trainability: 0.2 },
  }),
  // Procyonidae expansions — coati / kinkajou / ringtail on shared dog rig.
  'white-nosed-coati': mergeProfile({
    skeleton: {
      // Longer snout and body than raccoon; long elevated tail.
      scale: 0.62, bodyLength: 1.02, legLength: 0.82, chestWidth: 0.72, hipWidth: 0.78,
      neckLength: 0.7, headSize: 0.96, muzzleLength: 1.28, tailLength: 1.2,
    },
    geometry: {
      torsoWidth: 0.84, torsoDepth: 0.96, backArch: 0.02, frontTaper: 0.86,
      neckWidth: 0.68, skullWidth: 0.86, skullHeight: 0.94,
      skullLength: 1.14, cheekFullness: 0.55, muzzleWidth: 0.42,
      legThickness: 0.56, hindLegThickness: 0.72, pawSize: 0.7,
    },
    ears: { type: 'rounded', length: 0.48, width: 0.62, dynamics: 0.4 },
    tail: { type: 'saber', thickness: 1.05, taper: 0.72, curl: 0.08, motion: 0.7 },
    face: {
      eyeScale: 0.9, eyeSpacing: 0.9, eyeHeight: 1.06, eyeForward: 1.06, noseScale: 0.78, brow: 0.06,
      irisColor: 0x1a1410, lidColor: 0x6a5a48, lidDarkColor: 0x3a2e24,
      hideTeeth: true, noseColor: 0x2a2018, noseBlendColor: 0x4a3a2c,
    },
    coat: {
      length: 0.55, body: 0.62, head: 0.48, muzzle: 0.18, ears: 0.35, legs: 0.45, paws: 0.22, tail: 1.1,
      grooming: 'grizzled', pattern: 'coati-snout',
      palette: { undercoat: 0xd8c8a8, guard: 0x4a3420, root: 0x8a6a40, tip: 0xc8a878 },
      earInnerTint: [0.35, 0.24, 0.18],
      gravityDroop: 0.18, density: 580,
    },
    furnishings: { ruff: 0.04 },
    motion: { stride: 0.78, speed: 0.8, sitDepth: 0.65, earDynamics: 0.4, tailMotion: 0.75 },
    variation: { scale: 0.04, build: 0.04, coatShade: 0.12, coatLength: 0.06, energy: 0.25, trainability: 0.18 },
  }),
  kinkajou: mergeProfile({
    skeleton: {
      // Stockier / shorter-faced arboreal; thick flexible tail.
      scale: 0.55, bodyLength: 0.88, legLength: 0.74, chestWidth: 0.82, hipWidth: 0.86,
      neckLength: 0.58, headSize: 1.02, muzzleLength: 0.72, tailLength: 1.15,
    },
    geometry: {
      torsoWidth: 0.92, torsoDepth: 1.0, backArch: 0.03, frontTaper: 0.88,
      neckWidth: 0.78, skullWidth: 0.98, skullHeight: 1.02,
      skullLength: 0.92, cheekFullness: 0.8, muzzleWidth: 0.62,
      legThickness: 0.62, hindLegThickness: 0.82, pawSize: 0.74,
    },
    ears: { type: 'rounded', length: 0.42, width: 0.58, dynamics: 0.28 },
    // Thick saber tail reads prehensile-ish under shared rig limits.
    tail: { type: 'saber', thickness: 1.45, taper: 0.55, curl: 0.2, motion: 0.85 },
    face: {
      eyeScale: 1.05, eyeSpacing: 0.94, eyeHeight: 1.06, eyeForward: 1.08, noseScale: 0.75, brow: 0.04,
      irisColor: 0x2a1e14, lidColor: 0xc89850, lidDarkColor: 0x8a6a38,
      hideTeeth: true, noseColor: 0x3a2a1c, noseBlendColor: 0x6a4a30,
    },
    coat: {
      length: 0.45, body: 0.5, head: 0.4, muzzle: 0.16, ears: 0.22, legs: 0.38, paws: 0.16, tail: 0.95,
      grooming: 'short', pattern: 'solid',
      // Warm honey-gold (Potos flavus).
      palette: { undercoat: 0xe8b868, guard: 0xc07828, root: 0xd89840, tip: 0xf0c878 },
      earInnerTint: [0.55, 0.35, 0.22],
      gravityDroop: 0.16, density: 600,
    },
    furnishings: { ruff: 0.06 },
    motion: { stride: 0.62, speed: 0.72, sitDepth: 0.7, earDynamics: 0.28, tailMotion: 0.9 },
    variation: { scale: 0.04, build: 0.04, coatShade: 0.1, coatLength: 0.05, energy: 0.22, trainability: 0.18 },
  }),
  ringtail: mergeProfile({
    skeleton: {
      // Slender, longer legs/body than raccoon; very long ringed tail.
      scale: 0.52, bodyLength: 0.96, legLength: 0.9, chestWidth: 0.68, hipWidth: 0.72,
      neckLength: 0.72, headSize: 0.94, muzzleLength: 1.08, tailLength: 1.35,
    },
    geometry: {
      torsoWidth: 0.78, torsoDepth: 0.9, backArch: 0.018, frontTaper: 0.86,
      neckWidth: 0.64, skullWidth: 0.88, skullHeight: 0.96,
      skullLength: 1.06, cheekFullness: 0.55, muzzleWidth: 0.48,
      legThickness: 0.52, hindLegThickness: 0.68, pawSize: 0.64,
    },
    ears: { type: 'rounded', length: 0.58, width: 0.64, dynamics: 0.45 },
    tail: { type: 'saber', thickness: 0.95, taper: 0.75, curl: 0.06, motion: 0.8 },
    face: {
      eyeScale: 1.0, eyeSpacing: 0.92, eyeHeight: 1.08, eyeForward: 1.06, noseScale: 0.78, brow: 0.05,
      irisColor: 0x2a2418, lidColor: 0x8a8070, lidDarkColor: 0x4a4438,
      hideTeeth: true, noseColor: 0x2a221c, noseBlendColor: 0x4a3a32,
    },
    coat: {
      length: 0.5, body: 0.55, head: 0.42, muzzle: 0.18, ears: 0.32, legs: 0.4, paws: 0.18, tail: 1.15,
      grooming: 'short', pattern: 'ringed-tail',
      palette: { undercoat: 0xd8d0c4, guard: 0x4a463c, root: 0x8a8478, tip: 0xc8c0b4 },
      earInnerTint: [0.4, 0.32, 0.26],
      gravityDroop: 0.16, density: 600,
    },
    furnishings: { ruff: 0.02 },
    motion: { stride: 0.82, speed: 0.88, sitDepth: 0.6, earDynamics: 0.42, tailMotion: 0.85 },
    variation: { scale: 0.04, build: 0.04, coatShade: 0.12, coatLength: 0.05, energy: 0.25, trainability: 0.18 },
  }),
  // Feline P0 — short-muzzle erect-ear domestic cat silhouette. Coat patterns
  // `tortoiseshell` / `solid-white` live in dogCoatFields.js; Khao Manee eye
  // pairs are variant merges (dogVariantProfiles.js).
  tortoiseshell: mergeProfile({
    skeleton: {
      scale: 0.52, bodyLength: 0.88, legLength: 0.86, chestWidth: 0.72, hipWidth: 0.7,
      neckLength: 0.72, headSize: 0.96, muzzleLength: 0.52, tailLength: 1.05,
    },
    geometry: {
      torsoWidth: 0.78, torsoDepth: 0.9, neckWidth: 0.68, skullWidth: 0.98, skullHeight: 1.02,
      skullLength: 0.88, cheekFullness: 0.7, muzzleWidth: 0.62,
      legThickness: 0.82, hindLegThickness: 1.08, pawSize: 0.74,
    },
    ears: { type: 'erect', length: 1.05, width: 0.95, dynamics: 0.35 },
    tail: { type: 'straight', thickness: 0.62, curl: 0.05, motion: 0.85 },
    face: {
      eyeScale: 1.28, eyeSpacing: 0.98, eyeHeight: 1.06, eyeForward: 1.08, noseScale: 0.72, brow: 0.05,
      eyeStyle: 'feline', pupilAspect: 0.32, scleraAmount: 0.04,
      // Ref board: yellow-green iris, black nose leather, dark lids.
      irisColor: 0xaec24e, lidColor: 0x2a2420, lidDarkColor: 0x1a1614,
    },
    coat: {
      // Longhair tortie: retriever-plush shell volume (golden-retriever body
      // fur is the length reference), feathered britches/tail plume, short
      // face so eyes/nose stay readable.
      // Tail multiplies the 0.06m plume base — keep it low or the thin cat
      // tail drowns in a translucent fur halo that reads as one-sided fog.
      length: 0.85, body: 1.0, head: 0.42, muzzle: 0.16, ears: 0.4, legs: 0.6, paws: 0.28, tail: 0.5,
      grooming: 'feathered', pattern: 'tortoiseshell',
      // Tri-color mask: 0 → ginger undercoat, 0.5 → chocolate midcoat,
      // 1 → warm near-black guard. Refs read duller than a marmalade tabby —
      // keep the orange desaturated.
      palette: { undercoat: 0xbf742e, midcoat: 0x6e4526, guard: 0x120e0a, root: 0x8a5a30, tip: 0xe8b46a },
      // Inner pinna stays dark (ref ears are near-black inside; the default
      // tint reads rust under the warm key light).
      earInnerTint: [0.035, 0.022, 0.02],
      // Long coat with modest lay: high lean/droop slides the shells along
      // the groom, smearing the bold tortie patches into glassy streaks.
      gravityDroop: 0.4, density: 440, sheen: 0.22, lean: 0.5,
      // Re-quantize the interpolated mask to orange/brown/black plateaus
      // per-fragment — without it the coarse loft smears patches into streaks.
      maskSharpness: 0.85,
    },
    furnishings: { ruff: 0.05 },
    motion: { stride: 0.58, speed: 0.88, sitDepth: 0.55, earDynamics: 0.32, tailMotion: 0.9 },
    variation: { scale: 0.04, build: 0.04, coatShade: 0.1, coatLength: 0.04, energy: 0.22, trainability: 0.18 },
  }),
  'khao-manee': mergeProfile({
    skeleton: {
      scale: 0.5, bodyLength: 0.86, legLength: 0.88, chestWidth: 0.68, hipWidth: 0.66,
      neckLength: 0.74, headSize: 0.94, muzzleLength: 0.5, tailLength: 1.02,
    },
    geometry: {
      torsoWidth: 0.74, torsoDepth: 0.88, neckWidth: 0.64, skullWidth: 0.96, skullHeight: 1.0,
      skullLength: 0.86, cheekFullness: 0.65, muzzleWidth: 0.58,
      legThickness: 0.76, hindLegThickness: 1.0, pawSize: 0.7,
    },
    ears: { type: 'erect', length: 1.08, width: 0.92, dynamics: 0.32 },
    tail: { type: 'straight', thickness: 0.55, curl: 0.04, motion: 0.88 },
    face: {
      eyeScale: 1.32, eyeSpacing: 1.0, eyeHeight: 1.08, eyeForward: 1.1, noseScale: 0.68, brow: 0.02,
      eyeStyle: 'feline', pupilAspect: 0.28, scleraAmount: 0.05,
      // Default odd-eye; variants override irisColor / irisColorL / irisColorR.
      irisColor: 0x3a7fd4,
      irisColorL: 0x3a7fd4,
      irisColorR: 0x4cb86a,
      lidColor: 0xf0c8c0,
      lidDarkColor: 0xd8a090,
      noseColor: 0xe8a090,
      noseBlendColor: 0xf5d4c8,
    },
    coat: {
      length: 0.22, body: 0.24, head: 0.2, muzzle: 0.12, ears: 0.14, legs: 0.18, paws: 0.12, tail: 0.26,
      grooming: 'short', pattern: 'solid-white',
      palette: { undercoat: 0xf7f4ef, guard: 0xe8e4dc, root: 0xf0ebe4, tip: 0xffffff },
      gravityDroop: 0.1, density: 700,
    },
    furnishings: { ruff: 0 },
    motion: { stride: 0.56, speed: 0.9, sitDepth: 0.52, earDynamics: 0.3, tailMotion: 0.92 },
    variation: { scale: 0.035, build: 0.03, coatShade: 0.04, coatLength: 0.03, energy: 0.2, trainability: 0.18 },
  }),
  // ---- Feline P1: first-pass authored profiles for every cat-ref board.
  // Silhouette/palette/eyes from assets-source/cat-ref/reference-board-prompts.json;
  // one authoring pass each against the generated reference photos.
  'domestic-shorthair': felineProfile({
    coat: {
      pattern: 'cat-tabby',
      palette: { undercoat: 0xc59a62, guard: 0x4a3320, root: 0x96703f, tip: 0xdcb87e },
    },
    face: { irisColor: 0xd9a53c },
  }),
  'domestic-longhair': felineProfile({
    coat: {
      length: 0.85, body: 0.95, head: 0.5, tail: 1.25, pattern: 'cat-tabby',
      palette: { undercoat: 0xe0a058, guard: 0xa85a22, root: 0xb87838, tip: 0xf0c684 },
      gravityDroop: 0.24, density: 520,
    },
    furnishings: { ruff: 0.5, mane: 0.5 },
    face: { irisColor: 0x7fae52 },
  }),
  siamese: felineProfile({
    skeleton: { scale: 0.5, bodyLength: 0.92, legLength: 0.94, neckLength: 0.85, muzzleLength: 0.62, tailLength: 1.1 },
    geometry: { torsoWidth: 0.66, torsoDepth: 0.82, neckWidth: 0.6, skullLength: 0.98, muzzleWidth: 0.55, legThickness: 0.7 },
    ears: { length: 1.32, width: 1.08 },
    tail: { thickness: 0.48 },
    face: { irisColor: 0x4a7fd4, eyeScale: 1.24 },
    coat: {
      length: 0.22, pattern: 'cat-colorpoint',
      palette: { undercoat: 0xe8dcc4, guard: 0x3a2419, root: 0xb8a488, tip: 0xf2e8d4 },
    },
  }),
  persian: felineProfile({
    skeleton: { scale: 0.56, bodyLength: 0.82, legLength: 0.7, chestWidth: 0.86, hipWidth: 0.86, neckLength: 0.6, muzzleLength: 0.34, tailLength: 0.8 },
    geometry: { torsoWidth: 0.92, torsoDepth: 1.0, neckWidth: 0.82, skullWidth: 1.1, skullLength: 0.8, cheekFullness: 0.95, muzzleWidth: 0.85, legThickness: 0.92 },
    ears: { length: 0.6, width: 0.8, dynamics: 0.2 },
    tail: { thickness: 0.85 },
    face: { irisColor: 0xc06a28, eyeScale: 1.34, noseScale: 0.6 },
    coat: {
      length: 1.4, body: 1.55, head: 1.0, muzzle: 0.3, ears: 0.5, legs: 0.9, paws: 0.6, tail: 1.5,
      grooming: 'stand-off-double', pattern: 'solid',
      palette: { undercoat: 0xead9bc, guard: 0xcdb27e, root: 0xd8c298, tip: 0xf4e8cc },
      gravityDroop: 0.34, density: 380,
    },
    furnishings: { ruff: 0.95, mane: 1 },
    motion: { stride: 0.5, speed: 0.7, sitDepth: 0.6 },
  }),
  'maine-coon': felineProfile({
    skeleton: { scale: 0.68, bodyLength: 1.0, legLength: 0.9, chestWidth: 0.8, hipWidth: 0.78, tailLength: 1.15 },
    geometry: { torsoWidth: 0.85, torsoDepth: 0.95, muzzleWidth: 0.7 },
    ears: { length: 1.18, width: 0.95 },
    tail: { thickness: 0.8 },
    face: { irisColor: 0xb5b04a },
    coat: {
      length: 1.05, body: 1.2, head: 0.55, tail: 1.55, legs: 0.7, pattern: 'cat-tabby',
      palette: { undercoat: 0xc29a68, guard: 0x3f2c1a, root: 0xa07c50, tip: 0xdcb888 },
      gravityDroop: 0.26, density: 480,
    },
    furnishings: { ruff: 0.6, mane: 0.7 },
  }),
  ragdoll: felineProfile({
    skeleton: { scale: 0.64, bodyLength: 0.94, chestWidth: 0.8, hipWidth: 0.78 },
    geometry: { torsoWidth: 0.85, torsoDepth: 0.95 },
    face: { irisColor: 0x5a8bd6 },
    coat: {
      length: 0.9, body: 1.0, head: 0.45, tail: 1.35, pattern: 'cat-colorpoint',
      palette: { undercoat: 0xece2d0, guard: 0x6b7684, root: 0xc0b8aa, tip: 0xf4ecdc },
      gravityDroop: 0.24, density: 500,
    },
    furnishings: { ruff: 0.55, mane: 0.6 },
    motion: { stride: 0.55, speed: 0.78 },
  }),
  bengal: felineProfile({
    skeleton: { scale: 0.56, bodyLength: 0.92, legLength: 0.92 },
    geometry: { torsoWidth: 0.8, legThickness: 0.88 },
    face: { irisColor: 0xbfae4a },
    coat: {
      length: 0.2, pattern: 'cat-spotted',
      palette: { undercoat: 0xd8a24e, guard: 0x241a10, root: 0xa87838, tip: 0xecc27a },
    },
  }),
  'british-shorthair': felineProfile({
    skeleton: { scale: 0.58, bodyLength: 0.84, legLength: 0.78, chestWidth: 0.86, hipWidth: 0.86, neckLength: 0.62, tailLength: 0.9 },
    geometry: { torsoWidth: 0.92, torsoDepth: 1.0, neckWidth: 0.82, skullWidth: 1.12, cheekFullness: 1.0, muzzleWidth: 0.78, legThickness: 0.98 },
    ears: { length: 0.78, width: 0.85, dynamics: 0.22 },
    tail: { thickness: 0.8 },
    face: { irisColor: 0xc98230, eyeScale: 1.34 },
    coat: {
      length: 0.34, body: 0.38, pattern: 'solid',
      palette: { undercoat: 0x99a0af, guard: 0x6d7484, root: 0x848b9a, tip: 0xb4bac6 },
      density: 700,
    },
    motion: { stride: 0.52, speed: 0.74 },
  }),
  'american-shorthair': felineProfile({
    skeleton: { scale: 0.56 },
    face: { irisColor: 0x76a848 },
    coat: {
      pattern: 'cat-tabby',
      palette: { undercoat: 0xc9ccd2, guard: 0x2e2f33, root: 0x9a9da4, tip: 0xdee1e6 },
    },
  }),
  'scottish-fold': felineProfile({
    skeleton: { scale: 0.52, bodyLength: 0.84, chestWidth: 0.78, hipWidth: 0.78 },
    geometry: { skullWidth: 1.08, cheekFullness: 0.9 },
    ears: { type: 'folded', fold: 'button', length: 0.5, width: 0.8, dynamics: 0.15 },
    face: { irisColor: 0xd0a63c, eyeScale: 1.4 },
    coat: {
      pattern: 'cat-tabby',
      palette: { undercoat: 0xc6c9cf, guard: 0x3a3b40, root: 0x9a9da4, tip: 0xdcdfe4 },
    },
  }),
  abyssinian: felineProfile({
    skeleton: { scale: 0.5, bodyLength: 0.85, legLength: 0.94, neckLength: 0.78 },
    geometry: { torsoWidth: 0.68, torsoDepth: 0.84, legThickness: 0.74 },
    ears: { length: 1.22, width: 1.0 },
    face: { irisColor: 0xcfa63e },
    coat: {
      length: 0.2, pattern: 'cat-ticked',
      palette: { undercoat: 0xc98a4e, guard: 0x7a3f1e, root: 0xa06a34, tip: 0xe2ac6c },
    },
  }),
  'russian-blue': felineProfile({
    skeleton: { scale: 0.5, legLength: 0.9 },
    geometry: { torsoWidth: 0.72, legThickness: 0.74 },
    ears: { length: 1.15 },
    face: { irisColor: 0x59b04a },
    coat: {
      length: 0.24, pattern: 'solid',
      palette: { undercoat: 0x9aa3b0, guard: 0x7b8494, root: 0x8a93a2, tip: 0xdfe4ea },
      density: 720,
    },
  }),
  sphynx: felineProfile({
    skeleton: { scale: 0.5, legLength: 0.92, neckLength: 0.82, tailLength: 1.1 },
    geometry: { torsoWidth: 0.7, torsoDepth: 0.82, skullLength: 0.95, cheekFullness: 0.5, legThickness: 0.72 },
    ears: { type: 'bat', length: 1.4, width: 1.25 },
    tail: { thickness: 0.36 },
    face: { irisColor: 0xbfae4a, lidColor: 0xc9a08e, lidDarkColor: 0x8a6a58 },
    coat: {
      length: 0.1, body: 0.1, head: 0.1, muzzle: 0.05, ears: 0.05, legs: 0.08, paws: 0.08, tail: 0.08,
      pattern: 'solid',
      palette: { undercoat: 0xd9b49a, guard: 0xb98f78, root: 0xc4a088, tip: 0xe4c4aa },
      earInnerTint: [0.16, 0.09, 0.075],
      density: 300,
    },
  }),
  'norwegian-forest': felineProfile({
    skeleton: { scale: 0.66, bodyLength: 0.96, legLength: 0.92, chestWidth: 0.8, hipWidth: 0.78, tailLength: 1.12 },
    geometry: { torsoWidth: 0.84 },
    ears: { length: 1.12 },
    tail: { thickness: 0.78 },
    face: { irisColor: 0x74a64c },
    coat: {
      length: 1.0, body: 1.15, head: 0.5, tail: 1.55, legs: 0.65, pattern: 'cat-tabby',
      palette: { undercoat: 0xbfc3c9, guard: 0x33343a, root: 0x8f939a, tip: 0xd8dbe0 },
      gravityDroop: 0.26, density: 470,
    },
    furnishings: { ruff: 0.7, mane: 0.75 },
  }),
  siberian: felineProfile({
    skeleton: { scale: 0.66, bodyLength: 0.95, chestWidth: 0.82, hipWidth: 0.8 },
    geometry: { torsoWidth: 0.86, skullWidth: 1.04 },
    tail: { thickness: 0.78 },
    face: { irisColor: 0x9fae4a },
    coat: {
      length: 0.95, body: 1.1, head: 0.5, tail: 1.45, legs: 0.65, pattern: 'cat-tabby',
      palette: { undercoat: 0xc49666, guard: 0x453019, root: 0xa07a4e, tip: 0xdcb684 },
      gravityDroop: 0.25, density: 490,
    },
    furnishings: { ruff: 0.65, mane: 0.7 },
  }),
  birman: felineProfile({
    skeleton: { scale: 0.6, bodyLength: 0.9, chestWidth: 0.78, hipWidth: 0.76 },
    geometry: { torsoWidth: 0.82 },
    face: { irisColor: 0x3f6fd0 },
    coat: {
      length: 0.85, body: 0.95, head: 0.45, tail: 1.3, pattern: 'cat-colorpoint', pointGloves: true,
      palette: { undercoat: 0xe9ddc6, guard: 0x43301f, root: 0xc0b096, tip: 0xf2e8d2 },
      gravityDroop: 0.22, density: 520,
    },
    furnishings: { ruff: 0.5, mane: 0.55 },
  }),
  'exotic-shorthair': felineProfile({
    skeleton: { scale: 0.56, bodyLength: 0.82, legLength: 0.72, chestWidth: 0.86, hipWidth: 0.86, neckLength: 0.6, muzzleLength: 0.34, tailLength: 0.82 },
    geometry: { torsoWidth: 0.92, torsoDepth: 1.0, neckWidth: 0.82, skullWidth: 1.1, skullLength: 0.8, cheekFullness: 0.95, muzzleWidth: 0.85, legThickness: 0.92 },
    ears: { length: 0.62, width: 0.8, dynamics: 0.2 },
    tail: { thickness: 0.82 },
    face: { irisColor: 0xc06a28, eyeScale: 1.36, noseScale: 0.6 },
    coat: {
      length: 0.42, body: 0.48, pattern: 'solid',
      palette: { undercoat: 0xe6d3af, guard: 0xcdb27e, root: 0xd6c096, tip: 0xf2e4c4 },
      density: 620,
    },
    motion: { stride: 0.5, speed: 0.72 },
  }),
  'devon-rex': felineProfile({
    skeleton: { scale: 0.46, bodyLength: 0.84, legLength: 0.9, neckLength: 0.8, muzzleLength: 0.45, tailLength: 1.1 },
    geometry: { torsoWidth: 0.68, skullWidth: 1.02, cheekFullness: 0.78, legThickness: 0.68 },
    ears: { type: 'bat', length: 1.42, width: 1.3, dynamics: 0.3 },
    tail: { thickness: 0.4 },
    face: { irisColor: 0xbfae4a, eyeScale: 1.36 },
    coat: {
      length: 0.14, pattern: 'solid',
      palette: { undercoat: 0xa8a4a0, guard: 0x76716c, root: 0x8e8a86, tip: 0xbcb8b4 },
      density: 560,
    },
  }),
  'cornish-rex': felineProfile({
    skeleton: { scale: 0.48, bodyLength: 0.9, legLength: 1.0, neckLength: 0.85, tailLength: 1.15 },
    geometry: { torsoWidth: 0.64, torsoDepth: 0.8, skullLength: 0.95, legThickness: 0.66 },
    ears: { length: 1.38, width: 1.1 },
    tail: { thickness: 0.36 },
    face: { irisColor: 0xc9a24a, noseColor: 0xe8a090, noseBlendColor: 0xf5d4c8 },
    coat: {
      length: 0.12, pattern: 'solid-white',
      palette: { undercoat: 0xf3f0ea, guard: 0xe2ded6, root: 0xece8e0, tip: 0xfbf9f5 },
      density: 560,
    },
  }),
  savannah: felineProfile({
    skeleton: { scale: 0.72, bodyLength: 0.95, legLength: 1.14, neckLength: 0.85, headSize: 0.9, tailLength: 0.95 },
    geometry: { torsoWidth: 0.74, torsoDepth: 0.85, legThickness: 0.8 },
    ears: { length: 1.45, width: 1.15 },
    tail: { thickness: 0.6 },
    face: { irisColor: 0xcfa63e },
    coat: {
      length: 0.2, pattern: 'cat-spotted',
      palette: { undercoat: 0xcfa254, guard: 0x201812, root: 0xa07c40, tip: 0xe4c076 },
    },
  }),
  manx: felineProfile({
    skeleton: { scale: 0.54, bodyLength: 0.8, chestWidth: 0.8, hipWidth: 0.84, tailLength: 0.15 },
    geometry: { torsoWidth: 0.86, skullWidth: 1.06, cheekFullness: 0.85 },
    tail: { thickness: 0.5, motion: 0.3 },
    face: { irisColor: 0xc06a28 },
    coat: {
      pattern: 'cat-tabby',
      palette: { undercoat: 0xd99a55, guard: 0xa85820, root: 0xb87838, tip: 0xecb87c },
    },
  }),
  bombay: felineProfile({
    skeleton: { scale: 0.52, chestWidth: 0.78 },
    geometry: { torsoWidth: 0.84, skullWidth: 1.04, cheekFullness: 0.82 },
    face: { irisColor: 0xd08c2e, eyeScale: 1.34 },
    coat: {
      length: 0.2, pattern: 'solid',
      palette: { undercoat: 0x1c1a18, guard: 0x0e0c0a, root: 0x141210, tip: 0x2e2a26 },
      earInnerTint: [0.02, 0.014, 0.012],
      density: 740,
    },
  }),
  chartreux: felineProfile({
    skeleton: { scale: 0.6, chestWidth: 0.82, hipWidth: 0.8 },
    geometry: { torsoWidth: 0.88, skullWidth: 1.06, cheekFullness: 0.88, legThickness: 0.9 },
    face: { irisColor: 0xc9742a, eyeScale: 1.3 },
    coat: {
      length: 0.3, body: 0.34, pattern: 'solid',
      palette: { undercoat: 0x8f97a6, guard: 0x6a7280, root: 0x7d8594, tip: 0xaab1be },
      density: 680,
    },
  }),
  'turkish-angora': felineProfile({
    skeleton: { scale: 0.5, legLength: 0.92, neckLength: 0.8 },
    geometry: { torsoWidth: 0.68, legThickness: 0.72 },
    ears: { length: 1.25 },
    face: { irisColor: 0x5a8bd6, noseColor: 0xe8a090, noseBlendColor: 0xf5d4c8, lidColor: 0xe0c0b8, lidDarkColor: 0xb89088 },
    coat: {
      length: 0.7, body: 0.8, head: 0.4, tail: 1.35, pattern: 'solid-white',
      palette: { undercoat: 0xf5f2ec, guard: 0xe4e0d8, root: 0xeeeae2, tip: 0xfdfbf7 },
      gravityDroop: 0.22, density: 520,
    },
    furnishings: { ruff: 0.4 },
  }),
  'turkish-van': felineProfile({
    skeleton: { scale: 0.62, bodyLength: 0.94, legLength: 0.92 },
    geometry: { torsoWidth: 0.8 },
    face: { irisColor: 0xcf9a3a },
    coat: {
      length: 0.6, body: 0.7, head: 0.35, tail: 1.3, pattern: 'cat-van',
      palette: { undercoat: 0xefe9dd, guard: 0xa8542a, root: 0xd8ccb8, tip: 0xf8f2e6 },
      gravityDroop: 0.2, density: 540,
    },
  }),
  burmese: felineProfile({
    skeleton: { scale: 0.52, bodyLength: 0.86, chestWidth: 0.78 },
    geometry: { torsoWidth: 0.84, skullWidth: 1.04, cheekFullness: 0.82 },
    face: { irisColor: 0xd0a63c, eyeScale: 1.32 },
    coat: {
      length: 0.18, pattern: 'solid',
      palette: { undercoat: 0x59422e, guard: 0x3a2a1c, root: 0x4a3624, tip: 0x6e5238 },
      earInnerTint: [0.035, 0.024, 0.02],
      density: 720,
    },
  }),
  tonkinese: felineProfile({
    skeleton: { scale: 0.5, bodyLength: 0.9 },
    geometry: { torsoWidth: 0.72 },
    face: { irisColor: 0x64b8a8 },
    coat: {
      length: 0.2, pattern: 'cat-colorpoint',
      palette: { undercoat: 0xb9aa96, guard: 0x5f6b74, root: 0x9a8e7c, tip: 0xd0c4b0 },
    },
  }),
  'oriental-shorthair': felineProfile({
    skeleton: { scale: 0.5, bodyLength: 0.94, legLength: 0.96, neckLength: 0.88, muzzleLength: 0.64, tailLength: 1.15 },
    geometry: { torsoWidth: 0.62, torsoDepth: 0.78, neckWidth: 0.56, skullLength: 1.0, muzzleWidth: 0.52, legThickness: 0.66 },
    ears: { type: 'bat', length: 1.5, width: 1.3 },
    tail: { thickness: 0.36 },
    face: { irisColor: 0x63a848 },
    coat: {
      length: 0.16, pattern: 'solid',
      palette: { undercoat: 0x201c1a, guard: 0x100e0c, root: 0x181412, tip: 0x322c28 },
      earInnerTint: [0.02, 0.014, 0.012],
      density: 740,
    },
  }),
  himalayan: felineProfile({
    skeleton: { scale: 0.56, bodyLength: 0.82, legLength: 0.7, chestWidth: 0.86, hipWidth: 0.86, neckLength: 0.6, muzzleLength: 0.34, tailLength: 0.8 },
    geometry: { torsoWidth: 0.92, torsoDepth: 1.0, neckWidth: 0.82, skullWidth: 1.1, skullLength: 0.8, cheekFullness: 0.95, muzzleWidth: 0.85, legThickness: 0.92 },
    ears: { length: 0.6, width: 0.8, dynamics: 0.2 },
    tail: { thickness: 0.85 },
    face: { irisColor: 0x4a7fd4, eyeScale: 1.36, noseScale: 0.6 },
    coat: {
      length: 1.3, body: 1.45, head: 0.9, muzzle: 0.28, ears: 0.45, legs: 0.85, paws: 0.55, tail: 1.45,
      grooming: 'stand-off-double', pattern: 'cat-colorpoint',
      palette: { undercoat: 0xe9dcc2, guard: 0x43301f, root: 0xc4b498, tip: 0xf2e8d0 },
      gravityDroop: 0.33, density: 390,
    },
    furnishings: { ruff: 0.9, mane: 1 },
    motion: { stride: 0.5, speed: 0.68 },
  }),
  ragamuffin: felineProfile({
    skeleton: { scale: 0.66, bodyLength: 0.96, chestWidth: 0.82, hipWidth: 0.8 },
    geometry: { torsoWidth: 0.88 },
    face: { irisColor: 0xa87838 },
    coat: {
      length: 0.95, body: 1.05, head: 0.5, tail: 1.4, pattern: 'pied',
      palette: { undercoat: 0xe4d8c2, guard: 0x8b8f98, root: 0xc4b8a2, tip: 0xf0e6d2 },
      gravityDroop: 0.25, density: 480,
    },
    furnishings: { ruff: 0.6, mane: 0.75 },
    motion: { stride: 0.55, speed: 0.75 },
  }),
  nebelung: felineProfile({
    skeleton: { scale: 0.52, legLength: 0.9 },
    geometry: { torsoWidth: 0.72, legThickness: 0.74 },
    ears: { length: 1.15 },
    face: { irisColor: 0x59b04a },
    coat: {
      length: 0.6, body: 0.7, head: 0.35, tail: 1.35, pattern: 'solid',
      palette: { undercoat: 0x9aa3b0, guard: 0x7b8494, root: 0x8a93a2, tip: 0xdfe4ea },
      gravityDroop: 0.2, density: 560,
    },
  }),
  munchkin: felineProfile({
    skeleton: { scale: 0.46, legLength: 0.55, tailLength: 1.15 },
    geometry: { legThickness: 0.85 },
    face: { irisColor: 0xcfa63e },
    coat: {
      pattern: 'cat-tabby',
      palette: { undercoat: 0xc6c9cf, guard: 0x3a3b40, root: 0x9a9da4, tip: 0xdcdfe4 },
    },
  }),
  'egyptian-mau': felineProfile({
    skeleton: { scale: 0.52, bodyLength: 0.88, legLength: 0.92 },
    geometry: { torsoWidth: 0.72 },
    face: { irisColor: 0x8fbf4e },
    coat: {
      length: 0.2, pattern: 'cat-spotted',
      palette: { undercoat: 0xc6c9cf, guard: 0x2c2d31, root: 0x9a9da4, tip: 0xdcdfe4 },
    },
  }),
  somali: felineProfile({
    skeleton: { scale: 0.52, bodyLength: 0.86, legLength: 0.92, neckLength: 0.78 },
    geometry: { torsoWidth: 0.7, legThickness: 0.74 },
    ears: { length: 1.2 },
    tail: { thickness: 0.7 },
    face: { irisColor: 0xcfa63e },
    coat: {
      length: 0.65, body: 0.75, head: 0.35, tail: 1.5, pattern: 'cat-ticked',
      palette: { undercoat: 0xc98a4e, guard: 0x7a3f1e, root: 0xa06a34, tip: 0xe2ac6c },
      gravityDroop: 0.2, density: 540,
    },
    furnishings: { ruff: 0.5, mane: 0.55 },
  }),
  balinese: felineProfile({
    skeleton: { scale: 0.5, bodyLength: 0.92, legLength: 0.94, neckLength: 0.85, muzzleLength: 0.62, tailLength: 1.12 },
    geometry: { torsoWidth: 0.66, torsoDepth: 0.82, neckWidth: 0.6, skullLength: 0.98, muzzleWidth: 0.55, legThickness: 0.7 },
    ears: { length: 1.3, width: 1.06 },
    tail: { thickness: 0.5 },
    face: { irisColor: 0x4a7fd4, eyeScale: 1.24 },
    coat: {
      length: 0.6, body: 0.7, head: 0.35, tail: 1.4, pattern: 'cat-colorpoint',
      palette: { undercoat: 0xe8dcc4, guard: 0x3a2419, root: 0xc0b096, tip: 0xf2e8d4 },
      gravityDroop: 0.2, density: 540,
    },
  }),
  'japanese-bobtail': felineProfile({
    skeleton: { scale: 0.5, bodyLength: 0.88, legLength: 0.92, tailLength: 0.28 },
    geometry: { torsoWidth: 0.72 },
    ears: { length: 1.18 },
    tail: { thickness: 0.9, curl: 0.5, motion: 0.6 },
    face: { irisColor: 0xd0a63c },
    coat: {
      pattern: 'cat-mike',
      palette: { undercoat: 0xece5da, guard: 0x2a1812, root: 0xb08050, tip: 0xf2eade },
    },
  }),
  singapura: felineProfile({
    skeleton: { scale: 0.42, bodyLength: 0.82, headSize: 1.0 },
    geometry: { torsoWidth: 0.7, legThickness: 0.72 },
    ears: { length: 1.28, width: 1.05 },
    face: { irisColor: 0xb0a04a, eyeScale: 1.36 },
    coat: {
      length: 0.16, pattern: 'cat-ticked',
      palette: { undercoat: 0xd3b58a, guard: 0x8a5f38, root: 0xb08c58, tip: 0xe8cfa4 },
    },
  }),
  ocicat: felineProfile({
    skeleton: { scale: 0.58, bodyLength: 0.92, legLength: 0.92 },
    geometry: { torsoWidth: 0.78 },
    face: { irisColor: 0xcfa63e },
    coat: {
      length: 0.2, pattern: 'cat-spotted',
      palette: { undercoat: 0xc9a05e, guard: 0x4c3018, root: 0xa07c44, tip: 0xe0bc80 },
    },
  }),
  'havana-brown': felineProfile({
    skeleton: { scale: 0.52, bodyLength: 0.88 },
    geometry: { torsoWidth: 0.76, muzzleWidth: 0.68 },
    ears: { length: 1.15 },
    face: { irisColor: 0x5aa848 },
    coat: {
      length: 0.18, pattern: 'solid',
      palette: { undercoat: 0x6b4028, guard: 0x4a2b18, root: 0x5a3620, tip: 0x805034 },
      earInnerTint: [0.045, 0.028, 0.022],
      density: 720,
    },
  }),
  'american-curl': felineProfile({
    skeleton: { scale: 0.52 },
    ears: { length: 0.78, width: 0.9, dynamics: 0.2 },
    face: { irisColor: 0xa87838 },
    coat: {
      length: 0.55, body: 0.65, head: 0.35, tail: 1.3, pattern: 'solid',
      palette: { undercoat: 0xe7d7b8, guard: 0xcdb082, root: 0xd8c298, tip: 0xf2e6ca },
      gravityDroop: 0.2, density: 560,
    },
  }),
  'selkirk-rex': felineProfile({
    skeleton: { scale: 0.58, bodyLength: 0.86, chestWidth: 0.82, hipWidth: 0.8 },
    geometry: { torsoWidth: 0.88, skullWidth: 1.06, cheekFullness: 0.9 },
    face: { irisColor: 0xcfa63e, eyeScale: 1.32 },
    coat: {
      length: 0.55, body: 0.65, head: 0.4, tail: 0.9, pattern: 'pied',
      palette: { undercoat: 0xe3d6bf, guard: 0x99a0ac, root: 0xc2b6a0, tip: 0xf0e4cc },
      gravityDroop: 0.32, density: 340,
    },
  }),
  // Norway rat (Rattus norvegicus) — stocky muridae, cool grey-brown grizzle,
  // pale belly, pink nose/ears/paws, long thin scaly tail. Pattern
  // `murine-agouti` owns countershading; palette is cool vs house-mouse warm.
  //
  // Shared-rig hard stops: plantigrade feet / true pink scaly skin (paws read
  // via pale coat + geometry). Upright sit remains a quadruped crouch.
  'norway-rat': rodentProfile({
    skeleton: {
      scale: 0.38, bodyLength: 0.96, legLength: 0.55, frontLegScale: 0.88,
      chestWidth: 0.78, hipWidth: 0.8,
      neckLength: 0.52, headSize: 0.94, muzzleLength: 0.88, tailLength: 1.22,
    },
    geometry: {
      torsoWidth: 0.82, torsoDepth: 0.96, backArch: 0.02, frontTaper: 0.88,
      neckWidth: 0.68, skullWidth: 0.92, skullHeight: 0.96,
      skullLength: 0.98, cheekFullness: 0.62, muzzleWidth: 0.6,
      legThickness: 0.48, hindLegThickness: 0.62, pawSize: 0.5,
    },
    // Modest rounded-erect pinnae (smaller relative than house mouse).
    ears: { type: 'erect', length: 0.58, width: 0.72, dynamics: 0.24 },
    // Long thin scaly tail — straight, low thickness, almost no fur.
    tail: { type: 'straight', thickness: 0.32, taper: 0.92, curl: 0.02, motion: 0.72 },
    face: {
      eyeScale: 1.18, eyeSpacing: 0.94, eyeHeight: 1.02, eyeForward: 1.06, noseScale: 0.72, brow: 0.02,
      irisColor: 0x100e0c, lidColor: 0x8a7a70, lidDarkColor: 0x5a4a42,
      lidOpacity: 0.28, lidScale: 0.52,
      hideTeeth: true,
      // Soft pink nose (refs).
      noseColor: 0xd4a098, noseBlendColor: 0xe8c0b4,
    },
    coat: {
      // Short dense body; nearly bare tail; sparse ears.
      // coat.tail floored at recipe min 0.05 (scaly read is still near-bare).
      length: 0.32, body: 0.36, head: 0.26, muzzle: 0.1, ears: 0.08, legs: 0.12, paws: 0.05, tail: 0.05,
      grooming: 'short', pattern: 'murine-agouti',
      // Cool grey-brown (rodent-ref is not warm russet). Cream under + dark
      // guard; cool mid root/tip so shell multiply reads salt-and-pepper grey.
      palette: { undercoat: 0xe8e4dc, guard: 0x2a2620, root: 0x7a7670, tip: 0xb0aaa2 },
      earInnerTint: [0.72, 0.48, 0.42],
      gravityDroop: 0.1, density: 620,
    },
    furnishings: { ruff: 0.04 },
    motion: { stride: 0.5, speed: 1.04, sitDepth: 0.5, earDynamics: 0.26, tailMotion: 0.78 },
  }),
  // House mouse (Mus musculus) — smaller, warmer sandy-brown, larger ears,
  // white belly, pink extremities, long thin tail. Shares `murine-agouti`.
  'house-mouse': rodentProfile({
    skeleton: {
      scale: 0.3, bodyLength: 0.84, legLength: 0.52, frontLegScale: 0.86,
      chestWidth: 0.66, hipWidth: 0.68,
      neckLength: 0.5, headSize: 1.02, muzzleLength: 0.78, tailLength: 1.28,
    },
    geometry: {
      torsoWidth: 0.7, torsoDepth: 0.86, backArch: 0.025, frontTaper: 0.86,
      neckWidth: 0.58, skullWidth: 0.96, skullHeight: 1.0,
      skullLength: 0.9, cheekFullness: 0.58, muzzleWidth: 0.52,
      legThickness: 0.42, hindLegThickness: 0.55, pawSize: 0.42,
    },
    // Large rounded-erect pinnae relative to the toy skull (ref signature).
    ears: { type: 'erect', length: 0.92, width: 0.98, dynamics: 0.32 },
    // thickness floored at recipe min 0.25; still reads thin vs bushy plumes.
    tail: { type: 'straight', thickness: 0.26, taper: 0.94, curl: 0.02, motion: 0.85 },
    face: {
      eyeScale: 1.32, eyeSpacing: 0.96, eyeHeight: 1.04, eyeForward: 1.1, noseScale: 0.58, brow: 0.02,
      irisColor: 0x0e0c0a, lidColor: 0xb89888, lidDarkColor: 0x7a6050,
      lidOpacity: 0.26, lidScale: 0.5,
      hideTeeth: true,
      noseColor: 0xe0a898, noseBlendColor: 0xf0c8bc,
    },
    coat: {
      length: 0.28, body: 0.3, head: 0.22, muzzle: 0.08, ears: 0.06, legs: 0.12, paws: 0.05, tail: 0.05,
      grooming: 'short', pattern: 'murine-agouti',
      // Warm sandy brown (refs) + chalk belly undercoat.
      palette: { undercoat: 0xf0e8dc, guard: 0x3a2e24, root: 0x8a6e54, tip: 0xc8b098 },
      earInnerTint: [0.78, 0.52, 0.46],
      gravityDroop: 0.08, density: 680,
    },
    furnishings: { ruff: 0.02 },
    motion: { stride: 0.46, speed: 1.14, sitDepth: 0.44, earDynamics: 0.34, tailMotion: 0.88 },
  }),
  // Eastern grey squirrel — cool silver agouti, white bib, pale periocular
  // fur, and a tall rising plume. `coat.pattern: 'squirrel-grey'` does the
  // countershading / eye-ring / silver-tip work. Palette undercoat=chalk vs
  // guard=charcoal; root/tip are cool mid greys because fur shells *multiply*
  // them onto the mix (same raccoon multiply rationale — not near-white tints).
  //
  // Shared dog-rig hard stops (documented): plantigrade sciurid feet and true
  // upright sit need a dedicated kit; we push haunches/foreleg scale/plume
  // within the existing quadruped bone contract.
  'grey-squirrel': rodentProfile({
    skeleton: {
      // Plan band 0.28–0.42; short forelegs via frontLegScale.
      scale: 0.4, bodyLength: 0.82, legLength: 0.56, frontLegScale: 0.84,
      chestWidth: 0.78, hipWidth: 0.9,
      neckLength: 0.5, headSize: 0.96, muzzleLength: 0.58, tailLength: 1.38,
    },
    geometry: {
      torsoWidth: 0.84, torsoDepth: 0.98, backArch: 0.03, frontTaper: 0.84,
      neckWidth: 0.7, skullWidth: 0.96, skullHeight: 1.0,
      skullLength: 0.82, cheekFullness: 0.8, muzzleWidth: 0.62,
      legThickness: 0.5, hindLegThickness: 0.72, pawSize: 0.52,
    },
    // Modest rounded-erect pinnae (refs are short triangles, not dog ears).
    ears: { type: 'erect', length: 0.52, width: 0.68, dynamics: 0.24 },
    // Free column behind rump: thin solid core + high coat.tail for fluff.
    // thickness kept modest so loft doesn't fuse into a backpack potato.
    tail: { type: 'sciurid', thickness: 1.12, taper: 0.55, curl: 0.32, motion: 0.94 },
    face: {
      // Large dark eye; lids dialed down so periocular pale is coat-driven.
      eyeScale: 1.36, eyeSpacing: 0.98, eyeHeight: 1.05, eyeForward: 1.08, noseScale: 0.78, brow: 0.02,
      irisColor: 0x100e0c, lidColor: 0x8a8680, lidDarkColor: 0x5a5650,
      lidOpacity: 0.22, lidScale: 0.48,
      // Hide exterior tooth cones — closed snout still showed crowns as
      // white "teeth" on front-sit/head-close boards.
      hideTeeth: true,
      noseColor: 0xb09888, noseBlendColor: 0xd8ccc0,
    },
    coat: {
      length: 0.7, body: 0.78, head: 0.46, muzzle: 0.12, ears: 0.28, legs: 0.16, paws: 0.05, tail: 1.72,
      grooming: 'grizzled', pattern: 'squirrel-grey',
      // Cool silver-grey (rodent-ref is not warm brown).
      palette: { undercoat: 0xeef0ec, guard: 0x1c2022, root: 0x848886, tip: 0xb6bab6 },
      earInnerTint: [0.45, 0.34, 0.3],
      gravityDroop: 0.12, density: 420,
    },
    furnishings: { ruff: 0.12 },
    motion: { stride: 0.5, speed: 1.1, sitDepth: 0.56, earDynamics: 0.26, tailMotion: 1.0 },
  }),
  // Eastern chipmunk — warm russet + 5-stripe dorsal, chalk bib, white facial
  // stripe / periocular pale, pink-tan nose, mid-length grizzled plume.
  // Pattern `chipmunk-stripe` owns the longitudinal stripes + face markings.
  //
  // Shared-rig hard stops: plantigrade feet and true upright sit need a kit;
  // we push compact toy scale, short forelegs, and face markings within the
  // existing quadruped bone contract (same class as grey-squirrel).
  'eastern-chipmunk': rodentProfile({
    skeleton: {
      // Smaller than grey squirrel; short forelegs via frontLegScale.
      scale: 0.34, bodyLength: 0.8, legLength: 0.54, frontLegScale: 0.86,
      chestWidth: 0.72, hipWidth: 0.82,
      neckLength: 0.52, headSize: 0.98, muzzleLength: 0.62, tailLength: 1.12,
    },
    geometry: {
      torsoWidth: 0.78, torsoDepth: 0.92, backArch: 0.025, frontTaper: 0.86,
      neckWidth: 0.68, skullWidth: 0.98, skullHeight: 1.02,
      skullLength: 0.84, cheekFullness: 0.82, muzzleWidth: 0.6,
      legThickness: 0.46, hindLegThickness: 0.64, pawSize: 0.46,
    },
    // Small rounded-erect pinnae (refs are short triangles, not tall dog ears).
    ears: { type: 'erect', length: 0.48, width: 0.62, dynamics: 0.26 },
    // Mid-length bushy plume held caudal/low (not sciurid tower — refs are
    // horizontal-ish with a frosted tip).
    tail: { type: 'plume', thickness: 0.82, taper: 0.58, curl: 0.12, motion: 0.92 },
    face: {
      // Large dark eyes; lids dialed down so white facial stripe is coat-driven.
      eyeScale: 1.34, eyeSpacing: 0.98, eyeHeight: 1.04, eyeForward: 1.08, noseScale: 0.68, brow: 0.02,
      irisColor: 0x100e0c, lidColor: 0x8a7060, lidDarkColor: 0x5a4838,
      lidOpacity: 0.24, lidScale: 0.5,
      hideTeeth: true,
      // Soft pink-tan nose (refs), not dog black.
      noseColor: 0xc89888, noseBlendColor: 0xe0b8a8,
    },
    coat: {
      // Medium body shells so stripe contrast reads through fur; fuller tail.
      length: 0.48, body: 0.55, head: 0.32, muzzle: 0.1, ears: 0.16, legs: 0.14, paws: 0.05, tail: 1.15,
      grooming: 'short', pattern: 'chipmunk-stripe',
      // Chalk-cream undercoat + near-black guard. Warm mid root/tip multiply
      // keeps russet flanks (near-white root washes everything beige; pure mid-
      // brown root muddies black stripes — this band is the compromise that
      // still shows 5-stripe contrast under shell lighting).
      palette: { undercoat: 0xf0e6d8, guard: 0x120c08, root: 0x9a6a3c, tip: 0xe0b888 },
      earInnerTint: [0.55, 0.38, 0.3],
      gravityDroop: 0.1, density: 480,
    },
    furnishings: { ruff: 0.06 },
    motion: { stride: 0.48, speed: 1.12, sitDepth: 0.5, earDynamics: 0.28, tailMotion: 0.95 },
  }),
  // Syrian hamster (Mesocricetus auratus) — brachycephalic puff head with
  // moderate cheek fill (refs are round, not super-wide "mumps"). Golden body,
  // white chin strip, pink nose/paws, stub tail, rounded pinnae.
  //
  // Width pass notes: skullWidth/cheekFullness were over-pushed (W/D ~2.4);
  // target a compact round face closer to the head-close board (~1.2–1.4 W/D).
  'syrian-hamster': rodentProfile({
    skeleton: {
      // Stocky cricetid; short neck so the head sits into the body mass.
      scale: 0.34, bodyLength: 0.78, legLength: 0.48, frontLegScale: 0.9,
      chestWidth: 0.98, hipWidth: 1.02,
      neckLength: 0.42, headSize: 1.12, muzzleLength: 0.38, tailLength: 0.18,
    },
    geometry: {
      // Round body + compact short skull. Cheeks soft, not lateral balloons.
      torsoWidth: 1.08, torsoDepth: 1.18, backArch: 0.04, frontTaper: 0.92,
      neckWidth: 0.9, skullWidth: 1.16, skullHeight: 1.1,
      // Slightly more Z depth so the face reads round rather than flat-wide.
      skullLength: 0.86, cheekFullness: 1.05, muzzleWidth: 1.0,
      legThickness: 0.5, hindLegThickness: 0.68, pawSize: 0.48,
    },
    // Low rounded cup pinnae (raccoon ear type), modest width.
    ears: { type: 'rounded', length: 0.42, width: 0.64, dynamics: 0.16 },
    // Stub tail only.
    tail: { type: 'straight', thickness: 0.4, taper: 0.65, curl: 0.04, motion: 0.22 },
    face: {
      // Large dark eyes; neutral spacing so the face isn't stretched wide.
      eyeScale: 1.28, eyeSpacing: 1.0, eyeHeight: 1.04, eyeForward: 1.06, noseScale: 0.58, brow: 0.02,
      irisColor: 0x0c0a08, lidColor: 0xd4a888, lidDarkColor: 0xa07858,
      lidOpacity: 0.18, lidScale: 0.42,
      hideTeeth: true,
      noseColor: 0xe8b0a8, noseBlendColor: 0xf4d0c8,
    },
    coat: {
      // Dense plush body + full cheek/head fur; short muzzle plate; stub tail.
      length: 0.58, body: 0.65, head: 0.62, muzzle: 0.14, ears: 0.1, legs: 0.14, paws: 0.05, tail: 0.12,
      grooming: 'short', pattern: 'hamster-golden',
      // Golden orange (refs). Cream undercoat for white muzzle/belly; warm
      // mid root/tip so shell multiply keeps apricot not washed beige.
      palette: { undercoat: 0xf8f0e4, guard: 0xc87828, root: 0xe0a050, tip: 0xf8d090 },
      earInnerTint: [0.72, 0.48, 0.4],
      gravityDroop: 0.14, density: 520,
    },
    furnishings: { ruff: 0.08 },
    motion: { stride: 0.4, speed: 0.82, sitDepth: 0.58, earDynamics: 0.18, tailMotion: 0.22 },
  }),
  // Ursidae P0 — plantigrade bears on the shared dog rig. Short stub tails,
  // massive bodies, rounded pinnae. Giant panda uses `panda-bicolor` pattern.
  'brown-bear': ursidProfile({
    skeleton: {
      scale: 1.18, bodyLength: 0.94, legLength: 0.76, chestWidth: 1.22, hipWidth: 1.16,
      neckLength: 0.58, headSize: 1.16, muzzleLength: 0.95, tailLength: 0.2,
    },
    geometry: {
      torsoWidth: 1.24, torsoDepth: 1.2, neckWidth: 1.16, skullWidth: 1.18, skullHeight: 1.1,
      skullLength: 1.04, cheekFullness: 0.9, muzzleWidth: 0.98,
      legThickness: 1.22, hindLegThickness: 1.32, pawSize: 1.24,
    },
    ears: { type: 'rounded', length: 0.46, width: 0.68, dynamics: 0.16 },
    face: {
      eyeScale: 0.86, eyeSpacing: 0.94, noseScale: 1.08, brow: 0.14,
      irisColor: 0x14100c, lidColor: 0x4a3828, lidDarkColor: 0x2a1c14,
      hideTeeth: true, noseColor: 0x1a100c, noseBlendColor: 0x3a2418,
    },
    coat: {
      length: 0.75, body: 0.82, head: 0.58, muzzle: 0.24, ears: 0.38, legs: 0.58, paws: 0.24, tail: 0.32,
      grooming: 'dense-double', pattern: 'solid',
      // Warm chocolate-brown (not black).
      palette: { undercoat: 0x7a5a40, guard: 0x3a2414, root: 0x5a3a24, tip: 0x9a7850 },
      earInnerTint: [0.22, 0.14, 0.1],
      gravityDroop: 0.22, density: 460,
    },
    furnishings: { ruff: 0.18 },
    motion: { stride: 0.7, speed: 0.58, sitDepth: 0.72, earDynamics: 0.18, tailMotion: 0.2 },
  }),
  'polar-bear': ursidProfile({
    skeleton: {
      // Longer limbs / neck than brown bear; still short stub tail.
      scale: 1.22, bodyLength: 0.98, legLength: 0.92, chestWidth: 1.14, hipWidth: 1.08,
      neckLength: 0.78, headSize: 1.1, muzzleLength: 1.05, tailLength: 0.18,
    },
    geometry: {
      torsoWidth: 1.16, torsoDepth: 1.14, neckWidth: 1.05, skullWidth: 1.08, skullHeight: 1.04,
      skullLength: 1.08, cheekFullness: 0.72, muzzleWidth: 0.88,
      legThickness: 1.12, hindLegThickness: 1.2, pawSize: 1.28,
    },
    ears: { type: 'rounded', length: 0.4, width: 0.62, dynamics: 0.14 },
    face: {
      eyeScale: 0.84, eyeSpacing: 0.94, noseScale: 1.02, brow: 0.08,
      irisColor: 0x1a1814, lidColor: 0xd8d0c4, lidDarkColor: 0xa0988c,
      hideTeeth: true, noseColor: 0x1a1210, noseBlendColor: 0x3a322c,
    },
    coat: {
      length: 0.85, body: 0.92, head: 0.7, muzzle: 0.28, ears: 0.42, legs: 0.7, paws: 0.28, tail: 0.38,
      grooming: 'dense-double', pattern: 'solid-white',
      palette: { undercoat: 0xf4f0e8, guard: 0xe8e4dc, root: 0xf0ece4, tip: 0xfaf8f4 },
      earInnerTint: [0.55, 0.42, 0.36],
      gravityDroop: 0.18, density: 420,
    },
    furnishings: { ruff: 0.12 },
    motion: { stride: 0.82, speed: 0.64, sitDepth: 0.68, earDynamics: 0.16, tailMotion: 0.18 },
  }),
  'giant-panda': ursidProfile({
    skeleton: {
      // Slightly smaller / cobbier than brown bear; shorter muzzle.
      scale: 1.02, bodyLength: 0.88, legLength: 0.72, chestWidth: 1.2, hipWidth: 1.18,
      neckLength: 0.52, headSize: 1.18, muzzleLength: 0.62, tailLength: 0.18,
    },
    geometry: {
      torsoWidth: 1.22, torsoDepth: 1.22, neckWidth: 1.14, skullWidth: 1.22, skullHeight: 1.14,
      skullLength: 0.92, cheekFullness: 0.95, muzzleWidth: 1.05,
      legThickness: 1.2, hindLegThickness: 1.3, pawSize: 1.18,
    },
    ears: { type: 'rounded', length: 0.55, width: 0.78, dynamics: 0.16 },
    face: {
      eyeScale: 0.92, eyeSpacing: 0.98, eyeHeight: 1.04, eyeForward: 1.04, noseScale: 0.95, brow: 0.1,
      irisColor: 0x12100c, lidColor: 0x1a1816, lidDarkColor: 0x0c0a08,
      hideTeeth: true, noseColor: 0x141210, noseBlendColor: 0x2a2624,
    },
    coat: {
      length: 0.68, body: 0.75, head: 0.55, muzzle: 0.2, ears: 0.4, legs: 0.55, paws: 0.2, tail: 0.3,
      grooming: 'dense-double', pattern: 'panda-bicolor',
      // White undercoat + near-black guard (pattern paints the black patches).
      palette: { undercoat: 0xf2f0ec, guard: 0x12110f, root: 0xd8d6d2, tip: 0xf8f6f2 },
      earInnerTint: [0.08, 0.06, 0.05],
      gravityDroop: 0.2, density: 500,
    },
    furnishings: { ruff: 0.1 },
    motion: { stride: 0.62, speed: 0.52, sitDepth: 0.75, earDynamics: 0.18, tailMotion: 0.18 },
  }),
  // Bovidae / caprine — domestic goat on shared quadruped rig with hoof + horn kits.
  'domestic-goat': mergeProfile({
    skeleton: {
      scale: 0.72, bodyLength: 0.96, legLength: 0.94, chestWidth: 0.82, hipWidth: 0.8,
      neckLength: 0.82, headSize: 0.94, muzzleLength: 1.18, tailLength: 0.32,
    },
    geometry: {
      torsoWidth: 0.86, torsoDepth: 0.98, neckWidth: 0.78, skullWidth: 0.9, skullHeight: 1.02,
      skullLength: 1.06, cheekFullness: 0.55, muzzleWidth: 0.72, legThickness: 0.72, pawSize: 0.88,
    },
    ears: { type: 'erect', length: 0.72, width: 0.52, dynamics: 0.22 },
    tail: { type: 'upright', thickness: 0.42, curl: 0.08, motion: 0.55 },
    face: {
      eyeScale: 1.14, eyeSpacing: 1.12, eyeHeight: 1.02, eyeForward: 1.04, noseScale: 0.88, brow: 0.08,
      eyeStyle: 'caprine', pupilAspect: 3.2, scleraAmount: 0.32,
      irisColor: 0xc9a24a, lidColor: 0x3a3228, lidDarkColor: 0x221c16,
      noseColor: 0x2a221c, noseBlendColor: 0x8a7a62,
    },
    coat: {
      length: 0.52, body: 0.58, head: 0.42, muzzle: 0.22, ears: 0.28, legs: 0.38, paws: 0.12, tail: 0.35,
      grooming: 'coarse', fiber: 'coarse-guard', pattern: 'goat-pied',
      palette: { undercoat: 0xf0e6d4, guard: 0x3a342c, root: 0x8a7a62, tip: 0xf5efe4 },
      gravityDroop: 0.48, density: 480,
    },
    furnishings: { beard: 0.92, mustache: 0.15, neckSkirt: 0.35, ruff: 0.12 },
    extremities: { foot: 'cloven-hoof', hoofSize: 0.95, dewclaw: 0.55, bareBelow: 0.82 },
    headgear: {
      type: 'horn-caprine', length: 0.88, curl: 0.52, spread: 1.08, thickness: 0.9,
      color: 0xe8dcc8, tipColor: 0xb8a888,
    },
    motion: { stride: 0.78, speed: 0.92, sitDepth: 0.7, earDynamics: 0.25, tailMotion: 0.5 },
    variation: { scale: 0.04, build: 0.04, coatShade: 0.1, coatLength: 0.06, energy: 0.22, trainability: 0.18 },
  }),
  // ─────────────────────────────────────────────────────────────────────────
  // Iconic species expansion (mustelidae / mephitidae / ailuridae / viverridae
  // / herpestidae / hyaenidae / castoridae / caviidae / chinchillidae /
  // erethizontidae / hystricidae / cervidae / camelidae / suidae). Built from
  // the right prior (mustelidProfile / rodentProfile / mergeProfile) with the
  // species' signature body part(s): webbed-paw, paddle tail, quills, hump,
  // dorsalCrest, antler-rack, tusk-boar, cloven-hoof.
  // ─────────────────────────────────────────────────────────────────────────

  // Mustelidae — long low tube carnivorans on the mustelidBase prior.
  'river-otter': mustelidProfile({
    skeleton: {
      // Long sinuous body, short powerful legs, thick muscular tail base.
      scale: 0.66, bodyLength: 1.3, legLength: 0.62, chestWidth: 0.74, hipWidth: 0.74,
      neckLength: 0.7, headSize: 0.92, muzzleLength: 0.92, tailLength: 0.92,
    },
    geometry: {
      torsoWidth: 0.78, torsoDepth: 0.86, neckWidth: 0.66, skullWidth: 0.82, skullHeight: 0.86,
      skullLength: 0.98, cheekFullness: 0.56, muzzleWidth: 0.5,
      legThickness: 0.6, hindLegThickness: 0.74, pawSize: 0.72,
    },
    ears: { type: 'rounded', length: 0.34, width: 0.54, dynamics: 0.2 },
    // Thick tapered muscular tail (fatter at the base than the mustelid default).
    tail: { type: 'straight', thickness: 0.82, taper: 0.45, curl: 0.04, motion: 0.78 },
    face: {
      eyeScale: 1.0, eyeSpacing: 0.96, eyeHeight: 1.02, eyeForward: 1.06, noseScale: 0.66, brow: 0.06,
      irisColor: 0x2a1a10, lidColor: 0x2a1c12, lidDarkColor: 0x16100a,
      hideTeeth: true, noseColor: 0x1a120c, noseBlendColor: 0x3a2a1c,
    },
    coat: {
      length: 0.36, body: 0.4, head: 0.3, muzzle: 0.18, ears: 0.16, legs: 0.26, paws: 0.12, tail: 0.34,
      grooming: 'dense-double', pattern: 'solid',
      // Rich chocolate-brown overcoat over a slightly warmer under.
      palette: { undercoat: 0x6a5038, guard: 0x281c10, root: 0x503a26, tip: 0x7a5c3c },
      gravityDroop: 0.16, density: 760,
    },
    furnishings: { ruff: 0.04 },
    extremities: { foot: 'webbed-paw', hoofSize: 1, dewclaw: 0, bareBelow: 0.78 },
    motion: { stride: 0.62, speed: 0.96, sitDepth: 0.55, earDynamics: 0.28, tailMotion: 0.82 },
    variation: { scale: 0.04, build: 0.04, coatShade: 0.1, coatLength: 0.04, energy: 0.26, trainability: 0.18 },
  }),
  'european-badger': mustelidProfile({
    skeleton: {
      // Stocky flattened body, short legs, wedged head, short-ish tail.
      scale: 0.74, bodyLength: 1.04, legLength: 0.56, chestWidth: 0.9, hipWidth: 0.86,
      neckLength: 0.6, headSize: 0.96, muzzleLength: 1.0, tailLength: 0.5,
    },
    geometry: {
      torsoWidth: 0.96, torsoDepth: 0.92, neckWidth: 0.8, skullWidth: 0.88, skullHeight: 0.84,
      skullLength: 1.02, cheekFullness: 0.66, muzzleWidth: 0.54,
      legThickness: 0.72, hindLegThickness: 0.86, pawSize: 0.84,
    },
    ears: { type: 'rounded', length: 0.32, width: 0.5, dynamics: 0.18 },
    tail: { type: 'straight', thickness: 0.6, taper: 0.6, curl: 0.04, motion: 0.5 },
    face: {
      eyeScale: 0.94, eyeSpacing: 0.9, eyeHeight: 1.0, eyeForward: 1.04, noseScale: 0.78, brow: 0.1,
      irisColor: 0x1a120a, lidColor: 0x1a120a, lidDarkColor: 0x0c0806,
      hideTeeth: true, noseColor: 0x14100a, noseBlendColor: 0x2a221a,
    },
    coat: {
      length: 0.4, body: 0.46, head: 0.36, muzzle: 0.2, ears: 0.22, legs: 0.3, paws: 0.16, tail: 0.4,
      grooming: 'coarse', pattern: 'badger-faced',
      // White face/crown + near-black eye-stripes & belly; grizzled grey back from the mid mix.
      palette: { undercoat: 0xf0e8da, guard: 0x161210, root: 0xb8b0a4, tip: 0xdcd4c6 },
      gravityDroop: 0.18, density: 620,
    },
    // Short grizzled dorsal crest gives the badger's raised back-scruff read.
    furnishings: { ruff: 0.08, dorsalCrest: 0.45 },
    extremities: { foot: 'paw', hoofSize: 1, dewclaw: 0.3, bareBelow: 0.7 },
    motion: { stride: 0.58, speed: 0.7, sitDepth: 0.6, earDynamics: 0.24, tailMotion: 0.5 },
    variation: { scale: 0.04, build: 0.04, coatShade: 0.1, coatLength: 0.04, energy: 0.22, trainability: 0.16 },
  }),
  'least-weasel': mustelidProfile({
    skeleton: {
      // Tiny hyper-elongated tube on stilt legs; very short tail.
      scale: 0.32, bodyLength: 1.42, legLength: 0.5, chestWidth: 0.56, hipWidth: 0.56,
      neckLength: 0.56, headSize: 0.84, muzzleLength: 0.86, tailLength: 0.36,
    },
    geometry: {
      torsoWidth: 0.56, torsoDepth: 0.66, neckWidth: 0.5, skullWidth: 0.72, skullHeight: 0.78,
      skullLength: 0.9, cheekFullness: 0.42, muzzleWidth: 0.4,
      legThickness: 0.4, hindLegThickness: 0.5, pawSize: 0.46,
    },
    ears: { type: 'rounded', length: 0.3, width: 0.46, dynamics: 0.22 },
    tail: { type: 'straight', thickness: 0.42, taper: 0.55, curl: 0.06, motion: 0.7 },
    face: {
      eyeScale: 1.08, eyeSpacing: 0.92, eyeHeight: 1.04, eyeForward: 1.06, noseScale: 0.62, brow: 0.06,
      irisColor: 0x2a1a0e, lidColor: 0x2a1a0e, lidDarkColor: 0x140c06,
      hideTeeth: false, noseColor: 0x140c06, noseBlendColor: 0x3a2418,
    },
    coat: {
      length: 0.22, body: 0.26, head: 0.2, muzzle: 0.12, ears: 0.14, legs: 0.16, paws: 0.08, tail: 0.22,
      grooming: 'short', pattern: 'murine-agouti',
      // Warm brown back, cream belly (summer coat); agouti countershading carries the read.
      palette: { undercoat: 0xe8dcc4, guard: 0x6a4220, root: 0xa07850, tip: 0xc8a878 },
      gravityDroop: 0.12, density: 680,
    },
    furnishings: { ruff: 0 },
    extremities: { foot: 'paw', hoofSize: 1, dewclaw: 0, bareBelow: 0.82 },
    motion: { stride: 0.46, speed: 1.12, sitDepth: 0.5, earDynamics: 0.28, tailMotion: 0.78 },
    variation: { scale: 0.04, build: 0.035, coatShade: 0.12, coatLength: 0.04, energy: 0.3, trainability: 0.16 },
  }),

  // Mephitidae — striped skunk (skunk-striped pattern, big bushy tail).
  'striped-skunk': mustelidProfile({
    skeleton: {
      scale: 0.62, bodyLength: 1.06, legLength: 0.6, chestWidth: 0.82, hipWidth: 0.78,
      neckLength: 0.62, headSize: 0.92, muzzleLength: 0.96, tailLength: 0.86,
    },
    geometry: {
      torsoWidth: 0.88, torsoDepth: 0.92, neckWidth: 0.7, skullWidth: 0.84, skullHeight: 0.88,
      skullLength: 0.98, cheekFullness: 0.6, muzzleWidth: 0.5,
      legThickness: 0.6, hindLegThickness: 0.74, pawSize: 0.74,
    },
    ears: { type: 'rounded', length: 0.36, width: 0.52, dynamics: 0.3 },
    // Big bushy plume tail carried high — the skunk's signature.
    tail: { type: 'plume', thickness: 1.4, taper: 0.7, curl: 0.18, motion: 0.55 },
    face: {
      eyeScale: 0.92, eyeSpacing: 0.9, eyeHeight: 1.02, eyeForward: 1.04, noseScale: 0.74, brow: 0.08,
      irisColor: 0x1a120a, lidColor: 0x161210, lidDarkColor: 0x0a0806,
      hideTeeth: true, noseColor: 0x14100a, noseBlendColor: 0x2a221a,
    },
    coat: {
      length: 0.62, body: 0.72, head: 0.5, muzzle: 0.28, ears: 0.34, legs: 0.44, paws: 0.22, tail: 1.3,
      grooming: 'double', pattern: 'skunk-striped',
      // Black ground, white dorsal stripes/blaze/tail-flank.
      palette: { undercoat: 0xf4f0e8, guard: 0x100c0a, root: 0xb8b0a4, tip: 0xe0d8cc },
      gravityDroop: 0.22, density: 560,
    },
    furnishings: { ruff: 0.18 },
    extremities: { foot: 'paw', hoofSize: 1, dewclaw: 0.3, bareBelow: 0.7 },
    motion: { stride: 0.6, speed: 0.74, sitDepth: 0.6, earDynamics: 0.3, tailMotion: 0.55 },
    variation: { scale: 0.04, build: 0.04, coatShade: 0.08, coatLength: 0.06, energy: 0.22, trainability: 0.18 },
  }),

  // Ailuridae — red panda (arboreal stocky build, red/black, ringed bushy tail).
  'red-panda': mergeProfile({
    skeleton: {
      scale: 0.6, bodyLength: 0.96, legLength: 0.72, chestWidth: 0.86, hipWidth: 0.84,
      neckLength: 0.62, headSize: 0.98, muzzleLength: 0.72, tailLength: 1.12,
    },
    geometry: {
      torsoWidth: 0.9, torsoDepth: 0.96, backArch: 0.03, frontTaper: 0.88,
      neckWidth: 0.74, skullWidth: 0.92, skullHeight: 0.98,
      skullLength: 0.94, cheekFullness: 0.82, muzzleWidth: 0.62,
      legThickness: 0.64, hindLegThickness: 0.82, pawSize: 0.78,
    },
    ears: { type: 'rounded', length: 0.56, width: 0.74, dynamics: 0.36 },
    // Thick bushy ringed tail.
    tail: { type: 'plume', thickness: 1.3, taper: 0.6, curl: 0.22, motion: 0.8 },
    face: {
      eyeScale: 1.02, eyeSpacing: 0.92, eyeHeight: 1.06, eyeForward: 1.08, noseScale: 0.7, brow: 0.06,
      irisColor: 0x2a1a10, lidColor: 0xc89850, lidDarkColor: 0x8a5a30,
      hideTeeth: true, noseColor: 0x2a1a10, noseBlendColor: 0x5a3a24,
    },
    coat: {
      length: 0.6, body: 0.7, head: 0.56, muzzle: 0.3, ears: 0.5, legs: 0.5, paws: 0.24, tail: 1.2,
      grooming: 'medium-double', pattern: 'red-panda',
      // Red upper/face/tail, near-black belly/legs; muzzle leans pale for the face-mask read.
      palette: { undercoat: 0xb23a16, guard: 0x1a0e08, root: 0x8a2a10, tip: 0xc84a22 },
      earInnerTint: [0.6, 0.5, 0.42],
      gravityDroop: 0.2, density: 520,
    },
    furnishings: { ruff: 0.24 },
    extremities: { foot: 'paw', hoofSize: 1, dewclaw: 0.4, bareBelow: 0.62 },
    motion: { stride: 0.62, speed: 0.78, sitDepth: 0.66, earDynamics: 0.34, tailMotion: 0.82 },
    variation: { scale: 0.04, build: 0.04, coatShade: 0.1, coatLength: 0.06, energy: 0.24, trainability: 0.18 },
  }),

  // Viverridae — common genet (slender, spotted, very long ringed tail).
  'common-genet': mustelidProfile({
    skeleton: {
      scale: 0.52, bodyLength: 1.1, legLength: 0.82, chestWidth: 0.66, hipWidth: 0.68,
      neckLength: 0.7, headSize: 0.9, muzzleLength: 1.12, tailLength: 1.4,
    },
    geometry: {
      torsoWidth: 0.7, torsoDepth: 0.82, neckWidth: 0.6, skullWidth: 0.78, skullHeight: 0.82,
      skullLength: 1.02, cheekFullness: 0.5, muzzleWidth: 0.42,
      legThickness: 0.5, hindLegThickness: 0.66, pawSize: 0.6,
    },
    ears: { type: 'rounded', length: 0.5, width: 0.6, dynamics: 0.34 },
    // Very long ringed tail — saber so it reads as a slim taper.
    tail: { type: 'saber', thickness: 0.7, taper: 0.78, curl: 0.12, motion: 0.86 },
    face: {
      eyeScale: 1.1, eyeSpacing: 0.92, eyeHeight: 1.06, eyeForward: 1.08, noseScale: 0.66, brow: 0.06,
      irisColor: 0x3a2a18, lidColor: 0x3a2a1c, lidDarkColor: 0x1a120a,
      hideTeeth: true, noseColor: 0x1a120a, noseBlendColor: 0x3a2a1c,
    },
    coat: {
      length: 0.34, body: 0.4, head: 0.3, muzzle: 0.18, ears: 0.24, legs: 0.26, paws: 0.14, tail: 0.7,
      grooming: 'short', pattern: 'genet-spotted',
      // Grey-ticked ground with dark spots; dark facial mask + ringed black-tipped tail.
      palette: { undercoat: 0xd8ccb8, guard: 0x241c14, root: 0x8a7e6a, tip: 0xc0b4a0 },
      gravityDroop: 0.14, density: 640,
    },
    furnishings: { ruff: 0.06 },
    extremities: { foot: 'paw', hoofSize: 1, dewclaw: 0.3, bareBelow: 0.74 },
    motion: { stride: 0.66, speed: 0.96, sitDepth: 0.58, earDynamics: 0.34, tailMotion: 0.88 },
    variation: { scale: 0.04, build: 0.04, coatShade: 0.1, coatLength: 0.05, energy: 0.26, trainability: 0.16 },
  }),

  // Herpestidae — meerkat (slender sentinel, tan, long body).
  meerkat: mustelidProfile({
    skeleton: {
      scale: 0.5, bodyLength: 1.14, legLength: 0.86, chestWidth: 0.64, hipWidth: 0.64,
      neckLength: 0.74, headSize: 0.9, muzzleLength: 1.06, tailLength: 0.92,
    },
    geometry: {
      torsoWidth: 0.66, torsoDepth: 0.78, neckWidth: 0.56, skullWidth: 0.76, skullHeight: 0.82,
      skullLength: 1.0, cheekFullness: 0.46, muzzleWidth: 0.44,
      legThickness: 0.46, hindLegThickness: 0.6, pawSize: 0.54,
    },
    ears: { type: 'erect', length: 0.5, width: 0.62, dynamics: 0.34 },
    tail: { type: 'straight', thickness: 0.6, taper: 0.7, curl: 0.1, motion: 0.78 },
    face: {
      eyeScale: 1.06, eyeSpacing: 0.94, eyeHeight: 1.06, eyeForward: 1.08, noseScale: 0.7, brow: 0.1,
      irisColor: 0x2a1a0e, lidColor: 0x2a1a0e, lidDarkColor: 0x140c06,
      hideTeeth: true, noseColor: 0x1a120a, noseBlendColor: 0x3a2818,
    },
    coat: {
      length: 0.24, body: 0.28, head: 0.22, muzzle: 0.14, ears: 0.16, legs: 0.18, paws: 0.1, tail: 0.3,
      grooming: 'short', pattern: 'solid',
      // Tan/sandy back, paler underside.
      palette: { undercoat: 0xc9a878, guard: 0x6a4e30, root: 0x9a7848, tip: 0xd8b888 },
      gravityDroop: 0.1, density: 700,
    },
    furnishings: { ruff: 0 },
    extremities: { foot: 'paw', hoofSize: 1, dewclaw: 0.3, bareBelow: 0.78 },
    motion: { stride: 0.58, speed: 0.98, sitDepth: 0.5, earDynamics: 0.34, tailMotion: 0.82 },
    variation: { scale: 0.04, build: 0.035, coatShade: 0.1, coatLength: 0.04, energy: 0.28, trainability: 0.2 },
  }),

  // Hyaenidae — spotted hyena (heavy sloped-back build, spotted, dorsal crest).
  'spotted-hyena': mustelidProfile({
    skeleton: {
      // Heavyset carnivoran, larger than the mustelid default; big neck/head.
      scale: 0.94, bodyLength: 1.12, legLength: 0.92, chestWidth: 0.96, hipWidth: 0.88,
      neckLength: 0.82, headSize: 1.04, muzzleLength: 1.06, tailLength: 0.6,
    },
    geometry: {
      // Pronounced front-high / rear-low slope: high frontTaper + backArch.
      torsoWidth: 0.96, torsoDepth: 1.0, backArch: 0.05, frontTaper: 1.16,
      neckWidth: 0.92, skullWidth: 0.98, skullHeight: 0.96,
      skullLength: 1.1, cheekFullness: 0.7, muzzleWidth: 0.74,
      legThickness: 0.86, hindLegThickness: 0.98, pawSize: 0.92,
    },
    ears: { type: 'rounded', length: 0.5, width: 0.62, dynamics: 0.28 },
    tail: { type: 'straight', thickness: 0.6, taper: 0.7, curl: 0.06, motion: 0.5 },
    face: {
      eyeScale: 0.92, eyeSpacing: 0.98, eyeHeight: 1.0, eyeForward: 1.02, noseScale: 0.92, brow: 0.22,
      irisColor: 0x2a1a0e, lidColor: 0x2a1c12, lidDarkColor: 0x140c06,
      hideTeeth: false, noseColor: 0x1a120a, noseBlendColor: 0x3a2818,
    },
    coat: {
      length: 0.26, body: 0.3, head: 0.24, muzzle: 0.14, ears: 0.2, legs: 0.22, paws: 0.12, tail: 0.32,
      grooming: 'short', pattern: 'hyena-spotted',
      // Tawny-sandy ground with dark brown blotches; darker lower legs & muzzle.
      palette: { undercoat: 0xb89868, guard: 0x2a1a10, root: 0x8a6a40, tip: 0xc8a878 },
      gravityDroop: 0.16, density: 640,
    },
    // Bristly stand-up mane along the neck/spine (the hyena's dorsal crest).
    furnishings: { ruff: 0.18, dorsalCrest: 0.75 },
    extremities: { foot: 'paw', hoofSize: 1, dewclaw: 0.3, bareBelow: 0.7 },
    motion: { stride: 0.84, speed: 1.02, sitDepth: 0.62, earDynamics: 0.28, tailMotion: 0.5 },
    variation: { scale: 0.04, build: 0.04, coatShade: 0.1, coatLength: 0.04, energy: 0.26, trainability: 0.16 },
  }),

  // Caviidae — capybara (barrel stocky), guinea pig (cobby tiny), mara (long-legged).
  //
  // headShape 'caviid': flat-top rectangular poly head (animalPolyHead.js).
  // Ref profile is a near-straight dorsal line nape→nose tip (not a curved
  // crown / pig pipe). Constant-ish height prism with blunt tip face.
  capybara: rodentProfile({
    skeleton: {
      scale: 0.74, bodyLength: 0.96, legLength: 0.5, chestWidth: 1.02, hipWidth: 1.0,
      neckLength: 0.52, headSize: 1.04, muzzleLength: 0.96, tailLength: 0.16,
    },
    geometry: {
      headShape: 'caviid',
      torsoWidth: 1.12, torsoDepth: 1.1, neckWidth: 1.0,
      // Solid flat-top rectangle — poly schedule owns height/width continuity.
      skullWidth: 1.02, skullHeight: 0.96, skullLength: 1.08,
      cheekFullness: 0.9, muzzleWidth: 1.0, muzzleHeight: 1.02,
      legThickness: 0.66, hindLegThickness: 0.78, pawSize: 0.86,
    },
    ears: { type: 'rounded', length: 0.26, width: 0.4, dynamics: 0.16 },
    tail: { type: 'straight', thickness: 0.28, taper: 0.7, curl: 0.04, motion: 0.2 },
    face: {
      // Eyes high/forward on the cheek so front + 3/4 stills show them.
      eyeScale: 0.8, eyeSpacing: 1.0, eyeHeight: 1.12, eyeForward: 1.15, noseScale: 1.2, brow: 0.02,
      irisColor: 0x0c0804, lidColor: 0x5a3a24, lidDarkColor: 0x2a1a10,
      lidOpacity: 0.1, lidScale: 0.36,
      hideTeeth: true,
      noseColor: 0x2a1e16, noseBlendColor: 0x6a4a34,
    },
    coat: {
      length: 0.28, body: 0.32, head: 0.28, muzzle: 0.12, ears: 0.1, legs: 0.18, paws: 0.1, tail: 0.1,
      grooming: 'coarse', pattern: 'solid',
      palette: { undercoat: 0x9a7a52, guard: 0x3a2818, root: 0x7a5a38, tip: 0xb09068 },
      gravityDroop: 0.1, density: 640,
    },
    furnishings: { ruff: 0 },
    extremities: { foot: 'rodent-paw', hoofSize: 1, dewclaw: 0, bareBelow: 0.8 },
    motion: { stride: 0.5, speed: 0.72, sitDepth: 0.5, earDynamics: 0.2, tailMotion: 0.2 },
    variation: { scale: 0.04, build: 0.04, coatShade: 0.1, coatLength: 0.04, energy: 0.2, trainability: 0.18 },
  }),
  'guinea-pig': rodentProfile({
    skeleton: {
      scale: 0.42, bodyLength: 0.82, legLength: 0.42, chestWidth: 0.92, hipWidth: 0.9,
      neckLength: 0.4, headSize: 1.0, muzzleLength: 0.62, tailLength: 0.15,
    },
    geometry: {
      torsoWidth: 1.0, torsoDepth: 1.02, neckWidth: 0.86, skullWidth: 1.02, skullHeight: 0.96,
      skullLength: 0.92, cheekFullness: 0.84, muzzleWidth: 0.72,
      legThickness: 0.54, hindLegThickness: 0.62, pawSize: 0.66,
    },
    ears: { type: 'rounded', length: 0.26, width: 0.44, dynamics: 0.16 },
    tail: { type: 'straight', thickness: 0.26, taper: 0.7, curl: 0.04, motion: 0.16 },
    face: {
      eyeScale: 1.04, eyeSpacing: 1.0, eyeHeight: 1.06, eyeForward: 1.04, noseScale: 0.82, brow: 0.06,
      irisColor: 0x2a1a10, lidColor: 0x2a1a10, lidDarkColor: 0x140c06,
      hideTeeth: false, noseColor: 0x2a1a10, noseBlendColor: 0x4a3a2a,
    },
    coat: {
      length: 0.36, body: 0.42, head: 0.34, muzzle: 0.2, ears: 0.18, legs: 0.22, paws: 0.12, tail: 0.12,
      grooming: 'short', pattern: 'solid',
      // Agouti tan ticked over cream.
      palette: { undercoat: 0xb89868, guard: 0x4a3220, root: 0x8a6a44, tip: 0xc8a878 },
      gravityDroop: 0.12, density: 700,
    },
    furnishings: { ruff: 0 },
    extremities: { foot: 'rodent-paw', hoofSize: 1, dewclaw: 0, bareBelow: 0.82 },
    motion: { stride: 0.46, speed: 0.82, sitDepth: 0.46, earDynamics: 0.22, tailMotion: 0.18 },
    variation: { scale: 0.04, build: 0.035, coatShade: 0.12, coatLength: 0.06, energy: 0.24, trainability: 0.18 },
  }),
  // Patagonian mara — long-legged cursorial cavy (hare-like), short tail, upright ears.
  'patagonian-mara': rodentProfile({
    skeleton: {
      scale: 0.62, bodyLength: 0.92, legLength: 0.98, frontLegScale: 0.92,
      chestWidth: 0.78, hipWidth: 0.8,
      neckLength: 0.62, headSize: 0.96, muzzleLength: 0.88, tailLength: 0.22,
    },
    geometry: {
      torsoWidth: 0.84, torsoDepth: 0.92, backArch: 0.02, frontTaper: 0.88,
      neckWidth: 0.7, skullWidth: 0.92, skullHeight: 0.98,
      skullLength: 1.0, cheekFullness: 0.58, muzzleWidth: 0.58,
      legThickness: 0.52, hindLegThickness: 0.72, pawSize: 0.58,
    },
    ears: { type: 'erect', length: 0.72, width: 0.58, dynamics: 0.32 },
    tail: { type: 'straight', thickness: 0.32, taper: 0.75, curl: 0.04, motion: 0.28 },
    face: {
      eyeScale: 1.08, eyeSpacing: 0.96, eyeHeight: 1.04, eyeForward: 1.06, noseScale: 0.74, brow: 0.05,
      irisColor: 0x2a1a10, lidColor: 0x3a2a1a, lidDarkColor: 0x1a120a,
      hideTeeth: true, noseColor: 0x3a2a1c, noseBlendColor: 0x6a4a30,
    },
    coat: {
      length: 0.32, body: 0.36, head: 0.28, muzzle: 0.12, ears: 0.14, legs: 0.18, paws: 0.06, tail: 0.14,
      grooming: 'short', pattern: 'solid',
      // Warm agouti tan over cream underparts.
      palette: { undercoat: 0xd8c8a8, guard: 0x6a4a28, root: 0x9a7a48, tip: 0xe0c898 },
      earInnerTint: [0.55, 0.38, 0.28],
      gravityDroop: 0.12, density: 640,
    },
    furnishings: { ruff: 0.02 },
    extremities: { foot: 'rodent-paw', hoofSize: 1, dewclaw: 0, bareBelow: 0.85 },
    motion: { stride: 0.92, speed: 1.05, sitDepth: 0.5, earDynamics: 0.3, tailMotion: 0.28 },
    variation: { scale: 0.04, build: 0.04, coatShade: 0.1, coatLength: 0.05, energy: 0.26, trainability: 0.16 },
  }),

  // Chinchillidae — chinchilla (ultra-dense silver coat, big rounded ears, bushy tail).
  chinchilla: rodentProfile({
    skeleton: {
      scale: 0.46, bodyLength: 0.96, legLength: 0.66, chestWidth: 0.84, hipWidth: 0.82,
      neckLength: 0.56, headSize: 1.0, muzzleLength: 0.72, tailLength: 0.86,
    },
    geometry: {
      torsoWidth: 0.92, torsoDepth: 0.96, neckWidth: 0.74, skullWidth: 0.98, skullHeight: 0.96,
      skullLength: 0.92, cheekFullness: 0.86, muzzleWidth: 0.6,
      legThickness: 0.66, hindLegThickness: 0.96, pawSize: 0.78,
    },
    ears: { type: 'rounded', length: 0.78, width: 0.86, dynamics: 0.3 },
    // Long bushy squirrel-like tail.
    tail: { type: 'sciurid', thickness: 1.1, taper: 0.6, curl: 0.12, motion: 0.7 },
    face: {
      eyeScale: 1.14, eyeSpacing: 0.98, eyeHeight: 1.08, eyeForward: 1.06, noseScale: 0.72, brow: 0.06,
      irisColor: 0x2a1a10, lidColor: 0x2a1a10, lidDarkColor: 0x140c06,
      hideTeeth: false, noseColor: 0x2a1a10, noseBlendColor: 0x4a3a2a,
    },
    coat: {
      length: 0.72, body: 0.82, head: 0.66, muzzle: 0.34, ears: 0.46, legs: 0.58, paws: 0.3, tail: 1.1,
      grooming: 'dense-double', pattern: 'chinchilla-silver',
      // Silver-grey with darker guard tips; chalk-white belly.
      palette: { undercoat: 0xf0ece8, guard: 0x4a4650, root: 0x8a8890, tip: 0xc0bcc4 },
      gravityDroop: 0.2, density: 860,
    },
    furnishings: { ruff: 0.18 },
    extremities: { foot: 'rodent-paw', hoofSize: 1, dewclaw: 0, bareBelow: 0.66 },
    motion: { stride: 0.6, speed: 1.02, sitDepth: 0.54, earDynamics: 0.3, tailMotion: 0.74 },
    variation: { scale: 0.04, build: 0.035, coatShade: 0.1, coatLength: 0.06, energy: 0.26, trainability: 0.16 },
  }),

  // Erethizontidae + Hystricidae — porcupines (dorsal quill field over brown underfur).
  'north-american-porcupine': rodentProfile({
    skeleton: {
      scale: 0.66, bodyLength: 0.96, legLength: 0.54, chestWidth: 0.92, hipWidth: 0.92,
      neckLength: 0.54, headSize: 0.96, muzzleLength: 0.78, tailLength: 0.5,
    },
    geometry: {
      torsoWidth: 0.98, torsoDepth: 0.98, backArch: 0.04, frontTaper: 0.9,
      neckWidth: 0.82, skullWidth: 0.92, skullHeight: 0.9,
      skullLength: 0.94, cheekFullness: 0.74, muzzleWidth: 0.66,
      legThickness: 0.66, hindLegThickness: 0.76, pawSize: 0.82,
    },
    ears: { type: 'rounded', length: 0.26, width: 0.42, dynamics: 0.16 },
    tail: { type: 'straight', thickness: 0.62, taper: 0.6, curl: 0.04, motion: 0.4 },
    face: {
      eyeScale: 0.94, eyeSpacing: 0.96, eyeHeight: 1.02, eyeForward: 1.02, noseScale: 0.78, brow: 0.08,
      irisColor: 0x2a1a10, lidColor: 0x2a1a10, lidDarkColor: 0x140c06,
      hideTeeth: false, noseColor: 0x1a120a, noseBlendColor: 0x3a2a1c,
    },
    coat: {
      length: 0.34, body: 0.4, head: 0.3, muzzle: 0.18, ears: 0.16, legs: 0.24, paws: 0.14, tail: 0.3,
      grooming: 'coarse', pattern: 'solid',
      palette: { undercoat: 0x6a5038, guard: 0x2a1c12, root: 0x503a28, tip: 0x7a5c40 },
      gravityDroop: 0.16, density: 620,
    },
    // Signature: dense dorsal quill field (banded pale shaft → dark tip in geometry).
    furnishings: { ruff: 0.06, quills: 1.1 },
    extremities: { foot: 'rodent-paw', hoofSize: 1, dewclaw: 0.3, bareBelow: 0.74 },
    motion: { stride: 0.52, speed: 0.62, sitDepth: 0.56, earDynamics: 0.22, tailMotion: 0.4 },
    variation: { scale: 0.04, build: 0.04, coatShade: 0.1, coatLength: 0.04, energy: 0.18, trainability: 0.14 },
  }),
  'crested-porcupine': rodentProfile({
    skeleton: {
      scale: 0.74, bodyLength: 1.0, legLength: 0.56, chestWidth: 0.92, hipWidth: 0.92,
      neckLength: 0.56, headSize: 0.96, muzzleLength: 0.82, tailLength: 0.4,
    },
    geometry: {
      torsoWidth: 0.98, torsoDepth: 1.0, backArch: 0.04, frontTaper: 0.9,
      neckWidth: 0.82, skullWidth: 0.92, skullHeight: 0.9,
      skullLength: 0.96, cheekFullness: 0.72, muzzleWidth: 0.64,
      legThickness: 0.7, hindLegThickness: 0.8, pawSize: 0.84,
    },
    ears: { type: 'rounded', length: 0.28, width: 0.44, dynamics: 0.16 },
    tail: { type: 'straight', thickness: 0.56, taper: 0.6, curl: 0.04, motion: 0.36 },
    face: {
      eyeScale: 0.94, eyeSpacing: 0.96, eyeHeight: 1.02, eyeForward: 1.02, noseScale: 0.8, brow: 0.08,
      irisColor: 0x2a1a10, lidColor: 0x2a1a10, lidDarkColor: 0x140c06,
      hideTeeth: false, noseColor: 0x1a120a, noseBlendColor: 0x3a2a1c,
    },
    coat: {
      length: 0.32, body: 0.36, head: 0.28, muzzle: 0.18, ears: 0.16, legs: 0.22, paws: 0.14, tail: 0.26,
      grooming: 'coarse', pattern: 'solid',
      palette: { undercoat: 0x8a6a48, guard: 0x3a2a1a, root: 0x6a5038, tip: 0x9a7a58 },
      gravityDroop: 0.16, density: 600,
    },
    // Longer heavier quills + a bristly crest along the head/neck.
    furnishings: { ruff: 0.08, dorsalCrest: 0.4, quills: 1.3 },
    extremities: { foot: 'rodent-paw', hoofSize: 1, dewclaw: 0.3, bareBelow: 0.74 },
    motion: { stride: 0.54, speed: 0.64, sitDepth: 0.56, earDynamics: 0.22, tailMotion: 0.36 },
    variation: { scale: 0.04, build: 0.04, coatShade: 0.1, coatLength: 0.04, energy: 0.18, trainability: 0.14 },
  }),

  // Cervidae — red deer (long-legged slender, branched antler rack, fawn spots).
  'red-deer': mergeProfile({
    skeleton: {
      scale: 1.18, bodyLength: 1.12, legLength: 1.24, chestWidth: 0.8, hipWidth: 0.78,
      neckLength: 1.06, headSize: 0.96, muzzleLength: 1.28, tailLength: 0.32,
    },
    geometry: {
      torsoWidth: 0.82, torsoDepth: 1.0, backArch: 0.02, frontTaper: 0.9,
      neckWidth: 0.78, skullWidth: 0.88, skullHeight: 0.96,
      skullLength: 1.12, cheekFullness: 0.5, muzzleWidth: 0.66,
      legThickness: 0.72, hindLegThickness: 0.86, pawSize: 0.92,
    },
    ears: { type: 'erect', length: 0.78, width: 0.62, dynamics: 0.3 },
    tail: { type: 'straight', thickness: 0.4, taper: 0.6, curl: 0.04, motion: 0.5 },
    face: {
      eyeScale: 1.1, eyeSpacing: 1.1, eyeHeight: 1.02, eyeForward: 1.02, noseScale: 0.86, brow: 0.1,
      eyeStyle: 'caprine', pupilAspect: 3.0, scleraAmount: 0.2,
      irisColor: 0x9a7838, lidColor: 0x3a2a1a, lidDarkColor: 0x20140a,
      hideTeeth: true, noseColor: 0x241812, noseBlendColor: 0x6a5038,
    },
    coat: {
      length: 0.34, body: 0.4, head: 0.3, muzzle: 0.18, ears: 0.24, legs: 0.26, paws: 0.12, tail: 0.34,
      grooming: 'coarse', pattern: 'cervid-fawn',
      // Tawny ground with neat white spots; pale belly, white rump patch.
      palette: { undercoat: 0xeae0d0, guard: 0x9a6a36, root: 0xb8884a, tip: 0xd8b070 },
      gravityDroop: 0.2, density: 580,
    },
    furnishings: { ruff: 0.2, beard: 0.15 },
    extremities: { foot: 'cloven-hoof', hoofSize: 1.0, dewclaw: 0.6, bareBelow: 0.84 },
    // Signature: branched multi-tine antler rack on the poll.
    headgear: {
      type: 'antler-rack', length: 1.25, curl: 0.5, spread: 1.0, thickness: 1.0,
      color: 0x8a7250, tipColor: 0xd8c4a0,
    },
    motion: { stride: 1.18, speed: 1.16, sitDepth: 0.7, earDynamics: 0.3, tailMotion: 0.5 },
    variation: { scale: 0.04, build: 0.04, coatShade: 0.1, coatLength: 0.05, energy: 0.24, trainability: 0.14 },
  }),

  // Camelidae — dromedary (single hump, long neck/legs) + llama (woolly, long neck).
  dromedary: mergeProfile({
    skeleton: {
      scale: 1.3, bodyLength: 1.04, legLength: 1.3, chestWidth: 0.84, hipWidth: 0.82,
      neckLength: 1.32, headSize: 0.92, muzzleLength: 1.3, tailLength: 0.4,
    },
    geometry: {
      // Pronounced single dorsal hump over the withers.
      torsoWidth: 0.92, torsoDepth: 1.0, backArch: 0.02, frontTaper: 0.92, hump: 0.085,
      neckWidth: 0.84, skullWidth: 0.84, skullHeight: 0.86,
      skullLength: 1.18, cheekFullness: 0.48, muzzleWidth: 0.58,
      legThickness: 0.78, hindLegThickness: 0.86, pawSize: 0.98,
    },
    ears: { type: 'erect', length: 0.62, width: 0.5, dynamics: 0.28 },
    tail: { type: 'straight', thickness: 0.46, taper: 0.6, curl: 0.04, motion: 0.4 },
    face: {
      eyeScale: 1.06, eyeSpacing: 1.08, eyeHeight: 1.0, eyeForward: 1.0, noseScale: 0.92, brow: 0.16,
      eyeStyle: 'caprine', pupilAspect: 3.4, scleraAmount: 0.24,
      irisColor: 0x9a7838, lidColor: 0x3a2a1a, lidDarkColor: 0x20140a,
      hideTeeth: false, noseColor: 0x2a1a10, noseBlendColor: 0x6a4e30,
    },
    coat: {
      length: 0.32, body: 0.38, head: 0.26, muzzle: 0.16, ears: 0.2, legs: 0.22, paws: 0.12, tail: 0.28,
      grooming: 'short', pattern: 'solid',
      palette: { undercoat: 0xc8a878, guard: 0x7a5a38, root: 0xa88858, tip: 0xd8b888 },
      gravityDroop: 0.16, density: 560,
    },
    furnishings: { ruff: 0.12 },
    extremities: { foot: 'cloven-hoof', hoofSize: 1.05, dewclaw: 0.4, bareBelow: 0.82 },
    motion: { stride: 1.2, speed: 1.0, sitDepth: 0.7, earDynamics: 0.28, tailMotion: 0.4 },
    variation: { scale: 0.04, build: 0.04, coatShade: 0.1, coatLength: 0.05, energy: 0.2, trainability: 0.18 },
  }),
  llama: mergeProfile({
    skeleton: {
      scale: 1.24, bodyLength: 1.08, legLength: 1.26, chestWidth: 0.82, hipWidth: 0.8,
      neckLength: 1.4, headSize: 0.9, muzzleLength: 1.34, tailLength: 0.34,
    },
    geometry: {
      // No hump; woollier coat carries the silhouette read instead.
      torsoWidth: 0.9, torsoDepth: 0.98, backArch: 0.02, frontTaper: 0.92, hump: 0,
      neckWidth: 0.82, skullWidth: 0.82, skullHeight: 0.84,
      skullLength: 1.2, cheekFullness: 0.5, muzzleWidth: 0.54,
      legThickness: 0.8, hindLegThickness: 0.88, pawSize: 0.96,
    },
    ears: { type: 'erect', length: 0.78, width: 0.52, dynamics: 0.34 },
    tail: { type: 'straight', thickness: 0.5, taper: 0.6, curl: 0.04, motion: 0.4 },
    face: {
      eyeScale: 1.04, eyeSpacing: 1.06, eyeHeight: 1.0, eyeForward: 1.0, noseScale: 0.9, brow: 0.14,
      eyeStyle: 'caprine', pupilAspect: 3.4, scleraAmount: 0.22,
      irisColor: 0x9a7838, lidColor: 0x3a2a1a, lidDarkColor: 0x20140a,
      hideTeeth: false, noseColor: 0x2a1a10, noseBlendColor: 0x6a4e30,
    },
    coat: {
      length: 0.78, body: 0.92, head: 0.58, muzzle: 0.32, ears: 0.4, legs: 0.72, paws: 0.34, tail: 0.62,
      grooming: 'medium-double', fiber: 'soft', pattern: 'solid',
      // Woolly cream/tan fleece.
      palette: { undercoat: 0xd8c8a8, guard: 0x8a6a48, root: 0xb09878, tip: 0xe8d8c0 },
      gravityDroop: 0.34, density: 480,
    },
    furnishings: { ruff: 0.18 },
    extremities: { foot: 'cloven-hoof', hoofSize: 1.04, dewclaw: 0.4, bareBelow: 0.8 },
    motion: { stride: 1.16, speed: 0.98, sitDepth: 0.68, earDynamics: 0.32, tailMotion: 0.38 },
    variation: { scale: 0.04, build: 0.04, coatShade: 0.12, coatLength: 0.08, energy: 0.2, trainability: 0.18 },
  }),

  // Suidae — domestic pig (snout disk, cloven hooves) + warthog (tusks + dorsal crest + slope).
  // headShape 'suid': continuous poly head with curved crown + blocky snout
  // (rehomed from earlier capybara poly iterations that read as better pigs).
  'domestic-pig': mergeProfile({
    skeleton: {
      scale: 0.86, bodyLength: 0.98, legLength: 0.66, chestWidth: 0.98, hipWidth: 0.92,
      neckLength: 0.66, headSize: 1.06, muzzleLength: 1.08, tailLength: 0.3,
    },
    geometry: {
      headShape: 'suid',
      torsoWidth: 1.06, torsoDepth: 1.08, backArch: 0.02, frontTaper: 0.92,
      neckWidth: 0.96, skullWidth: 1.02, skullHeight: 0.94,
      skullLength: 1.1, cheekFullness: 0.9, muzzleWidth: 1.0, muzzleHeight: 1.06,
      legThickness: 0.82, hindLegThickness: 0.86, pawSize: 0.92,
    },
    ears: { type: 'floppy', length: 0.82, width: 0.92, dynamics: 0.5 },
    tail: { type: 'curled', thickness: 0.36, curl: 0.9, motion: 0.4 },
    face: {
      eyeScale: 0.9, eyeSpacing: 1.02, eyeHeight: 1.06, eyeForward: 1.0, noseScale: 1.25, brow: 0.1,
      eyeStyle: 'caprine', pupilAspect: 3.2, scleraAmount: 0.18,
      irisColor: 0x9a7838, lidColor: 0x4a3a2a, lidDarkColor: 0x2a2018,
      hideTeeth: false, noseColor: 0x2a1a10, noseBlendColor: 0xc89878,
    },
    coat: {
      length: 0.16, body: 0.16, head: 0.14, muzzle: 0.1, ears: 0.16, legs: 0.12, paws: 0.08, tail: 0.14,
      grooming: 'smooth', pattern: 'solid',
      // Sparsely bristled pink-tan skin.
      palette: { undercoat: 0xe0c8b0, guard: 0xb88868, root: 0xc8a888, tip: 0xeed8c0 },
      gravityDroop: 0.06, density: 540,
    },
    furnishings: { ruff: 0.04 },
    extremities: { foot: 'cloven-hoof', hoofSize: 1.0, dewclaw: 0.5, bareBelow: 0.78 },
    motion: { stride: 0.74, speed: 0.8, sitDepth: 0.62, earDynamics: 0.4, tailMotion: 0.4 },
    variation: { scale: 0.04, build: 0.04, coatShade: 0.12, coatLength: 0.04, energy: 0.22, trainability: 0.2 },
  }),
  warthog: mergeProfile({
    skeleton: {
      scale: 0.82, bodyLength: 1.06, legLength: 0.78, chestWidth: 0.9, hipWidth: 0.82,
      neckLength: 0.72, headSize: 1.08, muzzleLength: 1.14, tailLength: 0.4,
    },
    geometry: {
      headShape: 'suid',
      // Big sloped back: high withers, lowered rump.
      torsoWidth: 0.92, torsoDepth: 1.0, backArch: 0.06, frontTaper: 1.12,
      neckWidth: 0.92, skullWidth: 1.0, skullHeight: 0.9,
      skullLength: 1.16, cheekFullness: 0.78, muzzleWidth: 0.96, muzzleHeight: 1.04,
      legThickness: 0.78, hindLegThickness: 0.82, pawSize: 0.9,
    },
    ears: { type: 'floppy', length: 0.86, width: 0.96, dynamics: 0.46 },
    tail: { type: 'straight', thickness: 0.4, taper: 0.5, curl: 0.5, motion: 0.6 },
    face: {
      eyeScale: 0.86, eyeSpacing: 1.02, eyeHeight: 1.08, eyeForward: 0.98, noseScale: 1.18, brow: 0.18,
      eyeStyle: 'caprine', pupilAspect: 3.2, scleraAmount: 0.2,
      irisColor: 0x6a4e2a, lidColor: 0x3a2a1a, lidDarkColor: 0x20140a,
      hideTeeth: false, noseColor: 0x1a120a, noseBlendColor: 0x4a3a2a,
    },
    coat: {
      length: 0.22, body: 0.24, head: 0.2, muzzle: 0.14, ears: 0.28, legs: 0.14, paws: 0.08, tail: 0.4,
      grooming: 'coarse', pattern: 'solid',
      // Sparse bristly grey-brown over dark skin.
      palette: { undercoat: 0x8a6a48, guard: 0x2a1c14, root: 0x6a4e34, tip: 0x9a7858 },
      gravityDroop: 0.1, density: 460,
    },
    // Stiff dorsal mane along the spine + neck; signature curled tusks.
    furnishings: { ruff: 0.12, dorsalCrest: 0.7 },
    extremities: { foot: 'cloven-hoof', hoofSize: 1.0, dewclaw: 0.5, bareBelow: 0.8 },
    headgear: {
      type: 'tusk-boar', length: 1.0, curl: 0.55, spread: 1.0, thickness: 0.9,
      color: 0xe8dcc0, tipColor: 0xc0a888,
    },
    motion: { stride: 0.86, speed: 1.0, sitDepth: 0.6, earDynamics: 0.4, tailMotion: 0.6 },
    variation: { scale: 0.04, build: 0.04, coatShade: 0.1, coatLength: 0.04, energy: 0.26, trainability: 0.14 },
  }),

  // Castoridae — North American beaver (paddle tail, webbed paws, dense brown underfur).
  'north-american-beaver': rodentProfile({
    skeleton: {
      scale: 0.74, bodyLength: 1.08, legLength: 0.54, chestWidth: 0.96, hipWidth: 0.96,
      neckLength: 0.54, headSize: 0.96, muzzleLength: 0.82, tailLength: 0.46,
    },
    geometry: {
      torsoWidth: 1.02, torsoDepth: 1.04, neckWidth: 0.86, skullWidth: 0.94, skullHeight: 0.88,
      skullLength: 0.92, cheekFullness: 0.82, muzzleWidth: 0.74,
      legThickness: 0.72, hindLegThickness: 0.92, pawSize: 0.92,
    },
    ears: { type: 'rounded', length: 0.26, width: 0.42, dynamics: 0.16 },
    // Signature flat scaly paddle tail laid against the rump.
    tail: { type: 'paddle', thickness: 0.9, taper: 0.5, curl: 0.0, motion: 0.4 },
    face: {
      eyeScale: 0.96, eyeSpacing: 0.98, eyeHeight: 1.02, eyeForward: 1.02, noseScale: 0.74, brow: 0.08,
      irisColor: 0x2a1a10, lidColor: 0x2a1a10, lidDarkColor: 0x140c06,
      hideTeeth: false, noseColor: 0x1a120a, noseBlendColor: 0x3a2a1c,
    },
    coat: {
      length: 0.42, body: 0.5, head: 0.36, muzzle: 0.2, ears: 0.16, legs: 0.3, paws: 0.14, tail: 0.06,
      grooming: 'dense-double', pattern: 'solid',
      palette: { undercoat: 0x6a4830, guard: 0x2a1a10, root: 0x503824, tip: 0x7a5a3c },
      gravityDroop: 0.16, density: 760,
    },
    furnishings: { ruff: 0.04 },
    extremities: { foot: 'webbed-paw', hoofSize: 1, dewclaw: 0.3, bareBelow: 0.72 },
    motion: { stride: 0.54, speed: 0.74, sitDepth: 0.56, earDynamics: 0.22, tailMotion: 0.5 },
    variation: { scale: 0.04, build: 0.04, coatShade: 0.1, coatLength: 0.04, energy: 0.22, trainability: 0.18 },
  }),

  // ─────────────────────────────────────────────────────────────────────────
  // Remaining empty-species fill (eupleridae … antilocapridae). One phenotype
  // per species with the correct foot kit and a measurable signature trait.
  // ─────────────────────────────────────────────────────────────────────────

  // Eupleridae — fossa (long low cat-like Malagasy carnivoran).
  fossa: mustelidProfile({
    skeleton: {
      scale: 0.7, bodyLength: 1.28, legLength: 0.78, chestWidth: 0.72, hipWidth: 0.7,
      neckLength: 0.74, headSize: 0.92, muzzleLength: 0.96, tailLength: 1.12,
    },
    geometry: {
      torsoWidth: 0.72, torsoDepth: 0.84, neckWidth: 0.62, skullWidth: 0.84, skullHeight: 0.9,
      skullLength: 0.98, cheekFullness: 0.52, muzzleWidth: 0.5,
      legThickness: 0.56, hindLegThickness: 0.7, pawSize: 0.68,
    },
    ears: { type: 'rounded', length: 0.48, width: 0.6, dynamics: 0.32 },
    tail: { type: 'straight', thickness: 0.62, taper: 0.72, curl: 0.06, motion: 0.82 },
    face: {
      eyeScale: 1.08, eyeSpacing: 0.94, eyeHeight: 1.04, eyeForward: 1.06, noseScale: 0.7, brow: 0.06,
      eyeStyle: 'feline', pupilAspect: 0.4, scleraAmount: 0.05,
      irisColor: 0xc9a24a, lidColor: 0x2a1c12, lidDarkColor: 0x16100a,
      hideTeeth: true, noseColor: 0x1a120c, noseBlendColor: 0x4a3220,
    },
    coat: {
      length: 0.28, body: 0.32, head: 0.24, muzzle: 0.14, ears: 0.16, legs: 0.22, paws: 0.12, tail: 0.34,
      grooming: 'short', pattern: 'solid',
      palette: { undercoat: 0xc89868, guard: 0x6a3a1c, root: 0x9a6038, tip: 0xd8a878 },
      gravityDroop: 0.12, density: 680,
    },
    furnishings: { ruff: 0.04 },
    extremities: { foot: 'paw', hoofSize: 1, dewclaw: 0.2, bareBelow: 0.72 },
    motion: { stride: 0.7, speed: 1.02, sitDepth: 0.54, earDynamics: 0.32, tailMotion: 0.84 },
    variation: { scale: 0.04, build: 0.04, coatShade: 0.1, coatLength: 0.04, energy: 0.26, trainability: 0.16 },
  }),

  // Nandiniidae — African palm civet (stocky arboreal, ringed tail).
  'african-palm-civet': mustelidProfile({
    skeleton: {
      scale: 0.58, bodyLength: 1.08, legLength: 0.7, chestWidth: 0.82, hipWidth: 0.8,
      neckLength: 0.62, headSize: 0.96, muzzleLength: 0.78, tailLength: 1.0,
    },
    geometry: {
      torsoWidth: 0.88, torsoDepth: 0.94, neckWidth: 0.74, skullWidth: 0.92, skullHeight: 0.92,
      skullLength: 0.94, cheekFullness: 0.68, muzzleWidth: 0.58,
      legThickness: 0.64, hindLegThickness: 0.78, pawSize: 0.74,
    },
    ears: { type: 'rounded', length: 0.42, width: 0.58, dynamics: 0.28 },
    tail: { type: 'straight', thickness: 0.72, taper: 0.62, curl: 0.08, motion: 0.78 },
    face: {
      eyeScale: 1.02, eyeSpacing: 0.96, eyeHeight: 1.02, eyeForward: 1.04, noseScale: 0.76, brow: 0.08,
      irisColor: 0x3a2a18, lidColor: 0x2a1c12, lidDarkColor: 0x16100a,
      hideTeeth: true, noseColor: 0x1a120c, noseBlendColor: 0x4a3220,
    },
    coat: {
      length: 0.34, body: 0.4, head: 0.3, muzzle: 0.16, ears: 0.2, legs: 0.26, paws: 0.14, tail: 0.7,
      grooming: 'short', pattern: 'genet-spotted',
      palette: { undercoat: 0xc8b090, guard: 0x3a2818, root: 0x8a6a48, tip: 0xd0b890 },
      gravityDroop: 0.14, density: 640,
    },
    furnishings: { ruff: 0.08 },
    extremities: { foot: 'paw', hoofSize: 1, dewclaw: 0.3, bareBelow: 0.7 },
    motion: { stride: 0.62, speed: 0.88, sitDepth: 0.56, earDynamics: 0.28, tailMotion: 0.8 },
    variation: { scale: 0.04, build: 0.04, coatShade: 0.1, coatLength: 0.05, energy: 0.22, trainability: 0.16 },
  }),

  // Prionodontidae — banded linsang (very slender, long ringed tail).
  'banded-linsang': mustelidProfile({
    skeleton: {
      scale: 0.44, bodyLength: 1.36, legLength: 0.68, chestWidth: 0.6, hipWidth: 0.58,
      neckLength: 0.66, headSize: 0.86, muzzleLength: 0.9, tailLength: 1.28,
    },
    geometry: {
      torsoWidth: 0.6, torsoDepth: 0.72, neckWidth: 0.52, skullWidth: 0.76, skullHeight: 0.82,
      skullLength: 0.96, cheekFullness: 0.44, muzzleWidth: 0.42,
      legThickness: 0.44, hindLegThickness: 0.56, pawSize: 0.52,
    },
    ears: { type: 'rounded', length: 0.4, width: 0.54, dynamics: 0.32 },
    tail: { type: 'saber', thickness: 0.58, taper: 0.8, curl: 0.1, motion: 0.88 },
    face: {
      eyeScale: 1.12, eyeSpacing: 0.92, eyeHeight: 1.06, eyeForward: 1.08, noseScale: 0.64, brow: 0.05,
      eyeStyle: 'feline', pupilAspect: 0.36, scleraAmount: 0.04,
      irisColor: 0xc9a24a, lidColor: 0x2a1c12, lidDarkColor: 0x16100a,
      hideTeeth: true, noseColor: 0x1a120c, noseBlendColor: 0x3a2818,
    },
    coat: {
      length: 0.28, body: 0.32, head: 0.24, muzzle: 0.14, ears: 0.16, legs: 0.2, paws: 0.1, tail: 0.72,
      grooming: 'short', pattern: 'genet-spotted',
      palette: { undercoat: 0xe0d4bc, guard: 0x2a2014, root: 0xa89878, tip: 0xd0c4a8 },
      gravityDroop: 0.12, density: 660,
    },
    furnishings: { ruff: 0.02 },
    extremities: { foot: 'paw', hoofSize: 1, dewclaw: 0.2, bareBelow: 0.76 },
    motion: { stride: 0.64, speed: 1.0, sitDepth: 0.52, earDynamics: 0.32, tailMotion: 0.9 },
    variation: { scale: 0.04, build: 0.035, coatShade: 0.1, coatLength: 0.04, energy: 0.28, trainability: 0.16 },
  }),

  // Heteromyidae — kangaroo rat (long hind legs, long tufted tail, tiny scale).
  // frontLegScale ~0.88 keeps front/hind bind coplanar on the shared rig while
  // still reading hind-biased (true biped ratios float PawL).
  'kangaroo-rat': rodentProfile({
    skeleton: {
      scale: 0.34, bodyLength: 0.82, legLength: 0.98, frontLegScale: 0.88,
      chestWidth: 0.7, hipWidth: 0.78,
      neckLength: 0.5, headSize: 0.96, muzzleLength: 0.82, tailLength: 1.28,
    },
    geometry: {
      torsoWidth: 0.78, torsoDepth: 0.86, backArch: 0.04, frontTaper: 0.9,
      neckWidth: 0.64, skullWidth: 0.94, skullHeight: 0.96,
      skullLength: 0.94, cheekFullness: 0.7, muzzleWidth: 0.56,
      legThickness: 0.42, hindLegThickness: 1.05, pawSize: 0.7,
    },
    ears: { type: 'rounded', length: 0.7, width: 0.78, dynamics: 0.3 },
    tail: { type: 'straight', thickness: 0.38, taper: 0.55, curl: 0.08, motion: 0.85 },
    face: {
      eyeScale: 1.2, eyeSpacing: 0.96, eyeHeight: 1.06, eyeForward: 1.06, noseScale: 0.7, brow: 0.04,
      irisColor: 0x2a1a10, lidColor: 0x2a1a10, lidDarkColor: 0x140c06,
      hideTeeth: false, noseColor: 0x2a1a10, noseBlendColor: 0x5a4030,
    },
    coat: {
      length: 0.26, body: 0.3, head: 0.24, muzzle: 0.12, ears: 0.14, legs: 0.16, paws: 0.08, tail: 0.5,
      grooming: 'short', pattern: 'solid',
      palette: { undercoat: 0xd8c4a0, guard: 0x7a5a38, root: 0xa88858, tip: 0xe0c8a0 },
      gravityDroop: 0.1, density: 700,
    },
    furnishings: { ruff: 0 },
    extremities: { foot: 'rodent-paw', hoofSize: 1, dewclaw: 0, bareBelow: 0.88 },
    motion: { stride: 0.95, speed: 1.2, sitDepth: 0.42, earDynamics: 0.3, tailMotion: 0.88 },
    variation: { scale: 0.04, build: 0.035, coatShade: 0.1, coatLength: 0.04, energy: 0.3, trainability: 0.12 },
  }),

  // Dipodidae — jerboa (long hind legs + very long balancing tail).
  // Same coplanar bind constraint as kangaroo-rat — long legs, not true biped.
  jerboa: rodentProfile({
    skeleton: {
      scale: 0.32, bodyLength: 0.78, legLength: 1.0, frontLegScale: 0.88,
      chestWidth: 0.66, hipWidth: 0.74,
      neckLength: 0.48, headSize: 0.94, muzzleLength: 0.78, tailLength: 1.4,
    },
    geometry: {
      torsoWidth: 0.72, torsoDepth: 0.82, neckWidth: 0.6, skullWidth: 0.92, skullHeight: 0.94,
      skullLength: 0.92, cheekFullness: 0.62, muzzleWidth: 0.52,
      legThickness: 0.4, hindLegThickness: 1.1, pawSize: 0.68,
    },
    ears: { type: 'erect', length: 0.92, width: 0.7, dynamics: 0.36 },
    tail: { type: 'straight', thickness: 0.34, taper: 0.5, curl: 0.06, motion: 0.9 },
    face: {
      eyeScale: 1.18, eyeSpacing: 0.94, eyeHeight: 1.06, eyeForward: 1.06, noseScale: 0.68, brow: 0.04,
      irisColor: 0x2a1a10, lidColor: 0x2a1a10, lidDarkColor: 0x140c06,
      hideTeeth: false, noseColor: 0x2a1a10, noseBlendColor: 0x5a4030,
    },
    coat: {
      length: 0.24, body: 0.28, head: 0.22, muzzle: 0.12, ears: 0.12, legs: 0.14, paws: 0.06, tail: 0.4,
      grooming: 'short', pattern: 'solid',
      palette: { undercoat: 0xe0d0b0, guard: 0x8a6a40, root: 0xb09060, tip: 0xe8d8b8 },
      gravityDroop: 0.1, density: 700,
    },
    furnishings: { ruff: 0 },
    extremities: { foot: 'rodent-paw', hoofSize: 1, dewclaw: 0, bareBelow: 0.9 },
    motion: { stride: 1.0, speed: 1.22, sitDepth: 0.4, earDynamics: 0.34, tailMotion: 0.92 },
    variation: { scale: 0.04, build: 0.035, coatShade: 0.1, coatLength: 0.04, energy: 0.3, trainability: 0.12 },
  }),

  // Gliridae — edible dormouse (soft dense coat, bushy tail, large eyes).
  'edible-dormouse': rodentProfile({
    skeleton: {
      scale: 0.4, bodyLength: 0.9, legLength: 0.62, chestWidth: 0.78, hipWidth: 0.76,
      neckLength: 0.54, headSize: 1.0, muzzleLength: 0.7, tailLength: 0.92,
    },
    geometry: {
      torsoWidth: 0.86, torsoDepth: 0.92, neckWidth: 0.72, skullWidth: 0.98, skullHeight: 0.96,
      skullLength: 0.9, cheekFullness: 0.78, muzzleWidth: 0.58,
      legThickness: 0.56, hindLegThickness: 0.72, pawSize: 0.7,
    },
    ears: { type: 'rounded', length: 0.5, width: 0.64, dynamics: 0.28 },
    tail: { type: 'sciurid', thickness: 1.0, taper: 0.58, curl: 0.12, motion: 0.72 },
    face: {
      eyeScale: 1.22, eyeSpacing: 0.96, eyeHeight: 1.06, eyeForward: 1.06, noseScale: 0.7, brow: 0.05,
      irisColor: 0x1a120a, lidColor: 0x2a1a10, lidDarkColor: 0x140c06,
      hideTeeth: false, noseColor: 0x2a1a10, noseBlendColor: 0x4a3a2a,
    },
    coat: {
      length: 0.48, body: 0.56, head: 0.44, muzzle: 0.24, ears: 0.28, legs: 0.34, paws: 0.16, tail: 0.95,
      grooming: 'dense-double', pattern: 'solid',
      palette: { undercoat: 0xd8d0c4, guard: 0x6a5a48, root: 0x9a8a74, tip: 0xc8c0b0 },
      gravityDroop: 0.18, density: 780,
    },
    furnishings: { ruff: 0.1 },
    extremities: { foot: 'rodent-paw', hoofSize: 1, dewclaw: 0, bareBelow: 0.78 },
    motion: { stride: 0.54, speed: 0.9, sitDepth: 0.5, earDynamics: 0.28, tailMotion: 0.74 },
    variation: { scale: 0.04, build: 0.035, coatShade: 0.1, coatLength: 0.06, energy: 0.22, trainability: 0.16 },
  }),

  // Spalacidae — blind mole-rat (cylindrical fossorial, reduced pinnae/tail).
  'blind-mole-rat': rodentProfile({
    skeleton: {
      scale: 0.48, bodyLength: 1.14, legLength: 0.42, chestWidth: 0.9, hipWidth: 0.9,
      neckLength: 0.4, headSize: 0.96, muzzleLength: 0.92, tailLength: 0.18,
    },
    geometry: {
      torsoWidth: 0.96, torsoDepth: 0.98, neckWidth: 0.88, skullWidth: 0.92, skullHeight: 0.86,
      skullLength: 1.0, cheekFullness: 0.8, muzzleWidth: 0.7,
      legThickness: 0.62, hindLegThickness: 0.7, pawSize: 0.78,
    },
    // Tiny pinnae — still long enough for the ear-centerline plant check (≥0.012m).
    ears: { type: 'rounded', length: 0.28, width: 0.36, dynamics: 0.08 },
    tail: { type: 'straight', thickness: 0.3, taper: 0.7, curl: 0.02, motion: 0.15 },
    face: {
      eyeScale: 0.35, eyeSpacing: 0.9, eyeHeight: 0.98, eyeForward: 0.95, noseScale: 0.9, brow: 0.12,
      irisColor: 0x1a120a, lidColor: 0x3a2a1c, lidDarkColor: 0x1a120a,
      hideTeeth: false, noseColor: 0x2a1a10, noseBlendColor: 0x5a4030,
    },
    coat: {
      length: 0.3, body: 0.34, head: 0.28, muzzle: 0.16, ears: 0.08, legs: 0.2, paws: 0.12, tail: 0.12,
      grooming: 'short', pattern: 'solid',
      palette: { undercoat: 0x8a7860, guard: 0x4a3a28, root: 0x6a5840, tip: 0x9a8868 },
      gravityDroop: 0.1, density: 720,
    },
    furnishings: { ruff: 0 },
    extremities: { foot: 'rodent-paw', hoofSize: 1, dewclaw: 0.2, bareBelow: 0.72 },
    motion: { stride: 0.4, speed: 0.55, sitDepth: 0.48, earDynamics: 0.1, tailMotion: 0.15 },
    variation: { scale: 0.04, build: 0.04, coatShade: 0.1, coatLength: 0.04, energy: 0.16, trainability: 0.12 },
  }),

  // Nesomyidae — giant pouched rat (large muriform scavenger).
  'giant-pouched-rat': rodentProfile({
    skeleton: {
      scale: 0.56, bodyLength: 1.04, legLength: 0.66, chestWidth: 0.82, hipWidth: 0.8,
      neckLength: 0.6, headSize: 1.0, muzzleLength: 1.05, tailLength: 1.05,
    },
    geometry: {
      torsoWidth: 0.88, torsoDepth: 0.94, neckWidth: 0.72, skullWidth: 0.94, skullHeight: 0.92,
      skullLength: 1.05, cheekFullness: 0.72, muzzleWidth: 0.62,
      legThickness: 0.58, hindLegThickness: 0.74, pawSize: 0.72,
    },
    ears: { type: 'erect', length: 0.72, width: 0.72, dynamics: 0.32 },
    tail: { type: 'straight', thickness: 0.42, taper: 0.78, curl: 0.04, motion: 0.72 },
    face: {
      eyeScale: 1.06, eyeSpacing: 0.94, eyeHeight: 1.02, eyeForward: 1.05, noseScale: 0.78, brow: 0.06,
      irisColor: 0x2a1a10, lidColor: 0x2a1a10, lidDarkColor: 0x140c06,
      hideTeeth: false, noseColor: 0x2a1a10, noseBlendColor: 0x4a3a2a,
    },
    coat: {
      length: 0.3, body: 0.34, head: 0.26, muzzle: 0.14, ears: 0.16, legs: 0.18, paws: 0.08, tail: 0.22,
      grooming: 'short', pattern: 'solid',
      palette: { undercoat: 0xb09878, guard: 0x4a3828, root: 0x7a6248, tip: 0xc0a888 },
      gravityDroop: 0.12, density: 680,
    },
    furnishings: { ruff: 0.04 },
    extremities: { foot: 'rodent-paw', hoofSize: 1, dewclaw: 0, bareBelow: 0.86 },
    motion: { stride: 0.58, speed: 0.98, sitDepth: 0.5, earDynamics: 0.3, tailMotion: 0.7 },
    variation: { scale: 0.04, build: 0.04, coatShade: 0.1, coatLength: 0.04, energy: 0.26, trainability: 0.2 },
  }),

  // Geomyidae — pocket gopher (stocky fossorial, short pinnae/tail).
  'pocket-gopher': rodentProfile({
    skeleton: {
      scale: 0.46, bodyLength: 1.02, legLength: 0.48, chestWidth: 0.88, hipWidth: 0.88,
      neckLength: 0.46, headSize: 0.98, muzzleLength: 0.88, tailLength: 0.28,
    },
    geometry: {
      torsoWidth: 0.94, torsoDepth: 0.96, neckWidth: 0.82, skullWidth: 0.96, skullHeight: 0.9,
      skullLength: 0.96, cheekFullness: 0.82, muzzleWidth: 0.68,
      legThickness: 0.64, hindLegThickness: 0.74, pawSize: 0.8,
    },
    ears: { type: 'rounded', length: 0.34, width: 0.42, dynamics: 0.12 },
    tail: { type: 'straight', thickness: 0.36, taper: 0.7, curl: 0.04, motion: 0.25 },
    face: {
      eyeScale: 0.7, eyeSpacing: 0.92, eyeHeight: 1.0, eyeForward: 1.0, noseScale: 0.86, brow: 0.1,
      irisColor: 0x2a1a10, lidColor: 0x2a1a10, lidDarkColor: 0x140c06,
      hideTeeth: false, noseColor: 0x2a1a10, noseBlendColor: 0x5a4030,
    },
    coat: {
      length: 0.34, body: 0.4, head: 0.3, muzzle: 0.16, ears: 0.1, legs: 0.22, paws: 0.12, tail: 0.18,
      grooming: 'short', pattern: 'solid',
      palette: { undercoat: 0x9a7a58, guard: 0x4a3420, root: 0x7a5a3c, tip: 0xb09068 },
      gravityDroop: 0.12, density: 700,
    },
    furnishings: { ruff: 0 },
    extremities: { foot: 'rodent-paw', hoofSize: 1, dewclaw: 0.25, bareBelow: 0.74 },
    motion: { stride: 0.44, speed: 0.68, sitDepth: 0.5, earDynamics: 0.14, tailMotion: 0.25 },
    variation: { scale: 0.04, build: 0.04, coatShade: 0.1, coatLength: 0.04, energy: 0.2, trainability: 0.12 },
  }),

  // Bathyergidae — naked mole-rat (nearly hairless fossorial tube).
  'naked-mole-rat': rodentProfile({
    skeleton: {
      scale: 0.3, bodyLength: 1.2, legLength: 0.38, chestWidth: 0.78, hipWidth: 0.78,
      neckLength: 0.38, headSize: 0.92, muzzleLength: 0.86, tailLength: 0.2,
    },
    geometry: {
      torsoWidth: 0.84, torsoDepth: 0.88, neckWidth: 0.78, skullWidth: 0.88, skullHeight: 0.84,
      skullLength: 0.94, cheekFullness: 0.7, muzzleWidth: 0.62,
      legThickness: 0.5, hindLegThickness: 0.58, pawSize: 0.62,
    },
    // Vestigial pinnae — keep path length clearly above the 0.012m floor.
    ears: { type: 'rounded', length: 0.32, width: 0.4, dynamics: 0.05 },
    tail: { type: 'straight', thickness: 0.28, taper: 0.7, curl: 0.02, motion: 0.12 },
    face: {
      eyeScale: 0.28, eyeSpacing: 0.88, eyeHeight: 0.96, eyeForward: 0.94, noseScale: 0.88, brow: 0.1,
      irisColor: 0x1a120a, lidColor: 0xc89880, lidDarkColor: 0x8a6048,
      hideTeeth: false, noseColor: 0xc89880, noseBlendColor: 0xd8a890,
    },
    coat: {
      // Near-hairless: ultra-short sparse shells so pink skin reads.
      length: 0.04, body: 0.05, head: 0.04, muzzle: 0.03, ears: 0.02, legs: 0.03, paws: 0.02, tail: 0.03,
      grooming: 'smooth', pattern: 'solid',
      palette: { undercoat: 0xe8b8a0, guard: 0xc89078, root: 0xd8a888, tip: 0xf0c8b0 },
      gravityDroop: 0.02, density: 200,
    },
    furnishings: { ruff: 0 },
    extremities: { foot: 'rodent-paw', hoofSize: 1, dewclaw: 0, bareBelow: 0.92 },
    motion: { stride: 0.36, speed: 0.5, sitDepth: 0.42, earDynamics: 0.05, tailMotion: 0.12 },
    variation: { scale: 0.035, build: 0.03, coatShade: 0.08, coatLength: 0.02, energy: 0.14, trainability: 0.1 },
  }),

  // Equidae — domestic horse (solid hoof, long limbs, long neck).
  'domestic-horse': mergeProfile({
    skeleton: {
      scale: 1.36, bodyLength: 1.14, legLength: 1.32, chestWidth: 0.86, hipWidth: 0.82,
      neckLength: 1.26, headSize: 1.14, muzzleLength: 1.44, tailLength: 1.15,
      legStyle: 'cursorial', neckCarriage: 0.8,
    },
    geometry: {
      torsoWidth: 0.9, torsoDepth: 1.04, backArch: 0.02, frontTaper: 0.92,
      neckWidth: 0.84, skullWidth: 0.72, skullHeight: 0.76,
      skullLength: 1.32, cheekFullness: 0.4, muzzleWidth: 0.4, muzzleHeight: 0.66,
      headShape: 'equid',
      legThickness: 0.78, hindLegThickness: 0.9, pawSize: 0.95,
    },
    ears: { type: 'erect', length: 0.62, width: 0.52, dynamics: 0.3 },
    tail: { type: 'dock', thickness: 0.82, taper: 0.42, curl: 0, motion: 0.32 },
    face: {
      eyeScale: 0.98, eyeSpacing: 0.82, eyeHeight: 1.0, eyeForward: 0.62, noseScale: 0.92, brow: 0.12,
      eyeStyle: 'caprine', pupilAspect: 2.6, scleraAmount: 0, eyeLateral: 1.45,
      irisColor: 0x5a3a1c, lidColor: 0x2a1c12, lidDarkColor: 0x16100a,
      hideTeeth: true, noseColor: 0x1a120c, noseBlendColor: 0x4a3220,
    },
    coat: {
      length: 0.28, body: 0.32, head: 0.24, muzzle: 0.14, ears: 0.18, legs: 0.08, paws: 0.05, tail: 4.5,
      grooming: 'short', pattern: 'bay-points',
      palette: { undercoat: 0xc06f38, guard: 0x16120e, root: 0xa5643a, tip: 0xd88a50 },
      gravityDroop: 0.14, density: 560,
    },
    // Light dorsal mane read via crest + ruff.
    furnishings: { ruff: 0.1, dorsalCrest: 0, crestMane: 1 },
    extremities: { foot: 'solid-hoof', hoofSize: 1.08, dewclaw: 0.15, bareBelow: 0.88 },
    motion: { stride: 1.22, speed: 1.18, sitDepth: 0.72, earDynamics: 0.3, tailMotion: 0.55 },
    variation: { scale: 0.04, build: 0.04, coatShade: 0.12, coatLength: 0.05, energy: 0.24, trainability: 0.22 },
  }),

  // Rhinocerotidae — white rhino (massive barrel, solid hoof, poll horn).
  // Headgear: bilateral horn-bovid stands in for a single nasal horn (no rhino kit).
  'white-rhinoceros': mergeProfile({
    skeleton: {
      scale: 1.42, bodyLength: 1.12, legLength: 0.78, chestWidth: 1.18, hipWidth: 1.12,
      neckLength: 0.7, headSize: 1.2, muzzleLength: 1.35, tailLength: 0.36,
    },
    geometry: {
      torsoWidth: 1.22, torsoDepth: 1.2, backArch: 0.03, frontTaper: 0.95,
      neckWidth: 1.15, skullWidth: 1.1, skullHeight: 0.92,
      skullLength: 1.28, cheekFullness: 0.7, muzzleWidth: 0.95,
      legThickness: 1.15, hindLegThickness: 1.2, pawSize: 1.15,
    },
    ears: { type: 'erect', length: 0.55, width: 0.55, dynamics: 0.2 },
    tail: { type: 'straight', thickness: 0.5, taper: 0.55, curl: 0.1, motion: 0.35 },
    face: {
      eyeScale: 0.72, eyeSpacing: 1.05, eyeHeight: 0.96, eyeForward: 0.96, noseScale: 1.15, brow: 0.2,
      eyeStyle: 'caprine', pupilAspect: 2.8, scleraAmount: 0.15,
      irisColor: 0x3a2a18, lidColor: 0x4a4038, lidDarkColor: 0x2a2420,
      hideTeeth: true, noseColor: 0x3a342c, noseBlendColor: 0x6a6458,
    },
    coat: {
      length: 0.08, body: 0.1, head: 0.08, muzzle: 0.06, ears: 0.1, legs: 0.08, paws: 0.04, tail: 0.2,
      grooming: 'smooth', pattern: 'solid',
      palette: { undercoat: 0x9a9488, guard: 0x5a564c, root: 0x7a766c, tip: 0xb0aaa0 },
      gravityDroop: 0.04, density: 320,
    },
    furnishings: { ruff: 0.04 },
    extremities: { foot: 'solid-hoof', hoofSize: 1.2, dewclaw: 0.2, bareBelow: 0.82 },
    // Proxied with bovid horn on the poll (no dedicated rhino horn kit yet).
    headgear: {
      type: 'horn-bovid', length: 1.15, curl: 0.12, spread: 0.55, thickness: 1.2,
      color: 0xc8bca8, tipColor: 0xe8dcc8,
    },
    motion: { stride: 0.7, speed: 0.55, sitDepth: 0.75, earDynamics: 0.2, tailMotion: 0.32 },
    variation: { scale: 0.035, build: 0.035, coatShade: 0.08, coatLength: 0.03, energy: 0.14, trainability: 0.1 },
  }),

  // Tapiridae — Brazilian tapir (stocky, solid hoof, elongated muzzle).
  'brazilian-tapir': mergeProfile({
    skeleton: {
      scale: 1.1, bodyLength: 1.08, legLength: 0.82, chestWidth: 1.0, hipWidth: 0.98,
      neckLength: 0.72, headSize: 1.05, muzzleLength: 1.4, tailLength: 0.28,
    },
    geometry: {
      torsoWidth: 1.06, torsoDepth: 1.08, backArch: 0.04, frontTaper: 0.92,
      neckWidth: 0.95, skullWidth: 0.92, skullHeight: 0.88,
      skullLength: 1.22, cheekFullness: 0.62, muzzleWidth: 0.72,
      legThickness: 0.92, hindLegThickness: 1.0, pawSize: 1.0,
    },
    ears: { type: 'erect', length: 0.62, width: 0.58, dynamics: 0.28 },
    tail: { type: 'straight', thickness: 0.4, taper: 0.65, curl: 0.04, motion: 0.3 },
    face: {
      eyeScale: 0.9, eyeSpacing: 1.02, eyeHeight: 1.0, eyeForward: 1.0, noseScale: 1.1, brow: 0.14,
      eyeStyle: 'caprine', pupilAspect: 2.8, scleraAmount: 0.16,
      irisColor: 0x3a2a18, lidColor: 0x2a2420, lidDarkColor: 0x181410,
      hideTeeth: true, noseColor: 0x1a1410, noseBlendColor: 0x3a2a22,
    },
    coat: {
      length: 0.22, body: 0.26, head: 0.2, muzzle: 0.12, ears: 0.16, legs: 0.16, paws: 0.08, tail: 0.16,
      grooming: 'short', pattern: 'solid',
      palette: { undercoat: 0x4a4038, guard: 0x1a1612, root: 0x322820, tip: 0x5a5048 },
      gravityDroop: 0.1, density: 540,
    },
    furnishings: { ruff: 0.06 },
    extremities: { foot: 'solid-hoof', hoofSize: 1.05, dewclaw: 0.25, bareBelow: 0.84 },
    motion: { stride: 0.78, speed: 0.78, sitDepth: 0.65, earDynamics: 0.28, tailMotion: 0.28 },
    variation: { scale: 0.04, build: 0.04, coatShade: 0.08, coatLength: 0.04, energy: 0.2, trainability: 0.16 },
  }),

  // Tayassuidae — collared peccary (pig-like, cloven hoof, bristly).
  'collared-peccary': mergeProfile({
    skeleton: {
      scale: 0.78, bodyLength: 1.0, legLength: 0.7, chestWidth: 0.94, hipWidth: 0.9,
      neckLength: 0.64, headSize: 1.02, muzzleLength: 1.05, tailLength: 0.22,
    },
    geometry: {
      headShape: 'suid',
      torsoWidth: 1.0, torsoDepth: 1.02, backArch: 0.03, frontTaper: 0.94,
      neckWidth: 0.9, skullWidth: 0.98, skullHeight: 0.9,
      skullLength: 1.06, cheekFullness: 0.78, muzzleWidth: 0.9, muzzleHeight: 1.0,
      legThickness: 0.78, hindLegThickness: 0.84, pawSize: 0.88,
    },
    ears: { type: 'erect', length: 0.55, width: 0.6, dynamics: 0.32 },
    tail: { type: 'straight', thickness: 0.32, taper: 0.7, curl: 0.08, motion: 0.3 },
    face: {
      eyeScale: 0.88, eyeSpacing: 1.0, eyeHeight: 1.04, eyeForward: 1.0, noseScale: 1.15, brow: 0.12,
      eyeStyle: 'caprine', pupilAspect: 3.0, scleraAmount: 0.16,
      irisColor: 0x6a4e2a, lidColor: 0x3a2a1a, lidDarkColor: 0x20140a,
      hideTeeth: false, noseColor: 0x1a120a, noseBlendColor: 0x4a3a2a,
    },
    coat: {
      length: 0.32, body: 0.36, head: 0.28, muzzle: 0.16, ears: 0.22, legs: 0.2, paws: 0.1, tail: 0.2,
      grooming: 'coarse', pattern: 'solid',
      palette: { undercoat: 0x8a7860, guard: 0x2a2218, root: 0x5a4a38, tip: 0x9a8868 },
      gravityDroop: 0.12, density: 520,
    },
    furnishings: { ruff: 0.1, dorsalCrest: 0.3 },
    extremities: { foot: 'cloven-hoof', hoofSize: 0.95, dewclaw: 0.45, bareBelow: 0.8 },
    motion: { stride: 0.76, speed: 0.92, sitDepth: 0.58, earDynamics: 0.32, tailMotion: 0.3 },
    variation: { scale: 0.04, build: 0.04, coatShade: 0.1, coatLength: 0.04, energy: 0.24, trainability: 0.16 },
  }),

  // Hippopotamidae — common hippo (massive barrel, short legs, huge head).
  'common-hippopotamus': mergeProfile({
    skeleton: {
      scale: 1.45, bodyLength: 1.08, legLength: 0.58, chestWidth: 1.25, hipWidth: 1.22,
      neckLength: 0.55, headSize: 1.28, muzzleLength: 1.25, tailLength: 0.28,
    },
    geometry: {
      torsoWidth: 1.28, torsoDepth: 1.25, backArch: 0.02, frontTaper: 0.96,
      neckWidth: 1.2, skullWidth: 1.18, skullHeight: 0.95,
      skullLength: 1.22, cheekFullness: 0.9, muzzleWidth: 1.1, muzzleHeight: 1.05,
      legThickness: 1.2, hindLegThickness: 1.25, pawSize: 1.2,
    },
    ears: { type: 'rounded', length: 0.35, width: 0.5, dynamics: 0.18 },
    tail: { type: 'straight', thickness: 0.48, taper: 0.6, curl: 0.08, motion: 0.28 },
    face: {
      eyeScale: 0.7, eyeSpacing: 1.1, eyeHeight: 1.1, eyeForward: 0.98, noseScale: 1.2, brow: 0.15,
      eyeStyle: 'caprine', pupilAspect: 2.6, scleraAmount: 0.12,
      irisColor: 0x3a2a18, lidColor: 0xc89080, lidDarkColor: 0x8a5040,
      hideTeeth: false, noseColor: 0xc89080, noseBlendColor: 0xd8a898,
    },
    coat: {
      length: 0.05, body: 0.06, head: 0.05, muzzle: 0.04, ears: 0.06, legs: 0.05, paws: 0.03, tail: 0.1,
      grooming: 'smooth', pattern: 'solid',
      palette: { undercoat: 0xd8a090, guard: 0x8a5040, root: 0xb07868, tip: 0xe8b8a8 },
      gravityDroop: 0.02, density: 280,
    },
    furnishings: { ruff: 0 },
    extremities: { foot: 'cloven-hoof', hoofSize: 1.25, dewclaw: 0.35, bareBelow: 0.78 },
    motion: { stride: 0.55, speed: 0.48, sitDepth: 0.72, earDynamics: 0.18, tailMotion: 0.25 },
    variation: { scale: 0.035, build: 0.03, coatShade: 0.08, coatLength: 0.02, energy: 0.12, trainability: 0.1 },
  }),

  // Giraffidae — reticulated giraffe (extreme neck, cloven hoof, ossicone proxy).
  // Base scale 1.52 + variation 0.03 keeps seeded max ≤ 1.6 (range ceiling).
  'reticulated-giraffe': mergeProfile({
    skeleton: {
      scale: 1.52, bodyLength: 1.0, legLength: 1.45, chestWidth: 0.78, hipWidth: 0.76,
      neckLength: 1.95, headSize: 0.88, muzzleLength: 1.3, tailLength: 0.7,
    },
    geometry: {
      torsoWidth: 0.82, torsoDepth: 0.96, backArch: 0.02, frontTaper: 0.9,
      neckWidth: 0.62, skullWidth: 0.78, skullHeight: 0.88,
      skullLength: 1.15, cheekFullness: 0.42, muzzleWidth: 0.52,
      legThickness: 0.72, hindLegThickness: 0.82, pawSize: 0.95,
    },
    ears: { type: 'erect', length: 0.7, width: 0.48, dynamics: 0.28 },
    tail: { type: 'straight', thickness: 0.42, taper: 0.5, curl: 0.04, motion: 0.55 },
    face: {
      eyeScale: 1.05, eyeSpacing: 1.05, eyeHeight: 1.02, eyeForward: 1.0, noseScale: 0.88, brow: 0.12,
      eyeStyle: 'caprine', pupilAspect: 2.8, scleraAmount: 0.18,
      irisColor: 0x6a4e2a, lidColor: 0x3a2a1a, lidDarkColor: 0x20140a,
      hideTeeth: true, noseColor: 0x1a120c, noseBlendColor: 0x5a4030,
    },
    coat: {
      length: 0.26, body: 0.3, head: 0.22, muzzle: 0.14, ears: 0.18, legs: 0.2, paws: 0.08, tail: 0.55,
      grooming: 'short', pattern: 'hyena-spotted',
      // Warm orange reticulation approximated via spotted kit.
      palette: { undercoat: 0xe8d0a0, guard: 0x8a4a18, root: 0xc88840, tip: 0xf0d8a8 },
      gravityDroop: 0.12, density: 520,
    },
    furnishings: { ruff: 0.08, dorsalCrest: 0.2 },
    extremities: { foot: 'cloven-hoof', hoofSize: 1.1, dewclaw: 0.2, bareBelow: 0.9 },
    // Ossicones proxied with short upright simple horns (no dedicated ossicone kit).
    headgear: {
      type: 'horn-caprine', length: 0.45, curl: 0.08, spread: 0.7, thickness: 0.85,
      color: 0x3a2a1c, tipColor: 0x6a5040,
    },
    motion: { stride: 1.28, speed: 1.05, sitDepth: 0.78, earDynamics: 0.28, tailMotion: 0.5 },
    variation: { scale: 0.03, build: 0.035, coatShade: 0.1, coatLength: 0.04, energy: 0.2, trainability: 0.14 },
  }),

  // Moschidae — Siberian musk deer (small hornless deer, elongated canines via face).
  'siberian-musk-deer': mergeProfile({
    skeleton: {
      scale: 0.62, bodyLength: 1.0, legLength: 0.98, chestWidth: 0.78, hipWidth: 0.76,
      neckLength: 0.82, headSize: 0.92, muzzleLength: 1.1, tailLength: 0.22,
    },
    geometry: {
      torsoWidth: 0.8, torsoDepth: 0.94, backArch: 0.04, frontTaper: 0.9,
      neckWidth: 0.72, skullWidth: 0.86, skullHeight: 0.94,
      skullLength: 1.05, cheekFullness: 0.52, muzzleWidth: 0.58,
      legThickness: 0.62, hindLegThickness: 0.76, pawSize: 0.78,
    },
    ears: { type: 'erect', length: 0.78, width: 0.58, dynamics: 0.32 },
    tail: { type: 'straight', thickness: 0.32, taper: 0.65, curl: 0.04, motion: 0.35 },
    face: {
      eyeScale: 1.12, eyeSpacing: 1.05, eyeHeight: 1.02, eyeForward: 1.02, noseScale: 0.82, brow: 0.08,
      eyeStyle: 'caprine', pupilAspect: 3.0, scleraAmount: 0.2,
      irisColor: 0x8a6830, lidColor: 0x3a2a1a, lidDarkColor: 0x20140a,
      hideTeeth: false, noseColor: 0x241812, noseBlendColor: 0x5a4030,
    },
    coat: {
      length: 0.48, body: 0.54, head: 0.4, muzzle: 0.22, ears: 0.28, legs: 0.34, paws: 0.14, tail: 0.28,
      grooming: 'dense-double', pattern: 'solid',
      palette: { undercoat: 0x8a6a48, guard: 0x3a2818, root: 0x6a4a30, tip: 0x9a7850 },
      gravityDroop: 0.22, density: 620,
    },
    furnishings: { ruff: 0.12 },
    extremities: { foot: 'cloven-hoof', hoofSize: 0.88, dewclaw: 0.55, bareBelow: 0.84 },
    motion: { stride: 0.95, speed: 1.08, sitDepth: 0.62, earDynamics: 0.3, tailMotion: 0.35 },
    variation: { scale: 0.04, build: 0.04, coatShade: 0.1, coatLength: 0.05, energy: 0.26, trainability: 0.12 },
  }),

  // Tragulidae — lesser mouse-deer (tiny delicate cloven-hoofed).
  'lesser-mouse-deer': mergeProfile({
    skeleton: {
      scale: 0.38, bodyLength: 0.92, legLength: 0.92, chestWidth: 0.72, hipWidth: 0.72,
      neckLength: 0.7, headSize: 0.9, muzzleLength: 1.0, tailLength: 0.2,
    },
    geometry: {
      torsoWidth: 0.74, torsoDepth: 0.88, backArch: 0.06, frontTaper: 0.88,
      neckWidth: 0.64, skullWidth: 0.84, skullHeight: 0.92,
      skullLength: 0.98, cheekFullness: 0.5, muzzleWidth: 0.52,
      legThickness: 0.5, hindLegThickness: 0.62, pawSize: 0.62,
    },
    ears: { type: 'erect', length: 0.65, width: 0.52, dynamics: 0.3 },
    tail: { type: 'straight', thickness: 0.28, taper: 0.7, curl: 0.04, motion: 0.3 },
    face: {
      eyeScale: 1.18, eyeSpacing: 1.02, eyeHeight: 1.04, eyeForward: 1.04, noseScale: 0.76, brow: 0.06,
      eyeStyle: 'caprine', pupilAspect: 3.0, scleraAmount: 0.18,
      irisColor: 0x8a6830, lidColor: 0x3a2a1a, lidDarkColor: 0x20140a,
      hideTeeth: true, noseColor: 0x241812, noseBlendColor: 0x6a4a30,
    },
    coat: {
      length: 0.26, body: 0.3, head: 0.24, muzzle: 0.14, ears: 0.16, legs: 0.18, paws: 0.08, tail: 0.16,
      grooming: 'short', pattern: 'solid',
      palette: { undercoat: 0xd8a870, guard: 0x7a3a18, root: 0xa86030, tip: 0xe0b880 },
      gravityDroop: 0.12, density: 640,
    },
    furnishings: { ruff: 0.04 },
    extremities: { foot: 'cloven-hoof', hoofSize: 0.75, dewclaw: 0.4, bareBelow: 0.88 },
    motion: { stride: 0.85, speed: 1.1, sitDepth: 0.52, earDynamics: 0.3, tailMotion: 0.3 },
    variation: { scale: 0.04, build: 0.035, coatShade: 0.1, coatLength: 0.04, energy: 0.28, trainability: 0.12 },
  }),

  // Antilocapridae — pronghorn (cursorial, cloven hoof, pronged horns).
  pronghorn: mergeProfile({
    skeleton: {
      scale: 1.05, bodyLength: 1.08, legLength: 1.22, chestWidth: 0.8, hipWidth: 0.78,
      neckLength: 0.98, headSize: 0.94, muzzleLength: 1.2, tailLength: 0.28,
    },
    geometry: {
      torsoWidth: 0.84, torsoDepth: 0.98, backArch: 0.02, frontTaper: 0.9,
      neckWidth: 0.76, skullWidth: 0.86, skullHeight: 0.96,
      skullLength: 1.08, cheekFullness: 0.48, muzzleWidth: 0.58,
      legThickness: 0.7, hindLegThickness: 0.84, pawSize: 0.9,
    },
    ears: { type: 'erect', length: 0.72, width: 0.52, dynamics: 0.3 },
    tail: { type: 'straight', thickness: 0.36, taper: 0.6, curl: 0.04, motion: 0.4 },
    face: {
      eyeScale: 1.1, eyeSpacing: 1.08, eyeHeight: 1.02, eyeForward: 1.02, noseScale: 0.84, brow: 0.1,
      eyeStyle: 'caprine', pupilAspect: 3.0, scleraAmount: 0.2,
      irisColor: 0x9a7838, lidColor: 0x3a2a1a, lidDarkColor: 0x20140a,
      hideTeeth: true, noseColor: 0x241812, noseBlendColor: 0x6a5038,
    },
    coat: {
      length: 0.3, body: 0.34, head: 0.26, muzzle: 0.16, ears: 0.2, legs: 0.22, paws: 0.1, tail: 0.28,
      grooming: 'short', pattern: 'solid',
      // Tan back, pale belly/rump (goat-pied approximates the high-contrast blocks).
      palette: { undercoat: 0xf0e8d8, guard: 0xb07030, root: 0xd09850, tip: 0xf0d8a8 },
      gravityDroop: 0.14, density: 580,
    },
    furnishings: { ruff: 0.1 },
    extremities: { foot: 'cloven-hoof', hoofSize: 0.95, dewclaw: 0.35, bareBelow: 0.88 },
    headgear: {
      type: 'horn-caprine', length: 0.72, curl: 0.35, spread: 0.85, thickness: 0.85,
      color: 0x2a2218, tipColor: 0x5a4a38,
    },
    motion: { stride: 1.2, speed: 1.28, sitDepth: 0.68, earDynamics: 0.3, tailMotion: 0.4 },
    variation: { scale: 0.04, build: 0.04, coatShade: 0.1, coatLength: 0.04, energy: 0.28, trainability: 0.12 },
  }),
});

function toSeed32(seed) {
  const value = Number(seed);
  return Number.isFinite(value) ? (Math.trunc(value) >>> 0) : 1;
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
 * Resolve an immutable authored phenotype. Resolution order is
 * Family → Breed → Variant → Seed: `variantId` picks a discrete named
 * subtype (coat/size) via a sparse override merged onto the breed's base
 * profile *before* the 32-bit seed's bounded continuous noise is applied.
 * Ear/tail/muzzle/pattern *types* and skeleton proportions stay fixed by
 * breed (and, for variants, by the override) — seed never changes them.
 *
 * Catalog-only stubs keep their catalog `breedId` for identity/summary, but
 * silhouette/mesh data come from the family's first authored profile (or
 * Golden when no family authored base exists). Unknown ids → Golden.
 * Unknown/missing variant IDs resolve to the *renderable* breed's default.
 */
export function resolveDogPhenotype({ breedId = 'golden-retriever', seed = 1, variantId } = {}) {
  const catalogEntry = getDogBreed(breedId);
  const identityBreedId = catalogEntry?.id ?? normalizeRenderableDogBreedId(breedId);
  const resolvedBreedId = normalizeRenderableDogBreedId(breedId);
  const resolvedSeed = toSeed32(seed);
  // Stubs have no discrete subtype profiles — always use the render base default.
  // Authored breeds (identity === render) keep the caller's variantId path.
  const resolvedVariantId = identityBreedId === resolvedBreedId
    ? normalizeDogVariantId(resolvedBreedId, variantId)
    : normalizeDogVariantId(resolvedBreedId, undefined);
  const base = applyDogVariantOverride(
    DOG_PHENOTYPE_PROFILES[resolvedBreedId],
    resolvedBreedId,
    resolvedVariantId,
  );
  const breedInfo = getDogBreed(identityBreedId) ?? getDogBreed(resolvedBreedId);
  const [sizeV, buildV, shadeV, coatV, energyV, trainV] = seededValues(resolvedSeed, 6);
  const v = base.variation;
  const familyInfo = getDogFamily(breedInfo.familyId);
  const phenotype = {
    breedId: identityBreedId,
    variantId: identityBreedId === resolvedBreedId
      ? resolvedVariantId
      : normalizeDogVariantId(identityBreedId, variantId),
    familyId: breedInfo.familyId,
    speciesId: familyInfo?.speciesId ?? null,
    seed: resolvedSeed,
    skeleton: {
      ...base.skeleton,
      scale: base.skeleton.scale * (1 + sizeV * v.scale),
      chestWidth: base.skeleton.chestWidth * (1 + buildV * v.build),
      hipWidth: base.skeleton.hipWidth * (1 + buildV * v.build * 0.75),
    },
    geometry: {
      ...base.geometry,
      torsoWidth: base.geometry.torsoWidth * (1 + buildV * v.build),
      torsoDepth: base.geometry.torsoDepth * (1 + buildV * v.build * 0.6),
    },
    ears: { ...base.ears },
    tail: { ...base.tail },
    face: { ...base.face },
    coat: {
      ...base.coat,
      length: base.coat.length * (1 + coatV * v.coatLength),
      palette: Object.fromEntries(
        Object.entries(base.coat.palette).map(([key, hex]) => [key, tintHex(hex, shadeV * v.coatShade)]),
      ),
    },
    furnishings: { ...base.furnishings },
    extremities: { ...(base.extremities ?? { foot: 'paw', hoofSize: 1, dewclaw: 0, bareBelow: 0.75 }) },
    headgear: { ...(base.headgear ?? { type: 'none', length: 1, curl: 0.5, spread: 1, thickness: 1 }) },
    motion: { ...base.motion },
    personality: {
      energy: Math.max(1, Math.min(5, breedInfo.behavior.energy + energyV * v.energy)),
      trainability: Math.max(1, Math.min(5, breedInfo.behavior.trainability + trainV * v.trainability)),
      sociability: breedInfo.behavior.sociability,
      vigilance: breedInfo.behavior.vigilance,
    },
    variation: { ...base.variation },
  };
  return deepFreeze(phenotype);
}

export function hasAuthoredDogPhenotype(breedId) {
  return AUTHORED_DOG_BREED_IDS.includes(breedId) && Boolean(DOG_PHENOTYPE_PROFILES[breedId]);
}

export { toSeed32 as normalizeDogSeed };
