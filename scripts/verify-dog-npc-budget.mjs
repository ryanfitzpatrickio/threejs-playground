/**
 * Guards dog-park NPC draw-call budget: capped pack, low shell count, LOD API.
 *
 * Run: node scripts/verify-dog-npc-budget.mjs
 */
import assert from 'node:assert/strict';
import {
  MAX_NPC_DOGS,
  NPC_SHELL_COUNT,
  pickNpcBreedIds,
} from '../src/game/runtime/features/dogPark/DogParkNpcSystem.js';
import { AUTHORED_DOG_BREED_IDS } from '../src/game/characters/dog/dogCatalog.js';
import { createProceduralDog } from '../src/game/characters/dog/createProceduralDog.js';

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`  ✓ ${name}`);
};

{
  assert.ok(MAX_NPC_DOGS <= 10, `MAX_NPC_DOGS too high (${MAX_NPC_DOGS})`);
  assert.ok(NPC_SHELL_COUNT <= 3, `NPC_SHELL_COUNT too high (${NPC_SHELL_COUNT})`);
  ok(`caps: max=${MAX_NPC_DOGS} shells=${NPC_SHELL_COUNT}`);
}

{
  const picked = pickNpcBreedIds(AUTHORED_DOG_BREED_IDS, MAX_NPC_DOGS);
  assert.ok(picked.length <= MAX_NPC_DOGS);
  assert.ok(picked.length > 0);
  assert.equal(new Set(picked).size, picked.length, 'picked breeds unique');
  ok(`pickNpcBreedIds → ${picked.length} of ${AUTHORED_DOG_BREED_IDS.length}`);
}

{
  // Worst-case skinned draws if every NPC is near (full shells + body).
  const worstSkinned = MAX_NPC_DOGS * (1 + NPC_SHELL_COUNT);
  // Old pack: ~29 breeds × (1+8) shells ≈ 261
  assert.ok(worstSkinned <= 8 * 3, `worst skinned shells+body ${worstSkinned}`);
  assert.ok(worstSkinned <= 32, 'keep pack body+shell draws ≤ 32');
  ok(`worst-case body+shell draws ${worstSkinned} (was ~261)`);
}

{
  const dog = createProceduralDog({
    breedId: 'golden-retriever',
    seed: 1,
    shellCount: NPC_SHELL_COUNT,
    budget: 'npc',
  });
  assert.equal(dog.budget, 'npc');
  assert.equal(dog.shells.length, NPC_SHELL_COUNT);
  assert.equal(dog.bodyMesh.frustumCulled, true);
  dog.setDetailLevel(0);
  assert.equal(dog.getDetailLevel(), 0);
  assert.ok(dog.shells.every((s) => s.visible === false), 'LOD0 hides shells');
  dog.setDetailLevel(2);
  assert.ok(dog.shells.every((s) => s.visible === true), 'LOD2 shows shells');
  dog.dispose();
  ok('npc budget dog frustum + detail LOD');
}

console.log(`\n${passed} passed`);
