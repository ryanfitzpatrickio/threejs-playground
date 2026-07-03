/**
 * worldMapScenes.js
 *
 * A file-backed store for multiple named world maps ("scenes"),
 * separate from the editor's single working autosave (worldmaps/_draft.json).
 * Shared by the editor's scene manager now and usable by the runtime later to
 * load a chosen scene by id.
 *
 * Storage layout: one JSON file per scene in data/worldmaps/<id>.json —
 *   { id, name, savedAt, map }
 */

import { normalizeWorldMap, makeId } from './worldMapSchema.js';
import {
  getWorldMapDraft,
  readCollection,
  readState,
  writeEntry,
  deleteEntry,
  writeState,
} from '../../store/fileStore.js';

export const WORLDMAP_SCENES_KEY = 'dreamfall:worldmap:scenes';
// Which scene the playable World loads. The sentinel '__draft__' means "use the
// editor's working autosave" rather than a named scene.
export const WORLDMAP_ACTIVE_KEY = 'dreamfall:worldmap:active';
export const WORLDMAP_DRAFT_ID = '__draft__';

function normalizeSceneRecord(id, record) {
  if (!record || typeof record !== 'object') return null;
  if (record.map && typeof record.map === 'object') {
    return {
      id: record.id ?? id,
      name: record.name ?? 'Untitled',
      savedAt: record.savedAt ?? 0,
      map: record.map,
    };
  }
  if (record.zones || record.version) {
    return {
      id,
      name: record.name ?? 'Untitled',
      savedAt: record.savedAt ?? 0,
      map: record,
    };
  }
  return null;
}

function readAll() {
  const all = { ...readCollection('worldmaps') };
  delete all._draft;
  const scenes = {};
  for (const [id, record] of Object.entries(all)) {
    const normalized = normalizeSceneRecord(id, record);
    if (normalized) scenes[id] = normalized;
  }
  return scenes;
}

/** Lightweight metadata for every saved scene, newest first (no full map). */
export function listScenes() {
  const all = readAll();
  return Object.entries(all)
    .map(([id, s]) => ({
      id: s.id ?? id,
      name: s.name ?? 'Untitled',
      savedAt: s.savedAt ?? 0,
      zones: s.map?.zones?.length ?? 0,
      pois: s.map?.pois?.length ?? 0,
    }))
    .sort((a, b) => b.savedAt - a.savedAt);
}

/** Full scene (map normalized) by id, or null. */
export function getScene(id) {
  const all = readAll();
  const s = all[id];
  if (!s) return null;
  return {
    id: s.id ?? id,
    name: s.name ?? 'Untitled',
    savedAt: s.savedAt ?? 0,
    map: normalizeWorldMap(s.map),
  };
}

/**
 * Save a map under a name. If `id` is given it overwrites that scene; otherwise
 * an existing scene with the same (case-insensitive) name is overwritten, else a
 * new scene is created. Returns the saved metadata.
 */
export function saveScene({ id = null, name, map }) {
  const all = readAll();
  let sceneId = id;
  if (!sceneId) {
    const wanted = String(name ?? '').trim().toLowerCase();
    const existing = Object.values(all).find((s) => (s.name ?? '').trim().toLowerCase() === wanted && wanted);
    sceneId = existing?.id ?? makeId('scene');
  }
  const entry = {
    id: sceneId,
    name: String(name || 'Untitled').trim() || 'Untitled',
    savedAt: Date.now(),
    map: normalizeWorldMap(map),
  };
  writeEntry('worldmaps', sceneId, entry, { debounce: false });
  return { id: entry.id, name: entry.name, savedAt: entry.savedAt };
}

export function deleteScene(id) {
  const all = readAll();
  if (all[id]) {
    deleteEntry('worldmaps', id);
    return true;
  }
  return false;
}

// ----------------------------------------------------------------------
// Active scene (what the playable World loads)
// ----------------------------------------------------------------------
export function setActiveSceneId(id) {
  const state = readState();
  if (id) writeState({ ...state, activeSceneId: id });
  else {
    const next = { ...state };
    delete next.activeSceneId;
    writeState(next);
  }
}

export function getActiveSceneId() {
  return readState().activeSceneId || null;
}

/**
 * Synchronous lookup (editor / UI). Does not hit network.
 */
export function getActiveWorldMapSync() {
  const id = getActiveSceneId();
  if (id && id !== WORLDMAP_DRAFT_ID) {
    const scene = getScene(id);
    if (scene) return scene.map;
  }
  const draft = getWorldMapDraft();
  if (draft) return normalizeWorldMap(draft);
  return null;
}

/**
 * The world map the playable World should build, or null (→ plain terrain).
 * A named active scene wins; otherwise (or for the '__draft__' sentinel) fall
 * back to the editor's working autosave so "Play draft" works without saving.
 */
export async function getActiveWorldMap() {
  return getActiveWorldMapSync();
}
