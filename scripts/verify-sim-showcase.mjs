/**
 * Showcase household defaults: three hero Sims + clean wardrobe catalog.
 */
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getShowcasePresets,
  getSimSpawnPresets,
  loadSimPresets,
} from '../src/game/characters/simhuman/simPresetStore.js';
import {
  listSimOutfitOptions,
  resolveSimOutfitAsset,
  SIM_OUTFIT_ALIASES,
} from '../src/game/characters/simhuman/simOutfitCatalog.js';
import { sanitizeSimAppearance } from '../src/game/characters/simhuman/simAppearanceSchema.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const maxBytes = 25 * 1024 * 1024;

const showcase = getShowcasePresets();
assert.equal(showcase.length, 3);
const byId = Object.fromEntries(showcase.map((p) => [p.id, p]));
assert.ok(byId['showcase-base5']);
assert.ok(byId['showcase-female']);
assert.ok(byId['showcase-male']);

assert.equal(byId['showcase-base5'].body, 'human5');
assert.equal(byId['showcase-base5'].outfitId, 'executive-suit');
assert.equal(byId['showcase-base5'].hairStyleId, null);

assert.equal(byId['showcase-female'].body, 'female');
assert.equal(byId['showcase-female'].outfitId, 'rose-sequin-cocktail');
assert.equal(byId['showcase-female'].hairStyleId, 'chestnut-cascade');
assert.equal(byId['showcase-female'].hairColor, '#c8af97');

assert.equal(byId['showcase-male'].body, 'male');
assert.equal(byId['showcase-male'].outfitId, 'charcoal-suit');
assert.equal(byId['showcase-male'].hairStyleId, null);

// Loop cuts / fit tweaks survive sanitize.
const female = sanitizeSimAppearance(byId['showcase-female']);
assert.ok((female.outfitLoopCuts?.length ?? 0) >= 1, 'female loop cuts preserved');
assert.equal(female.outfitLimbReveal.arms, 1.47);
assert.ok(female.armSpace < 0, 'female arm space preserved');

const base5 = sanitizeSimAppearance(byId['showcase-base5']);
assert.ok((base5.outfitLoopCuts?.length ?? 0) >= 1, 'base5 loop cuts preserved');
assert.equal(base5.outfitScale.x, 1.24);

// Spawn order: female + male for a 2-sim lot.
const spawn = getSimSpawnPresets(2);
assert.equal(spawn[0].id, 'showcase-female');
assert.equal(spawn[1].id, 'showcase-male');

const listed = loadSimPresets();
assert.ok(listed.some((p) => p.id === 'showcase-female'));

// Catalog: fantasy + showcase, no Meshy hash ids.
const options = listSimOutfitOptions();
const ids = options.map((o) => o.id).sort();
assert.deepEqual(ids, [
  'charcoal-suit',
  'executive-suit',
  'fantasy-peasant',
  'fantasy-ranger',
  'rose-sequin-cocktail',
].sort());

for (const [legacy, clean] of Object.entries(SIM_OUTFIT_ALIASES)) {
  assert.equal(resolveSimOutfitAsset(legacy, clean === 'rose-sequin-cocktail' ? 'female' : clean === 'executive-suit' ? 'human5' : 'male')?.id, clean);
}

// Assets on disk under clean names.
for (const id of ['charcoal-suit', 'executive-suit', 'rose-sequin-cocktail', 'male-peasant', 'female-ranger']) {
  for (const folder of ['standard', 'morph']) {
    const filePath = path.join(root, 'public/assets/simoutfits', folder, `${id}.glb`);
    assert.ok(existsSync(filePath), `missing ${folder}/${id}.glb`);
    assert.ok(statSync(filePath).size < maxBytes, `${folder}/${id} over 25 MiB`);
  }
}

// Wardrobe re-select must re-apply authored neck/sleeve loop cuts (not only preset snapshot).
const { getSimOutfitAuthoredDefaults } = await import(
  '../src/game/characters/simhuman/simOutfitAuthoredDefaults.js'
);
const cocktail = getSimOutfitAuthoredDefaults('rose-sequin-cocktail');
assert.ok(cocktail?.outfitLoopCuts?.length >= 1, 'cocktail has authored neck loop cut');
assert.ok(
  cocktail.outfitLoopCuts.every((cut) => cut.target !== 'torso' || Number.isFinite(cut.radialReach)),
  'cocktail torso cuts use a finite ring limit so neck cruft can be removed without eating shoulders',
);
assert.equal(cocktail.outfitLimbReveal.arms, 1.47, 'cocktail sleeve limb reveal authored');
const executive = getSimOutfitAuthoredDefaults('executive-suit');
assert.deepEqual(
  executive.outfitLoopCuts.map((c) => c.target).sort(),
  ['leftArm', 'rightArm', 'torso'],
  'executive suit neck + both sleeve loop cuts',
);

console.log('verify-sim-showcase: Base 5 + Showcase Female/Male + wardrobe OK');
