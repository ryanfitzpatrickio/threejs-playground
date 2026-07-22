/**
 * Shared dog body-type bases (generator lineage silhouettes).
 *
 * Each canid breed has a `generatorLineage` weight vector. Its primary lineage
 * key selects one of these body types, which supplies skeleton + core geometry
 * proportions for the whole silhouette family. Coat / ears / face stay on the
 * per-breed phenotype profile.
 *
 * Debug (P menu → Dog Body) mutates the runtime copy. "Copy JSON" dumps values
 * to paste back into DOG_BODY_TYPE_DEFAULTS.
 */

import { DOG_LINEAGE_KEYS } from './dogCatalog.js';

/** Skeleton + geometry knobs shared by a lineage body type. */
/** @typedef {{
 *   label: string,
 *   scale: number,
 *   bodyLength: number,
 *   legLength: number,
 *   chestWidth: number,
 *   hipWidth: number,
 *   neckLength: number,
 *   headSize: number,
 *   muzzleLength: number,
 *   tailLength: number,
 *   torsoWidth: number,
 *   torsoDepth: number,
 *   legThickness: number,
 *   pawSize: number,
 * }} DogBodyType */

/**
 * Exemplar-derived defaults (golden / GSD / beagle / dane / frenchie / yorkie /
 * husky / cav / pointer-ish / poodle). Freeze as compiled bases.
 */
export const DOG_BODY_TYPE_DEFAULTS = Object.freeze({
  retriever: Object.freeze({
    label: 'Retriever',
    scale: 1.0, bodyLength: 1.0, legLength: 1.0, chestWidth: 1.0, hipWidth: 1.0,
    neckLength: 1.0, headSize: 1.0, muzzleLength: 1.0, tailLength: 1.0,
    torsoWidth: 1.0, torsoDepth: 1.0, legThickness: 1.0, pawSize: 1.0,
  }),
  shepherd: Object.freeze({
    label: 'Shepherd',
    scale: 1.04, bodyLength: 1.08, legLength: 1.08, chestWidth: 0.94, hipWidth: 0.9,
    neckLength: 1.08, headSize: 1.01, muzzleLength: 1.28, tailLength: 1.1,
    torsoWidth: 0.94, torsoDepth: 1.03, legThickness: 0.92, pawSize: 1.02,
  }),
  scentHound: Object.freeze({
    label: 'Scent hound',
    scale: 0.78, bodyLength: 0.94, legLength: 0.8, chestWidth: 0.96, hipWidth: 0.94,
    neckLength: 0.86, headSize: 0.96, muzzleLength: 0.98, tailLength: 0.82,
    torsoWidth: 0.96, torsoDepth: 1.0, legThickness: 0.92, pawSize: 0.96,
  }),
  mastiff: Object.freeze({
    label: 'Mastiff / giant',
    scale: 1.38, bodyLength: 1.02, legLength: 1.34, chestWidth: 0.94, hipWidth: 0.82,
    neckLength: 1.2, headSize: 1.06, muzzleLength: 1.2, tailLength: 1.1,
    torsoWidth: 1.08, torsoDepth: 1.06, legThickness: 1.12, pawSize: 1.18,
  }),
  bulldog: Object.freeze({
    label: 'Bulldog / brachy',
    scale: 0.68, bodyLength: 0.76, legLength: 0.72, chestWidth: 1.18, hipWidth: 1.03,
    neckLength: 0.6, headSize: 1.22, muzzleLength: 0.36, tailLength: 0.26,
    torsoWidth: 1.22, torsoDepth: 1.05, legThickness: 1.1, pawSize: 1.05,
  }),
  terrier: Object.freeze({
    label: 'Terrier',
    scale: 0.46, bodyLength: 0.68, legLength: 0.66, chestWidth: 0.7, hipWidth: 0.68,
    neckLength: 0.78, headSize: 0.82, muzzleLength: 0.62, tailLength: 0.6,
    torsoWidth: 0.72, torsoDepth: 0.85, legThickness: 0.72, pawSize: 0.7,
  }),
  spitz: Object.freeze({
    label: 'Spitz',
    scale: 0.94, bodyLength: 0.98, legLength: 1.04, chestWidth: 0.9, hipWidth: 0.88,
    neckLength: 1.02, headSize: 0.96, muzzleLength: 1.12, tailLength: 1.12,
    torsoWidth: 0.9, torsoDepth: 0.96, legThickness: 0.9, pawSize: 0.96,
  }),
  toySpaniel: Object.freeze({
    label: 'Toy / companion',
    scale: 0.48, bodyLength: 0.68, legLength: 0.56, chestWidth: 0.78, hipWidth: 0.78,
    neckLength: 0.56, headSize: 0.98, muzzleLength: 0.34, tailLength: 0.82,
    torsoWidth: 0.8, torsoDepth: 0.88, legThickness: 0.7, pawSize: 0.72,
  }),
  pointer: Object.freeze({
    label: 'Pointer / field',
    scale: 1.02, bodyLength: 1.02, legLength: 1.1, chestWidth: 0.9, hipWidth: 0.86,
    neckLength: 1.05, headSize: 0.96, muzzleLength: 1.2, tailLength: 0.95,
    torsoWidth: 0.9, torsoDepth: 1.0, legThickness: 0.88, pawSize: 0.98,
  }),
  poodle: Object.freeze({
    label: 'Poodle',
    scale: 0.96, bodyLength: 0.88, legLength: 1.16, chestWidth: 0.78, hipWidth: 0.78,
    neckLength: 1.12, headSize: 0.92, muzzleLength: 1.24, tailLength: 0.72,
    torsoWidth: 0.8, torsoDepth: 0.9, legThickness: 0.76, pawSize: 0.82,
  }),
});

export const DOG_BODY_TYPE_IDS = Object.freeze(
  DOG_LINEAGE_KEYS.filter((k) => DOG_BODY_TYPE_DEFAULTS[k]),
);

export const DOG_BODY_NUMERIC_FIELDS = Object.freeze([
  'scale', 'bodyLength', 'legLength', 'chestWidth', 'hipWidth',
  'neckLength', 'headSize', 'muzzleLength', 'tailLength',
  'torsoWidth', 'torsoDepth', 'legThickness', 'pawSize',
]);

/** @type {Record<string, DogBodyType>} */
const runtime = {};
for (const id of DOG_BODY_TYPE_IDS) {
  runtime[id] = { ...DOG_BODY_TYPE_DEFAULTS[id] };
}

let activeDogBodyTypeId = 'retriever';

export function listDogBodyTypes() {
  return DOG_BODY_TYPE_IDS.map((id) => ({
    id,
    label: runtime[id]?.label ?? DOG_BODY_TYPE_DEFAULTS[id]?.label ?? id,
  }));
}

export function getActiveDogBodyTypeId() {
  return activeDogBodyTypeId;
}

export function setActiveDogBodyTypeId(id) {
  const key = String(id ?? '').trim();
  if (!runtime[key]) return activeDogBodyTypeId;
  activeDogBodyTypeId = key;
  return activeDogBodyTypeId;
}

/**
 * @param {string} id
 * @returns {DogBodyType}
 */
export function getDogBodyType(id) {
  const key = String(id ?? 'retriever');
  return runtime[key] ?? runtime.retriever;
}

/**
 * Primary generator lineage for a breed (highest weight).
 * @param {{ generatorLineage?: Record<string, number> } | null | undefined} breed
 * @returns {string}
 */
export function primaryDogBodyTypeId(breed) {
  const lin = breed?.generatorLineage;
  if (!lin || typeof lin !== 'object') return 'retriever';
  let best = 'retriever';
  let bestW = -1;
  for (const key of DOG_BODY_TYPE_IDS) {
    const w = Number(lin[key] ?? 0);
    if (w > bestW) {
      bestW = w;
      best = key;
    }
  }
  return best;
}

/**
 * @param {string} id
 * @param {string} field
 * @param {unknown} value
 */
export function setDogBodyTypeField(id, field, value) {
  const key = String(id ?? '');
  const row = runtime[key];
  if (!row) return false;
  if (field === 'label') {
    row.label = String(value ?? row.label);
    return true;
  }
  if (!DOG_BODY_NUMERIC_FIELDS.includes(field)) return false;
  const n = Number(value);
  if (!Number.isFinite(n)) return false;
  // Generous clamps for authoring.
  const min = field === 'scale' ? 0.2 : 0.2;
  const max = field === 'scale' ? 2.5 : 2.2;
  row[field] = Math.max(min, Math.min(max, n));
  return true;
}

export function resetDogBodyType(id) {
  const key = String(id ?? '');
  if (!DOG_BODY_TYPE_DEFAULTS[key]) return false;
  runtime[key] = { ...DOG_BODY_TYPE_DEFAULTS[key] };
  return true;
}

export function resetAllDogBodyTypes() {
  for (const id of DOG_BODY_TYPE_IDS) runtime[id] = { ...DOG_BODY_TYPE_DEFAULTS[id] };
}

export function snapshotDogBodyTypes() {
  /** @type {Record<string, DogBodyType>} */
  const out = {};
  for (const id of DOG_BODY_TYPE_IDS) out[id] = { ...runtime[id] };
  return out;
}

export function formatDogBodyTypesJson() {
  return `${JSON.stringify(snapshotDogBodyTypes(), null, 2)}\n`;
}

/**
 * Apply body-type skeleton/geometry onto a resolved phenotype (mutates).
 *
 * Live values are treated as **relative to compiled defaults**: at stock
 * settings (live === default) every breed keeps its authored profile. Moving a
 * slider multiplies all breeds of that lineage by live/default.
 *
 * Coat / ears / face / tail stay breed-authored.
 * @param {object} phenotype
 * @param {string} [bodyTypeId]
 */
export function applyDogBodyTypeToPhenotype(phenotype, bodyTypeId) {
  if (!phenotype) return phenotype;
  const id = bodyTypeId
    ?? phenotype.bodyTypeId
    ?? 'retriever';
  const live = getDogBodyType(id);
  const base = DOG_BODY_TYPE_DEFAULTS[id] ?? DOG_BODY_TYPE_DEFAULTS.retriever;
  const ratio = (field) => {
    const b = Number(base[field]);
    const v = Number(live[field]);
    if (!Number.isFinite(b) || b === 0 || !Number.isFinite(v)) return 1;
    return v / b;
  };

  const sk = phenotype.skeleton ?? {};
  phenotype.skeleton = {
    ...sk,
    scale: (sk.scale ?? 1) * ratio('scale'),
    bodyLength: (sk.bodyLength ?? 1) * ratio('bodyLength'),
    legLength: (sk.legLength ?? 1) * ratio('legLength'),
    chestWidth: (sk.chestWidth ?? 1) * ratio('chestWidth'),
    hipWidth: (sk.hipWidth ?? 1) * ratio('hipWidth'),
    neckLength: (sk.neckLength ?? 1) * ratio('neckLength'),
    headSize: (sk.headSize ?? 1) * ratio('headSize'),
    muzzleLength: (sk.muzzleLength ?? 1) * ratio('muzzleLength'),
    tailLength: (sk.tailLength ?? 1) * ratio('tailLength'),
  };
  const geo = phenotype.geometry ?? {};
  phenotype.geometry = {
    ...geo,
    torsoWidth: (geo.torsoWidth ?? 1) * ratio('torsoWidth'),
    torsoDepth: (geo.torsoDepth ?? 1) * ratio('torsoDepth'),
    legThickness: (geo.legThickness ?? 1) * ratio('legThickness'),
    pawSize: (geo.pawSize ?? 1) * ratio('pawSize'),
  };
  phenotype.bodyTypeId = id;
  return phenotype;
}
