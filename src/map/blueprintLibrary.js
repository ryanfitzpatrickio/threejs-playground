/**
 * blueprintLibrary.js
 *
 * File-backed store of named "blueprints" — saved Map Builder projects
 * that can be placed into the world as entities (see worldMapSchema `entities[]`).
 * Mirrors the shape of worldMapScenes.js (one entry per id).
 *
 * Storage layout: one JSON file per blueprint in data/blueprints/<id>.json —
 *   { id, name, savedAt, project }
 *
 * `project` is the verbatim Map Builder payload from MapBuilder.getProjectJSON()
 * ({ version, chunkSize, resolution, seed, amplitude, octaves, chunks, objects }).
 * No re-serialization is needed: ChunkManager.loadProject rehydrates `heights`
 * from plain arrays, and createBlueprintEntities consumes the project directly.
 */

import { makeId } from '../world/worldMap/worldMapSchema.js';
import { deleteEntry, readCollection, writeEntry } from '../store/fileStore.js';

export const BLUEPRINTS_STORAGE_KEY = 'dreamfall:blueprints';

function readAll() {
  return readCollection('blueprints');
}

/** True if a stored project payload looks usable (has the Map Builder shape). */
function isValidProject(project) {
  return project && typeof project === 'object' && Array.isArray(project.chunks);
}

/** Lightweight metadata for every saved blueprint, newest first (no full project). */
export function listBlueprints() {
  const all = readAll();
  return Object.values(all)
    .filter((b) => b && b.id && isValidProject(b.project))
    .map((b) => ({
      id: b.id,
      name: b.name ?? 'Untitled Blueprint',
      savedAt: b.savedAt ?? 0,
      chunks: b.project.chunks?.length ?? 0,
      objects: Array.isArray(b.project.objects) ? b.project.objects.length : 0,
    }))
    .sort((a, b) => b.savedAt - a.savedAt);
}

/** Full blueprint entry by id, or null. */
export function getBlueprint(id) {
  if (!id) return null;
  const all = readAll();
  const b = all[id];
  if (!b || !isValidProject(b.project)) return null;
  return { id: b.id, name: b.name ?? 'Untitled Blueprint', savedAt: b.savedAt ?? 0, project: b.project };
}

/** The raw Map Builder project payload by id (what the runtime needs), or null. */
export function getBlueprintProject(id) {
  return getBlueprint(id)?.project ?? null;
}

/**
 * Save a project under a name. If `id` is given it overwrites that blueprint;
 * otherwise an existing blueprint with the same (case-insensitive) name is
 * overwritten, else a new blueprint is created. Returns the saved metadata.
 */
export function saveBlueprint({ id = null, name, project }) {
  if (!isValidProject(project)) {
    throw new Error('saveBlueprint: project must have a chunks array');
  }
  const all = readAll();
  let blueprintId = id;
  if (!blueprintId) {
    const wanted = String(name ?? '').trim().toLowerCase();
    const existing = Object.values(all).find(
      (b) => (b.name ?? '').trim().toLowerCase() === wanted && wanted,
    );
    blueprintId = existing?.id ?? makeId('bp');
  }
  const entry = {
    id: blueprintId,
    name: String(name || 'Untitled Blueprint').trim() || 'Untitled Blueprint',
    savedAt: Date.now(),
    project,
  };
  writeEntry('blueprints', blueprintId, entry, { debounce: false });
  return { id: entry.id, name: entry.name, savedAt: entry.savedAt };
}

export function deleteBlueprint(id) {
  if (!id) return false;
  const all = readAll();
  if (all[id]) {
    deleteEntry('blueprints', id);
    return true;
  }
  return false;
}

/** Set of all blueprint ids — for worldMapSchema.normalizeWorldMap pruning. */
export function getBlueprintIds() {
  const all = readAll();
  const ids = new Set();
  for (const b of Object.values(all)) {
    if (b && b.id && isValidProject(b.project)) ids.add(b.id);
  }
  return ids;
}
