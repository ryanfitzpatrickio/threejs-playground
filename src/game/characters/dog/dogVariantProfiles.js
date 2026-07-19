/**
 * Sparse phenotype overrides for discrete breed variants (coat/size subtypes).
 * Keyed `[breedId][variantId]`. Each entry is a shallow merge over the
 * breed's base DOG_PHENOTYPE_PROFILES entry — only touch coat/furnishings
 * (and, for size variants, skeleton.scale). Never touch ear/tail *type*,
 * pattern identity, or skeleton proportions: those stay the breed's fixed
 * conformation regardless of variant.
 */

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export const DOG_VARIANT_OVERRIDES = deepFreeze({
  dachshund: {
    // Identity — base profile already is the smooth coat.
    smooth: {},
    longhaired: {
      coat: {
        length: 0.95, body: 1.05, head: 0.55, muzzle: 0.32, ears: 1.2, legs: 0.9, paws: 0.55, tail: 1.1,
        grooming: 'feathered', gravityDroop: 0.55, density: 400,
      },
      furnishings: { ruff: 0.25 },
    },
    wirehaired: {
      coat: {
        length: 0.48, body: 0.5, head: 0.42, muzzle: 0.55, ears: 0.4, legs: 0.55, paws: 0.4, tail: 0.32,
        grooming: 'wire', gravityDroop: 0.42, density: 520,
      },
      furnishings: { brows: 0.8, beard: 0.65, mustache: 0.6, neckSkirt: 0.5, ruff: 0.1 },
    },
  },
  // Khao Manee eye subtypes — coat stays solid white; only iris colors change.
  'khao-manee': {
    'odd-eye': {
      face: {
        irisColor: 0x3a7fd4,
        irisColorL: 0x3a7fd4,
        irisColorR: 0x4cb86a,
      },
    },
    blue: {
      face: {
        irisColor: 0x3a7fd4,
        irisColorL: 0x3a7fd4,
        irisColorR: 0x3a7fd4,
      },
    },
    regular: {
      face: {
        irisColor: 0xc9a24a,
        irisColorL: 0xc9a24a,
        irisColorR: 0xc9a24a,
      },
    },
  },
});

/**
 * Shallow-merge a variant's coat/furnishings/skeleton overrides onto a base
 * phenotype profile. Returns `base` unchanged when there is no override
 * (including the common `{}` "identity" default-variant case).
 */
export function applyDogVariantOverride(base, breedId, variantId) {
  const override = DOG_VARIANT_OVERRIDES[breedId]?.[variantId];
  if (!override || Object.keys(override).length === 0) return base;
  const merged = { ...base };
  for (const key of ['skeleton', 'geometry', 'ears', 'tail', 'face', 'coat', 'furnishings', 'motion']) {
    if (!override[key]) continue;
    merged[key] = { ...base[key], ...override[key] };
    if (key === 'coat' && override.coat.palette) {
      merged.coat.palette = { ...base.coat.palette, ...override.coat.palette };
    }
  }
  return merged;
}
