/**
 * Outfit fit drivers for skinned (non-morph) clothing.
 *
 * Authored outfits (Quaternius UBC) share the sim skeleton and currently ship
 * with zero morph targets. Body appearance still changes under the clothes via
 * vibe-human modeling morphs — this module maps only the morphs that actually
 * affect garment volume onto cheap runtime tricks:
 *
 * 1. Vertex-shader push-out along normals (primary)
 * 2. Optional per-region scale hints for future corrective bones / soft layers
 *
 * Face/skull/nose/mouth morphs are intentionally ignored (selective projection).
 */

/** Modeling control ids that change torso/limb bulk under clothing. */
export const OUTFIT_RELEVANT_MORPH_IDS = Object.freeze([
  'id.body.global.mass',
  'id.body.global.muscle',
  'id.body.global.fat',
]);

/**
 * Shape-key / glTF morph target names projected onto outfits offline
 * (see scripts/bake-outfit-morphs.py). Matches buildModelingMorphs() targets
 * for the body global controls only.
 */
export const OUTFIT_PROJECTED_MORPH_TARGETS = Object.freeze([
  'id.body.global.mass.neg',
  'id.body.global.mass.pos',
  'id.body.global.muscle.neg',
  'id.body.global.muscle.pos',
  'id.body.global.fat.pos',
]);

const RELEVANT_SET = new Set(OUTFIT_RELEVANT_MORPH_IDS);
const PROJECTED_SET = new Set(OUTFIT_PROJECTED_MORPH_TARGETS);

/** True if a morph-target name was part of the selective outfit bake. */
export function isOutfitProjectedMorphTarget(name) {
  return typeof name === 'string' && PROJECTED_SET.has(name);
}

/**
 * True if this modeling control can change how an outfit should fit.
 * Used when projecting morphs offline or when filtering applyAppearance input.
 */
export function isOutfitRelevantMorphId(controlId) {
  return typeof controlId === 'string' && RELEVANT_SET.has(controlId);
}

/**
 * Keep only morphs that affect outfit fit. Face morphs drop out.
 * @param {Record<string, number>|null|undefined} morphs
 * @returns {Record<string, number>}
 */
export function selectOutfitMorphs(morphs) {
  if (!morphs || typeof morphs !== 'object') return {};
  const out = {};
  for (const id of OUTFIT_RELEVANT_MORPH_IDS) {
    const v = Number(morphs[id]);
    if (Number.isFinite(v) && v !== 0) out[id] = v;
  }
  return out;
}

/**
 * Convert selective body morphs into fit scalars in **meters** of surface push
 * (local bind space after the body/outfit scale wrap).
 *
 * @param {Record<string, number>|null|undefined} morphs full appearance.morphs
 * @param {{ maxPush?: number }} [options]
 * @returns {{
 *   pushMeters: number,
 *   mass: number,
 *   muscle: number,
 *   fat: number,
 *   selected: Record<string, number>,
 * }}
 */
export function computeOutfitFitFromMorphs(morphs, options = {}) {
  const selected = selectOutfitMorphs(morphs);
  const mass = clamp(selected['id.body.global.mass'] ?? 0, -1, 1);
  const muscle = clamp(selected['id.body.global.muscle'] ?? 0, -1, 1);
  const fat = clamp(selected['id.body.global.fat'] ?? 0, 0, 1);

  // Tuned for ~1.75 m UBC: heavy/fat should open a few centimetres of cloth ease
  // without exploding thin garments. Muscle adds a smaller surface lift.
  const raw =
    mass * 0.014
    + fat * 0.02
    + muscle * 0.008
    // slight inward ease when very lean so clothes hang closer
    + Math.min(0, mass) * 0.004;

  const maxPush = Number.isFinite(options.maxPush) ? options.maxPush : 0.045;
  const pushMeters = clamp(raw, -0.01, maxPush);

  return {
    pushMeters,
    mass,
    muscle,
    fat,
    selected,
  };
}

/**
 * Region scale hints for a future corrective-bone pass. Not applied to the
 * shared body skeleton (that would double-deform the sim). Safe to store /
 * visualize; bone application needs outfit-local bones or a second skin bind.
 */
export function computeOutfitRegionScales(fit) {
  const bulk = (fit?.mass ?? 0) * 0.04 + (fit?.fat ?? 0) * 0.05 + (fit?.muscle ?? 0) * 0.025;
  const arm = (fit?.muscle ?? 0) * 0.03 + (fit?.mass ?? 0) * 0.015;
  const leg = (fit?.mass ?? 0) * 0.02 + (fit?.fat ?? 0) * 0.025;
  return {
    torso: 1 + bulk,
    upperArm: 1 + arm,
    thigh: 1 + leg,
  };
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
