import { GARAGE_CHASSIS_OPTIONS, setGarageChassisOptionsOverride } from './garageBuilds.js';

export const BODYSHOP_CHASSIS_MANIFEST_URL = '/assets/models/bodyshop-chassis-manifest.json';

const manifestCache = {
  promise: null,
  entries: [],
};

let runtimeChassisOptions = null;

function normalizeEntry(entry) {
  if (!entry || typeof entry.id !== 'string' || !entry.id.trim()) return null;
  if (typeof entry.url !== 'string' || !entry.url.trim()) return null;
  return Object.freeze({
    id: entry.id.trim(),
    name: String(entry.name || entry.id).trim(),
    description: String(entry.description || 'Authored in Bodyshop.').trim(),
    url: entry.url.trim(),
    defaultTransform: entry.defaultTransform ?? null,
    devOnly: entry.devOnly === true,
    source: 'bodyshop',
  });
}

export function setRuntimeGarageChassisOptions(options) {
  runtimeChassisOptions = Object.freeze([...options]);
}

export function getRuntimeGarageChassisOptions() {
  if (runtimeChassisOptions) return runtimeChassisOptions;
  return filterChassisOptionsForRuntime(mergeGarageChassisOptions(manifestCache.entries));
}

export function mergeGarageChassisOptions(manifestEntries = []) {
  const baseIds = new Set(GARAGE_CHASSIS_OPTIONS.map((option) => option.id));
  const extras = [];
  for (const raw of manifestEntries) {
    const entry = normalizeEntry(raw);
    if (!entry || baseIds.has(entry.id)) continue;
    extras.push(entry);
  }
  return Object.freeze([...GARAGE_CHASSIS_OPTIONS, ...extras]);
}

export function filterChassisOptionsForRuntime(options, { dev = import.meta.env.DEV } = {}) {
  if (dev) return options;
  return options.filter((option) => option.source !== 'bodyshop' || option.devOnly !== true);
}

export async function fetchBodyshopChassisManifest({ force = false } = {}) {
  if (!force && manifestCache.entries.length > 0) {
    return manifestCache.entries;
  }
  if (!force && manifestCache.promise) {
    return manifestCache.promise;
  }

  manifestCache.promise = fetch(BODYSHOP_CHASSIS_MANIFEST_URL, { cache: 'no-store' })
    .then(async (response) => {
      if (!response.ok) return [];
      const payload = await response.json();
      const entries = Array.isArray(payload?.entries) ? payload.entries : [];
      manifestCache.entries = entries.map(normalizeEntry).filter(Boolean);
      return manifestCache.entries;
    })
    .catch(() => {
      manifestCache.entries = [];
      return manifestCache.entries;
    })
    .finally(() => {
      manifestCache.promise = null;
    });

  return manifestCache.promise;
}

export async function loadGarageChassisOptions({ force = false } = {}) {
  const manifestEntries = await fetchBodyshopChassisManifest({ force });
  const options = filterChassisOptionsForRuntime(mergeGarageChassisOptions(manifestEntries));
  setRuntimeGarageChassisOptions(options);
  setGarageChassisOptionsOverride(options);
  return options;
}

export function invalidateBodyshopChassisManifestCache() {
  manifestCache.entries = [];
  manifestCache.promise = null;
}

export async function publishBodyshopChassis({
  id,
  name,
  description,
  glbBytes,
  defaultTransform = null,
  devOnly = false,
}) {
  const response = await fetch('/__editor/bodyshop/chassis', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id,
      name,
      description,
      defaultTransform,
      devOnly,
      glbBase64: arrayBufferToBase64(glbBytes),
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Publish failed (${response.status})`);
  }
  invalidateBodyshopChassisManifestCache();
  return payload.entry;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const slice = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}
