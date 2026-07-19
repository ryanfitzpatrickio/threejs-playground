/**
 * Quaternius "Farm Animals Animated" FBX skeleton → procedural dog joints.
 *
 * Shared hierarchy across Horse / Cow / Zebra / Pig / Sheep / Llama / Pug:
 *   Body → Hips / Shoulders / Back / Tail*
 *   FrontLeg* → FrontUpLeg* → FrontLowLeg* → FrontFoot*
 *   BackLeg* → BackUpLeg* → BackLowLeg* → BackFoot*
 *
 * Full locomotion (Idle, Walk, WalkSlow, Run, Jump, Death): Horse, Cow, Zebra.
 * Partial (Idle, Jump): Llama, Pig, Pug, Sheep.
 */

export const QUATERNIUS_TO_DOG_BONE_MAP = Object.freeze({
  // Spine: Body→Hips→Torso and Body→Shoulders→Neck→Head (parallel branches).
  Body: 'Pelvis',
  Hips: 'Spine',
  Torso: 'Spine1',
  Shoulders: 'Chest',
  Neck: 'Neck',
  Head: 'Head',
  // Back is the tail root on Horse/Cow/Zebra (parent of Tail1); leave unmapped
  // so Tail* map cleanly onto dog Tail0–3 without double-driving Chest.

  // Front legs (L/R). Foot nodes parent under root in the FBX; still map world rot.
  FrontLegL: 'ShoulderL',
  FrontUpLegL: 'UpperArmL',
  FrontLowLegL: 'ForearmL',
  FrontFootL: 'PawL',
  FrontLegR: 'ShoulderR',
  FrontUpLegR: 'UpperArmR',
  FrontLowLegR: 'ForearmR',
  FrontFootR: 'PawR',

  // Hind legs
  BackLegL: 'HipL',
  BackUpLegL: 'ThighL',
  BackLowLegL: 'ShinL',
  BackFootL: 'HindPawL',
  BackLegR: 'HipR',
  BackUpLegR: 'ThighR',
  BackLowLegR: 'ShinR',
  BackFootR: 'HindPawR',

  // Tail (Horse / Cow / Zebra only — Pig/Llama/Sheep use Back_end stub)
  Tail1: 'Tail0',
  Tail2: 'Tail1',
  Tail3: 'Tail2',
  Tail4: 'Tail3',
});

/** Bones intentionally left unmapped (tips / ends / root). */
export const INTENTIONALLY_UNMAPPED_QUATERNIUS_BONES = Object.freeze([
  'root',
  'Torso_end',
  'Back_end',
  'Head_end', // also mapped Head_end→NoseTip when present as animated track
  'FrontLowLegL_end',
  'FrontLowLegR_end',
  'BackLowLegL_end',
  'BackLowLegR_end',
  'FrontFootL_end',
  'FrontFootR_end',
  'BackFootL_end',
  'BackFootR_end',
  'Tail4_end',
]);

/**
 * Normalize `Armature|Walk` / `Armature|WalkSlow` → studio clip names.
 * @param {string} name
 * @returns {string | null}
 */
export function normalizeQuaterniusClipName(name) {
  if (!name || typeof name !== 'string') return null;
  let n = name;
  const pipe = n.lastIndexOf('|');
  if (pipe >= 0) n = n.slice(pipe + 1);
  n = n.replace(/^Armature[_\s.]*/i, '').trim();
  // Canonical labels matching DOG_CLIP_CATALOG where possible.
  const aliases = {
    WalkSlow: 'Walk Slow',
    walkslow: 'Walk Slow',
    Walk_Slow: 'Walk Slow',
    Idle: 'Idle',
    Walk: 'Walk',
    Run: 'Run',
    Jump: 'Jump',
    Death: 'Death',
  };
  if (aliases[n]) return aliases[n];
  // Title-case fallback
  return n.replace(/[_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function mapQuaterniusBoneName(name) {
  return QUATERNIUS_TO_DOG_BONE_MAP[name] ?? null;
}
