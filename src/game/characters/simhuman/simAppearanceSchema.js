// Sim appearance preset schema.
//
// A preset is what the sim character creator saves to the `sims` fileStore
// collection and what createVibeHumanModel consumes: modeling-slider values
// (vibe-human MODELING_CONTROLS ids → [-1..1]), optional FACS expression
// values, skin material setting overrides, and garment references.

import {
  clampModelingValue,
  getModelingControlById,
} from '../../../vendor/vibe-human/characterModeling.ts';
import {
  DEFAULT_ARM_SPACE,
  sanitizeArmSpace,
} from './armRaisePose.js';
import { DEMO_SIM_GARMENT_ID } from './simGarmentConstants.js';
import {
  DEFAULT_SIM_HAIR_COLOR,
  DEFAULT_SIM_HAIR_FIT,
  DEFAULT_SIM_HAIR_STYLE_ID,
  isSimHairStyleId,
} from './simHairCatalog.js';
import { SIM_BODY_PROFILES, isSimBodyId } from './simBodyProfiles.js';
import { isSimOutfitId, isSimOutfitVariant } from './simOutfitCatalog.js';
import { sanitizeOutfitLoopCuts } from './outfitLoopCuts.js';

export const SIM_APPEARANCE_VERSION = 12;
export {
  DEFAULT_SIM_HAIR_COLOR,
  DEFAULT_SIM_HAIR_FIT,
  DEFAULT_SIM_HAIR_STYLE_ID,
  listSimHairOptions,
  isSimHairStyleId,
} from './simHairCatalog.js';
export {
  ARM_SPACE_MIN,
  ARM_SPACE_MAX,
  DEFAULT_ARM_SPACE,
  sanitizeArmSpace,
} from './armRaisePose.js';
export const SIM_BODY_OPTIONS = Object.freeze(
  SIM_BODY_PROFILES.map(({ id, label }) => Object.freeze({ id, label })),
);
const SIM_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Manual outfit fit scale relative to the body bind (1 = authored size). */
export const OUTFIT_SCALE_MIN = 0.85;
export const OUTFIT_SCALE_MAX = 1.25;
export const DEFAULT_OUTFIT_SCALE = Object.freeze({ x: 1, y: 1, z: 1 });
/** Bind-pose local offset applied to an authored outfit after baking. */
export const OUTFIT_POSITION_MIN = -0.5;
export const OUTFIT_POSITION_MAX = 0.5;
export const DEFAULT_OUTFIT_POSITION = Object.freeze({ x: 0, y: 0, z: 0 });

export function sanitizeOutfitScale(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const clampAxis = (value) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return 1;
    return Math.min(OUTFIT_SCALE_MAX, Math.max(OUTFIT_SCALE_MIN, num));
  };
  return {
    x: clampAxis(src.x ?? src[0] ?? 1),
    y: clampAxis(src.y ?? src[1] ?? 1),
    z: clampAxis(src.z ?? src[2] ?? 1),
  };
}

export function sanitizeOutfitPosition(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const clampAxis = (value) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return Math.min(OUTFIT_POSITION_MAX, Math.max(OUTFIT_POSITION_MIN, num));
  };
  return {
    x: clampAxis(src.x ?? src[0] ?? 0),
    y: clampAxis(src.y ?? src[1] ?? 0),
    z: clampAxis(src.z ?? src[2] ?? 0),
  };
}

/**
 * Recess multipliers for the real-skin companion that fills authored outfit
 * openings. 1 = legacy depth; smaller values move it closer to the garment.
 * Torso defaults shallower because the old fixed recess read as a second,
 * faceted shell in open backs and wide necklines. Limb seams keep the safer
 * legacy depth by default.
 */
export const OUTFIT_SKIN_TUCK_MIN = 0.1;
export const OUTFIT_SKIN_TUCK_MAX = 1.5;
export const DEFAULT_OUTFIT_SKIN_TUCK = Object.freeze({ torso: 0.5, seams: 1 });

export function sanitizeOutfitSkinTuck(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const clampMultiplier = (value, fallback) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(OUTFIT_SKIN_TUCK_MAX, Math.max(OUTFIT_SKIN_TUCK_MIN, num));
  };
  return {
    torso: clampMultiplier(src.torso, DEFAULT_OUTFIT_SKIN_TUCK.torso),
    seams: clampMultiplier(src.seams, DEFAULT_OUTFIT_SKIN_TUCK.seams),
  };
}

/**
 * Neckline tuck: how much real lower-neck, trap, and sternum skin stays
 * behind open collars. drop 0 = window off; enabled skin renders on the
 * recessed companion mesh installed by bodyHideUnderOutfit.
 */
export const DEFAULT_OUTFIT_TUCK = Object.freeze({ drop: 0, width: 0.5 });

export function sanitizeOutfitTuck(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const clamp01 = (value, fallback) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(1, Math.max(0, num));
  };
  return {
    drop: clamp01(src.drop, DEFAULT_OUTFIT_TUCK.drop),
    width: clamp01(src.width, DEFAULT_OUTFIT_TUCK.width),
  };
}

/**
 * How much authored clothing is replaced by the real body on each limb.
 * 0 = garment owns the complete region; 1 = body owns the complete limb.
 * Arms continue through 2, extending across shoulder/clavicle into center chest.
 */
export const DEFAULT_OUTFIT_LIMB_REVEAL = Object.freeze({ arms: 0, legs: 0, feet: 0 });
export const OUTFIT_ARM_REVEAL_MAX = 2;
export const OUTFIT_LIMB_REVEAL_MAX = 1;

export function sanitizeOutfitLimbReveal(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const clampReveal = (value, fallback, max) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(0, num));
  };
  return {
    arms: clampReveal(src.arms, DEFAULT_OUTFIT_LIMB_REVEAL.arms, OUTFIT_ARM_REVEAL_MAX),
    legs: clampReveal(src.legs, DEFAULT_OUTFIT_LIMB_REVEAL.legs, OUTFIT_LIMB_REVEAL_MAX),
    feet: clampReveal(src.feet, DEFAULT_OUTFIT_LIMB_REVEAL.feet, OUTFIT_LIMB_REVEAL_MAX),
  };
}

export function createDefaultSimAppearance(overrides = {}) {
  return {
    version: SIM_APPEARANCE_VERSION,
    id: overrides.id ?? `sim-${Math.random().toString(36).slice(2, 10)}`,
    name: overrides.name ?? 'New Sim',
    body: overrides.body ?? 'human5',
    morphs: { ...(overrides.morphs ?? {}) },
    facs: { ...(overrides.facs ?? {}) },
    skin: { ...(overrides.skin ?? {}) },
    garmentIds: [...(overrides.garmentIds ?? [DEMO_SIM_GARMENT_ID])],
    outfitId: overrides.outfitId ?? null,
    /** 'morph' = bulk shape keys (larger); 'standard' = no morphs (smaller). */
    outfitVariant: isSimOutfitVariant(overrides.outfitVariant) ? overrides.outfitVariant : 'morph',
    outfitScale: sanitizeOutfitScale(overrides.outfitScale ?? DEFAULT_OUTFIT_SCALE),
    outfitPosition: sanitizeOutfitPosition(
      overrides.outfitPosition ?? DEFAULT_OUTFIT_POSITION,
    ),
    outfitSkinTuck: sanitizeOutfitSkinTuck(
      overrides.outfitSkinTuck ?? DEFAULT_OUTFIT_SKIN_TUCK,
    ),
    outfitTuck: sanitizeOutfitTuck(overrides.outfitTuck ?? DEFAULT_OUTFIT_TUCK),
    outfitLimbReveal: sanitizeOutfitLimbReveal(
      overrides.outfitLimbReveal ?? DEFAULT_OUTFIT_LIMB_REVEAL,
    ),
    outfitLoopCuts: sanitizeOutfitLoopCuts(overrides.outfitLoopCuts),
    /**
     * Lateral arm raise (− in, + out). Applied after animation so hands clear
     * the thighs on bulkier bodies / tight outfits.
     */
    armSpace: sanitizeArmSpace(overrides.armSpace ?? DEFAULT_ARM_SPACE),
    /** Hair-cap catalog id, or null for bald. Default on for new Sims. */
    hairStyleId: overrides.hairStyleId === null
      ? null
      : (isSimHairStyleId(overrides.hairStyleId)
        ? overrides.hairStyleId
        : DEFAULT_SIM_HAIR_STYLE_ID),
    hairColor: sanitizeHairColor(overrides.hairColor ?? DEFAULT_SIM_HAIR_COLOR),
    hairFit: sanitizeHairFit(overrides.hairFit ?? DEFAULT_HAIR_FIT),
  };
}

export function sanitizeHairColor(raw) {
  const value = String(raw ?? '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(value)) {
    const [, r, g, b] = value;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return DEFAULT_SIM_HAIR_COLOR;
}

/**
 * Manual hair-cap fit relative to the head-bone socket
 * (auto-normalized in head space, top of mesh at bone origin).
 * scale is uniform; position is meters; rotation is Euler degrees (XYZ).
 */
export const HAIR_SCALE_MIN = 0.1;
export const HAIR_SCALE_MAX = 4;
/** Generous local-space range — offsets are head-bone local meters. */
export const HAIR_POS_MIN = -2.5;
export const HAIR_POS_MAX = 2.5;
export const HAIR_ROT_MIN = -180;
export const HAIR_ROT_MAX = 180;
/** Prefer showcase-tuned head fit; fall back identity if catalog missing. */
export const DEFAULT_HAIR_FIT = Object.freeze({
  scale: DEFAULT_SIM_HAIR_FIT?.scale ?? 1,
  position: Object.freeze({
    x: DEFAULT_SIM_HAIR_FIT?.position?.x ?? 0,
    y: DEFAULT_SIM_HAIR_FIT?.position?.y ?? 0,
    z: DEFAULT_SIM_HAIR_FIT?.position?.z ?? 0,
  }),
  rotation: Object.freeze({
    x: DEFAULT_SIM_HAIR_FIT?.rotation?.x ?? 0,
    y: DEFAULT_SIM_HAIR_FIT?.rotation?.y ?? 0,
    z: DEFAULT_SIM_HAIR_FIT?.rotation?.z ?? 0,
  }),
});

export function sanitizeHairFit(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const clamp = (value, min, max, fallback) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, num));
  };
  const pos = src.position && typeof src.position === 'object' ? src.position : src;
  const rot = src.rotation && typeof src.rotation === 'object' ? src.rotation : {};
  return {
    scale: clamp(src.scale ?? src.s, HAIR_SCALE_MIN, HAIR_SCALE_MAX, DEFAULT_HAIR_FIT.scale),
    position: {
      x: clamp(pos.x ?? pos[0], HAIR_POS_MIN, HAIR_POS_MAX, 0),
      y: clamp(pos.y ?? pos[1], HAIR_POS_MIN, HAIR_POS_MAX, 0),
      z: clamp(pos.z ?? pos[2], HAIR_POS_MIN, HAIR_POS_MAX, 0),
    },
    rotation: {
      x: clamp(rot.x ?? rot[0] ?? src.rotX, HAIR_ROT_MIN, HAIR_ROT_MAX, 0),
      y: clamp(rot.y ?? rot[1] ?? src.rotY, HAIR_ROT_MIN, HAIR_ROT_MAX, 0),
      z: clamp(rot.z ?? rot[2] ?? src.rotZ, HAIR_ROT_MIN, HAIR_ROT_MAX, 0),
    },
  };
}

// Returns a safe copy: unknown morph ids dropped, values clamped to the
// control's range, non-finite values discarded.
export function sanitizeSimAppearance(raw) {
  const sourceVersion = Number(raw?.version) || 1;
  const base = createDefaultSimAppearance(raw && typeof raw === 'object' ? raw : {});
  base.version = SIM_APPEARANCE_VERSION;
  if (!SIM_ID_PATTERN.test(String(base.id))) {
    base.id = createDefaultSimAppearance().id;
  }
  base.name = String(base.name ?? '').trim().slice(0, 80) || 'New Sim';
  base.body = isSimBodyId(base.body) ? String(base.body) : 'human5';

  const morphs = {};
  for (const [controlId, value] of Object.entries(base.morphs)) {
    if (!getModelingControlById(controlId)) continue;
    const num = Number(value);
    if (!Number.isFinite(num)) continue;
    morphs[controlId] = clampModelingValue(controlId, num);
  }
  base.morphs = morphs;

  const facs = {};
  for (const [key, value] of Object.entries(base.facs)) {
    const num = Number(value);
    if (!Number.isFinite(num)) continue;
    facs[key] = num;
  }
  base.facs = facs;

  base.garmentIds = base.garmentIds.filter((id) => typeof id === 'string' && id.length > 0);
  base.outfitId = isSimOutfitId(base.outfitId) ? base.outfitId : null;
  base.outfitVariant = isSimOutfitVariant(base.outfitVariant) ? base.outfitVariant : 'morph';
  // Authored outfits and simulated pattern garments occupy the same wardrobe
  // layer. Enforce that contract at the schema boundary so imported/older
  // presets cannot accidentally render both on top of one another.
  if (base.outfitId) base.garmentIds = [];
  // M3 presets predate garment runtime and could only save an empty list. Give
  // those version-1 records the built-in shirt once; version-2 authoring may
  // intentionally save an empty outfit later. Never re-add a shirt when an
  // authored outfit is already assigned.
  if (sourceVersion < 2 && base.garmentIds.length === 0 && !base.outfitId) {
    base.garmentIds = [DEMO_SIM_GARMENT_ID];
  }
  base.outfitScale = sanitizeOutfitScale(base.outfitScale ?? raw?.outfitScale);
  base.outfitPosition = sanitizeOutfitPosition(base.outfitPosition ?? raw?.outfitPosition);
  base.outfitSkinTuck = sanitizeOutfitSkinTuck(
    base.outfitSkinTuck ?? raw?.outfitSkinTuck,
  );
  base.outfitTuck = sanitizeOutfitTuck(base.outfitTuck ?? raw?.outfitTuck);
  base.outfitLimbReveal = sanitizeOutfitLimbReveal(
    base.outfitLimbReveal ?? raw?.outfitLimbReveal,
  );
  base.outfitLoopCuts = sanitizeOutfitLoopCuts(base.outfitLoopCuts ?? raw?.outfitLoopCuts);
  base.armSpace = sanitizeArmSpace(base.armSpace ?? raw?.armSpace);
  // Explicit null = bald. Missing field on new defaults → chestnut cascade.
  // Pre-v9 presets without the key also pick up the default hair cap.
  if (raw && Object.prototype.hasOwnProperty.call(raw, 'hairStyleId')) {
    base.hairStyleId = raw.hairStyleId === null
      ? null
      : (isSimHairStyleId(raw.hairStyleId) ? raw.hairStyleId : DEFAULT_SIM_HAIR_STYLE_ID);
  } else {
    base.hairStyleId = DEFAULT_SIM_HAIR_STYLE_ID;
  }
  base.hairColor = sanitizeHairColor(base.hairColor ?? raw?.hairColor);
  base.hairFit = sanitizeHairFit(base.hairFit ?? raw?.hairFit);
  base.skin = base.skin && typeof base.skin === 'object' && !Array.isArray(base.skin)
    ? { ...base.skin }
    : {};
  if (Number.isFinite(Number(raw?.updatedAt))) base.updatedAt = Number(raw.updatedAt);
  return base;
}
