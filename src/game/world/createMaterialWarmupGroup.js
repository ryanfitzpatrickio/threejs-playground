import * as THREE from 'three';

/**
 * Build a Mesh + InstancedMesh pair per material for pipeline prewarm batches.
 * Materials are not owned — disposeWarmup only disposes the shared geometry.
 *
 * @param {Iterable<THREE.Material>} materials
 * @param {string} [name]
 */
export function createMaterialWarmupGroup(materials, name = 'Pipeline Warmup') {
  const geometry = new THREE.BoxGeometry(0.01, 0.01, 0.01);
  const group = new THREE.Group();
  group.name = name;
  group.userData.pipelineWarmup = true;
  let index = 0;
  for (const material of materials) {
    if (!material) continue;
    const mesh = new THREE.Mesh(geometry, material);
    const instanced = new THREE.InstancedMesh(geometry, material, 1);
    mesh.name = `${name} Mesh ${index}`;
    instanced.name = `${name} Instanced ${index}`;
    mesh.frustumCulled = false;
    instanced.frustumCulled = false;
    mesh.castShadow = instanced.castShadow = true;
    mesh.receiveShadow = instanced.receiveShadow = true;
    mesh.position.set(0, -10000 - index, 0);
    instanced.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, -10000 - index, 0));
    instanced.instanceMatrix.needsUpdate = true;
    group.add(mesh, instanced);
    index += 1;
  }
  group.userData.disposeWarmup = () => {
    geometry.dispose();
  };
  return group;
}
