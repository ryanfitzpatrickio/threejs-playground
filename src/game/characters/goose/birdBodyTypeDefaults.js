/**
 * Shared bird body-type bases (goose-body morph plans).
 *
 * Every avian breed maps to a bodyPlan; shape knobs (neck, upright, fat, beak,
 * feet, eyes) come from these defaults so one slider can retarget a whole plan.
 * Breed entries still own scale + plumage palette.
 *
 * Debug (P menu → Bird Body) mutates the runtime copy. "Copy JSON" dumps this
 * shape so you can paste it back here as the new compiled defaults.
 */

// Style allow-lists kept local to avoid a gooseMorph ↔ defaults import cycle.
const BEAK_STYLES = Object.freeze(['goose', 'flat', 'point', 'cone', 'needle', 'hook']);
const FOOT_STYLES = Object.freeze(['web', 'perch', 'talon', 'zygodactyl']);
const EYE_STYLES = Object.freeze(['beady', 'large', 'raptor', 'soft']);

/** @typedef {{
 *   label: string,
 *   neckLen: number,
 *   neckRot: number,
 *   neckSocketX: number,
 *   neckSocketY: number,
 *   neckSocketZ: number,
 *   neckSocketRotX: number,
 *   neckSocketRotY: number,
 *   neckSocketRotZ: number,
 *   bodyUpright: number,
 *   bodyFat: number,
 *   beakStyle: string,
 *   beakPosX: number,
 *   beakPosY: number,
 *   beakPosZ: number,
 *   beakRotX: number,
 *   beakRotY: number,
 *   beakRotZ: number,
 *   beakScaleX: number,
 *   beakScaleY: number,
 *   beakScaleZ: number,
 *   footStyle: string,
 *   eyeStyle: string,
 * }} BirdBodyType */

/**
 * Shared neck–body socket (from studio tune on pigeon).
 * Applied to every body plan; per-plan neckLen / upright / fat / styles stay.
 */
const NECK_SOCKET = Object.freeze({
  neckRot: -0.04,
  neckSocketX: 0,
  neckSocketY: -0.095,
  neckSocketZ: 0,
  neckSocketRotX: -180,
  neckSocketRotY: 180,
  neckSocketRotZ: 180,
});

/** Beak local transform (identity). Pivot is bill base on the head. */
const BEAK_XFORM = Object.freeze({
  beakPosX: 0,
  beakPosY: 0,
  beakPosZ: 0,
  beakRotX: 0,
  beakRotY: 0,
  beakRotZ: 0,
  beakScaleX: 1,
  beakScaleY: 1,
  beakScaleZ: 1,
});

/**
 * Studio-tuned hook bill (macaw/raptor). Shared by parrot + raptor plans.
 * Pivot = bill base; rot ≈ 180 flip so the culmen reads right-side-up after neck socket.
 */
const HOOK_BEAK_XFORM = Object.freeze({
  beakPosX: 0,
  beakPosY: -0.03,
  beakPosZ: 0.03,
  beakRotX: 180,
  beakRotY: 180,
  beakRotZ: -180,
  beakScaleX: 0.68,
  beakScaleY: 1.02,
  beakScaleZ: 0.8,
});

/** Compiled defaults — edit via debug export paste. */
export const BIRD_BODY_TYPE_DEFAULTS = Object.freeze({
  waterfowl: Object.freeze({
    label: 'Waterfowl',
    neckLen: 1.0,
    ...NECK_SOCKET,
    ...BEAK_XFORM,
    bodyUpright: 0.05,
    bodyFat: 1.15,
    beakStyle: 'goose',
    footStyle: 'web',
    eyeStyle: 'beady',
  }),
  passerine: Object.freeze({
    label: 'Passerine',
    neckLen: 0.08,
    ...NECK_SOCKET,
    ...BEAK_XFORM,
    bodyUpright: 0.88,
    bodyFat: 0.92,
    beakStyle: 'point',
    footStyle: 'perch',
    eyeStyle: 'large',
  }),
  pigeon: Object.freeze({
    label: 'Pigeon',
    neckLen: 0.22,
    ...NECK_SOCKET,
    ...BEAK_XFORM,
    bodyUpright: 0.55,
    bodyFat: 1.2,
    beakStyle: 'cone',
    footStyle: 'perch',
    eyeStyle: 'beady',
  }),
  raptor: Object.freeze({
    label: 'Raptor',
    neckLen: 0.22,
    ...NECK_SOCKET,
    ...HOOK_BEAK_XFORM,
    bodyUpright: 0.58,
    bodyFat: 1.05,
    beakStyle: 'hook',
    footStyle: 'talon',
    eyeStyle: 'raptor',
  }),
  parrot: Object.freeze({
    label: 'Parrot',
    neckLen: 0.18,
    ...NECK_SOCKET,
    ...HOOK_BEAK_XFORM,
    bodyUpright: 0.72,
    bodyFat: 1.0,
    beakStyle: 'hook',
    footStyle: 'zygodactyl',
    eyeStyle: 'large',
  }),
  hummingbird: Object.freeze({
    label: 'Hummingbird',
    neckLen: 0.04,
    ...NECK_SOCKET,
    ...BEAK_XFORM,
    bodyUpright: 0.92,
    bodyFat: 0.72,
    beakStyle: 'needle',
    footStyle: 'perch',
    eyeStyle: 'large',
  }),
});

export const BIRD_BODY_TYPE_IDS = Object.freeze(Object.keys(BIRD_BODY_TYPE_DEFAULTS));

/** @type {Record<string, BirdBodyType>} */
const runtime = {};
for (const id of BIRD_BODY_TYPE_IDS) {
  runtime[id] = { ...BIRD_BODY_TYPE_DEFAULTS[id] };
}

/** Selected body type in the debug pane (for focused sliders). */
let activeBirdBodyTypeId = 'waterfowl';

export function listBirdBodyTypes() {
  return BIRD_BODY_TYPE_IDS.map((id) => ({
    id,
    label: runtime[id]?.label ?? BIRD_BODY_TYPE_DEFAULTS[id]?.label ?? id,
  }));
}

export function getActiveBirdBodyTypeId() {
  return activeBirdBodyTypeId;
}

export function setActiveBirdBodyTypeId(id) {
  const key = String(id ?? '').toLowerCase();
  if (!runtime[key]) return activeBirdBodyTypeId;
  activeBirdBodyTypeId = key;
  return activeBirdBodyTypeId;
}

/**
 * @param {string} id
 * @returns {BirdBodyType}
 */
export function getBirdBodyType(id) {
  const key = String(id ?? 'waterfowl').toLowerCase();
  return runtime[key] ?? runtime.waterfowl;
}

/**
 * @param {string} id
 * @param {string} field
 * @param {unknown} value
 */
const BEAK_POS_FIELDS = new Set(['beakPosX', 'beakPosY', 'beakPosZ']);
const BEAK_ROT_FIELDS = new Set(['beakRotX', 'beakRotY', 'beakRotZ']);
const BEAK_SCALE_FIELDS = new Set(['beakScaleX', 'beakScaleY', 'beakScaleZ']);

export function setBirdBodyTypeField(id, field, value) {
  const key = String(id ?? '').toLowerCase();
  const row = runtime[key];
  if (!row) return false;
  if (
    field === 'neckLen' || field === 'bodyUpright' || field === 'bodyFat' || field === 'neckRot'
    || field === 'neckSocketX' || field === 'neckSocketY' || field === 'neckSocketZ'
    || field === 'neckSocketRotX' || field === 'neckSocketRotY' || field === 'neckSocketRotZ'
    || BEAK_POS_FIELDS.has(field) || BEAK_ROT_FIELDS.has(field) || BEAK_SCALE_FIELDS.has(field)
  ) {
    const n = Number(value);
    if (!Number.isFinite(n)) return false;
    if (field === 'bodyFat') row[field] = Math.max(0.55, Math.min(1.45, n));
    else if (field === 'neckRot') row[field] = Math.max(-1, Math.min(1, n));
    else if (field.startsWith('neckSocketRot') || BEAK_ROT_FIELDS.has(field)) {
      row[field] = Math.max(-180, Math.min(180, n));
    } else if (field.startsWith('neckSocket') && field !== 'neckSocketRot') {
      row[field] = Math.max(-0.25, Math.min(0.25, n));
    } else if (BEAK_POS_FIELDS.has(field)) {
      row[field] = Math.max(-0.25, Math.min(0.25, n));
    } else if (BEAK_SCALE_FIELDS.has(field)) {
      row[field] = Math.max(0.15, Math.min(3.5, n));
    } else row[field] = Math.max(0, Math.min(1, n));
    return true;
  }
  if (field === 'beakStyle') {
    const s = String(value).toLowerCase();
    if (!BEAK_STYLES.includes(s)) return false;
    row.beakStyle = s;
    return true;
  }
  if (field === 'footStyle') {
    const s = String(value).toLowerCase();
    if (!FOOT_STYLES.includes(s)) return false;
    row.footStyle = s;
    return true;
  }
  if (field === 'eyeStyle') {
    const s = String(value).toLowerCase();
    if (!EYE_STYLES.includes(s)) return false;
    row.eyeStyle = s;
    return true;
  }
  return false;
}

export function resetBirdBodyType(id) {
  const key = String(id ?? '').toLowerCase();
  if (!BIRD_BODY_TYPE_DEFAULTS[key]) return false;
  runtime[key] = { ...BIRD_BODY_TYPE_DEFAULTS[key] };
  return true;
}

export function resetAllBirdBodyTypes() {
  for (const id of BIRD_BODY_TYPE_IDS) runtime[id] = { ...BIRD_BODY_TYPE_DEFAULTS[id] };
}

/** Snapshot for debug UI / export (mutable-safe plain objects). */
export function snapshotBirdBodyTypes() {
  /** @type {Record<string, BirdBodyType>} */
  const out = {};
  for (const id of BIRD_BODY_TYPE_IDS) out[id] = { ...runtime[id] };
  return out;
}

/**
 * JS source dump for pasting into BIRD_BODY_TYPE_DEFAULTS.
 * @returns {string}
 */
export function formatBirdBodyTypesExport() {
  const snap = snapshotBirdBodyTypes();
  const body = JSON.stringify(snap, null, 2)
    .replace(/"(\w+)":/g, '$1:')
    .replace(/"/g, "'");
  return [
    '/** Paste into src/game/characters/goose/birdBodyTypeDefaults.js → BIRD_BODY_TYPE_DEFAULTS */',
    'export const BIRD_BODY_TYPE_DEFAULTS = Object.freeze(',
    body.split('\n').map((line, i) => {
      // freeze nested objects lightly via comment; author freezes manually
      return (i === 0 ? '' : '  ') + line;
    }).join('\n').replace(/^/, '  ').replace(/\n/g, '\n  '),
    ');',
    '',
  ].join('\n');
}

/**
 * Clipboard-friendly JSON of current runtime body types.
 * @returns {string}
 */
export function formatBirdBodyTypesJson() {
  return `${JSON.stringify(snapshotBirdBodyTypes(), null, 2)}\n`;
}


