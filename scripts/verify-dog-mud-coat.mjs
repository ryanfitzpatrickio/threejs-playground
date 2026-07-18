import assert from 'node:assert/strict';
import { createProceduralDog } from '../src/game/characters/dog/createProceduralDog.js';
import { createDogFurUniforms } from '../src/game/characters/dog/dogFurMaterial.js';
import {
  DOG_MUD_FLOP_DROPLETS,
  DOG_MUD_SPLASH_POOL_SIZE,
  DogMudCoatController,
} from '../src/game/runtime/features/dogPark/DogMudCoatController.js';
import {
  MUD_DRY_SRGB,
  MUD_WET_SRGB,
  RALLY_MUD_BODY_LINEAR,
  RALLY_MUD_WET_LINEAR,
  mudLinearFromHex,
} from '../src/game/materials/rallyMudPalette.js';

function makeController(seed = 7) {
  return new DogMudCoatController({ uniforms: createDogFurUniforms(), seed });
}

{
  const coat = makeController();
  coat.depositPawMud({ pawName: 'PawL', intensity: 0.8 });
  const first = coat.snapshot();
  assert.ok(first.lowerCoverage > 0, 'paw deposit coats the lower body');
  assert.ok(first.bodyCoverage > 0 && first.bodyCoverage < first.lowerCoverage,
    'paw deposit adds only sparse belly coverage');
  assert.equal(first.wetness, 1);
  assert.equal(first.phase, 'wet');
  assert.equal(first.particleCount, 2, 'accepted paw stamp emits two droplets');
  assert.equal(first.pawDepositCount, 1);
  for (let index = 0; index < 80; index += 1) {
    coat.depositPawMud({ pawName: 'PawR', intensity: 1 });
  }
  const repeated = coat.snapshot();
  assert.equal(repeated.lowerCoverage, 1, 'running coverage clamps safely');
  assert.equal(repeated.bodyCoverage, 0.38, 'running never becomes a broad full-body coat');
  assert.ok(repeated.particleCount <= DOG_MUD_SPLASH_POOL_SIZE, 'fixed splash pool never grows');
  coat.dispose();
}

{
  const coat = makeController();
  coat.depositFlopMud({ position: { x: 1, y: 0, z: 2 }, headingZ: 1 });
  const flop = coat.snapshot();
  assert.ok(flop.bodyCoverage >= 0.85 && flop.lowerCoverage >= 0.85, 'flop broadly coats dog');
  assert.equal(flop.wetness, 1);
  assert.equal(flop.flopDepositCount, 1);
  assert.equal(flop.burstEventCount, 1, 'one successful flop creates one burst event');
  assert.equal(flop.particleEmissionCount, DOG_MUD_FLOP_DROPLETS);

  coat.update(5.999);
  assert.equal(coat.snapshot().phase, 'wet');
  coat.update(0.001);
  assert.equal(coat.snapshot().phase, 'drying');
  assert.equal(coat.snapshot().dryness, 0);
  coat.update(5);
  assert.ok(Math.abs(coat.snapshot().wetness - 0.5) < 1e-6, 'drying transition is continuous');
  assert.ok(Math.abs(coat.snapshot().dryness - 0.5) < 1e-6);
  coat.update(5);
  assert.equal(coat.snapshot().phase, 'shedding');
  assert.equal(coat.snapshot().dryness, 1);
  const retained = coat.snapshot().bodyCoverage;
  coat.update(2);
  assert.ok(coat.snapshot().bodyCoverage < retained, 'dry crust sheds during final four seconds');
  coat.update(2);
  assert.deepEqual(
    { phase: coat.snapshot().phase, lower: coat.snapshot().lowerCoverage, body: coat.snapshot().bodyCoverage },
    { phase: 'clean', lower: 0, body: 0 },
  );
  coat.dispose();
}

{
  const coat = makeController();
  coat.depositFlopMud();
  coat.update(11);
  const partiallyDry = coat.snapshot();
  assert.ok(partiallyDry.dryness > 0 && partiallyDry.wetness < 1);
  coat.depositPawMud({ pawName: 'HindPawR', intensity: 0.5 });
  const refreshed = coat.snapshot();
  assert.equal(refreshed.wetness, 1, 'new contact refreshes wetness');
  assert.equal(refreshed.dryness, 0);
  assert.ok(refreshed.lowerCoverage >= partiallyDry.lowerCoverage, 'new contact never removes existing coat');
  assert.ok(refreshed.bodyCoverage >= partiallyDry.bodyCoverage);
  coat.dispose();
}

{
  assert.equal(MUD_WET_SRGB, 0x625038);
  assert.equal(MUD_DRY_SRGB, 0x7a5f38);
  assert.deepEqual(RALLY_MUD_WET_LINEAR, mudLinearFromHex(MUD_WET_SRGB));
  assert.deepEqual(RALLY_MUD_BODY_LINEAR, mudLinearFromHex(MUD_DRY_SRGB));
  const dog = createProceduralDog({ breedId: 'beagle', seed: 3, shellCount: 3 });
  const shared = dog.furUniforms;
  assert.equal(dog.bodyMesh.material.userData.dogMudUniforms, shared, 'undercoat owns shared mud uniforms');
  for (const shell of dog.shells) {
    assert.equal(shell.material.userData.dogMudUniforms, shared, 'all shells own the same mud uniforms');
  }
  assert.ok(dog.geometry.getAttribute('restPosition') && dog.geometry.getAttribute('coatZone'),
    'anatomical mud mask reuses existing vertex streams');
  dog.dispose();
}

console.log('verify-dog-mud-coat: lifecycle, deposits, fixed splash pool, palette, and shared uniforms OK');
