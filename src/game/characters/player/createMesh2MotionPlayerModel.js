import * as THREE from 'three';
import { MaraAnimationController, prepareClip } from '../mara/MaraAnimationController.js';
import {
  collectBindRotations,
  collectTargetNames,
  normalizeCharacterObject,
  prepareRenderable,
} from '../mara/createMaraFbxModel.js';
import { flattenObjectForWebGPU } from '../../geometry/prepareWebGPUGeometry.js';
import { createGltfLoader } from '../../utils/createGltfLoader.js';
import {
  getSourceSkeleton,
  listSourceAnimationActions,
  resolveSourceAnimation,
} from './sourceSkeletons.js';

export async function createMesh2MotionPlayerModel(profile) {
  const skeleton = getSourceSkeleton(profile.skeletonSource);
  const gltf = await createGltfLoader().loadAsync(encodeURI(profile.url));
  const object = gltf.scene;

  if (!object) {
    throw new Error(`Player model has no glTF scene: ${profile.url}`);
  }

  object.name = `${profile.label} GLB`;
  object.updateMatrixWorld(true);
  object.traverse(prepareRenderable);
  flattenObjectForWebGPU(object);

  const rootBindPosition = object.getObjectByName(skeleton.bones.hips)?.position.clone()
    ?? new THREE.Vector3();
  const targetBindRotations = collectBindRotations(object);
  const targetNames = collectTargetNames(object);
  normalizeCharacterObject(object);

  object.updateMatrixWorld(true);
  object.traverse((child) => {
    if (child.isSkinnedMesh && child.skeleton) {
      child.skeleton.update();
    }
  });

  const clipsByName = new Map((gltf.animations ?? []).map((clip) => [clip.name, clip]));
  const clips = new Map();

  for (const action of listSourceAnimationActions(profile.skeletonSource)) {
    const route = resolveSourceAnimation(profile.skeletonSource, action);
    const sourceClip = clipsByName.get(route?.clip);
    if (!route || !sourceClip) {
      console.warn(`[player] Missing ${profile.skeletonSource} clip for ${action}: ${route?.clip ?? 'unmapped'}`);
      continue;
    }

    clips.set(action, {
      clip: prepareClip({
        clip: sourceClip,
        state: action,
        rootBindPosition,
        sourceBindRotations: targetBindRotations,
        targetBindRotations,
        targetNames,
        retargetQuaternionTracks: false,
        rootPosition: route.rootPosition,
      }),
      loop: route.loop,
      fadeIn: route.fadeIn,
      timeScale: route.timeScale,
      reversed: route.reversed === true,
      transitions: route.transitions,
    });
  }

  if (!clips.has('idle')) {
    throw new Error(`${profile.label} has no mapped idle animation`);
  }

  const group = new THREE.Group();
  group.name = profile.label;
  group.add(object);

  const mixer = new THREE.AnimationMixer(object);
  const animationController = new MaraAnimationController({
    mixer,
    clips,
    modelRoot: object,
    skeletonSource: profile.skeletonSource,
  });
  animationController.start();

  return {
    group,
    velocity: new THREE.Vector3(),
    animationController,
    source: 'glb',
    modelId: profile.id,
    skeletonSource: profile.skeletonSource,
  };
}

