/**
 * Easy Animated Enemy Pack Rat.fbx → shared procedural dog skeleton.
 *
 * Rat rig is a short-limb quadruped with no mid-spine chain (Hips → Neck → Head)
 * and 7 tail segments. We map onto dog Pelvis/Spine/Chest and Tail0–4.
 *
 * NOTE: After FBX→GLB conversion, Blender-style dotted side suffixes are often
 * stripped (`FrontLeg.L` → `FrontLegL`). Map both forms so retarget never
 * silently drops leg tracks (which freezes rodent locomotion).
 */

const RAT_TO_DOG_BONE_MAP_CORE = {
  root: 'Root',
  Hips: 'Pelvis',
  // Optional mid-torso helpers if present on a future export.
  Body: 'Spine',
  Back: 'Spine1',
  Shoulders: 'Chest',
  Torso: 'Spine',
  // No intermediate spine bones on the stock rat — fold neck/head onto dog chain.
  Neck: 'Neck',
  Head: 'Head',
  Head_end: 'NoseTip',

  // Legs — dotted (source FBX / some exporters)
  'FrontLeg.L': 'ShoulderL',
  'FrontUpLeg.L': 'UpperArmL',
  'FrontLowLeg.L': 'ForearmL',
  'FrontFoot.L': 'PawL',
  'FrontLeg.R': 'ShoulderR',
  'FrontUpLeg.R': 'UpperArmR',
  'FrontLowLeg.R': 'ForearmR',
  'FrontFoot.R': 'PawR',
  'BackLeg.L': 'HipL',
  'BackUpLeg.L': 'ThighL',
  'BackLowLeg.L': 'ShinL',
  'BackFoot.L': 'HindPawL',
  'BackLeg.R': 'HipR',
  'BackUpLeg.R': 'ThighR',
  'BackLowLeg.R': 'ShinR',
  'BackFoot.R': 'HindPawR',

  // Legs — undotted (common after glTF round-trip)
  FrontLegL: 'ShoulderL',
  FrontUpLegL: 'UpperArmL',
  FrontLowLegL: 'ForearmL',
  FrontFootL: 'PawL',
  FrontLegR: 'ShoulderR',
  FrontUpLegR: 'UpperArmR',
  FrontLowLegR: 'ForearmR',
  FrontFootR: 'PawR',
  BackLegL: 'HipL',
  BackUpLegL: 'ThighL',
  BackLowLegL: 'ShinL',
  BackFootL: 'HindPawL',
  BackLegR: 'HipR',
  BackUpLegR: 'ThighR',
  BackLowLegR: 'ShinR',
  BackFootR: 'HindPawR',

  Tail1: 'Tail0',
  Tail2: 'Tail1',
  Tail3: 'Tail2',
  Tail4: 'Tail3',
  Tail5: 'Tail4',
  // Tail6/Tail7 collapse onto tip — extras ignored
};

export const RAT_TO_DOG_BONE_MAP = Object.freeze(RAT_TO_DOG_BONE_MAP_CORE);

export const INTENTIONALLY_UNMAPPED_RAT_BONES = Object.freeze([
  'Tail6',
  'Tail7',
  'Tail7_end',
  'FrontLowLeg.L_end',
  'FrontLowLeg.R_end',
  'FrontFoot.L_end',
  'FrontFoot.R_end',
  'BackLowLeg.L_end',
  'BackLowLeg.R_end',
  'BackFoot.L_end',
  'BackFoot.R_end',
  'FrontLowLegL_end',
  'FrontLowLegR_end',
  'FrontFootL_end',
  'FrontFootR_end',
  'BackLowLegL_end',
  'BackLowLegR_end',
  'BackFootL_end',
  'BackFootR_end',
  'Torso_end',
  'Armature',
  'Skeleton',
]);

export function mapRatBoneName(name) {
  if (RAT_TO_DOG_BONE_MAP[name]) return RAT_TO_DOG_BONE_MAP[name];
  // Tolerate leftover dotted/undotted mismatches.
  if (name?.includes('.')) {
    const undotted = name.replace(/\./g, '');
    if (RAT_TO_DOG_BONE_MAP[undotted]) return RAT_TO_DOG_BONE_MAP[undotted];
  }
  return null;
}

/** Normalize Armature|Armature|Rat_Idle → Idle, Rat_Walk → Walk, etc. */
export function normalizeRatClipName(rawName) {
  let base = String(rawName ?? '').trim();
  // Strip Armature| prefixes (Blender may nest them).
  base = base.replace(/^(Armature\|)+/gi, '');
  base = base.replace(/\.tak$/i, '');
  // Prefer the Rat_* token if present.
  const ratToken = base.match(/Rat_([A-Za-z0-9]+)/i);
  if (ratToken) base = ratToken[1];
  else base = base.replace(/^Rat_/i, '');
  base = base.trim();
  if (!base) return null;
  // Collapse Run0 onto Run for catalog simplicity.
  if (/^Run0$/i.test(base)) return 'Run';
  if (/^AttackT$/i.test(base)) return 'Attack';
  // Title-case single tokens.
  return base.charAt(0).toUpperCase() + base.slice(1);
}
