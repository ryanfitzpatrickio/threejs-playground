import {
  deleteEntry,
  readCollection,
  readState,
  writeEntry,
  writeState,
} from '../../../store/fileStore.js';
import {
  createDefaultSimAppearance,
  sanitizeSimAppearance,
} from './simAppearanceSchema.js';
import showcasePresetsJson from './showcasePresets.js';

/** Stable showcase household (Base 5, Showcase Female, Showcase Male). */
export const SHOWCASE_SIM_PRESETS = Object.freeze(
  showcasePresetsJson.map((preset) => Object.freeze(sanitizeSimAppearance(preset))),
);

const SHOWCASE_BY_ID = new Map(SHOWCASE_SIM_PRESETS.map((preset) => [preset.id, preset]));

export function getShowcasePresets() {
  return SHOWCASE_SIM_PRESETS.map((preset) => ({ ...preset, morphs: { ...preset.morphs } }));
}

export function getShowcasePreset(id) {
  const preset = SHOWCASE_BY_ID.get(id);
  return preset ? sanitizeSimAppearance(preset) : null;
}

export function loadSimPresets() {
  const fromStore = Object.values(readCollection('sims')).map(sanitizeSimAppearance);
  const byId = new Map();
  // Showcase first so empty installs still list the hero trio.
  for (const preset of SHOWCASE_SIM_PRESETS) {
    byId.set(preset.id, { ...preset, morphs: { ...preset.morphs } });
  }
  // User/local saves win on the same id; otherwise append.
  for (const preset of fromStore) {
    byId.set(preset.id, preset);
  }
  return [...byId.values()].sort((a, b) => {
    const aShow = SHOWCASE_BY_ID.has(a.id) ? 1 : 0;
    const bShow = SHOWCASE_BY_ID.has(b.id) ? 1 : 0;
    if (aShow !== bShow) return bShow - aShow; // showcase first
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  });
}

export function getSimPreset(id) {
  const raw = readCollection('sims')[id];
  if (raw) return sanitizeSimAppearance(raw);
  return getShowcasePreset(id);
}

export function createSimPreset(overrides = {}) {
  return sanitizeSimAppearance(createDefaultSimAppearance(overrides));
}

export function saveSimPreset(preset) {
  const saved = sanitizeSimAppearance({ ...preset, updatedAt: Date.now() });
  writeEntry('sims', saved.id, saved, { debounce: false });
  writeState({ activeSimPresetId: saved.id });
  return saved;
}

export function deleteSimPreset(id) {
  deleteEntry('sims', id);
  if (readState().activeSimPresetId === id) {
    writeState({ activeSimPresetId: undefined });
  }
  return loadSimPresets();
}

export function getActiveSimPreset() {
  return getSimPreset(readState().activeSimPresetId)
    ?? getShowcasePreset('showcase-female')
    ?? loadSimPresets()[0]
    ?? null;
}

/**
 * Lot / household spawn: prefer Showcase Female + Showcase Male, then Base 5.
 * Falls back to other saved presets, then synthetic defaults.
 */
export function getSimSpawnPresets(count = 2) {
  const n = Math.max(0, count);
  if (n === 0) return [];

  const preferredIds = ['showcase-female', 'showcase-male', 'showcase-base5'];
  const picked = [];
  const used = new Set();

  for (const id of preferredIds) {
    if (picked.length >= n) break;
    const preset = getSimPreset(id);
    if (!preset || used.has(preset.id)) continue;
    picked.push(preset);
    used.add(preset.id);
  }

  for (const preset of loadSimPresets()) {
    if (picked.length >= n) break;
    if (used.has(preset.id)) continue;
    picked.push(preset);
    used.add(preset.id);
  }

  while (picked.length < n) {
    const index = picked.length;
    picked.push(createSimPreset({
      id: `default-sim-${index + 1}`,
      name: `Sim ${index + 1}`,
      body: index === 0 ? 'female' : 'male',
      morphs: index === 0
        ? { 'id.body.global.mass': -0.15 }
        : { 'id.body.global.mass': 0.12 },
    }));
  }

  return picked.slice(0, n);
}
