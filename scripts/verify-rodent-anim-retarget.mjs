/**
 * verify-rodent-anim-retarget — guards Rat.fbx → dog-bone retarget contracts.
 *
 * Catches the regression where glTF stripped dotted side suffixes
 * (`FrontLeg.L` → `FrontLegL`) and leg tracks were silently dropped, freezing
 * rodent locomotion (house mouse / rat / squirrel all share this pack).
 *
 * Run: node scripts/verify-rodent-anim-retarget.mjs
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DOG_BONE_DEFS } from '../src/game/characters/dog/dogSkeleton.js';
import {
  RAT_TO_DOG_BONE_MAP,
  INTENTIONALLY_UNMAPPED_RAT_BONES,
  mapRatBoneName,
} from '../src/game/characters/dog/ratToDogBoneMap.js';
import { animalClipLibraryKind } from '../src/game/characters/dog/DogClipPlayer.js';

const dogBones = new Set(DOG_BONE_DEFS.map((definition) => definition.name));
for (const [source, target] of Object.entries(RAT_TO_DOG_BONE_MAP)) {
  assert.ok(dogBones.has(target), `${source} maps to missing dog bone ${target}`);
}

// Both dotted and undotted side suffixes must resolve to the same dog bone.
assert.equal(mapRatBoneName('FrontLeg.L'), 'ShoulderL');
assert.equal(mapRatBoneName('FrontLegL'), 'ShoulderL');
assert.equal(mapRatBoneName('BackFoot.R'), 'HindPawR');
assert.equal(mapRatBoneName('BackFootR'), 'HindPawR');

// Clip library routing: muridae / sciuridae / niche rodents use rodent pack.
assert.equal(animalClipLibraryKind({ speciesId: 'muridae' }), 'rodent');
assert.equal(animalClipLibraryKind({ speciesId: 'sciuridae' }), 'rodent');
assert.equal(animalClipLibraryKind({ speciesId: 'cricetidae' }), 'rodent');
assert.equal(animalClipLibraryKind({ speciesId: 'heteromyidae' }), 'rodent');
assert.equal(animalClipLibraryKind({ speciesId: 'bathyergidae' }), 'rodent');
assert.equal(
  animalClipLibraryKind({ conformationFlags: ['rat-clips'] }),
  'rodent',
);
// Equid routing (horse-sourced dog-anims) for all 5 equid-route species.
assert.equal(animalClipLibraryKind({ speciesId: 'equidae' }), 'equid');
assert.equal(animalClipLibraryKind({ speciesId: 'rhinocerotidae' }), 'equid');
assert.equal(animalClipLibraryKind({ speciesId: 'tapiridae' }), 'equid');
assert.equal(animalClipLibraryKind({ speciesId: 'giraffidae' }), 'equid');
assert.equal(animalClipLibraryKind({ speciesId: 'hippopotamidae' }), 'equid');
assert.equal(animalClipLibraryKind({ speciesId: 'canidae' }), 'dog');
assert.equal(animalClipLibraryKind({ breedId: 'domestic-horse' }), 'equid');
assert.equal(animalClipLibraryKind({ breedId: 'brazilian-tapir' }), 'equid');

const manifest = JSON.parse(
  await readFile(resolve('public/assets/rodent-anims/manifest.json'), 'utf8'),
);
assert.equal(manifest.rootTranslationLocked, true);
for (const required of ['Idle', 'Walk', 'Run', 'Jump', 'Attack', 'Death']) {
  assert.ok(manifest.clips.some((clip) => clip.name === required), `manifest missing ${required}`);
}

const walk = JSON.parse(
  await readFile(resolve('public/assets/rodent-anims/walk.json'), 'utf8'),
);
const trackNames = new Set(walk.tracks.map((track) => track.name));
const requiredLegTracks = [
  'ShoulderL.quaternion',
  'UpperArmL.quaternion',
  'ForearmL.quaternion',
  'PawL.quaternion',
  'ShoulderR.quaternion',
  'UpperArmR.quaternion',
  'ForearmR.quaternion',
  'PawR.quaternion',
  'HipL.quaternion',
  'ThighL.quaternion',
  'ShinL.quaternion',
  'HindPawL.quaternion',
  'HipR.quaternion',
  'ThighR.quaternion',
  'ShinR.quaternion',
  'HindPawR.quaternion',
];
for (const name of requiredLegTracks) {
  assert.ok(trackNames.has(name), `Walk clip missing leg track ${name} (retarget bone map likely broken)`);
}

// Legs must actually move — identity/rest tracks mean retarget failed.
function trackMotion(track) {
  const step = track.name.endsWith('.quaternion') ? 4 : 3;
  const values = track.values;
  let max = 0;
  for (let i = step; i < values.length; i += step) {
    let d = 0;
    for (let c = 0; c < step; c += 1) d += Math.abs(values[i + c] - values[c]);
    max = Math.max(max, d);
  }
  return max;
}

const forearmL = walk.tracks.find((track) => track.name === 'ForearmL.quaternion');
const thighL = walk.tracks.find((track) => track.name === 'ThighL.quaternion');
assert.ok(forearmL && trackMotion(forearmL) > 0.15, 'Walk ForearmL must carry real locomotion (not rest)');
assert.ok(thighL && trackMotion(thighL) > 0.05, 'Walk ThighL must carry real locomotion (not rest)');
assert.ok(walk.tracks.length >= 20, `Walk should retarget most limbs (got ${walk.tracks.length} tracks)`);

// Silence unused import warning for intentional-unmapped list (kept for map docs).
assert.ok(INTENTIONALLY_UNMAPPED_RAT_BONES.includes('Tail6'));

console.log(
  `ok — rodent retarget: ${walk.tracks.length} walk tracks, legs mapped (dotted+undotted), motion present`,
);
