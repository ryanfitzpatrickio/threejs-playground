#!/usr/bin/env node
/** Gunsmith material schema + imported PBR asset contract. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  GUN_MATERIAL_MODES,
  GUN_PBR_TEXTURE_SETS,
  createDefaultGunAppearance,
  gunMaterialModeUsesTextureSet,
  normalizeGunAppearance,
} from '../src/game/weapons/gunMaterials.js';

assert.deepEqual(
  GUN_MATERIAL_MODES.map((mode) => mode.id),
  ['baked', 'baked_flat', 'flat', 'pbr', 'metal_tsl', 'texture_pbr', 'texture_metal_tsl'],
);
assert.equal(createDefaultGunAppearance('metal').mode, 'pbr');
assert.equal(normalizeGunAppearance({ mode: 'not-real' }).mode, 'pbr');
assert.equal(normalizeGunAppearance({ mode: 'texture_metal_tsl', metalness: 2 }).metalness, 1);
assert.equal(gunMaterialModeUsesTextureSet('texture_pbr'), true);
assert.equal(gunMaterialModeUsesTextureSet('metal_tsl'), false);

for (const set of GUN_PBR_TEXTURE_SETS) {
  for (const map of ['albedo', 'normal', 'roughness', 'ao']) {
    const file = path.resolve('public', set.baseUrl.replace(/^\//, ''), `${map}.png`);
    assert.ok(existsSync(file), `${set.id} missing ${map}`);
  }
}

console.log(`verify-gun-materials: ${GUN_PBR_TEXTURE_SETS.length} PBR sets and material schema OK`);
