#!/usr/bin/env node
/**
 * M2: round-trip a gun profile through the in-memory fileStore gunsmith collection,
 * re-resolve anchors/parts, assert rifle profiles have required anchors.
 */
import assert from 'node:assert/strict';
import { __seedFileStoreForTests, readEntry, writeEntry, readCollection } from '../src/store/fileStore.js';
import {
  createCatalogStubProfile,
  GUN_CATALOG,
  normalizeProfile,
  validateProfile,
} from '../src/game/weapons/gunProfile.js';
import { REQUIRED_ANCHORS_BY_KIND, validateRequiredAnchors } from '../src/game/weapons/gunAnchors.js';
import {
  getGunsmithProfile,
  listGunsmithProfiles,
  resolveGunProfile,
  saveGunsmithProfile,
  validateStoredProfile,
} from '../src/game/weapons/gunsmithStore.js';

// Seed empty writable-like cache
__seedFileStoreForTests({ gunsmith: {} });

const rifleEntry = GUN_CATALOG.find((g) => g.weaponKind === 'rifle');
const pistolEntry = GUN_CATALOG.find((g) => g.weaponKind === 'pistol');
const shotgunEntry = GUN_CATALOG.find((g) => g.weaponKind === 'shotgun');
assert.ok(rifleEntry && pistolEntry && shotgunEntry);

const meshNames = ['receiver', 'barrel', 'stock', 'magazine', 'grip'];
const stub = createCatalogStubProfile(rifleEntry, meshNames);
stub.parts[0].identity = 'receiver';
stub.parts[0].surfaceClass = 'metal';
stub.parts[0].appearance = {
  mode: 'texture_metal_tsl',
  textureSet: 'weathered-black',
  uvScale: 1.4,
  metalness: 0.92,
  roughness: 0.31,
};
stub.parts[3].identity = 'magazine';
stub.parts[3].behaviors = ['detaches_on_reload'];
stub.anchors = stub.anchors.map((a) => (
  a.name === 'muzzle' ? { ...a, position: [0, 0.05, -0.42] } : a
));
stub.sounds.fire = 'snake-556-single-isolated';
stub.scopeViewport = {
  enabled: true,
  position: [0.012, 0.18, -0.09],
  quaternion: [0, 0, 0, 1],
  scale: [1.1, 0.95, 1],
  radius: 0.031,
  depth: 0.005,
  magnification: 4.5,
  resolution: 512,
  eyeRelief: 0.19,
  viewRotationDeg: -90,
};

const saved = saveGunsmithProfile(stub, { debounce: false });
assert.equal(saved.id, rifleEntry.id);

const loaded = getGunsmithProfile(rifleEntry.id);
assert.ok(loaded);
assert.equal(loaded.anchorSpace, 'weapon');
assert.equal(loaded.parts.length, meshNames.length);
assert.equal(loaded.parts[0].identity, 'receiver');
assert.equal(loaded.parts[0].appearance.mode, 'texture_metal_tsl');
assert.equal(loaded.parts[0].appearance.textureSet, 'weathered-black');
assert.deepEqual(loaded.parts[3].behaviors, ['detaches_on_reload']);
assert.equal(loaded.sounds.fire, 'snake-556-single-isolated');
assert.deepEqual(loaded.scopeViewport.position, [0.012, 0.18, -0.09]);
assert.deepEqual(loaded.scopeViewport.scale, [1.1, 0.95, 1]);
assert.equal(loaded.scopeViewport.radius, 0.031);
assert.equal(loaded.scopeViewport.magnification, 4.5);
assert.equal(loaded.scopeViewport.resolution, 512);
assert.equal(loaded.scopeViewport.eyeRelief, 0.19);
assert.equal(loaded.scopeViewport.viewRotationDeg, -90);

const muzzle = loaded.anchors.find((a) => a.name === 'muzzle');
assert.ok(muzzle);
assert.ok(Math.abs(muzzle.position[2] + 0.42) < 1e-6);

const validation = validateProfile(loaded);
assert.equal(validation.ok, true, validation.errors?.join('; '));

const migratedV4Scope = normalizeProfile({
  ...stub,
  version: 4,
  scopeViewport: { ...stub.scopeViewport, magnification: 4 },
});
assert.equal(migratedV4Scope.scopeViewport.magnification, 8, 'V4 default scope zoom migrates to V5 tactical zoom');

// Required anchors for every kind
for (const entry of [rifleEntry, pistolEntry, shotgunEntry]) {
  const profile = createCatalogStubProfile(entry, ['a', 'b']);
  saveGunsmithProfile(profile, { debounce: false });
  const check = validateStoredProfile(entry.id);
  assert.equal(check.ok, true, `${entry.id}: ${check.errors?.join('; ')}`);
  const req = REQUIRED_ANCHORS_BY_KIND[entry.weaponKind];
  const anchors = validateRequiredAnchors(getGunsmithProfile(entry.id));
  assert.equal(anchors.ok, true, `${entry.id} missing ${anchors.missing}`);
  for (const name of req) {
    assert.ok(
      getGunsmithProfile(entry.id).anchors.some((a) => a.name === name),
      `${entry.id} lacks ${name}`,
    );
  }
}

// resolveGunProfile falls back to stub when missing
assert.equal(getGunsmithProfile('no-such-gun'), null);
const resolved = resolveGunProfile(rifleEntry.id);
assert.equal(resolved.id, rifleEntry.id);

// list
const listed = listGunsmithProfiles();
assert.ok(listed.length >= 3);

// Direct collection round-trip via fileStore primitives
writeEntry('gunsmith', 'hand-written', normalizeProfile({
  id: 'hand-written',
  label: 'Hand Written',
  glbUrl: '/assets/guns/modern-ar15.glb',
  weaponKind: 'rifle',
  anchors: createCatalogStubProfile(rifleEntry).anchors,
  parts: [{ meshName: 'x', identity: 'barrel', surfaceClass: 'metal', behaviors: [] }],
}), { debounce: false });
assert.ok(readEntry('gunsmith', 'hand-written'));
assert.ok(Object.keys(readCollection('gunsmith')).includes('hand-written'));

console.log(`verify-gunsmith-store: ${listed.length} profiles, round-trip OK`);
