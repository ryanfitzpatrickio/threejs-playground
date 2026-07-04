const MIXAMO_BONES = Object.freeze({
  hips: 'mixamorigHips',
  spine: 'mixamorigSpine',
  chest: 'mixamorigSpine2',
  neck: 'mixamorigNeck',
  head: 'mixamorigHead',
  leftHand: 'mixamorigLeftHand',
  rightHand: 'mixamorigRightHand',
  leftFoot: 'mixamorigLeftFoot',
  rightFoot: 'mixamorigRightFoot',
});

// Canonical gameplay action -> clip authored for the Mesh2Motion source rig.
// Deliberately omit actions without a real equivalent. The controller will not
// substitute idle or a clip from another skeleton source for a missing route.
const MESH2MOTION_ANIMATIONS = Object.freeze({
  idle: route('Idle_Loop', { loop: true, fadeIn: 0.22 }),
  walk: route('Walk_Loop', { loop: true }),
  jog: route('Jog_Fwd_Loop', { loop: true, fadeIn: 0.2, timeScale: 1.08 }),
  sprint: route('Sprint_Loop', { loop: true, fadeIn: 0.14 }),
  brace: route('Crouch_Idle_Loop', { loop: true, fadeIn: 0.16 }),
  runningSlide: route('Slide_Loop', { loop: false, fadeIn: 0.08 }),
  jump: route('Jump_Start', { loop: false, fadeIn: 0.08 }),
  jumpMoving: route('Jump_Start', { loop: false, fadeIn: 0.08 }),
  freeFall: route('Jump_Loop', { loop: true, fadeIn: 0.16 }),
  land: route('Jump_Land', { loop: false, fadeIn: 0.06 }),
  landMoving: route('Jump_Land', { loop: false, fadeIn: 0.06 }),
  landRoll: route('Roll', { loop: false, fadeIn: 0.08 }),
  aerialEvade: route('Roll', { loop: false, fadeIn: 0.08 }),
  swim: route('Swim_Fwd_Loop', { loop: true, fadeIn: 0.2 }),
  wingsuitCoast: route('Flying Forward', { loop: true, fadeIn: 0.3 }),
  wingsuitDive: route('Flying Forward Super', { loop: true, fadeIn: 0.22 }),
  freeHangClimb: route('ClimbUp_1m_RM', { loop: false, fadeIn: 0.08 }),
  armedIdle: route('Sword_Idle', { loop: true, fadeIn: 0.15 }),
  lightSlash1: route('Sword_Regular_A', { loop: false, fadeIn: 0.08 }),
  lightSlash2: route('Sword_Regular_B', { loop: false, fadeIn: 0.08 }),
  lightSlash3: route('Sword_Regular_C', { loop: false, fadeIn: 0.08 }),
  heavyAttack: route('Sword_Attack', { loop: false, fadeIn: 0.1 }),
  unarmedLight: route('Punch_Jab', { loop: false, fadeIn: 0.08 }),
  hitBackward: route('Hit_Chest', { loop: false, fadeIn: 0.06 }),
  hitThrown: route('Hit_Knockback', { loop: false, fadeIn: 0.06 }),
  armedHitBackward: route('Hit_Chest', { loop: false, fadeIn: 0.06 }),
  armedHitThrown: route('Hit_Knockback', { loop: false, fadeIn: 0.06 }),
});

export const SOURCE_SKELETONS = Object.freeze({
  mixamo: Object.freeze({
    id: 'mixamo',
    animationLibrary: 'external',
    bones: MIXAMO_BONES,
    // The existing animation manifest is already keyed by canonical action.
    resolveAnimation(action, manifest) {
      return manifest?.[action] ? { action, ...manifest[action] } : null;
    },
  }),
  mesh2motion: Object.freeze({
    id: 'mesh2motion',
    animationLibrary: 'embedded',
    bones: MIXAMO_BONES,
    resolveAnimation(action) {
      return MESH2MOTION_ANIMATIONS[action] ?? null;
    },
  }),
});

export function getSourceSkeleton(id) {
  const source = SOURCE_SKELETONS[id];
  if (!source) {
    throw new Error(`Unknown source skeleton: ${id}`);
  }
  return source;
}

export function resolveSourceAnimation(sourceId, action, manifest) {
  return getSourceSkeleton(sourceId).resolveAnimation(action, manifest);
}

export function listSourceAnimationActions(sourceId) {
  if (sourceId === 'mesh2motion') {
    return Object.keys(MESH2MOTION_ANIMATIONS);
  }
  return [];
}

function route(clip, settings = {}) {
  return Object.freeze({ clip, rootPosition: 'locked', ...settings });
}

