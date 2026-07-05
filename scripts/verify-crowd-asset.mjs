import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import {
  CROWD_ASSET_CLIPS,
  CROWD_CLIP_DEFINITIONS,
  CROWD_MODEL_URL,
  STATIC_CROWD_MODELS,
} from '../src/game/world/spectatorCrowd.js';

const MODEL_PATH = `public${CROWD_MODEL_URL}`;
const MAX_BYTES = 8 * 1024 * 1024;

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule() });

const fileBytes = statSync(MODEL_PATH).size;
assert.ok(fileBytes < MAX_BYTES, `crowd model should stay under ${MAX_BYTES} bytes (got ${fileBytes})`);

const doc = await io.read(MODEL_PATH);
const clipNames = new Set(doc.getRoot().listAnimations().map((a) => a.getName()));

for (const clipName of CROWD_ASSET_CLIPS) {
  assert.ok(
    clipNames.has(clipName),
    `missing source crowd clip "${clipName}"`,
  );
}
for (const definition of CROWD_CLIP_DEFINITIONS) {
  assert.ok(clipNames.has(definition.sourceClip), `runtime clip "${definition.name}" is packaged`);
}

let verts = 0;
for (const mesh of doc.getRoot().listMeshes()) {
  for (const primitive of mesh.listPrimitives()) {
    const pos = primitive.getAttribute('POSITION');
    if (pos) verts += pos.getCount();
  }
}
assert.ok(verts > 0 && verts <= 6000, `vertex count ${verts} should stay crowd-bakeable`);

for (const definition of STATIC_CROWD_MODELS) {
  const staticPath = `public${definition.url}`;
  const staticBytes = statSync(staticPath).size;
  assert.ok(staticBytes < 1024 * 1024, `${definition.name} should stay under 1 MiB`);
  const staticDoc = await io.read(staticPath);
  const root = staticDoc.getRoot();
  assert.equal(root.listMeshes().length, 1, `${definition.name} has one instanced mesh`);
  assert.equal(root.listSkins().length, 0, `${definition.name} stays static`);
  assert.equal(root.listAnimations().length, 0, `${definition.name} has no animation payload`);
  let triangles = 0;
  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute('POSITION');
      triangles += (primitive.getIndices()?.getCount() ?? position?.getCount() ?? 0) / 3;
    }
  }
  assert.ok(triangles > 0 && triangles <= 5500, `${definition.name} triangle count ${triangles}`);
}

console.log(`verify:crowd-asset ok — animated GLB + ${STATIC_CROWD_MODELS.length} static variants`);
