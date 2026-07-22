/**
 * Guards dog-park golden-retriever ↔ grey-squirrel chase: breeds, gap band,
 * and speed scales that keep a near-miss forever.
 *
 * Run: node scripts/verify-dog-park-chase.mjs
 */
import assert from 'node:assert/strict';
import {
  CHASE_DOG_BREED,
  CHASE_SQUIRREL_BREED,
  CHASE_PAIR_COUNT,
  chaseSpeedScales,
} from '../src/game/runtime/features/dogPark/DogParkChasePair.js';
import {
  MAX_NPC_DOGS,
  NPC_SHELL_COUNT,
} from '../src/game/runtime/features/dogPark/DogParkNpcSystem.js';
import { getDogBreed } from '../src/game/characters/dog/dogCatalog.js';
import { createProceduralDog } from '../src/game/characters/dog/createProceduralDog.js';

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`  ✓ ${name}`);
};

{
  assert.equal(CHASE_DOG_BREED, 'golden-retriever');
  assert.equal(CHASE_SQUIRREL_BREED, 'grey-squirrel');
  assert.equal(CHASE_PAIR_COUNT, 2);
  assert.ok(getDogBreed(CHASE_DOG_BREED)?.authored);
  assert.ok(getDogBreed(CHASE_SQUIRREL_BREED)?.authored);
  ok('chase cast breeds authored in catalog');
}

{
  // Close: leader faster than pursuer so gap opens.
  const close = chaseSpeedScales(1.4);
  assert.ok(close.leader > close.pursuer, 'near: squirrel outruns dog');
  // Far: pursuer faster so it closes the gap.
  const far = chaseSpeedScales(9);
  assert.ok(far.pursuer > far.leader, 'far: dog closes in');
  // Comfort: both near parity, leader still slightly ahead.
  const mid = chaseSpeedScales(2.7);
  assert.ok(mid.leader >= mid.pursuer * 0.95);
  ok('chaseSpeedScales near/far/comfort band');
}

{
  // Simulate 1D pursuit for 20s at 60Hz with hard min gap.
  // Matches DogParkChasePair base speeds (squirrel leader / golden pursuer).
  const minGap = 1.4;
  const comfortGap = 2.15;
  let dist = 5.5;
  const baseLeader = 3.25;
  const basePursuer = 3.45;
  const dt = 1 / 60;
  let minSeen = Infinity;
  let maxSeen = 0;
  for (let i = 0; i < 60 * 20; i += 1) {
    const scales = chaseSpeedScales(dist, { minGap, comfortGap });
    // Optimal: squirrel always flees +x, dog always pursues +x along the line.
    dist += (scales.leader * baseLeader - scales.pursuer * basePursuer) * dt;
    if (dist < minGap) dist = minGap;
    minSeen = Math.min(minSeen, dist);
    maxSeen = Math.max(maxSeen, dist);
  }
  assert.ok(minSeen >= minGap - 1e-6, `never collapsed below minGap (${minSeen})`);
  assert.ok(minSeen <= comfortGap + 0.05, `gets close (minSeen=${minSeen})`);
  assert.ok(maxSeen > minSeen + 0.35, `gap breathes (min=${minSeen} max=${maxSeen})`);
  ok(`1D near-miss sim min=${minSeen.toFixed(2)} max=${maxSeen.toFixed(2)}`);
}

{
  const dog = createProceduralDog({
    breedId: CHASE_DOG_BREED,
    seed: 3,
    shellCount: NPC_SHELL_COUNT,
    budget: 'npc',
  });
  const squirrel = createProceduralDog({
    breedId: CHASE_SQUIRREL_BREED,
    seed: 5,
    shellCount: NPC_SHELL_COUNT,
    budget: 'npc',
  });
  assert.equal(dog.breedId, CHASE_DOG_BREED);
  assert.equal(squirrel.breedId, CHASE_SQUIRREL_BREED);
  // Squirrel is smaller than the retriever.
  assert.ok(
    (squirrel.phenotype?.skeleton?.scale ?? 1) < (dog.phenotype?.skeleton?.scale ?? 1),
    'squirrel smaller than golden',
  );
  dog.dispose();
  squirrel.dispose();
  ok('procedural golden + grey squirrel spawn');
}

{
  // Ambient pack removed — chase pair is the only always-on dog/squirrel cast.
  assert.equal(MAX_NPC_DOGS, 0, 'no ambient random dogs');
  const total = MAX_NPC_DOGS + CHASE_PAIR_COUNT;
  const worstSkinned = total * (1 + NPC_SHELL_COUNT);
  assert.equal(total, CHASE_PAIR_COUNT);
  assert.ok(worstSkinned <= 12, `chase body+shell draws ${worstSkinned}`);
  ok(`budget ambient ${MAX_NPC_DOGS} + chase ${CHASE_PAIR_COUNT} → ${worstSkinned} draws`);
}

console.log(`\n${passed} passed`);
