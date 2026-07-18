/**
 * Guards hair-cap assets + appearance schema defaults for Character Maker.
 */
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDefaultSimAppearance,
  sanitizeSimAppearance,
} from '../src/game/characters/simhuman/simAppearanceSchema.js';
import {
  DEFAULT_SIM_HAIR_STYLE_ID,
  getSimHairDefinition,
  listSimHairOptions,
  resolveSimHairAsset,
} from '../src/game/characters/simhuman/simHairCatalog.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const maxBytes = 25 * 1024 * 1024;

const options = listSimHairOptions();
assert.ok(options.length >= 1, 'expected at least one hair cap');
assert.equal(DEFAULT_SIM_HAIR_STYLE_ID, 'chestnut-cascade');

for (const entry of options) {
  const asset = resolveSimHairAsset(entry.id);
  assert.ok(asset, `resolve ${entry.id}`);
  const rel = asset.url.replace(/^\//, '');
  const filePath = path.join(root, 'public', rel.replace(/^assets\//, 'assets/'));
  // url is /assets/simhair/... → public/assets/simhair/...
  const publicPath = path.join(root, 'public', asset.url.replace(/^\//, ''));
  assert.ok(existsSync(publicPath), `missing ${publicPath}`);
  const bytes = statSync(publicPath).size;
  assert.ok(bytes > 1024, `${entry.id} too small`);
  assert.ok(bytes < maxBytes, `${entry.id} exceeds 25 MiB (${bytes})`);
}

const def = getSimHairDefinition('chestnut-cascade');
assert.equal(def?.sourceKeepMeshIndex, 6, 'source pack keeps 1-based mesh 7');

const fresh = createDefaultSimAppearance();
assert.equal(fresh.hairStyleId, 'chestnut-cascade');
assert.equal(fresh.hairColor, '#c8af97', 'default hair color matches Showcase Female');
assert.equal(fresh.hairFit.scale, 0.43, 'default hair fit scale matches Showcase Female');
assert.deepEqual(fresh.hairFit.position, { x: 0.005, y: 0.485, z: -0.065 });
assert.deepEqual(fresh.hairFit.rotation, { x: 0, y: 0, z: 0 });

const migrated = sanitizeSimAppearance({ version: 8, name: 'Legacy', morphs: {} });
assert.equal(migrated.hairStyleId, 'chestnut-cascade', 'pre-v9 presets default hair on');
assert.ok(migrated.version >= 9);
assert.equal(migrated.hairFit.scale, 0.43, 'missing hairFit defaults to showcase head fit');

const bald = sanitizeSimAppearance({ ...fresh, hairStyleId: null });
assert.equal(bald.hairStyleId, null, 'explicit null stays bald');

const fit = sanitizeSimAppearance({
  ...fresh,
  hairFit: { scale: 1.4, position: { x: 0.05, y: -0.1, z: 0.02 }, rotation: { y: 25 } },
});
assert.equal(fit.hairFit.scale, 1.4);
assert.equal(fit.hairFit.position.y, -0.1);
assert.equal(fit.hairFit.rotation.y, 25);
assert.equal(fit.hairFit.rotation.x, 0);

// Head-local offsets allow multi-meter authoring (not ±0.75 body-root clamps).
const wide = sanitizeSimAppearance({
  ...fresh,
  hairFit: { position: { x: 1.8, y: -2, z: 1.2 } },
});
assert.equal(wide.hairFit.position.x, 1.8);
assert.equal(wide.hairFit.position.y, -2);

console.log(`verify-sim-hair: OK (${options.length} styles, default=${DEFAULT_SIM_HAIR_STYLE_ID})`);
