import { toRuntimeRigifyBoneName } from './rigifySkeleton.js';

// Quaternius outfits use the original Universal Base Character UE skeleton.
// Prepared UBC bodies retain leaf bones but rename the 52 animated/deforming
// bones into Dreamfall's DEF convention. This is the same mapping used by
// scripts/prepare-simhuman-glb.py.
const UE_TO_DEF = Object.freeze({
  pelvis: 'DEF-spine',
  spine_01: 'DEF-spine.001',
  spine_02: 'DEF-spine.002',
  spine_03: 'DEF-spine.003',
  neck_01: 'DEF-spine.005',
  neck_02: 'DEF-spine.005',
  Head: 'DEF-spine.006',
  head: 'DEF-spine.006',
  clavicle_l: 'DEF-shoulder.L',
  clavicle_r: 'DEF-shoulder.R',
  upperarm_l: 'DEF-upper_arm.L',
  upperarm_r: 'DEF-upper_arm.R',
  lowerarm_l: 'DEF-forearm.L.001',
  lowerarm_r: 'DEF-forearm.R.001',
  hand_l: 'DEF-hand.L',
  hand_r: 'DEF-hand.R',
  thigh_l: 'DEF-thigh.L',
  thigh_r: 'DEF-thigh.R',
  calf_l: 'DEF-thigh.L.001',
  calf_r: 'DEF-thigh.R.001',
  foot_l: 'DEF-foot.L',
  foot_r: 'DEF-foot.R',
  ball_l: 'DEF-toe.L',
  ball_r: 'DEF-toe.R',
  thumb_01_l: 'DEF-thumb.01.L',
  thumb_02_l: 'DEF-thumb.02.L',
  thumb_03_l: 'DEF-thumb.03.L',
  index_01_l: 'DEF-f_index.01.L',
  index_02_l: 'DEF-f_index.02.L',
  index_03_l: 'DEF-f_index.03.L',
  middle_01_l: 'DEF-f_middle.01.L',
  middle_02_l: 'DEF-f_middle.02.L',
  middle_03_l: 'DEF-f_middle.03.L',
  ring_01_l: 'DEF-f_ring.01.L',
  ring_02_l: 'DEF-f_ring.02.L',
  ring_03_l: 'DEF-f_ring.03.L',
  pinky_01_l: 'DEF-f_pinky.01.L',
  pinky_02_l: 'DEF-f_pinky.02.L',
  pinky_03_l: 'DEF-f_pinky.03.L',
  thumb_01_r: 'DEF-thumb.01.R',
  thumb_02_r: 'DEF-thumb.02.R',
  thumb_03_r: 'DEF-thumb.03.R',
  index_01_r: 'DEF-f_index.01.R',
  index_02_r: 'DEF-f_index.02.R',
  index_03_r: 'DEF-f_index.03.R',
  middle_01_r: 'DEF-f_middle.01.R',
  middle_02_r: 'DEF-f_middle.02.R',
  middle_03_r: 'DEF-f_middle.03.R',
  ring_01_r: 'DEF-f_ring.01.R',
  ring_02_r: 'DEF-f_ring.02.R',
  ring_03_r: 'DEF-f_ring.03.R',
  pinky_01_r: 'DEF-f_pinky.01.R',
  pinky_02_r: 'DEF-f_pinky.02.R',
  pinky_03_r: 'DEF-f_pinky.03.R',
});

export function toSimOutfitTargetBoneName(sourceBoneName) {
  return toRuntimeRigifyBoneName(UE_TO_DEF[sourceBoneName] ?? sourceBoneName);
}

/**
 * Resolve a body bone for an outfit joint name.
 * Tries UE→DEF map, raw name, and sanitized variants (Three strips `.` `:`).
 * @param {Record<string, import('three').Bone>} bones
 * @param {string} sourceBoneName
 * @returns {import('three').Bone|null}
 */
export function resolveSimOutfitBone(bones, sourceBoneName) {
  if (!bones || !sourceBoneName) return null;
  const mapped = UE_TO_DEF[sourceBoneName] ?? sourceBoneName;
  const candidates = [
    toRuntimeRigifyBoneName(mapped),
    mapped,
    sourceBoneName,
    toRuntimeRigifyBoneName(sourceBoneName),
  ];
  for (const key of candidates) {
    if (key && bones[key]) return bones[key];
  }
  // Case-insensitive / fuzzy tail match (DEF-upper_arm.L vs DEFupper_armL).
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const want = norm(mapped);
  for (const [key, bone] of Object.entries(bones)) {
    if (norm(key) === want) return bone;
  }
  return null;
}
