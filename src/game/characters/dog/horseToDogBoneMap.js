/** Shared quadruped animation map: horse-rigged.glb source joint → procedural dog joint. */
export const HORSE_TO_DOG_BONE_MAP = Object.freeze({
  root: 'Root',
  Hips: 'Pelvis',
  Spine_1: 'Spine',
  Spine_2: 'Spine1',
  Spine_2001: 'Chest',
  Spine_3: 'Neck',
  Head: 'Head',
  Headtip: 'NoseTip',
  Ear_L: 'EarL0',
  Ear_Tip_L: 'EarL2',
  Ear_R: 'EarR0',
  Ear_Tip_R: 'EarR2',
  Front_Leg_Shoulder_L: 'ShoulderL',
  Front_Leg_Upper_L: 'UpperArmL',
  Front_Leg_Lower_L: 'ForearmL',
  Front_Leg_Ankle_L: 'PasternL',
  Front_Leg_Foot_L: 'PawL',
  Front_Leg_Shoulder_R: 'ShoulderR',
  Front_Leg_Upper_R: 'UpperArmR',
  Front_Leg_Lower_R: 'ForearmR',
  Front_Leg_Ankle_R: 'PasternR',
  Front_Leg_Foot_R: 'PawR',
  Back_Leg_Pelvis_L: 'HipL',
  Back_Leg_Upper_L: 'ThighL',
  Back_Leg_Lower_L: 'ShinL',
  Back_Leg_Ankle_L: 'HockL',
  Back_Leg_Foot_L: 'HindPawL',
  Back_Leg_Pelvis_R: 'HipR',
  Back_Leg_Upper_R: 'ThighR',
  Back_Leg_Lower_R: 'ShinR',
  Back_Leg_Ankle_R: 'HockR',
  Back_Leg_Foot_R: 'HindPawR',
  Tail_Base: 'Tail0',
  Tail_Mid: 'Tail1',
  Tail_Mid001: 'Tail2',
  Tail_End: 'Tail3',
  Tail_Tip: 'Tail4',
});

export const INTENTIONALLY_UNMAPPED_HORSE_BONES = Object.freeze([
  'Spine_4',
  // Horse chin: its pose in the Rest Pose reference sits 30-35deg away from
  // every locomotion clip, so retargeting it cranked the dog jaw permanently.
  // The dog Jaw stays procedural-only (pant/bark) and rides the head in clips.
  'Chin',
  'Chin_Tip',
  'Stomach',
  'Stomach_tip',
  'Front_Leg_Tip_L',
  'Front_Leg_Tip_R',
  'Back_Leg_Foot_1_L',
  'Back_Leg_Foot_1_R',
  'Back_Leg_Tip_L',
  'Back_Leg_Tip_R',
]);

export function mapHorseBoneName(name) {
  return HORSE_TO_DOG_BONE_MAP[name] ?? null;
}

