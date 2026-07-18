import assert from 'node:assert/strict';
import { readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  registerSimOutfitImport,
  registerSimOutfitPromoted,
  resolveSimOutfitAsset,
} from '../src/game/characters/simhuman/simOutfitCatalog.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetDir = path.join(root, 'public/assets/simoutfits');
const maxBytes = 25 * 1024 * 1024;
/** Fantasy packs: strict UBC 65-bone + essential morph contract. */
const fantasyAssets = [
  'female-peasant',
  'female-ranger',
  'male-peasant',
  'male-ranger',
];
/** Showcase wardrobe: exist + size + skins; joint counts vary by body. */
const showcaseAssets = [
  { id: 'charcoal-suit', joints: 65 },
  { id: 'rose-sequin-cocktail', joints: 65 },
  { id: 'executive-suit', joints: 164 }, // human5 DEF skeleton
];
const REQUIRED_MORPHS = [
  'id.body.global.mass.neg',
  'id.body.global.mass.pos',
  'id.body.global.muscle.neg',
  'id.body.global.muscle.pos',
  'id.body.global.fat.pos',
];
// Face morphs must never be baked into outfits.
const FORBIDDEN_PREFIXES = ['id.head.', 'id.skull.', 'id.nose.', 'id.mouth.'];

function assertPair(id, { joints = 65, requireEssentialMorphs = true } = {}) {
  const standardPath = path.join(assetDir, 'standard', `${id}.glb`);
  const morphPath = path.join(assetDir, 'morph', `${id}.glb`);
  assert.ok(existsSync(standardPath), `missing standard/${id}.glb`);
  assert.ok(existsSync(morphPath), `missing morph/${id}.glb`);

  for (const [label, filePath, expectMorphs] of [
    ['standard', standardPath, false],
    ['morph', morphPath, true],
  ]) {
    const bytes = statSync(filePath).size;
    assert.ok(bytes < maxBytes, `${label}/${id} exceeds 25 MiB (${bytes})`);
    const gltf = parseGlb(filePath);
    assert.equal(gltf.skins?.length, 1, `${label}/${id} should contain one shared skin`);
    assert.equal(
      gltf.skins[0].joints.length,
      joints,
      `${label}/${id} should retain the ${joints}-bone skeleton`,
    );
    assert.ok((gltf.materials?.length ?? 0) > 0, `${label}/${id} should retain materials`);
    assert.ok((gltf.images?.length ?? 0) > 0, `${label}/${id} should embed textures`);

    const morphNames = collectMorphNames(gltf);
    if (expectMorphs) {
      if (requireEssentialMorphs) {
        for (const name of REQUIRED_MORPHS) {
          assert.ok(morphNames.has(name), `${label}/${id} missing essential morph ${name}`);
        }
        assert.equal(
          morphNames.size,
          REQUIRED_MORPHS.length,
          `${label}/${id} should keep only the ${REQUIRED_MORPHS.length} essential morphs, got ${[...morphNames].join(', ')}`,
        );
      } else {
        assert.ok(morphNames.size > 0, `${label}/${id} morph variant should carry shape keys`);
      }
      for (const name of morphNames) {
        for (const prefix of FORBIDDEN_PREFIXES) {
          assert.ok(!name.startsWith(prefix), `${label}/${id} must not bake face morph ${name}`);
        }
      }
    } else {
      assert.equal(morphNames.size, 0, `${label}/${id} must have zero morph targets (Standard)`);
    }
  }

  const stdSize = statSync(standardPath).size;
  const morphSize = statSync(morphPath).size;
  assert.ok(
    morphSize >= stdSize * 0.9,
    `${id}: morph (${morphSize}) unexpectedly much smaller than standard (${stdSize})`,
  );
}

for (const id of fantasyAssets) {
  assertPair(id, { joints: 65, requireEssentialMorphs: true });
}
for (const entry of showcaseAssets) {
  assertPair(entry.id, { joints: entry.joints, requireEssentialMorphs: true });
}

// Catalog resolve smoke for showcase bodies.
assert.equal(
  resolveSimOutfitAsset('rose-sequin-cocktail', 'female', { variant: 'morph' })?.url.includes('rose-sequin-cocktail'),
  true,
);
assert.equal(
  resolveSimOutfitAsset('charcoal-suit', 'male', { variant: 'standard' })?.url.includes('charcoal-suit'),
  true,
);
assert.equal(
  resolveSimOutfitAsset('executive-suit', 'human5', { variant: 'morph' })?.url.includes('executive-suit'),
  true,
);
// Legacy id alias.
assert.equal(
  resolveSimOutfitAsset('test', 'male', { variant: 'morph' })?.id,
  'charcoal-suit',
);

const license = readFileSync(path.join(assetDir, 'LICENSE.txt'), 'utf8');
assert.match(license, /CC0 1\.0 Universal/i, 'outfit license must remain documented as CC0');
assert.match(readFileSync(path.join(assetDir, 'SOURCE.md'), 'utf8'), /Quaternius|Standard|Morph/i);

// A newly baked Base draft must remain wearable when the same logical id has
// already been promoted for Male. Import Studio commonly reuses the source
// filename as its id, so this collision is a real authoring path rather than
// malformed input.
registerSimOutfitPromoted({
  id: 'verify-cross-body-import',
  name: 'Promoted Male',
  bodies: {
    male: {
      standard: '/verify/promoted-male.glb',
      morph: '/verify/promoted-male-morph.glb',
    },
  },
});
registerSimOutfitImport({
  id: 'verify-cross-body-import',
  name: 'Fresh Base Draft',
  bodies: {
    human5: {
      standard: '/verify/draft-human5.glb',
      morph: '/verify/draft-human5.glb',
    },
  },
});
assert.equal(
  resolveSimOutfitAsset('verify-cross-body-import', 'male', { variant: 'standard' })?.url,
  '/verify/promoted-male.glb',
  'cross-body draft keeps the existing promoted Male asset',
);
assert.equal(
  resolveSimOutfitAsset('verify-cross-body-import', 'human5', { variant: 'standard' })?.url,
  '/verify/draft-human5.glb',
  'fresh Base draft remains wearable beside an older Male promotion',
);

console.log('verify-sim-outfits: standard+morph variants, 5 essential morphs, skins, deploy caps OK');

function parseGlb(filePath) {
  const buffer = readFileSync(filePath);
  assert.equal(buffer.subarray(0, 4).toString('ascii'), 'glTF', `${path.basename(filePath)} magic`);
  const jsonLength = buffer.readUInt32LE(12);
  assert.equal(buffer.readUInt32LE(16), 0x4e4f534a, `${path.basename(filePath)} JSON chunk`);
  return JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));
}

function collectMorphNames(gltf) {
  const names = new Set();
  for (const mesh of gltf.meshes ?? []) {
    const extras = mesh.extras ?? {};
    for (const name of extras.targetNames ?? []) names.add(name);
    for (const prim of mesh.primitives ?? []) {
      const targets = prim.targets ?? [];
      if (targets.length && !(extras.targetNames?.length)) {
        names.add(`__unnamed_${targets.length}`);
      }
    }
  }
  return names;
}
