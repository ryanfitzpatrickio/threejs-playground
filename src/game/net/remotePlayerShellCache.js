/**
 * Shared player shell template for deathmatch remote puppets (M6 polish).
 *
 * Loads one skinned player once, SkeletonUtils-clones per remote with a private
 * AnimationMixer. Clips are cloned per instance so bindings hit the clone's
 * bones (sharing live template clips leaves remotes in bind-pose).
 *
 * WebGPU: after clone we flatten attributes and ensure `uv` exists so TSL
 * materials cannot explode the render pipeline (missing-uv AttributeNode).
 *
 * Node / failed loads return null → capsule fallback.
 */

import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { createMaraFbxModel } from '../characters/mara/createMaraFbxModel.js';
import { MaraAnimationController } from '../characters/mara/MaraAnimationController.js';
import { getPlayerModelProfile, PLAYER_MODEL_IDS } from '../characters/player/playerModelProfiles.js';
import { applyLeanRoll, resolveSpineAimBones } from '../characters/player/firstPersonRig.js';
import {
  flattenObjectForWebGPU,
  sanitizeWebGPUVertexBuffers,
} from '../geometry/prepareWebGPUGeometry.js';

/**
 * THREE.AnimationClip carries no `isAnimationClip` flag (r185), so duck-type it:
 * a clip is any object exposing a `tracks` array. Guarding on the missing flag
 * silently dropped every clip and left remotes as capsules.
 */
function isAnimationClip(clip) {
  return !!clip && (clip instanceof THREE.AnimationClip || Array.isArray(clip.tracks));
}

/** Baseline states retained as a public compatibility/testing contract. */
export const REMOTE_LOCO_STATES = Object.freeze([
  'idle',
  'jog',
  'sprint',
  'walk',
  'armedIdle',
  'armedJog',
  'armedSprint',
  'armedWalk',
]);

/** @type {Promise<object|null>|null} */
let templatePromise = null;

export function canLoadRemoteShells() {
  return typeof document !== 'undefined' && typeof window !== 'undefined';
}

/**
 * @returns {Promise<object|null>}
 */
export function ensureRemoteShellTemplate() {
  if (!canLoadRemoteShells()) return Promise.resolve(null);
  if (!templatePromise) {
    templatePromise = loadTemplate().catch((err) => {
      console.warn('[RemoteShell] template load failed; remotes stay capsules', err);
      templatePromise = null;
      return null;
    });
  }
  return templatePromise;
}

async function loadTemplate() {
  const profile = getPlayerModelProfile(PLAYER_MODEL_IDS.PLAYER);
  const model = await createMaraFbxModel({
    modelUrl: profile.url,
    modelId: profile.id,
    skeletonSource: profile.skeletonSource,
    standUpright: profile.standUpright === true,
    standUprightAfterNormalize: profile.standUprightAfterNormalize === true,
  });
  const controller = model.animationController;
  if (!controller?.modelRoot || !controller.clips) {
    throw new Error('remote shell template missing controller/clips');
  }
  model.group.visible = false;
  try { controller.mixer?.stopAllAction?.(); } catch { /* ignore */ }

  // The local player streams non-core clips after spawn. Remote instances must
  // wait for that same pack so jumps, reactions, sword actions, gun 8-way,
  // reloads, and traversal states are not silently reduced to locomotion.
  await model.animationsReady;

  // WebGPU-safe attributes on the source graph before any clones.
  flattenObjectForWebGPU(controller.modelRoot);
  sanitizeWebGPUVertexBuffers(controller.modelRoot, { warn: () => {} });

  /** @type {Map<string, THREE.AnimationClip>} */
  const clips = new Map();
  for (const [state, entry] of controller.clips) {
    const clip = entry?.clip ?? entry;
    if (isAnimationClip(clip)) clips.set(state, entry);
  }
  if (clips.size === 0) {
    throw new Error('remote shell template has no usable animation clips');
  }

  return {
    modelRoot: controller.modelRoot,
    clips,
    skeletonSource: controller.skeletonSource || profile.skeletonSource || 'mixamo',
    _retainGroup: model.group,
    _retainController: controller,
  };
}

/**
 * Create a skinned remote instance with the same controller/layer graph used by
 * the local player. The server carries the resolved graph; remotes only replay
 * it and never run their own gameplay animation resolver.
 *
 * @param {object} template
 */
export function createRemoteShellInstance(template) {
  if (!template?.modelRoot) {
    throw new Error('createRemoteShellInstance requires a loaded template');
  }

  let root;
  try {
    root = cloneSkeleton(template.modelRoot);
  } catch (err) {
    throw new Error(`SkeletonUtils.clone failed: ${err?.message || err}`);
  }
  root.name = 'RemoteShellModel';
  root.visible = true;

  // Critical for WebGPU: de-interleave + invent missing uvs before materials run.
  flattenObjectForWebGPU(root);
  sanitizeWebGPUVertexBuffers(root, { warn: () => {} });

  root.traverse((obj) => {
    if (obj.isMesh || obj.isSkinnedMesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
      obj.frustumCulled = true;
      if (obj.material) {
        // Prefer simple standard materials — node/TSL materials from the template
        // often hard-require UV/maps and will cascade GPUValidationErrors.
        if (Array.isArray(obj.material)) {
          obj.material = obj.material.map((m) => simplifyMaterial(m));
        } else {
          obj.material = simplifyMaterial(obj.material);
        }
      }
    }
    if (obj.isSkinnedMesh && obj.skeleton) {
      try {
        obj.skeleton.init?.();
        obj.skeleton.update();
      } catch { /* ignore */ }
    }
  });
  root.updateMatrixWorld(true);

  const mixer = new THREE.AnimationMixer(root);
  const controller = new MaraAnimationController({
    mixer,
    clips: template.clips,
    modelRoot: root,
    skeletonSource: template.skeletonSource,
  });
  if (controller.actions.size === 0) {
    throw new Error('no animation actions bound on remote shell');
  }
  controller.start();
  const spineBones = resolveSpineAimBones(root);
  let lean = 0;

  const applyAnimation = (animation, fallbackState, fade = 0.14) => {
    if (!animation || typeof animation.base !== 'string') {
      controller.clearFootwork();
      controller.setLayered(false);
      controller.setUpperBodyState(null);
      controller.setAttackLegs(null, 0);
      controller.setMirrorX(false);
      controller.play(fallbackState, fade);
      lean = 0;
      return;
    }

    controller.setMirrorX(animation.mirrorX === true);
    controller.setLayered(animation.layered === true);
    controller.play(animation.base, fade);
    controller.setUpperBodyState(animation.layered ? animation.upper : null);
    controller.setAttackLegs(
      animation.layered ? animation.attackLeg : null,
      animation.layered ? animation.attackLegWeight : 0,
    );
    if (animation.footwork && animation.footworkLeg && animation.footworkBody) {
      controller.setFootwork(animation.footworkLeg, animation.footworkBody);
    } else {
      controller.clearFootwork();
    }
    lean = THREE.MathUtils.clamp(Number(animation.lean) || 0, -1, 1);
  };

  // Seed pose.
  const start = controller.hasState('idle') ? 'idle' : controller.actions.keys().next().value;
  controller.play(start, 0);
  try { mixer.update(1 / 60); } catch { /* ignore */ }

  return {
    root,
    mixer,
    controller,
    actions: controller.actions,
    get currentState() { return controller.currentState; },
    hasState(state) { return controller.hasState(state); },
    play(state, fade) { controller.play(state, fade); },
    applyAnimation,
    update(delta) {
      try {
        controller.update(Math.max(0, delta));
        applyLeanRoll(spineBones, lean);
      }
      catch (err) {
        // One bad frame should not take down the render loop.
        if (!this._warnedMixer) {
          this._warnedMixer = true;
          console.warn('[RemoteShell] mixer.update failed', err);
        }
      }
    },
    _warnedMixer: false,
    dispose() {
      try { mixer.stopAllAction(); } catch { /* ignore */ }
      root.traverse((obj) => {
        if (obj.isMesh || obj.isSkinnedMesh) {
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose?.());
          else obj.material?.dispose?.();
        }
      });
    },
    rightHand: root.getObjectByName('mixamorigRightHand')
      || root.getObjectByName('RightHand')
      || null,
  };
}

/** Strip exotic materials down to MeshStandardMaterial for WebGPU safety. */
function simplifyMaterial(mat) {
  if (!mat) {
    return new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.7, metalness: 0.1 });
  }
  // Already a plain standard/basic — clone and keep maps if present.
  if (mat.isMeshStandardMaterial || mat.isMeshPhysicalMaterial || mat.isMeshBasicMaterial) {
    try {
      const c = mat.clone();
      // Drop maps that require exotic attributes if uv is missing — maps without uv
      // are the usual WebGPU AttributeNode crash source.
      return c;
    } catch {
      /* fall through */
    }
  }
  const color = mat.color?.isColor ? mat.color.getHex() : 0x8a8a8a;
  return new THREE.MeshStandardMaterial({
    color,
    roughness: typeof mat.roughness === 'number' ? mat.roughness : 0.72,
    metalness: typeof mat.metalness === 'number' ? mat.metalness : 0.12,
    map: mat.map ?? null,
    normalMap: mat.normalMap ?? null,
    roughnessMap: mat.roughnessMap ?? null,
    metalnessMap: mat.metalnessMap ?? null,
    emissive: mat.emissive?.isColor ? mat.emissive.clone() : new THREE.Color(0x000000),
    emissiveIntensity: mat.emissiveIntensity ?? 0,
    transparent: !!mat.transparent,
    opacity: typeof mat.opacity === 'number' ? mat.opacity : 1,
    side: mat.side ?? THREE.FrontSide,
    skinning: true,
  });
}

/**
 * Map network locomotion labels → Mara clip state names.
 * @param {string} label
 * @param {{ armed?: boolean, speed?: number }} [opts]
 */
export function mapLocomotionToClip(label, { armed = true, speed = 0 } = {}) {
  const raw = String(label || 'idle');
  const L = raw.toLowerCase();
  // 'walk' is a rest-loaded clip; the shell template only ever carries the armed
  // walk, so unarmed walk still routes there via pickAction.
  const walkClip = armed ? 'armedWalk' : 'walk';

  // Airborne is the one thing the pose's velocity can't express — take it from
  // the label only.
  if (L === 'jump' || L === 'fall' || L === 'airborne') {
    if (speed > 3) return armed ? 'armedJog' : 'jog';
    return armed ? 'armedIdle' : 'idle';
  }

  // Otherwise drive the clip from the pose's *own* horizontal speed so the shell
  // animates whenever the remote is actually moving — matching the capsule's
  // velocity-driven bob. The authored label is only a hint (it defaults to 'idle'
  // on the server and can lag), so speed wins to avoid freezing on idle mid-run.
  if (speed > 7 || /sprint/.test(L)) return armed ? 'armedSprint' : 'sprint';
  if (speed > 3.5 || L === 'run' || /run|jog/.test(L)) return armed ? 'armedJog' : 'jog';
  if (speed > 0.4 || L === 'walk') return walkClip;
  return armed ? 'armedIdle' : 'idle';
}
