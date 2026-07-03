import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';

const io = await new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.encoder': await draco3d.createEncoderModule(),
    'draco3d.decoder': await draco3d.createDecoderModule(),
  });

const doc = await io.read('public/assets/models/soldier.glb');
const root = doc.getRoot();

console.log('=== ANIMATIONS ===');
for (const anim of root.listAnimations()) {
  const channels = anim.listChannels();
  const roots = new Set(channels.map((c) => c.getTargetNode()?.getName?.() ?? '?'));
  let dur = 0;
  for (const s of anim.listSamplers()) {
    const arr = s.getInput()?.getArray();
    if (arr?.length) dur = Math.max(dur, arr[arr.length - 1]);
  }
  console.log(`  "${anim.getName()}" channels=${channels.length} roots=${roots.size} dur=${dur.toFixed(3)}s`);
}

console.log('\n=== MESHES ===');
let totalVerts = 0;
for (const mesh of root.listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const vc = (prim.getAttribute('POSITION')?.getArray()?.length ?? 0) / 3;
    totalVerts += vc;
    console.log(`  mesh "${mesh.getName()}" verts=${vc} ${prim.getAttribute('JOINTS_0') ? 'skinned' : 'static'}`);
  }
}
console.log(`Total vertices: ${totalVerts}`);

console.log('\n=== SKINS ===');
for (const skin of root.listSkins()) {
  const joints = skin.listJoints().map((j) => j.getName());
  console.log(`  skin "${skin.getName()}" joints=${joints.length} sample: ${joints.slice(0, 6).join(', ')}`);
}

console.log('\n=== MATERIALS ===');
console.log(`  textures: ${root.listTextures().length}`);
for (const mat of root.listMaterials()) {
  console.log(`  "${mat.getName()}" baseColorTex=${mat.getBaseColorTexture() ? 'yes' : 'no'} metallic=${mat.getMetallicFactor()} roughness=${mat.getRoughnessFactor()} alphaMode=${mat.getAlphaMode()}`);
}

const expected = [
  'Idle', 'Walk', 'Run', 'Idle Alert', 'Bite',
  'Head Missing', 'Head Missing 2',
  'Left Arm Missing Walk', 'Right Arm Missing Walk',
  'Left Leg Missing', 'Right Leg Missing',
  'Crawl Forward', 'Crawl Back',
];
const got = root.listAnimations().map((a) => a.getName());
const extra = got.filter((n) => !expected.includes(n));
console.log('\n=== CHECK ===');
console.log('All 5 expected present:', expected.every((n) => got.includes(n)));
console.log('Extra/leaked:', extra.length ? JSON.stringify(extra) : 'none');
