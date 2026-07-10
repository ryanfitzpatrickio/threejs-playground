import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import * as THREE from 'three';
import { getBounds, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { CharacterSystem } from '../src/game/systems/CharacterSystem.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const assetPath = path.join(ROOT, 'public/assets/models/player-sunglasses.glb');
const assetStat = await stat(assetPath);
assert.ok(assetStat.size < 5 * 1024 * 1024, 'runtime asset must be below 5 MB');

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
});
const document = await io.read(assetPath);
const assetRoot = document.getRoot();
assert.ok(
  assetRoot.listExtensionsUsed().some((extension) => extension.extensionName === 'KHR_draco_mesh_compression'),
  'runtime asset must use Draco compression',
);
const vertexCount = assetRoot.listMeshes().reduce((total, mesh) => total + mesh.listPrimitives().reduce(
  (meshTotal, primitive) => meshTotal + (primitive.getAttribute('POSITION')?.getCount() ?? 0), 0,
), 0);
assert.ok(vertexCount >= 25000 && vertexCount <= 35000, `vertex count ${vertexCount} must be 25–35k`);
const scene = assetRoot.getDefaultScene() ?? assetRoot.listScenes()[0];
const bounds = getBounds(scene);
assert.ok(Math.abs((bounds.max[0] - bounds.min[0]) - 0.15) < 0.001, 'asset width must be 0.15 m');
for (const texture of assetRoot.listTextures()) {
  const size = texture.getSize();
  assert.ok(size && size[0] <= 1024 && size[1] <= 1024, `texture ${texture.getName()} exceeds 1024²`);
}

function character(modelId = 'player', withHead = true) {
  const root = new THREE.Group();
  if (withHead) {
    const head = new THREE.Bone();
    head.name = 'mixamorigHead';
    root.add(head);
  }
  root.scale.setScalar(0.02);
  root.updateWorldMatrix(true, true);
  return { modelId, animationController: { modelRoot: root } };
}

const makeAccessory = async () => {
  const group = new THREE.Group();
  group.name = 'Player Sunglasses';
  return { group, source: 'test' };
};
const system = new CharacterSystem();
const player = character();
await system.attachSunglasses(player, makeAccessory);
assert.equal(player.sunglasses.group.parent.name, 'mixamorigHead');
assert.equal(player.sunglasses.group.parent.children.filter((child) => child.name === 'Player Sunglasses').length, 1);
assert.ok(Math.abs(player.sunglasses.group.scale.x - 50) < 1e-6, 'inherited 0.02 scale should be cancelled');

const alternate = character('climber');
await system.attachSunglasses(alternate, makeAccessory);
assert.equal(alternate.sunglasses, undefined);

const missingBone = character('player', false);
await system.attachSunglasses(missingBone, makeAccessory);
assert.equal(missingBone.sunglasses, undefined);

const failedLoad = character();
await system.attachSunglasses(failedLoad, async () => { throw new Error('missing'); });
assert.equal(failedLoad.sunglasses, undefined);
console.log(`Player sunglasses asset and attachment checks passed (${vertexCount.toLocaleString()} vertices, ${(assetStat.size / 1048576).toFixed(2)} MB).`);
