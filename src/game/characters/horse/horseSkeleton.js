/**
 * Fully procedural domestic horse skeleton (~120 bones, built in code — no GLB).
 *
 * This is the "horse v2" rig: a bespoke equine armature that replaces nothing —
 * the v1 `domestic-horse` phenotype keeps riding the shared dog skeleton +
 * Quaternius equid clip pack. This rig exists because the dog skeleton can't
 * express the horse's defining structure: a long multi-vertebra neck column
 * with a crest, a detailed distal limb (carpus/hock → cannon → fetlock →
 * pastern → hoof) with pastern flex and hoof breakover, an expressive face
 * (jaw, nostrils, lips, eyelids), independent ears, a mane, and a long
 * haired tail.
 *
 * Conventions (match DogSimScene studio + the cat/goose rigs):
 *   meters, ground y=0, horse faces +Z, profile camera on +X.
 *   Bind pose == square halt (reference profile.jpg): all four hooves planted,
 *   level topline, neck raised ~45°, head angled down-forward, tail hanging.
 *   Every bone binds with IDENTITY rotation, so geometry is authored directly
 *   in world bind space and animation applies quaternion deltas on top (same
 *   trick the goose/cat rigs use).
 *
 * Structure (≈120 bones):
 *   root → hips (pelvis) + pelvis_L/R wings
 *   spine_0..9 (lumbar → thoracic → withers), chest + breast volumes
 *   rib_{L,R}_{0..4} ribcage approximation, belly + flank_L/R jiggle bones
 *   neck_0..6 (7 cervical), throat
 *   head: jaw/chin/tongue/lips, muzzle/noseTip/nostrils, cheeks, brows,
 *         eyes + upper/lower eyelids, forelock ×2
 *   ear_{L,R}_{0,1}, mane_0..9 crest chain, tail_0..11 (dock + hair)
 *   fore ×2: scapula → humerus → radius → carpus → cannon → fetlock →
 *            hoof → hoofTip  (+ shoulder muscle helper)
 *   hind ×2: femur → tibia → tarsus → cannon → fetlock → hoof → hoofTip
 *            (+ haunch muscle helper)
 */

import * as THREE from 'three';

/**
 * Landmark dimensions measured off the equid-ref boards
 * (public/assets/equid-ref/domestic-horse/profile.jpg) as pixel ratios scaled
 * to a 1.58 m withers height (515 px withers on the 960 px board → 3.07 mm/px).
 * Shared by geometry, coat masks, and animation so every consumer agrees.
 */
export const HORSE_DIMS = Object.freeze({
  withersY: 1.58,
  croupY: 1.50,
  backY: 1.40,          // topline dip between withers and croup
  bellyY: 0.92,
  chestFrontZ: 0.80,    // breast most-forward point
  rumpZ: -0.80,
  bodyHalfWidth: 0.33,
  // neck / head (poll 630 px → 1.93 m; head length ≈ 0.37 × withers)
  neckBaseY: 1.50,
  neckBaseZ: 0.58,
  pollY: 1.92,
  pollZ: 1.13,
  headCenterY: 1.90,
  headCenterZ: 1.22,
  browY: 1.84,
  browZ: 1.28,
  muzzleY: 1.60,
  muzzleZ: 1.42,
  noseTipY: 1.475,
  noseTipZ: 1.52,
  headHalfWidth: 0.105,
  // eyes — laterally set on the side wall of the skull (ref head-close.jpg)
  eyeX: 0.105,
  eyeY: 1.79,
  eyeZ: 1.30,
  eyeRadius: 0.028,
  // ears
  earBaseX: 0.055,
  earBaseY: 1.985,
  earBaseZ: 1.13,
  earTipX: 0.082,
  earTipY: 2.10,
  earTipZ: 1.10,
  // fore leg (elbow 265 px → 0.81, knee 155 px → 0.48, fetlock 55 px → 0.17)
  foreX: 0.145,
  scapulaY: 1.46,
  scapulaZ: 0.40,
  shoulderY: 1.13,
  shoulderZ: 0.61,
  elbowY: 0.81,
  elbowZ: 0.54,
  carpusY: 0.48,
  carpusZ: 0.58,
  fCannonY: 0.43,
  fCannonZ: 0.585,
  fFetlockY: 0.165,
  fFetlockZ: 0.60,
  fHoofY: 0.07,
  fHoofZ: 0.645,
  fToeY: 0.005,
  fToeZ: 0.71,
  // hind leg (stifle 0.90, hock 0.60, fetlock 0.17)
  hindX: 0.16,
  hipY: 1.28,
  hipZ: -0.58,
  stifleY: 0.90,
  stifleZ: -0.34,
  hockY: 0.60,
  hockZ: -0.64,
  hCannonY: 0.54,
  hCannonZ: -0.625,
  hFetlockY: 0.17,
  hFetlockZ: -0.56,
  hHoofY: 0.07,
  hHoofZ: -0.52,
  hToeY: 0.005,
  hToeZ: -0.45,
  // tail (dock off the croup, hair hanging to ~hock height)
  tailBaseY: 1.48,
  tailBaseZ: -0.78,
});

const D = HORSE_DIMS;

/**
 * Bone table: [name, parentName, worldBindPos [x,y,z]].
 * Order defines the skin index used by horseBodyGeometry.
 * @type {Array<[string, string | null, [number, number, number]]>}
 */
export const HORSE_BONE_DEFS = (() => {
  /** @type {Array<[string, string | null, [number, number, number]]>} */
  const defs = [];
  const add = (name, parent, pos) => defs.push([name, parent, pos]);

  add('root', null, [0, 0, 0]);
  add('hips', 'root', [0, 1.42, -0.62]);
  add('pelvis_L', 'hips', [0.16, 1.40, -0.66]);
  add('pelvis_R', 'hips', [-0.16, 1.40, -0.66]);

  // ---- spine: lumbar → thoracic → withers (10 controls) ---------------------
  const spinePath = [
    [1.44, -0.48],
    [1.43, -0.34],
    [1.42, -0.20],
    [1.41, -0.06],
    [1.40, 0.08],
    [1.41, 0.20],
    [1.43, 0.30],
    [1.46, 0.38],
    [1.50, 0.45],
    [1.53, 0.50],   // withers crest / neck root
  ];
  let prev = 'hips';
  spinePath.forEach(([y, z], i) => {
    add(`spine_${i}`, prev, [0, y, z]);
    prev = `spine_${i}`;
  });
  add('chest', 'spine_5', [0, 1.05, 0.28]);    // sternum / breath volume
  add('breast', 'spine_8', [0, 1.12, 0.70]);   // pectoral mass

  // ---- ribcage approximation: 5 hanger pairs off the thoracic spine --------
  for (let i = 0; i < 5; i += 1) {
    const parent = `spine_${i + 2}`;
    const z = spinePath[i + 2][1];
    add(`rib_L_${i}`, parent, [0.28, 1.18, z]);
    add(`rib_R_${i}`, parent, [-0.28, 1.18, z]);
  }
  add('belly', 'spine_3', [0, 0.96, -0.06]);
  add('flank_L', 'hips', [0.28, 1.10, -0.42]);
  add('flank_R', 'hips', [-0.28, 1.10, -0.42]);

  // ---- neck: 7 cervical controls rising withers → poll ----------------------
  const neckPath = [
    [1.50, 0.58],
    [1.58, 0.70],
    [1.66, 0.81],
    [1.74, 0.91],
    [1.81, 1.00],
    [1.87, 1.07],
    [D.pollY, D.pollZ],
  ];
  prev = 'spine_9';
  neckPath.forEach(([y, z], i) => {
    add(`neck_${i}`, prev, [0, y, z]);
    prev = `neck_${i}`;
  });
  add('throat', 'neck_2', [0, 1.48, 0.86]);

  // ---- head + expressive face ----------------------------------------------
  add('head', 'neck_6', [0, D.headCenterY, D.headCenterZ]);
  add('jaw', 'head', [0, 1.74, 1.18]);          // hinge high + back → chin swings
  add('chin', 'jaw', [0, 1.53, 1.42]);
  add('lip_lower', 'chin', [0, 1.468, 1.505]);
  add('tongue', 'jaw', [0, 1.56, 1.34]);
  add('muzzle', 'head', [0, D.muzzleY, D.muzzleZ]);
  add('noseTip', 'muzzle', [0, D.noseTipY, D.noseTipZ]);
  add('lip_upper', 'noseTip', [0, 1.452, 1.535]);
  for (const side of ['L', 'R']) {
    const s = side === 'L' ? 1 : -1;
    add(`nostril_${side}`, 'muzzle', [s * 0.047, 1.50, 1.485]);
    add(`lip_corner_${side}`, 'jaw', [s * 0.048, 1.51, 1.42]);
    add(`cheek_${side}`, 'head', [s * 0.092, 1.72, 1.22]);
    add(`brow_${side}`, 'head', [s * 0.085, D.browY + 0.02, D.browZ - 0.01]);
    add(`eye_${side}`, 'head', [s * D.eyeX, D.eyeY, D.eyeZ]);
    add(`eyelid_up_${side}`, 'head', [s * D.eyeX, D.eyeY + 0.018, D.eyeZ]);
    add(`eyelid_low_${side}`, 'head', [s * D.eyeX, D.eyeY - 0.018, D.eyeZ]);
  }
  add('forelock', 'head', [0, 1.97, 1.22]);
  add('forelock_1', 'forelock', [0, 1.94, 1.33]);

  // ---- ears: base + tip for independent swivel/spring -----------------------
  for (const side of ['L', 'R']) {
    const s = side === 'L' ? 1 : -1;
    add(`ear_${side}_0`, 'head', [s * D.earBaseX, D.earBaseY, D.earBaseZ]);
    add(`ear_${side}_1`, `ear_${side}_0`, [s * D.earTipX, D.earTipY, D.earTipZ]);
  }

  // ---- mane: 10 crest controls, each hung off the nearest neck/withers bone -
  // (independent parents so each spring sways without compounding down a chain)
  const maneParents = ['spine_8', 'spine_9', 'neck_0', 'neck_1', 'neck_2', 'neck_3', 'neck_4', 'neck_5', 'neck_6', 'neck_6'];
  // Crest-line points ON the neck loft's top surface (ring center + ht along
  // the tilted ring frame) so the mane curtain roots at the ridge, not inside
  // the neck volume.
  const maneCrest = [
    [1.60, 0.42],
    [1.64, 0.50],
    [1.68, 0.58],
    [1.73, 0.66],
    [1.78, 0.74],
    [1.84, 0.82],
    [1.89, 0.90],
    [1.94, 0.99],
    [1.98, 1.08],
    [2.00, 1.16],
  ];
  maneCrest.forEach(([y, z], i) => {
    add(`mane_${i}`, maneParents[i], [0, y, z]);
  });

  // ---- tail: 12 caudal controls — 3 dock bones arcing off the croup,
  //      then the hair mass hanging to hock height ---------------------------
  const tailPath = [
    [D.tailBaseY, D.tailBaseZ],
    [1.45, -0.90],
    [1.36, -0.98],
    [1.20, -1.02],
    [1.03, -1.045],
    [0.87, -1.055],
    [0.72, -1.055],
    [0.59, -1.05],
    [0.48, -1.045],
    [0.40, -1.04],
    [0.34, -1.035],
    [0.29, -1.03],
  ];
  prev = 'hips';
  tailPath.forEach(([y, z], i) => {
    add(`tail_${i}`, prev, [0, y, z]);
    prev = `tail_${i}`;
  });

  // ---- fore legs: scapula → humerus → radius → carpus → cannon → fetlock →
  //      hoof → hoofTip, plus a shoulder muscle helper -----------------------
  for (const side of ['L', 'R']) {
    const s = side === 'L' ? 1 : -1;
    const x = s * D.foreX;
    add(`shoulder_${side}`, 'spine_8', [x * 0.9, 1.34, 0.48]);
    add(`scapula_${side}`, 'spine_8', [x * 0.78, D.scapulaY, D.scapulaZ]);
    add(`humerus_${side}`, `scapula_${side}`, [x, D.shoulderY, D.shoulderZ]);
    add(`radius_${side}`, `humerus_${side}`, [x, D.elbowY, D.elbowZ]);
    add(`carpus_${side}`, `radius_${side}`, [x, D.carpusY, D.carpusZ]);
    add(`cannon_F_${side}`, `carpus_${side}`, [x, D.fCannonY, D.fCannonZ]);
    add(`fetlock_F_${side}`, `cannon_F_${side}`, [x, D.fFetlockY, D.fFetlockZ]);
    add(`hoof_F_${side}`, `fetlock_F_${side}`, [x, D.fHoofY, D.fHoofZ]);
    add(`hoofTip_F_${side}`, `hoof_F_${side}`, [x, D.fToeY, D.fToeZ]);
  }

  // ---- hind legs: femur → tibia → tarsus → cannon → fetlock → hoof → tip,
  //      plus a haunch muscle helper ------------------------------------------
  for (const side of ['L', 'R']) {
    const s = side === 'L' ? 1 : -1;
    const x = s * D.hindX;
    add(`haunch_${side}`, 'hips', [x * 0.9, 1.22, -0.48]);
    add(`femur_${side}`, `pelvis_${side}`, [x, D.hipY, D.hipZ]);
    add(`tibia_${side}`, `femur_${side}`, [x * 1.05, D.stifleY, D.stifleZ]);
    add(`tarsus_${side}`, `tibia_${side}`, [x, D.hockY, D.hockZ]);
    add(`cannon_H_${side}`, `tarsus_${side}`, [x, D.hCannonY, D.hCannonZ]);
    add(`fetlock_H_${side}`, `cannon_H_${side}`, [x, D.hFetlockY, D.hFetlockZ]);
    add(`hoof_H_${side}`, `fetlock_H_${side}`, [x, D.hHoofY, D.hHoofZ]);
    add(`hoofTip_H_${side}`, `hoof_H_${side}`, [x, D.hToeY, D.hToeZ]);
  }

  return defs;
})();

/** Chains used by animation / IK. */
export const HORSE_CHAINS = Object.freeze({
  spine: ['hips', 'spine_0', 'spine_1', 'spine_2', 'spine_3', 'spine_4', 'spine_5', 'spine_6', 'spine_7', 'spine_8', 'spine_9'],
  neck: ['neck_0', 'neck_1', 'neck_2', 'neck_3', 'neck_4', 'neck_5', 'neck_6'],
  tail: ['tail_0', 'tail_1', 'tail_2', 'tail_3', 'tail_4', 'tail_5', 'tail_6', 'tail_7', 'tail_8', 'tail_9', 'tail_10', 'tail_11'],
  earL: ['ear_L_0', 'ear_L_1'],
  earR: ['ear_R_0', 'ear_R_1'],
  foreL: ['scapula_L', 'humerus_L', 'radius_L', 'carpus_L', 'cannon_F_L', 'fetlock_F_L', 'hoof_F_L', 'hoofTip_F_L'],
  foreR: ['scapula_R', 'humerus_R', 'radius_R', 'carpus_R', 'cannon_F_R', 'fetlock_F_R', 'hoof_F_R', 'hoofTip_F_R'],
  hindL: ['femur_L', 'tibia_L', 'tarsus_L', 'cannon_H_L', 'fetlock_H_L', 'hoof_H_L', 'hoofTip_H_L'],
  hindR: ['femur_R', 'tibia_R', 'tarsus_R', 'cannon_H_R', 'fetlock_H_R', 'hoof_H_R', 'hoofTip_H_R'],
});

/** Four ground contacts (used to plant the posed frame). */
export const HORSE_HOOF_TIPS = Object.freeze([
  'hoofTip_F_L', 'hoofTip_F_R', 'hoofTip_H_L', 'hoofTip_H_R',
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
export function createHorseSkeleton() {
  const root = new THREE.Group();
  root.name = 'HorseArmature';

  /** @type {THREE.Bone[]} */
  const bones = [];
  const bonesByName = new Map();
  const boneIndex = new Map();
  const worldBindPos = new Map();

  for (const [name, parentName, pos] of HORSE_BONE_DEFS) {
    const bone = new THREE.Bone();
    bone.name = name;
    const world = new THREE.Vector3(...pos);
    worldBindPos.set(name, world.clone());
    if (parentName) {
      const parent = bonesByName.get(parentName);
      if (!parent) throw new Error(`horse bone ${name}: missing parent ${parentName}`);
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
