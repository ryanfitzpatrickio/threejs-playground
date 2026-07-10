import * as THREE from 'three';
import { flattenObjectForWebGPU } from '../../geometry/prepareWebGPUGeometry.js';
import { createGltfLoader } from '../../utils/createGltfLoader.js';
import { disposeObject3D } from '../../utils/disposeObject3D.js';

export const PLAYER_SUNGLASSES_URL = '/assets/models/player-sunglasses.glb';

// The preparation script bakes the authored model to a centered 0.15 m width.
export async function createPlayerSunglasses() {
  const gltf = await createGltfLoader().loadAsync(PLAYER_SUNGLASSES_URL);
  const model = gltf.scene;
  model.name = 'Player Sunglasses Model';
  flattenObjectForWebGPU(model);

  model.traverse((child) => {
    if (!child.isMesh) return;
    child.castShadow = true;
    child.receiveShadow = true;
  });

  const group = new THREE.Group();
  group.name = 'Player Sunglasses';
  group.add(model);

  return {
    group,
    source: 'glb',
    dispose() {
      disposeObject3D(group);
      group.removeFromParent();
    },
  };
}
