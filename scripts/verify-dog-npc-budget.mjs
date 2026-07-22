/**
 * Guards dog-park NPC draw-call budget: spectacle-only cast (no ambient pack),
 * low shell counts, chase pair, cats, geese, pigeons.
 *
 * Run: node scripts/verify-dog-npc-budget.mjs
 */
import assert from 'node:assert/strict';
import {
  MAX_NPC_DOGS,
  NPC_SHELL_COUNT,
  CHASE_PAIR_COUNT,
  pickNpcBreedIds,
} from '../src/game/runtime/features/dogPark/DogParkNpcSystem.js';
import {
  CAT_FIGHT_BREEDS,
  CAT_FIGHT_COUNT,
  CAT_FIGHT_SHELL_COUNT,
} from '../src/game/runtime/features/dogPark/DogParkCatFight.js';
import {
  FLOCK_COUNT,
  FLOCK_SHELL_COUNT,
} from '../src/game/runtime/features/dogPark/DogParkGooseFlock.js';
import {
  TREE_PIGEON_COUNT,
  TREE_PIGEON_SHELL_COUNT,
} from '../src/game/runtime/features/dogPark/DogParkTreePigeons.js';
import { createProceduralDog } from '../src/game/characters/dog/createProceduralDog.js';
import { getDogBreed, isCatRigBreed } from '../src/game/characters/dog/dogCatalog.js';
import {
  pickFurDetailLevel,
  shellCountForDetailLevel,
} from '../src/game/characters/dog/dogFurLod.js';

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`  ✓ ${name}`);
};

{
  assert.equal(MAX_NPC_DOGS, 0, 'ambient pack removed');
  assert.ok(CHASE_PAIR_COUNT === 2, 'chase pair is golden + squirrel');
  assert.ok(NPC_SHELL_COUNT <= 3, `NPC_SHELL_COUNT too high (${NPC_SHELL_COUNT})`);
  assert.ok(CAT_FIGHT_COUNT <= 2);
  assert.ok(CAT_FIGHT_SHELL_COUNT <= 6);
  assert.ok(FLOCK_COUNT <= 5);
  assert.ok(FLOCK_SHELL_COUNT <= 4);
  assert.ok(TREE_PIGEON_COUNT <= 5);
  assert.ok(TREE_PIGEON_SHELL_COUNT <= 4);
  ok(`spectacle caps: ambient=0 chase=${CHASE_PAIR_COUNT} cats=${CAT_FIGHT_COUNT} geese=${FLOCK_COUNT} pigeons=${TREE_PIGEON_COUNT}`);
}

{
  // Ambient pack helper is a no-op after removal.
  assert.deepEqual(pickNpcBreedIds(['a', 'b', 'c'], 6), []);
  ok('pickNpcBreedIds returns empty (ambient removed)');
}

{
  // Worst-case body+shell skinned draws for park spectacles (not player dog).
  const chaseDraws = CHASE_PAIR_COUNT * (1 + NPC_SHELL_COUNT);
  const catDraws = CAT_FIGHT_COUNT * (1 + CAT_FIGHT_SHELL_COUNT);
  const gooseDraws = FLOCK_COUNT * (1 + FLOCK_SHELL_COUNT);
  const pigeonDraws = TREE_PIGEON_COUNT * (1 + TREE_PIGEON_SHELL_COUNT);
  const worstSkinned = chaseDraws + catDraws + gooseDraws + pigeonDraws;
  // Old ambient pack alone was ~24; full breed pack was ~261.
  assert.ok(worstSkinned <= 60, `worst spectacle body+shell draws ${worstSkinned}`);
  ok(`worst-case spectacle body+shell draws ${worstSkinned} (chase ${chaseDraws} + cats ${catDraws} + geese ${gooseDraws} + pigeons ${pigeonDraws})`);
}

{
  // Thin NPC stacks keep all shells at every LOD (dropping to 1 root shell
  // was the white-triangle flash). Hero stacks may thin safely.
  assert.equal(shellCountForDetailLevel(0, 2), 2);
  assert.equal(shellCountForDetailLevel(1, 2), 2);
  assert.equal(shellCountForDetailLevel(0, 12), Math.max(3, Math.ceil(12 * 0.22)));
  assert.ok(shellCountForDetailLevel(1, 12) >= 4);
  assert.equal(shellCountForDetailLevel(2, 12), 12);
  // Hysteresis: leave near only after near+hyst.
  assert.equal(pickFurDetailLevel(16.5, 2), 2);
  assert.equal(pickFurDetailLevel(20, 2), 1);
  assert.equal(pickFurDetailLevel(15, 1), 2);
  ok('fur LOD shell counts + hysteresis');
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
  // NPC (2 shells): far LOD still keeps shells — no bare undercoat flash.
  assert.ok(dog.shells.every((s) => s.visible === true), 'thin stack keeps shells at LOD0');
  dog.setDetailLevel(2);
  assert.ok(dog.shells.every((s) => s.visible === true), 'LOD2 shows shells');
  dog.dispose();

  const hero = createProceduralDog({
    breedId: 'golden-retriever',
    seed: 2,
    shellCount: 12,
    budget: 'hero',
  });
  hero.setDetailLevel(0);
  assert.ok(hero.shells.filter((s) => s.visible).length >= 3, 'hero far keeps base coat');
  assert.ok(hero.shells.filter((s) => s.visible).length < 12, 'hero far thins shells');
  hero.setDetailLevel(2);
  assert.ok(hero.shells.every((s) => s.visible === true), 'hero near full shells');
  hero.dispose();
  ok('npc/hero dog detail LOD visibility');
}

{
  // First two feline catalog entries — dog pipeline, not cat-rig procedural.
  assert.deepEqual(CAT_FIGHT_BREEDS, ['tortoiseshell', 'khao-manee']);
  for (const breedId of CAT_FIGHT_BREEDS) {
    assert.ok(getDogBreed(breedId)?.authored, `${breedId} authored`);
    assert.equal(getDogBreed(breedId)?.familyId, 'feline');
    assert.equal(isCatRigBreed(breedId), false, `${breedId} is not cat-rig`);
  }
  assert.equal(isCatRigBreed('tortoiseshell-procedural'), true);
  const cat = createProceduralDog({
    breedId: CAT_FIGHT_BREEDS[0],
    seed: 2,
    shellCount: CAT_FIGHT_SHELL_COUNT,
    budget: 'npc',
  });
  assert.equal(cat.budget, 'npc');
  assert.equal(cat.breedId, 'tortoiseshell');
  assert.equal(cat.shells.length, CAT_FIGHT_SHELL_COUNT);
  cat.setDetailLevel(0);
  // 4-shell fight cats keep shells at far LOD (same thin-stack rule as dogs).
  assert.ok(cat.shells.every((s) => s.visible === true), 'cat fight thin stack keeps shells');
  cat.dispose();
  ok('cat fight cast: tortoiseshell + khao-manee (not procedural)');
}

console.log(`\n${passed} passed`);
