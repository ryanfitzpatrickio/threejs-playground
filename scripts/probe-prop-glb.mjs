import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const paths = process.argv.slice(2);
const loader = new GLTFLoader();

function probe(filePath) {
  const buffer = readFileSync(filePath);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return loader.parseAsync(arrayBuffer, '');
}

for (const filePath of paths) {
  console.log('\n========================================');
  console.log('FILE:', filePath);
  probe(filePath).then((gltf) => {
    const root = gltf.scene;
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    console.log('Bounds size:', size.x.toFixed(3), size.y.toFixed(3), size.z.toFixed(3));
    console.log('Bounds min:', box.min.x.toFixed(3), box.min.y.toFixed(3), box.min.z.toFixed(3));
    console.log('Bounds max:', box.max.x.toFixed(3), box.max.y.toFixed(3), box.max.z.toFixed(3));
    console.log('Animations:', gltf.animations?.length ?? 0);

    let meshCount = 0;
    let skinnedCount = 0;
    root.traverse((child) => {
      if (child.isMesh || child.isSkinnedMesh) {
        meshCount += 1;
        if (child.isSkinnedMesh) skinnedCount += 1;
        console.log('  mesh:', child.name, child.isSkinnedMesh ? 'skinned' : 'static',
          'verts:', child.geometry?.attributes?.position?.count ?? 0);
      }
    });
    console.log(`Meshes: ${meshCount} (${skinnedCount} skinned)`);
  }).catch((err) => console.error('ERROR:', err.message));
}
