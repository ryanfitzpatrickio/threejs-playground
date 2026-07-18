// Shared Rigify skeleton knowledge for the vibe-human GLB, used by BOTH the
// offline retarget script (scripts/retarget-rigify-animations.mjs) and the
// runtime model factory. Keep this file dependency-free (no three import) so
// node scripts can use it without the WebGPU loader shim.
//
// The GLB's export stripped Rigify's ORG- bones, leaving the DEF- skeleton
// almost FLAT: spine.003–.006, shoulders, upper arms, thighs, breasts and
// most face bones are parented directly to the armature root ('rig.001').
// Local-rotation animation on a flat skeleton falls apart (chest rotation
// would not move the arms), so we reparent anatomically at load, preserving
// world transforms — bind-pose bone world matrices are unchanged, so the
// skin's inverseBindMatrices stay valid.
//
// Note this export also merges Rigify twist bones: DEF-forearm.L.001 IS the
// forearm (no DEF-forearm.L), DEF-thigh.L.001 IS the shin (no DEF-shin.L).

// GLTFLoader sanitizes node names for AnimationMixer bindings by removing
// punctuation such as `.`, `:` and `/`. Keep the readable Blender names in
// this module, then expose the exact runtime names used by Three.js.
export function toRuntimeRigifyBoneName(name) {
  return name.replace(/[\[\]\.:/]/g, '');
}

// child bone -> anatomical parent (applied with Object3D.attach()).
const RAW_RIGIFY_PARENT_OVERRIDES = {
  'DEF-pelvis.L': 'DEF-spine',
  'DEF-pelvis.R': 'DEF-spine',
  'DEF-thigh.L': 'DEF-spine',
  'DEF-thigh.R': 'DEF-spine',
  'DEF-spine.003': 'DEF-spine.002',
  'DEF-spine.004': 'DEF-spine.003',
  'DEF-spine.005': 'DEF-spine.004',
  'DEF-spine.006': 'DEF-spine.005',
  'DEF-breast.L': 'DEF-spine.003',
  'DEF-breast.R': 'DEF-spine.003',
  'DEF-shoulder.L': 'DEF-spine.003',
  'DEF-shoulder.R': 'DEF-spine.003',
  'DEF-upper_arm.L': 'DEF-shoulder.L',
  'DEF-upper_arm.R': 'DEF-shoulder.R',
};

export const RIGIFY_PARENT_OVERRIDES = Object.freeze(Object.fromEntries(
  Object.entries(RAW_RIGIFY_PARENT_OVERRIDES).map(([child, parent]) => [
    toRuntimeRigifyBoneName(child),
    toRuntimeRigifyBoneName(parent),
  ]),
));

// Face/head bones that sit at the armature root get parented to the head
// bone so head rotation carries the face (upstream did this manually every
// frame via HEAD_POSE_FOLLOW_BONE_PATTERN).
export const RIGIFY_HEAD_BONE = toRuntimeRigifyBoneName('DEF-spine.006');
export const RIGIFY_FACE_BONE_PATTERN =
  /^DEF-(brow|cheek|chin|ear|eye|forehead|jaw|lid|lip|nose|teeth|tongue|temple)/;

// target Rigify DEF bone -> source Mixamo bone. Unmapped bones (palms,
// pelvis, breasts, face, spine.004) hold their rest pose.
const RAW_RIGIFY_FROM_MIXAMO = {
  'DEF-spine': 'mixamorigHips',
  'DEF-spine.001': 'mixamorigSpine',
  'DEF-spine.002': 'mixamorigSpine1',
  'DEF-spine.003': 'mixamorigSpine2',
  'DEF-spine.005': 'mixamorigNeck',
  'DEF-spine.006': 'mixamorigHead',

  'DEF-shoulder.L': 'mixamorigLeftShoulder',
  'DEF-upper_arm.L': 'mixamorigLeftArm',
  'DEF-forearm.L.001': 'mixamorigLeftForeArm',
  'DEF-hand.L': 'mixamorigLeftHand',
  'DEF-shoulder.R': 'mixamorigRightShoulder',
  'DEF-upper_arm.R': 'mixamorigRightArm',
  'DEF-forearm.R.001': 'mixamorigRightForeArm',
  'DEF-hand.R': 'mixamorigRightHand',

  'DEF-thumb.01.L': 'mixamorigLeftHandThumb1',
  'DEF-thumb.02.L': 'mixamorigLeftHandThumb2',
  'DEF-thumb.03.L': 'mixamorigLeftHandThumb3',
  'DEF-f_index.01.L': 'mixamorigLeftHandIndex1',
  'DEF-f_index.02.L': 'mixamorigLeftHandIndex2',
  'DEF-f_index.03.L': 'mixamorigLeftHandIndex3',
  'DEF-f_middle.01.L': 'mixamorigLeftHandMiddle1',
  'DEF-f_middle.02.L': 'mixamorigLeftHandMiddle2',
  'DEF-f_middle.03.L': 'mixamorigLeftHandMiddle3',
  'DEF-f_ring.01.L': 'mixamorigLeftHandRing1',
  'DEF-f_ring.02.L': 'mixamorigLeftHandRing2',
  'DEF-f_ring.03.L': 'mixamorigLeftHandRing3',
  'DEF-f_pinky.01.L': 'mixamorigLeftHandPinky1',
  'DEF-f_pinky.02.L': 'mixamorigLeftHandPinky2',
  'DEF-f_pinky.03.L': 'mixamorigLeftHandPinky3',
  'DEF-thumb.01.R': 'mixamorigRightHandThumb1',
  'DEF-thumb.02.R': 'mixamorigRightHandThumb2',
  'DEF-thumb.03.R': 'mixamorigRightHandThumb3',
  'DEF-f_index.01.R': 'mixamorigRightHandIndex1',
  'DEF-f_index.02.R': 'mixamorigRightHandIndex2',
  'DEF-f_index.03.R': 'mixamorigRightHandIndex3',
  'DEF-f_middle.01.R': 'mixamorigRightHandMiddle1',
  'DEF-f_middle.02.R': 'mixamorigRightHandMiddle2',
  'DEF-f_middle.03.R': 'mixamorigRightHandMiddle3',
  'DEF-f_ring.01.R': 'mixamorigRightHandRing1',
  'DEF-f_ring.02.R': 'mixamorigRightHandRing2',
  'DEF-f_ring.03.R': 'mixamorigRightHandRing3',
  'DEF-f_pinky.01.R': 'mixamorigRightHandPinky1',
  'DEF-f_pinky.02.R': 'mixamorigRightHandPinky2',
  'DEF-f_pinky.03.R': 'mixamorigRightHandPinky3',

  'DEF-thigh.L': 'mixamorigLeftUpLeg',
  'DEF-thigh.L.001': 'mixamorigLeftLeg',
  'DEF-foot.L': 'mixamorigLeftFoot',
  'DEF-toe.L': 'mixamorigLeftToeBase',
  'DEF-thigh.R': 'mixamorigRightUpLeg',
  'DEF-thigh.R.001': 'mixamorigRightLeg',
  'DEF-foot.R': 'mixamorigRightFoot',
  'DEF-toe.R': 'mixamorigRightToeBase',
};

export const RIGIFY_FROM_MIXAMO = Object.freeze(Object.fromEntries(
  Object.entries(RAW_RIGIFY_FROM_MIXAMO).map(([target, source]) => [
    toRuntimeRigifyBoneName(target),
    source,
  ]),
));

export const RIGIFY_HIP_BONE = 'DEF-spine';

/**
 * Reparent the flat DEF skeleton anatomically, preserving world transforms.
 * Idempotent. Call after the GLB scene's matrixWorld is up to date and
 * BEFORE animating; skinning is unaffected (bind world matrices unchanged).
 *
 * @param {import('three').Object3D} root — loaded glTF scene (or any
 *   ancestor of the armature).
 * @returns {{ reparented: number, missing: string[] }}
 */
export function reparentRigifySkeleton(root) {
  const byName = new Map();
  root.traverse((node) => {
    if (node.isBone) byName.set(node.name, node);
  });

  root.updateMatrixWorld(true);

  const missing = [];
  let reparented = 0;

  const attach = (childName, parentName) => {
    const child = byName.get(childName);
    const parent = byName.get(parentName);
    if (!child || !parent) {
      missing.push(`${childName} -> ${parentName}`);
      return;
    }
    if (child.parent === parent) return;
    parent.attach(child);
    reparented += 1;
  };

  for (const [child, parent] of Object.entries(RIGIFY_PARENT_OVERRIDES)) {
    attach(child, parent);
  }

  const head = byName.get(RIGIFY_HEAD_BONE);
  if (head) {
    for (const [name, bone] of byName) {
      if (!RIGIFY_FACE_BONE_PATTERN.test(name)) continue;
      // Only lift root-level face bones; jaw/lid sub-chains keep their parents.
      if (bone.parent?.isBone && bone.parent.name.startsWith('DEF-')) continue;
      if (bone.parent === head) continue;
      head.attach(bone);
      reparented += 1;
    }
  }

  root.updateMatrixWorld(true);
  return { reparented, missing };
}
