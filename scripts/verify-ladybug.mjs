/**
 * verify-ladybug — guards the procedural ladybug MVP:
 * - 15-bone skeleton, skinned geometry builds without throw
 * - materials + shells construct
 * - animation settles (idle + crawl) with fixed dt
 * - catalog flag ladybug-rig routes isLadybugBreed
 * - excluded from dog phenotype / clip packs
 *
 * Run:  node scripts/verify-ladybug.mjs
 * npm:  npm run verify:ladybug
 */

import assert from 'node:assert/strict';
import * as THREE from 'three';

import {
  AUTHORED_DOG_BREED_IDS,
  getDogBreed,
  isInsectBreed,
  isLadybugBreed,
} from '../src/game/characters/dog/dogCatalog.js';
import { animalClipLibraryKind } from '../src/game/characters/dog/DogClipPlayer.js';
import {
  createLadybugSkeleton,
  LADYBUG_BONE_DEFS,
  LADYBUG_LEG_BONES,
} from '../src/game/characters/insect/ladybugSkeleton.js';
import { buildLadybugBodyGeometry, LADYBUG_ZONE } from '../src/game/characters/insect/ladybugBodyGeometry.js';
import { createProceduralLadybug } from '../src/game/characters/insect/createProceduralLadybug.js';

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`  ✓ ${name}`);
};

// --- Catalog routing ---
{
  assert.ok(isLadybugBreed('seven-spotted-ladybug'), 'seven-spotted-ladybug should be ladybug-rig');
  assert.ok(isInsectBreed('seven-spotted-ladybug'), 'still insect-flagged');
  assert.ok(!AUTHORED_DOG_BREED_IDS.includes('seven-spotted-ladybug'), 'not in dog phenotype pool');
  assert.equal(
    animalClipLibraryKind({ breedId: 'seven-spotted-ladybug' }),
    null,
    'must not use dog-bone clips',
  );
  const flags = getDogBreed('seven-spotted-ladybug').conformationFlags;
  assert.ok(flags.includes('ladybug-rig'));
  assert.ok(flags.includes('insect'));
  ok('Catalog ladybug-rig + clip exclusion');
}

// --- Skeleton ---
{
  assert.equal(LADYBUG_BONE_DEFS.length, 15, `expected 15 bones, got ${LADYBUG_BONE_DEFS.length}`);
  const rig = createLadybugSkeleton();
  assert.equal(rig.boneCount, 15);
  assert.ok(rig.bonesByName.has('thorax'));
  assert.ok(rig.bonesByName.has('elytra_L'));
  assert.ok(rig.bonesByName.has('Head')); // studio alias
  for (const leg of LADYBUG_LEG_BONES) {
    assert.ok(rig.bonesByName.has(leg), `missing ${leg}`);
  }
  assert.equal(LADYBUG_LEG_BONES.length, 6);
  ok('15-bone skeleton with 6 legs + elytra + Head alias');
}

// --- Geometry ---
{
  const rig = createLadybugSkeleton();
  const geo = buildLadybugBodyGeometry(rig.boneIndex);
  const verts = geo.getAttribute('position').count;
  assert.ok(verts > 500, `expected dense mesh, got ${verts} verts`);
  assert.ok(geo.getAttribute('skinIndex'));
  assert.ok(geo.getAttribute('skinWeight'));
  assert.ok(geo.getAttribute('zoneId'));
  assert.ok(geo.getAttribute('spotMask'));
  assert.ok(geo.getAttribute('shellLen'));
  assert.ok(geo.getIndex()?.count > 1000);
  // Spot mask should light up on elytra verts
  const spots = geo.getAttribute('spotMask');
  const zones = geo.getAttribute('zoneId');
  let maxSpot = 0;
  let elytraVerts = 0;
  for (let i = 0; i < spots.count; i += 1) {
    if (Math.abs(zones.getX(i) - LADYBUG_ZONE.elytra) < 0.1) {
      elytraVerts += 1;
      maxSpot = Math.max(maxSpot, spots.getX(i));
    }
  }
  assert.ok(elytraVerts > 50, 'expected elytra verts');
  assert.ok(maxSpot > 0.3, `expected baked spots, max=${maxSpot}`);
  geo.dispose();
  ok(`Geometry ${verts} verts with elytra spots (max=${maxSpot.toFixed(2)})`);
}

// --- Full factory + animation settle ---
{
  const bug = createProceduralLadybug({
    breedId: 'seven-spotted-ladybug',
    seed: 7,
    variantId: 'seven-spot',
    shellCount: 8,
  });
  assert.equal(bug.rigKind, 'insect');
  assert.equal(bug.breedId, 'seven-spotted-ladybug');
  assert.equal(bug.speciesId, 'coccinellidae');
  assert.ok(bug.boneCount >= 15);
  assert.ok(bug.vertexCount > 500);
  assert.ok(bug.bodyMesh instanceof THREE.SkinnedMesh);
  assert.equal(bug.shells.length, 8);

  // Idle settle
  for (let i = 0; i < 30; i += 1) bug.update(1 / 60);
  const idlePos = bug.animation.getRootPosition();

  // Crawl advances root
  bug.animation.setBehavior('walk');
  for (let i = 0; i < 60; i += 1) bug.update(1 / 60);
  const crawlPos = bug.animation.getRootPosition();
  const dist = Math.hypot(crawlPos.x - idlePos.x, crawlPos.z - idlePos.z);
  assert.ok(dist > 0.01, `crawl should advance root, dist=${dist}`);

  // Elytra flare doesn't throw
  bug.animation.setBehavior('alert');
  for (let i = 0; i < 20; i += 1) bug.update(1 / 60);

  // Naked / shell toggles
  bug.setNakedBody(true);
  assert.equal(bug.getNakedBody(), true);
  bug.setShowFur(false);
  bug.setDetailLevel(0);

  // Variant spot strength
  const immaculate = createProceduralLadybug({
    breedId: 'seven-spotted-ladybug',
    seed: 1,
    variantId: 'immaculate',
    shellCount: 0,
  });
  assert.ok(immaculate.furUniforms.spotStrength.value < 0.2);

  bug.dispose();
  immaculate.dispose();
  ok('Factory + idle/crawl/alert animation + variants');
}

console.log(`\nverify-ladybug: ${passed} checks passed`);
