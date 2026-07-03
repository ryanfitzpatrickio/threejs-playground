import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { bakeSkinnedModelGeometry } from './bakeSkinnedModelGeometry.js';
import { flattenObjectForWebGPU } from './prepareWebGPUGeometry.js';

/**
 * Milestone 1/2: prepareBakedCrowdPoses
 *
 * Samples frames from a clip using a temp mixer on a cloned root, then bakes
 * non-skinned posed BufferGeometry by calling bakeSkinnedModelGeometry on the
 * posed temp root (reusing its applyBoneTransform + matrixWorld logic).
 *
 * Returns array of { geometry, duration, sampleTime, name } for use by CrowdSystem
 * InstancedMesh. Skin attrs are stripped since we render static posed (skinning=false).
 *
 * For v1 crowd: standardize on soldier archetype. Uses soldier targetHeight/groundOffset.
 * Clip analysis performed in CrowdSystem.load (enumerates + selects "Idle Alert").
 *
 * Dupe of small normalize + clip prep (incl. root locking) + flatten seq from EnemySystem only for independent
 * v1 bake (no changes to EnemySystem; smallest scope for phases 1+2). Full mixer used for exact pose parity with Enemy create/mixer.
 */

function normalizeToHeightForCrowd(root, targetHeight) {
  // Duplicated from EnemySystem.js: Box3.setFromObject(root, true) for skinned bind-pose.
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root, true);
  const size = box.getSize(new THREE.Vector3());

  if (!Number.isFinite(size.y) || size.y <= 0) {
    return;
  }

  const scale = targetHeight / size.y;
  root.scale.multiplyScalar(scale);
  root.updateMatrixWorld(true);

  const normalizedBox = new THREE.Box3().setFromObject(root, true);
  root.position.y -= normalizedBox.min.y;
}

// Duplicated minimal root-locking from EnemySystem.js (prepareAnimationClips + lockRootTranslation + isRootTranslationTrack)
// so baked posed geometry has root translation removed exactly as for full soldier enemies (at t=0 for idles).
// "Idle Alert" is non-disability so uses full lockRootTranslation (not horizontal).
function lockRootTranslationForCrowd(clip) {
  const filteredTracks = clip.tracks.filter((track) => !isRootTranslationTrackForCrowd(track.name));

  if (filteredTracks.length === clip.tracks.length) {
    return clip;
  }

  const lockedClip = new THREE.AnimationClip(clip.name, clip.duration, filteredTracks);
  lockedClip.blendMode = clip.blendMode;
  lockedClip.userData = { ...(clip.userData ?? {}), rootTranslationLocked: true };
  return lockedClip;
}

function isRootTranslationTrackForCrowd(trackName) {
  const name = trackName.toLowerCase();
  return (
    name === 'root.position' ||
    name === 'hips.position' ||
    name === 'mixamorig:hips.position' ||
    name === 'mixamorighips.position' ||
    name.endsWith('/root.position') ||
    name.endsWith('/hips.position')
  );
}

function prepareAnimationClipsForCrowd(clips) {
  return clips.map((clip) => lockRootTranslationForCrowd(clip));
}

function findClip(clips, name) {
  if (!name) return clips[0] || null;
  const lower = name.toLowerCase();
  return (
    clips.find((c) => c.name === name) ||
    clips.find((c) => c.name.toLowerCase() === lower) ||
    clips[0] ||
    null
  );
}

export function prepareBakedCrowdPoses(root, clips = [], options = {}) {
  const {
    clipName = 'Idle Alert',
    sampleTimes = [0],
    targetHeight = 1.85,
    orientationFixX = -Math.PI / 2,
  } = options;

  if (!root) return [];

  const preparedClips = prepareAnimationClipsForCrowd(clips);
  const chosen = findClip(preparedClips, clipName) || findClip(preparedClips, 'Idle') || preparedClips[0];
  if (!chosen) {
    return [];
  }

  const poses = [];

  for (const sampleTime of sampleTimes) {
    const posedRoot = cloneSkeleton(root);
    posedRoot.updateMatrixWorld(true);

    // Match EnemySystem clone sequence exactly for attribute safety + pose parity.
    posedRoot.traverse((child) => {
      if (child.isSkinnedMesh && child.skeleton) child.skeleton.update();
    });
    flattenObjectForWebGPU(posedRoot);

    // Soldier orientation fix (matches EnemySystem exactly for visual parity).
    if (orientationFixX) {
      posedRoot.rotation.x = orientationFixX;
    }

    normalizeToHeightForCrowd(posedRoot, targetHeight);

    // Pose via temp mixer at sample time (direct, matches Enemy create+mixer usage).
    const mixer = new THREE.AnimationMixer(posedRoot);
    const action = mixer.clipAction(chosen);
    action.reset();
    action.enabled = true;
    action.setEffectiveWeight(1);
    action.play();
    const safeTime = Math.max(0, Math.min(sampleTime || 0, chosen.duration || 0));
    action.time = safeTime;
    mixer.update(0);
    posedRoot.updateMatrixWorld(true);

    // Bake applies bone transforms for current pose + world matrices.
    const baked = bakeSkinnedModelGeometry(posedRoot);
    if (baked?.geometry) {
      const g = baked.geometry;
      // Strip skinning data: crowd InstancedMesh uses static posed geom + skinning=false material.
      if (g.hasAttribute('skinIndex')) g.deleteAttribute('skinIndex');
      if (g.hasAttribute('skinWeight')) g.deleteAttribute('skinWeight');
      g.computeBoundingBox();
      g.computeBoundingSphere();
      poses.push({
        geometry: g,
        duration: chosen.duration || 1,
        sampleTime: safeTime,
        name: chosen.name,
      });
    }
  }

  return poses;
}
