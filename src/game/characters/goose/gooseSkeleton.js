/**
 * Fully procedural Canada goose skeleton (~53 bones, built in code — no GLB).
 *
 * The shared bird rig (bird-rigged.glb) has NO neck bones, which caps goose
 * fidelity: the long S-curve neck is the species' defining trait. This rig is
 * authored specifically for the goose:
 *   - 12 cervical control bones (neck_0..neck_11) approximating 17–18 vertebrae
 *   - paired avian wing chains (shoulder / humerus / forearm / carpometacarpus
 *     / digit) authored in the FOLDED pose (dual-state: fold ↔ open in anim)
 *   - synsacrum (hips) + 3 tail bones ending at the pygostyle
 *   - legs: femur / tibiotarsus / tarsometatarsus + toe fan for the webbed foot
 *
 * Bind pose can be morphed (neck length, body upright, …) via gooseMorph —
 * bone NAMES stay fixed so animation/skin weights stay valid.
 *
 * Conventions (match DogSimScene studio):
 *   meters, ground y=0, goose faces +Z, profile camera on +X.
 *   All bones bind with IDENTITY rotation, so geometry is authored directly in
 *   world bind space and animation applies quaternion deltas on top.
 */

import * as THREE from 'three';
import { GOOSE_DIMS } from './gooseDims.js';
import {
  DEFAULT_GOOSE_MORPH,
  buildGooseBoneWorldPos,
  resolveGooseMorph,
} from './gooseMorph.js';

export { GOOSE_DIMS };

/**
 * Parent table for the goose armature (name → parent). World positions come
 * from buildGooseBoneWorldPos(morph) so the hierarchy can be remorphed.
 * @type {Array<[string, string | null]>}
 */
export const GOOSE_BONE_PARENTS = Object.freeze([
  ['root', null],
  ['hips', 'root'],
  ['spine_0', 'hips'],
  ['spine_1', 'spine_0'],
  ['spine_2', 'spine_1'],
  ['spine_3', 'spine_2'],
  ['keel', 'spine_1'],
  ['crop', 'spine_3'],
  ...Array.from({ length: 12 }, (_, i) => /** @type {[string, string]} */ (
    [`neck_${i}`, i === 0 ? 'spine_3' : `neck_${i - 1}`]
  )),
  ['head', 'neck_11'],
  ['jaw', 'head'],
  ['eye_L', 'head'],
  ['eye_R', 'head'],
  ['tail_0', 'hips'],
  ['tail_1', 'tail_0'],
  ['tail_2', 'tail_1'],
  ['rectrix_L', 'tail_2'],
  ['rectrix_R', 'tail_2'],
  ...['L', 'R'].flatMap((side) => [
    [`shoulder_${side}`, 'spine_2'],
    [`wing_0_${side}`, `shoulder_${side}`],
    [`wing_1_${side}`, `wing_0_${side}`],
    [`wing_2_${side}`, `wing_1_${side}`],
    [`wing_tip_${side}`, `wing_2_${side}`],
  ]),
  ...['L', 'R'].flatMap((side) => [
    [`femur_${side}`, 'hips'],
    [`tibia_${side}`, `femur_${side}`],
    [`Foot_${side}`, `tibia_${side}`],
    [`Toes_${side}`, `Foot_${side}`],
    [`Toes_tip_${side}`, `Toes_${side}`],
    [`toe_in_${side}`, `Toes_${side}`],
    [`toe_out_${side}`, `Toes_${side}`],
    [`hallux_${side}`, `Foot_${side}`],
  ]),
]);

/**
 * Canonical (identity morph) bone table for tooling that still expects a static list.
 * @type {Array<[string, string | null, [number, number, number]]>}
 */
export const GOOSE_BONE_DEFS = (() => {
  const morph = resolveGooseMorph(DEFAULT_GOOSE_MORPH);
  const world = buildGooseBoneWorldPos(morph);
  return GOOSE_BONE_PARENTS.map(([name, parent]) => {
    const pos = world.get(name);
    if (!pos) throw new Error(`goose bone defs: missing ${name}`);
    return /** @type {[string, string | null, [number, number, number]]} */ (
      [name, parent, pos]
    );
  });
})();

/** Chains used by animation / IK. */
export const GOOSE_CHAINS = Object.freeze({
  neck: ['spine_3', ...Array.from({ length: 12 }, (_, i) => `neck_${i}`), 'head'],
  wingL: ['shoulder_L', 'wing_0_L', 'wing_1_L', 'wing_2_L', 'wing_tip_L'],
  wingR: ['shoulder_R', 'wing_0_R', 'wing_1_R', 'wing_2_R', 'wing_tip_R'],
  legL: ['femur_L', 'tibia_L', 'Foot_L', 'Toes_L', 'Toes_tip_L'],
  legR: ['femur_R', 'tibia_R', 'Foot_R', 'Toes_R', 'Toes_tip_R'],
  tail: ['tail_0', 'tail_1', 'tail_2'],
});

/**
 * @param {import('./gooseMorph.js').GooseMorphInput | import('./gooseMorph.js').GooseMorph} [morphInput]
 * @returns {{
 *   root: THREE.Group,
 *   rootBone: THREE.Bone,
 *   bones: THREE.Bone[],
 *   bonesByName: Map<string, THREE.Bone>,
 *   boneIndex: Map<string, number>,
 *   worldBindPos: Map<string, THREE.Vector3>,
 *   skeleton: THREE.Skeleton,
 *   boneCount: number,
 *   morph: import('./gooseMorph.js').GooseMorph,
 * }}
 */
export function createGooseSkeleton(morphInput = DEFAULT_GOOSE_MORPH) {
  const morph = /** @type {import('./gooseMorph.js').GooseMorph} */ (
    morphInput.dims ? morphInput : resolveGooseMorph(morphInput)
  );
  const worldPos = buildGooseBoneWorldPos(morph);

  const root = new THREE.Group();
  root.name = 'GooseArmature';

  /** @type {THREE.Bone[]} */
  const bones = [];
  const bonesByName = new Map();
  const boneIndex = new Map();
  const worldBindPos = new Map();

  for (const [name, parentName] of GOOSE_BONE_PARENTS) {
    const pos = worldPos.get(name);
    if (!pos) throw new Error(`goose bone ${name}: missing world position`);
    const bone = new THREE.Bone();
    bone.name = name;
    const world = new THREE.Vector3(...pos);
    worldBindPos.set(name, world.clone());
    if (parentName) {
      const parent = bonesByName.get(parentName);
      if (!parent) throw new Error(`goose bone ${name}: missing parent ${parentName}`);
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
    morph,
  };
}
