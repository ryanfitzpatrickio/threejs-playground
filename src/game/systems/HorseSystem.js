import * as THREE from 'three';
import { disposeObject3D } from '../utils/disposeObject3D.js';
import { flattenObjectForWebGPU } from '../geometry/prepareWebGPUGeometry.js';
import { createGltfLoader } from '../utils/createGltfLoader.js';

const HORSE_URL = '/assets/models/horse-rigged.glb';
const SADDLE_URL = '/assets/models/saddle.glb';
export const HORSE_GROUND_OFFSET = 0.21;
const HORSE_TARGET_HEIGHT = 1.65;
const SADDLE_SOCKET_BONES = ['Spine_1', 'Spine_2001', 'Spine_2', 'Spine_3', 'Hips'];
const SADDLE_LOCAL_OFFSET = new THREE.Vector3(0, 0.1, 0.1);
const SADDLE_LOCAL_ROTATION = new THREE.Euler(THREE.MathUtils.degToRad(270), 0, 0, 'XYZ');
const SADDLE_LOCAL_SCALE = 0.35;
const HORSE_ANIMATION_FADE_SECONDS = 0.18;
const DEFAULT_FRONT_LEG_BEND_CORRECTION = {
  enabled: false,
  amount: 0,
  axis: 'x',
  mirror: false,
  bones: ['Front_Leg_Lower_L', 'Front_Leg_Lower_R'],
};
// Optional debug-only front leg IK. Disabled by default so the horse uses its
// authored clip leg motion without the reversal experiment applied.
const DEFAULT_FRONT_LEG_IK = {
  enabled: false,
  weight: 1,
  pole: new THREE.Vector3(0, 0, 1),
  chains: [
    {
      side: 'left',
      shoulder: 'Front_Leg_Shoulder_L',
      upper: 'Front_Leg_Upper_L',
      lower: 'Front_Leg_Lower_L',
      ankle: 'Front_Leg_Ankle_L',
      foot: 'Front_Leg_Foot_L',
      tip: 'Front_Leg_Tip_L',
    },
    {
      side: 'right',
      shoulder: 'Front_Leg_Shoulder_R',
      upper: 'Front_Leg_Upper_R',
      lower: 'Front_Leg_Lower_R',
      ankle: 'Front_Leg_Ankle_R',
      foot: 'Front_Leg_Foot_R',
      tip: 'Front_Leg_Tip_R',
    },
  ],
};
const identityQuaternion = new THREE.Quaternion();
const tempInverseQuaternion = new THREE.Quaternion();
const correctionRestInverse = new THREE.Quaternion();
const correctionDelta = new THREE.Quaternion();
const correctionRotatedAxis = new THREE.Vector3();
const correctionSwing = new THREE.Quaternion();
const correctionTwist = new THREE.Quaternion();
const correctionSwingTarget = new THREE.Quaternion();
const frontLegIkTarget = new THREE.Vector3();
const frontLegIkUpperPosition = new THREE.Vector3();
const frontLegIkLowerPosition = new THREE.Vector3();
const frontLegIkEffectorPosition = new THREE.Vector3();
const frontLegIkTargetOffset = new THREE.Vector3();
const frontLegIkReachDirection = new THREE.Vector3();
const frontLegIkPoleDirection = new THREE.Vector3();
const frontLegIkPoleProjected = new THREE.Vector3();
const frontLegIkElbowTarget = new THREE.Vector3();
const frontLegIkCurrentDirection = new THREE.Vector3();
const frontLegIkDesiredDirection = new THREE.Vector3();
const frontLegIkDeltaRotation = new THREE.Quaternion();
const frontLegIkLimitedRotation = new THREE.Quaternion();
const frontLegIkParentWorldRotation = new THREE.Quaternion();
const frontLegIkParentWorldRotationInverse = new THREE.Quaternion();
const frontLegIkLocalDelta = new THREE.Quaternion();
const socketWorldPosition = new THREE.Vector3();
const socketWorldQuaternion = new THREE.Quaternion();
const socketWorldScale = new THREE.Vector3();

export class HorseSystem {
  constructor() {
    this.group = null;
    this.horse = null;
    this.mixer = null;
    this.action = null;
    this.actions = new Map();
    this.currentActionName = null;
    this.locomotion = {
      state: 'idle',
      moving: false,
      running: false,
      speed: 0,
    };
    this.socketBone = null;
    this.saddle = null;
    this.bones = [];
    this.bonesByName = new Map();
    this.restBoneQuaternions = new Map();
    this.restBoneLengthAxes = new Map();
    this.boneAdjustments = new Map();
    this.frontLegBendCorrection = cloneFrontLegBendCorrection(DEFAULT_FRONT_LEG_BEND_CORRECTION);
    this.frontLegIk = cloneFrontLegIk(DEFAULT_FRONT_LEG_IK);
    this.status = 'idle';
    this.error = null;
    this.clipNames = [];
    this.groundOffset = HORSE_GROUND_OFFSET;
  }

  async load(scene, { position = new THREE.Vector3(0, 0, 0), getGroundHeightAt = null } = {}) {
    this.status = 'loading';
    this.error = null;

    try {
      const loader = createGltfLoader();
      const [horseGltf, saddleGltf] = await Promise.all([
        loader.loadAsync(HORSE_URL),
        loader.loadAsync(SADDLE_URL),
      ]);

      this.group = new THREE.Group();
      this.group.name = 'Socketed Horse';
      this.group.position.copy(position);
      this.group.rotation.y = Math.PI * 0.5;

      const horse = horseGltf.scene;
      horse.name = 'Horse Rigged Model';

      // Ensure matrices/skeleton are ready right after GLTF load (critical for skinned
      // bounding box normalization after quantization + GLB conversion).
      horse.updateMatrixWorld(true);
      horse.traverse((child) => {
        if (child.isSkinnedMesh && child.skeleton) child.skeleton.update();
      });

      prepareAsset(horse);
      // De-interleave + de-quantize attributes so the WebGPU backend doesn't
      // emit the invalid `unorm32x4` format these Tripo GLBs otherwise produce.
      // Must precede normalizeToHeight's bounding-box work.
      flattenObjectForWebGPU(horse);
      normalizeToHeight(horse, HORSE_TARGET_HEIGHT);
      this.group.add(horse);
      this.horse = horse;
      this.indexBones(horse);

      this.socketBone = findSocketBone(horse);

      const saddle = saddleGltf.scene;
      saddle.name = 'Socketed Saddle';
      prepareAsset(saddle);
      saddle.scale.setScalar(SADDLE_LOCAL_SCALE);
      saddle.position.copy(SADDLE_LOCAL_OFFSET);
      saddle.rotation.copy(SADDLE_LOCAL_ROTATION);
      flattenObjectForWebGPU(saddle);

      if (this.socketBone) {
        this.socketBone.add(saddle);
      } else {
        saddle.position.set(0, HORSE_TARGET_HEIGHT * 0.72, 0);
        horse.add(saddle);
      }

      this.saddle = saddle;
      this.mixer = new THREE.AnimationMixer(horse);
      this.clipNames = horseGltf.animations.map((clip) => clip.name).filter(Boolean);
      this.actions = createActions(this.mixer, horseGltf.animations);
      this.playAnimation('Idle', { fadeSeconds: 0 });
      this.mixer.update(0);

      scene.add(this.group);
      if (typeof getGroundHeightAt === 'function') {
        const ground = getGroundHeightAt(this.group.position);
        if (Number.isFinite(ground)) this.placeOnGround(ground);
      }
      this.status = 'ready';
      await nextFrame();
    } catch (error) {
      this.status = 'error';
      this.error = error;
      console.warn('Horse model failed to load.', error);
    }
  }

  update({ delta }) {
    this.removeBoneAdjustments();
    this.mixer?.update(delta);
    this.applyFrontLegIk();
    this.applyFrontLegBendCorrection();
    this.applyBoneAdjustments();
  }

  placeOnGround(groundY) {
    if (!this.group || !this.horse || !Number.isFinite(groundY)) return false;

    this.group.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(this.horse, true);
    if (!Number.isFinite(bounds.min.y)) return false;

    this.group.position.y += groundY - bounds.min.y;
    this.groundOffset = this.group.position.y - groundY;
    this.group.updateMatrixWorld(true);
    return true;
  }

  setLocomotion({ moving = false, running = false, speed = 0, reverse = false } = {}) {
    const state = moving ? running ? 'run' : 'walk' : 'idle';
    this.locomotion = {
      state,
      moving,
      running,
      speed: Number.isFinite(speed) ? speed : 0,
    };

    if (state === 'run') {
      this.playAnimation('Run', { timeScale: 1.5 }); // half as fast as current (was 3x)
      return this.snapshot();
    }

    if (state === 'walk') {
      this.playAnimation('Walk', { timeScale: reverse ? 0.72 : 1 }); // half as fast as current (was 2x / 1.44x)
      return this.snapshot();
    }

    this.playAnimation('Idle', { timeScale: 1 });
    return this.snapshot();
  }

  playAnimation(name, { fadeSeconds = HORSE_ANIMATION_FADE_SECONDS, timeScale = 1 } = {}) {
    const action = this.findAction(name);

    if (!action) {
      return false;
    }

    if (action === this.action) {
      action.setEffectiveTimeScale(timeScale);
      return true;
    }

    action.reset();
    action.enabled = true;
    action.setEffectiveTimeScale(timeScale);
    action.setEffectiveWeight(1);
    action.play();

    if (this.action) {
      this.action.crossFadeTo(action, fadeSeconds, false);
    } else if (fadeSeconds > 0) {
      action.fadeIn(fadeSeconds);
    }

    this.action = action;
    this.currentActionName = action.getClip()?.name ?? name;
    return true;
  }

  findAction(name) {
    if (!name) {
      return null;
    }

    return this.actions.get(name)
      ?? this.actions.get(String(name).toLowerCase())
      ?? null;
  }

  setFrontLegBendCorrection({ enabled, amount, axis, mirror, bones } = {}) {
    if (typeof enabled === 'boolean') {
      this.frontLegBendCorrection.enabled = enabled;
    }

    if (Number.isFinite(amount)) {
      this.frontLegBendCorrection.amount = THREE.MathUtils.clamp(amount, 0, 1);
    }

    if (axis === 'x' || axis === 'y' || axis === 'z') {
      this.frontLegBendCorrection.axis = axis;
    }

    if (typeof mirror === 'boolean') {
      this.frontLegBendCorrection.mirror = mirror;
    }

    if (Array.isArray(bones) && bones.length) {
      this.frontLegBendCorrection.bones = bones.map((boneName) => String(boneName));
    }

    return this.snapshot();
  }

  resetFrontLegBendCorrection() {
    this.frontLegBendCorrection = cloneFrontLegBendCorrection(DEFAULT_FRONT_LEG_BEND_CORRECTION);
    return this.snapshot();
  }

  setFrontLegIk({ enabled, weight, pole } = {}) {
    if (typeof enabled === 'boolean') {
      this.frontLegIk.enabled = enabled;
    }

    if (Number.isFinite(weight)) {
      this.frontLegIk.weight = THREE.MathUtils.clamp(weight, 0, 1);
    }

    applyPosition(this.frontLegIk.pole, pole);

    return this.snapshot();
  }

  resetFrontLegIk() {
    this.frontLegIk = cloneFrontLegIk(DEFAULT_FRONT_LEG_IK);
    return this.snapshot();
  }

  applyFrontLegIk() {
    const settings = this.frontLegIk;

    if (!settings.enabled || settings.weight <= 0 || !this.horse) {
      return;
    }

    this.horse.updateMatrixWorld(true);

    for (const chainDefinition of settings.chains) {
      const chain = resolveFrontLegChain(this, chainDefinition);

      if (!chain) {
        continue;
      }

      chain.tip.getWorldPosition(frontLegIkTarget);

      for (const bone of chain.resetBones) {
        const restQuaternion = this.restBoneQuaternions.get(bone.name);
        if (restQuaternion) {
          bone.quaternion.copy(restQuaternion);
        }
      }

      this.horse.updateMatrixWorld(true);
      frontLegIkPoleDirection
        .copy(settings.pole)
        .transformDirection(this.horse.matrixWorld);

      if (frontLegIkPoleDirection.lengthSq() <= 0.0001) {
        frontLegIkPoleDirection.set(0, -1, -1).transformDirection(this.horse.matrixWorld);
      }

      solveFrontLegTwoBoneIk({
        root: this.horse,
        upper: chain.upper,
        lower: chain.lower,
        effector: chain.tip,
        target: frontLegIkTarget,
        poleDirection: frontLegIkPoleDirection,
        weight: settings.weight,
      });
    }
  }

  applyFrontLegBendCorrection() {
    const correction = this.frontLegBendCorrection;

    if (!correction.enabled || correction.amount <= 0) {
      return;
    }

    for (const boneName of correction.bones) {
      const bone = this.findBone(boneName);
      const restQuaternion = this.restBoneQuaternions.get(bone?.name);
      // Bone-local "length" direction at rest — the twist axis used to isolate
      // the bend (swing) from the spin (twist). Auto-derived in indexBones.
      const lengthAxis = bone && this.restBoneLengthAxes.get(bone.name);

      if (!bone || !restQuaternion || !lengthAxis) {
        continue;
      }

      // Animated local delta from rest — what the clip/IK contributed this frame.
      correctionRestInverse.copy(restQuaternion).invert();
      correctionDelta.copy(correctionRestInverse).multiply(bone.quaternion);

      // Twist–swing decomposition about the rest length axis:
      //   swing = the bend (redirects the length axis),
      //   twist = rotation about the length axis (foot yaw, preserved).
      // This is angle-exact and has no Euler gimbal coupling, so it stays clean
      // even at the ~90°+ bends these knees actually reach (Walk/Run/Jump).
      correctionRotatedAxis.copy(lengthAxis).applyQuaternion(correctionDelta);
      correctionSwing.setFromUnitVectors(lengthAxis, correctionRotatedAxis);
      correctionTwist.copy(correctionSwing).invert().multiply(correctionDelta);

      // Blend the swing toward its inverse (mirror = flip the bend direction)
      // or toward identity (straighten). Twist is left untouched either way.
      if (correction.mirror) {
        correctionSwingTarget.copy(correctionSwing).invert();
      } else {
        correctionSwingTarget.copy(identityQuaternion);
      }
      correctionSwing.slerp(correctionSwingTarget, correction.amount);

      correctionDelta.copy(correctionSwing).multiply(correctionTwist);
      bone.quaternion.copy(restQuaternion).multiply(correctionDelta).normalize();
    }
  }

  adjustSaddle({ boneName, position, rotationDegrees, scaleMultiplier } = {}) {
    if (!this.saddle) {
      return this.snapshot();
    }

    if (boneName) {
      this.attachSaddleToBone(boneName);
    }

    applyPositionDelta(this.saddle.position, position);
    applyRotationDelta(this.saddle.rotation, rotationDegrees);

    if (Number.isFinite(scaleMultiplier) && scaleMultiplier > 0) {
      this.saddle.scale.multiplyScalar(scaleMultiplier);
    }

    return this.snapshot();
  }

  setSaddle({ boneName, position, rotationDegrees, scale } = {}) {
    if (!this.saddle) {
      return this.snapshot();
    }

    if (boneName) {
      this.attachSaddleToBone(boneName);
    }

    applyPosition(this.saddle.position, position);
    applyRotation(this.saddle.rotation, rotationDegrees);

    if (Number.isFinite(scale) && scale > 0) {
      this.saddle.scale.setScalar(scale);
    }

    return this.snapshot();
  }

  adjustSaddleOffset({ boneName, position, offset } = {}) {
    if (!this.saddle) {
      return this.snapshot();
    }

    if (boneName) {
      this.attachSaddleToBone(boneName);
    }

    applyPositionDelta(this.saddle.position, position ?? offset);
    return this.snapshot();
  }

  setSaddleOffset({ boneName, position, offset } = {}) {
    if (!this.saddle) {
      return this.snapshot();
    }

    if (boneName) {
      this.attachSaddleToBone(boneName);
    }

    applyPosition(this.saddle.position, position ?? offset);
    return this.snapshot();
  }

  attachSaddleToBone(boneName) {
    const bone = this.findBone(boneName);

    if (!bone || !this.saddle) {
      return false;
    }

    bone.add(this.saddle);
    this.socketBone = bone;
    return true;
  }

  dumpBones(filter = '') {
    const search = String(filter ?? '').trim().toLowerCase();

    return this.bones.filter((bone) => !search || bone.name.toLowerCase().includes(search)).map((bone) => ({
      name: bone.name,
      parent: bone.parent?.name ?? null,
      socket: bone === this.socketBone,
      adjusted: this.boneAdjustments.has(bone.name),
    }));
  }

  adjustBone({ boneName = this.socketBone?.name, position, rotationDegrees, scaleMultiplier } = {}) {
    const bone = this.findBone(boneName);

    if (!bone) {
      return this.boneCommandSnapshot(boneName);
    }

    const adjustment = this.getBoneAdjustment(bone);
    this.removeBoneAdjustment(bone, adjustment);
    applyPositionDelta(adjustment.position, position);
    applyRotationDelta(adjustment.rotation, rotationDegrees);
    updateAdjustmentQuaternion(adjustment);

    if (Number.isFinite(scaleMultiplier) && scaleMultiplier > 0) {
      adjustment.scale *= scaleMultiplier;
    }

    this.applyBoneAdjustment(bone, adjustment);
    return this.boneCommandSnapshot(bone.name);
  }

  setBone({ boneName = this.socketBone?.name, position, rotationDegrees, scale } = {}) {
    const bone = this.findBone(boneName);

    if (!bone) {
      return this.boneCommandSnapshot(boneName);
    }

    const adjustment = this.getBoneAdjustment(bone);
    this.removeBoneAdjustment(bone, adjustment);
    applyPosition(adjustment.position, position);
    applyRotation(adjustment.rotation, rotationDegrees);
    updateAdjustmentQuaternion(adjustment);

    if (Number.isFinite(scale) && scale > 0) {
      adjustment.scale = scale;
    }

    this.applyBoneAdjustment(bone, adjustment);
    return this.boneCommandSnapshot(bone.name);
  }

  resetBone({ boneName = this.socketBone?.name } = {}) {
    const bone = this.findBone(boneName);

    if (!bone) {
      return this.boneCommandSnapshot(boneName);
    }

    const adjustment = this.boneAdjustments.get(bone.name);
    if (adjustment) {
      this.removeBoneAdjustment(bone, adjustment);
      this.boneAdjustments.delete(bone.name);
    }

    return this.boneCommandSnapshot(bone.name);
  }

  getSocketTransform({ boneName = 'Spine_1', offset = null } = {}) {
    const bone = boneName === 'saddle'
      ? this.saddle
      : this.findBone(boneName) ?? this.socketBone;

    if (!bone) {
      return null;
    }

    bone.updateWorldMatrix(true, false);

    if (offset) {
      socketWorldPosition.copy(offset).applyMatrix4(bone.matrixWorld);
    } else {
      bone.getWorldPosition(socketWorldPosition);
    }

    bone.getWorldQuaternion(socketWorldQuaternion);
    bone.getWorldScale(socketWorldScale);

    return {
      bone,
      position: socketWorldPosition.clone(),
      quaternion: socketWorldQuaternion.clone(),
      scale: socketWorldScale.clone(),
    };
  }

  snapshot() {
    const position = this.group?.position ?? null;
    return {
      status: this.status,
      error: this.error?.message ?? null,
      socketBone: this.socketBone?.name ?? null,
      saddleAttached: Boolean(this.saddle?.parent),
      saddle: this.saddle ? objectTransformSnapshot(this.saddle) : null,
      bones: {
        count: this.bones.length,
        adjusted: [...this.boneAdjustments.entries()].map(([boneName, adjustment]) => ({
          boneName,
          ...boneAdjustmentSnapshot(adjustment),
        })),
      },
      clips: this.clipNames,
      action: this.currentActionName ?? this.action?._clip?.name ?? null,
      locomotion: {
        ...this.locomotion,
        speed: Number(this.locomotion.speed.toFixed(3)),
      },
      frontLegBendCorrection: {
        enabled: this.frontLegBendCorrection.enabled,
        amount: Number(this.frontLegBendCorrection.amount.toFixed(3)),
        axis: this.frontLegBendCorrection.axis,
        mirror: this.frontLegBendCorrection.mirror,
        bones: [...this.frontLegBendCorrection.bones],
      },
      frontLegIk: {
        enabled: this.frontLegIk.enabled,
        weight: Number(this.frontLegIk.weight.toFixed(3)),
        pole: {
          x: Number(this.frontLegIk.pole.x.toFixed(3)),
          y: Number(this.frontLegIk.pole.y.toFixed(3)),
          z: Number(this.frontLegIk.pole.z.toFixed(3)),
        },
      },
      position: position
        ? {
            x: Number(position.x.toFixed(3)),
            y: Number(position.y.toFixed(3)),
            z: Number(position.z.toFixed(3)),
          }
        : null,
    };
  }

  dispose() {
    this.action?.stop();
    this.mixer?.stopAllAction();
    this.mixer = null;
    this.action = null;
    this.actions.clear();
    this.currentActionName = null;
    this.locomotion = {
      state: 'idle',
      moving: false,
      running: false,
      speed: 0,
    };
    this.horse = null;
    this.socketBone = null;
    this.saddle = null;
    this.bones = [];
    this.bonesByName.clear();
    this.restBoneQuaternions.clear();
    this.restBoneLengthAxes.clear();
    this.boneAdjustments.clear();

    if (this.group) {
      disposeObject3D(this.group);
      this.group.removeFromParent();
      this.group = null;
    }

    this.status = 'idle';
  }

  indexBones(root) {
    this.bones = [];
    this.bonesByName.clear();
    this.restBoneQuaternions.clear();
    this.restBoneLengthAxes.clear();

    root.traverse((object) => {
      if (!object.isBone) {
        return;
      }

      this.bones.push(object);
      this.bonesByName.set(object.name, object);
      this.bonesByName.set(object.name.toLowerCase(), object);
      this.restBoneQuaternions.set(object.name, object.quaternion.clone());

      // Rest length axis = direction from this bone to its farthest bone child,
      // expressed in this bone's local frame (child.position is parent-local).
      // Used as the twist axis when decomposing bend corrections.
      let farthest = null;
      let farthestDistSq = 0;
      for (const child of object.children) {
        if (!child.isBone) {
          continue;
        }
        const distSq = child.position.lengthSq();
        if (distSq > farthestDistSq) {
          farthestDistSq = distSq;
          farthest = child;
        }
      }
      if (farthest) {
        this.restBoneLengthAxes.set(object.name, farthest.position.clone().normalize());
      }
    });
  }

  findBone(boneName) {
    if (!boneName) {
      return null;
    }

    return this.bonesByName.get(boneName) ?? this.bonesByName.get(String(boneName).toLowerCase()) ?? null;
  }

  getBoneAdjustment(bone) {
    let adjustment = this.boneAdjustments.get(bone.name);

    if (!adjustment) {
      adjustment = createBoneAdjustment();
      this.boneAdjustments.set(bone.name, adjustment);
    }

    return adjustment;
  }

  removeBoneAdjustments() {
    for (const [boneName, adjustment] of this.boneAdjustments.entries()) {
      const bone = this.findBone(boneName);
      if (bone) {
        this.removeBoneAdjustment(bone, adjustment);
      }
    }
  }

  applyBoneAdjustments() {
    for (const [boneName, adjustment] of this.boneAdjustments.entries()) {
      const bone = this.findBone(boneName);
      if (bone) {
        this.applyBoneAdjustment(bone, adjustment);
      }
    }
  }

  removeBoneAdjustment(bone, adjustment) {
    if (!adjustment.applied) {
      return;
    }

    bone.position.sub(adjustment.lastPosition);

    if (!adjustment.lastRotation.equals(identityQuaternion)) {
      tempInverseQuaternion.copy(adjustment.lastRotation).invert();
      bone.quaternion.multiply(tempInverseQuaternion);
    }

    if (Number.isFinite(adjustment.lastScale) && adjustment.lastScale > 0 && adjustment.lastScale !== 1) {
      bone.scale.multiplyScalar(1 / adjustment.lastScale);
    }

    adjustment.lastPosition.set(0, 0, 0);
    adjustment.lastRotation.identity();
    adjustment.lastScale = 1;
    adjustment.applied = false;
  }

  applyBoneAdjustment(bone, adjustment) {
    bone.position.add(adjustment.position);
    bone.quaternion.multiply(adjustment.quaternion);

    if (Number.isFinite(adjustment.scale) && adjustment.scale > 0 && adjustment.scale !== 1) {
      bone.scale.multiplyScalar(adjustment.scale);
    }

    adjustment.lastPosition.copy(adjustment.position);
    adjustment.lastRotation.copy(adjustment.quaternion);
    adjustment.lastScale = adjustment.scale;
    adjustment.applied = true;
  }

  boneCommandSnapshot(requestedBoneName) {
    const bone = this.findBone(requestedBoneName);

    return {
      requestedBoneName: requestedBoneName ?? null,
      found: Boolean(bone),
      boneName: bone?.name ?? null,
      availableBones: bone ? undefined : this.dumpBones().map((entry) => entry.name),
      adjustment: bone ? boneAdjustmentSnapshot(this.boneAdjustments.get(bone.name) ?? createBoneAdjustment()) : null,
      current: bone ? objectTransformSnapshot(bone) : null,
      horse: this.snapshot(),
    };
  }
}

function prepareAsset(root) {
  root.traverse((object) => {
    if (!object.isMesh && !object.isSkinnedMesh) {
      return;
    }

    object.castShadow = true;
    object.receiveShadow = true;
    object.frustumCulled = false;
  });
}

function normalizeToHeight(root, targetHeight) {
  // Box3.setFromObject(root, true) computes the true SKINNED (bind-pose) bounds:
  // for SkinnedMesh it applies the bone transforms, so the armature's intrinsic
  // unit scale is accounted for. The raw geometry bounding box is authored in a
  // normalized [-1,1] bind space and the bones carry the real scale, so measuring
  // geometry.boundingBox * matrixWorld instead reports ~3x the rendered height and
  // shrinks the horse. flattenObjectForWebGPU has already de-quantized positions,
  // so the precise (per-vertex, bone-aware) path is safe here.
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

function findSocketBone(root) {
  const bones = [];
  root.traverse((object) => {
    if (object.isBone) {
      bones.push(object);
    }
  });

  for (const name of SADDLE_SOCKET_BONES) {
    const bone = bones.find((candidate) => candidate.name === name);
    if (bone) {
      return bone;
    }
  }

  return bones.find((candidate) => /spine|back|hips/i.test(candidate.name)) ?? null;
}

function findClip(clips, name) {
  return clips.find((clip) => clip.name.toLowerCase() === name.toLowerCase()) ?? null;
}

function createActions(mixer, clips) {
  const actions = new Map();

  for (const clip of clips) {
    const action = mixer.clipAction(lockHorseRootTranslation(clip));
    action.enabled = true;
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = false;
    actions.set(clip.name, action);
    actions.set(clip.name.toLowerCase(), action);
  }

  return actions;
}

function lockHorseRootTranslation(clip) {
  const filteredTracks = clip.tracks.filter((track) => {
    const name = track.name.toLowerCase();
    return !(
      name === 'root.position' ||
      name === 'hips.position' ||
      name.endsWith('/root.position') ||
      name.endsWith('/hips.position')
    );
  });

  if (filteredTracks.length === clip.tracks.length) {
    return clip;
  }

  const lockedClip = new THREE.AnimationClip(clip.name, clip.duration, filteredTracks);
  lockedClip.blendMode = clip.blendMode;
  lockedClip.userData = { ...(clip.userData ?? {}), rootTranslationLocked: true };
  return lockedClip;
}

function cloneFrontLegBendCorrection(source) {
  return {
    enabled: source.enabled === true,
    amount: Number.isFinite(source.amount) ? source.amount : 0,
    axis: source.axis ?? 'x',
    mirror: source.mirror === true,
    bones: [...(source.bones ?? [])],
  };
}

function cloneFrontLegIk(source) {
  return {
    enabled: source.enabled === true,
    weight: Number.isFinite(source.weight) ? source.weight : 1,
    pole: source.pole?.clone?.() ?? new THREE.Vector3(0, -1, 1),
    chains: source.chains.map((chain) => ({ ...chain })),
  };
}

function resolveFrontLegChain(horseSystem, definition) {
  const shoulder = horseSystem.findBone(definition.shoulder);
  const upper = horseSystem.findBone(definition.upper);
  const lower = horseSystem.findBone(definition.lower);
  const ankle = horseSystem.findBone(definition.ankle);
  const foot = horseSystem.findBone(definition.foot);
  const tip = horseSystem.findBone(definition.tip);

  if (!upper || !lower || !tip) {
    return null;
  }

  return {
    shoulder,
    upper,
    lower,
    ankle,
    foot,
    tip,
    resetBones: [shoulder, upper, lower, ankle, foot].filter(Boolean),
  };
}

function solveFrontLegTwoBoneIk({ root, upper, lower, effector, target, poleDirection, weight }) {
  root.updateMatrixWorld(true);
  upper.getWorldPosition(frontLegIkUpperPosition);
  lower.getWorldPosition(frontLegIkLowerPosition);
  effector.getWorldPosition(frontLegIkEffectorPosition);

  const upperLength = frontLegIkUpperPosition.distanceTo(frontLegIkLowerPosition);
  const lowerLength = frontLegIkLowerPosition.distanceTo(frontLegIkEffectorPosition);

  if (upperLength <= 0.0001 || lowerLength <= 0.0001) {
    return;
  }

  frontLegIkTargetOffset.copy(target).sub(frontLegIkUpperPosition);

  if (frontLegIkTargetOffset.lengthSq() <= 0.000001) {
    return;
  }

  const maxReach = Math.max(0.0001, upperLength + lowerLength - 0.015);
  const minReach = Math.max(0.0001, Math.abs(upperLength - lowerLength) + 0.015);
  const targetDistance = THREE.MathUtils.clamp(frontLegIkTargetOffset.length(), minReach, maxReach);

  frontLegIkReachDirection.copy(frontLegIkTargetOffset).normalize();
  frontLegIkPoleProjected
    .copy(poleDirection)
    .sub(frontLegIkReachDirection.clone().multiplyScalar(poleDirection.dot(frontLegIkReachDirection)));

  if (frontLegIkPoleProjected.lengthSq() <= 0.000001) {
    frontLegIkPoleProjected.copy(frontLegIkLowerPosition).sub(frontLegIkUpperPosition);
    frontLegIkPoleProjected.sub(frontLegIkReachDirection.clone().multiplyScalar(frontLegIkPoleProjected.dot(frontLegIkReachDirection)));
  }

  if (frontLegIkPoleProjected.lengthSq() <= 0.000001) {
    return;
  }

  frontLegIkPoleProjected.normalize();

  const elbowAlong = THREE.MathUtils.clamp(
    (upperLength * upperLength + targetDistance * targetDistance - lowerLength * lowerLength) /
      (2 * targetDistance),
    -upperLength,
    upperLength,
  );
  const elbowSide = Math.sqrt(Math.max(0, upperLength * upperLength - elbowAlong * elbowAlong));

  frontLegIkElbowTarget
    .copy(frontLegIkUpperPosition)
    .addScaledVector(frontLegIkReachDirection, elbowAlong)
    .addScaledVector(frontLegIkPoleProjected, elbowSide);

  rotateFrontLegBoneToward({
    root,
    bone: upper,
    fromWorld: frontLegIkLowerPosition,
    toWorld: frontLegIkElbowTarget,
    originWorld: frontLegIkUpperPosition,
    weight,
  });

  root.updateMatrixWorld(true);
  lower.getWorldPosition(frontLegIkLowerPosition);
  effector.getWorldPosition(frontLegIkEffectorPosition);

  rotateFrontLegBoneToward({
    root,
    bone: lower,
    fromWorld: frontLegIkEffectorPosition,
    toWorld: target,
    originWorld: frontLegIkLowerPosition,
    weight,
  });

  root.updateMatrixWorld(true);
}

function rotateFrontLegBoneToward({ root, bone, fromWorld, toWorld, originWorld, weight }) {
  frontLegIkCurrentDirection.copy(fromWorld).sub(originWorld);
  frontLegIkDesiredDirection.copy(toWorld).sub(originWorld);

  if (frontLegIkCurrentDirection.lengthSq() <= 0.000001 || frontLegIkDesiredDirection.lengthSq() <= 0.000001) {
    return;
  }

  frontLegIkCurrentDirection.normalize();
  frontLegIkDesiredDirection.normalize();
  frontLegIkDeltaRotation.setFromUnitVectors(frontLegIkCurrentDirection, frontLegIkDesiredDirection);
  frontLegIkLimitedRotation.identity().slerp(frontLegIkDeltaRotation, THREE.MathUtils.clamp(weight, 0, 1));
  applyFrontLegWorldRotationDelta(bone, frontLegIkLimitedRotation);
  root.updateMatrixWorld(true);
}

function applyFrontLegWorldRotationDelta(bone, worldDelta) {
  bone.parent.getWorldQuaternion(frontLegIkParentWorldRotation);
  frontLegIkParentWorldRotationInverse.copy(frontLegIkParentWorldRotation).invert();
  frontLegIkLocalDelta
    .copy(frontLegIkParentWorldRotationInverse)
    .multiply(worldDelta)
    .multiply(frontLegIkParentWorldRotation);
  bone.quaternion.premultiply(frontLegIkLocalDelta).normalize();
}

function createBoneAdjustment() {
  return {
    position: new THREE.Vector3(),
    rotation: new THREE.Euler(0, 0, 0, 'XYZ'),
    quaternion: new THREE.Quaternion(),
    scale: 1,
    lastPosition: new THREE.Vector3(),
    lastRotation: new THREE.Quaternion(),
    lastScale: 1,
    applied: false,
  };
}

function updateAdjustmentQuaternion(adjustment) {
  adjustment.quaternion.setFromEuler(adjustment.rotation);
}

function applyPosition(target, source) {
  if (!source) {
    return;
  }

  target.set(
    Number.isFinite(source.x) ? source.x : target.x,
    Number.isFinite(source.y) ? source.y : target.y,
    Number.isFinite(source.z) ? source.z : target.z,
  );
}

function applyPositionDelta(target, source) {
  if (!source) {
    return;
  }

  if (Number.isFinite(source.x)) target.x += source.x;
  if (Number.isFinite(source.y)) target.y += source.y;
  if (Number.isFinite(source.z)) target.z += source.z;
}

function applyRotation(target, source) {
  if (!source) {
    return;
  }

  target.set(
    Number.isFinite(source.x) ? THREE.MathUtils.degToRad(source.x) : target.x,
    Number.isFinite(source.y) ? THREE.MathUtils.degToRad(source.y) : target.y,
    Number.isFinite(source.z) ? THREE.MathUtils.degToRad(source.z) : target.z,
    target.order,
  );
}

function applyRotationDelta(target, source) {
  if (!source) {
    return;
  }

  if (Number.isFinite(source.x)) target.x += THREE.MathUtils.degToRad(source.x);
  if (Number.isFinite(source.y)) target.y += THREE.MathUtils.degToRad(source.y);
  if (Number.isFinite(source.z)) target.z += THREE.MathUtils.degToRad(source.z);
}

function objectTransformSnapshot(object) {
  return {
    position: {
      x: Number(object.position.x.toFixed(4)),
      y: Number(object.position.y.toFixed(4)),
      z: Number(object.position.z.toFixed(4)),
    },
    rotationDegrees: {
      x: Number(THREE.MathUtils.radToDeg(object.rotation.x).toFixed(2)),
      y: Number(THREE.MathUtils.radToDeg(object.rotation.y).toFixed(2)),
      z: Number(THREE.MathUtils.radToDeg(object.rotation.z).toFixed(2)),
    },
    scale: Number(object.scale.x.toFixed(4)),
  };
}

function boneAdjustmentSnapshot(adjustment) {
  return {
    position: {
      x: Number(adjustment.position.x.toFixed(4)),
      y: Number(adjustment.position.y.toFixed(4)),
      z: Number(adjustment.position.z.toFixed(4)),
    },
    rotationDegrees: {
      x: Number(THREE.MathUtils.radToDeg(adjustment.rotation.x).toFixed(2)),
      y: Number(THREE.MathUtils.radToDeg(adjustment.rotation.y).toFixed(2)),
      z: Number(THREE.MathUtils.radToDeg(adjustment.rotation.z).toFixed(2)),
    },
    scale: Number(adjustment.scale.toFixed(4)),
  };
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}
