/**
 * Legacy authored bird character (shared bird-rigged.glb + procedural loft mesh).
 *
 * Studio / Dog Park no longer use this path — all birds are varieties of the
 * procedural Canada-goose body (`createProceduralGoose` + `birdVarietyProfile`).
 * Kept for verify-birds tooling, proportion experiments, and offline probes.
 *
 * Reference GLBs (e.g. canada goose export) are **measurement oracles only**
 * (`birdProportionProfile.js`). We never display their triangle mesh.
 *
 * Returns a handle duck-typed for DogSimScene.
 */

import * as THREE from 'three';
import { clone as cloneSkinnedHierarchy } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { createGltfLoader } from '../../utils/createGltfLoader.js';
import {
  getDogBreed,
  getDogFamily,
  normalizeDogBreedId,
  normalizeDogVariantId,
} from './dogCatalog.js';
import { normalizeDogSeed } from './dogPhenotypes.js';
import {
  buildBirdBodyGeometry,
  remapBirdSkinIndices,
} from './buildBirdBodyGeometry.js';
import { createBirdPlumageMaterial } from './birdPlumageMaterial.js';
import { createGoosePlumageMaterial } from './birdGooseMaterial.js';
import { CANADA_GOOSE_PALETTE } from './birdProportionProfile.js';

/** Shared skeleton + clip pack for all birds (procedural mesh on top). */
export const BIRD_MODEL_URL = '/assets/models/bird-rigged.glb';

/**
 * All birds share one rig GLB. Per-breed silhouette comes from shape knobs +
 * body-plan profiles (see birdProportionProfile / buildBirdBodyGeometry).
 * @param {string} [_breedId]
 * @returns {string}
 */
export function birdModelUrlForBreed(_breedId) {
  return BIRD_MODEL_URL;
}

/** Embedded clips from bird-rigged.glb. */
export const BIRD_CLIP_CATALOG = Object.freeze([
  { name: 'Idle', label: 'Idle', loop: true, behavior: 'idle' },
  { name: 'Walk', label: 'Walk', loop: true, behavior: 'walk' },
  { name: 'Flap', label: 'Flap', loop: true, behavior: 'trot' },
  { name: 'Glide', label: 'Glide', loop: true, behavior: 'look' },
  { name: 'Rest Pose', label: 'Rest Pose', loop: true, behavior: 'sit' },
]);

/**
 * Per-breed presentation: overall scale, plumage colors, and shape knobs for
 * the procedural mesh (bodyFat / wingChord / beakLen / …).
 * `sheen` drives iridescence on accent/wing zones (0–1).
 */
export const BIRD_BREED_PRESENTATION = Object.freeze({
  // Passerine — compact, plump, short neck, folded wings, longish tail (ref boards)
  'eastern-phoebe': {
    scale: 0.42,
    color: 0x6b6e66,
    belly: 0xe8e4d4,
    accent: 0x3a3c38,
    beakColor: 0x1a1814,
    legColor: 0x1a1814,
    sheen: 0.04,
    bodyPlan: 'passerine',
    beakStyle: 'point',
    footStyle: 'perch',
    bodyFat: 1.0,
    wingChord: 0.95,
    beakLen: 0.9,
    legThick: 0.85,
    tailSpread: 1.15,
    neckThick: 0.85,
    breast: 1.12,
    headSize: 1.02,
    eyeSize: 1.15,
    label: 'Eastern Phoebe',
  },
  'blue-gray-tanager': {
    scale: 0.44,
    color: 0x7a9bb5,
    belly: 0xc0d0dc,
    accent: 0x4a6a82,
    beakColor: 0x1e1c18,
    legColor: 0x3a3430,
    sheen: 0.1,
    bodyPlan: 'passerine',
    beakStyle: 'cone',
    footStyle: 'perch',
    bodyFat: 1.08,
    wingChord: 1.0,
    beakLen: 0.8,
    legThick: 0.9,
    tailSpread: 0.95,
    neckThick: 0.9,
    breast: 1.1,
    headSize: 1.0,
    eyeSize: 1.05,
    label: 'Blue-gray Tanager',
  },
  'ruby-throated-hummingbird': {
    scale: 0.22,
    color: 0x3d8f5a,
    belly: 0xd0e4c0,
    accent: 0xc42828,
    beakColor: 0x1a1a18,
    legColor: 0x2a2820,
    sheen: 0.55,
    bodyPlan: 'hummingbird',
    beakStyle: 'needle',
    footStyle: 'perch',
    bodyFat: 0.78,
    wingChord: 1.45,
    beakLen: 1.75,
    legThick: 0.6,
    tailSpread: 0.7,
    neckThick: 0.7,
    breast: 0.9,
    headSize: 1.2,
    eyeSize: 1.25,
    label: 'Ruby-throated Hummingbird',
  },
  'rock-pigeon': {
    scale: 0.58,
    color: 0x6a7080,
    belly: 0x9aa0ac,
    accent: 0x5a3a6a,
    beakColor: 0xc8c0b0,
    legColor: 0xc45a4a,
    sheen: 0.35,
    bodyPlan: 'pigeon',
    beakStyle: 'cone',
    footStyle: 'perch',
    bodyFat: 1.3,
    wingChord: 1.15,
    beakLen: 0.65,
    legThick: 1.15,
    tailSpread: 0.95,
    neckThick: 1.15,
    breast: 1.35,
    headSize: 0.92,
    eyeSize: 1.0,
    label: 'Rock Pigeon',
  },
  'european-robin': {
    scale: 0.36,
    color: 0x6a5840,
    belly: 0xf07838,
    accent: 0xe86830,
    beakColor: 0x1a1814,
    legColor: 0x5a3a28,
    sheen: 0.06,
    bodyPlan: 'passerine',
    beakStyle: 'point',
    footStyle: 'perch',
    // Photo: very round, short stubby tail, huge orange breast/face, large eye
    bodyFat: 1.28,
    wingChord: 0.9,
    beakLen: 0.62,
    legThick: 0.82,
    tailSpread: 0.55,
    neckThick: 0.75,
    breast: 1.38,
    headSize: 1.1,
    eyeSize: 1.3,
    label: 'European Robin',
  },
  'rufous-hornero': {
    scale: 0.46,
    color: 0xb56a3a,
    belly: 0xd4a070,
    accent: 0x6a3a18,
    beakColor: 0x3a3020,
    legColor: 0x4a4030,
    sheen: 0.04,
    bodyPlan: 'passerine',
    beakStyle: 'point',
    footStyle: 'perch',
    bodyFat: 1.12,
    wingChord: 0.9,
    beakLen: 1.15,
    legThick: 1.05,
    tailSpread: 0.95,
    neckThick: 0.95,
    breast: 1.15,
    headSize: 1.0,
    eyeSize: 1.05,
    label: 'Rufous Hornero',
  },
  'red-tailed-hawk': {
    scale: 1.0,
    color: 0x8a5a3a,
    belly: 0xd4c4a0,
    accent: 0xc04020,
    beakColor: 0xc8a020,
    legColor: 0xc8a040,
    sheen: 0.08,
    bodyPlan: 'raptor',
    beakStyle: 'hook',
    footStyle: 'talon',
    bodyFat: 1.08,
    wingChord: 1.4,
    beakLen: 1.15,
    legThick: 1.35,
    tailSpread: 1.15,
    neckThick: 0.95,
    breast: 1.15,
    headSize: 1.08,
    eyeSize: 1.2,
    label: 'Red-tailed Hawk',
  },
  'house-finch': {
    scale: 0.34,
    color: 0x8a6a5a,
    belly: 0xe8d8c8,
    accent: 0xc43838,
    beakColor: 0x3a2820,
    legColor: 0x4a3a28,
    sheen: 0.05,
    bodyPlan: 'passerine',
    beakStyle: 'cone',
    footStyle: 'perch',
    bodyFat: 1.0,
    wingChord: 0.9,
    beakLen: 0.85,
    legThick: 0.85,
    tailSpread: 0.9,
    neckThick: 0.88,
    breast: 1.08,
    headSize: 1.0,
    eyeSize: 1.1,
    label: 'House Finch',
  },
  mallard: {
    scale: 0.78,
    color: 0x5a6a58,
    belly: 0xc8b070,
    accent: 0x1a6b3a,
    beakColor: 0xd4b020,
    legColor: 0xc86830,
    sheen: 0.22,
    bodyPlan: 'waterfowl',
    beakStyle: 'flat',
    footStyle: 'web',
    bodyFat: 1.45,
    wingChord: 1.15,
    beakLen: 1.35,
    legThick: 1.15,
    tailSpread: 0.65,
    neckThick: 1.3,
    breast: 1.4,
    headSize: 1.0,
    eyeSize: 0.9,
    label: 'Mallard',
  },
  'canada-goose': {
    // Procedural waterfowl kit tuned to photo boards + envelope oracle.
    // Black S-neck, white chinstrap, cream breast, barred brown body, black tail.
    scale: 1.18,
    color: CANADA_GOOSE_PALETTE.color,
    belly: CANADA_GOOSE_PALETTE.belly,
    accent: CANADA_GOOSE_PALETTE.accent,
    chin: CANADA_GOOSE_PALETTE.chin,
    beakColor: CANADA_GOOSE_PALETTE.beakColor,
    legColor: CANADA_GOOSE_PALETTE.legColor,
    sheen: CANADA_GOOSE_PALETTE.sheen,
    bodyPlan: 'waterfowl',
    beakStyle: 'goose',
    footStyle: 'web',
    bodyFat: 1.22,
    wingChord: 1.2,
    beakLen: 1.05,
    legThick: 0.95,
    tailSpread: 0.82,
    neckThick: 0.55,
    neckLen: 2.2,
    breast: 1.28,
    headSize: 0.94,
    eyeSize: 0.95,
    label: 'Canada Goose',
  },
  'scarlet-macaw': {
    scale: 0.92,
    color: 0xd42a2a,
    belly: 0xe8c020,
    accent: 0x2050c0,
    beakColor: 0xe8e0d0,
    legColor: 0x4a4a48,
    sheen: 0.18,
    bodyPlan: 'parrot',
    beakStyle: 'hook',
    footStyle: 'zygodactyl',
    bodyFat: 1.02,
    wingChord: 1.25,
    beakLen: 1.45,
    legThick: 1.15,
    tailSpread: 1.7,
    neckThick: 0.85,
    breast: 1.12,
    headSize: 1.15,
    eyeSize: 1.0,
    label: 'Scarlet Macaw',
  },
});

/** Deterministic [0,1) from seed + salt. */
function seedUnit(seed, salt = 0) {
  let h = (seed >>> 0) ^ Math.imul(salt + 1, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff;
}

/** Nudge a 0xRRGGBB color by a small HSV-ish shift. */
function nudgeColor(hex, seed, salt) {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  hsl.h = (hsl.h + (seedUnit(seed, salt) - 0.5) * 0.04 + 1) % 1;
  hsl.s = THREE.MathUtils.clamp(hsl.s + (seedUnit(seed, salt + 1) - 0.5) * 0.08, 0.05, 1);
  hsl.l = THREE.MathUtils.clamp(hsl.l + (seedUnit(seed, salt + 2) - 0.5) * 0.06, 0.08, 0.92);
  c.setHSL(hsl.h, hsl.s, hsl.l);
  return c.getHex();
}

/**
 * Apply seed micro-variation for gallery A/B without leaving the breed identity.
 * @param {object} base
 * @param {number} seed
 */
export function varyBirdPresentation(base, seed) {
  const s = seed >>> 0;
  const scaleJitter = 1 + (seedUnit(s, 3) - 0.5) * 0.06;
  const shapeJitter = (salt) => 1 + (seedUnit(s, salt) - 0.5) * 0.08;
  return {
    ...base,
    // bodyPlan / beakStyle / footStyle stay identity (not jittered)
    scale: (base.scale ?? 0.45) * scaleJitter,
    color: nudgeColor(base.color ?? 0x888888, s, 10),
    belly: nudgeColor(base.belly ?? 0xcccccc, s, 20),
    accent: nudgeColor(base.accent ?? 0x444444, s, 30),
    bodyFat: (base.bodyFat ?? 1) * shapeJitter(40),
    wingChord: (base.wingChord ?? 1) * shapeJitter(41),
    beakLen: (base.beakLen ?? 1) * shapeJitter(42),
    breast: (base.breast ?? 1) * shapeJitter(43),
    tailSpread: (base.tailSpread ?? 1) * shapeJitter(44),
    headSize: (base.headSize ?? 1) * shapeJitter(45),
    eyeSize: (base.eyeSize ?? 1) * shapeJitter(46),
  };
}

/** @type {Promise<{ scene: THREE.Object3D, animations: THREE.AnimationClip[] }> | null} */
let templatePromise = null;

function loadBirdTemplate() {
  if (!templatePromise) {
    const loader = createGltfLoader();
    templatePromise = new Promise((resolve, reject) => {
      loader.load(
        BIRD_MODEL_URL,
        (gltf) => {
          resolve({
            scene: gltf.scene,
            animations: gltf.animations ?? [],
          });
        },
        undefined,
        (err) => {
          templatePromise = null;
          reject(err);
        },
      );
    });
  }
  return templatePromise;
}

export function collectBones(root) {
  /** @type {Map<string, THREE.Bone | THREE.Object3D>} */
  const bonesByName = new Map();
  root.traverse((obj) => {
    if (obj.isBone || obj.type === 'Bone') {
      bonesByName.set(obj.name, obj);
      if (obj.name === 'head' && !bonesByName.has('Head')) {
        bonesByName.set('Head', obj);
      }
    }
  });
  return bonesByName;
}

export function findSkinnedMesh(root) {
  let found = null;
  root.traverse((obj) => {
    if (found) return;
    if (obj.isSkinnedMesh && obj.skeleton) found = obj;
  });
  return found;
}

/**
 * Ensure skeleton.bones are the same Object3D instances as the hierarchy under
 * `root`. Plain `scene.clone(true)` leaves SkinnedMesh.skeleton pointing at the
 * *template* bones, so the mixer animates the clone while skinning samples the
 * static originals — looks frozen. SkeletonUtils.clone fixes this; this helper
 * is a safety net if a mesh still has a mismatched skeleton.
 *
 * @param {THREE.Skeleton} skeleton
 * @param {THREE.Object3D} root
 * @returns {THREE.Skeleton}
 */
export function rebindSkeletonToHierarchy(skeleton, root) {
  const byName = new Map();
  root.traverse((obj) => {
    if (obj.isBone || obj.type === 'Bone') byName.set(obj.name, obj);
  });
  let mismatch = 0;
  const bones = skeleton.bones.map((bone, i) => {
    const local = byName.get(bone.name);
    if (!local) return bone;
    if (local !== bone) mismatch += 1;
    return local;
  });
  if (mismatch === 0 && bones.every((b, i) => b === skeleton.bones[i])) {
    return skeleton;
  }
  const inverses = skeleton.boneInverses.map((m) => m.clone());
  return new THREE.Skeleton(bones, inverses);
}

function createNoopFurDynamics() {
  return {
    update() {},
    addImpulse() {},
    setNaked() {},
  };
}

/**
 * Minimal animation facade compatible with DogSimScene / studio presets.
 * @param {{
 *   root: THREE.Object3D,
 *   model: THREE.Object3D,
 *   mixer: THREE.AnimationMixer,
 *   actions: Map<string, THREE.AnimationAction>,
 *   skeleton?: THREE.Skeleton | null,
 *   bonesByName?: Map<string, THREE.Object3D>,
 *   timeScale?: number,
 * }} ctx
 */
export function createBirdAnimation(ctx) {
  let behavior = 'idle';
  let autopilot = false;
  let mouthState = 'closed';
  let time = 0;
  let rootYaw = 0;
  let yawRate = 0;
  let frozenBlink = false;
  let frozenBreeze = false;
  let clipDriven = true;
  let externalRootMotion = false;
  /** @type {{ x: number, z: number, moving: boolean } | null} */
  let moveIntent = null;
  const rootPos = new THREE.Vector3();
  const timeScale = Number.isFinite(ctx.timeScale) ? ctx.timeScale : 1;

  const loopByBehavior = {
    idle: 'Idle',
    walk: 'Walk',
    trot: 'Flap',
    look: 'Glide',
    // Rest Pose / Glide open wings wide; Idle is the best “perched” sit.
    sit: 'Idle',
    lie: 'Idle',
  };

  let currentClip = null;
  let autopilotTimer = 0;
  let autopilotPhase = 0;

  function playNamed(name, fade = 0.18) {
    const next = ctx.actions.get(name);
    if (!next) return false;
    if (
      currentClip === name
      && next.isRunning()
      && next.getEffectiveWeight() > 0.85
    ) {
      next.setEffectiveTimeScale(timeScale);
      return true;
    }

    const prev = currentClip ? ctx.actions.get(currentClip) : null;
    next.enabled = true;
    next.setLoop(THREE.LoopRepeat, Infinity);
    next.clampWhenFinished = false;
    next.setEffectiveTimeScale(timeScale);
    next.reset();
    next.setEffectiveWeight(1);
    next.play();

    if (prev && prev !== next && (prev.isRunning() || prev.getEffectiveWeight() > 0.01)) {
      // Prefer crossFade so weight stays continuous (no 1-frame rest pose flash).
      try {
        prev.crossFadeTo(next, fade, false);
      } catch {
        prev.fadeOut(fade);
        next.fadeIn(fade);
      }
    } else {
      next.fadeIn(Math.min(fade, 0.12));
    }

    // Ensure other leftovers drain
    for (const [clipName, action] of ctx.actions) {
      if (clipName === name || action === prev) continue;
      if (action.isRunning() || action.getEffectiveWeight() > 0.01) {
        action.fadeOut(fade);
      }
    }

    currentClip = name;
    return true;
  }

  function syncBehaviorClip() {
    const clipName = loopByBehavior[behavior] ?? 'Idle';
    playNamed(clipName, 0.18);
  }

  function plantFeet() {
    if (!ctx.model || !ctx.bonesByName) return;
    groundBird(ctx.model, ctx.bonesByName, { accumulate: true });
  }

  return {
    setBehavior(id) {
      behavior = String(id ?? 'idle');
      syncBehaviorClip();
    },
    getBehavior: () => behavior,
    setAutopilot(on) {
      autopilot = Boolean(on);
      autopilotTimer = 0;
    },
    getAutopilot: () => autopilot,
    /**
     * Studio / free-roam locomotion hook (mirrors dogAnimation.setMoveIntent).
     * Steers yaw toward the stick; walk/idle clips follow.
     */
    setMoveIntent({
      x = 0,
      z = 0,
      sprint = false,
      moving = null,
      sit = false,
      look = false,
    } = {}) {
      autopilot = false;
      const hasDirection = x * x + z * z > 1e-6;
      const wantsMove = moving ?? hasDirection;
      moveIntent = hasDirection || wantsMove
        ? { x, z, moving: wantsMove }
        : null;
      if (sit) this.setBehavior('sit');
      else if (look) this.setBehavior('look');
      else if (wantsMove) this.setBehavior(sprint ? 'trot' : 'walk');
      else this.setBehavior('idle');
    },
    setExternalRootMotion(on) {
      externalRootMotion = Boolean(on);
    },
    getExternalRootMotion: () => externalRootMotion,
    setMouthState(id) {
      mouthState = String(id ?? 'closed');
    },
    getMouthState: () => mouthState,
    setTime(t) {
      time = Number(t) || 0;
    },
    getTime: () => time,
    setRootPosition(x, y, z) {
      rootPos.set(x, y, z);
      ctx.root.position.copy(rootPos);
    },
    getRootPosition: () => rootPos.clone(),
    setRootYaw(yaw) {
      rootYaw = Number(yaw) || 0;
      ctx.root.rotation.y = rootYaw;
    },
    getRootYaw: () => rootYaw,
    getYawRate: () => yawRate,
    getMoveSpeed: () => (behavior === 'walk' || behavior === 'trot' ? 0.6 : 0),
    setFrozenBlink(on) {
      frozenBlink = Boolean(on);
    },
    setFrozenBreeze(on) {
      frozenBreeze = Boolean(on);
    },
    isFrozenBreeze: () => frozenBreeze,
    isFrozenBlink: () => frozenBlink,
    setClipDriven(on) {
      clipDriven = Boolean(on);
    },
    getClipDriven: () => clipDriven,
    applyPostClipOverlays() {
      plantFeet();
    },
    playClip(name) {
      return playNamed(name, 0.18);
    },
    getCurrentClip: () => currentClip,
    /**
     * Core body bounds (hips / spine / head / feet) — ignores hanging wing tips
     * so Flap framing and studio orbit stay stable.
     */
    getCoreBounds() {
      const names = [
        'hips', 'spine_0', 'spine_1', 'spine_2', 'spine_3', 'head',
        'Foot_L', 'Foot_R', 'Toes_tip_L', 'Toes_tip_R', 'tail_1',
      ];
      const box = new THREE.Box3();
      const p = new THREE.Vector3();
      let any = false;
      ctx.root.updateMatrixWorld(true);
      for (const name of names) {
        const bone = ctx.bonesByName?.get(name);
        if (!bone) continue;
        bone.getWorldPosition(p);
        box.expandByPoint(p);
        any = true;
      }
      if (!any) box.setFromObject(ctx.root);
      return box;
    },
    update(dt) {
      time += dt;
      if (autopilot && !frozenBlink) {
        autopilotTimer -= dt;
        if (autopilotTimer <= 0) {
          autopilotPhase = (autopilotPhase + 1) % 5;
          // Prefer Idle/Walk/Glide — Flap mid-pose hangs wings through the floor.
          const cycle = ['idle', 'look', 'idle', 'walk', 'idle'];
          behavior = cycle[autopilotPhase];
          syncBehaviorClip();
          autopilotTimer = 2.4 + (autopilotPhase % 3) * 0.7;
        }
      }
      // Free-roam steer: ease yaw toward stick while moving.
      if (moveIntent?.moving && (moveIntent.x * moveIntent.x + moveIntent.z * moveIntent.z) > 1e-6) {
        const targetYaw = Math.atan2(moveIntent.x, moveIntent.z);
        let dyaw = targetYaw - rootYaw;
        while (dyaw > Math.PI) dyaw -= Math.PI * 2;
        while (dyaw < -Math.PI) dyaw += Math.PI * 2;
        const step = THREE.MathUtils.clamp(dyaw * (1 - Math.exp(-3.0 * dt)), -2.0 * dt, 2.0 * dt);
        rootYaw += step;
        yawRate = THREE.MathUtils.lerp(yawRate, step / Math.max(dt, 1e-5), 1 - Math.exp(-10 * dt));
      } else {
        yawRate = THREE.MathUtils.lerp(yawRate, 0, 1 - Math.exp(-6 * dt));
      }
      if (clipDriven) {
        ctx.mixer.update(dt);
        // Skinning samples skeleton.boneMatrices — force update after mixer
        // writes bone local TRS (matrixWorld cascade is scene-driven).
        ctx.skeleton?.update?.();
        plantFeet();
      }
      ctx.root.position.copy(rootPos);
      ctx.root.rotation.y = rootYaw;
    },
  };
}

/**
 * Plant the bird so the lowest toe sits near y=0 (studio floor).
 * Offset is applied on `model` (not the facade root) so animation root TRS
 * does not fight the grounding each frame.
 *
 * @param {THREE.Object3D} model
 * @param {Map<string, THREE.Object3D>} bonesByName
 * @param {{ accumulate?: boolean }} [opts]
 *   accumulate:true keeps adjusting model.position.y each call (for live clips).
 *   accumulate:false (default) only offsets when feet are off the floor by >ε.
 */
export function groundBird(model, bonesByName, opts = {}) {
  model.updateMatrixWorld(true);
  const tips = ['Toes_tip_L', 'Toes_tip_R', 'Foot_L', 'Foot_R']
    .map((n) => bonesByName.get(n))
    .filter(Boolean);
  if (!tips.length) return;
  let minY = Infinity;
  const p = new THREE.Vector3();
  for (const bone of tips) {
    bone.getWorldPosition(p);
    minY = Math.min(minY, p.y);
  }
  if (!Number.isFinite(minY)) return;
  // Dead-zone so we don't micro-jitter every frame from float noise.
  if (!opts.accumulate && Math.abs(minY) < 1e-4) return;
  if (opts.accumulate && Math.abs(minY) < 5e-4) return;
  model.position.y -= minY;
  model.updateMatrixWorld(true);
}

/**
 * @param {{
 *   breedId?: string,
 *   seed?: number,
 *   variantId?: string,
 * }} [options]
 */
export async function createAuthoredBird(options = {}) {
  const breedId = normalizeDogBreedId(options.breedId ?? 'eastern-phoebe', 'eastern-phoebe');
  const breed = getDogBreed(breedId);
  if (!breed?.conformationFlags?.includes('bird-rig')) {
    throw new Error(`createAuthoredBird: ${breedId} is not a bird-rig breed`);
  }
  const seed = normalizeDogSeed(options.seed ?? 1);
  const variantId = normalizeDogVariantId(breedId, options.variantId);
  const family = getDogFamily(breed.familyId);
  const presentationBase = {
    scale: 0.45,
    color: 0x888888,
    belly: 0xcccccc,
    accent: 0x444444,
    beakColor: 0x2a2418,
    legColor: 0x3a3028,
    sheen: 0.08,
    bodyPlan: 'passerine',
    beakStyle: 'point',
    footStyle: 'perch',
    bodyFat: 1,
    wingChord: 1,
    beakLen: 1,
    legThick: 1,
    tailSpread: 1,
    neckThick: 1,
    breast: 1,
    headSize: 1,
    eyeSize: 1,
    label: breed.label,
    ...(BIRD_BREED_PRESENTATION[breedId] ?? {}),
  };
  const presentation = varyBirdPresentation(presentationBase, seed);

  // Always the shared bird rig — never a per-breed display mesh.
  const template = await loadBirdTemplate();

  const root = new THREE.Group();
  root.name = `AuthoredBird_${breedId}`;

  // SkeletonUtils.clone rebinds SkinnedMesh skeletons to the *cloned* bones.
  // Object3D.clone(true) shares the template skeleton → animations look frozen.
  const model = cloneSkinnedHierarchy(template.scene);
  model.name = 'BirdArmature';

  // Hide (and leave unused) any mesh that shipped with the rig GLB.
  // Display mesh is always the dog-style procedural loft kit.
  const sourceMeshes = [];
  model.traverse((obj) => {
    if (obj.isMesh || obj.isSkinnedMesh) sourceMeshes.push(obj);
  });
  for (const mesh of sourceMeshes) {
    mesh.visible = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
  }

  const scale = presentation.scale;
  root.scale.setScalar(scale);
  root.add(model);

  // Force bind-pose matrices before sampling bone positions.
  model.updateMatrixWorld(true);

  const bonesByName = collectBones(model);
  const sourceSkin = findSkinnedMesh(model);
  let skeleton = sourceSkin?.skeleton ?? null;

  // If the clone lost its skeleton reference, rebuild from bones.
  if (!skeleton) {
    const bones = [];
    bonesByName.forEach((b, name) => {
      if (name === 'Head') return;
      if (b.isBone) bones.push(b);
    });
    skeleton = new THREE.Skeleton(bones);
  } else {
    skeleton = rebindSkeletonToHierarchy(skeleton, model);
    // Keep every skinned mesh on this clone pointing at the hierarchy skeleton.
    for (const mesh of sourceMeshes) {
      if (mesh.isSkinnedMesh) mesh.bind(skeleton, mesh.bindMatrix);
    }
  }

  const geometry = buildBirdBodyGeometry(bonesByName, {
    bodyFat: presentation.bodyFat,
    wingChord: presentation.wingChord,
    beakLen: presentation.beakLen,
    legThick: presentation.legThick,
    tailSpread: presentation.tailSpread,
    neckThick: presentation.neckThick,
    neckLen: presentation.neckLen,
    breast: presentation.breast,
    headSize: presentation.headSize,
    eyeSize: presentation.eyeSize,
    bodyPlan: presentation.bodyPlan,
    beakStyle: presentation.beakStyle,
    footStyle: presentation.footStyle,
  });
  remapBirdSkinIndices(geometry, skeleton);

  // Canada goose: zone field marks (black neck / white chin / brown body).
  // No GLB albedo — same rudimentary mesh kit as every other bird.
  const material = breedId === 'canada-goose'
    ? createGoosePlumageMaterial(presentation)
    : createBirdPlumageMaterial(presentation);

  const bodyMesh = new THREE.SkinnedMesh(geometry, material);
  bodyMesh.name = 'BirdBody';
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  bodyMesh.frustumCulled = false;
  bodyMesh.bind(skeleton);
  // Parent under the armature so world matrices stay consistent with clips.
  // Keep GLB boneInverses (bind pose) — do not recalculate after sampling.
  model.add(bodyMesh);
  model.updateMatrixWorld(true);
  skeleton.update();
  const vertexCount = geometry.getAttribute('position')?.count ?? 0;

  groundBird(model, bonesByName);

  const armatureRoot = bonesByName.get('root') ?? model;
  // Mixer root must own the bone hierarchy (model), not the scaled facade.
  const mixer = new THREE.AnimationMixer(model);
  /** @type {Map<string, THREE.AnimationAction>} */
  const actions = new Map();
  for (const sourceClip of template.animations) {
    const name = sourceClip.name || 'Clip';
    // Per-instance clip clone so concurrent birds / reloads never share mixer state.
    const clip = sourceClip.clone();
    clip.name = name;
    actions.set(name, mixer.clipAction(clip));
  }

  // Small birds flap faster; large raptors / waterfowl read better slightly slower.
  const flapBoost = presentation.scale < 0.35 ? 1.55
    : presentation.scale < 0.5 ? 1.2
      : presentation.scale > 0.85 ? 0.88
        : 1;

  const animation = createBirdAnimation({
    root,
    model,
    mixer,
    actions,
    skeleton,
    bonesByName,
    timeScale: flapBoost,
  });
  animation.setBehavior('idle');
  // Sample a few Idle frames then re-ground — bind pose wings hang low and
  // inflate the AABB; Idle usually reads better for floor plant.
  {
    const idle = actions.get('Idle');
    if (idle) {
      idle.reset().play();
      mixer.update(1 / 30);
      skeleton.update();
      mixer.update(1 / 30);
      skeleton.update();
      groundBird(model, bonesByName);
    }
  }

  const phenotype = Object.freeze({
    breedId,
    variantId,
    familyId: breed.familyId,
    speciesId: family?.speciesId ?? breed.speciesId,
    seed,
    skeleton: {
      scale,
      headSize: presentation.headSize ?? 1,
      bodyLength: 1,
      chestWidth: presentation.breast,
      hipWidth: presentation.bodyFat,
      legLength: 1,
      neckLength: presentation.neckThick,
      tailLength: presentation.tailSpread,
    },
    geometry: { torsoWidth: presentation.bodyFat, torsoDepth: presentation.breast },
    ears: { type: 'none' },
    tail: { type: 'feathered' },
    face: {},
    coat: {
      length: 1,
      palette: {
        base: presentation.color,
        belly: presentation.belly,
        accent: presentation.accent,
      },
    },
    furnishings: {},
    extremities: { foot: 'bird-foot' },
    headgear: { type: 'none' },
    motion: {},
    personality: { ...breed.behavior },
    variation: {},
    rigKind: 'bird',
    shape: {
      bodyFat: presentation.bodyFat,
      wingChord: presentation.wingChord,
      beakLen: presentation.beakLen,
      legThick: presentation.legThick,
      tailSpread: presentation.tailSpread,
      neckThick: presentation.neckThick,
      neckLen: presentation.neckLen,
      breast: presentation.breast,
      headSize: presentation.headSize,
      eyeSize: presentation.eyeSize,
      bodyPlan: presentation.bodyPlan,
      beakStyle: presentation.beakStyle,
      footStyle: presentation.footStyle,
    },
  });

  const furDynamics = createNoopFurDynamics();
  let nakedBody = false;
  let showFur = true;
  let detailLevel = 2;

  function dispose() {
    mixer.stopAllAction();
    geometry?.dispose?.();
    if (material) {
      if (Array.isArray(material)) material.forEach((m) => m.dispose?.());
      else material.dispose?.();
    }
    root.removeFromParent();
  }

  return {
    breed,
    breedId,
    variantId,
    familyId: breed.familyId,
    speciesId: family?.speciesId ?? breed.speciesId,
    seed,
    phenotype,
    resolvedTraits: phenotype,
    presentation,
    root,
    rig: {
      root: armatureRoot,
      skeleton,
      bonesByName,
      boneCount: bonesByName.size,
      phenotype,
    },
    geometry,
    bodyMesh,
    shells: [],
    shellCount: 0,
    budget: 'hero',
    face: null,
    headgear: null,
    animation,
    furUniforms: null,
    furDynamics,
    update(dt) {
      animation.update(dt);
    },
    setNakedBody(on) {
      nakedBody = Boolean(on);
    },
    getNakedBody: () => nakedBody,
    setShowFur(on) {
      showFur = Boolean(on);
    },
    getShowFur: () => showFur,
    setDetailLevel(level) {
      detailLevel = Math.max(0, Math.min(2, Math.floor(Number(level) || 0)));
      return detailLevel;
    },
    getDetailLevel: () => detailLevel,
    dispose,
    boneCount: bonesByName.size,
    vertexCount,
    isBird: true,
    birdClips: BIRD_CLIP_CATALOG,
    birdActions: actions,
  };
}

/** Preload the shared bird rig GLB (optional warm-up). */
export function warmBirdTemplate() {
  return loadBirdTemplate();
}
