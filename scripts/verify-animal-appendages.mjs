/**
 * verify-animal-appendages — ungulate kits: hooves, horns, caprine eyes, goat coat.
 *
 * Run: node scripts/verify-animal-appendages.mjs
 * npm:  npm run verify:animal-appendages
 */

import assert from 'node:assert/strict';
import {
  createProceduralDog,
  resolveDogPhenotype,
  isSpeciesPopulated,
  getFamiliesForSpecies,
} from '../src/game/characters/dog/index.js';
import { colorMaskAt, COAT_ZONE } from '../src/game/characters/dog/dogCoatFields.js';
import * as THREE from 'three';

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`  ✓ ${name}`);
};

// Catalog: Bovidae / caprine populated
{
  assert.equal(isSpeciesPopulated('bovidae'), true);
  assert.ok(getFamiliesForSpecies('bovidae').some((f) => f.id === 'caprine'));
  const ph = resolveDogPhenotype({ breedId: 'domestic-goat', seed: 1 });
  assert.equal(ph.familyId, 'caprine');
  assert.equal(ph.speciesId, 'bovidae');
  assert.equal(ph.extremities.foot, 'cloven-hoof');
  assert.equal(ph.headgear.type, 'horn-caprine');
  assert.equal(ph.face.eyeStyle, 'caprine');
  assert.equal(ph.coat.fiber, 'coarse-guard');
  assert.equal(ph.coat.pattern, 'goat-pied');
  assert.ok(ph.furnishings.beard > 0.5);
  ok('domestic-goat phenotype kit fields');
}

// Coat patterns vary
{
  const ph = resolveDogPhenotype({ breedId: 'domestic-goat', seed: 1 });
  const headCenter = new THREE.Vector3(0, 0.55, 0.35);
  const samples = [];
  for (let i = 0; i < 8; i += 1) {
    const p = new THREE.Vector3((i - 4) * 0.04, 0.45, 0.1);
    samples.push(colorMaskAt(COAT_ZONE.body, p, headCenter, ph));
  }
  const spread = Math.max(...samples) - Math.min(...samples);
  assert.ok(spread > 0.15, `goat-pied should vary (spread=${spread})`);
  ok('goat-pied pattern varies');
}

// Build mesh: goat
{
  const dog = createProceduralDog({ breedId: 'domestic-goat', seed: 1, shellCount: 3 });
  assert.ok(dog.root);
  assert.ok(dog.breed);
  assert.equal(dog.breedId, 'domestic-goat');
  assert.equal(dog.speciesId, 'bovidae');
  assert.ok(dog.headgear?.root, 'goat should have headgear root');
  assert.ok(dog.boneCount >= 38);
  assert.ok(dog.vertexCount > 1500);
  dog.dispose();
  ok('createProceduralDog domestic-goat builds with horns');
}

// Canid still has no headgear, paw feet
{
  const dog = createProceduralDog({ breedId: 'golden-retriever', seed: 1, shellCount: 2 });
  assert.equal(dog.phenotype.extremities.foot, 'paw');
  assert.equal(dog.phenotype.headgear.type, 'none');
  assert.ok(!dog.headgear?.root);
  dog.dispose();
  ok('golden keeps paw + no horns');
}

// Recipe path for ungulate
{
  const dog = createProceduralDog({
    recipe: {
      template: 'caprine',
      name: 'nubian-mix',
      extremities: { foot: 'cloven-hoof', hoofSize: 1.05, dewclaw: 0.4 },
      headgear: { type: 'horn-bovid', length: 1.2, curl: 0.7 },
      face: { eyeStyle: 'caprine', pupilAspect: 3.5 },
      ears: { type: 'erect' },
      tail: { type: 'upright' },
      coat: { pattern: 'dorsal-stripe', fiber: 'coarse-guard', length: 0.5 },
      skeleton: { scale: 0.7 },
    },
    seed: 1,
    shellCount: 2,
  });
  assert.equal(dog.breedId, 'nubian-mix');
  assert.equal(dog.phenotype.extremities.foot, 'cloven-hoof');
  assert.equal(dog.phenotype.headgear.type, 'horn-bovid');
  assert.equal(dog.phenotype.face.eyeStyle, 'caprine');
  assert.equal(dog.phenotype.coat.pattern, 'dorsal-stripe');
  assert.ok(dog.headgear?.root);
  dog.dispose();
  ok('recipe path ungulate kits');
}

// Feline eye style
{
  const ph = resolveDogPhenotype({ breedId: 'tortoiseshell', seed: 1 });
  assert.equal(ph.face.eyeStyle, 'feline');
  ok('feline eyeStyle on cats');
}

console.log(`\n${passed} passed`);
