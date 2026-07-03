/**
 * mapProjectLibrary.js
 *
 * File-backed store of named Map Builder projects ("saved maps").
 * Mirrors blueprintLibrary.js but writes to the `mapbuilder` collection,
 * next to the `_autosave` working copy (which is skipped when listing).
 *
 * Storage layout: one entry per map in the mapbuilder collection —
 *   { id, name, savedAt, project }
 *
 * `project` is the verbatim MapBuilder.getProjectJSON() payload, so
 * MapBuilder.loadProjectFromJSON consumes it directly.
 */

import { makeId } from '../world/worldMap/worldMapSchema.js';
import { deleteEntry, readCollection, writeEntry } from '../store/fileStore.js';

function readAll() {
  return readCollection('mapbuilder');
}

/** True if a stored entry is a named map (not the raw `_autosave` project). */
function isMapEntry(entry) {
  return entry && entry.id && entry.project
    && typeof entry.project === 'object' && Array.isArray(entry.project.chunks);
}

/** Lightweight metadata for every saved map, newest first (no full project). */
export function listMapProjects() {
  const all = readAll();
  return Object.values(all)
    .filter(isMapEntry)
    .map((m) => ({
      id: m.id,
      name: m.name ?? 'Untitled Map',
      savedAt: m.savedAt ?? 0,
      chunks: m.project.chunks?.length ?? 0,
      objects: Array.isArray(m.project.objects) ? m.project.objects.length : 0,
    }))
    .sort((a, b) => b.savedAt - a.savedAt);
}

/** Full saved-map entry by id, or null. */
export function getMapProject(id) {
  if (!id) return null;
  const entry = readAll()[id];
  if (!isMapEntry(entry)) return null;
  return {
    id: entry.id,
    name: entry.name ?? 'Untitled Map',
    savedAt: entry.savedAt ?? 0,
    project: entry.project,
  };
}

/**
 * Save a project under a name. If `id` is given it overwrites that map;
 * otherwise an existing map with the same (case-insensitive) name is
 * overwritten, else a new map is created. Returns the saved metadata.
 */
export function saveMapProject({ id = null, name, project }) {
  if (!project || !Array.isArray(project.chunks)) {
    throw new Error('saveMapProject: project must have a chunks array');
  }
  const all = readAll();
  let mapId = id;
  if (!mapId) {
    const wanted = String(name ?? '').trim().toLowerCase();
    const existing = Object.values(all).find(
      (m) => isMapEntry(m) && (m.name ?? '').trim().toLowerCase() === wanted && wanted,
    );
    mapId = existing?.id ?? makeId('map');
  }
  const entry = {
    id: mapId,
    name: String(name || 'Untitled Map').trim() || 'Untitled Map',
    savedAt: Date.now(),
    project,
  };
  writeEntry('mapbuilder', mapId, entry, { debounce: false });
  return { id: entry.id, name: entry.name, savedAt: entry.savedAt };
}

export function deleteMapProject(id) {
  if (!id) return false;
  const all = readAll();
  if (isMapEntry(all[id])) {
    deleteEntry('mapbuilder', id);
    return true;
  }
  return false;
}
