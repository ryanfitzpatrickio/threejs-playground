/**
 * Procedural ladybug skeleton — minimal 15-bone control rig.
 *
 *   root → thorax → abdomen_0 → abdomen_1
 *                 → head → ant_L / ant_R
 *                 → elytra_L / elytra_R
 *                 → 6 single-bone legs (FL/ML/HL/FR/MR/HR)
 *
 * Conventions (match DogSimScene studio):
 *   meters, ground y=0, faces +Z, profile camera on +X.
 *   Bind pose = standing crawl stance, all six feet planted, elytra closed.
 *   Bones bind with IDENTITY rotation; geometry is authored in world bind space.
 *
 * Display scale is an enlarged macro model (~10 cm body) so the insect is
 * readable next to vertebrate subjects in the studio.
 */

import * as THREE from 'three';

/** Landmark dimensions for the studio-scale seven-spotted ladybug. */
export const LADYBUG_DIMS = Object.freeze({
  // Body oval (thorax + abdomen under closed elytra)
  bodyLen: 0.100,
  bodyHalfW: 0.044,
  domeH: 0.046,
  bellyY: 0.018,
  bodyCenterY: 0.038,
  thoraxZ: 0.018,
  abdomenZ: -0.018,
  rumpZ: -0.042,
  // Head (small, tucked under front of dome)
  headCenterY: 0.030,
  headCenterZ: 0.052,
  headRadius: 0.014,
  // Eyes
  eyeX: 0.009,
  eyeY: 0.032,
  eyeZ: 0.060,
  eyeRadius: 0.0045,
  // Antennae bases
  antBaseX: 0.006,
  antBaseY: 0.034,
  antBaseZ: 0.058,
  antLen: 0.022,
  // Elytra hinges (dorsal lateral)
  elytraHingeY: 0.042,
  elytraHingeZ: 0.022,
  elytraHingeX: 0.006,
  // Legs — coxa attach points (thorax sides), tips plant near y=0
  legAttachY: 0.022,
  legFL: { x: 0.022, z: 0.028 },
  legML: { x: 0.026, z: 0.002 },
  legHL: { x: 0.022, z: -0.024 },
  // Tip offsets from attach (bind pose, slightly splayed)
  legTipOut: 0.018,
  legTipDown: 0.020,
  legTipFwd: 0.010,
});

const D = LADYBUG_DIMS;

/**
 * Bone table: [name, parentName, worldBindPos [x,y,z]].
 * Order defines the skin index used by ladybugBodyGeometry.
 * @type {Array<[string, string | null, [number, number, number]]>}
 */
export const LADYBUG_BONE_DEFS = (() => {
  /** @type {Array<[string, string | null, [number, number, number]]>} */
  const defs = [];
  const add = (name, parent, pos) => defs.push([name, parent, pos]);

  add('root', null, [0, 0, 0]);
  add('thorax', 'root', [0, D.bodyCenterY, D.thoraxZ]);
  add('abdomen_0', 'thorax', [0, D.bodyCenterY - 0.002, D.abdomenZ]);
  add('abdomen_1', 'abdomen_0', [0, D.bellyY + 0.012, D.rumpZ]);
  add('head', 'thorax', [0, D.headCenterY, D.headCenterZ]);
  add('ant_L', 'head', [D.antBaseX, D.antBaseY, D.antBaseZ]);
  add('ant_R', 'head', [-D.antBaseX, D.antBaseY, D.antBaseZ]);
  add('elytra_L', 'thorax', [D.elytraHingeX, D.elytraHingeY, D.elytraHingeZ]);
  add('elytra_R', 'thorax', [-D.elytraHingeX, D.elytraHingeY, D.elytraHingeZ]);

  // Six legs: single control bone at coxa; geometry multi-segments along the bone.
  for (const [side, sx] of [['L', 1], ['R', -1]]) {
    for (const [tag, attach] of [
      ['F', D.legFL],
      ['M', D.legML],
      ['H', D.legHL],
    ]) {
      const name = `leg_${tag}${side}`;
      add(name, 'thorax', [
        sx * attach.x,
        D.legAttachY,
        attach.z,
      ]);
    }
  }

  return defs;
})();

/** Six leg control bones, L then R, front→hind. */
export const LADYBUG_LEG_BONES = Object.freeze([
  'leg_FL', 'leg_ML', 'leg_HL',
  'leg_FR', 'leg_MR', 'leg_HR',
]);

/**
 * Tripod gait groups (classic insect alternate tripods).
 * Group A: FL + MR + HL; Group B: FR + ML + HR.
 */
export const LADYBUG_TRIPOD_A = Object.freeze(['leg_FL', 'leg_MR', 'leg_HL']);
export const LADYBUG_TRIPOD_B = Object.freeze(['leg_FR', 'leg_ML', 'leg_HR']);

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
export function createLadybugSkeleton() {
  const root = new THREE.Group();
  root.name = 'LadybugArmature';

  /** @type {THREE.Bone[]} */
  const bones = [];
  const bonesByName = new Map();
  const boneIndex = new Map();
  const worldBindPos = new Map();

  for (const [name, parentName, pos] of LADYBUG_BONE_DEFS) {
    const bone = new THREE.Bone();
    bone.name = name;
    const world = new THREE.Vector3(...pos);
    worldBindPos.set(name, world.clone());
    if (parentName) {
      const parent = bonesByName.get(parentName);
      if (!parent) throw new Error(`ladybug bone ${name}: missing parent ${parentName}`);
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

  // Studio alias used by head-close camera presets.
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
