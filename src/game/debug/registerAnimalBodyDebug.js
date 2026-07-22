/**
 * P-menu (shader debug pane) folders for Dog Studio body-type authoring.
 *
 * - Dog Body: generator-lineage bases (retriever, shepherd, …)
 * - Bird Body: goose-body plans (waterfowl, passerine, …)
 *
 * Sliders mutate live stores; when Dog Studio is open the current animal
 * rebuilds so changes show in realtime. "Copy JSON" dumps the store for
 * pasting back into *BodyTypeDefaults.js.
 */

import {
  registerShaderDebugFolder,
  registerShaderDebugParam,
  emitShaderDebugEvent,
} from './shaderDebugRegistry.js';
import {
  DOG_BODY_NUMERIC_FIELDS,
  DOG_BODY_TYPE_IDS,
  formatDogBodyTypesJson,
  getActiveDogBodyTypeId,
  getDogBodyType,
  listDogBodyTypes,
  primaryDogBodyTypeId,
  resetAllDogBodyTypes,
  resetDogBodyType,
  setActiveDogBodyTypeId,
  setDogBodyTypeField,
  snapshotDogBodyTypes,
} from '../characters/dog/dogBodyTypeDefaults.js';
import {
  BIRD_BODY_TYPE_IDS,
  formatBirdBodyTypesJson,
  getActiveBirdBodyTypeId,
  getBirdBodyType,
  listBirdBodyTypes,
  resetAllBirdBodyTypes,
  resetBirdBodyType,
  setActiveBirdBodyTypeId,
  setBirdBodyTypeField,
  snapshotBirdBodyTypes,
} from '../characters/goose/birdBodyTypeDefaults.js';
import { getDogBreed, isBirdBreed } from '../characters/dog/dogCatalog.js';

function dogSim() {
  return globalThis.__DOG_SIM_DEBUG__ ?? null;
}

function activeBreedId() {
  return dogSim()?.getBreedId?.()
    ?? dogSim()?.snapshot?.()?.breedId
    ?? null;
}

function activeBodyTypeForCurrentAnimal() {
  const breedId = activeBreedId();
  if (!breedId) return null;
  if (isBirdBreed(breedId)) {
    const dog = dogSim()?.getDog?.();
    const plan = dog?.presentation?.bodyPlan
      ?? dog?.variety?.bodyPlan
      ?? dog?.phenotype?.shape?.bodyPlan
      ?? dogSim()?.snapshot?.()?.resolvedTraits?.shape?.bodyPlan
      ?? getDogBreed(breedId)?.conformationFlags?.find((f) => (
        ['waterfowl', 'passerine', 'pigeon', 'raptor', 'parrot', 'hummingbird'].includes(f)
      ))
      ?? 'waterfowl';
    return { kind: 'bird', id: plan };
  }
  const breed = getDogBreed(breedId);
  if (breed?.conformationFlags?.includes('non-canine-extension')) return null;
  return { kind: 'dog', id: primaryDogBodyTypeId(breed) };
}

/** Rebuild studio animal if open (debounced slightly for slider spam). */
let _rebuildTimer = 0;
function scheduleStudioRebuild() {
  if (_rebuildTimer) globalThis.clearTimeout(_rebuildTimer);
  _rebuildTimer = globalThis.setTimeout(() => {
    _rebuildTimer = 0;
    const sim = dogSim();
    if (!sim?.rebuildDog) return;
    try {
      void sim.rebuildDog({});
    } catch (err) {
      console.warn('[animal-body-debug] rebuild failed', err);
    }
  }, 40);
}

async function copyText(text) {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      console.info('[animal-body-debug] copied to clipboard');
      return true;
    }
  } catch (err) {
    console.warn('[animal-body-debug] clipboard failed', err);
  }
  console.info('[animal-body-debug] export\n', text);
  return false;
}

/** Tweakpane enum options: { Label: value }. */
function dogTypeOptions() {
  /** @type {Record<string, string>} */
  const opts = {};
  for (const t of listDogBodyTypes()) opts[t.label] = t.id;
  return opts;
}

function birdTypeOptions() {
  /** @type {Record<string, string>} */
  const opts = {};
  for (const t of listBirdBodyTypes()) opts[t.label] = t.id;
  return opts;
}

function enumOpts(values) {
  /** @type {Record<string, string>} */
  const opts = {};
  for (const v of values) opts[v] = v;
  return opts;
}

let registered = false;

/**
 * Register once. Safe to call from registerBuiltinShaderDebug / Dog Studio boot.
 */
export function registerAnimalBodyDebug() {
  if (registered) return;
  registered = true;

  registerShaderDebugFolder('Dog Body', { expanded: true, title: 'Dog Body' });
  registerShaderDebugFolder('Bird Body', { expanded: true, title: 'Bird Body' });

  // ── Dog Body ────────────────────────────────────────────────────────────
  registerShaderDebugParam({
    id: 'dogBody.activeType',
    label: 'Body type',
    folder: 'Dog Body',
    type: 'enum',
    options: dogTypeOptions(),
    pinPolicy: 'allow',
    help: 'Generator lineage silhouette. Sliders edit the shared base for that type.',
    get: () => getActiveDogBodyTypeId(),
    set: (v) => {
      setActiveDogBodyTypeId(v);
      emitShaderDebugEvent('param-changed', { id: 'dogBody.activeType' });
      // Soft-refresh other bindings so labels track the new type.
      emitShaderDebugEvent('rebind');
    },
  });

  registerShaderDebugParam({
    id: 'dogBody.useCurrent',
    label: 'Select type of current animal',
    folder: 'Dog Body',
    type: 'action',
    pinPolicy: 'allow',
    get: () => null,
    action: () => {
      const hit = activeBodyTypeForCurrentAnimal();
      if (hit?.kind === 'dog') {
        setActiveDogBodyTypeId(hit.id);
        emitShaderDebugEvent('rebind');
      } else {
        console.info('[animal-body-debug] current animal is not a canid body type');
      }
    },
  });

  for (const field of DOG_BODY_NUMERIC_FIELDS) {
    const isScale = field === 'scale';
    registerShaderDebugParam({
      id: `dogBody.${field}`,
      label: field,
      folder: 'Dog Body',
      type: 'float',
      min: isScale ? 0.25 : 0.3,
      max: isScale ? 2.2 : 2.0,
      step: 0.01,
      pinPolicy: 'allow',
      cost: 'rebuild',
      help: `Shared ${field} for active dog body type (ratio vs compiled default).`,
      get: () => getDogBodyType(getActiveDogBodyTypeId())[field],
      set: (v) => {
        setDogBodyTypeField(getActiveDogBodyTypeId(), field, v);
        scheduleStudioRebuild();
      },
    });
  }

  registerShaderDebugParam({
    id: 'dogBody.resetType',
    label: 'Reset active type',
    folder: 'Dog Body',
    type: 'action',
    pinPolicy: 'allow',
    get: () => null,
    action: () => {
      resetDogBodyType(getActiveDogBodyTypeId());
      emitShaderDebugEvent('rebind');
      scheduleStudioRebuild();
    },
  });

  registerShaderDebugParam({
    id: 'dogBody.resetAll',
    label: 'Reset all dog types',
    folder: 'Dog Body',
    type: 'action',
    pinPolicy: 'allow',
    get: () => null,
    action: () => {
      resetAllDogBodyTypes();
      emitShaderDebugEvent('rebind');
      scheduleStudioRebuild();
    },
  });

  registerShaderDebugParam({
    id: 'dogBody.copyJson',
    label: 'Copy JSON (all dog types)',
    folder: 'Dog Body',
    type: 'action',
    pinPolicy: 'allow',
    help: 'Clipboard dump of DOG_BODY_TYPE_DEFAULTS — paste into dogBodyTypeDefaults.js',
    get: () => null,
    action: () => {
      void copyText(formatDogBodyTypesJson());
    },
  });

  registerShaderDebugParam({
    id: 'dogBody.copyActiveJson',
    label: 'Copy JSON (active type only)',
    folder: 'Dog Body',
    type: 'action',
    pinPolicy: 'allow',
    get: () => null,
    action: () => {
      const id = getActiveDogBodyTypeId();
      const snap = { [id]: snapshotDogBodyTypes()[id] };
      void copyText(`${JSON.stringify(snap, null, 2)}\n`);
    },
  });

  // ── Bird Body ───────────────────────────────────────────────────────────
  registerShaderDebugParam({
    id: 'birdBody.activeType',
    label: 'Body type',
    folder: 'Bird Body',
    type: 'enum',
    options: birdTypeOptions(),
    pinPolicy: 'allow',
    help: 'Goose-body plan (waterfowl, passerine, …). Shape knobs retarget every breed on that plan.',
    get: () => getActiveBirdBodyTypeId(),
    set: (v) => {
      setActiveBirdBodyTypeId(v);
      emitShaderDebugEvent('rebind');
    },
  });

  registerShaderDebugParam({
    id: 'birdBody.useCurrent',
    label: 'Select type of current animal',
    folder: 'Bird Body',
    type: 'action',
    pinPolicy: 'allow',
    get: () => null,
    action: () => {
      const hit = activeBodyTypeForCurrentAnimal();
      if (hit?.kind === 'bird') {
        setActiveBirdBodyTypeId(hit.id);
        emitShaderDebugEvent('rebind');
      } else {
        console.info('[animal-body-debug] current animal is not a bird body type');
      }
    },
  });

  /** @type {Array<{ field: string, min: number, max: number, step: number, help: string }>} */
  const birdNumeric = [
    { field: 'neckLen', min: 0, max: 1, step: 0.01, help: '0 = almost no neck, 1 = full Canada S-neck' },
    { field: 'neckRot', min: -1, max: 1, step: 0.01, help: 'Legacy pitch shorthand (−1..1) added onto neckSocketRotX' },
    { field: 'neckSocketX', min: -0.2, max: 0.2, step: 0.005, help: 'Neck–body socket offset X (m, lateral)' },
    { field: 'neckSocketY', min: -0.2, max: 0.2, step: 0.005, help: 'Neck–body socket offset Y (m, up)' },
    { field: 'neckSocketZ', min: -0.2, max: 0.2, step: 0.005, help: 'Neck–body socket offset Z (m, forward)' },
    { field: 'neckSocketRotX', min: -180, max: 180, step: 1, help: 'Socket pitch ° (try 180 if head is upside-down)' },
    { field: 'neckSocketRotY', min: -180, max: 180, step: 1, help: 'Socket yaw °' },
    { field: 'neckSocketRotZ', min: -180, max: 180, step: 1, help: 'Socket roll ° (try 180 if head is upside-down)' },
    { field: 'bodyUpright', min: 0, max: 1, step: 0.01, help: '0 = horizontal waterfowl, 1 = upright' },
    { field: 'bodyFat', min: 0.55, max: 1.45, step: 0.01, help: 'Torso girth' },
  ];
  for (const { field, min, max, step, help } of birdNumeric) {
    registerShaderDebugParam({
      id: `birdBody.${field}`,
      label: field,
      folder: 'Bird Body',
      type: 'float',
      min,
      max,
      step,
      pinPolicy: 'allow',
      cost: 'rebuild',
      help,
      get: () => getBirdBodyType(getActiveBirdBodyTypeId())[field] ?? 0,
      set: (v) => {
        setBirdBodyTypeField(getActiveBirdBodyTypeId(), field, v);
        scheduleStudioRebuild();
      },
    });
  }

  registerShaderDebugParam({
    id: 'birdBody.flipNeck180X',
    label: 'Flip neck 180° (RotX)',
    folder: 'Bird Body',
    type: 'action',
    pinPolicy: 'allow',
    help: 'Adds 180° to neckSocketRotX — quick test for upside-down head/neck.',
    get: () => null,
    action: () => {
      const id = getActiveBirdBodyTypeId();
      const cur = getBirdBodyType(id).neckSocketRotX ?? 0;
      // Toggle ±180 around current (wrap into [-180,180]).
      let next = cur + 180;
      if (next > 180) next -= 360;
      setBirdBodyTypeField(id, 'neckSocketRotX', next);
      emitShaderDebugEvent('rebind');
      scheduleStudioRebuild();
    },
  });
  registerShaderDebugParam({
    id: 'birdBody.flipNeck180Z',
    label: 'Flip neck 180° (RotZ)',
    folder: 'Bird Body',
    type: 'action',
    pinPolicy: 'allow',
    help: 'Adds 180° to neckSocketRotZ — roll flip at the body socket.',
    get: () => null,
    action: () => {
      const id = getActiveBirdBodyTypeId();
      const cur = getBirdBodyType(id).neckSocketRotZ ?? 0;
      let next = cur + 180;
      if (next > 180) next -= 360;
      setBirdBodyTypeField(id, 'neckSocketRotZ', next);
      emitShaderDebugEvent('rebind');
      scheduleStudioRebuild();
    },
  });

  registerShaderDebugParam({
    id: 'birdBody.beakStyle',
    label: 'beakStyle',
    folder: 'Bird Body',
    type: 'enum',
    options: enumOpts(['goose', 'flat', 'point', 'cone', 'needle', 'hook']),
    pinPolicy: 'allow',
    cost: 'rebuild',
    get: () => getBirdBodyType(getActiveBirdBodyTypeId()).beakStyle,
    set: (v) => {
      setBirdBodyTypeField(getActiveBirdBodyTypeId(), 'beakStyle', v);
      scheduleStudioRebuild();
    },
  });

  /** Beak local transform about bill base (pos m / rot ° / scale). */
  /** @type {Array<{ field: string, min: number, max: number, step: number, help: string }>} */
  const beakXformNumeric = [
    { field: 'beakPosX', min: -0.2, max: 0.2, step: 0.005, help: 'Bill offset X (m, lateral)' },
    { field: 'beakPosY', min: -0.2, max: 0.2, step: 0.005, help: 'Bill offset Y (m, up)' },
    { field: 'beakPosZ', min: -0.2, max: 0.2, step: 0.005, help: 'Bill offset Z (m, forward)' },
    { field: 'beakRotX', min: -180, max: 180, step: 1, help: 'Bill pitch ° about base' },
    { field: 'beakRotY', min: -180, max: 180, step: 1, help: 'Bill yaw ° about base' },
    { field: 'beakRotZ', min: -180, max: 180, step: 1, help: 'Bill roll ° about base' },
    { field: 'beakScaleX', min: 0.2, max: 3, step: 0.02, help: 'Bill width scale' },
    { field: 'beakScaleY', min: 0.2, max: 3, step: 0.02, help: 'Bill height/depth scale' },
    { field: 'beakScaleZ', min: 0.2, max: 3, step: 0.02, help: 'Bill length scale (along culmen)' },
  ];
  for (const { field, min, max, step, help } of beakXformNumeric) {
    registerShaderDebugParam({
      id: `birdBody.${field}`,
      label: field,
      folder: 'Bird Body',
      type: 'float',
      min,
      max,
      step,
      pinPolicy: 'allow',
      cost: 'rebuild',
      help,
      get: () => {
        const row = getBirdBodyType(getActiveBirdBodyTypeId());
        const v = row[field];
        if (Number.isFinite(v)) return v;
        return field.startsWith('beakScale') ? 1 : 0;
      },
      set: (v) => {
        setBirdBodyTypeField(getActiveBirdBodyTypeId(), field, v);
        scheduleStudioRebuild();
      },
    });
  }

  registerShaderDebugParam({
    id: 'birdBody.resetBeakXform',
    label: 'Reset beak pos/rot/scale',
    folder: 'Bird Body',
    type: 'action',
    pinPolicy: 'allow',
    help: 'Identity beak transform (pos 0, rot 0, scale 1) on active body type.',
    get: () => null,
    action: () => {
      const id = getActiveBirdBodyTypeId();
      for (const axis of ['X', 'Y', 'Z']) {
        setBirdBodyTypeField(id, `beakPos${axis}`, 0);
        setBirdBodyTypeField(id, `beakRot${axis}`, 0);
        setBirdBodyTypeField(id, `beakScale${axis}`, 1);
      }
      emitShaderDebugEvent('rebind');
      scheduleStudioRebuild();
    },
  });

  registerShaderDebugParam({
    id: 'birdBody.footStyle',
    label: 'footStyle',
    folder: 'Bird Body',
    type: 'enum',
    options: enumOpts(['web', 'perch', 'talon', 'zygodactyl']),
    pinPolicy: 'allow',
    cost: 'rebuild',
    get: () => getBirdBodyType(getActiveBirdBodyTypeId()).footStyle,
    set: (v) => {
      setBirdBodyTypeField(getActiveBirdBodyTypeId(), 'footStyle', v);
      scheduleStudioRebuild();
    },
  });

  registerShaderDebugParam({
    id: 'birdBody.eyeStyle',
    label: 'eyeStyle',
    folder: 'Bird Body',
    type: 'enum',
    options: enumOpts(['beady', 'large', 'raptor', 'soft']),
    pinPolicy: 'allow',
    cost: 'rebuild',
    get: () => getBirdBodyType(getActiveBirdBodyTypeId()).eyeStyle,
    set: (v) => {
      setBirdBodyTypeField(getActiveBirdBodyTypeId(), 'eyeStyle', v);
      scheduleStudioRebuild();
    },
  });

  registerShaderDebugParam({
    id: 'birdBody.resetType',
    label: 'Reset active type',
    folder: 'Bird Body',
    type: 'action',
    pinPolicy: 'allow',
    get: () => null,
    action: () => {
      resetBirdBodyType(getActiveBirdBodyTypeId());
      emitShaderDebugEvent('rebind');
      scheduleStudioRebuild();
    },
  });

  registerShaderDebugParam({
    id: 'birdBody.resetAll',
    label: 'Reset all bird types',
    folder: 'Bird Body',
    type: 'action',
    pinPolicy: 'allow',
    get: () => null,
    action: () => {
      resetAllBirdBodyTypes();
      emitShaderDebugEvent('rebind');
      scheduleStudioRebuild();
    },
  });

  registerShaderDebugParam({
    id: 'birdBody.copyJson',
    label: 'Copy JSON (all bird types)',
    folder: 'Bird Body',
    type: 'action',
    pinPolicy: 'allow',
    help: 'Clipboard dump of BIRD_BODY_TYPE_DEFAULTS — paste into birdBodyTypeDefaults.js',
    get: () => null,
    action: () => {
      void copyText(formatBirdBodyTypesJson());
    },
  });

  registerShaderDebugParam({
    id: 'birdBody.copyActiveJson',
    label: 'Copy JSON (active type only)',
    folder: 'Bird Body',
    type: 'action',
    pinPolicy: 'allow',
    get: () => null,
    action: () => {
      const id = getActiveBirdBodyTypeId();
      const snap = { [id]: snapshotBirdBodyTypes()[id] };
      void copyText(`${JSON.stringify(snap, null, 2)}\n`);
    },
  });

  // Silence unused in tree-shake-ish checks
  void DOG_BODY_TYPE_IDS;
  void BIRD_BODY_TYPE_IDS;
}
