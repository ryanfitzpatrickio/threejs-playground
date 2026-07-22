/**
 * verify-insects — guards the Insecta catalog pass:
 * - Order Insecta present with 24 taxonomic families (body-plan groups 1–25)
 * - Each family has ≥1 authored insect breed (flag: insect)
 * - Breeds never leak into AUTHORED_DOG_BREED_IDS or dog-bone clip packs
 * - Silhouette families + variants resolve cleanly
 * - normalizeRenderable falls back to golden (no insect mesh yet)
 * - First-wave photo boards (5 most popular) slice to public/assets/insect-ref
 *
 * Run:  node scripts/verify-insects.mjs
 * npm:  npm run verify:insects
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ANIMAL_ORDERS,
  ANIMAL_SPECIES,
  AUTHORED_DOG_BREED_IDS,
  AUTHORED_INSECT_BREED_IDS,
  DOG_BREEDS,
  DOG_FAMILIES,
  getAnimalSpecies,
  getDogBreed,
  getDogVariants,
  getFamiliesForSpecies,
  isInsectBreed,
  isInsectSpecies,
  isSpeciesPopulated,
  normalizeRenderableDogBreedId,
} from '../src/game/characters/dog/dogCatalog.js';
import { animalClipLibraryKind } from '../src/game/characters/dog/DogClipPlayer.js';
import { dogRefUrl, dogRefUrlChain } from '../src/game/test/DogSimScene.js';
import { INSECT_REF_BREED_IDS } from './prepare-insect-reference-boards.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`  ✓ ${name}`);
};

/** Taxonomic families in body-plan order (user groups 1–25). */
const INSECT_SPECIES = [
  // 1–4 Oval / armored / dome (beetles)
  'coccinellidae',
  'scarabaeidae',
  'curculionidae',
  'carabidae',
  // 5–8 Narrow-waisted (bees, wasps, ants)
  'apidae',
  'vespidae',
  'formicidae',
  'ichneumonidae',
  // 9–11 Two-winged (flies)
  'muscidae',
  'culicidae',
  'syrphidae',
  // 12–14 Jumping orthopterans
  'acrididae',
  'gryllidae',
  'tettigoniidae',
  // 15–16 Flat / scuttling
  'blattidae',
  'rhinotermitidae',
  // 17–19 Lepidoptera
  'nymphalidae',
  'saturniidae',
  'sphingidae',
  // 20–21 Odonates
  'libellulidae',
  'coenagrionidae',
  // 22–23 Raptorial
  'mantidae',
  // 24–25 Camouflage & others
  'phasmatidae',
  'cicadidae',
];

const MVP_BREEDS = [
  'seven-spotted-ladybug',
  'japanese-beetle',
  'acorn-weevil',
  'ground-beetle',
  'honey-bee',
  'yellowjacket',
  'pavement-ant',
  'ichneumon-wasp',
  'house-fly',
  'anopheles-mosquito',
  'hoverfly',
  'grasshopper',
  'field-cricket',
  'katydid',
  'american-cockroach',
  'subterranean-termite',
  'monarch-butterfly',
  'luna-moth',
  'sphinx-moth',
  'dragonfly',
  'damselfly',
  'praying-mantis',
  'stick-insect',
  'periodical-cicada',
];

const BODY_PLANS = new Set([
  'beetle',
  'hymenopteran',
  'fly',
  'orthopteran',
  'roach',
  'termite',
  'lepidopteran',
  'odonate',
  'mantis',
  'phasmid',
  'cicada',
]);

// --- Order + species ---
{
  assert.ok(ANIMAL_ORDERS.some((o) => o.id === 'insecta'), 'missing insecta order');
  const insecta = ANIMAL_SPECIES.filter((s) => s.orderId === 'insecta');
  assert.equal(insecta.length, 24, `expected 24 insecta species, got ${insecta.length}`);
  for (const id of INSECT_SPECIES) {
    const sp = getAnimalSpecies(id);
    assert.ok(sp, `missing species ${id}`);
    assert.equal(sp.orderId, 'insecta');
    assert.ok(isInsectSpecies(id), `${id} should be insect`);
    assert.ok(isSpeciesPopulated(id), `${id} should be populated`);
    assert.ok(BODY_PLANS.has(sp.bodyPlan), `${id} missing/unknown bodyPlan ${sp.bodyPlan}`);
    const families = getFamiliesForSpecies(id);
    assert.equal(families.length, 1, `${id} should have exactly one silhouette family`);
  }
  ok('Insecta order + 24 families populated with body plans');
}

// --- Breeds / flags ---
{
  assert.equal(
    AUTHORED_INSECT_BREED_IDS.length,
    24,
    `expected 24 insect breeds, got ${AUTHORED_INSECT_BREED_IDS.length}`,
  );
  for (const id of MVP_BREEDS) {
    assert.ok(AUTHORED_INSECT_BREED_IDS.includes(id), `missing insect breed ${id}`);
    assert.ok(isInsectBreed(id), `${id} should be insect-flagged`);
    const breed = getDogBreed(id);
    assert.ok(breed.conformationFlags.includes('insect'));
    assert.ok(breed.conformationFlags.includes('non-canine-extension'));
    assert.ok(!AUTHORED_DOG_BREED_IDS.includes(id), `${id} leaked into AUTHORED_DOG_BREED_IDS`);
    assert.equal(
      animalClipLibraryKind({ breedId: id }),
      null,
      `${id} must not use dog-bone clip packs`,
    );
    assert.equal(
      animalClipLibraryKind({ speciesId: breed.speciesId }),
      null,
      `${breed.speciesId} must not use dog-bone clip packs`,
    );
    assert.equal(
      normalizeRenderableDogBreedId(id),
      'golden-retriever',
      `${id} renderable path must fall back until insect mesh ships`,
    );
  }
  ok('24 authored insect breeds flagged, excluded from quadruped set, no clips');
}

// --- Signature subtypes (caste / stage variants) ---
{
  const honey = getDogVariants('honey-bee');
  assert.ok(honey.some((v) => v.id === 'worker'));
  assert.ok(honey.some((v) => v.id === 'drone'));
  assert.ok(honey.some((v) => v.id === 'queen'));
  assert.equal(getDogBreed('honey-bee').defaultVariantId, 'worker');

  const termite = getDogVariants('subterranean-termite');
  assert.ok(termite.some((v) => v.id === 'worker'));
  assert.ok(termite.some((v) => v.id === 'soldier'));
  assert.ok(termite.some((v) => v.id === 'alate'));

  const monarch = getDogVariants('monarch-butterfly');
  assert.ok(monarch.some((v) => v.id === 'chrysalis'));
  assert.ok(monarch.some((v) => v.id === 'caterpillar'));

  const mantis = getDogVariants('praying-mantis');
  assert.ok(mantis.some((v) => v.id === 'green'));
  assert.ok(mantis.some((v) => v.id === 'brown'));

  const cicada = getDogVariants('periodical-cicada');
  assert.ok(cicada.some((v) => v.id === 'brood-x'));
  ok('Caste/stage/morph variants present on eusocial + metamorphosis breeds');
}

// --- Silhouette families unique and nested ---
{
  const insectFamilies = DOG_FAMILIES.filter((f) => {
    const sp = getAnimalSpecies(f.speciesId);
    return sp?.orderId === 'insecta';
  });
  assert.equal(insectFamilies.length, 24, `expected 24 insect silhouette families, got ${insectFamilies.length}`);
  assert.equal(
    new Set(insectFamilies.map((f) => f.id)).size,
    24,
    'insect silhouette family ids must be unique',
  );
  ok('24 unique insect silhouette families');
}

// --- Body-plan group sizes match user top-level buckets ---
{
  const byPlan = {};
  for (const id of INSECT_SPECIES) {
    const plan = getAnimalSpecies(id).bodyPlan;
    byPlan[plan] = (byPlan[plan] ?? 0) + 1;
  }
  assert.equal(byPlan.beetle, 4, 'beetle body plan count');
  assert.equal(byPlan.hymenopteran, 4, 'hymenopteran body plan count');
  assert.equal(byPlan.fly, 3, 'fly body plan count');
  assert.equal(byPlan.orthopteran, 3, 'orthopteran body plan count');
  assert.equal(byPlan.roach, 1, 'roach body plan count');
  assert.equal(byPlan.termite, 1, 'termite body plan count');
  assert.equal(byPlan.lepidopteran, 3, 'lepidopteran body plan count');
  assert.equal(byPlan.odonate, 2, 'odonate body plan count');
  assert.equal(byPlan.mantis, 1, 'mantis body plan count');
  assert.equal(byPlan.phasmid, 1, 'phasmid body plan count');
  assert.equal(byPlan.cicada, 1, 'cicada body plan count');
  ok('Body-plan group sizes match top-level insect buckets');
}

// Sanity: total catalog breed list still includes non-insects
{
  assert.ok(DOG_BREEDS.length >= 157, `catalog should include insects, got ${DOG_BREEDS.length}`);
  assert.equal(AUTHORED_DOG_BREED_IDS.length, 120, 'quadruped authored count must stay 120');
  ok('Catalog size + quadruped authored count intact');
}

// --- First-wave photo boards (5 most popular) ---
{
  assert.equal(INSECT_REF_BREED_IDS.length, 5, 'expected 5 photo-board breeds');
  const views = ['three-quarter', 'profile', 'front-sit', 'head-close'];
  for (const id of INSECT_REF_BREED_IDS) {
    assert.ok(isInsectBreed(id), `${id} must be an insect breed`);
    const board = join(root, 'assets-source', 'insect-ref', id, 'board.jpg');
    assert.ok(existsSync(board), `missing source board ${board}`);
    for (const view of views) {
      const still = join(root, 'public', 'assets', 'insect-ref', id, `${view}.jpg`);
      assert.ok(existsSync(still), `missing prepared still ${still}`);
    }
    assert.equal(
      dogRefUrl('three-quarter.jpg', id),
      `/assets/insect-ref/${id}/three-quarter.jpg`,
    );
    const chain = dogRefUrlChain('head-close.jpg', id);
    assert.ok(chain[0].includes(`/insect-ref/${id}/`), `${id} chain should hit insect-ref first`);
  }
  ok('5 popular insect photo boards + dogRefUrl routing');
}

// --- Ladybug mesh path (first procedural insect) ---
{
  const breed = getDogBreed('seven-spotted-ladybug');
  assert.ok(breed.conformationFlags.includes('ladybug-rig'), 'ladybug must flag ladybug-rig');
  ok('seven-spotted-ladybug carries ladybug-rig mesh flag');
}

console.log(`\nverify-insects: ${passed} checks passed`);
