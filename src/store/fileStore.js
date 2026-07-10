/**
 * fileStore.js
 *
 * In-memory cache hydrated once at boot from /api/store (dev) or /data (prod).
 * All editor store modules read/write synchronously through this cache; disk
 * persistence is async and debounced for autosaves.
 */

// Legacy localStorage keys — kept here (not imported from store modules) to avoid cycles.
const BLUEPRINTS_STORAGE_KEY = 'dreamfall:blueprints';
const WORLDMAP_SCENES_KEY = 'dreamfall:worldmap:scenes';
const WORLDMAP_ACTIVE_KEY = 'dreamfall:worldmap:active';
const WORLDMAP_STORAGE_KEY = 'dreamfall:worldmap:autosave';
const GARAGE_BUILDS_KEY = 'dreamfall:garage-builds:v1';
const GARAGE_ACTIVE_KEY = 'dreamfall:garage-active:v1';
const MAPBUILDER_AUTOSAVE_KEY = 'dreamfall:mapbuilder:autosave';

const DEBOUNCE_MS = 800;

/** @type {Record<string, Record<string, unknown>>} */
const cache = {
  blueprints: {},
  worldmaps: {},
  mapbuilder: {},
  garage: {},
  bodyshop: {},
  gunsmith: {},
};

/** @type {Record<string, unknown>} */
let state = {};

let writable = false;
let initialized = false;
let listenersRegistered = false;
let persistError = null;
let storeRevision = 0;

/** @type {Set<() => void>} */
const storeListeners = new Set();

function notifyStoreRevision() {
  storeRevision += 1;
  for (const listener of storeListeners) listener();
}

function notifyStoreHydrated() {
  notifyStoreRevision();
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('dreamfall:store-hydrated'));
}

export function getFileStoreRevision() {
  return storeRevision;
}

export function subscribeFileStore(listener) {
  storeListeners.add(listener);
  return () => storeListeners.delete(listener);
}

export function isFileStoreInitialized() {
  return initialized;
}

let initPromise = null;

/** Re-run hydration after HMR module reload (bootstrap does not re-execute). */
export function ensureFileStore() {
  if (initialized) return Promise.resolve();
  if (!initPromise) initPromise = initFileStore().finally(() => { initPromise = null; });
  return initPromise;
}

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const debounceTimers = new Map();

/** @type {Map<string, Promise<void>>} */
const inflightWrites = new Map();

function entryKey(collection, id) {
  return `${collection}:${id}`;
}

function apiUrl(collection, id) {
  return `/api/store/${collection}/${encodeURIComponent(id)}`;
}

function prodUrl(collection, id) {
  if (collection === 'state') return '/data/state.json';
  return `/data/${collection}/${encodeURIComponent(id)}.json`;
}

export function isFileStoreWritable() {
  return writable;
}

export function getFileStorePersistError() {
  return persistError;
}

export function readCollection(collection) {
  return cache[collection] ?? {};
}

export function readState() {
  return { ...state };
}

export function writeState(patch) {
  state = { ...state };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete state[key];
    else state[key] = value;
  }
  notifyStoreRevision();
  queuePersist('state', '_', state, { debounce: false });
}

export function readEntry(collection, id) {
  return cache[collection]?.[id] ?? null;
}

export function writeEntry(collection, id, data, options = {}) {
  if (!cache[collection]) cache[collection] = {};
  cache[collection][id] = data;
  notifyStoreRevision();
  queuePersist(collection, id, data, options);
}

export function deleteEntry(collection, id) {
  if (cache[collection]) delete cache[collection][id];
  notifyStoreRevision();
  queueDelete(collection, id);
}

export function getWorldMapDraft() {
  const draft = cache.worldmaps?._draft;
  if (!draft) return null;
  if (draft.map) return draft.map;
  return draft;
}

export function setWorldMapDraft(map, options = { debounce: true }) {
  cache.worldmaps._draft = map;
  queuePersist('worldmaps', '_draft', map, options);
}

export function getMapBuilderAutosave() {
  return cache.mapbuilder?._autosave ?? null;
}

export function setMapBuilderAutosave(project, options = { debounce: true }) {
  cache.mapbuilder._autosave = project;
  queuePersist('mapbuilder', '_autosave', project, options);
}

export function getBodyshopAutosave() {
  return cache.bodyshop?._autosave ?? null;
}

export function setBodyshopAutosave(session, options = { debounce: true }) {
  if (!cache.bodyshop) cache.bodyshop = {};
  cache.bodyshop._autosave = session;
  queuePersist('bodyshop', '_autosave', session, options);
}

export function getGunsmithAutosave() {
  return cache.gunsmith?._autosave ?? null;
}

export function setGunsmithAutosave(session, options = { debounce: true }) {
  if (!cache.gunsmith) cache.gunsmith = {};
  cache.gunsmith._autosave = session;
  queuePersist('gunsmith', '_autosave', session, options);
}

function setPersistError(err) {
  persistError = err?.message || String(err);
  console.error('[fileStore] persist failed:', persistError);
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) {
    const err = new Error(`${init?.method || 'GET'} ${url} → ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function persistNow(collection, id, data, { keepalive = false } = {}) {
  if (!writable) {
    console.warn(`[fileStore] read-only — skipped write ${collection}/${id}`);
    return;
  }

  const key = entryKey(collection, id);
  const body = JSON.stringify(data);
  const promise = fetchJson(apiUrl(collection, id), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body,
    keepalive,
  }).then(() => {
    persistError = null;
  }).catch((err) => {
    setPersistError(err);
    throw err;
  }).finally(() => {
    inflightWrites.delete(key);
  });

  inflightWrites.set(key, promise);
  return promise;
}

function queuePersist(collection, id, data, { debounce = false } = {}) {
  const key = entryKey(collection, id);
  if (!debounce) {
    const existing = debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    debounceTimers.delete(key);
    void persistNow(collection, id, data);
    return;
  }

  const existing = debounceTimers.get(key);
  if (existing) clearTimeout(existing);
  debounceTimers.set(key, setTimeout(() => {
    debounceTimers.delete(key);
    void persistNow(collection, id, data);
  }, DEBOUNCE_MS));
}

function queueDelete(collection, id) {
  if (!writable) {
    console.warn(`[fileStore] read-only — skipped delete ${collection}/${id}`);
    return;
  }
  void fetch(apiUrl(collection, id), { method: 'DELETE' }).catch(setPersistError);
}

function clearCache() {
  cache.blueprints = {};
  cache.worldmaps = {};
  cache.mapbuilder = {};
  cache.garage = {};
  cache.bodyshop = {};
  cache.gunsmith = {};
  state = {};
}

function applySnapshot(snapshot, readOnly) {
  writable = !readOnly;
  cache.blueprints = { ...(snapshot.blueprints ?? {}) };
  cache.worldmaps = { ...(snapshot.worldmaps ?? {}) };
  cache.mapbuilder = { ...(snapshot.mapbuilder ?? {}) };
  cache.garage = { ...(snapshot.garage ?? {}) };
  cache.bodyshop = { ...(snapshot.bodyshop ?? {}) };
  cache.gunsmith = { ...(snapshot.gunsmith ?? {}) };
  state = snapshot.state && typeof snapshot.state === 'object' ? { ...snapshot.state } : {};
}

async function hydrateFromSnapshot(snapshot, readOnly) {
  applySnapshot(snapshot, readOnly);
  notifyStoreHydrated();
}
async function hydrateFromIndex(index, readOnly) {
  applySnapshot({
    blueprints: {},
    worldmaps: {},
    mapbuilder: {},
    garage: {},
    bodyshop: {},
    gunsmith: {},
    state: index.state ?? {},
  }, readOnly);

  const fetches = [];

  for (const meta of index.blueprints ?? []) {
    fetches.push(
      fetchJson(readOnly ? prodUrl('blueprints', meta.id) : apiUrl('blueprints', meta.id))
        .then((data) => {
          cache.blueprints[meta.id] = data;
        })
        .catch((err) => {
          console.error(`[fileStore] failed to load blueprint ${meta.id}:`, err?.message || err);
        }),
    );
  }

  for (const meta of index.worldmaps ?? []) {
    fetches.push(
      fetchJson(readOnly ? prodUrl('worldmaps', meta.id) : apiUrl('worldmaps', meta.id))
        .then((data) => {
          cache.worldmaps[meta.id] = data;
        })
        .catch((err) => {
          console.error(`[fileStore] failed to load worldmap ${meta.id}:`, err?.message || err);
        }),
    );
  }

  for (const meta of index.mapbuilder ?? []) {
    fetches.push(
      fetchJson(readOnly ? prodUrl('mapbuilder', meta.id) : apiUrl('mapbuilder', meta.id))
        .then((data) => {
          cache.mapbuilder[meta.id] = data;
        })
        .catch((err) => {
          console.error(`[fileStore] failed to load mapbuilder ${meta.id}:`, err?.message || err);
        }),
    );
  }

  for (const meta of index.garage ?? []) {
    fetches.push(
      fetchJson(readOnly ? prodUrl('garage', meta.id) : apiUrl('garage', meta.id))
        .then((data) => {
          cache.garage[meta.id] = data;
        })
        .catch((err) => {
          console.error(`[fileStore] failed to load garage ${meta.id}:`, err?.message || err);
        }),
    );
  }

  for (const meta of index.bodyshop ?? []) {
    fetches.push(
      fetchJson(readOnly ? prodUrl('bodyshop', meta.id) : apiUrl('bodyshop', meta.id))
        .then((data) => {
          cache.bodyshop[meta.id] = data;
        })
        .catch((err) => {
          console.error(`[fileStore] failed to load bodyshop ${meta.id}:`, err?.message || err);
        }),
    );
  }

  for (const meta of index.gunsmith ?? []) {
    fetches.push(
      fetchJson(readOnly ? prodUrl('gunsmith', meta.id) : apiUrl('gunsmith', meta.id))
        .then((data) => {
          cache.gunsmith[meta.id] = data;
        })
        .catch((err) => {
          console.error(`[fileStore] failed to load gunsmith ${meta.id}:`, err?.message || err);
        }),
    );
  }

  await Promise.allSettled(fetches);
  notifyStoreHydrated();
}

async function loadDevStore() {
  try {
    const snapshot = await fetchJson('/api/store/snapshot');
    await hydrateFromSnapshot(snapshot, false);
    writable = true;
    if (isStoreEmpty(snapshot)) {
      await migrateFromLocalStorage();
    }
    return;
  } catch (err) {
    if (err?.status !== 404 && err?.status !== 502) throw err;
  }

  try {
    const index = await fetchJson('/api/store/index');
    await hydrateFromIndex(index, false);
    writable = true;
    if (isStoreEmpty(index)) {
      await migrateFromLocalStorage();
    }
    return;
  } catch (err) {
    if (err?.status !== 404 && err?.status !== 502) throw err;
    console.warn(
      '[fileStore] /api/store unavailable — start the dev server with `npm run dev` '
      + '(not an old vite instance on another port). Falling back to static /data.',
    );
  }

  let index = null;
  try {
    index = await fetchJson('/data/index.json');
  } catch {
    index = { blueprints: [], worldmaps: [], mapbuilder: [], garage: [], bodyshop: [], gunsmith: [], state: {} };
  }
  await hydrateFromIndex(index, true);
  if (isStoreEmpty(index)) {
    await migrateFromLocalStorage();
  }
}

function isStoreEmpty(snapshotOrIndex) {
  const hasCollections = ['blueprints', 'worldmaps', 'mapbuilder', 'garage', 'bodyshop', 'gunsmith'].some((collection) => {
    const bucket = snapshotOrIndex[collection];
    if (Array.isArray(bucket)) return bucket.length > 0;
    return bucket && Object.keys(bucket).length > 0;
  });
  const stateObj = snapshotOrIndex.state ?? {};
  return !hasCollections && !stateObj.activeSceneId && !stateObj.activeGarageBuildId;
}

function readLocalStorageJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function migrateFromLocalStorage() {
  if (typeof localStorage === 'undefined') return 0;

  let migrated = 0;

  const blueprints = readLocalStorageJson(BLUEPRINTS_STORAGE_KEY, null);
  if (blueprints && typeof blueprints === 'object') {
    for (const entry of Object.values(blueprints)) {
      if (!entry?.id) continue;
      await persistNow('blueprints', entry.id, entry);
      cache.blueprints[entry.id] = entry;
      migrated += 1;
    }
    localStorage.removeItem(BLUEPRINTS_STORAGE_KEY);
  }

  const scenes = readLocalStorageJson(WORLDMAP_SCENES_KEY, null);
  if (scenes && typeof scenes === 'object') {
    for (const entry of Object.values(scenes)) {
      if (!entry?.id) continue;
      await persistNow('worldmaps', entry.id, entry);
      cache.worldmaps[entry.id] = entry;
      migrated += 1;
    }
    localStorage.removeItem(WORLDMAP_SCENES_KEY);
  }

  const activeSceneId = localStorage.getItem(WORLDMAP_ACTIVE_KEY);
  if (activeSceneId) {
    state.activeSceneId = activeSceneId;
    localStorage.removeItem(WORLDMAP_ACTIVE_KEY);
    migrated += 1;
  }

  const worldDraft = localStorage.getItem(WORLDMAP_STORAGE_KEY);
  if (worldDraft) {
    try {
      const map = JSON.parse(worldDraft);
      await persistNow('worldmaps', '_draft', map);
      cache.worldmaps._draft = map;
      localStorage.removeItem(WORLDMAP_STORAGE_KEY);
      migrated += 1;
    } catch {
      // ignore corrupt draft
    }
  }

  const mapAutosave = localStorage.getItem(MAPBUILDER_AUTOSAVE_KEY);
  if (mapAutosave) {
    try {
      const project = JSON.parse(mapAutosave);
      await persistNow('mapbuilder', '_autosave', project);
      cache.mapbuilder._autosave = project;
      localStorage.removeItem(MAPBUILDER_AUTOSAVE_KEY);
      migrated += 1;
    } catch {
      // ignore corrupt autosave
    }
  }

  const garageBuilds = readLocalStorageJson(GARAGE_BUILDS_KEY, null);
  if (Array.isArray(garageBuilds)) {
    for (const build of garageBuilds) {
      if (!build?.id) continue;
      await persistNow('garage', build.id, build);
      cache.garage[build.id] = build;
      migrated += 1;
    }
    localStorage.removeItem(GARAGE_BUILDS_KEY);
  }

  const activeGarageId = localStorage.getItem(GARAGE_ACTIVE_KEY);
  if (activeGarageId) {
    state.activeGarageBuildId = activeGarageId;
    localStorage.removeItem(GARAGE_ACTIVE_KEY);
    migrated += 1;
  }

  if (migrated > 0) {
    await persistNow('state', '_', state);
    notifyStoreHydrated();
  }

  if (migrated > 0) {
    console.info(`[fileStore] migrated ${migrated} editor item(s) from localStorage → SQLite`);
  }

  return migrated;
}

export async function rehydrateFileStore() {
  try {
    const snapshot = await fetchJson('/api/store/snapshot');
    await hydrateFromSnapshot(snapshot, false);
    return true;
  } catch (err) {
    if (err?.status !== 404) console.warn('[fileStore] rehydrate failed:', err?.message || err);
    return false;
  }
}

export async function initFileStore() {
  if (initialized) return;

  await loadDevStore();
  initialized = true;

  const { ensureBuiltInRallyScene } = await import('../world/worldMap/worldMapScenes.js');
  ensureBuiltInRallyScene();

  if (typeof window !== 'undefined' && !listenersRegistered) {
    listenersRegistered = true;
    window.addEventListener('beforeunload', () => { void flushFileStore({ keepalive: true }); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void flushFileStore({ keepalive: true });
    });

    if (import.meta.hot) {
      import.meta.hot.on('dreamfall:store-changed', () => {
        void rehydrateFileStore();
      });
    }
  }
}

export async function flushFileStore({ keepalive = false } = {}) {
  for (const [key, timer] of debounceTimers.entries()) {
    clearTimeout(timer);
    debounceTimers.delete(key);
    const [collection, id] = key.split(':');
    const data = collection === 'state'
      ? state
      : cache[collection]?.[id];
    if (data !== undefined) {
      await persistNow(collection, id, data, { keepalive });
    }
  }

  await Promise.allSettled([...inflightWrites.values()]);
}

/** @internal test helper — seed cache without network */
export function __seedFileStoreForTests(snapshot = {}) {
  Object.assign(cache.blueprints, snapshot.blueprints ?? {});
  Object.assign(cache.worldmaps, snapshot.worldmaps ?? {});
  Object.assign(cache.mapbuilder, snapshot.mapbuilder ?? {});
  Object.assign(cache.garage, snapshot.garage ?? {});
  Object.assign(cache.bodyshop, snapshot.bodyshop ?? {});
  Object.assign(cache.gunsmith, snapshot.gunsmith ?? {});
  state = { ...state, ...(snapshot.state ?? {}) };
  writable = false;
  initialized = true;
}
