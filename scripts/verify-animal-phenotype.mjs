/**
 * verify-animal-phenotype — guards AI Animal Compiler PR1:
 * recipe clamp/merge, direct createProceduralDog path, enum drift, catalog ranges.
 *
 * Run: node scripts/verify-animal-phenotype.mjs
 * npm:  npm run verify:animal-phenotype
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ANIMAL_COAT_PATTERNS,
  ANIMAL_EAR_TYPES,
  ANIMAL_FOOT_TYPES,
  ANIMAL_HEADGEAR_TYPES,
  ANIMAL_NUMERIC_RANGES,
  ANIMAL_TAIL_TYPES,
  PATTERN_ALIASES,
  TEMPLATE_BASE_ID,
} from '../src/game/characters/dog/animalPhenotypeEnums.js';
import {
  getBreedOrVirtual,
  isAnimalRefusal,
  nearestCoatPattern,
  parseColorToHex,
  resolveDogPhenotypeFromRecipe,
  validateAndClampAnimalRecipe,
} from '../src/game/characters/dog/animalPhenotypeClamp.js';
import { createProceduralDog } from '../src/game/characters/dog/createProceduralDog.js';
import {
  DOG_PHENOTYPE_PROFILES,
  resolveDogPhenotype,
} from '../src/game/characters/dog/dogPhenotypes.js';
import { normalizeRenderableDogBreedId } from '../src/game/characters/dog/dogCatalog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`  ✓ ${name}`);
};

// --- Enum drift: coat patterns cover colorMaskAt branches + golden-shade ---
{
  const coatSrc = readFileSync(join(root, 'src/game/characters/dog/dogCoatFields.js'), 'utf8');
  const colorMaskFn = coatSrc.match(/export function colorMaskAt[\s\S]*?^export function /m)?.[0]
    ?? coatSrc;
  const patternLiterals = new Set(
    [...colorMaskFn.matchAll(/pattern\s*===\s*['"]([a-z0-9-]+)['"]/g)].map((m) => m[1]),
  );
  patternLiterals.add('golden-shade');
  for (const p of patternLiterals) {
    assert.ok(
      ANIMAL_COAT_PATTERNS.includes(p),
      `ANIMAL_COAT_PATTERNS missing pattern used in colorMaskAt: ${p}`,
    );
  }
  ok(`coat patterns cover colorMaskAt (${patternLiterals.size} literals)`);
}

// --- Ear / tail types appear in skeleton ---
{
  const skelSrc = readFileSync(join(root, 'src/game/characters/dog/dogSkeleton.js'), 'utf8');
  for (const t of ANIMAL_EAR_TYPES) {
    assert.ok(
      skelSrc.includes(`'${t}'`) || skelSrc.includes(`"${t}"`),
      `ear type ${t} not referenced in dogSkeleton.js`,
    );
  }
  for (const t of ANIMAL_TAIL_TYPES) {
    if (t === 'plume' || t === 'saber') {
      // plume is default fallthrough; saber may share straight-ish path
      continue;
    }
    assert.ok(
      skelSrc.includes(`'${t}'`) || skelSrc.includes(`"${t}"`),
      `tail type ${t} not referenced in dogSkeleton.js`,
    );
  }
  ok('ear/tail enums grounded in dogSkeleton.js');
}

// --- Catalog numerics fall within recipe ranges ---
{
  const outOfRange = [];
  for (const [breedId, profile] of Object.entries(DOG_PHENOTYPE_PROFILES)) {
    const stack = [[profile, '']];
    while (stack.length) {
      const [obj, prefix] = stack.pop();
      for (const [key, value] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          stack.push([value, path]);
        } else if (typeof value === 'number') {
          const range = ANIMAL_NUMERIC_RANGES[path];
          if (!range) continue;
          if (value < range.min || value > range.max) {
            outOfRange.push(`${breedId} ${path}=${value} not in [${range.min}, ${range.max}]`);
          }
        }
      }
    }
  }
  assert.equal(outOfRange.length, 0, outOfRange.join('\n'));
  ok('catalog profile numerics within ANIMAL_NUMERIC_RANGES');
}

// --- Seeded extremes stay in range (base-only walk is not enough) ---
{
  const extremeBreeds = [
    'reticulated-giraffe', 'common-hippopotamus', 'domestic-horse',
    'white-rhinoceros', 'naked-mole-rat', 'house-mouse', 'great-dane',
  ];
  // Nonzero seeds only — seed 0 collapses via `seed || default` in resolve path.
  const seeds = [1, 2, 3, 7, 11, 43];
  const outOfRange = [];
  for (const breedId of extremeBreeds) {
    for (const seed of seeds) {
      const ph = resolveDogPhenotype({ breedId, seed });
      for (const path of ['skeleton.scale', 'skeleton.neckLength', 'skeleton.legLength']) {
        const [section, key] = path.split('.');
        const value = ph[section]?.[key];
        const range = ANIMAL_NUMERIC_RANGES[path];
        if (!range || typeof value !== 'number') continue;
        if (value < range.min || value > range.max) {
          outOfRange.push(`${breedId} seed=${seed} ${path}=${value}`);
        }
      }
    }
  }
  assert.equal(outOfRange.length, 0, `seeded extremes out of range:\n${outOfRange.join('\n')}`);
  ok(`seeded extreme breeds stay in numeric ranges (${extremeBreeds.length} × ${seeds.length} seeds)`);
}

// --- Template bases exist ---
{
  for (const [template, baseId] of Object.entries(TEMPLATE_BASE_ID)) {
    assert.ok(DOG_PHENOTYPE_PROFILES[baseId], `template ${template} base ${baseId} missing`);
  }
  ok('template base profiles exist');
}

// --- Caprine template base ---
{
  assert.equal(TEMPLATE_BASE_ID.caprine, 'domestic-goat');
  assert.ok(DOG_PHENOTYPE_PROFILES['domestic-goat']);
  ok('caprine template maps to domestic-goat');
}

// --- Color parse ---
{
  assert.equal(parseColorToHex('#9da0a2'), 0x9da0a2);
  assert.equal(parseColorToHex('17191a'), 0x17191a);
  assert.equal(parseColorToHex(0xcf9440), 0xcf9440);
  assert.equal(parseColorToHex('nope'), null);
  ok('parseColorToHex');
}

// --- Pattern aliases ---
{
  assert.equal(nearestCoatPattern('silver-fox', 'canid').pattern, 'husky-mask');
  assert.equal(nearestCoatPattern('raccoon-mask').pattern, 'raccoon-mask');
  assert.equal(nearestCoatPattern('totally-unknown-xyz', 'feline').pattern, 'solid');
  assert.ok(PATTERN_ALIASES['silver-fox']);
  ok('nearestCoatPattern + aliases');
}

// --- Refusal detection ---
{
  assert.equal(isAnimalRefusal({ refuse: true, error: 'horse' }), true);
  assert.equal(isAnimalRefusal({ template: 'canid', name: 'x' }), false);
  const refused = validateAndClampAnimalRecipe({
    refuse: true,
    error: 'Birds need a separate generator',
    suggestion: 'Try a fox or cat',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.refuse, true);
  ok('refusal path');
}

// --- Silver fox recipe ---
const silverFoxRecipe = {
  schemaVersion: 1,
  template: 'canid',
  name: 'silver-fox',
  label: 'Silver Fox',
  familyId: 'wild-canid',
  baseBreedId: 'german-shepherd-dog',
  seed: 1,
  skeleton: {
    scale: 0.72,
    bodyLength: 1.08,
    legLength: 0.94,
    muzzleLength: 1.35,
    tailLength: 1.28,
  },
  geometry: {
    torsoWidth: 0.9,
    cheekFullness: 0.7,
    backArch: 0.01,
    frontTaper: 1.0,
  },
  ears: { type: 'erect', length: 0.9, width: 0.86, dynamics: 0.3 },
  tail: { type: 'plume', thickness: 1.4, curl: 0.05, motion: 0.85 },
  face: {
    eyeScale: 0.95,
    irisColor: '#2a2418',
    lidColor: '#1a1614',
    noseColor: '#1a1412',
  },
  coat: {
    length: 0.9,
    body: 0.95,
    pattern: 'silver-fox',
    grooming: 'dense-double',
    palette: {
      undercoat: '#9da0a2',
      guard: '#17191a',
      root: '#6a6e72',
      tip: '#d5d7d8',
    },
    gravityDroop: 0.35,
    density: 480,
  },
  furnishings: { ruff: 0.4 },
  motion: { stride: 1.05, speed: 1.08 },
  personality: { energy: 4, trainability: 3, sociability: 3, vigilance: 4 },
};

{
  const result = validateAndClampAnimalRecipe(silverFoxRecipe);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.phenotype.source, 'recipe');
  assert.equal(result.phenotype.breedId, 'silver-fox');
  assert.equal(result.phenotype.familyId, 'wild-canid');
  assert.equal(result.phenotype.speciesId, 'canidae');
  assert.equal(result.phenotype.coat.pattern, 'husky-mask');
  assert.equal(result.phenotype.ears.type, 'erect');
  assert.equal(result.phenotype.skeleton.scale, 0.72);
  assert.equal(typeof result.phenotype.coat.palette.guard, 'number');
  assert.equal(result.phenotype.coat.palette.guard, 0x17191a);
  assert.equal(result.recipe.coat.palette.guard.startsWith('#'), true);
  ok('silver-fox recipe clamp + merge');
}

// --- Unknown baseBreedId does not Golden-normalize breedId ---
{
  const ph = resolveDogPhenotypeFromRecipe({
    template: 'canid',
    name: 'ghost-canid',
    baseBreedId: 'not-a-real-breed-zzzz',
    skeleton: { scale: 0.8 },
    ears: { type: 'erect' },
    tail: { type: 'saber' },
    coat: { pattern: 'saddle', length: 0.5 },
  });
  assert.equal(ph.breedId, 'ghost-canid');
  assert.equal(ph.source, 'recipe');
  assert.notEqual(ph.breedId, 'golden-retriever');
  assert.equal(normalizeRenderableDogBreedId('not-a-real-breed-zzzz'), 'golden-retriever');
  ok('recipe path never uses normalizeRenderableDogBreedId for identity');
}

// --- Scale clamp ---
{
  const ph = resolveDogPhenotypeFromRecipe({
    template: 'canid',
    name: 'giant-clamp-test',
    skeleton: { scale: 9 },
    ears: { type: 'erect' },
    tail: { type: 'plume' },
    coat: { pattern: 'solid' },
  });
  // Clamp ceiling tracks ANIMAL_NUMERIC_RANGES['skeleton.scale'].max (giraffe pad).
  assert.ok(ph.skeleton.scale <= 1.6, `scale ${ph.skeleton.scale}`);
  ok('numeric scale clamp');
}

// --- Feline dual iris ---
{
  const ph = resolveDogPhenotypeFromRecipe({
    template: 'feline',
    name: 'odd-eye-cat',
    baseBreedId: 'khao-manee',
    skeleton: { scale: 0.48 },
    ears: { type: 'erect' },
    tail: { type: 'straight' },
    face: {
      irisColor: '#3a7fd4',
      irisColorL: '#3a7fd4',
      irisColorR: '#4cb86a',
    },
    coat: { pattern: 'solid-white', length: 0.22 },
  });
  assert.equal(ph.face.irisColorL, 0x3a7fd4);
  assert.equal(ph.face.irisColorR, 0x4cb86a);
  assert.equal(ph.template, 'feline');
  ok('feline dual iris round-trip');
}

// --- Raccoon geometry extras ---
{
  const ph = resolveDogPhenotypeFromRecipe({
    template: 'procyonid',
    name: 'bandit-test',
    skeleton: { scale: 0.55 },
    geometry: { backArch: 0.03, frontTaper: 0.8, cheekFullness: 0.75 },
    ears: { type: 'rounded' },
    tail: { type: 'straight' },
    coat: { pattern: 'bandit', length: 0.6 },
  });
  assert.equal(ph.coat.pattern, 'raccoon-mask');
  assert.ok(Math.abs(ph.geometry.backArch - 0.03) < 1e-9);
  assert.ok(Math.abs(ph.geometry.frontTaper - 0.8) < 1e-9);
  ok('raccoon geometry + pattern alias');
}

// --- Catalog path unchanged (Great Dane scale preserved if present) ---
{
  if (DOG_PHENOTYPE_PROFILES['great-dane']) {
    const ph = resolveDogPhenotype({ breedId: 'great-dane', seed: 1 });
    assert.equal(ph.skeleton.scale, DOG_PHENOTYPE_PROFILES['great-dane'].skeleton.scale);
    assert.ok(ph.skeleton.scale > 1.35, 'great dane above old clamp max');
    ok(`catalog great-dane scale preserved (${ph.skeleton.scale})`);
  } else {
    // No great-dane profile — still prove catalog path ignores recipe clamp by
    // checking golden scale is exactly authored (1) after seed 1.
    const ph = resolveDogPhenotype({ breedId: 'golden-retriever', seed: 1 });
    assert.equal(ph.skeleton.scale, 1);
    assert.equal(ph.source, undefined);
    ok('catalog golden path unclamped (no great-dane profile in tree)');
  }
}

// --- Garbage breedId still Golden on catalog path ---
{
  const ph = resolveDogPhenotype({ breedId: 'totally-unknown-breed', seed: 1 });
  assert.equal(ph.breedId, 'golden-retriever');
  ok('catalog unknown still Golden');
}

// --- createProceduralDog({ recipe }) ---
{
  const dog = createProceduralDog({ recipe: silverFoxRecipe, seed: 1, shellCount: 3 });
  assert.ok(dog.root);
  assert.ok(dog.breed, 'breed must be non-null');
  assert.equal(dog.breedId, 'silver-fox');
  assert.equal(dog.phenotype.source, 'recipe');
  assert.equal(dog.breed.id, 'silver-fox');
  assert.equal(dog.breed.authored, false);
  assert.ok(dog.boneCount >= 38);
  assert.ok(dog.vertexCount > 1000);
  dog.dispose();
  ok('createProceduralDog({ recipe }) builds mesh + virtual breed');
}

// --- createProceduralDog({ phenotype }) direct ---
{
  const ph = resolveDogPhenotypeFromRecipe(silverFoxRecipe);
  const dog = createProceduralDog({ phenotype: ph, shellCount: 2 });
  assert.equal(dog.breedId, 'silver-fox');
  assert.ok(dog.breed);
  dog.dispose();
  ok('createProceduralDog({ phenotype })');
}

// --- getBreedOrVirtual for catalog id ---
{
  const ph = resolveDogPhenotype({ breedId: 'beagle', seed: 1 });
  const breed = getBreedOrVirtual(ph);
  assert.equal(breed.id, 'beagle');
  assert.equal(breed.authored, true);
  ok('getBreedOrVirtual returns catalog breed when present');
}

// --- Schema file present and oneOf ---
{
  const schema = JSON.parse(
    readFileSync(join(root, 'src/game/characters/dog/animalPhenotype.schema.json'), 'utf8'),
  );
  assert.ok(schema.oneOf?.length === 2);
  assert.equal(schema.$id, 'dreamfall-animal-phenotype-v1');
  ok('animalPhenotype.schema.json oneOf Recipe|Refusal');

  // Content lockstep: sciurid / frontLegScale / lid knobs must stay in schema
  // (additionalProperties:false rejects recipes if these are dropped).
  const recipeDef = schema.$defs?.AnimalRecipe;
  assert.ok(recipeDef?.properties, 'AnimalRecipe definition missing');
  const tailEnum = recipeDef.properties.tail?.properties?.type?.enum;
  assert.ok(Array.isArray(tailEnum), 'tail.type.enum missing from schema');
  assert.ok(tailEnum.includes('sciurid'), 'schema tail.type.enum must include sciurid');
  // Runtime ANIMAL_TAIL_TYPES must all appear in the schema enum (and vice versa).
  for (const t of ANIMAL_TAIL_TYPES) {
    assert.ok(tailEnum.includes(t), `schema tail.type.enum missing runtime type ${t}`);
  }
  for (const t of tailEnum) {
    assert.ok(ANIMAL_TAIL_TYPES.includes(t), `schema tail type ${t} not in ANIMAL_TAIL_TYPES`);
  }
  assert.ok(
    recipeDef.properties.skeleton?.properties?.frontLegScale,
    'schema skeleton.properties.frontLegScale missing',
  );
  const faceProps = recipeDef.properties.face?.properties;
  assert.ok(faceProps?.lidOpacity, 'schema face.properties.lidOpacity missing');
  assert.ok(faceProps?.lidScale, 'schema face.properties.lidScale missing');
  assert.ok(faceProps?.hideTeeth, 'schema face.properties.hideTeeth missing');
  assert.equal(faceProps.hideTeeth.type, 'boolean', 'schema hideTeeth should be boolean');

  // Foot / headgear enums must lockstep with runtime (new fills use solid-hoof etc.).
  const footEnum = recipeDef.properties.extremities?.properties?.foot?.enum;
  assert.ok(Array.isArray(footEnum), 'schema extremities.foot.enum missing');
  for (const t of ANIMAL_FOOT_TYPES) {
    assert.ok(footEnum.includes(t), `schema foot.enum missing runtime type ${t}`);
  }
  for (const t of footEnum) {
    assert.ok(ANIMAL_FOOT_TYPES.includes(t), `schema foot type ${t} not in ANIMAL_FOOT_TYPES`);
  }
  assert.ok(footEnum.includes('solid-hoof') && footEnum.includes('cloven-hoof') && footEnum.includes('webbed-paw'));

  const headgearEnum = recipeDef.properties.headgear?.properties?.type?.enum;
  assert.ok(Array.isArray(headgearEnum), 'schema headgear.type.enum missing');
  for (const t of ANIMAL_HEADGEAR_TYPES) {
    assert.ok(headgearEnum.includes(t), `schema headgear.type.enum missing runtime type ${t}`);
  }
  for (const t of headgearEnum) {
    assert.ok(ANIMAL_HEADGEAR_TYPES.includes(t), `schema headgear type ${t} not in ANIMAL_HEADGEAR_TYPES`);
  }
  assert.ok(headgearEnum.includes('antler-rack') && headgearEnum.includes('tusk-boar'));

  ok('schema content: sciurid + frontLegScale + lid + foot/headgear enum lockstep');
}

console.log(`\n${passed} passed`);
