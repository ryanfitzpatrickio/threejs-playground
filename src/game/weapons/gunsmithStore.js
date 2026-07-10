/**
 * Gunsmith profile persistence via fileStore `gunsmith` collection.
 * Synchronous API (cache-backed), same pattern as bodyshop/garage.
 */

import {
  deleteEntry,
  flushFileStore,
  readCollection,
  readEntry,
  writeEntry,
} from '../../store/fileStore.js';
import {
  createCatalogStubProfile,
  GUN_CATALOG,
  normalizeProfile,
  validateProfile,
} from './gunProfile.js';

const COLLECTION = 'gunsmith';

export function listGunsmithProfiles() {
  const bag = readCollection(COLLECTION) || {};
  return Object.values(bag)
    .filter((p) => p && typeof p === 'object' && p.id)
    .map((p) => {
      try {
        return normalizeProfile(p);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function getGunsmithProfile(id) {
  if (!id) return null;
  const raw = readEntry(COLLECTION, id);
  if (!raw) return null;
  try {
    return normalizeProfile(raw);
  } catch {
    return null;
  }
}

export function saveGunsmithProfile(profile, options = {}) {
  const normalized = normalizeProfile(profile);
  normalized.updatedAt = Date.now();
  writeEntry(COLLECTION, normalized.id, normalized, options);
  return normalized;
}

export function deleteGunsmithProfile(id) {
  if (!id) return;
  deleteEntry(COLLECTION, id);
}

/**
 * Resolve profile for a catalog gun: store first, else stub with optional mesh names.
 */
export function resolveGunProfile(id, { meshNames = [] } = {}) {
  const existing = getGunsmithProfile(id);
  if (existing) return existing;
  const entry = GUN_CATALOG.find((g) => g.id === id);
  if (!entry) return null;
  return createCatalogStubProfile(entry, meshNames);
}

export function ensureCatalogStubs({ meshNamesById = {} } = {}) {
  const saved = [];
  for (const entry of GUN_CATALOG) {
    if (getGunsmithProfile(entry.id)) continue;
    const stub = createCatalogStubProfile(entry, meshNamesById[entry.id] || []);
    saveGunsmithProfile(stub, { debounce: false });
    saved.push(stub.id);
  }
  return saved;
}

export async function flushGunsmithStore() {
  await flushFileStore();
}

export function validateStoredProfile(id) {
  const profile = getGunsmithProfile(id);
  if (!profile) return { ok: false, errors: ['not found'] };
  return validateProfile(profile);
}

export { GUN_CATALOG, COLLECTION as GUNSMITH_COLLECTION };
