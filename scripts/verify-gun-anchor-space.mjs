#!/usr/bin/env node
/** Legacy Gunsmith source-space anchors must land on the runtime weapon visual. */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  orientGunMeshToWeaponSpace,
  transformGunAnchorsToWeaponSpace,
} from '../src/game/weapons/gunHandSocket.js';
import { createCatalogStubProfile, normalizeProfile, GUN_CATALOG } from '../src/game/weapons/gunProfile.js';

const root = new THREE.Group();
root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 0.18, 0.12), new THREE.MeshBasicMaterial()));
const sourceMuzzle = { name: 'muzzle', position: [-0.48, 0.03, 0], quaternion: [0, 0, 0, 1] };
const weaponSpace = orientGunMeshToWeaponSpace(root);
const expected = new THREE.Vector3().fromArray(sourceMuzzle.position)
  .applyMatrix4(weaponSpace.anchorTransform);
const migrated = transformGunAnchorsToWeaponSpace([sourceMuzzle], weaponSpace.anchorTransform)[0];
assert.ok(new THREE.Vector3().fromArray(migrated.position).distanceTo(expected) < 1e-6);

const stub = createCatalogStubProfile(GUN_CATALOG[0]);
assert.equal(stub.anchorSpace, 'weapon');
const legacy = normalizeProfile({ ...stub, version: 2, anchorSpace: undefined });
assert.equal(legacy.anchorSpace, 'source');

console.log('verify-gun-anchor-space: source anchors migrate into runtime weapon space');
