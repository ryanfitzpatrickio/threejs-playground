import * as THREE from 'three';
import { GAME_CONFIG } from '../../config/gameConfig.js';

const DEFAULT_FADE_SECONDS = 0.18;
// Smoothing rate for the leg-overlay weight (attack/draw/sheathe legs blending
// in/out over locomotion). Higher = snappier blend.
const ATTACK_LEG_SMOOTHING = 12;

const ROOT_POSITION_TRACK = 'mixamorigHips.position';
const HANG_IK_ENABLED = true;
const HANG_FOOT_IK_ENABLED = true;
const CLIMB_UP_HARD_HAND_IK_START = 0.48;
const rootMotionStart = new THREE.Vector3();
const rootMotionEnd = new THREE.Vector3();
const rootMotionTotal = new THREE.Vector3();
const rootMotionWrapEnd = new THREE.Vector3();
const rootMotionWrapStart = new THREE.Vector3();
const rootMotionPreviousKey = new THREE.Vector3();
const rootMotionNextKey = new THREE.Vector3();
const footWorldPosition = new THREE.Vector3();
const modelVisualOffset = new THREE.Vector3();

const FOOT_GROUNDING_SETTINGS = {
  land: {
    maxDrop: 0.08,
    maxRaise: 0.08,
    maxGroundDistance: 0.24,
    smoothing: 14,
  },
  landMoving: {
    maxDrop: 0.08,
    maxRaise: 0.08,
    maxGroundDistance: 0.24,
    smoothing: 14,
  },
  landRoll: {
    maxDrop: 0.08,
    maxRaise: 0.08,
    maxGroundDistance: 0.24,
    smoothing: 14,
  },
  jumpBig: {
    maxDrop: 0.08,
    maxRaise: 0.08,
    maxGroundDistance: 0.24,
    smoothing: 14,
  },
  jog: {
    maxDrop: 0.16,
    maxRaise: 0.035,
    maxGroundDistance: 0.08,
    smoothing: 20,
  },
  sprint: {
    maxDrop: 0.18,
    maxRaise: 0.035,
    maxGroundDistance: 0.09,
    smoothing: 24,
  },
  mudIdle: {
    maxDrop: 0.2,
    maxRaise: 0.04,
    maxGroundDistance: 0.12,
    smoothing: 18,
  },
  mudWalk: {
    maxDrop: 0.22,
    maxRaise: 0.04,
    maxGroundDistance: 0.12,
    smoothing: 20,
  },
  mudRun: {
    maxDrop: 0.24,
    maxRaise: 0.04,
    maxGroundDistance: 0.13,
    smoothing: 24,
  },
  runningSlide: {
    maxDrop: 0.68,
    maxRaise: 0.035,
    maxGroundDistance: 0.56,
    smoothing: 46,
  },
  brace: {
    maxDrop: 0.42,
    maxRaise: 0.04,
    maxGroundDistance: 0.16,
    smoothing: 24,
  },
};
const FOOT_BONE_NAMES = [
  'mixamorigLeftFoot',
  'mixamorigLeftToeBase',
  'mixamorigRightFoot',
  'mixamorigRightToeBase',
];

// Bones driven by the LOWER layer (legs + hips, which carry root motion). Every
// other bone (spine, arms, head, hands) is driven by the UPPER layer. The two
// sets are disjoint, so the two masked clips coexist on one mixer at weight 1
// without fighting — that's what makes upper/lower body layering work.
const LOWER_BODY_PREFIXES = [
  'mixamorigHips',
  'mixamorigLeftUpLeg',
  'mixamorigLeftLeg',
  'mixamorigLeftFoot',
  'mixamorigLeftToe',
  'mixamorigRightUpLeg',
  'mixamorigRightLeg',
  'mixamorigRightFoot',
  'mixamorigRightToe',
];

function boneNameOfTrack(track) {
  const dot = track.name.indexOf('.');
  return dot === -1 ? track.name : track.name.slice(0, dot);
}

// Return a clip that keeps only the lower- or upper-body tracks of `source`.
// Track objects are shared (no keyframe duplication); userData (root motion) is
// preserved so the lower clip still drives movement.
function filterClipByBody(source, keepLower) {
  const tracks = source.tracks.filter((track) => {
    const bone = boneNameOfTrack(track);
    const isLower = LOWER_BODY_PREFIXES.some((prefix) => bone.startsWith(prefix));
    return keepLower ? isLower : !isLower;
  });
  const masked = new THREE.AnimationClip(
    `${source.name}:${keepLower ? 'lower' : 'upper'}`,
    source.duration,
    tracks,
    source.blendMode,
  );
  masked.userData = source.userData ?? {};
  return masked;
}
const LANDING_VISUAL_OFFSET_MAX = 0.62;
const LANDING_VISUAL_OFFSET_EPSILON = 0.015;
const LANDING_VISUAL_OFFSET_SMOOTHING = 7.2;
const TRAVERSAL_VISUAL_OFFSET_MAX = 0.28;
const TRAVERSAL_VISUAL_OFFSET_EPSILON = 0.004;
const TRAVERSAL_VISUAL_OFFSET_SMOOTHING = 9.5;
const TOP_OUT_FOOT_PLANT_SECONDS = 0.5;
const TOP_OUT_FOOT_PLANT_SETTINGS = {
  maxDrop: 0.52,
  maxRaise: 0.04,
  maxGroundDistance: 0.85,
  smoothing: 38,
};
const HAND_BONE_NAMES = ['mixamorigLeftHand', 'mixamorigRightHand'];
const MOUNT_TORSO_STABILIZER_BONES = [
  'mixamorigHips',
  'mixamorigSpine',
  'mixamorigSpine1',
  'mixamorigSpine2',
  'mixamorigNeck',
  'mixamorigHead',
];

const ARMED_SPINE_STABILIZER_BONES = [
  'mixamorigSpine',
  'mixamorigSpine1',
  'mixamorigSpine2',
  'mixamorigNeck',
  'mixamorigHead',
];
const MOUNT_CORE_LOCKED_STATES = new Set(['getOnHorse', 'ridingHorse', 'drivingQuad', 'getOffHorse']);
const FOOT_GROUNDING_RELEASE_SMOOTHING = 12;
const HANG_IK_SETTINGS = {
  handSpacing: 0.26,
  handYOffset: -0.01,
  handNormalOffset: 0.18,
  footSpacing: 0.18,
  footDrop: 1.08,
  footNormalOffset: 0.08,
  handIterations: 12,
  footIterations: 6,
  maxAnglePerStep: 0.62,
};
const HANG_IK_PROFILES = {
  bracedHang: { hands: 1, feet: 0.8 },
  bracedHangAttach: { hands: 1, feet: 0.8 },
  bracedHangShimmyLeft: { hands: 0.95, feet: 0.72 },
  bracedHangShimmyRight: { hands: 0.95, feet: 0.72 },
  bracedHangShimmyAlt: { hands: 0.95, feet: 0.72 },
  bracedHangHopLeft: { hands: 1, feet: 0 },
  bracedHangHopRight: { hands: 1, feet: 0 },
  bracedHangHopUp: { hands: 1, feet: 0.45 },
  bracedToFreeHang: {
    hands: 1,
    feet: { start: 0.18, end: 0.72, from: 0.72, to: 0 },
  },
  freeHangToBraced: {
    hands: 1,
    feet: { start: 0.18, end: 0.72, from: 0, to: 0.72 },
  },
  bracedHangEnter: {
    hands: 1,
    feet: { start: 0.18, end: 0.72, from: 0, to: 0.72 },
  },
  bracedHangExit: {
    hands: 1,
    feet: { start: 0.18, end: 0.72, from: 0.72, to: 0 },
  },
  freeHang: { hands: 1, feet: 0 },
  freeHangIdleAlt: { hands: 1, feet: 0 },
  freeHangIdleAlt2: { hands: 1, feet: 0 },
  hookSwing: { hands: 1, feet: 0 },
  hookMulti: { hands: 1, feet: 0 },
  hanging: { hands: 1, feet: 0 },
  leftShimmy: {
    leftHand: 1,
    rightHand: 1,
    leftFoot: 0.05,
    rightFoot: 0.05,
  },
  rightShimmy: {
    leftHand: 1,
    rightHand: 1,
    leftFoot: 0.05,
    rightFoot: 0.05,
  },
  movingWhileHanging: {
    leftHand: 1,
    rightHand: 1,
    leftFoot: 0.05,
    rightFoot: 0.05,
  },
  freeHangHopLeft: { hands: 1, feet: 0 },
  freeHangHopRight: { hands: 1, feet: 0 },
  freeHangHopLeftAlt: { hands: 1, feet: 0 },
  freeHangHopRightAlt: { hands: 1, feet: 0 },
  jumpToFreeHang: { hands: 1, feet: 0, snapHands: true },
  jumpToHang: {
    hands: 1,
    feet: { start: 0.58, end: 0.86, from: 0, to: 0.8 },
    snapHands: true,
  },
  jumpingToHanging: { hands: 1, feet: 0, snapHands: true },
  dropToFreeHang: { hands: { start: 0.12, end: 0.42, from: 0, to: 1 }, feet: 0 },
  standToFreeHang: { hands: { start: 0.12, end: 0.42, from: 0, to: 1 }, feet: 0 },
  idleToBracedHang: {
    hands: { start: 0.12, end: 0.42, from: 0, to: 1 },
    feet: { start: 0.32, end: 0.78, from: 0, to: 0.8 },
  },
  jumpFromWall: { hands: 1, feet: 0.65 },
  freeHangDrop: { hands: { start: 0.48, end: 0.72, from: 1, to: 0 }, feet: 0 },
  bracedHangDrop: {
    hands: { start: 0, end: 0.24, from: 1, to: 0 },
    feet: { start: 0, end: 0.18, from: 0.75, to: 0 },
  },
  freeHangClimb: { hands: 1, feet: 0 },
  freeHangClimbDown: { hands: { start: 0.82, end: 0.98, from: 0, to: 1 }, feet: 0 },
  bracedHangToCrouch: {
    hands: 1,
    feet: { start: 0, end: 0.18, from: 0.75, to: 0 },
  },
  bracedHangToCrouchDown: {
    hands: { start: 0.82, end: 0.98, from: 0, to: 1 },
    feet: { start: 0.82, end: 0.98, from: 0, to: 0.75 },
  },
};
const VAULT_IK_PROFILES = {
  idleSmallVault: {
    hands: [
      { start: 0.1, end: 0.24, from: 0, to: 1 },
      { start: 0.24, end: 0.7, from: 1, to: 1 },
      { start: 0.7, end: 0.92, from: 1, to: 0 },
    ],
    snapAt: 0.78,
  },
  runVault: {
    leftHand: [
      { start: 0.06, end: 0.17, from: 0, to: 1 },
      { start: 0.17, end: 0.58, from: 1, to: 1 },
      { start: 0.58, end: 0.8, from: 1, to: 0 },
    ],
    rightHand: 0,
    snapAt: 0.76,
    leftTarget: 'center',
  },
  runButtVault: {
    leftHand: [
      { start: 0.06, end: 0.16, from: 0, to: 0.72 },
      { start: 0.16, end: 0.3, from: 0.72, to: 0.64 },
      { start: 0.3, end: 0.46, from: 0.64, to: 0 },
    ],
    rightHand: [
      { start: 0.06, end: 0.16, from: 0, to: 0.72 },
      { start: 0.16, end: 0.3, from: 0.72, to: 0.64 },
      { start: 0.3, end: 0.46, from: 0.64, to: 0 },
    ],
    leftTarget: 'midRight',
    rightTarget: 'midLeft',
    snapAt: 1.1,
  },
  runFancyVault: {
    leftHand: [
      { start: 0.06, end: 0.18, from: 0, to: 1 },
      { start: 0.18, end: 0.6, from: 1, to: 1 },
      { start: 0.6, end: 0.82, from: 1, to: 0 },
    ],
    rightHand: 0,
    leftTarget: 'center',
    snapAt: 0.76,
  },
};
const MOUNT_IK_PROFILE = {
  getOnHorse: {
    hands: [
      { start: 0.18, end: 0.42, from: 0, to: 1 },
      { start: 0.42, end: 1, from: 1, to: 1 },
    ],
  },
  ridingHorse: { hands: 1 },
  drivingQuad: { hands: 1, feet: 1 },
  getOffHorse: {
    hands: [
      { start: 0, end: 0.48, from: 1, to: 1 },
      { start: 0.48, end: 0.78, from: 1, to: 0 },
    ],
  },
};
const CONTACT_IK_CHAINS = {
  leftHand: {
    effector: 'mixamorigLeftHand',
    upper: 'mixamorigLeftArm',
    lower: 'mixamorigLeftForeArm',
    links: ['mixamorigLeftForeArm', 'mixamorigLeftArm', 'mixamorigLeftShoulder'],
  },
  rightHand: {
    effector: 'mixamorigRightHand',
    upper: 'mixamorigRightArm',
    lower: 'mixamorigRightForeArm',
    links: ['mixamorigRightForeArm', 'mixamorigRightArm', 'mixamorigRightShoulder'],
  },
  leftFoot: {
    effector: 'mixamorigLeftToeBase',
    links: ['mixamorigLeftFoot', 'mixamorigLeftLeg', 'mixamorigLeftUpLeg'],
  },
  rightFoot: {
    effector: 'mixamorigRightToeBase',
    links: ['mixamorigRightFoot', 'mixamorigRightLeg', 'mixamorigRightUpLeg'],
  },
};
const handWorldPosition = new THREE.Vector3();
const contactWorldPosition = new THREE.Vector3();
const ledgePoint = new THREE.Vector3();
const ledgeNormal = new THREE.Vector3();
const ledgeTangent = new THREE.Vector3();
const ikTarget = new THREE.Vector3();
const ikWeightedTarget = new THREE.Vector3();
const ikPoleDirection = new THREE.Vector3();
const ikUpperPosition = new THREE.Vector3();
const ikLowerPosition = new THREE.Vector3();
const ikTargetOffset = new THREE.Vector3();
const ikReachDirection = new THREE.Vector3();
const ikPoleProjected = new THREE.Vector3();
const ikElbowTarget = new THREE.Vector3();
const ikCurrentDirection = new THREE.Vector3();
const ikDesiredDirection = new THREE.Vector3();
const ikEffectorPosition = new THREE.Vector3();
const ikJointPosition = new THREE.Vector3();
const ikEffectorDirection = new THREE.Vector3();
const ikTargetDirection = new THREE.Vector3();
const ikDeltaRotation = new THREE.Quaternion();
const ikLimitedRotation = new THREE.Quaternion();
const ikParentWorldRotation = new THREE.Quaternion();
const ikParentWorldRotationInverse = new THREE.Quaternion();
const ikLocalDelta = new THREE.Quaternion();
const ikIdentityRotation = new THREE.Quaternion();
const mountTorsoRestInverse = new THREE.Quaternion();
const mountTorsoLocalDelta = new THREE.Quaternion();
const mountTorsoStabilizerEuler = new THREE.Euler(0, 0, 0, 'XYZ');
const emptyIkWeights = {
  hands: 0,
  feet: 0,
  leftHand: 0,
  rightHand: 0,
  leftFoot: 0,
  rightFoot: 0,
  snapHands: false,
  time: 0,
};

export class MaraAnimationController {
  constructor({ mixer, clips, modelRoot, skeletonSource = 'mixamo' }) {
    this.mixer = mixer;
    this.clips = clips;
    this.modelRoot = modelRoot;
    this.skeletonSource = skeletonSource;
    this.baseModelPosition = modelRoot?.position.clone() ?? new THREE.Vector3();
    this.baseModelQuaternion = modelRoot?.quaternion.clone() ?? new THREE.Quaternion();
    this.baseModelY = modelRoot?.position.y ?? 0;
    this.footGroundingOffset = 0;
    this.landingVisualOffset = 0;
    this.traversalVisualOffset = new THREE.Vector3();
    this.topOutFootPlantTimer = 0;
    this.footBones = FOOT_BONE_NAMES
      .map((name) => modelRoot?.getObjectByName(name))
      .filter(Boolean);
    this.handBones = HAND_BONE_NAMES
      .map((name) => modelRoot?.getObjectByName(name))
      .filter(Boolean);
    this.mountTorsoStabilizerBones = MOUNT_TORSO_STABILIZER_BONES
      .map((name) => modelRoot?.getObjectByName(name))
      .filter(Boolean);
    this.mountTorsoStabilizerRestPose = this.mountTorsoStabilizerBones.map((bone) => ({
      bone,
      quaternion: bone.quaternion.clone(),
    }));
    this.spineStabilizerBones = ARMED_SPINE_STABILIZER_BONES
      .map((name) => modelRoot?.getObjectByName(name))
      .filter(Boolean);
    this.spineStableQuats = new Map();
    this.contactBones = [...new Set([...HAND_BONE_NAMES, ...FOOT_BONE_NAMES])]
      .map((name) => modelRoot?.getObjectByName(name))
      .filter(Boolean);
    this.contactIkChains = buildContactIkChains(modelRoot);
    this.lastHangIkWeights = emptyIkWeights;
    this.mirrorX = 1;
    this.actions = new Map();
    this.actionSettings = new Map();
    this.lowerActions = new Map();
    this.upperActions = new Map();
    this.currentAction = null;
    this.currentState = 'loading';
    this.upperBodyAction = null;
    this.upperBodyState = null;
    this.layered = false;
    // Leg overlay for attack/draw/sheathe legs
    this.attackLegAction = null;
    this.attackLegState = null;
    this.attackLegWeight = 0;
    this.attackLegTarget = 0;

    for (const [state, entry] of clips) {
      const clip = entry.clip ?? entry;
      const loop = entry.loop !== false;
      const pingPong = loop && entry.pingPong === true;
      const loopMode = loop ? (pingPong ? THREE.LoopPingPong : THREE.LoopRepeat) : THREE.LoopOnce;
      const action = mixer.clipAction(clip);
      action.enabled = true;
      action.setLoop(loopMode, Infinity);
      action.clampWhenFinished = !loop;
      this.actions.set(state, action);
      this.actionSettings.set(state, {
        fadeIn: entry.fadeIn ?? DEFAULT_FADE_SECONDS,
        timeScale: entry.timeScale ?? 1,
        reversed: entry.reversed === true,
        transitions: entry.transitions ?? {},
      });

      // Masked variants for upper/lower body layering (disjoint track sets).
      const lowerAction = mixer.clipAction(filterClipByBody(clip, true));
      const upperAction = mixer.clipAction(filterClipByBody(clip, false));
      lowerAction.enabled = true;
      upperAction.enabled = true;
      lowerAction.setLoop(loopMode, Infinity);
      upperAction.setLoop(loopMode, Infinity);
      lowerAction.clampWhenFinished = !loop;
      upperAction.clampWhenFinished = !loop;
      this.lowerActions.set(state, lowerAction);
      this.upperActions.set(state, upperAction);
    }
  }

  addClips(additionalClips) {
    if (!additionalClips) return;
    for (const [state, entry] of additionalClips) {
      if (this.actions.has(state)) continue;
      const clip = entry.clip ?? entry;
      const loop = entry.loop !== false;
      const pingPong = loop && entry.pingPong === true;
      const loopMode = loop ? (pingPong ? THREE.LoopPingPong : THREE.LoopRepeat) : THREE.LoopOnce;
      const action = this.mixer.clipAction(clip);
      action.enabled = true;
      action.setLoop(loopMode, Infinity);
      action.clampWhenFinished = !loop;
      this.actions.set(state, action);
      this.actionSettings.set(state, {
        fadeIn: entry.fadeIn ?? DEFAULT_FADE_SECONDS,
        timeScale: entry.timeScale ?? 1,
        reversed: entry.reversed === true,
        transitions: entry.transitions ?? {},
      });

      const lowerAction = this.mixer.clipAction(filterClipByBody(clip, true));
      const upperAction = this.mixer.clipAction(filterClipByBody(clip, false));
      lowerAction.enabled = true;
      upperAction.enabled = true;
      lowerAction.setLoop(loopMode, Infinity);
      upperAction.setLoop(loopMode, Infinity);
      lowerAction.clampWhenFinished = !loop;
      upperAction.clampWhenFinished = !loop;
      this.lowerActions.set(state, lowerAction);
      this.upperActions.set(state, upperAction);
    }
  }

  start() {
    this.play('idle', 0);
  }

  update(delta) {
    // Ramp the leg-overlay weight toward its target (set by setAttackLegs).
    if (this.attackLegAction) {
      const k = 1 - Math.exp(-ATTACK_LEG_SMOOTHING * delta);
      this.attackLegWeight += (this.attackLegTarget - this.attackLegWeight) * k;
      if (this.attackLegTarget <= 0 && this.attackLegWeight < 0.01) {
        this.attackLegWeight = 0;
      }
    } else {
      this.attackLegWeight = 0;
    }

    // Cleanup faded overlay: once weight is negligible and target is to clear,
    // stop the action so it doesn't linger.
    if (this.attackLegAction && this.attackLegWeight < 0.01 && this.attackLegTarget <= 0) {
      this.attackLegAction.stop();
      this.attackLegAction = null;
      this.attackLegState = null;
    }

    // Weight assignment:
    // - While overlay active and significant weight: suppress base locomotion,
    //   give weight to the attack/draw/sheathe leg overlay.
    // - Otherwise (no overlay, or fully faded, or clearing): ensure locomotion
    //   base always has weight 1 so legs never freeze static after attack.
    if (this.attackLegAction && this.attackLegWeight > 0.001 && this.currentAction) {
      this.currentAction.setEffectiveWeight(1 - this.attackLegWeight);
      this.attackLegAction.setEffectiveWeight(this.attackLegWeight);
    } else if (this.currentAction) {
      this.currentAction.setEffectiveWeight(1);
      if (this.attackLegAction) {
        this.attackLegAction.setEffectiveWeight(0);
      }
    }

    this.mixer.update(delta);
  }

  setMirrorX(mirror = false) {
    const target = mirror ? -1 : 1;

    if (!this.modelRoot || this.mirrorX === target) {
      return;
    }

    this.mirrorX = target;
    this.modelRoot.scale.x = Math.abs(this.modelRoot.scale.x || 1) * target;
    this.modelRoot.updateMatrixWorld(true);
  }

  applyFootGrounding({ state, groundHeight, characterHeight, delta }) {
    if (!this.modelRoot || !this.footBones.length) {
      return;
    }

    const baseGroundingSettings = FOOT_GROUNDING_SETTINGS[state];
    const groundingSettings = this.topOutFootPlantTimer > 0
      ? TOP_OUT_FOOT_PLANT_SETTINGS
      : baseGroundingSettings;
    const closeEnoughToGround = characterHeight - groundHeight < (groundingSettings?.maxGroundDistance ?? 0);
    const shouldGroundFeet = Boolean(groundingSettings) && closeEnoughToGround;
    const measuredTargetOffset = shouldGroundFeet
      ? this.measureFootGroundingOffset(groundHeight, groundingSettings)
      : 0;
    const targetOffset = this.landingVisualOffset > LANDING_VISUAL_OFFSET_EPSILON
      ? Math.max(0, measuredTargetOffset)
      : measuredTargetOffset;
    const smoothing = shouldGroundFeet ? groundingSettings.smoothing : FOOT_GROUNDING_RELEASE_SMOOTHING;

    this.footGroundingOffset = THREE.MathUtils.lerp(
      this.footGroundingOffset,
      targetOffset,
      1 - Math.exp(-smoothing * delta),
    );
    this.updateLandingVisualOffset(delta);
    this.updateTraversalVisualOffset(delta);
    this.topOutFootPlantTimer = Math.max(0, this.topOutFootPlantTimer - delta);
    this.applyModelVisualOffset();
  }

  plantFeetOnTopOut(groundHeight) {
    if (!this.modelRoot || !this.footBones.length || !Number.isFinite(groundHeight)) {
      return;
    }

    this.topOutFootPlantTimer = TOP_OUT_FOOT_PLANT_SECONDS;
    this.footGroundingOffset = this.measureFootGroundingOffset(
      groundHeight,
      TOP_OUT_FOOT_PLANT_SETTINGS,
    );
    this.applyModelVisualOffset();
  }

  addLandingVisualOffset(offset) {
    if (!Number.isFinite(offset) || offset <= LANDING_VISUAL_OFFSET_EPSILON) {
      return;
    }

    this.footGroundingOffset = Math.max(0, this.footGroundingOffset);
    this.landingVisualOffset = Math.max(
      this.landingVisualOffset,
      THREE.MathUtils.clamp(offset, 0, LANDING_VISUAL_OFFSET_MAX),
    );
  }

  updateLandingVisualOffset(delta) {
    if (this.landingVisualOffset <= LANDING_VISUAL_OFFSET_EPSILON) {
      this.landingVisualOffset = 0;
      return;
    }

    this.landingVisualOffset = THREE.MathUtils.lerp(
      this.landingVisualOffset,
      0,
      1 - Math.exp(-LANDING_VISUAL_OFFSET_SMOOTHING * delta),
    );
  }

  addTraversalVisualOffset(offset) {
    if (!this.modelRoot || !offset || offset.lengthSq?.() <= TRAVERSAL_VISUAL_OFFSET_EPSILON ** 2) {
      return;
    }

    this.traversalVisualOffset.set(
      0,
      THREE.MathUtils.clamp(offset.y, -TRAVERSAL_VISUAL_OFFSET_MAX, TRAVERSAL_VISUAL_OFFSET_MAX),
      0,
    );
    this.applyModelVisualOffset();
  }

  updateTraversalVisualOffset(delta) {
    if (this.traversalVisualOffset.lengthSq() <= TRAVERSAL_VISUAL_OFFSET_EPSILON ** 2) {
      this.traversalVisualOffset.set(0, 0, 0);
      return;
    }

    this.traversalVisualOffset.lerp(
      modelVisualOffset.set(0, 0, 0),
      1 - Math.exp(-TRAVERSAL_VISUAL_OFFSET_SMOOTHING * delta),
    );
  }

  applyModelVisualOffset() {
    if (!this.modelRoot) {
      return;
    }

    this.modelRoot.position.set(
      this.baseModelPosition.x,
      this.baseModelY + this.footGroundingOffset + this.landingVisualOffset + this.traversalVisualOffset.y,
      this.baseModelPosition.z,
    );
  }

  sampleRootMotionDelta(delta) {
    if (!this.currentAction) {
      return null;
    }

    const clip = this.currentAction.getClip();
    const rootMotion = clip.userData?.rootMotion;

    if (!rootMotion) {
      return null;
    }

    const settings = this.actionSettings.get(this.currentState) ?? {};
    const effectiveTimeScale = this.currentAction.getEffectiveTimeScale?.() ?? settings.timeScale ?? 1;
    const isReversed = settings.reversed === true || effectiveTimeScale < 0;
    const timeScale = isReversed
      ? -Math.abs(effectiveTimeScale)
      : Math.abs(effectiveTimeScale);
    const startTime = this.currentAction.time;
    const scaledDelta = delta * timeScale;
    const endTime = startTime + scaledDelta;

    if (Math.abs(scaledDelta) <= 0 || clip.duration <= 0) {
      return null;
    }

    sampleLoopingRootMotionDelta({
      rootMotion,
      startTime: isReversed ? endTime : startTime,
      endTime: isReversed ? startTime : endTime,
      duration: clip.duration,
      target: rootMotionEnd,
    });

    if (isReversed) {
      rootMotionEnd.negate();
    }

    const normalizedEndTime = timeScale < 0
      ? 1 - THREE.MathUtils.clamp(endTime / clip.duration, 0, 1)
      : THREE.MathUtils.clamp(endTime / clip.duration, 0, 1);

    return {
      delta: rootMotionEnd.clone(),
      totalDelta: rootMotionTotal
        .fromArray(rootMotion.totalValues)
        .multiplyScalar(isReversed ? -1 : 1)
        .clone(),
      blend: rootMotion.blend,
      drive: rootMotion.drive,
      normalizedEndTime,
    };
  }

  play(state, fadeSeconds) {
    // When layered (armed), the base drives only the lower body so the upper-body
    // overlay can own the torso/arms. Otherwise play the full clip.
    const map = this.layered ? this.lowerActions : this.actions;
    // The quad has its own gameplay pose state while intentionally reusing the
    // stable seated horse clip; its hand/foot IK profile makes the final pose ATV-specific.
    const actionState = state === 'drivingQuad' ? 'ridingHorse' : state;
    const nextAction = map.get(actionState) ?? this.actions.get(actionState);
    const currentSettings = this.actionSettings.get(this.currentState) ?? {};
    const settings = this.actionSettings.get(state) ?? this.actionSettings.get(actionState) ?? {};
    const transition = currentSettings.transitions?.[state] ?? {};
    const fade = fadeSeconds ?? transition.fade ?? settings.fadeIn ?? DEFAULT_FADE_SECONDS;

    if (!nextAction || nextAction === this.currentAction) {
      return;
    }

    const reversed = settings.reversed === true;
    const timeScale = Math.abs(settings.timeScale ?? 1);

    nextAction.reset();
    if (Number.isFinite(transition.startAt)) {
      nextAction.time = Math.min(Math.max(transition.startAt, 0), nextAction.getClip().duration);
    } else if (reversed) {
      nextAction.time = nextAction.getClip().duration;
    }
    nextAction.setEffectiveTimeScale(reversed ? -timeScale : timeScale);
    nextAction.setEffectiveWeight(1);
    nextAction.fadeIn(fade);
    nextAction.play();

    if (this.currentAction) {
      this.currentAction.crossFadeTo(nextAction, fade, transition.warp === true);
    }

    this.currentAction = nextAction;
    this.currentState = state;
  }

  hasState(state) {
    return this.actions.has(state);
  }

  // Toggle armed mode: when layered, play() uses lower-body-masked clips so the
  // upper-body overlay (setUpperBodyState) can drive the torso/arms.
  setLayered(layered) {
    this.layered = layered === true;
  }

  getUpperBodyNormalizedTime() {
    const action = this.upperBodyAction;
    if (!action) {
      return 0;
    }
    const duration = action.getClip()?.duration ?? 0;
    if (duration <= 0) return 0;
    let t = action.time / duration;
    // Support reversed clips (e.g. sheathe) by returning progress toward the "end"
    // of playback (0 at start of clip play, 1 near completion).
    const ts = action.getEffectiveTimeScale?.() ?? 1;
    if (ts < 0) {
      t = 1 - t;
    }
    return t;
  }

  setUpperBodyState(state, fadeSeconds = 0.15) {
    if (this.upperBodyState === state) {
      return;
    }

    if (!state) {
      this.upperBodyState = null;
      if (this.upperBodyAction) {
        this.upperBodyAction.fadeOut(fadeSeconds);
        this.upperBodyAction = null;
      }
      return;
    }

    // Upper-body-masked clip (torso/arms only). Weight 1 is correct: its tracks
    // are disjoint from the lower-body base, so they never compete for a bone.
    const nextAction = this.upperActions.get(state);
    if (!nextAction) {
      this.upperBodyState = null;
      if (this.upperBodyAction) {
        this.upperBodyAction.fadeOut(fadeSeconds);
        this.upperBodyAction = null;
      }
      return;
    }
    this.upperBodyState = state;

    const settings = this.actionSettings.get(state) ?? {};
    const fade = fadeSeconds ?? settings.fadeIn ?? DEFAULT_FADE_SECONDS;
    const reversed = settings.reversed === true;
    const timeScale = Math.abs(settings.timeScale ?? 1);

    nextAction.reset();
    if (reversed) {
      nextAction.time = nextAction.getClip().duration;
    }
    nextAction.setEffectiveTimeScale(reversed ? -timeScale : timeScale);
    nextAction.setEffectiveWeight(1);
    nextAction.fadeIn(fade);
    nextAction.play();

    if (this.upperBodyAction && this.upperBodyAction !== nextAction) {
      this.upperBodyAction.crossFadeTo(nextAction, fade, false);
    }

    this.upperBodyAction = nextAction;
  }

  // Set the leg-overlay clip (an override's lower-masked clip) and its target
  // weight. AnimationStateSystem passes target = (1 - moveBlend) so the override's
  // legs dominate when standing and fade out as the player moves. state=null keeps
  // the action fading to 0.
  setAttackLegs(state, targetWeight = 0) {
    if (state !== this.attackLegState) {
      const next = state ? (this.lowerActions.get(state) ?? null) : null;
      if (next) {
        // Installing a new leg overlay (attack/draw/sheathe footwork).
        if (this.attackLegAction && this.attackLegAction !== next) {
          this.attackLegAction.stop();
        }
        this.attackLegAction = next;
        this.attackLegState = state;
        const settings = this.actionSettings.get(state) ?? {};
        const reversed = settings.reversed === true;
        const timeScale = Math.abs(settings.timeScale ?? 1);
        next.reset();
        if (reversed) {
          next.time = next.getClip().duration;
        }
        next.setEffectiveTimeScale(reversed ? -timeScale : timeScale);
        next.setEffectiveWeight(this.attackLegWeight);
        next.play();
      } else {
        // Clearing overlay (attack finished): keep the current attackLegAction
        // reference so the ramp can continue fading its weight and restore the
        // locomotion base weight. Actual stop/null happens in update when weight ~0.
        this.attackLegState = null;
        if (state) {
          targetWeight = 0;
        }
      }
    }
    this.attackLegTarget = Math.max(0, Math.min(1, targetWeight));
  }

  durationFor(state) {
    const duration = this.actions.get(state)?.getClip?.()?.duration ?? null;
    const timeScale = Math.abs(this.actionSettings.get(state)?.timeScale ?? 1);
    return Number.isFinite(duration) && timeScale > 0 ? duration / timeScale : duration;
  }

  hasAnimation(state) {
    return this.actions.has(state);
  }

  snapshot() {
    return {
      source: this.modelRoot?.parent?.name?.includes('GLB') || this.modelRoot?.name?.includes('GLB') ? 'glb' : 'fbx',
      skeletonSource: this.skeletonSource,
      currentState: this.currentState,
      upperBodyState: this.upperBodyState,
      attackLegState: this.attackLegState,
      attackLegWeight: Number(this.attackLegWeight.toFixed(3)),
      attackLegTarget: Number(this.attackLegTarget.toFixed(3)),
      currentActionWeight: this.currentAction?.getEffectiveWeight?.() ?? null,
      attackLegActionWeight: this.attackLegAction?.getEffectiveWeight?.() ?? null,
      attackLegTrackCount: this.attackLegAction?.getClip()?.tracks?.length ?? 0,
      attackLegSampleTracks: (this.attackLegAction?.getClip()?.tracks ?? []).slice(0, 3).map((t) => t.name),
      mirrorX: this.mirrorX,
      availableStates: [...this.actions.keys()],
      footGroundingOffset: Number(this.footGroundingOffset.toFixed(3)),
      landingVisualOffset: Number(this.landingVisualOffset.toFixed(3)),
      traversalVisualOffset: {
        x: Number(this.traversalVisualOffset.x.toFixed(3)),
        y: Number(this.traversalVisualOffset.y.toFixed(3)),
        z: Number(this.traversalVisualOffset.z.toFixed(3)),
      },
      topOutFootPlantTimer: Number(this.topOutFootPlantTimer.toFixed(3)),
      modelYOffset: Number(((this.modelRoot?.position.y ?? this.baseModelY) - this.baseModelY).toFixed(3)),
      hangIk: {
        hands: Number(this.lastHangIkWeights.hands.toFixed(2)),
        feet: Number(this.lastHangIkWeights.feet.toFixed(2)),
        leftHand: Number(this.lastHangIkWeights.leftHand.toFixed(2)),
        rightHand: Number(this.lastHangIkWeights.rightHand.toFixed(2)),
        leftFoot: Number(this.lastHangIkWeights.leftFoot.toFixed(2)),
        rightFoot: Number(this.lastHangIkWeights.rightFoot.toFixed(2)),
        snapHands: this.lastHangIkWeights.snapHands === true,
        time: Number(this.lastHangIkWeights.time.toFixed(2)),
      },
      handAnchors: this.measureHandAnchors(),
      contactAnchors: this.measureContactAnchors(),
    };
  }

  dispose() {
    this.mixer.stopAllAction();
    this.actions.clear();
    this.actionSettings.clear();
    if (this.upperBodyAction) {
      this.upperBodyAction.stop();
    }
    this.upperBodyAction = null;
    this.upperBodyState = null;
    if (this.attackLegAction) {
      this.attackLegAction.stop();
    }
    this.attackLegAction = null;
    this.attackLegState = null;
    this.attackLegWeight = 0;
    this.attackLegTarget = 0;
    if (this.modelRoot) {
      this.modelRoot.position.copy(this.baseModelPosition);
    }
    this.topOutFootPlantTimer = 0;
    this.landingVisualOffset = 0;
    this.traversalVisualOffset.set(0, 0, 0);
  }

  measureFootGroundingOffset(groundHeight, settings) {
    this.modelRoot.updateMatrixWorld(true);

    let lowestFootY = Infinity;

    for (const bone of this.footBones) {
      bone.getWorldPosition(footWorldPosition);
      lowestFootY = Math.min(lowestFootY, footWorldPosition.y);
    }

    if (!Number.isFinite(lowestFootY)) {
      return 0;
    }

    // Include playerGroundOffset so the visual model sits lower/higher than
    // the raw ground snap (negative lowers to stop floating).
    const playerGroundOffset = GAME_CONFIG.character.playerGroundOffset ?? 0;
    return THREE.MathUtils.clamp(
      this.footGroundingOffset + (groundHeight + playerGroundOffset) - lowestFootY,
      -settings.maxDrop,
      settings.maxRaise,
    );
  }

  measureHandAnchors() {
    if (!this.modelRoot || !this.handBones?.length) {
      return null;
    }

    this.modelRoot.updateMatrixWorld(true);

    return this.handBones.map((bone) => {
      bone.getWorldPosition(handWorldPosition);

      return {
        name: bone.name,
        x: Number(handWorldPosition.x.toFixed(3)),
        y: Number(handWorldPosition.y.toFixed(3)),
        z: Number(handWorldPosition.z.toFixed(3)),
      };
    });
  }

  measureContactAnchors() {
    if (!this.modelRoot || !this.contactBones?.length) {
      return null;
    }

    this.modelRoot.updateMatrixWorld(true);

    return this.contactBones.map((bone) => {
      bone.getWorldPosition(contactWorldPosition);

      return {
        name: bone.name,
        x: Number(contactWorldPosition.x.toFixed(3)),
        y: Number(contactWorldPosition.y.toFixed(3)),
        z: Number(contactWorldPosition.z.toFixed(3)),
      };
    });
  }

  applyHangIk(hang) {
    if (!HANG_IK_ENABLED) {
      this.lastHangIkWeights = emptyIkWeights;
      return;
    }

    if (!this.modelRoot || !hang?.active || !hang.ledge) {
      this.lastHangIkWeights = emptyIkWeights;
      return;
    }

    const weights = this.resolveHangIkWeights(hang);
    this.lastHangIkWeights = weights;

    if (weights.hands <= 0 && weights.feet <= 0) {
      return;
    }

    const { ledge, along } = hang;
    ledgeNormal.set(ledge.normal.x, ledge.normal.y, ledge.normal.z);
    ledgeTangent.set(ledge.tangent.x, ledge.tangent.y, ledge.tangent.z);
    ledgePoint.set(
      ledge.axis === 'x' ? along : ledge.x,
      ledge.y,
      ledge.axis === 'z' ? along : ledge.z,
    );

    this.solveContactChain({
      key: 'leftHand',
      weight: weights.leftHand,
      targetPosition: hang.handTargets?.left,
      side: -1,
      spacing: HANG_IK_SETTINGS.handSpacing,
      yOffset: HANG_IK_SETTINGS.handYOffset,
      normalOffset: HANG_IK_SETTINGS.handNormalOffset,
      iterations: HANG_IK_SETTINGS.handIterations,
      maxAngle: weights.snapHands ? Math.PI : null,
    });
    this.solveContactChain({
      key: 'rightHand',
      weight: weights.rightHand,
      targetPosition: hang.handTargets?.right,
      side: 1,
      spacing: HANG_IK_SETTINGS.handSpacing,
      yOffset: HANG_IK_SETTINGS.handYOffset,
      normalOffset: HANG_IK_SETTINGS.handNormalOffset,
      iterations: HANG_IK_SETTINGS.handIterations,
      maxAngle: weights.snapHands ? Math.PI : null,
    });
    this.solveContactChain({
      key: 'leftFoot',
      weight: weights.leftFoot,
      side: -1,
      spacing: HANG_IK_SETTINGS.footSpacing,
      yOffset: -HANG_IK_SETTINGS.footDrop,
      normalOffset: HANG_IK_SETTINGS.footNormalOffset,
      iterations: HANG_IK_SETTINGS.footIterations,
    });
    this.solveContactChain({
      key: 'rightFoot',
      weight: weights.rightFoot,
      side: 1,
      spacing: HANG_IK_SETTINGS.footSpacing,
      yOffset: -HANG_IK_SETTINGS.footDrop,
      normalOffset: HANG_IK_SETTINGS.footNormalOffset,
      iterations: HANG_IK_SETTINGS.footIterations,
    });
  }

  applyVaultIk(vault) {
    if (!HANG_IK_ENABLED || !this.modelRoot || !vault?.active || !vault.handTargets) {
      return;
    }

    const profile = VAULT_IK_PROFILES[this.currentState];

    if (!profile) {
      return;
    }

    const normalizedTime = THREE.MathUtils.clamp(
      vault.action?.progress ?? this.getCurrentActionNormalizedTime(),
      0,
      1,
    );
    const leftHand = resolveIkTrackWeight(profile.leftHand ?? profile.hands, normalizedTime);
    const rightHand = resolveIkTrackWeight(profile.rightHand ?? profile.hands, normalizedTime);
    const hands = Math.max(leftHand, rightHand);

    this.lastHangIkWeights = {
      hands,
      feet: 0,
      leftHand,
      rightHand,
      leftFoot: 0,
      rightFoot: 0,
      snapHands: hands >= (profile.snapAt ?? 0.8),
      time: normalizedTime,
    };

    if (hands <= 0) {
      return;
    }

    const direction = vault.candidate?.direction;

    if (!direction) {
      return;
    }

    ledgeNormal.set(-direction.x, 0, -direction.z);
    if (ledgeNormal.lengthSq() <= 0.0001) {
      ledgeNormal.set(0, 0, 1);
    } else {
      ledgeNormal.normalize();
    }

    ledgeTangent.set(direction.z, 0, -direction.x);
    if (ledgeTangent.lengthSq() <= 0.0001) {
      ledgeTangent.set(1, 0, 0);
    } else {
      ledgeTangent.normalize();
    }

    const leftTarget = resolveVaultIkTarget({
      vault,
      targetKey: profile.leftTarget,
      fallback: profile.swapTargets === true ? 'right' : 'left',
    });
    const rightTarget = resolveVaultIkTarget({
      vault,
      targetKey: profile.rightTarget,
      fallback: profile.swapTargets === true ? 'left' : 'right',
    });

    this.solveContactChain({
      key: 'leftHand',
      weight: leftHand,
      targetPosition: leftTarget,
      side: -1,
      spacing: HANG_IK_SETTINGS.handSpacing,
      yOffset: HANG_IK_SETTINGS.handYOffset,
      normalOffset: HANG_IK_SETTINGS.handNormalOffset,
      iterations: HANG_IK_SETTINGS.handIterations,
      maxAngle: hands >= (profile.snapAt ?? 0.8) ? Math.PI : null,
    });
    this.solveContactChain({
      key: 'rightHand',
      weight: rightHand,
      targetPosition: rightTarget,
      side: 1,
      spacing: HANG_IK_SETTINGS.handSpacing,
      yOffset: HANG_IK_SETTINGS.handYOffset,
      normalOffset: HANG_IK_SETTINGS.handNormalOffset,
      iterations: HANG_IK_SETTINGS.handIterations,
      maxAngle: hands >= (profile.snapAt ?? 0.8) ? Math.PI : null,
    });
  }

  applyMountIk(mount) {
    if (!HANG_IK_ENABLED || !this.modelRoot || !mount?.active
      || (!mount.handTargets && !mount.footTargets)) {
      return;
    }

    const profile = MOUNT_IK_PROFILE[this.currentState];

    if (!profile) {
      return;
    }

    const normalizedTime = this.getCurrentActionNormalizedTime();
    const leftHand = resolveIkTrackWeight(profile.leftHand ?? profile.hands, normalizedTime);
    const rightHand = resolveIkTrackWeight(profile.rightHand ?? profile.hands, normalizedTime);
    const hands = Math.max(leftHand, rightHand);
    const hasFootTargets = Boolean(mount.footTargets?.left && mount.footTargets?.right);
    const leftFoot = hasFootTargets ? 1 : 0;
    const rightFoot = hasFootTargets ? 1 : 0;

    this.lastHangIkWeights = {
      hands,
      feet: Math.max(leftFoot, rightFoot),
      leftHand,
      rightHand,
      leftFoot,
      rightFoot,
      snapHands: hands >= 0.95,
      time: normalizedTime,
    };

    if (hands <= 0 && !hasFootTargets) {
      return;
    }

    if (mount.handTargets.tangent) {
      ledgeTangent.copy(mount.handTargets.tangent);
    } else {
      ledgeTangent.set(1, 0, 0);
    }

    if (mount.handTargets.normal) {
      ledgeNormal.copy(mount.handTargets.normal);
    } else {
      ledgeNormal.set(0, 0, 1);
    }

    if (ledgeTangent.lengthSq() <= 0.0001) {
      ledgeTangent.set(1, 0, 0);
    } else {
      ledgeTangent.normalize();
    }

    if (ledgeNormal.lengthSq() <= 0.0001) {
      ledgeNormal.set(0, 0, 1);
    } else {
      ledgeNormal.normalize();
    }

    if (mount.handTargets) {
      this.solveContactChain({
        key: 'leftHand', weight: leftHand,
        targetPosition: mount.handTargets.left ?? mount.handTargets.center,
        side: -1, poleSide: -1, spacing: 0, yOffset: 0, normalOffset: 0,
        iterations: HANG_IK_SETTINGS.handIterations,
        maxAngle: hands >= 0.95 ? Math.PI : null,
      });
      this.solveContactChain({
        key: 'rightHand', weight: rightHand,
        targetPosition: mount.handTargets.right ?? mount.handTargets.center,
        side: 1, poleSide: -1, spacing: 0, yOffset: 0, normalOffset: 0,
        iterations: HANG_IK_SETTINGS.handIterations,
        maxAngle: hands >= 0.95 ? Math.PI : null,
      });
    }
    if (hasFootTargets) {
      this.solveContactChain({
        key: 'leftFoot', weight: leftFoot, targetPosition: mount.footTargets.left,
        side: -1, poleSide: 1, spacing: 0, yOffset: 0, normalOffset: 0,
        iterations: 4, maxAngle: Math.PI,
      });
      this.solveContactChain({
        key: 'rightFoot', weight: rightFoot, targetPosition: mount.footTargets.right,
        side: 1, poleSide: 1, spacing: 0, yOffset: 0, normalOffset: 0,
        iterations: 4, maxAngle: Math.PI,
      });
    }
  }

  applyMountTorsoStabilizer(mount) {
    if (!this.modelRoot || !mount?.active || !this.mountTorsoStabilizerBones.length) {
      return;
    }

    this.modelRoot.quaternion.copy(this.baseModelQuaternion);

    if (MOUNT_CORE_LOCKED_STATES.has(this.currentState)) {
      restoreChainPose(this.mountTorsoStabilizerRestPose);
      this.modelRoot.updateMatrixWorld(true);
      return;
    }

    if (!mount.torsoStabilizerPose || mount.torsoStabilizerState !== this.currentState) {
      mount.torsoStabilizerState = this.currentState;
      mount.torsoStabilizerPose = captureMountTorsoStabilizerPose(
        this.mountTorsoStabilizerBones,
        this.mountTorsoStabilizerRestPose,
      );
      this.modelRoot.updateMatrixWorld(true);
      return;
    }

    for (const entry of mount.torsoStabilizerPose) {
      entry.bone.quaternion.copy(entry.quaternion);
    }

    this.modelRoot.updateMatrixWorld(true);
  }

  /**
   * Stabilize the spine/torso for armed locomotion.
   * When legs are playing locomotion (jog/idle/etc) the upper armed clip's
   * spine animation can cause visible wobbling/bobbing at the hips-spine
   * junction. This damps the spine motion to make the upper body behave more
   * like a rigid "car body without shocks" while the legs do the work.
   */
  applyArmedSpineStabilizer() {
    if (!this.layered || !this.spineStabilizerBones.length) {
      return;
    }

    // Heavy low-pass / inertia filter on spine quats during armed locomotion.
    // Lower value = stiffer torso (less of the run/walk clip's per-stride
    // spine wobble/bob gets through). 0.12-0.18 seems good range.
    // This directly targets the "stride of the run or walk" wobble you mentioned.
    const filterStrength = 0.14;

    for (const bone of this.spineStabilizerBones) {
      if (!bone) continue;

      let filtered = this.spineStableQuats.get(bone.name);
      const animated = bone.quaternion;

      if (!filtered) {
        filtered = animated.clone();
        this.spineStableQuats.set(bone.name, filtered);
      } else {
        // Slowly blend the live animated spine into our filtered version.
        // Result: the upper body keeps the overall armed run posture but
        // the high-frequency stride oscillations are heavily damped.
        filtered.slerp(animated, filterStrength);
      }

      bone.quaternion.copy(filtered);
    }

    this.modelRoot.updateMatrixWorld(true);
  }

  applyWallRunIk(wallRun) {
    if (!HANG_IK_ENABLED || !this.modelRoot || !wallRun?.active || !wallRun.handTarget || !wallRun.surface) {
      return;
    }

    const handSide = wallRun.handSide === 'left' ? 'leftHand' : 'rightHand';
    const side = handSide === 'leftHand' ? -1 : 1;
    const weight = 1;
    this.applyWallRunArmStabilizer({ wallRun, handSide });

    ledgeNormal.copy(wallRun.surface.normal);
    ledgeTangent.copy(wallRun.surface.tangent).multiplyScalar(wallRun.direction || 1);

    this.lastHangIkWeights = {
      hands: weight,
      feet: 0,
      leftHand: handSide === 'leftHand' ? weight : 0,
      rightHand: handSide === 'rightHand' ? weight : 0,
      leftFoot: 0,
      rightFoot: 0,
      snapHands: true,
      time: 1,
    };

    this.solveContactChain({
      key: handSide,
      weight,
      targetPosition: wallRun.handTarget,
      side,
      spacing: HANG_IK_SETTINGS.handSpacing,
      yOffset: HANG_IK_SETTINGS.handYOffset,
      normalOffset: HANG_IK_SETTINGS.handNormalOffset,
      iterations: Math.max(HANG_IK_SETTINGS.handIterations, 5),
      maxAngle: Math.PI,
    });
  }

  applyWallRunArmStabilizer({ wallRun, handSide }) {
    const chain = this.contactIkChains[handSide];

    if (!chain) {
      return;
    }

    if (wallRun.stabilizedArmSide !== handSide || !Array.isArray(wallRun.stabilizedArmPose)) {
      wallRun.stabilizedArmSide = handSide;
      wallRun.stabilizedArmPose = captureChainPose(chain);
      return;
    }

    restoreChainPose(wallRun.stabilizedArmPose);
    this.modelRoot.updateMatrixWorld(true);
  }

  solveContactChain({
    key,
    weight,
    targetPosition,
    side,
    spacing,
    yOffset,
    normalOffset,
    iterations,
    maxAngle,
    poleSide = side,
  }) {
    const chain = this.contactIkChains[key];

    if (!chain || weight <= 0) {
      return;
    }

    if (targetPosition) {
      ikTarget.copy(targetPosition);
    } else {
      ikTarget
        .copy(ledgePoint)
        .addScaledVector(ledgeTangent, side * spacing)
        .addScaledVector(ledgeNormal, normalOffset);
      ikTarget.y += yOffset;
    }
    chain.effector.getWorldPosition(ikEffectorPosition);
    ikWeightedTarget.copy(ikEffectorPosition).lerp(ikTarget, THREE.MathUtils.clamp(weight, 0, 1));
    const resolvedMaxAngle = Number.isFinite(maxAngle)
      ? maxAngle
      : HANG_IK_SETTINGS.maxAnglePerStep * THREE.MathUtils.clamp(weight, 0.15, 1);

    if (chain.upper && chain.lower) {
      ikPoleDirection
        .copy(ledgeTangent)
        .multiplyScalar(poleSide)
        .addScaledVector(ledgeNormal, 0.18);
      ikPoleDirection.y -= 0.45;

      solveTwoBoneArmIk({
        root: this.modelRoot,
        upper: chain.upper,
        lower: chain.lower,
        effector: chain.effector,
        target: ikWeightedTarget,
        poleDirection: ikPoleDirection,
        maxAngle: resolvedMaxAngle,
      });
      return;
    }

    solveCcdIk({
      root: this.modelRoot,
      effector: chain.effector,
      links: chain.links,
      target: ikWeightedTarget,
      iterations,
      maxAngle: resolvedMaxAngle,
    });
  }

  resolveHangIkWeights(hang = null) {
    if (!hang?.active) {
      return emptyIkWeights;
    }

    const profile = HANG_IK_PROFILES[this.currentState] ?? defaultHangIkProfileFor(hang);
    const normalizedTime = this.getHangIkNormalizedTime(hang);

    const leftHand = resolveIkTrackWeight(profile.leftHand ?? profile.hands, normalizedTime);
    const rightHand = resolveIkTrackWeight(profile.rightHand ?? profile.hands, normalizedTime);
    const leftFoot = HANG_FOOT_IK_ENABLED
      ? resolveIkTrackWeight(profile.leftFoot ?? profile.feet, normalizedTime)
      : 0;
    const rightFoot = HANG_FOOT_IK_ENABLED
      ? resolveIkTrackWeight(profile.rightFoot ?? profile.feet, normalizedTime)
      : 0;

    return {
      hands: Math.max(leftHand, rightHand),
      feet: Math.max(leftFoot, rightFoot),
      leftHand,
      rightHand,
      leftFoot,
      rightFoot,
      snapHands: shouldUseHardHandIk({
        profile,
        hang,
        state: this.currentState,
        normalizedTime,
      }),
      time: normalizedTime,
    };
  }

  getHangIkNormalizedTime(hang) {
    const duration = hang?.transitionDuration;

    if (Number.isFinite(duration) && duration > 0) {
      return THREE.MathUtils.clamp(1 - (hang.timer ?? 0) / duration, 0, 1);
    }

    return this.getCurrentActionNormalizedTime();
  }

  getCurrentActionNormalizedTime() {
    if (!this.currentAction) {
      return 0;
    }

    const duration = this.currentAction.getClip()?.duration ?? 0;

    if (duration <= 0) {
      return 0;
    }

    const settings = this.actionSettings.get(this.currentState) ?? {};
    const normalized = THREE.MathUtils.clamp(this.currentAction.time / duration, 0, 1);

    if (settings.reversed) {
      return 1 - normalized;
    }

    return normalized;
  }
}

function defaultHangIkProfileFor(hang) {
  return hang.mode === 'braced'
    ? { hands: 0.9, feet: 0.65 }
    : { hands: 0.9, feet: 0 };
}

function resolveVaultIkTarget({ vault, targetKey, fallback }) {
  return vault.handTargets?.[targetKey ?? fallback]
    ?? vault.handTargets?.[fallback]
    ?? vault.handTargets?.center
    ?? null;
}

function shouldUseHardHandIk({ profile, hang, state, normalizedTime }) {
  if (profile.snapHands === true && hang.transition === 'attach') {
    return true;
  }

  return hang.transition === 'climb'
    && isClimbUpHangState(state)
    && normalizedTime >= CLIMB_UP_HARD_HAND_IK_START;
}

function isClimbUpHangState(state) {
  return state === 'freeHangClimb' || state === 'bracedHangToCrouch';
}

function resolveIkTrackWeight(track, normalizedTime) {
  if (typeof track === 'number') {
    return THREE.MathUtils.clamp(track, 0, 1);
  }

  if (!track) {
    return 0;
  }

  if (Array.isArray(track)) {
    if (!track.length) {
      return 0;
    }

    let weight = track[0].from ?? 0;

    for (const segment of track) {
      const start = segment.start ?? 0;
      const end = segment.end ?? 1;

      if (normalizedTime < start) {
        break;
      }

      if (normalizedTime <= end) {
        return interpolateIkSegment(segment, normalizedTime);
      }

      weight = segment.to ?? weight;
    }

    return THREE.MathUtils.clamp(weight, 0, 1);
  }

  return interpolateIkSegment(track, normalizedTime);
}

function interpolateIkSegment(segment, normalizedTime) {
  const start = segment.start ?? 0;
  const end = segment.end ?? 1;
  const from = segment.from ?? 0;
  const to = segment.to ?? 1;
  const alpha = smoothStep(THREE.MathUtils.clamp((normalizedTime - start) / (end - start || 1), 0, 1));

  return THREE.MathUtils.clamp(THREE.MathUtils.lerp(from, to, alpha), 0, 1);
}

function smoothStep(value) {
  return value * value * (3 - 2 * value);
}

function buildContactIkChains(modelRoot) {
  if (!modelRoot) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(CONTACT_IK_CHAINS)
      .map(([key, definition]) => {
        const effector = modelRoot.getObjectByName(definition.effector);
        const upper = definition.upper ? modelRoot.getObjectByName(definition.upper) : null;
        const lower = definition.lower ? modelRoot.getObjectByName(definition.lower) : null;
        const links = definition.links
          .map((name) => modelRoot.getObjectByName(name))
          .filter(Boolean);

        if (!effector || !links.length) {
          return null;
        }

        return [key, { effector, upper, lower, links }];
      })
      .filter(Boolean),
  );
}

function captureChainPose(chain) {
  const bones = [...new Set([
    ...chain.links,
    chain.upper,
    chain.lower,
    chain.effector,
  ].filter(Boolean))];

  return bones.map((bone) => ({
    bone,
    quaternion: bone.quaternion.clone(),
  }));
}

function restoreChainPose(pose) {
  for (const entry of pose) {
    entry.bone.quaternion.copy(entry.quaternion);
  }
}

function captureMountTorsoStabilizerPose(bones, restPose) {
  return bones.map((bone, index) => {
    const restQuaternion = restPose?.[index]?.bone === bone
      ? restPose[index].quaternion
      : null;
    const quaternion = bone.quaternion.clone().normalize();

    if (restQuaternion) {
      mountTorsoRestInverse.copy(restQuaternion).invert();
      mountTorsoLocalDelta.copy(mountTorsoRestInverse).multiply(quaternion).normalize();
      mountTorsoStabilizerEuler.setFromQuaternion(mountTorsoLocalDelta, 'XYZ');
      mountTorsoStabilizerEuler.z = 0;
      mountTorsoLocalDelta.setFromEuler(mountTorsoStabilizerEuler).normalize();
      quaternion.copy(restQuaternion).multiply(mountTorsoLocalDelta).normalize();
    } else {
      mountTorsoStabilizerEuler.setFromQuaternion(quaternion, 'XYZ');
      mountTorsoStabilizerEuler.z = 0;
      quaternion.setFromEuler(mountTorsoStabilizerEuler).normalize();
    }

    return { bone, quaternion };
  });
}

function solveTwoBoneArmIk({ root, upper, lower, effector, target, poleDirection, maxAngle }) {
  root.updateMatrixWorld(true);
  upper.getWorldPosition(ikUpperPosition);
  lower.getWorldPosition(ikLowerPosition);
  effector.getWorldPosition(ikEffectorPosition);

  const upperLength = ikUpperPosition.distanceTo(ikLowerPosition);
  const lowerLength = ikLowerPosition.distanceTo(ikEffectorPosition);

  if (upperLength <= 0.0001 || lowerLength <= 0.0001) {
    return;
  }

  ikTargetOffset.copy(target).sub(ikUpperPosition);
  const maxReach = Math.max(0.0001, upperLength + lowerLength - 0.015);
  const minReach = Math.max(0.0001, Math.abs(upperLength - lowerLength) + 0.015);
  const targetDistance = THREE.MathUtils.clamp(ikTargetOffset.length(), minReach, maxReach);

  if (ikTargetOffset.lengthSq() <= 0.000001) {
    return;
  }

  ikReachDirection.copy(ikTargetOffset).normalize();
  ikPoleProjected
    .copy(poleDirection)
    .sub(ikReachDirection.clone().multiplyScalar(poleDirection.dot(ikReachDirection)));

  if (ikPoleProjected.lengthSq() <= 0.000001) {
    ikPoleProjected.copy(ikLowerPosition).sub(ikUpperPosition);
    ikPoleProjected.sub(ikReachDirection.clone().multiplyScalar(ikPoleProjected.dot(ikReachDirection)));
  }

  if (ikPoleProjected.lengthSq() <= 0.000001) {
    return;
  }

  ikPoleProjected.normalize();

  const elbowAlong = THREE.MathUtils.clamp(
    (upperLength * upperLength + targetDistance * targetDistance - lowerLength * lowerLength) /
      (2 * targetDistance),
    -upperLength,
    upperLength,
  );
  const elbowSide = Math.sqrt(Math.max(0, upperLength * upperLength - elbowAlong * elbowAlong));

  ikElbowTarget
    .copy(ikUpperPosition)
    .addScaledVector(ikReachDirection, elbowAlong)
    .addScaledVector(ikPoleProjected, elbowSide);

  rotateBoneToward({
    root,
    bone: upper,
    fromWorld: ikLowerPosition,
    toWorld: ikElbowTarget,
    originWorld: ikUpperPosition,
    maxAngle,
  });

  root.updateMatrixWorld(true);
  lower.getWorldPosition(ikLowerPosition);
  effector.getWorldPosition(ikEffectorPosition);

  rotateBoneToward({
    root,
    bone: lower,
    fromWorld: ikEffectorPosition,
    toWorld: target,
    originWorld: ikLowerPosition,
    maxAngle,
  });

  root.updateMatrixWorld(true);
}

function rotateBoneToward({ root, bone, fromWorld, toWorld, originWorld, maxAngle }) {
  ikCurrentDirection.copy(fromWorld).sub(originWorld);
  ikDesiredDirection.copy(toWorld).sub(originWorld);

  if (ikCurrentDirection.lengthSq() <= 0.000001 || ikDesiredDirection.lengthSq() <= 0.000001) {
    return;
  }

  ikCurrentDirection.normalize();
  ikDesiredDirection.normalize();
  ikDeltaRotation.setFromUnitVectors(ikCurrentDirection, ikDesiredDirection);
  limitRotation(ikDeltaRotation, maxAngle, ikLimitedRotation);
  applyWorldRotationDelta(bone, ikLimitedRotation);
  root.updateMatrixWorld(true);
}

function applyWorldRotationDelta(bone, worldDelta) {
  bone.parent.getWorldQuaternion(ikParentWorldRotation);
  ikParentWorldRotationInverse.copy(ikParentWorldRotation).invert();
  ikLocalDelta
    .copy(ikParentWorldRotationInverse)
    .multiply(worldDelta)
    .multiply(ikParentWorldRotation);
  bone.quaternion.premultiply(ikLocalDelta).normalize();
}

function solveCcdIk({ root, effector, links, target, iterations, maxAngle }) {
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let reachedTarget = false;

    for (const link of links) {
      root.updateMatrixWorld(true);
      effector.getWorldPosition(ikEffectorPosition);

      if (ikEffectorPosition.distanceToSquared(target) < 0.0001) {
        reachedTarget = true;
        break;
      }

      link.getWorldPosition(ikJointPosition);
      ikEffectorDirection.copy(ikEffectorPosition).sub(ikJointPosition);
      ikTargetDirection.copy(target).sub(ikJointPosition);

      if (ikEffectorDirection.lengthSq() < 0.000001 || ikTargetDirection.lengthSq() < 0.000001) {
        continue;
      }

      ikEffectorDirection.normalize();
      ikTargetDirection.normalize();
      ikDeltaRotation.setFromUnitVectors(ikEffectorDirection, ikTargetDirection);
      limitRotation(ikDeltaRotation, maxAngle, ikLimitedRotation);

      link.parent.getWorldQuaternion(ikParentWorldRotation);
      ikParentWorldRotationInverse.copy(ikParentWorldRotation).invert();
      ikLocalDelta
        .copy(ikParentWorldRotationInverse)
        .multiply(ikLimitedRotation)
        .multiply(ikParentWorldRotation);
      link.quaternion.premultiply(ikLocalDelta).normalize();
    }

    if (reachedTarget) {
      break;
    }
  }

  root.updateMatrixWorld(true);
}

function limitRotation(rotation, maxAngle, target) {
  const angle = 2 * Math.acos(THREE.MathUtils.clamp(rotation.w, -1, 1));

  if (!Number.isFinite(angle) || angle <= maxAngle) {
    target.copy(rotation);
    return target;
  }

  target.copy(ikIdentityRotation).slerp(rotation, maxAngle / angle);
  return target;
}

export function prepareClip({
  clip,
  state,
  rootBindPosition,
  sourceBindRotations,
  targetBindRotations,
  targetNames,
  retargetQuaternionTracks = true,
  rootPosition = 'normalized',
  maskedBonePrefixes = [],
  allowedBonePrefixes = null,
  endAt,
  startAt,
  rootMotion,
  rootMotionScale = 1,
}) {
  const preparedClip = clip.clone();
  preparedClip.name = state;
  trimClipEnd(preparedClip, endAt);
  trimClipStart(preparedClip, startAt);
  const rootMotionTrack = preparedClip.tracks.find((track) => track.name === ROOT_POSITION_TRACK);

  if (rootMotionTrack && rootMotion?.horizontal) {
    preparedClip.userData = {
      ...preparedClip.userData,
      rootMotion: extractHorizontalRootMotion({
        track: rootMotionTrack,
        scale: rootMotionScale * (rootMotion.movementScale ?? 1),
        blend: rootMotion.blend ?? 1,
        drive: rootMotion.drive,
        includeVertical: rootMotion.vertical === true,
      }),
    };
  }

  preparedClip.tracks = preparedClip.tracks
    .filter((track) => hasTargetNode({ track, targetNames }))
    .filter((track) => isAllowedTrack({ track, allowedBonePrefixes }))
    .filter((track) => !isMaskedTrack({ track, maskedBonePrefixes }))
    .map((track) => {
      if (track.name !== ROOT_POSITION_TRACK) {
        if (!retargetQuaternionTracks) {
          return track;
        }

        return retargetQuaternionTrack({
          track,
          sourceBindRotations,
          targetBindRotations,
        });
      }

      return normalizeRootMotion({ track, rootBindPosition, rootPosition });
    });
  preparedClip.optimize();

  return preparedClip;
}

export function trimClipStart(clip, startAt) {
  if (!Number.isFinite(startAt) || startAt <= 0 || startAt >= clip.duration) {
    return clip;
  }

  clip.duration = Math.max(clip.duration - startAt, 0.0001);
  clip.tracks = clip.tracks.map((track) => trimTrackStart(track, startAt));

  return clip;
}

export function trimClipEnd(clip, endAt) {
  if (!Number.isFinite(endAt) || endAt <= 0 || endAt >= clip.duration) {
    return clip;
  }

  clip.duration = endAt;
  clip.tracks = clip.tracks.map((track) => trimTrackEnd(track, endAt));

  return clip;
}

function hasTargetNode({ track, targetNames }) {
  const [targetName] = track.name.split('.');

  return !targetName || targetNames.has(targetName);
}

function isMaskedTrack({ track, maskedBonePrefixes }) {
  if (!maskedBonePrefixes.length) {
    return false;
  }

  const [targetName] = track.name.split('.');

  return maskedBonePrefixes.some((prefix) => targetName.startsWith(prefix));
}

function isAllowedTrack({ track, allowedBonePrefixes }) {
  if (!allowedBonePrefixes?.length) {
    return true;
  }

  const [targetName] = track.name.split('.');

  return allowedBonePrefixes.some((prefix) => targetName.startsWith(prefix));
}

function trimTrackEnd(track, endAt) {
  const valueSize = track.getValueSize();
  const firstExcludedKey = track.times.findIndex((time) => time > endAt + Number.EPSILON);

  if (firstExcludedKey < 0) {
    return track;
  }

  const keyCount = Math.max(1, firstExcludedKey);
  const times = track.times.slice(0, keyCount);
  const values = track.values.slice(0, keyCount * valueSize);

  return new track.constructor(track.name, times, values, track.getInterpolation());
}

function trimTrackStart(track, startAt) {
  const valueSize = track.getValueSize();
  const firstIncludedKey = track.times.findIndex((time) => time >= startAt - Number.EPSILON);

  if (firstIncludedKey <= 0) {
    return track;
  }

  if (firstIncludedKey >= track.times.length) {
    const lastIndex = track.times.length - 1;
    return new track.constructor(
      track.name,
      [0],
      track.values.slice(lastIndex * valueSize, (lastIndex + 1) * valueSize),
      track.getInterpolation(),
    );
  }

  const times = track.times.slice(firstIncludedKey).map((time) => time - startAt);
  const values = track.values.slice(firstIncludedKey * valueSize);

  return new track.constructor(track.name, times, values, track.getInterpolation());
}

function extractHorizontalRootMotion({ track, scale, blend, drive, includeVertical = false }) {
  const values = [];
  const rootX = track.values[0] ?? 0;
  const rootY = track.values[1] ?? 0;
  const rootZ = track.values[2] ?? 0;

  for (let index = 0; index < track.values.length; index += 3) {
    values.push(
      (track.values[index] - rootX) * scale,
      includeVertical ? (track.values[index + 1] - rootY) * scale : 0,
      (track.values[index + 2] - rootZ) * scale,
    );
  }

  return {
    times: Array.from(track.times),
    values,
    totalValues: values.slice(values.length - 3),
    blend,
    drive,
  };
}

function sampleLoopingRootMotionDelta({ rootMotion, startTime, endTime, duration, target }) {
  const start = wrapAnimationTime(startTime, duration);
  const end = wrapAnimationTime(endTime, duration);

  sampleRootMotionAt(rootMotion, start, rootMotionStart);

  if (endTime - startTime < duration && end >= start) {
    sampleRootMotionAt(rootMotion, end, rootMotionEnd);
    return target.copy(rootMotionEnd).sub(rootMotionStart);
  }

  sampleRootMotionAt(rootMotion, duration, rootMotionWrapEnd);
  sampleRootMotionAt(rootMotion, 0, rootMotionWrapStart);
  sampleRootMotionAt(rootMotion, end, rootMotionEnd);

  return target
    .copy(rootMotionWrapEnd)
    .sub(rootMotionStart)
    .add(rootMotionEnd)
    .sub(rootMotionWrapStart);
}

function wrapAnimationTime(time, duration) {
  if (duration <= 0) {
    return 0;
  }

  return ((time % duration) + duration) % duration;
}

function sampleRootMotionAt(rootMotion, time, target) {
  const { times, values } = rootMotion;

  if (!times.length) {
    return target.set(0, 0, 0);
  }

  if (time <= times[0]) {
    return target.fromArray(values, 0);
  }

  const lastIndex = times.length - 1;

  if (time >= times[lastIndex]) {
    return target.fromArray(values, lastIndex * 3);
  }

  let index = 1;
  while (index < times.length && times[index] < time) {
    index += 1;
  }

  const previousIndex = index - 1;
  const previousTime = times[previousIndex];
  const nextTime = times[index];
  const alpha = (time - previousTime) / (nextTime - previousTime || 1);

  rootMotionPreviousKey.fromArray(values, previousIndex * 3);
  rootMotionNextKey.fromArray(values, index * 3);

  return target.copy(rootMotionPreviousKey).lerp(rootMotionNextKey, alpha);
}

function retargetQuaternionTrack({ track, sourceBindRotations, targetBindRotations }) {
  if (track.ValueTypeName !== 'quaternion') {
    return track;
  }

  const [targetName] = track.name.split('.');
  const sourceBind = sourceBindRotations.get(targetName);
  const targetBind = targetBindRotations.get(targetName);

  if (!sourceBind || !targetBind) {
    return track;
  }

  const clonedTrack = track.clone();
  const values = clonedTrack.values;
  const sourceBindInverse = sourceBind.clone().invert();
  const animated = new THREE.Quaternion();
  const delta = new THREE.Quaternion();
  const retargeted = new THREE.Quaternion();

  for (let index = 0; index < values.length; index += 4) {
    animated.fromArray(values, index).normalize();
    delta.copy(sourceBindInverse).multiply(animated);
    retargeted.copy(targetBind).multiply(delta).normalize();
    retargeted.toArray(values, index);
  }

  return clonedTrack;
}

function normalizeRootMotion({ track, rootBindPosition, rootPosition }) {
  const clonedTrack = track.clone();
  const values = clonedTrack.values;
  const rootX = values[0] ?? 0;
  const rootY = values[1] ?? 0;
  const rootZ = values[2] ?? 0;
  const bindX = rootBindPosition?.x ?? rootX;
  const bindY = rootBindPosition?.y ?? rootY;
  const bindZ = rootBindPosition?.z ?? rootZ;

  for (let index = 0; index < values.length; index += 3) {
    if (rootPosition === 'animated') {
      values[index] = bindX + (values[index] - rootX);
      values[index + 1] = bindY + (values[index + 1] - rootY);
      values[index + 2] = bindZ + (values[index + 2] - rootZ);
      continue;
    }

    values[index] = bindX;
    values[index + 2] = bindZ;

    if (rootPosition === 'locked') {
      values[index + 1] = bindY;
      continue;
    }

    values[index + 1] = bindY + (values[index + 1] - rootY);
  }

  return clonedTrack;
}
