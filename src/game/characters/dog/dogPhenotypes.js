/** Data-authored phenotype profiles and deterministic seeded resolution. */

import {
  AUTHORED_DOG_BREED_IDS,
  getDogBreed,
  normalizeRenderableDogBreedId,
} from './dogCatalog.js';

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
  face: { eyeScale: 1, eyeSpacing: 1, eyeHeight: 1, eyeForward: 1, noseScale: 1, brow: 0 },
  coat: { length: 1, body: 1, head: 1, muzzle: 1, ears: 1, legs: 1, paws: 1, tail: 1, grooming: 'feathered', pattern: 'golden-shade', palette: { undercoat: 0xecd6a4, guard: 0xcf9440, root: 0xd8b57e, tip: 0xf2d9a4 }, gravityDroop: 0.58, density: 420 },
  furnishings: { brows: 0, beard: 0, ruff: 0.35 },
  motion: { stride: 1, speed: 1, sitDepth: 1, earDynamics: 1, tailMotion: 1 },
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
    furnishings: { topknot: 0.65, beard: 0.45, ruff: 0.18 },
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
    furnishings: { topknot: 0.78, beard: 0.58, ruff: 0.4 },
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
    furnishings: { brows: 0.9, beard: 1, ruff: 0.12 },
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
 * Resolve an immutable authored phenotype. A 32-bit seed only changes bounded
 * continuous traits; defining ear, tail, muzzle, pattern, and furnishing types
 * remain fixed. Catalog-only and unknown IDs resolve to Golden at this boundary.
 */
export function resolveDogPhenotype({ breedId = 'golden-retriever', seed = 1 } = {}) {
  const resolvedBreedId = normalizeRenderableDogBreedId(breedId);
  const resolvedSeed = toSeed32(seed);
  const base = DOG_PHENOTYPE_PROFILES[resolvedBreedId];
  const breedInfo = getDogBreed(resolvedBreedId);
  const [sizeV, buildV, shadeV, coatV, energyV, trainV] = seededValues(resolvedSeed, 6);
  const v = base.variation;
  const phenotype = {
    breedId: resolvedBreedId,
    familyId: breedInfo.familyId,
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
