#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  GUN_SOUND_INTERACTIONS,
  GUN_SOUND_LIBRARY,
  WEAPON_PRESENTATION_SOUND_LIBRARY,
  defaultGunSoundAssignments,
  getGunSound,
  getGunSoundsForInteraction,
  getWeaponPresentationSound,
  getWeaponPresentationSoundVariants,
  normalizeGunSoundAssignments,
} from '../src/game/weapons/gunSoundLibrary.js';
import { createCatalogStubProfile, GUN_CATALOG, normalizeProfile } from '../src/game/weapons/gunProfile.js';

const ids = new Set();
for (const sound of GUN_SOUND_LIBRARY) {
  assert.ok(!ids.has(sound.id), `duplicate sound id: ${sound.id}`);
  ids.add(sound.id);
  assert.match(sound.url, /^\/assets\/audio\/weapons\/(rifles|pistols|shotguns|feedback)\//);
  assert.ok(
    sound.source?.includes("Snake's") || sound.source?.includes('Dreamfall shooting-feedback'),
    `missing source attribution for ${sound.id}`,
  );
  assert.ok(
    existsSync(path.join(process.cwd(), 'public', sound.url.slice(1))),
    `missing sound asset: ${sound.url}`,
  );
}

for (const sound of WEAPON_PRESENTATION_SOUND_LIBRARY) {
  assert.match(sound.url, /^\/assets\/audio\/weapons\/feedback\//);
  assert.ok(getWeaponPresentationSound(sound.id), `unknown presentation sound: ${sound.id}`);
  assert.ok(
    existsSync(path.join(process.cwd(), 'public', sound.url.slice(1))),
    `missing presentation sound asset: ${sound.url}`,
  );
}
for (const kind of ['metal', 'concrete', 'marble', 'wood', 'glass']) {
  assert.ok(getWeaponPresentationSoundVariants(kind).length >= 3, `${kind} needs randomized variants`);
}
assert.equal(getWeaponPresentationSoundVariants('soil').length, 1);
assert.equal(getWeaponPresentationSoundVariants('flesh').length, 10);

for (const interaction of GUN_SOUND_INTERACTIONS) {
  if (interaction.id !== 'dryFire') {
    assert.ok(getGunSoundsForInteraction(interaction.id).length > 0, `${interaction.id} has no choices`);
  }
}

for (const entry of GUN_CATALOG) {
  const defaults = defaultGunSoundAssignments(entry.id);
  for (const interaction of ['fire', 'reloadStart', 'reloadComplete']) {
    assert.ok(defaults[interaction], `${entry.id} is missing ${interaction}`);
    assert.ok(getGunSound(defaults[interaction]), `${entry.id} has an unknown ${interaction}`);
  }
}

const desertDefaults = defaultGunSoundAssignments('desert-ar15');
assert.equal(desertDefaults.fire, 'feedback-rifle-02');
assert.equal(desertDefaults.reloadStart, 'snake-ar-reload-full');
assert.equal(desertDefaults.reloadComplete, 'snake-ar-bolt-release');
const shotgunDefaults = defaultGunSoundAssignments('tactical-shotgun');
assert.equal(shotgunDefaults.pump, 'snake-pump-cycle');
assert.ok(getGunSoundsForInteraction('pump').some((sound) => sound.id === 'snake-pump-cycle'));

const desertEntry = GUN_CATALOG.find((entry) => entry.id === 'desert-ar15');
const desertProfile = createCatalogStubProfile(desertEntry);
assert.deepEqual(desertProfile.sounds, desertDefaults);

const customized = normalizeProfile({
  ...desertProfile,
  sounds: {
    ...desertProfile.sounds,
    fire: 'snake-556-single-isolated',
    reloadComplete: 'snake-ar-bolt-release',
  },
});
assert.equal(customized.sounds.fire, 'snake-556-single-isolated');
assert.equal(customized.sounds.reloadComplete, 'snake-ar-bolt-release');

const shotgunEntry = GUN_CATALOG.find((entry) => entry.id === 'tactical-shotgun');
const shotgunProfile = createCatalogStubProfile(shotgunEntry);
assert.equal(shotgunProfile.sounds.pump, 'snake-pump-cycle');

const explicitlyDisabled = normalizeGunSoundAssignments({ fire: '' }, 'desert-ar15');
assert.equal(explicitlyDisabled.fire, '');
const unknown = normalizeGunSoundAssignments({ fire: 'not-in-library' }, 'desert-ar15');
assert.equal(unknown.fire, '');
const incompatible = normalizeGunSoundAssignments({ fire: 'snake-ar-bolt-release' }, 'desert-ar15');
assert.equal(incompatible.fire, '');

console.log(`verify-gun-sounds: ${GUN_SOUND_LIBRARY.length} gun sounds + ${WEAPON_PRESENTATION_SOUND_LIBRARY.length} presentation variants OK`);
