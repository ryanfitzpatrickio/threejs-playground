import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

globalThis.window = { URL: { createObjectURL: () => '' } };
THREE.TextureLoader.prototype.load = function loadStubbedTexture() {
  return new THREE.Texture();
};

const loader = new FBXLoader();

function loadFbx(filePath) {
  const buffer = readFileSync(filePath);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return loader.parse(arrayBuffer, '');
}

function summarize(filePath) {
  console.log('\n========================================');
  console.log('FILE:', filePath);
  try {
    const obj = loadFbx(filePath);

    const bones = [];
    const meshes = [];
    obj.traverse((child) => {
      if (child.isBone) bones.push(child.name);
      if (child.isMesh || child.isSkinnedMesh) {
        meshes.push({
          name: child.name,
          type: child.isSkinnedMesh ? 'SkinnedMesh' : 'Mesh',
          verts: child.geometry?.attributes?.position?.count ?? 0,
          skinned: child.isSkinnedMesh,
          bonesInfluence: child.isSkinnedMesh ? child.skeleton?.bones?.length ?? 0 : 0,
        });
      }
    });

    console.log(`Bones (${bones.length}):`);
    console.log('  ', bones.slice(0, 60).join(', ') || '(none)');
    if (bones.length > 60) console.log(`   ... +${bones.length - 60} more`);
    console.log(`Meshes (${meshes.length}):`);
    for (const m of meshes) console.log('   -', JSON.stringify(m));

    const clips = obj.animations ?? [];
    console.log(`Animations (${clips.length}):`);
    for (const clip of clips) {
      console.log(`   - "${clip.name}" dur=${clip.duration?.toFixed(3)}s tracks=${clip.tracks.length}`);
      const trackBones = new Set();
      for (const t of clip.tracks) trackBones.add(t.name.split('.')[0]);
      console.log(`     track roots sample:`, [...trackBones].slice(0, 10).join(', '));
    }

    // Hips bone check
    const hips = obj.getObjectByName('mixamorigHips') || obj.getObjectByName('Hips') || obj.getObjectByName('mixamorig:Hips');
    console.log('Hips bone present:', hips ? hips.name : 'NOT FOUND (neither mixamorigHips nor Hips)');
  } catch (e) {
    console.log('ERROR loading:', e.message);
  }
}

// Example FBX files used for diagnosis. Update these to your local files
// (e.g. Mixamo downloads or assets-source models) before running.
const targets = [
  // '/path/to/soldier.fbx',
  // '/path/to/Pro Rifle Pack/idle.fbx',
];

for (const t of targets) summarize(t);
