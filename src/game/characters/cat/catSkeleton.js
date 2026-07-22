/**
 * Fully procedural domestic cat skeleton (~46 bones, built in code — no GLB).
 *
 * This is the "3cat" attempt: a fresh, bespoke feline rig (own skeleton +
 * ring-loft mesh + TSL coat) that replaces the tortoiseshell feline stub which
 * previously rode the shared quadruped dog pipeline. The dog rig can't express
 * the cat's defining traits — a highly flexible multi-bone spine for arch /
 * crouch / stretch, digitigrade fore & hind legs, a long expressive tail, and
 * independently mobile ears — so the cat gets its own armature here.
 *
 * Conventions (match DogSimScene studio):
 *   meters, ground y=0, cat faces +Z, profile camera on +X.
 *   Bind pose == a relaxed standing stance (reference profile.jpg): all four
 *   paws planted, back level, neck up-forward, tail arced up and trailing.
 *   Every bone binds with IDENTITY rotation, so geometry is authored directly
 *   in world bind space and animation applies quaternion deltas on top (same
 *   trick the goose rig uses — see gooseSkeleton.js).
 *
 * Bone naming reuses studio conventions where shared code looks them up:
 *   hips, spine_0..4, head (+"Head" alias), tail_1, and Foot_/Toes_tip_ for the
 *   grounded hind paws. Fore paws use Hand_/Fingers_tip_.
 */

import * as THREE from 'three';
import { resolveCatHeadLandmarks } from './catLandmarks.js';

// Head centre + scale for a mid-size domestic shorthair; the eye/ear/muzzle/
// nose landmarks below are placed BY RATIO off the cat-ref boards (catLandmarks.js)
// rather than hand-tuned numbers, so the face re-scales as one unit.
// Proportions matched to the cat-ref boards: a LOW, STOCKY cat — deep barrel
// torso, short thick legs, short neck, the small round head sitting close to
// and just above the shoulder line.
const HEAD_CENTER_Y = 0.288;
const HEAD_CENTER_Z = 0.246;
const HEAD_SCALE = 0.072;
const _lm = resolveCatHeadLandmarks({
  headCenterY: HEAD_CENTER_Y,
  headCenterZ: HEAD_CENTER_Z,
  headScale: HEAD_SCALE,
});

/**
 * Landmark dimensions for a mid-size domestic shorthair, measured off the
 * reference boards as pixel-landmark ratios scaled to a 0.30 m withers height.
 * Shared by geometry, coat masks, and animation so every consumer agrees.
 * Face features (eye/ear/muzzle/nose) are ratio-derived — see catLandmarks.js.
 */
export const CAT_DIMS = Object.freeze({
  withersY: 0.252,         // top of shoulders (low stocky stance)
  hipTopY: 0.248,
  backY: 0.250,            // level back line
  bellyY: 0.122,           // deep body, short leg clearance
  bodyCenterY: 0.186,
  chestFrontZ: 0.200,      // breast most-forward point
  rumpZ: -0.195,
  bodyHalfWidth: 0.064,    // stockier barrel
  // neck / head
  neckBaseY: 0.244,
  neckBaseZ: 0.160,
  headCenterY: HEAD_CENTER_Y,
  headCenterZ: HEAD_CENTER_Z,
  headScale: HEAD_SCALE,
  crownY: 0.330,
  headHalfWidth: 0.050,
  // muzzle / nose (short, blunt feline face) — ratio-placed
  muzzleTipY: _lm.muzzleTipY,
  muzzleTipZ: _lm.muzzleTipZ,
  noseY: _lm.noseY,
  noseZ: _lm.noseZ,
  // eyes (large, forward-set, proud of the rounded skull) — ratio-placed
  eyeX: _lm.eyeX,
  eyeY: _lm.eyeY,
  eyeZ: _lm.eyeZ,
  eyeRadius: _lm.eyeRadius,
  // ears (tall triangles on the crown) — ratio-placed
  earBaseX: _lm.earBaseX,
  earBaseY: _lm.earBaseY,
  earBaseZ: _lm.earBaseZ,
  earTipX: _lm.earTipX,
  earTipY: _lm.earTipY,
  earTipZ: _lm.earTipZ,
  // fore leg (digitigrade) — short + thick, near-vertical column
  legX: 0.048,
  shoulderY: 0.178,
  shoulderZ: 0.118,
  elbowY: 0.108,
  elbowZ: 0.128,
  fWristY: 0.056,
  fWristZ: 0.118,
  fPawY: 0.024,
  fPawZ: 0.120,
  fToeZ: 0.148,
  // hind leg (digitigrade, angulated) — short + thick
  hipY: 0.162,
  hipZ: -0.118,
  stifleY: 0.112,
  stifleZ: -0.072,
  hockY: 0.058,
  hockZ: -0.108,
  hPawY: 0.024,
  hPawZ: -0.086,
  hToeZ: -0.056,
  // tail
  tailBaseZ: -0.195,
});

const D = CAT_DIMS;

/**
 * Bone table: [name, parentName, worldBindPos [x,y,z]].
 * Order defines the skin index used by catBodyGeometry.
 * @type {Array<[string, string | null, [number, number, number]]>}
 */
export const CAT_BONE_DEFS = (() => {
  /** @type {Array<[string, string | null, [number, number, number]]>} */
  const defs = [];
  const add = (name, parent, pos) => defs.push([name, parent, pos]);

  add('root', null, [0, 0, 0]);
  add('hips', 'root', [0, 0.238, -0.140]);

  // ---- flexible spine: lumbar → thoracic → withers (5 controls) -------------
  const spinePath = [
    [0.242, -0.072],
    [0.246, -0.004],
    [0.248, 0.062],
    [0.246, 0.118],
    [0.242, 0.156],   // withers / neck base
  ];
  let prev = 'hips';
  spinePath.forEach(([y, z], i) => {
    add(`spine_${i}`, prev, [0, y, z]);
    prev = `spine_${i}`;
  });
  add('chest', 'spine_2', [0, 0.160, 0.072]);   // sternum / breath volume

  // ---- neck (short) → head → muzzle / jaw -----------------------------------
  add('neck_0', 'spine_4', [0, D.neckBaseY, D.neckBaseZ]);
  add('neck_1', 'neck_0', [0, 0.262, 0.196]);
  add('head', 'neck_1', [0, D.headCenterY, D.headCenterZ]);
  add('muzzle', 'head', [0, D.muzzleTipY, D.muzzleTipZ]);
  add('jaw', 'head', [0, 0.256, 0.224]); // hinge low + back so the chin swings
  add('eye_L', 'head', [D.eyeX, D.eyeY, D.eyeZ]);
  add('eye_R', 'head', [-D.eyeX, D.eyeY, D.eyeZ]);

  // ---- ears: two bones each (base + tip) for independent spring/FK ----------
  for (const side of ['L', 'R']) {
    const s = side === 'L' ? 1 : -1;
    add(`ear_${side}_0`, 'head', [s * D.earBaseX, D.earBaseY, D.earBaseZ]);
    add(`ear_${side}_1`, `ear_${side}_0`, [s * D.earTipX, D.earTipY, D.earTipZ]);
  }

  // ---- tail: 7 caudal controls, arcing off the rump then trailing low -------
  const tailPath = [
    [0.234, -0.196],
    [0.236, -0.250],
    [0.230, -0.304],
    [0.218, -0.356],
    [0.202, -0.402],
    [0.184, -0.440],
    [0.166, -0.470],
  ];
  prev = 'hips';
  tailPath.forEach(([y, z], i) => {
    add(`tail_${i}`, prev, [0, y, z]);
    prev = `tail_${i}`;
  });

  // ---- fore legs (digitigrade): scapula/humerus/radius/hand/fingers ---------
  for (const side of ['L', 'R']) {
    const s = side === 'L' ? 1 : -1;
    const x = s * D.legX;
    add(`scapula_${side}`, 'spine_3', [x, D.shoulderY, D.shoulderZ]);
    add(`humerus_${side}`, `scapula_${side}`, [x * 1.08, D.elbowY, D.elbowZ]);
    add(`radius_${side}`, `humerus_${side}`, [x * 1.12, D.fWristY, D.fWristZ]);
    add(`Hand_${side}`, `radius_${side}`, [x * 1.12, D.fPawY, D.fPawZ]);
    add(`Fingers_tip_${side}`, `Hand_${side}`, [x * 1.12, 0.004, D.fToeZ]);
  }

  // ---- hind legs (digitigrade): femur/tibia/hock/foot/toes ------------------
  for (const side of ['L', 'R']) {
    const s = side === 'L' ? 1 : -1;
    const x = s * D.legX;
    add(`femur_${side}`, 'hips', [x, D.hipY, D.hipZ]);
    add(`tibia_${side}`, `femur_${side}`, [x * 1.06, D.stifleY, D.stifleZ]);
    add(`Foot_${side}`, `tibia_${side}`, [x * 1.08, D.hockY, D.hockZ]);     // hock (ankle)
    add(`Toes_${side}`, `Foot_${side}`, [x * 1.08, D.hPawY, D.hPawZ]);       // metatarsal ball
    add(`Toes_tip_${side}`, `Toes_${side}`, [x * 1.08, 0.004, D.hToeZ]);
  }

  // ---- retractable claw controls (one carrier per paw, →50 bones) -----------
  // Bind pose == SHEATHED: the claw carrier sits tucked; animation rotates it
  // down/forward to protract the claws (silent stalk / pounce / knead).
  for (const side of ['L', 'R']) {
    const x = (side === 'L' ? 1 : -1) * D.legX;
    add(`claw_F${side}`, `Fingers_tip_${side}`, [x * 1.12, 0.006, D.fToeZ + 0.006]);
    add(`claw_H${side}`, `Toes_tip_${side}`, [x * 1.08, 0.006, D.hToeZ + 0.006]);
  }

  return defs;
})();

/** Claw carriers: [clawBone, parentToe, side, fore]. */
export const CAT_CLAWS = Object.freeze([
  ['claw_FL', 'Fingers_tip_L', 'L', true],
  ['claw_FR', 'Fingers_tip_R', 'R', true],
  ['claw_HL', 'Toes_tip_L', 'L', false],
  ['claw_HR', 'Toes_tip_R', 'R', false],
]);

/** Chains used by animation / IK. */
export const CAT_CHAINS = Object.freeze({
  spine: ['hips', 'spine_0', 'spine_1', 'spine_2', 'spine_3', 'spine_4'],
  neck: ['spine_4', 'neck_0', 'neck_1', 'head'],
  tail: ['tail_0', 'tail_1', 'tail_2', 'tail_3', 'tail_4', 'tail_5', 'tail_6'],
  earL: ['ear_L_0', 'ear_L_1'],
  earR: ['ear_R_0', 'ear_R_1'],
  foreL: ['scapula_L', 'humerus_L', 'radius_L', 'Hand_L', 'Fingers_tip_L'],
  foreR: ['scapula_R', 'humerus_R', 'radius_R', 'Hand_R', 'Fingers_tip_R'],
  hindL: ['femur_L', 'tibia_L', 'Foot_L', 'Toes_L', 'Toes_tip_L'],
  hindR: ['femur_R', 'tibia_R', 'Foot_R', 'Toes_R', 'Toes_tip_R'],
});

/** Four-paw ground contacts (used to plant the posed frame). */
export const CAT_FOOT_TIPS = Object.freeze([
  'Toes_tip_L', 'Toes_tip_R', 'Fingers_tip_L', 'Fingers_tip_R',
]);

/**
 * @returns {{
 *   root: THREE.Group,
 *   rootBone: THREE.Bone,
 *   bones: THREE.Bone[],
 *   bonesByName: Map<string, THREE.Bone>,
 *   boneIndex: Map<string, number>,
 *   worldBindPos: Map<string, THREE.Vector3>,
 *   skeleton: THREE.Skeleton,
 *   boneCount: number,
 * }}
 */
export function createCatSkeleton() {
  const root = new THREE.Group();
  root.name = 'CatArmature';

  /** @type {THREE.Bone[]} */
  const bones = [];
  const bonesByName = new Map();
  const boneIndex = new Map();
  const worldBindPos = new Map();

  for (const [name, parentName, pos] of CAT_BONE_DEFS) {
    const bone = new THREE.Bone();
    bone.name = name;
    const world = new THREE.Vector3(...pos);
    worldBindPos.set(name, world.clone());
    if (parentName) {
      const parent = bonesByName.get(parentName);
      if (!parent) throw new Error(`cat bone ${name}: missing parent ${parentName}`);
      bone.position.copy(world).sub(worldBindPos.get(parentName));
      parent.add(bone);
    } else {
      bone.position.copy(world);
      root.add(bone);
    }
    boneIndex.set(name, bones.length);
    bones.push(bone);
    bonesByName.set(name, bone);
  }

  // Studio alias (head-close preset looks up 'Head' first).
  bonesByName.set('Head', bonesByName.get('head'));

  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);

  return {
    root,
    rootBone: bones[0],
    bones,
    bonesByName,
    boneIndex,
    worldBindPos,
    skeleton,
    boneCount: bones.length,
  };
}
