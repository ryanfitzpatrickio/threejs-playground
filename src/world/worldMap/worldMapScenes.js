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
import { getDefaultRallyWorldMap as getBuiltInDefaultRallyWorldMap } from './defaultRallyMap.js';
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

/** @typedef {'world' | 'rally'} SceneDefaultRole */

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
      defaultRole: getSceneDefaultRole(s.id ?? id),
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

/** Stable id for the authored Pine Ridge stage shipped in defaultRallyMap.js */
export const BUILTIN_RALLY_SCENE_ID = 'pine-ridge-rally';

/**
 * Save the built-in rally track as a named scene (idempotent). Returns scene
 * metadata whether newly created or already present.
 */
export function ensureBuiltInRallyScene() {
  const existing = getScene(BUILTIN_RALLY_SCENE_ID);
  if (existing) {
    return { id: existing.id, name: existing.name, savedAt: existing.savedAt };
  }
  const map = getBuiltInDefaultRallyWorldMap();
  return saveScene({
    id: BUILTIN_RALLY_SCENE_ID,
    name: map.name ?? 'Pine Ridge Rally',
    map,
  });
}

export function deleteScene(id) {
  const all = readAll();
  if (!all[id]) return false;
  deleteEntry('worldmaps', id);
  clearSceneDefaultRoles(id);
  return true;
}

// ----------------------------------------------------------------------
// Default scene roles (one World default + one Rally default across all maps)
// ----------------------------------------------------------------------
export function getDefaultWorldSceneId() {
  return readState().defaultWorldSceneId || null;
}

export function getDefaultRallySceneId() {
  return readState().defaultRallySceneId || null;
}

/** @returns {SceneDefaultRole | null} */
export function getSceneDefaultRole(sceneId) {
  if (!sceneId) return null;
  const state = readState();
  if (state.defaultWorldSceneId === sceneId) return 'world';
  if (state.defaultRallySceneId === sceneId) return 'rally';
  return null;
}

/**
 * Mark a scene as the default for World or Rally play. Each scene can hold at
 * most one role; setting a role clears the other on the same scene. Only one
 * scene may be the default of each type. Pass `role: null` to clear this scene.
 */
export function setSceneDefaultRole(sceneId, role) {
  if (!sceneId) return;
  if (role && !getScene(sceneId)) return;
  const state = readState();
  const patch = {};

  if (role === 'world') {
    patch.defaultWorldSceneId = sceneId;
    if (state.defaultRallySceneId === sceneId) patch.defaultRallySceneId = undefined;
  } else if (role === 'rally') {
    patch.defaultRallySceneId = sceneId;
    if (state.defaultWorldSceneId === sceneId) patch.defaultWorldSceneId = undefined;
  } else {
    if (state.defaultWorldSceneId === sceneId) patch.defaultWorldSceneId = undefined;
    if (state.defaultRallySceneId === sceneId) patch.defaultRallySceneId = undefined;
  }

  if (Object.keys(patch).length) writeState(patch);
}

function clearSceneDefaultRoles(sceneId) {
  const state = readState();
  const patch = {};
  if (state.defaultWorldSceneId === sceneId) patch.defaultWorldSceneId = undefined;
  if (state.defaultRallySceneId === sceneId) patch.defaultRallySceneId = undefined;
  if (Object.keys(patch).length) writeState(patch);
}

// ----------------------------------------------------------------------
// Active scene (what the playable World loads)
// ----------------------------------------------------------------------
export function setActiveSceneId(id) {
  writeState({ activeSceneId: id || undefined });
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

/**
 * Rally play map: default rally scene when set, otherwise the built-in stage.
 */
export function getRallyWorldMapSync() {
  const id = getDefaultRallySceneId();
  if (id) {
    const scene = getScene(id);
    if (scene) return scene.map;
  }
  return getBuiltInDefaultRallyWorldMap();
}

export async function getRallyWorldMap() {
  return getRallyWorldMapSync();
}
